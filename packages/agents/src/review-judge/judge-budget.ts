/**
 * The plain-rule judge's daily call budget: one per daemon, durable and shared (#701). Every prepared judge the
 * daemon makes reserves from the same file, one count per UTC day for each key (destination and key reference), so
 * a restart, a second session or a re-preparation does not start again at zero.
 *
 * Durability. A reservation is acknowledged only after it is committed: the new count is written to a temporary
 * file, that file is synced, renamed over the budget file, and the directory is synced; then the same is done for
 * the anchor (below). Only then does `reserve` answer `true`. Any failure on that path answers `false`, and the call
 * is not made. (Node cannot sync a directory on Windows, so there the replacement protocol is not verified.) Reads and
 * writes are serialized across processes with the policy files' strict-ownership lock; a lock left by a crashed
 * process is never taken over, so calls are refused (the person is asked) until it is removed.
 *
 * No silent recovery. The file is created only by `initialize` or `replace`, explicit owner steps, and a fresh file starts
 * with today's budget fully spent for every key: the first calls are allowed on the next UTC day. A missing file is
 * not an empty budget (it refuses), and neither is one that cannot be read, parsed or trusted, nor one dated after
 * today (a clock moved back). `initialize` never overwrites an existing budget file.
 *
 * Rollback, across restarts. Every commit also writes a high-water mark (budget id and sequence) to an anchor file
 * in a separate directory that the daemon keeps outside its state directory, so restoring the state directory (or
 * the budget file alone) from a backup does not restore the anchor. Every reservation, including the first after a
 * restart, compares the two: a budget whose id differs from the anchor's, whose sequence is below it, or which has
 * no anchor is refused until the owner runs `initialize` again, which spends that day. The anchor is written after
 * the budget, so a crash between the two leaves the anchor behind, never ahead; every acknowledged reservation is in
 * both. The two directories must not contain one another. What this cannot detect is a coordinated rollback of
 * both directories to the same earlier pair; that is out of scope, as for the engine's revision runtime.
 *
 * Unqualified. This primitive takes the two directories as given: it only checks that their paths do not contain
 * one another, which does not show that they are physically separate, that the anchor is excluded from the
 * daemon's supported restore, or that the platform's replacement protocol is verified (Windows is not). So it
 * reports `durable: false`, and activation, which requires `true`, refuses it. Only a reviewed daemon integration
 * that enforces those prerequisites at its construction boundary may present a budget as durable.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { withPolicyLock } from "../permission-file.js";

export const JUDGE_BUDGET_FILE_VERSION = 2;
/** Where a daemon keeps its one budget, under its state directory. */
export const JUDGE_BUDGET_FILENAME = join("review-judge", "budget.json");
/** Where it keeps the budget's high-water mark, under its anchor directory (outside the state directory). */
export const JUDGE_BUDGET_ANCHOR_FILENAME = join("review-judge", "budget-anchor.json");
const DAY_MS = 86_400_000;
const MAX_LIMIT = 100_000;

export interface JudgeBudget {
  /** Whether the call was reserved and durably committed. Every refusal is `false`; never throws. */
  readonly reserve: (key: string, limit: number) => Promise<boolean>;
  /**
   * Whether the count is the daemon's qualified durable one. Activation requires `true`. Neither budget here
   * reports it: only a reviewed daemon integration that enforces the storage prerequisites may.
   */
  readonly durable: boolean;
}

export type JudgeBudgetInitResult =
  | { readonly status: "initialized"; readonly day: string }
  /** Nothing was changed: a budget already exists (initialize only), the clock, the storage check, or a write before the budget was replaced. */
  | { readonly status: "refused"; readonly reason: "exists" | "clock" | "storage" | "write" }
  /**
   * The new budget may have replaced the old one but its anchor was not committed, or the replacement's own commit did
   * not finish. Calls are refused (the budget and its anchor disagree) until `replace` succeeds.
   */
  | { readonly status: "uncertain" };

/** What a budget's files say, read without the lock and without changing anything. */
export type JudgeBudgetState =
  /** No budget file: `initialize` creates one. */
  | { readonly state: "uninitialized" }
  /** A budget agreeing with its anchor: its current day, and the day it was started (that day counts as spent). */
  | { readonly state: "ready"; readonly day: string; readonly initializedDay: string }
  /** A budget that reservations refuse: unreadable, no or another anchor, behind its anchor. `replace` starts again. */
  | { readonly state: "refused" };

/** The key a judge reserves under: its destination and key reference, never a value. */
export function judgeBudgetKey(destination: string, credentialRefId: string): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([destination, credentialRefId]))
    .digest("hex")}`;
}

const utcDay = (now: number): string | undefined =>
  Number.isFinite(now) ? new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString().slice(0, 10) : undefined;

const validLimit = (limit: unknown): limit is number =>
  Number.isSafeInteger(limit) && (limit as number) > 0 && (limit as number) <= MAX_LIMIT;

/** Counts kept in this process only. For tests and fakes: not durable, and refused for activation. */
export function memoryJudgeBudget(options: { now?: () => number } = {}): JudgeBudget {
  const now = options.now ?? Date.now;
  let day: string | undefined;
  const counts = new Map<string, number>();
  return Object.freeze({
    durable: false,
    reserve: async (key: string, limit: number) => {
      const today = utcDay(now());
      if (today === undefined || typeof key !== "string" || key === "" || !validLimit(limit)) return false;
      if (today !== day) {
        day = today;
        counts.clear();
      }
      const used = counts.get(key) ?? 0;
      if (used >= limit) return false;
      counts.set(key, used + 1);
      return true;
    },
  });
}

interface BudgetFile {
  readonly version: typeof JUDGE_BUDGET_FILE_VERSION;
  /** Random at `initialize`; a different one is a different budget. */
  readonly budgetId: string;
  /** Incremented by every committed write. */
  readonly sequence: number;
  readonly day: string;
  /** Today's count per key. */
  readonly counts: Readonly<Record<string, number>>;
  /** The day the file was initialized: every key counts as spent on that day. */
  readonly initializedDay: string;
}

const FILE_KEYS = ["version", "budgetId", "sequence", "day", "counts", "initializedDay"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parse(text: string): BudgetFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== FILE_KEYS.length || !FILE_KEYS.every((k) => Object.hasOwn(v, k))) return undefined;
  if (v.version !== JUDGE_BUDGET_FILE_VERSION) return undefined;
  if (typeof v.budgetId !== "string" || !/^[0-9a-f-]{36}$/.test(v.budgetId)) return undefined;
  if (!Number.isSafeInteger(v.sequence) || (v.sequence as number) < 0) return undefined;
  if (typeof v.day !== "string" || !DAY.test(v.day)) return undefined;
  if (typeof v.initializedDay !== "string" || !DAY.test(v.initializedDay) || v.initializedDay > v.day) return undefined;
  const counts = v.counts;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) return undefined;
  for (const n of Object.values(counts)) if (!Number.isSafeInteger(n) || (n as number) < 0) return undefined;
  return v as unknown as BudgetFile;
}

interface AnchorFile {
  readonly version: typeof JUDGE_BUDGET_FILE_VERSION;
  readonly budgetId: string;
  readonly sequence: number;
}

function parseAnchor(text: string): AnchorFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 3) return undefined;
  if (v.version !== JUDGE_BUDGET_FILE_VERSION) return undefined;
  if (typeof v.budgetId !== "string" || !/^[0-9a-f-]{36}$/.test(v.budgetId)) return undefined;
  if (!Number.isSafeInteger(v.sequence) || (v.sequence as number) < 0) return undefined;
  return v as unknown as AnchorFile;
}

/** The file system steps a commit takes. Tests inject them to check order and failures. */
export interface JudgeBudgetIo {
  readonly writeSynced: (path: string, text: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly syncDirectory: (dir: string) => Promise<void>;
}

const NODE_IO: JudgeBudgetIo = {
  writeSynced: async (path, text) => {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => rename(from, to),
  syncDirectory: async (dir) => {
    if (process.platform === "win32") return;
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

/**
 * Write, sync, rename, sync the directory. Resolves only once the new contents are committed. `renaming` is called
 * just before the rename: from then on the file may have been replaced.
 */
async function commit(
  io: JudgeBudgetIo,
  file: string,
  next: object,
  owned?: () => Promise<void>,
  renaming?: () => void,
): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await io.writeSynced(tmp, `${JSON.stringify(next)}\n`);
    await owned?.();
    renaming?.();
    await io.rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await io.syncDirectory(dirname(file));
}

/** Per process: the highest sequence this process has seen for each budget file, to refuse a rollback. */
const seen = new Map<string, { budgetId: string; sequence: number }>();
/** Per process: one budget object per budget and anchor file, so the daemon has a single one however often it is asked. */
const budgets = new Map<string, ReturnType<typeof makeFileBudget>>();

/** Commit the budget, then its anchor. Resolves only once both are committed. */
async function commitBoth(
  io: JudgeBudgetIo,
  file: string,
  anchor: string,
  next: BudgetFile,
  owned: () => Promise<void>,
  renaming?: () => void,
): Promise<void> {
  await commit(io, file, next, owned, renaming);
  const mark: AnchorFile = { version: JUDGE_BUDGET_FILE_VERSION, budgetId: next.budgetId, sequence: next.sequence };
  await commit(io, anchor, mark, owned);
}

/**
 * A check of the storage the budget lives in, supplied by a qualified integration (the daemon's). It runs before
 * the directories are created, again once the lock is held, and again just before every rename, so the ledger is
 * never read or replaced in a location that failed it. `false` refuses; it never throws.
 */
export type JudgeBudgetStorageCheck = () => Promise<boolean>;

class StorageRefused extends Error {}

function makeFileBudget(
  file: string,
  anchor: string,
  now: () => number,
  io: JudgeBudgetIo,
  lockTimeoutMs: number,
  check: JudgeBudgetStorageCheck = async () => true,
) {
  const verified = async () => {
    let ok: boolean;
    try {
      ok = await check();
    } catch {
      ok = false;
    }
    if (!ok) throw new StorageRefused();
  };
  const locked = <T>(fn: (owned: () => Promise<void>) => Promise<T>) =>
    withPolicyLock(file, { strictOwnership: true, timeoutMs: lockTimeoutMs }, async (owned) => {
      await verified();
      return fn(async () => {
        await owned();
        await verified();
      });
    });

  /** Start a new budget whose first day is spent: only where none exists (`initialize`), or over any (`replace`). */
  const start = async (over: boolean): Promise<JudgeBudgetInitResult> => {
    const today = utcDay(now());
    if (today === undefined) return { status: "refused", reason: "clock" };
    let renamed = false;
    try {
      await verified();
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await mkdir(dirname(anchor), { recursive: true, mode: 0o700 });
      return await locked(async (owned) => {
        if (!over)
          try {
            await readFile(file);
            return { status: "refused", reason: "exists" } as const;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              return { status: "refused", reason: "write" } as const;
          }
        const fresh: BudgetFile = {
          version: JUDGE_BUDGET_FILE_VERSION,
          budgetId: randomUUID(),
          sequence: 0,
          day: today,
          counts: {},
          initializedDay: today,
        };
        // Replaces any earlier anchor (and, for `replace`, the budget): this explicit owner step starts a new budget.
        // Until the rename the earlier budget is untouched.
        await commitBoth(io, file, anchor, fresh, owned, () => {
          renamed = true;
        });
        seen.set(file, { budgetId: fresh.budgetId, sequence: 0 });
        return { status: "initialized", day: today } as const;
      });
    } catch (error) {
      if (renamed) return { status: "uncertain" };
      return { status: "refused", reason: error instanceof StorageRefused ? "storage" : "write" };
    }
  };
  const initialize = () => start(false);
  const replace = () => start(true);

  /** Read-only: what the files say. No lock, no write, no directory created. */
  const inspect = async (): Promise<JudgeBudgetState> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "uninitialized" } : { state: "refused" };
    }
    const current = parse(text);
    if (current === undefined) return { state: "refused" };
    let mark: AnchorFile | undefined;
    try {
      mark = parseAnchor(await readFile(anchor, "utf8"));
    } catch {
      return { state: "refused" };
    }
    // The budget is committed first, so it may be one ahead of its anchor while a reservation is in flight.
    if (mark === undefined || mark.budgetId !== current.budgetId || current.sequence < mark.sequence)
      return { state: "refused" };
    return { state: "ready", day: current.day, initializedDay: current.initializedDay };
  };

  const reserve = async (key: string, limit: number): Promise<boolean> => {
    if (typeof key !== "string" || key === "" || !validLimit(limit)) return false;
    try {
      await verified();
      return await locked(async (owned) => {
        const today = utcDay(now());
        if (today === undefined) return false;
        let current: BudgetFile | undefined;
        try {
          current = parse(await readFile(file, "utf8"));
        } catch {
          return false; // Missing included: only `initialize` creates a budget.
        }
        if (current === undefined) return false;
        // A rollback across restarts: the anchor, outside the state directory, holds the last committed mark.
        let mark: AnchorFile | undefined;
        try {
          mark = parseAnchor(await readFile(anchor, "utf8"));
        } catch {
          return false; // No anchor: the budget cannot be trusted as current.
        }
        if (mark === undefined || mark.budgetId !== current.budgetId || current.sequence < mark.sequence) return false;
        // A rollback within this process's life (restored copy, replaced file): refuse from now on.
        const last = seen.get(file);
        if (last && (last.budgetId !== current.budgetId || current.sequence < last.sequence)) {
          seen.set(file, { budgetId: "rolled-back", sequence: Number.MAX_SAFE_INTEGER });
          return false;
        }
        seen.set(file, { budgetId: current.budgetId, sequence: current.sequence });
        // The clock moved back before the file's day: refuse until that day passes, never reset early.
        if (current.day > today) return false;
        // The day the budget was initialized counts as fully spent.
        if (current.initializedDay === today) return false;
        const counts: Record<string, number> = current.day === today ? { ...current.counts } : {};
        const used = Object.hasOwn(counts, key) ? counts[key]! : 0;
        if (used >= limit) return false;
        counts[key] = used + 1;
        const next: BudgetFile = { ...current, sequence: current.sequence + 1, day: today, counts };
        try {
          await commitBoth(io, file, anchor, next, owned);
        } catch {
          return false;
        }
        seen.set(file, { budgetId: next.budgetId, sequence: next.sequence });
        return true;
      });
    } catch {
      return false;
    }
  };

  // Unqualified: see the module comment. Never signals activation readiness on its own.
  return Object.freeze({ durable: false as const, reserve, initialize, replace, inspect });
}

export interface FileJudgeBudget extends JudgeBudget {
  /** Create the budget where none exists; its first day counts as spent. Never over an existing file. */
  readonly initialize: () => Promise<JudgeBudgetInitResult>;
  /**
   * Replace the budget, whatever it holds, with a new one whose first day counts as spent: the owner's way back from a
   * refused budget. Under the lock; the earlier budget is left as it was on any failure before its replacement.
   */
  readonly replace: () => Promise<JudgeBudgetInitResult>;
  /** Read-only: what the files say now. */
  readonly inspect: () => Promise<JudgeBudgetState>;
}

/** Where the daemon keeps the budget and its anchor. The two must not contain one another. */
export interface DaemonJudgeBudgetDirs {
  /** The daemon's state directory: the budget is `<stateDir>/review-judge/budget.json`. */
  readonly stateDir: string;
  /**
   * A per-machine directory outside the state directory and outside anything restored with it: the anchor is
   * `<anchorDir>/review-judge/budget-anchor.json`.
   */
  readonly anchorDir: string;
}

const within = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * The daemon's one budget. The same object is returned for the same files within a process. Call `initialize` once,
 * as an owner step, before the first use. Throws when the anchor directory and the state directory overlap.
 */
export function daemonJudgeBudget(
  dirs: DaemonJudgeBudgetDirs,
  options: { now?: () => number; io?: JudgeBudgetIo; lockTimeoutMs?: number; check?: JudgeBudgetStorageCheck } = {},
): FileJudgeBudget {
  const stateDir = resolve(dirs.stateDir);
  const anchorDir = resolve(dirs.anchorDir);
  if (within(stateDir, anchorDir) || within(anchorDir, stateDir))
    throw new Error("the judge budget's anchor directory must be outside its state directory, and the other way round");
  const file = resolve(stateDir, JUDGE_BUDGET_FILENAME);
  const anchor = resolve(anchorDir, JUDGE_BUDGET_ANCHOR_FILENAME);
  const timeout = options.lockTimeoutMs ?? 5_000;
  if (options.now || options.io || options.check)
    return makeFileBudget(file, anchor, options.now ?? Date.now, options.io ?? NODE_IO, timeout, options.check);
  const id = JSON.stringify([file, anchor]);
  let budget = budgets.get(id);
  if (!budget) {
    budget = makeFileBudget(file, anchor, Date.now, NODE_IO, timeout);
    budgets.set(id, budget);
  }
  return budget;
}
