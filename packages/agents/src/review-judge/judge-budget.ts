/**
 * The plain-rule judge's daily call budget: one per daemon, durable and shared (#701). Every prepared judge the
 * daemon makes reserves from the same file, one count per UTC day for each key (destination and key reference), so
 * a restart, a second session or a re-preparation does not start again at zero.
 *
 * Durability. A reservation is acknowledged only after it is committed: the new count is written to a temporary
 * file, that file is synced, renamed over the budget file, and the directory is synced; then the same is done for
 * the anchor (below). Only then does `reserve` answer `true`. Any failure on that path answers `false`, and the call
 * is not made. Node cannot sync a directory on Windows, so the replacement is not verified durable there: on Windows
 * the budget reports `durable: false`, which activation refuses, until that protocol is verified on it. Reads and
 * writes are serialized across processes with the policy files' strict-ownership lock; a lock left by a crashed
 * process is never taken over, so calls are refused (the person is asked) until it is removed.
 *
 * No silent recovery. The file is created only by `initialize`, an explicit owner step, and a fresh file starts
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
  /** Whether the count is the daemon's durable one. Activation requires `true`. */
  readonly durable: boolean;
}

export type JudgeBudgetInitResult =
  | { readonly status: "initialized"; readonly day: string }
  | { readonly status: "refused"; readonly reason: "exists" | "clock" | "write" };

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

/** Write, sync, rename, sync the directory. Resolves only once the new contents are committed. */
async function commit(io: JudgeBudgetIo, file: string, next: object, owned?: () => Promise<void>): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await io.writeSynced(tmp, `${JSON.stringify(next)}\n`);
    await owned?.();
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
): Promise<void> {
  await commit(io, file, next, owned);
  const mark: AnchorFile = { version: JUDGE_BUDGET_FILE_VERSION, budgetId: next.budgetId, sequence: next.sequence };
  await commit(io, anchor, mark, owned);
}

function makeFileBudget(
  file: string,
  anchor: string,
  now: () => number,
  io: JudgeBudgetIo,
  lockTimeoutMs: number,
  durable: boolean,
) {
  const locked = <T>(fn: (owned: () => Promise<void>) => Promise<T>) =>
    withPolicyLock(file, { strictOwnership: true, timeoutMs: lockTimeoutMs }, fn);

  const initialize = async (): Promise<JudgeBudgetInitResult> => {
    const today = utcDay(now());
    if (today === undefined) return { status: "refused", reason: "clock" };
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await mkdir(dirname(anchor), { recursive: true, mode: 0o700 });
      return await locked(async (owned) => {
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
        // Replaces any earlier anchor: this explicit owner step starts a new budget.
        await commitBoth(io, file, anchor, fresh, owned);
        seen.set(file, { budgetId: fresh.budgetId, sequence: 0 });
        return { status: "initialized", day: today } as const;
      });
    } catch {
      return { status: "refused", reason: "write" };
    }
  };

  const reserve = async (key: string, limit: number): Promise<boolean> => {
    if (typeof key !== "string" || key === "" || !validLimit(limit)) return false;
    try {
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

  return Object.freeze({ durable, reserve, initialize });
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
  options: { now?: () => number; io?: JudgeBudgetIo; lockTimeoutMs?: number; platform?: NodeJS.Platform } = {},
): JudgeBudget & { readonly initialize: () => Promise<JudgeBudgetInitResult> } {
  const stateDir = resolve(dirs.stateDir);
  const anchorDir = resolve(dirs.anchorDir);
  if (within(stateDir, anchorDir) || within(anchorDir, stateDir))
    throw new Error("the judge budget's anchor directory must be outside its state directory, and the other way round");
  const file = resolve(stateDir, JUDGE_BUDGET_FILENAME);
  const anchor = resolve(anchorDir, JUDGE_BUDGET_ANCHOR_FILENAME);
  // The directory sync is part of the durability claim; where Node cannot do it, the budget is not durable.
  const durable = (options.platform ?? process.platform) !== "win32";
  const timeout = options.lockTimeoutMs ?? 5_000;
  if (options.now || options.io || options.platform)
    return makeFileBudget(file, anchor, options.now ?? Date.now, options.io ?? NODE_IO, timeout, durable);
  const id = JSON.stringify([file, anchor]);
  let budget = budgets.get(id);
  if (!budget) {
    budget = makeFileBudget(file, anchor, Date.now, NODE_IO, timeout, durable);
    budgets.set(id, budget);
  }
  return budget;
}
