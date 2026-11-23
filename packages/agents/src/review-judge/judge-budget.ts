/**
 * The plain-rule judge's daily call budget: one per daemon, durable and shared (#701). Every prepared judge the
 * daemon makes reserves from the same file, one count per UTC day for each key (destination and key reference), so
 * a restart, a second session or a re-preparation does not start again at zero.
 *
 * Durability. A reservation is acknowledged only after it is committed: the new count is written to a temporary
 * file, that file is synced, renamed over the budget file, and the directory is synced. Only then does `reserve`
 * answer `true`. Any failure on that path answers `false`, and the call is not made. (Node cannot sync a directory
 * on Windows; as in ORCA's protected and artifact stores, Windows gets the file sync without a directory-entry
 * power-loss guarantee.) Reads and writes are serialized across processes with the policy files' strict-ownership
 * lock; a lock left by a crashed process is never taken over, so calls are refused (the person is asked) until it
 * is removed.
 *
 * No silent recovery. The file is created only by `initialize`, an explicit owner step, and a fresh file starts
 * with today's budget fully spent for every key: the first calls are allowed on the next UTC day. A missing file is
 * not an empty budget (it refuses), and neither is one that cannot be read, parsed or trusted, nor one dated after
 * today (a clock moved back). `initialize` never overwrites an existing file. Within one process, a file whose
 * budget id changes or whose sequence goes backwards (replaced, rolled back, restored from a copy) is refused until
 * it is initialized again. So losing or replacing the file while the daemon runs can only cost calls.
 *
 * Backup and restore. The file cannot tell, on its own, that it was restored from a copy while the daemon was
 * stopped: an older copy would count fewer calls for that day. So do not restore it. Exclude it from backups, or
 * after restoring a state directory delete the file and run `initialize`, which spends the current day; calls
 * resume on the next UTC day. A budget belongs to one daemon: do not copy it between machines.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withPolicyLock } from "../permission-file.js";

export const JUDGE_BUDGET_FILE_VERSION = 2;
/** Where a daemon keeps its one budget, under its state directory. */
export const JUDGE_BUDGET_FILENAME = join("review-judge", "budget.json");
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
async function commit(io: JudgeBudgetIo, file: string, next: BudgetFile, owned?: () => Promise<void>): Promise<void> {
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
/** Per process: one budget object per file, so the daemon has a single one however often it is asked. */
const budgets = new Map<string, ReturnType<typeof makeFileBudget>>();

function makeFileBudget(file: string, now: () => number, io: JudgeBudgetIo, lockTimeoutMs: number) {
  const locked = <T>(fn: (owned: () => Promise<void>) => Promise<T>) =>
    withPolicyLock(file, { strictOwnership: true, timeoutMs: lockTimeoutMs }, fn);

  const initialize = async (): Promise<JudgeBudgetInitResult> => {
    const today = utcDay(now());
    if (today === undefined) return { status: "refused", reason: "clock" };
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
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
        await commit(io, file, fresh, owned);
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
          await commit(io, file, next, owned);
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

  return Object.freeze({ durable: true as const, reserve, initialize });
}

/**
 * The daemon's one budget, at `<stateDir>/review-judge/budget.json`. The same object is returned for the same file
 * within a process. Call `initialize` once, as an owner step, before the first use.
 */
export function daemonJudgeBudget(
  stateDir: string,
  options: { now?: () => number; io?: JudgeBudgetIo; lockTimeoutMs?: number } = {},
): JudgeBudget & { readonly initialize: () => Promise<JudgeBudgetInitResult> } {
  const file = resolve(stateDir, JUDGE_BUDGET_FILENAME);
  if (options.now || options.io)
    return makeFileBudget(file, options.now ?? Date.now, options.io ?? NODE_IO, options.lockTimeoutMs ?? 5_000);
  let budget = budgets.get(file);
  if (!budget) {
    budget = makeFileBudget(file, Date.now, NODE_IO, options.lockTimeoutMs ?? 5_000);
    budgets.set(file, budget);
  }
  return budget;
}
