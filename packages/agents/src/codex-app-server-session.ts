/**
 * The Codex app-server session driver (#1157): one `codex app-server` process and one Codex
 * thread, presented as an ORCA `AgentSession`, so nothing above `packages/agents` changes.
 *
 * **Not reachable from a run yet.** The session factory, the ACP launch and delegation still
 * refuse `driver: codex-app-server` (`codex-app-server.ts`) until ORCA's policy answers Codex's
 * asks (#1159). Until then this opens a session only for a caller that names the thread's
 * approval policy and sandbox itself.
 *
 * - **Open:** the user's Codex CLI started as `codex app-server` on ORCA's own host
 *   (`codexAppServerLaunch`, secrets delivered as for any agent), the pinned handshake, the
 *   login check (`account/read`), then `thread/start` with the given approval policy and
 *   sandbox and the reviewer `user`, which are also the process's session flags. The session is
 *   refused, and the process stopped, when the thread comes back with another reviewer,
 *   approval policy, sandbox or working directory, when its sandbox could write a path ORCA
 *   protects, or when Codex's effective config (read before and after the thread starts) is not
 *   ORCA's (`codex-app-server-config.ts`, #1160): ORCA never lets `auto_review` or
 *   `guardian_subagent` decide an ask.
 * - **Turns:** `turn/start` per prompt; the turn ends on Codex's `turn/completed` for that turn
 *   (`completed` → `end_turn`, `interrupted` → `cancelled`, `failed` → an error with Codex's
 *   message). Cancel, abort and timeout send `turn/interrupt`; a turn Codex does not end within
 *   the cancel grace kills the process, as on the ACP route, and the caller settles then even
 *   while `turn/start` is unanswered.
 * - **Failures:** a `turn/start` whose outcome is unknown (no answer in time, the connection
 *   lost, an answer without a turn id) ends the session, since Codex may be running the turn; a
 *   refusal Codex answers with an error does not. Every notification ORCA reads is checked
 *   against the pinned protocol before use: anything malformed closes the connection as
 *   `AGENT_PROTOCOL`, fails the turn and stops the process.
 * - **Events:** Codex's items and deltas become ACP session updates (`codexItemUpdate` and
 *   friends below), so the event log, the app and the ACP facade read them unchanged.
 * - **Asks:** every approval ask is declined and any other ask refused until #1159.
 */
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  newId,
  OrcaError,
  silentLogger,
  systemClock,
  type AgentSpec,
  type Clock,
  type Logger,
  type SecretsConfig,
  type SessionConfigOption,
} from "@orca/core";
import type { AgentHost, AgentProcessHandle } from "./host.js";
import {
  codexAppServerLaunch,
  codexAppServerRequested,
  codexAppServerRefused,
  codexLoginRefused,
  CODEX_ACCOUNT_READ_PARAMS,
} from "./codex-app-server.js";
import {
  CodexAppServerClient,
  CodexRpcError,
  initializeCodexAppServer,
  stdioLineTransport,
} from "./codex-app-server-client.js";
import type { ThreadItem } from "./codex-protocol/0.171.0/v2/ThreadItem.js";
import type { ThreadStartParams } from "./codex-protocol/0.171.0/v2/ThreadStartParams.js";
import type { TurnPlanStep } from "./codex-protocol/0.171.0/v2/TurnPlanStep.js";
import type { ThreadTokenUsage } from "./codex-protocol/0.171.0/v2/ThreadTokenUsage.js";
import { processCleanup } from "./process-cleanup.js";
import {
  codexAccountContinuity,
  codexAccountIdentity,
  codexAccountSwitched,
  codexLimitBucket,
  codexRateLimitsProblem,
  codexSignedOut,
  codexUsageLimitFailure,
  mergeCodexRateLimits,
  type CodexAccountIdentity,
  type CodexAccountStatus,
  type CodexRateLimits,
} from "./codex-app-server-account.js";
import {
  codexConfigCheck,
  codexSessionFlags,
  codexWritableRoots,
  codexWritableRootsProblem,
  type CodexThreadPolicy,
  type CodexVerifiedConfig,
} from "./codex-app-server-config.js";
import {
  checkSecretUse,
  ENV_SECRET_DELIVERY,
  planSessionSecrets,
  redactError,
  redactingLogger,
  type AuthorizeSecretUse,
} from "./secrets.js";
import {
  summarizeUpdate,
  withStartupTermination,
  type AgentSession,
  type PromptOptions,
  type SessionUpdateEvent,
  type TurnResult,
} from "./session.js";

export interface OpenCodexAppServerSessionOptions {
  host: AgentHost;
  agent: AgentSpec;
  cwd: string;
  /**
   * The thread's approval policy and sandbox (`never` and full access are not offered), set as
   * session flags and thread parameters and verified against Codex's effective config.
   */
  thread: CodexThreadPolicy;
  /**
   * Paths no writable root of the thread may overlap: ORCA's config directory and sidecars.
   * The session is refused when the sandbox Codex reports could write one.
   */
  protectedPaths?: readonly string[];
  /** Called with what ORCA verified of Codex's config, on open and after each restart. */
  onVerifiedConfig?: (config: CodexVerifiedConfig) => void;
  /** Called with the account Codex runs on, at open and whenever Codex reports it changed (#1164). */
  onAccount?: (account: CodexAccountStatus) => void;
  /** Called with Codex's usage limits whenever it reports them, merged with what was known (#1164). */
  onRateLimits?: (limits: CodexRateLimits) => void;
  env?: Record<string, string>;
  secrets?: SecretsConfig | undefined;
  authorizeSecretUse?: AuthorizeSecretUse | undefined;
  logger?: Logger;
  clock?: Clock;
  /** ORCA's version, for Codex's `clientInfo`. */
  orcaVersion?: string;
  /** Per-request limit for the handshake and thread requests. Default 30 s. */
  requestTimeoutMs?: number;
  /** Overrides `agent.cancelGraceMs`. */
  cancelGraceMs?: number;
  /** Called once with the token usage Codex last reported, whenever it changes. */
  onTokenUsage?: (usage: ThreadTokenUsage) => void;
  /**
   * A listener for the session's updates from the start, so it also gets the history a resumed
   * thread replays before the session is returned.
   */
  onUpdate?: (event: SessionUpdateEvent) => void;
  /**
   * Resume this Codex thread (`thread/resume`) instead of starting one, replaying its history
   * as session updates. Explicit opt-in only: nothing restores an ask that was pending.
   */
  resumeThreadId?: string;
  /** Fail the open when the thread cannot be resumed, instead of starting a new one. */
  requireContextRecovery?: boolean;
  /** Whether the session resumed the thread or started a new one, and why. */
  onSessionContinuity?: (state: CodexSessionContinuity) => void;
  /** Overrides the crash-loop budget for restarting an app-server that exited. */
  recovery?: Partial<CodexRecoveryLimits>;
  /** For tests: how the restart backoff waits. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: how long each stop signal waits for the process to exit (default 2 s). */
  exitGraceMs?: number;
}

/** As `SessionContinuity` on the ACP route: the thread was resumed, or a new one started. */
export interface CodexSessionContinuity {
  mode: "fresh" | "loaded";
  reason: "new" | "load-supported" | "load-failed";
}

/**
 * How often a session restarts an app-server that exited before it gives up: at most
 * `crashLimit` exits or failed restarts within `windowMs`, the n-th restart waiting
 * `backoffMs[n - 1]` (the last entry after that).
 */
export interface CodexRecoveryLimits {
  crashLimit: number;
  windowMs: number;
  backoffMs: readonly number[];
}

export const CODEX_RECOVERY_LIMITS: CodexRecoveryLimits = {
  crashLimit: 3,
  windowMs: 5 * 60_000,
  backoffMs: [0, 1_000, 2_000, 4_000],
};

/** One app-server process and ORCA's connection to it. */
interface Connection {
  proc: AgentProcessHandle;
  client: CodexAppServerClient;
  cleanup: () => Promise<void>;
  /** The account Codex reported at the handshake, or at its latest re-read. */
  account: CodexAccountIdentity;
  /** Codex sent `account/updated` that ORCA has not re-read the account for yet. */
  accountUpdated?: boolean;
}

/** Provider errors can carry private context: report only the failed recovery boundary, as the ACP route does. */
function codexRecoveryFailure(reason: "missing-thread-id" | "load-failed"): OrcaError {
  return reason === "missing-thread-id"
    ? new OrcaError("CONFIG_INVALID", "Required agent context recovery needs a nonempty resumeThreadId.", {
        contextRecoveryReason: reason,
      })
    : new OrcaError("AGENT_PROTOCOL", "Required agent context could not be loaded; no fresh session was opened.", {
        contextRecoveryReason: reason,
      });
}

/** How many turns a history page asks for, and how many pages ORCA reads at most. */
const HISTORY_PAGE = 50;
const HISTORY_MAX_PAGES = 200;

/**
 * A thread's history as the session updates a live run of it reported: the user's messages,
 * Codex's messages and reasoning summaries, and each tool call started and ended. Read
 * oldest first with `thread/turns/list`; every item is checked against the pinned protocol.
 */
export async function codexThreadHistory(
  client: CodexAppServerClient,
  threadId: string,
  agentId: string,
): Promise<acp.SessionUpdate[]> {
  const updates: acp.SessionUpdate[] = [];
  const malformed = (what: string) =>
    new OrcaError("AGENT_PROTOCOL", `agent ${agentId}: thread/turns/list answered with ${what}`);
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= HISTORY_MAX_PAGES) throw malformed(`more than ${HISTORY_MAX_PAGES} pages`);
    const answer = await client.request("thread/turns/list", {
      threadId,
      sortDirection: "asc",
      itemsView: "full",
      limit: HISTORY_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    if (!isObject(answer) || !Array.isArray(answer.data)) throw malformed("no list of turns");
    for (const turn of answer.data as unknown[]) {
      if (!isObject(turn) || !Array.isArray(turn.items)) throw malformed("a turn without its items");
      for (const item of turn.items as unknown[]) {
        const problem = codexItemProblem(item);
        if (problem) throw malformed(problem);
        updates.push(...codexHistoryUpdates(item as ThreadItem));
      }
    }
    if (answer.nextCursor === null || answer.nextCursor === undefined) return updates;
    if (typeof answer.nextCursor !== "string" || answer.nextCursor === cursor)
      throw malformed("a cursor that does not advance");
    cursor = answer.nextCursor;
  }
}

/** One saved item as the updates a live run reported for it. */
export function codexHistoryUpdates(item: ThreadItem): acp.SessionUpdate[] {
  switch (item.type) {
    case "userMessage":
      return item.content.flatMap((c) =>
        c.type === "text" && c.text
          ? [{ sessionUpdate: "user_message_chunk" as const, content: { type: "text" as const, text: c.text } }]
          : [],
      );
    case "agentMessage":
      return item.text ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } }] : [];
    case "reasoning":
      return item.summary
        .filter((t) => t)
        .map((t) => ({ sessionUpdate: "agent_thought_chunk" as const, content: { type: "text" as const, text: t } }));
    default:
      return [codexItemUpdate(item, "started"), codexItemUpdate(item, "completed")].filter(
        (u): u is acp.SessionUpdate => u !== undefined,
      );
  }
}

/** Methods every session of this driver calls; the handshake refuses a protocol without them. */
export const CODEX_SESSION_METHODS = [
  "account/read",
  "thread/start",
  "turn/start",
  "turn/interrupt",
  "thread/unsubscribe",
  "thread/resume",
  "thread/turns/list",
  "model/list",
  "config/read",
  "configRequirements/read",
  "hooks/list",
  "account/rateLimits/read",
] as const;

/** The notifications the session reads; anything else Codex sends is ignored. */
const HANDLED_NOTIFICATIONS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "item/completed",
  "turn/plan/updated",
  "thread/tokenUsage/updated",
  "turn/completed",
  "account/updated",
  "account/rateLimits/updated",
]);

/** Asks that are approvals, declined until ORCA's policy answers them (#1159). */
const APPROVAL_ASKS: Readonly<Record<string, unknown>> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  execCommandApproval: { decision: "denied" },
  applyPatchApproval: { decision: "denied" },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The sandbox a thread reports for each mode ORCA asks for. */
const SANDBOX_TYPES: Record<CodexThreadPolicy["sandbox"], string> = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
};

/** Paths compared as the host resolves them, links followed, when they exist. */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
}

/** A Codex item's status as an ACP tool call status. */
function toolStatus(status: unknown): acp.ToolCallStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "declined":
      return "failed";
    default:
      return "in_progress";
  }
}

const text = (t: string): acp.ToolCallContent => ({ type: "content", content: { type: "text", text: t } });

/**
 * The ACP update for a Codex item starting (`started`) or ending, or undefined for an item
 * that is not a tool call (messages and reasoning arrive as deltas; the user's own message and
 * Codex's bookkeeping are not reported). An item type ORCA does not know is reported as a
 * generic tool call, never dropped.
 */
export function codexItemUpdate(item: ThreadItem, phase: "started" | "completed"): acp.SessionUpdate | undefined {
  const start = phase === "started";
  const head = { toolCallId: item.id };
  switch (item.type) {
    case "userMessage":
    case "hookPrompt":
    case "agentMessage":
    case "reasoning":
    case "plan":
    case "contextCompaction":
      return undefined;
    case "commandExecution": {
      if (start) return { sessionUpdate: "tool_call", ...head, ...commandFacts(item), status: "in_progress" };
      const output = item.aggregatedOutput ?? "";
      return {
        sessionUpdate: "tool_call_update",
        ...head,
        status: toolStatus(item.status),
        rawOutput: { exitCode: item.exitCode, output, ...(item.status === "declined" ? { declined: true } : {}) },
        ...(output ? { content: [text(output)] } : {}),
      };
    }
    case "fileChange": {
      const locations = item.changes.map((c) => ({ path: c.path }));
      if (start)
        return {
          sessionUpdate: "tool_call",
          ...head,
          title: FILE_CHANGE_TITLE,
          kind: "edit",
          status: "in_progress",
          locations,
          rawInput: { changes: item.changes },
          content: item.changes.map(changeContent),
        };
      return {
        sessionUpdate: "tool_call_update",
        ...head,
        status: toolStatus(item.status),
        rawOutput: { status: item.status },
      };
    }
    case "mcpToolCall": {
      if (start)
        return {
          sessionUpdate: "tool_call",
          ...head,
          title: `mcp__${item.server}__${item.tool}`,
          kind: "other",
          status: "in_progress",
          rawInput: item.arguments,
        };
      return {
        sessionUpdate: "tool_call_update",
        ...head,
        status: toolStatus(item.status),
        rawOutput: item.error ? { error: item.error } : (item.result ?? null),
      };
    }
    case "webSearch":
      return start
        ? { sessionUpdate: "tool_call", ...head, title: "Web search", kind: "fetch", status: "in_progress" }
        : { sessionUpdate: "tool_call_update", ...head, status: "completed" };
    default: {
      // dynamic tools, sub-agents, image views and generation, review mode, sleep, and
      // anything newer: reported as what Codex calls it.
      const status = (item as { status?: unknown }).status;
      return start
        ? { sessionUpdate: "tool_call", ...head, title: item.type, kind: "other", status: "in_progress" }
        : {
            sessionUpdate: "tool_call_update",
            ...head,
            status: status === undefined ? "completed" : toolStatus(status),
          };
    }
  }
}

/** The title the ACP route gives a file change (codex-acp 2.9.0), so both routes read alike. */
const FILE_CHANGE_TITLE = "Editing files";

/** `bash -lc 'cmd'` as `cmd`: the title the ACP route shows for a shell command. */
export function stripShellPrefix(command: string): string {
  const shell = /^(?:\/(?:[^\s/]+\/)*)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/.exec(command);
  if (!shell) return command;
  const rest = command.slice(shell[0].length);
  if (rest.startsWith("-")) return command;
  if (/^'[^']*'$/.test(rest)) return rest.slice(1, -1);
  if (/^"(?:[^"\\]|\\[\s\S])*"$/.test(rest))
    return rest.slice(1, -1).replace(/\\([$`"\\\n])/g, (_, c: string) => (c === "\n" ? "" : c));
  return rest;
}

/**
 * Kind, title and input of a command, from Codex's own reading of it when that is a single
 * action (a file read, a search, a listing), as the ACP route reports them; any other command
 * is `execute`, titled by the command without its shell.
 */
function commandFacts(item: Extract<ThreadItem, { type: "commandExecution" }>): {
  title: string;
  kind: acp.ToolKind;
  locations?: acp.ToolCallLocation[];
  rawInput: unknown;
} {
  const action = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
  const rawInput = { command: item.command, cwd: item.cwd };
  switch (action?.type) {
    case "read":
      return { kind: "read", title: `Read file '${action.path}'`, locations: [{ path: action.path }], rawInput };
    case "search": {
      const { query, path } = action;
      const title =
        query && path
          ? `Search for '${query}' in ${path}`
          : query
            ? `Search for '${query}'`
            : path
              ? `Search in '${path}'`
              : "Search";
      return { kind: "search", title, rawInput };
    }
    case "listFiles":
      return { kind: "read", title: action.path ? `List files in '${action.path}'` : "List files", rawInput };
    default:
      return { kind: "execute", title: stripShellPrefix(item.command), rawInput };
  }
}

/** A file change as ACP content: a whole added or deleted file as a diff, an update as its patch text. */
function changeContent(change: { path: string; kind: { type: string }; diff: string }): acp.ToolCallContent {
  if (change.kind.type === "add") return { type: "diff", path: change.path, oldText: null, newText: change.diff };
  if (change.kind.type === "delete") return { type: "diff", path: change.path, oldText: change.diff, newText: "" };
  return text(change.diff);
}

/** Codex's plan as an ACP plan. */
export function codexPlanUpdate(plan: readonly TurnPlanStep[]): acp.SessionUpdate {
  return {
    sessionUpdate: "plan",
    entries: plan.map((s) => ({
      content: s.step,
      status: s.status === "inProgress" ? "in_progress" : s.status,
      priority: "medium",
    })),
  };
}

/** What a finished turn tells ORCA. */
export function codexStopReason(
  agentId: string,
  turn: unknown,
  reported: readonly CodexRateLimits[] = [],
): acp.StopReason {
  const t = isObject(turn) ? turn : {};
  if (t.status === "completed") return "end_turn";
  if (t.status === "interrupted") return "cancelled";
  const limited =
    t.status === "failed" && isObject(t.error)
      ? codexUsageLimitFailure(agentId, t.error.codexErrorInfo, reported)
      : undefined;
  if (limited) throw limited;
  const error = isObject(t.error) && typeof t.error.message === "string" ? t.error.message : undefined;
  throw new OrcaError(
    "AGENT_PROTOCOL",
    t.status === "failed"
      ? `agent ${agentId}: Codex failed the turn${error ? `: ${error}` : ""}`
      : `agent ${agentId}: Codex ended the turn with status ${JSON.stringify(t.status)}`,
    { agentId, status: t.status ?? null },
  );
}

const isString = (v: unknown): v is string => typeof v === "string";
/** A nullable field: absent, null or a string. */
const optionalString = (v: unknown) => v === undefined || v === null || typeof v === "string";
const PLAN_STATUSES = new Set(["pending", "inProgress", "completed"]);

/**
 * What is wrong with an item Codex sent, against the pinned protocol, for the fields ORCA reads;
 * undefined when nothing is. Checked before `codexItemUpdate` reads nested fields, so a
 * malformed item ends the session as a protocol failure instead of throwing in the stdio callback.
 */
export function codexItemProblem(item: unknown): string | undefined {
  if (!isObject(item) || !isString(item.id) || !item.id || !isString(item.type))
    return "an item without an id and a type";
  const status = item.status === undefined || isString(item.status);
  switch (item.type) {
    case "agentMessage":
      return isString(item.text) ? undefined : "an agentMessage item without its text";
    case "userMessage":
      return Array.isArray(item.content) &&
        (item.content as unknown[]).every(
          (c) => isObject(c) && isString(c.type) && (c.type !== "text" || isString(c.text)),
        )
        ? undefined
        : "a userMessage item without its content";
    case "reasoning":
      return Array.isArray(item.summary) && (item.summary as unknown[]).every(isString)
        ? undefined
        : "a reasoning item without its summary";
    case "commandExecution": {
      if (!isString(item.command) || !isString(item.cwd) || !Array.isArray(item.commandActions) || !status)
        return "a commandExecution item without its command, cwd, actions or status";
      if (!optionalString(item.aggregatedOutput) || !(item.exitCode == null || typeof item.exitCode === "number"))
        return "a commandExecution item with a malformed output or exit code";
      for (const a of item.commandActions as unknown[]) {
        if (!isObject(a) || !isString(a.type)) return "a command action without a type";
        if (a.type === "read" && !isString(a.path)) return "a read command action without its path";
        if (a.type === "listFiles" && !optionalString(a.path))
          return "a listFiles command action with a malformed path";
        if (a.type === "search" && !(optionalString(a.path) && optionalString(a.query)))
          return "a search command action with a malformed query or path";
      }
      return undefined;
    }
    case "fileChange":
      if (!Array.isArray(item.changes) || !status) return "a fileChange item without its changes or status";
      for (const c of item.changes as unknown[])
        if (!isObject(c) || !isString(c.path) || !isString(c.diff) || !isObject(c.kind) || !isString(c.kind.type))
          return "a file change without its path, kind or diff";
      return undefined;
    case "mcpToolCall":
      return isString(item.server) && isString(item.tool) && status
        ? undefined
        : "an mcpToolCall item without its server, tool or status";
    default:
      return status ? undefined : `a ${item.type} item with a malformed status`;
  }
}

/** What is wrong with a plan Codex sent, or undefined. */
export function codexPlanProblem(plan: unknown): string | undefined {
  if (!Array.isArray(plan)) return "a plan that is not a list";
  for (const step of plan as unknown[])
    if (!isObject(step) || !isString(step.step) || !PLAN_STATUSES.has(step.status as string))
      return "a plan step without its text or a known status";
  return undefined;
}

const TOKEN_FIELDS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

/** What is wrong with token usage Codex sent, or undefined. */
export function codexTokenUsageProblem(usage: unknown): string | undefined {
  const breakdown = (b: unknown) => isObject(b) && TOKEN_FIELDS.every((f) => typeof b[f] === "number");
  if (!isObject(usage) || !breakdown(usage.total) || !breakdown(usage.last))
    return "token usage without its total and last counts";
  if (!(usage.modelContextWindow == null || typeof usage.modelContextWindow === "number"))
    return "token usage with a malformed context window";
  return undefined;
}

interface ActiveTurn {
  /** Codex's turn id, once `turn/start` answers. */
  turnId?: string;
  /** Turns Codex finished while `turn/start` had not answered yet; dropped with the turn. */
  finishedEarly: Map<string, unknown>;
  /** Agent message items that streamed deltas, so their completion does not repeat the text. */
  streamed: Set<string>;
  cancelReason?: string;
  /** Waiting on an account re-read, before any turn/start: a cancel ends the wait, nothing else. */
  waking?: () => void;
  grace?: ReturnType<typeof setTimeout>;
  /** The turn already failed (the cancel grace ran out, or the connection ended). */
  failed?: boolean;
  done: (turn: unknown) => void;
  fail: (error: Error) => void;
}

/**
 * Open a Codex app-server session. Refused unless the spec asks for the driver and the host is
 * ORCA's own; every failure after the process starts stops it, with its exit attached.
 */
export async function openCodexAppServerSession(opts: OpenCodexAppServerSessionOptions): Promise<AgentSession> {
  const agent = opts.agent;
  if (!codexAppServerRequested(agent))
    throw new OrcaError("NOT_SUPPORTED", `agent ${agent.id} does not ask for driver: codex-app-server`, {
      agentId: agent.id,
    });
  if (opts.host.spec.type !== "local") throw codexAppServerRefused(agent, "non-local-host", opts.host.spec)!;
  const policy = opts.thread as Partial<CodexThreadPolicy> | undefined;
  if (
    !policy ||
    !["untrusted", "on-request"].includes(policy.approvalPolicy as string) ||
    !["read-only", "workspace-write"].includes(policy.sandbox as string)
  )
    throw new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agent.id}: a Codex app-server session needs an approval policy (untrusted or on-request) and a sandbox (read-only or workspace-write)`,
      { agentId: agent.id },
    );
  if (opts.requireContextRecovery && !opts.resumeThreadId?.trim()) throw codexRecoveryFailure("missing-thread-id");

  const secretPlan = planSessionSecrets(opts.host, agent, opts.secrets);
  await checkSecretUse(secretPlan, opts.host, agent.id, opts.authorizeSecretUse);
  const values: string[] = [];
  const redacted = <T>(work: () => Promise<T>) =>
    work().catch((error: unknown) => {
      throw redactError(error, values);
    });

  const launch = await codexAppServerLaunch(agent, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    sessionFlags: codexSessionFlags(opts.thread),
  });
  const spec: AgentSpec = { ...secretPlan.agent, command: launch.command, args: launch.args };
  /** The `$TMPDIR` Codex sees, which a workspace-write sandbox lets it write unless excluded. */
  const fromAgent = agent.env.TMPDIR;
  const tmpdir = opts.env?.TMPDIR ?? (typeof fromAgent === "string" ? fromAgent : process.env.TMPDIR);
  // Everything logged passes the session's secret values through redaction first: a stderr
  // tail or a provider message can carry them.
  const logger = redactingLogger(
    (opts.logger ?? silentLogger).child({ agent: agent.id, host: opts.host.id }),
    () => values,
  );
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limits = { ...CODEX_RECOVERY_LIMITS, ...(opts.recovery ?? {}) };
  const listeners = new Set<(e: SessionUpdateEvent) => void>();
  if (opts.onUpdate) listeners.add(opts.onUpdate);
  const id = newId("sess", clock.now());
  let threadId = "";
  let active: ActiveTurn | undefined;
  /** Set once the session cannot take another prompt: Codex may still be running a turn. */
  let broken: OrcaError | undefined;
  /** The account the session started on, which every later answer is compared to. */
  const sessionAccount: { identity?: CodexAccountIdentity } = {};
  /**
   * Set while Codex reports the user signed out or on another account, or while ORCA could not
   * confirm the account after Codex reported a change: new turns are refused.
   */
  let accountProblem: OrcaError | undefined;
  /** The account re-read in progress after `account/updated`; new turns wait for it. */
  let accountCheck: Promise<void> | undefined;
  /** Bumped per account re-read, so only the latest answer counts. */
  let accountReads = 0;
  /**
   * Codex's usage limits per bucket (`limitId`), for the live connection and account only, each
   * with the sequence number of its last update so a stale read never overwrites a newer one.
   */
  const limitBuckets = new Map<string, { limits: CodexRateLimits; seq: number }>();
  let limitSeq = 0;
  /**
   * Each snapshot as Codex sent it, unmerged, with its sequence number: the evidence a failed turn
   * is read against, so a window known only from before the turn never names its failure.
   */
  let limitReports: { seq: number; snapshot: unknown }[] = [];
  /** A new account or process: what was known of its usage limits no longer holds. */
  const forgetLimits = () => {
    accountGen++;
    limitBuckets.clear();
    limitReports = [];
  };
  /**
   * Bumped when the account is read again or a new process is installed: a usage-limit read
   * begun before it describes another account or process, and is dropped.
   */
  let accountGen = 0;
  /** The live app-server; undefined after it exited, until the next prompt restarts it. */
  let conn: Connection | undefined;
  /** The connection that exited last, whose process the restart waits on. */
  let lost: Connection | undefined;
  /** Every app-server this session started; `terminated` waits on all of their exits. */
  const owned = new Set<Connection>();
  /** The replacement being started, until it is installed or given up. */
  let starting: Connection | undefined;
  /** The restart in progress, which close waits out. */
  let restarting: Promise<unknown> | undefined;
  /** Ends a restart's backoff early, when the prompt is cancelled or the session stops. */
  let wakeRestart: (() => void) | undefined;
  /** When each exit or failed restart happened, for the crash-loop budget. */
  const crashes: number[] = [];
  let closing = false;
  /** Whether the open finished: from then on an exit is recovered rather than the open's failure. */
  let open = false;
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => (closedResolve = r));
  let terminatedResolve!: () => void;
  let terminatedReject!: (error: unknown) => void;
  const terminated = new Promise<void>((resolve, reject) => {
    terminatedResolve = resolve;
    terminatedReject = reject;
  });
  void terminated.catch(() => undefined);

  const event = (update: acp.SessionUpdate): SessionUpdateEvent => ({
    sessionId: threadId,
    raw: update,
    summary: summarizeUpdate(update),
    at: clock.now(),
  });
  const emit = (update: acp.SessionUpdate) => {
    const e = event(update);
    for (const l of listeners) l(e);
  };

  /** Codex sent something the pinned protocol does not allow: the connection ends, and the session with it. */
  class PayloadProblem extends Error {}
  const check = (problem: string | undefined) => {
    if (problem) throw new PayloadProblem(problem);
  };

  /**
   * A usage-limit snapshot from `c` into its bucket. A read (`read`) is dropped when the account
   * or process changed since it began, or Codex updated the bucket since; it is never evidence
   * about a turn, since finishing during one says nothing of when Codex measured it.
   */
  const applyLimits = (c: Connection, snapshot: unknown, read?: { since: number; gen: number }) => {
    if (conn !== c) return;
    if (read && read.gen !== accountGen) return;
    const since = read?.since;
    const bucket = codexLimitBucket({ limitId: (snapshot as { limitId: string | null }).limitId ?? null });
    const previous = limitBuckets.get(bucket);
    if (since !== undefined && previous && previous.seq > since) return;
    const limits = mergeCodexRateLimits(previous?.limits, snapshot);
    limitBuckets.set(bucket, { limits, seq: ++limitSeq });
    if (!read) limitReports.push({ seq: limitSeq, snapshot });
    opts.onRateLimits?.(limits);
  };
  /**
   * What Codex reported after sequence number `since`, per bucket, merging only those reports:
   * nothing known from before counts. Older reports are dropped, since only one turn runs at a time.
   */
  const limitsSince = (since: number) => {
    limitReports = limitReports.filter((r) => r.seq > since);
    const byBucket = new Map<string, CodexRateLimits>();
    for (const { snapshot } of limitReports) {
      const bucket = codexLimitBucket({ limitId: (snapshot as { limitId: string | null }).limitId ?? null });
      byBucket.set(bucket, mergeCodexRateLimits(byBucket.get(bucket), snapshot));
    }
    return [...byBucket.values()];
  };

  /**
   * Read `c`'s account again after Codex reported it changed, as `c.account`. `undefined` when the
   * read failed: no answer in time, a refusal, or the connection lost.
   */
  const rereadAccount = async (c: Connection): Promise<CodexAccountIdentity | undefined> => {
    c.accountUpdated = false;
    let answer: unknown;
    try {
      answer = await c.client.request("account/read", CODEX_ACCOUNT_READ_PARAMS);
    } catch {
      return undefined;
    }
    const now = codexAccountIdentity(answer);
    if (!now) {
      c.client.closeOnProtocolError("an account/read answer with a shape ORCA does not know");
      return undefined;
    }
    c.account = now;
    return now;
  };
  /** Whether `now` may run turns for a session that started on `then`; its refusal otherwise. */
  const accountRefusal = (now: CodexAccountIdentity, then: CodexAccountIdentity): OrcaError | undefined => {
    if (now.signedOut) return codexSignedOut(agent.id);
    const continuity = codexAccountContinuity(now, then);
    if (continuity === "different") return codexAccountSwitched(agent.id);
    if (continuity === "unverifiable")
      logger.info("Codex reports no account id for this kind of login, so ORCA cannot confirm it is the same account", {
        kind: now.status.kind,
      });
    return undefined;
  };
  /**
   * After Codex reports the account changed on the live connection: new turns wait for the
   * re-read, and are refused while the user is signed out, on another account, or the account
   * could not be confirmed. Only the latest re-read counts; usage limits start over.
   */
  /** The account re-read in progress, read anew each time (it changes across awaits). */
  const pendingAccountCheck = () => accountCheck;
  const recheckAccount = (c: Connection) => {
    const read = ++accountReads;
    // Usage-limit reads begun before this describe an account that may be gone.
    accountGen++;
    const check = (async () => {
      const then = sessionAccount.identity;
      const now = await rereadAccount(c);
      if (read !== accountReads || !then) return;
      forgetLimits();
      if (!now) {
        // A lost connection is the restart's to deal with: it reads the account again.
        accountProblem = c.client.closed
          ? undefined
          : new OrcaError(
              "NOT_SUPPORTED",
              `agent ${agent.id}: Codex reported its account changed, and ORCA could not read it again. ORCA ` +
                `starts no new turn until it can; start a new session.`,
              { agentId: agent.id, reason: "codex-account-unconfirmed" },
            );
        return;
      }
      accountProblem = accountRefusal(now, then);
      logger.info("Codex reported its account changed", {
        kind: now.status.kind,
        planType: now.status.planType,
        refused: accountProblem?.details?.["reason"] ?? null,
      });
      opts.onAccount?.(now.status);
    })();
    accountCheck = check.finally(() => {
      if (accountCheck === settled) accountCheck = undefined;
    });
    const settled = accountCheck;
    return settled;
  };
  /**
   * Codex's usage limits, read once a ChatGPT login is in place (Codex answers no other login):
   * in the background, since the read goes to OpenAI, and only as diagnostics. Every bucket Codex
   * answers with is kept apart, and none overwrites an update Codex sent after the read began.
   */
  const readRateLimits = async (c: Connection) => {
    if (c.account.status.kind !== "chatgpt") return;
    const read = { since: limitSeq, gen: accountGen };
    let answer: unknown;
    try {
      answer = await c.client.request(
        "account/rateLimits/read",
        { excludeResetCreditDetails: true },
        { timeoutMs: 10_000 },
      );
    } catch (error) {
      logger.debug("Codex reported no usage limits", {
        code: error instanceof CodexRpcError || error instanceof OrcaError ? error.code : "unknown",
      });
      return;
    }
    const a = isObject(answer) ? answer : {};
    const byId = a.rateLimitsByLimitId;
    const snapshots =
      byId === null || byId === undefined ? [a.rateLimits] : isObject(byId) ? Object.values(byId) : [undefined];
    for (const snapshot of snapshots) {
      const problem = codexRateLimitsProblem(snapshot);
      if (problem) {
        c.client.closeOnProtocolError(`an account/rateLimits/read answer with ${problem}`);
        return;
      }
    }
    for (const snapshot of snapshots) applyLimits(c, snapshot, read);
  };

  const onNotification = (method: string, params: unknown) => {
    if (!isObject(params)) {
      if (HANDLED_NOTIFICATIONS.has(method)) throw new PayloadProblem("params that are not an object");
      return;
    }
    if (threadId && typeof params.threadId === "string" && params.threadId !== threadId) return;
    switch (method) {
      case "item/agentMessage/delta":
        check(isString(params.itemId) && isString(params.delta) ? undefined : "a delta without its item id and text");
        active?.streamed.add(params.itemId as string);
        if (params.delta)
          emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.delta as string } });
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        check(isString(params.delta) ? undefined : "a reasoning delta without its text");
        if (params.delta)
          emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: params.delta as string } });
        return;
      case "item/started":
      case "item/completed": {
        check(codexItemProblem(params.item));
        const item = params.item as ThreadItem;
        if (method === "item/completed" && item.type === "agentMessage" && !active?.streamed.has(item.id) && item.text)
          emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } });
        const update = codexItemUpdate(item, method === "item/started" ? "started" : "completed");
        if (update) emit(update);
        return;
      }
      case "turn/plan/updated":
        check(codexPlanProblem(params.plan));
        emit(codexPlanUpdate(params.plan as TurnPlanStep[]));
        return;
      case "thread/tokenUsage/updated":
        check(codexTokenUsageProblem(params.tokenUsage));
        opts.onTokenUsage?.(params.tokenUsage as ThreadTokenUsage);
        return;
      case "account/rateLimits/updated":
        check(codexRateLimitsProblem(params.rateLimits));
        if (conn) applyLimits(conn, params.rateLimits);
        return;
      case "account/updated":
        check(
          optionalString(params.authMode) && optionalString(params.planType) && optionalString(params.reason)
            ? undefined
            : "an account update whose auth mode, plan or reason is not a string",
        );
        // Signed out: no new turn until Codex reports an account again.
        if (params.authMode === null) accountProblem = codexSignedOut(agent.id);
        // Before the session is open there is no account to compare yet: the open re-reads it.
        if (conn && sessionAccount.identity) void recheckAccount(conn);
        return;
      case "turn/completed": {
        const turn = params.turn;
        check(
          isObject(turn) && isString(turn.id) && isString(turn.status) ? undefined : "a turn without its id and status",
        );
        const turnId = (turn as { id: string }).id;
        if (!active) return;
        if (active.turnId === turnId) active.done(turn);
        // Only while this session's turn/start is still unanswered: its turn may finish first.
        else if (active.turnId === undefined) active.finishedEarly.set(turnId, turn);
        return;
      }
      default:
        return;
    }
  };

  /** Exits and failed restarts within the window, after dropping older ones. */
  const recentCrashes = () => {
    const since = clock.now() - limits.windowMs;
    while (crashes.length && crashes[0]! < since) crashes.shift();
    return crashes.length;
  };
  const crashLoop = (last: Error) =>
    new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agent.id}: the Codex app-server exited or failed to restart ${crashes.length} times within ` +
        `${Math.round(limits.windowMs / 1000)}s; ORCA stops the session (last: ${last.message})`,
      { agentId: agent.id, crashes: crashes.length },
    );

  /**
   * The connection ended. ORCA's own close is nothing more; a protocol error ends the session;
   * anything else is Codex exiting or its stdio closing: the turn fails, any ask it raised goes
   * unanswered (the client never writes to a closed connection), the process is stopped, and the
   * next prompt starts a new app-server on the same thread, within the crash budget.
   */
  const connectionClosed = (c: Connection, error: OrcaError) => {
    if (conn !== c) return;
    // While opening, the open's pending request fails with this error and the open stops it.
    if (closing || !open || error.code === "AGENT_PROTOCOL") {
      active?.fail(error);
      if (open && !closing) breakSession(error);
      return;
    }
    conn = undefined;
    lost = c;
    void c.cleanup().catch(() => undefined);
    crashes.push(clock.now());
    if (recentCrashes() >= limits.crashLimit) {
      const loop = crashLoop(error);
      active?.fail(loop);
      breakSession(loop);
      return;
    }
    active?.fail(error);
    logger.warn("Codex app-server exited; ORCA restarts it on the next prompt", {
      error: error.message,
      stderr: c.proc.stderrTail(),
      crashes: crashes.length,
    });
  };

  /**
   * Start `codex app-server`, handshake and check the login. The session owns the process from
   * its spawn (`owned`, and `starting` for a replacement), so a close or cancel can stop it at
   * any step; `stopped` says why it must not go on. The process is stopped on any failure.
   */
  const connect = async (replacement: boolean, stopped: () => Error | undefined): Promise<Connection> => {
    const proc = await opts.host.spawnAgent(spec, {
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      ...ENV_SECRET_DELIVERY.spawnOptions(secretPlan),
    });
    values.push(...(proc.secretValues?.values() ?? []));
    const cleanup = processCleanup(proc, opts.exitGraceMs);
    const c = { proc, cleanup } as Connection;
    owned.add(c);
    if (replacement) starting = c;
    const fail = async (error: unknown): Promise<never> => {
      await cleanup().catch(() => undefined);
      const failure = redactError(error instanceof Error ? error : new Error(String(error)), values);
      throw withStartupTermination(failure, proc.exited);
    };
    const why = stopped();
    if (why) return fail(why);
    if (!proc.stdio)
      return fail(new OrcaError("NOT_SUPPORTED", `host ${opts.host.id} cannot give an agent's raw stdio`));
    const client: CodexAppServerClient = new CodexAppServerClient(stdioLineTransport(proc.stdio()), {
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
      onNotification: (method, params) => {
        // Noted for a connection not yet live too: it is not published until it is re-read.
        if (method === "account/updated") c.accountUpdated = true;
        if (conn !== c) return;
        try {
          onNotification(method, params);
        } catch (error) {
          if (!(error instanceof PayloadProblem)) throw error;
          client.closeOnProtocolError(`a ${method} notification with ${error.message}`);
        }
      },
      // Until ORCA's policy answers asks (#1159): approvals declined, anything else refused.
      onServerRequest: async (method) => {
        const answer = APPROVAL_ASKS[method];
        if (answer !== undefined) {
          logger.warn("Codex asked for approval; declined until ORCA's ask bridge (#1159)", { method });
          return answer;
        }
        throw new CodexRpcError(-32601, `ORCA does not answer ${method} yet`);
      },
      onClose: (error) => connectionClosed(c, error),
    });
    c.client = client;
    try {
      await initializeCodexAppServer(client, {
        agentId: agent.id,
        orcaVersion: opts.orcaVersion ?? "0.0.0",
        requiredMethods: CODEX_SESSION_METHODS,
      });
      const answer = await client.request("account/read", CODEX_ACCOUNT_READ_PARAMS);
      const login = codexLoginRefused(agent.id, answer);
      if (login) throw login;
      const account = codexAccountIdentity(answer);
      if (!account)
        throw new OrcaError(
          "AGENT_PROTOCOL",
          `agent ${agent.id}: Codex answered account/read with a shape ORCA does not know`,
          {
            agentId: agent.id,
          },
        );
      c.account = account;
      return c;
    } catch (error) {
      client.close("closed after a refused open");
      return fail(error);
    }
  };

  const policyParams = () => ({
    cwd: opts.cwd,
    approvalPolicy: opts.thread.approvalPolicy,
    approvalsReviewer: "user" as const,
    sandbox: opts.thread.sandbox,
  });
  /** The thread Codex answered with, refused unless it is what ORCA asked for. */
  const acceptThread = (method: string, answer: unknown, want?: string) => {
    const t = isObject(answer) ? answer : {};
    const thread = isObject(t.thread) ? t.thread : {};
    if (typeof thread.id !== "string" || !thread.id)
      throw new OrcaError("AGENT_PROTOCOL", `agent ${agent.id}: ${method} answered without a thread id`);
    const refuse = (what: string, got: unknown) =>
      new OrcaError(
        "NOT_SUPPORTED",
        `agent ${agent.id}: Codex ${method === "thread/start" ? "started" : "resumed"} the thread with ${what} ${JSON.stringify(got)}, not what ORCA asked for. ORCA refuses the session.`,
        { agentId: agent.id, [what.replace(/ /g, "_")]: got ?? null },
      );
    if (want !== undefined && thread.id !== want) throw refuse("thread id", thread.id);
    if (t.approvalsReviewer !== "user") throw refuse("approvals reviewer", t.approvalsReviewer);
    if (t.approvalPolicy !== opts.thread.approvalPolicy) throw refuse("approval policy", t.approvalPolicy);
    if (typeof t.cwd !== "string" || !samePath(t.cwd, opts.cwd)) throw refuse("working directory", t.cwd);
    const sandbox = isObject(t.sandbox) ? t.sandbox.type : undefined;
    const roots = codexWritableRoots(t.sandbox, opts.cwd, tmpdir);
    if (roots === undefined || sandbox !== SANDBOX_TYPES[opts.thread.sandbox])
      throw configRefusal(refuse("sandbox", sandbox));
    const overlap = codexWritableRootsProblem(roots, opts.protectedPaths ?? []);
    if (overlap)
      throw configRefusal(
        new OrcaError("NOT_SUPPORTED", `agent ${agent.id}: ${overlap}. ORCA refuses the session.`, {
          agentId: agent.id,
        }),
      );
    return {
      id: thread.id,
      model: typeof t.model === "string" ? t.model : undefined,
      effort: typeof t.reasoningEffort === "string" ? t.reasoningEffort : null,
    };
  };
  /**
   * Refusals of what Codex would run with: its config, or the sandbox a thread came back with.
   * On a restart these stop the session; a request that failed or was cut short is not one.
   */
  const configRefusals = new WeakSet<object>();
  const configRefusal = (error: OrcaError) => {
    configRefusals.add(error);
    return error;
  };
  /**
   * What Codex will run with on `c`, read back and checked (`codexConfigCheck`): before a thread
   * is started or resumed, and again on the thread, since starting a workspace-write thread has
   * Codex trust the project and load its config.
   */
  const verifyConfig = async (c: Connection, thread?: string) => {
    const config = await c.client.request("config/read", { includeLayers: true, cwd: opts.cwd });
    const requirements = await c.client.request("configRequirements/read", undefined);
    const hooks = await c.client.request("hooks/list", thread ? { threadId: thread } : { cwds: [opts.cwd] });
    try {
      return codexConfigCheck(agent.id, opts.thread, { config, requirements, hooks });
    } catch (error) {
      throw configRefusal(error as OrcaError);
    }
  };
  const recordConfig = (verified: CodexVerifiedConfig) => {
    logger.info("Codex's effective config verified", { ...verified });
    opts.onVerifiedConfig?.(verified);
  };
  /** `thread/resume` of `want` on `c`, with ORCA's policy, history left to `thread/turns/list`. */
  const resumeOn = async (c: Connection, want: string) =>
    acceptThread(
      "thread/resume",
      await c.client.request("thread/resume", {
        threadId: want,
        ...policyParams(),
        ...(model ? { model } : {}),
        excludeTurns: true,
      }),
      want,
    );

  let configOptions: SessionConfigOption[] = [];
  let model: string | undefined;
  let effort: string | null = null;
  let continuity: CodexSessionContinuity = { mode: "fresh", reason: "new" };
  conn = await connect(false, () => undefined);
  let verified: CodexVerifiedConfig;
  try {
    await verifyConfig(conn);
    let opened: ReturnType<typeof acceptThread> | undefined;
    if (opts.resumeThreadId) {
      try {
        opened = await resumeOn(conn, opts.resumeThreadId);
        threadId = opened.id;
        // History is part of the resume: a thread whose history cannot be read is not resumed.
        for (const update of await codexThreadHistory(conn.client, threadId, agent.id)) emit(update);
        continuity = { mode: "loaded", reason: "load-supported" };
      } catch (error) {
        // A closed connection is the open's own failure, never a failed resume to fall back from.
        if (conn.client.closed) throw conn.client.closed;
        if (opts.requireContextRecovery) throw codexRecoveryFailure("load-failed");
        // The provider's own words stay out of the log, as out of the recovery failure.
        logger.warn("Codex could not resume the thread; ORCA starts a new one", {
          code: error instanceof OrcaError ? error.code : error instanceof CodexRpcError ? error.code : "unknown",
        });
        opened = undefined;
        threadId = "";
        continuity = { mode: "fresh", reason: "load-failed" };
      }
    }
    if (!opened) {
      // No `cwd`: the app-server already runs in it. A `thread/start` that names a cwd Codex
      // has no trust recorded for, with a sandbox that can write it, has Codex write that
      // project as trusted into the user's own config.toml (0.171.0
      // `thread_processor.rs`, `requested_cwd.is_some() && …`), a lasting change to their
      // profile that also puts the project's config, hooks and exec policies in force. The
      // thread's cwd is still checked against ORCA's in the answer.
      const { cwd: _cwd, ...startPolicy } = policyParams();
      const params: ThreadStartParams = {
        ...startPolicy,
        ...(agent.defaultModel ? { model: agent.defaultModel } : {}),
      };
      opened = acceptThread("thread/start", await conn.client.request("thread/start", params));
      threadId = opened.id;
    }
    verified = await verifyConfig(conn, threadId);
    model = opened.model;
    effort = opened.effort;
    configOptions = await readConfigOptions(conn.client, model, effort, logger);
  } catch (error) {
    const c = conn;
    closing = true;
    c.client.close("closed after a refused open");
    await c.cleanup().catch(() => undefined);
    throw withStartupTermination(
      redactError(error instanceof Error ? error : new Error(String(error)), values),
      c.proc.exited,
    );
  }
  // An account update during the open: the session starts on the account Codex reports now.
  while (conn.accountUpdated) {
    const now = await rereadAccount(conn);
    const refusal = !now
      ? new OrcaError(
          "AGENT_TRANSPORT",
          `agent ${agent.id}: Codex reported its account changed during the open, and ORCA could not read it again`,
          { agentId: agent.id },
        )
      : now.signedOut
        ? codexSignedOut(agent.id)
        : undefined;
    if (refusal) {
      closing = true;
      conn.client.close("closed after a refused open");
      await conn.cleanup().catch(() => undefined);
      throw refusal;
    }
  }
  opts.onSessionContinuity?.(continuity);
  recordConfig(verified);
  sessionAccount.identity = conn.account;
  logger.info("Codex account", { kind: conn.account.status.kind, planType: conn.account.status.planType });
  opts.onAccount?.(conn.account.status);
  void readRateLimits(conn);

  const cancelGraceMs = opts.cancelGraceMs ?? agent.cancelGraceMs;
  let terminating: Promise<void> | undefined;
  /**
   * Close: unsubscribe from the thread while the live connection is up, stop a replacement
   * still starting, wait out the restart, then stop every process the session started.
   * `terminated` resolves once each of them has exited.
   */
  const terminate = () =>
    (terminating ??= (async () => {
      closing = true;
      wakeRestart?.();
      starting?.client?.close("closed by ORCA: the session closed during a restart");
      const c = conn;
      if (c && !c.client.closed) {
        await c.client.request("thread/unsubscribe", { threadId }, { timeoutMs: 5_000 }).catch(() => undefined);
        c.client.close();
      }
      for (const o of owned) if (o.client && !o.client.closed) o.client.close();
      closedResolve();
      await restarting?.catch(() => undefined);
      const results = await Promise.allSettled([...owned].map((o) => o.cleanup()));
      void Promise.all([...owned].map((o) => o.proc.exited)).then(
        () => terminatedResolve(),
        (error: unknown) => terminatedReject(error),
      );
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    })());
  /**
   * Stop now, waiting on no reply: every connection is closed first, so a pending unsubscribe
   * or handshake fails at once, and the processes are stopped.
   */
  const stopNow = () => {
    closing = true;
    for (const o of owned) if (o.client && !o.client.closed) o.client.close("closed by ORCA: the session stopped");
    return terminate();
  };
  /** The session takes no further prompt, and stops. */
  function breakSession(error: OrcaError) {
    broken ??= error;
    void stopNow().catch(() => undefined);
  }
  open = true;
  // Codex may have exited between its last answer and here.
  if (conn.client.closed) connectionClosed(conn, conn.client.closed);

  /**
   * A new app-server for the same thread after the last one exited: after the backoff its crash
   * count calls for, once the old process is gone, with the same policy checks as the open.
   * A failed restart counts against the budget like an exit.
   */
  /** The session's failure, read fresh (TypeScript narrows `broken` across awaits). */
  const isBroken = (): OrcaError | undefined => broken;
  /** A restart given up because its prompt was cancelled: not a crash, and the prompt ends cancelled. */
  class RestartCancelled extends Error {}
  /**
   * Wait for `c`'s process to be gone. When its exit cannot be confirmed, Codex may still be
   * running on the thread, so the session stops and takes no further prompt.
   */
  const confirmGone = async (c: Connection, which: string) => {
    try {
      await c.cleanup();
    } catch {
      breakSession(
        new OrcaError(
          "AGENT_TRANSPORT",
          `agent ${agent.id}: the Codex app-server ${which} could not be confirmed gone, so ORCA does not ` +
            `start another on its thread and stops the session`,
          { agentId: agent.id, stderr: c.proc.stderrTail() },
        ),
      );
      throw isBroken()!;
    }
  };
  const restart = async (turn: ActiveTurn): Promise<Connection> => {
    const stopped = () =>
      isBroken() ??
      (closing ? new OrcaError("RUN_STATE", "the session closed during the restart") : undefined) ??
      (turn.cancelReason ? new RestartCancelled(turn.cancelReason) : undefined);
    const n = recentCrashes();
    const wait = n === 0 ? 0 : limits.backoffMs[Math.min(n, limits.backoffMs.length) - 1]!;
    if (wait > 0) await Promise.race([sleep(wait), new Promise<void>((r) => (wakeRestart = r))]);
    wakeRestart = undefined;
    const early = stopped();
    if (early) throw early;
    // Two app-servers never own the thread: the last one has to be seen gone first.
    if (lost) await confirmGone(lost, "that exited");
    let c: Connection | undefined;
    try {
      c = await connect(true, stopped);
      // A config or sandbox that no longer holds is not a crash to retry: the session stops.
      // A cancel or close first keeps its own outcome, since it closes the replacement under
      // whatever request is in flight; any other failure is a failed restart, as before.
      const refused = (error: unknown): never => {
        const why = stopped();
        if (why) throw why;
        if (error instanceof OrcaError && configRefusals.has(error)) breakSession(error);
        throw error;
      };
      // The account the replacement runs on, re-read if Codex reported a change since: another
      // account than the session started on stops the session, before the thread is resumed on it
      // and again before the replacement is published.
      const checkAccount = async (live: Connection) => {
        while (live.accountUpdated)
          if (!(await rereadAccount(live)))
            refused(
              new OrcaError("AGENT_TRANSPORT", `agent ${agent.id}: ORCA could not read the restarted Codex's account`),
            );
        const switched = sessionAccount.identity ? accountRefusal(live.account, sessionAccount.identity) : undefined;
        if (switched) refused(configRefusal(switched));
      };
      await verifyConfig(c).catch(refused);
      // No await between the last account check and thread/resume going out (nor, below, between
      // it and publishing the replacement): an update Codex sends in between is read first.
      await checkAccount(c);
      const resumed = await resumeOn(c, threadId).catch(refused);
      const reverified = await verifyConfig(c, threadId).catch(refused);
      await checkAccount(c);
      const late = stopped();
      if (late) throw late;
      conn = c;
      lost = undefined;
      // A new process: usage limits start over, and the account is the one just confirmed.
      forgetLimits();
      accountProblem = undefined;
      model = resumed.model ?? model;
      logger.info("Codex app-server restarted on the same thread", { threadId, crashes: crashes.length });
      recordConfig(reverified);
      void readRateLimits(c);
      return c;
    } catch (error) {
      // A replacement that failed or was cancelled is stopped, and has to be seen gone like an
      // exited one: otherwise the next prompt could start a third app-server beside it.
      const replacement = c ?? starting;
      if (replacement) {
        replacement.client?.close("closed after a failed restart");
        await confirmGone(replacement, "ORCA was starting");
      }
      const why = stopped();
      if (why) throw why;
      crashes.push(clock.now());
      const failure = new OrcaError(
        "AGENT_TRANSPORT",
        `agent ${agent.id}: ORCA could not restart the Codex app-server: ${(error as Error).message}`,
        { agentId: agent.id },
      );
      if (recentCrashes() >= limits.crashLimit) {
        breakSession(crashLoop(failure));
        throw isBroken() ?? failure;
      }
      throw failure;
    } finally {
      starting = undefined;
    }
  };

  const requestCancel = (reason: string) => {
    const turn = active;
    if (!turn || turn.cancelReason) return;
    turn.cancelReason = reason;
    // Still waiting on an account re-read: no turn was started, and none will be.
    if (turn.waking) {
      turn.waking();
      return;
    }
    // While the app-server restarts there is no turn yet: the replacement is stopped where it
    // is, and the prompt ends cancelled.
    const c = conn;
    if (!c) {
      wakeRestart?.();
      starting?.client?.close("closed by ORCA: the prompt was cancelled during a restart");
      return;
    }
    const interrupt = () => {
      if (turn.turnId)
        void c.client.request("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => undefined);
    };
    // Before turn/start answers there is no turn id yet; the prompt sends the interrupt then.
    interrupt();
    turn.grace = setTimeout(() => {
      const err = new OrcaError(
        "AGENT_TRANSPORT",
        `agent '${agent.id}' did not end its turn within ${cancelGraceMs}ms of turn/interrupt (${reason}); killing it`,
        { reason, stderr: c.proc.stderrTail() },
      );
      // The caller settles now, whether turn/start has answered or not, and the process stops
      // without waiting on any reply from it.
      turn.fail(err);
      breakSession(err);
    }, cancelGraceMs);
  };

  const session: AgentSession = {
    id,
    agentId: agent.id,
    hostId: opts.host.id,
    cwd: opts.cwd,
    acpSessionId: threadId,
    closed,
    terminated,
    promptCapabilities: { embeddedContext: false },

    prompt: (input, options: PromptOptions = {}) =>
      redacted(async (): Promise<TurnResult> => {
        if (broken) throw broken;
        if (closing) throw new OrcaError("RUN_STATE", "the session is closed");
        if (active) throw new OrcaError("RUN_STATE", "a prompt turn is already active on this session");
        if (options.signal?.aborted) throw new OrcaError("CANCELLED", String(options.signal.reason ?? "cancelled"));
        const blocks: acp.ContentBlock[] = typeof input === "string" ? [{ type: "text", text: input }] : input;
        const other = blocks.find((b) => b.type !== "text");
        if (other)
          throw new OrcaError(
            "NOT_SUPPORTED",
            `agent ${agent.id}: the Codex app-server driver takes text prompts only, not ${other.type}`,
          );
        const started = clock.now();
        // Only limits Codex reports during this turn can name the window a failure ran into.
        const limitsAtStart = limitSeq;
        limitReports = [];
        let turn!: ActiveTurn;
        const ended = new Promise<unknown>((resolve, reject) => {
          turn = {
            done: resolve,
            fail: (error) => {
              turn.failed = true;
              reject(error);
            },
            finishedEarly: new Map(),
            streamed: new Set(),
          };
        });
        /** turn/start's outcome is unknown: Codex may be running the turn, so the session stops. */
        const unknownStart = (what: string) => {
          const error = new OrcaError(
            "AGENT_TRANSPORT",
            `agent ${agent.id}: turn/start got ${what}, so whether Codex is running the turn is unknown; ` +
              `ORCA stops the session and takes no further prompt on it`,
            { agentId: agent.id },
          );
          breakSession(error);
          return error;
        };
        ended.catch(() => undefined);
        active = turn;
        const onAbort = () => requestCancel(`aborted: ${String(options.signal?.reason ?? "cancelled")}`);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = options.timeoutMs
          ? setTimeout(() => requestCancel(`turn timed out after ${options.timeoutMs}ms`), options.timeoutMs)
          : undefined;
        try {
          // A pending account re-read holds the turn until it answers, under the prompt's cancel
          // and deadline: once either fires, no turn/start goes out.
          if (accountCheck) {
            const woken = new Promise<void>((r) => (turn.waking = r));
            for (let check = pendingAccountCheck(); check && !turn.cancelReason; check = pendingAccountCheck())
              await Promise.race([check, woken]);
            delete turn.waking;
            if (turn.cancelReason) return { stopReason: "cancelled", durationMs: clock.now() - started };
          }
          const brokenSince = isBroken();
          if (brokenSince) throw brokenSince;
          if (accountProblem) throw accountProblem;
          if (closing) throw new OrcaError("RUN_STATE", "the session is closed");
          // The last app-server exited: a new one on the same thread first.
          let c = conn;
          if (!c) {
            const r = restart(turn);
            restarting = r;
            try {
              c = await r;
            } catch (error) {
              // Cancelled while it restarted: no turn was started.
              if (error instanceof RestartCancelled)
                return { stopReason: "cancelled", durationMs: clock.now() - started };
              throw error;
            } finally {
              if (restarting === r) restarting = undefined;
            }
          }
          const start = c.client.request("turn/start", {
            threadId,
            clientUserMessageId: randomUUID(),
            input: blocks.map((b) => ({ type: "text", text: (b as { text: string }).text, text_elements: [] })),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          });
          start.catch(() => undefined);
          let answer: unknown;
          try {
            // Before turn/start answers, `ended` can only fail (the cancel grace, the connection
            // ending), and then the caller settles without waiting on the answer.
            answer = await Promise.race([start, ended]);
          } catch (error) {
            if (turn.failed) throw error;
            // Codex answered with an error: it did not start the turn, and the session goes on.
            if (error instanceof CodexRpcError)
              throw new OrcaError("AGENT_PROTOCOL", `agent ${agent.id}: Codex refused turn/start: ${error.message}`, {
                code: error.code,
              });
            // No usable answer (timeout, a malformed error): Codex may be running the turn, so the session ends.
            throw unknownStart(`no usable answer (${(error as Error).message})`);
          }
          const turnId =
            isObject(answer) && isObject(answer.turn) && typeof answer.turn.id === "string" && answer.turn.id
              ? answer.turn.id
              : undefined;
          if (!turnId) throw unknownStart("an answer without a turn id");
          turn.turnId = turnId;
          if (turn.finishedEarly.has(turnId)) {
            turn.done(turn.finishedEarly.get(turnId));
          } else if (turn.cancelReason) {
            void c.client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          }
          const finished = await ended;
          return {
            stopReason: codexStopReason(agent.id, finished, limitsSince(limitsAtStart)),
            durationMs: clock.now() - started,
          };
        } finally {
          if (timer) clearTimeout(timer);
          if (turn.grace) clearTimeout(turn.grace);
          options.signal?.removeEventListener("abort", onAbort);
          turn.finishedEarly.clear();
          active = undefined;
        }
      }),

    onUpdate(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    get configOptions() {
      return configOptions;
    },

    setConfigOption: (configId, value) =>
      redacted(async () => {
        const option = configOptions.find((o) => o.id === configId);
        if (!option || option.type !== "select" || typeof value !== "string")
          throw new OrcaError(
            "AGENT_PROTOCOL",
            `agent '${agent.id}' has no option ${configId} that takes ${String(value)}`,
            {
              configId,
              value,
            },
          );
        const offered = option.options.flatMap((o) => ("group" in o ? o.options : [o])).some((o) => o.value === value);
        if (!offered)
          throw new OrcaError("AGENT_PROTOCOL", `agent '${agent.id}' does not offer ${value} for ${configId}`, {
            configId,
            value,
          });
        if (configId === MODEL_OPTION) model = value;
        else effort = value;
        const c = conn;
        if (c) configOptions = await readConfigOptions(c.client, model, effort, logger);
        return configOptions;
      }),

    cancel: async () => requestCancel("cancel requested"),

    close: () => redacted(terminate),
  };
  return session;
}

const MODEL_OPTION = "model";
const EFFORT_OPTION = "reasoning_effort";

/**
 * The model and reasoning-effort options, from Codex's own model list. A list Codex cannot
 * give leaves only the current model, never a guess.
 */
async function readConfigOptions(
  client: CodexAppServerClient,
  model: string | undefined,
  effort: string | null,
  logger: Logger,
): Promise<SessionConfigOption[]> {
  let models: { model: string; displayName: string; description: string; hidden: boolean; efforts: string[] }[] = [];
  try {
    const answer = await client.request("model/list", {}, { timeoutMs: 10_000 });
    const data = isObject(answer) && Array.isArray(answer.data) ? answer.data : [];
    models = data.filter(isObject).flatMap((m) =>
      typeof m.model === "string"
        ? [
            {
              model: m.model,
              displayName: typeof m.displayName === "string" ? m.displayName : m.model,
              description: typeof m.description === "string" ? m.description : "",
              hidden: m.hidden === true,
              efforts: Array.isArray(m.supportedReasoningEfforts)
                ? m.supportedReasoningEfforts.flatMap((e) =>
                    isObject(e) && typeof e.reasoningEffort === "string" ? [e.reasoningEffort] : [],
                  )
                : [],
            },
          ]
        : [],
    );
  } catch (error) {
    logger.warn("Codex did not list its models", { error: (error as Error).message });
  }
  if (!model) return [];
  const visible = models.filter((m) => !m.hidden || m.model === model);
  if (!visible.some((m) => m.model === model))
    visible.unshift({ model, displayName: model, description: "", hidden: false, efforts: [] });
  const options: SessionConfigOption[] = [
    {
      type: "select",
      id: MODEL_OPTION,
      name: "Model",
      category: "model",
      currentValue: model,
      options: visible.map((m) => ({
        value: m.model,
        name: m.displayName,
        ...(m.description ? { description: m.description } : {}),
      })),
    },
  ];
  const efforts = visible.find((m) => m.model === model)?.efforts ?? [];
  if (efforts.length && effort)
    options.push({
      type: "select",
      id: EFFORT_OPTION,
      name: "Reasoning effort",
      category: "thought_level",
      currentValue: effort,
      options: efforts.map((e) => ({ value: e, name: e })),
    });
  return options;
}
