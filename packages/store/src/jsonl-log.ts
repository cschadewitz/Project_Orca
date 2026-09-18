/**
 * A directory of append-only JSONL logs, one file per key, whose records carry a gap-free
 * `seq` per file. The run event store (`runs/<runId>.jsonl`) and the plan journal
 * (`plans/<planId>.jsonl`) are both this under different names.
 *
 * `seq` is decided on disk, not in memory. Every append takes the file's lock
 * (`<key>.jsonl.lock`, see file-lock.ts) and numbers the record after the last one already
 * in the file, so two processes over one directory - an `orca acp` facade beside an
 * `orca resume`, two CLI invocations - extend one log consistently. An in-process counter
 * cannot: it only knows about its own writes. The lock is also what keeps lines whole:
 * `appendJsonl` is a plain `O_APPEND` write, which is atomic per `write(2)` but not per
 * line, and only serialised writers make that distinction moot.
 *
 * Re-reading a multi-megabyte `agent.update` log on every append would be quadratic, so the
 * last `seq` and the file's size and inode are cached per key, and the cache is trusted only
 * while `stat` reports the same size and inode. The file is append-only, so any write by
 * another process grows it and invalidates the cache; a delete-and-recreate changes the inode.
 *
 * A process that dies mid-append leaves a torn last line with no newline. Reads skip lines
 * that are not JSON (logged as warnings) rather than throwing, so a journal with one torn
 * line stays readable. The next append, holding the lock, truncates the torn tail before it
 * writes: the append that produced it never completed, so nothing observed that record as
 * durable, and the sequence continues from the last complete one.
 */
import { mkdir, readdir, readFile, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import {
  anyJson,
  appendJsonl,
  parseJsonlLine,
  readJsonl,
  readJsonlLines,
  silentLogger,
  splitJsonlLines,
  type JsonlParser,
  type Logger,
} from "@orca/core";
import { withFileLock, type FileLockOptions } from "./file-lock.js";

export interface JsonlLogDirOptions {
  /** Where torn tails, corrupt lines and broken locks are reported. Silent by default. */
  logger?: Logger;
  lock?: FileLockOptions;
}

interface Tail {
  ino: number;
  size: number;
  nextSeq: number;
}

const NEWLINE = 0x0a;

export class JsonlLogDir {
  private readonly tails = new Map<string, Tail>();
  /** Appends from this process queue per key, so only one of them contends for the lock file at a time. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly logger: Logger;
  private readonly lock: FileLockOptions;
  private ready: Promise<void> | undefined;

  constructor(
    readonly dir: string,
    options: JsonlLogDirOptions = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.lock = {
      ...options.lock,
      onBroken: (holder) => {
        this.logger.warn("jsonl log: broke a stale lock", { dir, pid: holder.pid, ageMs: Date.now() - holder.at });
        options.lock?.onBroken?.(holder);
      },
    };
  }

  file(key: string): string {
    return join(this.dir, `${key}.jsonl`);
  }

  private init(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  /**
   * Append the record `build(seq)` to `key`'s log and return it. `build` runs under the
   * lock, so ids and timestamps it assigns are ordered like the records themselves.
   */
  append<T>(key: string, build: (seq: number) => T): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.appendLocked(key, build));
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private async appendLocked<T>(key: string, build: (seq: number) => T): Promise<T> {
    await this.init();
    const file = this.file(key);
    return withFileLock(
      `${file}.lock`,
      async () => {
        const tail = await this.tail(key, file);
        const record = build(tail.nextSeq);
        await appendJsonl(file, record);
        const { ino, size } = await stat(file);
        this.tails.set(key, { ino, size, nextSeq: tail.nextSeq + 1 });
        return record;
      },
      this.lock,
    );
  }

  /** Where the log ends right now: from the cache when the file is unchanged, otherwise from disk. */
  private async tail(key: string, file: string): Promise<Pick<Tail, "nextSeq">> {
    let ino: number;
    let size: number;
    try {
      ({ ino, size } = await stat(file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.tails.delete(key);
      return { nextSeq: 0 };
    }
    const cached = this.tails.get(key);
    if (cached && cached.ino === ino && cached.size === size) return cached;

    const buf = await readFile(file);
    let end = buf.length;
    if (end > 0 && buf[end - 1] !== NEWLINE) {
      end = buf.lastIndexOf(NEWLINE) + 1;
      this.logger.warn("jsonl log: discarding torn tail left by an interrupted append", {
        file,
        bytes: buf.length - end,
      });
      await truncate(file, end);
    }
    const lines = splitJsonlLines(buf.toString("utf8", 0, end));
    let nextSeq = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const seq = this.seqOf(file, lines[i]!);
      if (seq !== undefined) {
        nextSeq = seq + 1;
        break;
      }
    }
    return { nextSeq };
  }

  private seqOf(file: string, line: string): number | undefined {
    const raw = parseJsonlLine(line, anyJson, this.readOptions(file));
    const seq = (raw as { seq?: unknown } | undefined)?.seq;
    return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : undefined;
  }

  private readOptions(file: string) {
    return {
      onCorrupt: (line: string) =>
        this.logger.warn("jsonl log: skipping a line that is not JSON", { file, bytes: Buffer.byteLength(line) }),
    };
  }

  /** Every record of `key`'s log, in file order; a missing log reads as empty. */
  async read<T>(key: string, parser: JsonlParser<T>): Promise<T[]> {
    await this.init();
    const file = this.file(key);
    return readJsonl(file, parser, this.readOptions(file));
  }

  /** The raw lines of `key`'s log, for callers that want to pre-select before parsing. */
  async lines(key: string): Promise<string[]> {
    await this.init();
    return readJsonlLines(this.file(key));
  }

  /** Parse one line from {@link lines}; `undefined` for a line that is not JSON. */
  parseLine<T>(key: string, line: string, parser: JsonlParser<T>): T | undefined {
    return parseJsonlLine(line, parser, this.readOptions(this.file(key)));
  }

  /** Every key with a log file, sorted. Lock and scratch files are not logs. */
  async keys(): Promise<string[]> {
    await this.init();
    return (await readdir(this.dir))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort();
  }
}
