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
 * caller survives power loss on hardware that honours flushes), foreign keys on, and checkpoints
 * as `SqliteCheckpointOptions` describes. The database
 * file must be on a local filesystem: SQLite's locking is not reliable over network filesystems,
 * so remote workers reach metadata through the control-plane daemon, never by opening this file.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { OrcaError } from "@orca/core";
import { ORCA_SQLITE_APPLICATION_ID, SQLITE_MIGRATIONS } from "./schema.js";

export interface SqliteOptions {
  /** How long a write keeps retrying `SQLITE_BUSY` before `STORE_LOCK_TIMEOUT`. Default 10 s. */
  busyDeadlineMs?: number;
  /** When the write-ahead log is copied back into the database. Defaults: `SQLITE_CHECKPOINT`. */
  checkpoint?: SqliteCheckpointOptions;
  /**
   * Open read-only, for checks that must change nothing (closed update validation): the database
   * must already exist at this build's schema version (no migration runs), no setting is
   * written, and every write fails.
   */
  readOnly?: boolean;
}

/**
 * WAL checkpointing (#339). A checkpoint copies committed pages from `metadata.sqlite-wal` back
 * into the database file; until one runs the log only grows, and every reader has to look
 * through it. SQLite's own automatic checkpoint runs *inside* the commit that crosses the
 * threshold, so that one write pays for copying the log. These settings move the work out of the
 * write path where they can.
 *
 * None of them is a hard bound on the log. A checkpoint cannot copy past the oldest snapshot a
 * reader still holds, and the log cannot start over while one is held, so a long read (or one
 * large transaction) lets it grow past `autoPages` and past `walLimitBytes` alike. Measure the
 * log's size; do not assume it.
 */
export interface SqliteCheckpointOptions {
  /**
   * Log pages (4 KiB each) past which a commit runs a passive checkpoint itself
   * (`wal_autocheckpoint`): a trigger, not a bound (see above). The backstop for a connection
   * that never goes idle. 0 turns it off.
   */
  autoPages?: number;
  /**
   * After this long without a write from this connection, run a passive checkpoint off the
   * write path. 0 turns it off.
   */
  idleMs?: number;
  /**
   * The size a log file is cut back to when SQLite starts it over after a complete checkpoint,
   * or a truncating one runs (`journal_size_limit`), so one burst does not leave a large file
   * behind for good. It limits what is *kept*, not how far the log grows before that.
   */
  walLimitBytes?: number;
  /**
   * Told about every checkpoint this connection runs by itself (the idle one), with what it did
   * and how long it took, or why it failed. For diagnostics and the benchmark; it must not throw.
   */
  observe?: (event: SqliteCheckpointEvent) => void;
}

/** One checkpoint a connection ran by itself. */
export type SqliteCheckpointEvent =
  ({ trigger: "idle"; ms: number } & SqliteCheckpointResult) | { trigger: "idle"; ms: number; error: unknown };

/** The checkpoint settings every connection gets unless told otherwise. */
export const SQLITE_CHECKPOINT: Readonly<Required<Omit<SqliteCheckpointOptions, "observe">>> = Object.freeze({
  autoPages: 1000,
  idleMs: 1000,
  walLimitBytes: 64 * 1024 * 1024,
});

/** What one checkpoint did, from `PRAGMA wal_checkpoint`. */
export interface SqliteCheckpointResult {
  /** True when another connection held a lock the checkpoint needed and it stopped early. */
  busy: boolean;
  /** Pages in the log. */
  logPages: number;
  /** Pages of it now copied into the database. */
  checkpointedPages: number;
}

const BUSY = 5;
const LOCKED = 6;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The built-in `node:sqlite` module, loaded on first use. */
export function sqlite(): typeof import("node:sqlite") {
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
  private readonly checkpointSettings: Required<Omit<SqliteCheckpointOptions, "observe">> &
    Pick<SqliteCheckpointOptions, "observe">;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    readonly file: string,
    options: SqliteOptions = {},
  ) {
    this.busyDeadlineMs = options.busyDeadlineMs ?? 10_000;
    this.checkpointSettings = { ...SQLITE_CHECKPOINT, ...options.checkpoint };
    const { DatabaseSync } = sqlite();
    if (options.readOnly) {
      this.db = new DatabaseSync(file, { readOnly: true });
      try {
        this.db.exec("PRAGMA busy_timeout = 50");
        this.refuseNewer();
        if (this.schemaVersion() !== SQLITE_MIGRATIONS.length)
          throw new OrcaError(
            "STORE_FORMAT",
            `SQLite metadata schema ${this.schemaVersion()} needs migrating to ${SQLITE_MIGRATIONS.length}, which a read-only open does not do`,
            { reason: "NEEDS_MIGRATION", file, schema: this.schemaVersion(), supported: SQLITE_MIGRATIONS.length },
          );
      } catch (error) {
        this.db.close();
        throw error;
      }
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("PRAGMA busy_timeout = 50");
      // Before anything that can change the file: a database from a newer build is refused
      // exactly as it was found, journal mode included.
      this.refuseNewer();
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA foreign_keys = ON");
      const { autoPages, walLimitBytes } = this.checkpointSettings;
      this.db.exec(`PRAGMA wal_autocheckpoint = ${Math.max(0, Math.floor(autoPages))}`);
      this.db.exec(`PRAGMA journal_size_limit = ${Math.max(-1, Math.floor(walLimitBytes))}`);
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  }

  /**
   * Refuse, before anything can change the file, a database this build must not open: one from
   * a newer build, or one that is not an ORCA metadata database at all (another application's
   * id, or an unmarked file that already holds tables). A brand-new empty file is fine.
   */
  private refuseNewer(): void {
    const schema = this.schemaVersion();
    const known = SQLITE_MIGRATIONS.length;
    const applicationId = Number(
      (this.db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id,
    );
    const tables = Number((this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema").get() as { n: number }).n);
    const fresh = schema === 0 && applicationId === 0 && tables === 0;
    if (!fresh && applicationId !== ORCA_SQLITE_APPLICATION_ID)
      throw new OrcaError("STORE_FORMAT", `${this.file} is not an ORCA metadata database`, {
        reason: "FOREIGN",
        file: this.file,
        applicationId,
      });
    if (schema > known)
      throw new OrcaError("STORE_FORMAT", `SQLite metadata schema ${schema} is newer than this build (${known})`, {
        reason: "NEWER",
        file: this.file,
        schema,
        supported: known,
      });
  }

  /** Apply pending migrations in one immediate transaction; a newer database is refused first. */
  private migrate(): void {
    const version = () => this.schemaVersion();
    const known = SQLITE_MIGRATIONS.length;
    this.refuseNewer();
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
      this.scheduleIdleCheckpoint();
      return result;
    });
  }

  /**
   * Copy the log back into the database now. `passive` never waits: it copies what no reader
   * still needs and reports `busy` if it could not finish. `truncate` waits (within the
   * connection's busy timeout) for readers and writers, copies everything and empties the log
   * file: for maintenance, never on the write path. A failure is the caller's to see.
   */
  checkpoint(mode: "passive" | "truncate" = "passive"): SqliteCheckpointResult {
    const row = this.db.prepare(`PRAGMA wal_checkpoint(${mode === "truncate" ? "TRUNCATE" : "PASSIVE"})`).get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    return { busy: row.busy !== 0, logPages: row.log, checkpointedPages: row.checkpointed };
  }

  /**
   * Re-arm the idle checkpoint after a commit: a burst of writes is followed by one checkpoint
   * once it has stopped, not one per write. The timer never keeps the process alive, and a
   * checkpoint that fails (another connection busy, the store closed under it) is left for the
   * next one or for `wal_autocheckpoint`: it never fails a write that has already committed.
   */
  private scheduleIdleCheckpoint(): void {
    const { idleMs } = this.checkpointSettings;
    if (idleMs <= 0 || this.closed) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.closed) return;
      const started = performance.now();
      let event: SqliteCheckpointEvent;
      try {
        event = { trigger: "idle", ms: 0, ...this.checkpoint("passive") };
      } catch (error) {
        // Best effort by design; see above.
        event = { trigger: "idle", ms: 0, error };
      }
      event.ms = performance.now() - started;
      try {
        this.checkpointSettings.observe?.(event);
      } catch {
        // An observer that throws must not become an uncaught error in a timer.
      }
    }, idleMs);
    this.idleTimer.unref?.();
  }

  /**
   * Run `body` as one read transaction: every statement in it sees the same committed snapshot,
   * so a read made of several statements (rows and a write counter, a size check and the rows it
   * bounds) can never mix two commits of another connection. WAL readers rarely see
   * `SQLITE_BUSY`, but recovery and checkpoints can cause it, so it is retried like a write.
   */
  read<T>(body: () => T): Promise<T> {
    return this.retry(() => {
      this.db.exec("BEGIN DEFERRED");
      try {
        return body();
      } finally {
        if (this.db.isTransaction) this.db.exec("COMMIT");
      }
    });
  }

  /** Run `body` outside any transaction, with the same busy handling: for `VACUUM INTO`. */
  statement<T>(body: () => T): Promise<T> {
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
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.statements.clear();
    this.db.close();
  }
}
