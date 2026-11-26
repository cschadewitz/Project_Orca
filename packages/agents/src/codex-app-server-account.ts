/**
 * Account status and usage limits on the Codex app-server route (#1164), read from Codex itself
 * on the user's own `codex login`. ORCA never reads Codex's credential files and never calls a
 * login, logout or token method; it only asks `account/read` and `account/rateLimits/read` and
 * listens for `account/updated` and `account/rateLimits/updated`.
 *
 * - **Account:** the kind of login (`apiKey`, `chatgpt`, ...) and, for ChatGPT, the plan. The
 *   user id Codex reports is compared to notice a switched account, never logged; the email
 *   and workspace name are never read.
 * - **Usage limits:** the snapshot Codex reports (each window's used percent, length and reset
 *   time), merged with Codex's sparse updates. A turn Codex fails with `usageLimitExceeded` or
 *   `rateLimitExceeded` names the window and its reset time when Codex reported them.
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

/** Whether two `account/read` answers name the same account. */
export const sameCodexAccount = (a: CodexAccountIdentity, b: CodexAccountIdentity) =>
  a.status.kind === b.status.kind && a.userId === b.userId;

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
 * A checked snapshot (`codexRateLimitsProblem` first) merged into the last one: Codex's updates
 * are sparse, so a field it leaves null keeps what was known.
 */
export function mergeCodexRateLimits(previous: CodexRateLimits | undefined, snapshot: unknown): CodexRateLimits {
  const s = snapshot as Record<string, unknown>;
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

/** The window that ran out: the fuller of the two, when Codex reported any. */
function limitingWindow(limits: CodexRateLimits | undefined): CodexRateLimitWindow | undefined {
  const windows = [limits?.primary, limits?.secondary].filter((w): w is CodexRateLimitWindow => !!w);
  return windows.sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

/**
 * The failure for a turn Codex ended because a usage or rate limit was reached, naming the window
 * and its reset time when Codex reported them; `undefined` for any other failure.
 */
export function codexUsageLimitFailure(
  agentId: string,
  codexErrorInfo: unknown,
  limits: CodexRateLimits | undefined,
): OrcaError | undefined {
  const kind =
    codexErrorInfo === "usageLimitExceeded" ? "usage" : codexErrorInfo === "rateLimitExceeded" ? "rate" : undefined;
  if (!kind) return undefined;
  const w = limitingWindow(limits);
  const resets = w?.resetsAt != null ? new Date(w.resetsAt * 1000).toISOString() : undefined;
  const what =
    w === undefined
      ? `Codex reported no window or reset time`
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
