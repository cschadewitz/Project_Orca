/**
 * Account status and usage limits on the Codex app-server route (#1164), read from Codex itself
 * on the user's own `codex login`. ORCA never reads Codex's credential files and never calls a
 * login, logout or token method; it only asks `account/read` and `account/rateLimits/read` and
 * listens for `account/updated` and `account/rateLimits/updated`.
 *
 * - **Account:** the kind of login (`apiKey`, `chatgpt`, ...) and, for ChatGPT, the plan. The
 *   user id Codex reports is compared to notice a switched account, never logged; the email
 *   and workspace name are never read. Codex reports a user id only for ChatGPT logins, so for
 *   other logins of the same kind the account's continuity cannot be verified
 *   (`codexAccountContinuity`), and ORCA does not claim it.
 * - **Usage limits:** the snapshots Codex reports per limit bucket (each window's used percent,
 *   length and reset time), each merged only with Codex's sparse updates to the same bucket. A
 *   turn Codex fails with `usageLimitExceeded` or `rateLimitExceeded` names the window and its
 *   reset time when what Codex reported during that turn names exactly one window at its limit.
 */
import { OrcaError } from "@orca/core";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nullableString = (v: unknown) => v === undefined || v === null || typeof v === "string";
const nullableNumber = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));

/** What ORCA keeps of the account Codex runs on: never its email, workspace name or user id. */
export interface CodexAccountStatus {
  kind: "none" | "apiKey" | "chatgpt" | "amazonBedrock" | "gcp";
  /** The ChatGPT plan, when Codex reports one. */
  planType: string | null;
}

/** Who the account is, to notice a switch: the kind and Codex's user id. Compared, never logged. */
export interface CodexAccountIdentity {
  status: CodexAccountStatus;
  userId: string | null;
  signedOut: boolean;
}

const KINDS = ["apiKey", "chatgpt", "amazonBedrock", "gcp"] as const;

/** An `account/read` answer as the account it names; `undefined` for a shape ORCA does not know. */
export function codexAccountIdentity(answer: unknown): CodexAccountIdentity | undefined {
  if (!isObject(answer) || typeof answer.requiresOpenaiAuth !== "boolean" || !nullableString(answer.userId))
    return undefined;
  const userId = typeof answer.userId === "string" ? answer.userId : null;
  if (answer.account === null)
    return { status: { kind: "none", planType: null }, userId, signedOut: answer.requiresOpenaiAuth };
  const account = answer.account;
  if (!isObject(account)) return undefined;
  const kind = KINDS.find((k) => k === account.type);
  if (!kind) return undefined;
  if (kind === "chatgpt" && !nullableString(account.planType)) return undefined;
  return {
    status: { kind, planType: kind === "chatgpt" && typeof account.planType === "string" ? account.planType : null },
    userId,
    signedOut: false,
  };
}

/**
 * Whether `now` is the account a session started on (`then`): `different` when the kind of login
 * or a reported user id differs, `same` only when both carry the same user id, and
 * `unverifiable` otherwise. Codex 0.171.0 reports a user id only for ChatGPT logins, so two API-key
 * (or other) logins of the same kind cannot be told apart: ORCA does not claim they are the same.
 */
export function codexAccountContinuity(
  now: CodexAccountIdentity,
  then: CodexAccountIdentity,
): "same" | "different" | "unverifiable" {
  if (now.status.kind !== then.status.kind) return "different";
  if (now.userId !== null && then.userId !== null) return now.userId === then.userId ? "same" : "different";
  return "unverifiable";
}

/** The bucket a snapshot belongs to: its `limitId`, Codex's own `codex` when it names none. */
export const codexLimitBucket = (limits: { limitId: string | null }) => limits.limitId ?? "codex";

/** Unix seconds as an ISO time, or `undefined` for a time a JS date cannot hold. */
export function codexResetTime(seconds: number | null): string | undefined {
  if (seconds === null || !Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** One usage-limit window as Codex reports it. */
export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}

/** What ORCA keeps of a usage-limit snapshot. */
export interface CodexRateLimits {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

const windowProblem = (w: unknown, name: string) =>
  w === undefined || w === null
    ? undefined
    : !isObject(w) ||
        typeof w.usedPercent !== "number" ||
        !Number.isFinite(w.usedPercent) ||
        !nullableNumber(w.windowDurationMins) ||
        !nullableNumber(w.resetsAt)
      ? `a ${name} usage-limit window without its used percent, length and reset time`
      : undefined;

/** What is wrong with a `RateLimitSnapshot` Codex sent, for the fields ORCA reads; undefined when nothing is. */
export function codexRateLimitsProblem(snapshot: unknown): string | undefined {
  if (!isObject(snapshot)) return "a usage-limit snapshot that is not an object";
  for (const field of ["limitId", "limitName", "planType", "rateLimitReachedType"])
    if (!nullableString(snapshot[field])) return `a usage-limit snapshot whose ${field} is not a string`;
  return windowProblem(snapshot.primary, "primary") ?? windowProblem(snapshot.secondary, "secondary");
}

const readWindow = (w: unknown): CodexRateLimitWindow | null =>
  isObject(w)
    ? {
        usedPercent: w.usedPercent as number,
        windowDurationMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
        resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null,
      }
    : null;
const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * A checked snapshot (`codexRateLimitsProblem` first) merged into the last one of the same
 * bucket: Codex's updates are sparse, so a field it leaves null keeps what was known. A previous
 * snapshot of another bucket contributes nothing.
 */
export function mergeCodexRateLimits(previous: CodexRateLimits | undefined, snapshot: unknown): CodexRateLimits {
  const s = snapshot as Record<string, unknown>;
  if (previous && codexLimitBucket(previous) !== codexLimitBucket({ limitId: str(s.limitId) })) previous = undefined;
  return {
    limitId: str(s.limitId) ?? previous?.limitId ?? null,
    limitName: str(s.limitName) ?? previous?.limitName ?? null,
    primary: readWindow(s.primary) ?? previous?.primary ?? null,
    secondary: readWindow(s.secondary) ?? previous?.secondary ?? null,
    planType: str(s.planType) ?? previous?.planType ?? null,
    rateLimitReachedType: str(s.rateLimitReachedType) ?? previous?.rateLimitReachedType ?? null,
  };
}

/** A window's length as a person says it. */
function windowName(mins: number | null): string {
  if (mins === null) return "usage window";
  if (mins === 10_080) return "weekly window";
  if (mins % 1_440 === 0) return `${mins / 1_440}-day window`;
  if (mins % 60 === 0) return `${mins / 60}-hour window`;
  return `${mins}-minute window`;
}

/**
 * The window that ran out, when the evidence names exactly one: among the snapshots Codex
 * reported during the turn, the one window at or over 100%. Several, or none, name no window.
 */
function limitingWindow(reported: readonly CodexRateLimits[]): CodexRateLimitWindow | undefined {
  const full = reported
    .flatMap((l) => [l.primary, l.secondary])
    .filter((w): w is CodexRateLimitWindow => !!w && w.usedPercent >= 100);
  return full.length === 1 ? full[0] : undefined;
}

/**
 * The failure for a turn Codex ended because a usage or rate limit was reached, naming the window
 * and its reset time when what Codex reported during the turn names exactly one; `undefined` for
 * any other failure. `reported` is the snapshots Codex sent during the turn, never older ones.
 */
export function codexUsageLimitFailure(
  agentId: string,
  codexErrorInfo: unknown,
  reported: readonly CodexRateLimits[],
): OrcaError | undefined {
  const kind =
    codexErrorInfo === "usageLimitExceeded" ? "usage" : codexErrorInfo === "rateLimitExceeded" ? "rate" : undefined;
  if (!kind) return undefined;
  const w = limitingWindow(reported);
  const resets = w ? codexResetTime(w.resetsAt) : undefined;
  const what =
    w === undefined
      ? `Codex reported no single window at its limit for this turn`
      : `the ${windowName(w.windowDurationMins)} is ${Math.round(w.usedPercent)}% used` +
        (resets ? ` and resets at ${resets}` : ", and Codex reported no reset time");
  return new OrcaError(
    "AGENT_PROTOCOL",
    `agent ${agentId}: Codex stopped the turn because the ${kind === "usage" ? "usage" : "rate"} limit of its login is reached: ${what}.`,
    {
      agentId,
      reason: kind === "usage" ? "codex-usage-limit" : "codex-rate-limit",
      window: w ? { durationMins: w.windowDurationMins, usedPercent: w.usedPercent, resetsAt: resets ?? null } : null,
    },
  );
}

/** The refusal of a new turn once Codex reports the user signed out. */
export const codexSignedOut = (agentId: string) =>
  new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agentId}: Codex is no longer signed in. Run \`codex login\` as the account ORCA runs Codex as ` +
      `(with the same CODEX_HOME); ORCA does not sign in to Codex itself.`,
    { agentId, reason: "codex-login-required" },
  );

/** The refusal of a new turn once Codex reports another account than the session started on. */
export const codexAccountSwitched = (agentId: string) =>
  new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agentId}: Codex is now signed in to another account than this session started on. ORCA ` +
      `starts no new turn on it; start a new session to run on the new account.`,
    { agentId, reason: "codex-account-switched" },
  );
