/**
 * One SQLite connection for the SQLite metadata backend (#339): open, migrate, and run every
 * statement through bounded busy handling.
 *
 * Node's built-in `node:sqlite` (no new dependency) is synchronous, so a write transaction is a
 * single synchronous call - `BEGIN IMMEDIATE`, the statements, `COMMIT` - and no other promise in
 * this process can interleave with it. Contention with *another* connection (another process, or
 * another `sqliteStores` handle) surfaces as `SQLITE_BUSY`; the connection's own busy timeout is
 * short, and the retry around it is asynchronous with backoff, so a contended write does not hold
 * the event loop for long. Past the deadline it is `STORE_LOCK_TIMEOUT`, as for the file locks.
 *
 * The module is loaded lazily (`process.getBuiltinModule`), so processes that never open a SQLite
 * store never load it.
 *
 * Settings: WAL (readers never block the writer), `synchronous = FULL` (a commit acknowledged to a
 * caller survives power loss on hardware that honours flushes), foreign keys on. The database
 * file must be on a local filesystem: SQLite's locking is not reliable over network filesystems,
 * so remote workers reach metadata through the control-plane daemon, never by opening this file.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { OrcaError } from "@orca/core";
import { SQLITE_MIGRATIONS } from "./schema.js";

export interface SqliteOptions {
  /** How long a write keeps retrying `SQLITE_BUSY` before `STORE_LOCK_TIMEOUT`. Default 10 s. */
  busyDeadlineMs?: number;
}

const BUSY = 5;
const LOCKED = 6;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!mod) throw new OrcaError("NOT_SUPPORTED", "this Node.js runtime has no built-in SQLite (node:sqlite)");
  return mod;
}

function busy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return code !== undefined && ((code & 0xff) === BUSY || (code & 0xff) === LOCKED);
}

export class SqliteDatabase {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly busyDeadlineMs: number;
  private closed = false;

  constructor(
    readonly file: string,
    options: SqliteOptions = {},
  ) {
    this.busyDeadlineMs = options.busyDeadlineMs ?? 10_000;
    mkdirSync(dirname(file), { recursive: true });
    const { DatabaseSync } = sqlite();
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout = 50");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  /** Apply pending migrations in one immediate transaction; refuse a database from a newer build. */
  private migrate(): void {
    const version = () =>
      Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    const known = SQLITE_MIGRATIONS.length;
    if (version() > known)
      throw new OrcaError("STORE_FORMAT", `SQLite metadata schema ${version()} is newer than this build (${known})`, {
        reason: "NEWER",
        file: this.file,
        schema: version(),
        supported: known,
      });
    if (version() === known) return;
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (let v = version(); v < known; v++) {
            this.db.exec(SQLITE_MIGRATIONS[v]!);
            this.db.exec(`PRAGMA user_version = ${v + 1}`);
          }
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        return;
      } catch (error) {
        // Another connection is migrating the same file; synchronous wait is fine at open.
        if (!busy(error) || attempt > 200) throw error;
        const until = Date.now() + 25;
        while (Date.now() < until);
        if (version() === known) return;
      }
    }
  }

  /** A cached prepared statement. */
  prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * Run `body` in one immediate (write) transaction, retrying `SQLITE_BUSY` with backoff.
   *
   * `COMMIT` is the commit point, and the outcome a caller sees follows it, as on the file
   * backend: a failure before it rolls back and rejects with the underlying error (nothing was
   * committed, a retry is safe); a failure *of* it rejects with `STORE_WRITE` and
   * `details.outcome: "uncertain"`, because an I/O error while the commit is being made durable
   * does not say whether it reached the disk - re-read before retrying.
   */
  write<T>(body: () => T): Promise<T> {
    return this.retry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      let result: T;
      try {
        result = body();
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
      try {
        this.db.exec("COMMIT");
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        if (busy(error)) throw error;
        throw new OrcaError(
          "STORE_WRITE",
          `the outcome of a write to ${this.file} is unknown: re-read before retrying`,
          { file: this.file, outcome: "uncertain" },
          { cause: error },
        );
      }
      return result;
    });
  }

  /** Run a read; WAL readers rarely see `SQLITE_BUSY`, but recovery and checkpoints can cause it. */
  read<T>(body: () => T): Promise<T> {
    return this.retry(body);
  }

  private async retry<T>(attempt: () => T): Promise<T> {
    if (this.closed) throw new OrcaError("STORE_WRITE", `SQLite metadata store ${this.file} is closed`);
    const deadline = Date.now() + this.busyDeadlineMs;
    let backoff = 1;
    for (;;) {
      try {
        return attempt();
      } catch (error) {
        if (!busy(error)) throw error;
        if (Date.now() >= deadline)
          throw new OrcaError(
            "STORE_LOCK_TIMEOUT",
            `SQLite metadata store ${this.file} stayed busy for ${this.busyDeadlineMs}ms`,
            { file: this.file, timeoutMs: this.busyDeadlineMs },
            { cause: error },
          );
        await sleep(backoff + Math.random() * backoff);
        backoff = Math.min(backoff * 2, 32);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}
