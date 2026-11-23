/**
 * The plain-rule judge's daily call budget, shared and durable (#701). Every prepared judge that uses the same key
 * for the same destination reserves from one count per UTC day, kept in one file, so a restart, a second session or
 * a re-preparation does not start again at zero.
 *
 * - A call reserves before the key is leased and is never refunded, whatever happens to the send.
 * - Reads and writes are serialized across processes with the policy files' strict-ownership lock, and each write
 *   replaces the file atomically (write a temporary file, then rename).
 * - Fail closed: a file that cannot be read, parsed or written refuses the call. Only a missing file is an empty
 *   count. Nothing is guessed or repaired.
 * - Only today's counts are kept; an earlier day's are dropped at the next write.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { withPolicyLock } from "../permission-file.js";

export const JUDGE_BUDGET_FILE_VERSION = 1;
const DAY_MS = 86_400_000;

export interface JudgeBudget {
  /** Whether the call was reserved. Refusal (over the limit, or the store unusable) is `false`; never throws. */
  readonly reserve: (key: string, limit: number) => Promise<boolean>;
  /** Whether the count is shared and survives restarts. Activation requires `true`. */
  readonly durable: boolean;
}

/** The key a judge reserves under: its destination and key reference, never a value. */
export function judgeBudgetKey(destination: string, credentialRefId: string): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([destination, credentialRefId]))
    .digest("hex")}`;
}

const utcDay = (now: number): string | undefined =>
  Number.isFinite(now) ? new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString().slice(0, 10) : undefined;

const validLimit = (limit: unknown): limit is number =>
  Number.isSafeInteger(limit) && (limit as number) > 0 && (limit as number) <= 100_000;

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
  readonly day: string;
  readonly counts: Readonly<Record<string, number>>;
}

function parse(text: string): BudgetFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { version, day, counts } = value as Record<string, unknown>;
  if (version !== JUDGE_BUDGET_FILE_VERSION || typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    return undefined;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) return undefined;
  for (const n of Object.values(counts)) if (!Number.isSafeInteger(n) || (n as number) < 0) return undefined;
  if (Object.keys(value).some((k) => k !== "version" && k !== "day" && k !== "counts")) return undefined;
  return { version, day, counts: counts as Record<string, number> };
}

/** The shared, durable budget in `file` (for example under the daemon's state directory). */
export function fileJudgeBudget(
  file: string,
  options: { now?: () => number; lockTimeoutMs?: number } = {},
): JudgeBudget {
  const now = options.now ?? Date.now;
  const reserve = async (key: string, limit: number): Promise<boolean> => {
    if (typeof key !== "string" || key === "" || !validLimit(limit)) return false;
    try {
      return await withPolicyLock(
        file,
        { strictOwnership: true, timeoutMs: options.lockTimeoutMs ?? 5_000 },
        async (owned) => {
          const today = utcDay(now());
          if (today === undefined) return false;
          let current: BudgetFile;
          try {
            const parsed = parse(await readFile(file, "utf8"));
            if (parsed === undefined) return false;
            current = parsed;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
            current = { version: JUDGE_BUDGET_FILE_VERSION, day: today, counts: {} };
          }
          // A file dated after today means the clock moved back: refuse until that day passes, never reset early.
          if (current.day > today) return false;
          const counts = current.day === today ? { ...current.counts } : {};
          const used = Object.hasOwn(counts, key) ? counts[key]! : 0;
          if (used >= limit) return false;
          counts[key] = used + 1;
          const next: BudgetFile = { version: JUDGE_BUDGET_FILE_VERSION, day: today, counts };
          const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
          try {
            await writeFile(tmp, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
            await owned();
            await rename(tmp, file);
          } catch {
            await rm(tmp, { force: true });
            return false;
          }
          return true;
        },
      );
    } catch {
      return false;
    }
  };
  return Object.freeze({ durable: true, reserve });
}
