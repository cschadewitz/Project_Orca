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
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  newId,
  OrcaError,
  redactSecretValues,
  silentLogger,
  systemClock,
  type AgentSpec,
  type Clock,
  type JudgedDecision,
  type Logger,
  type SecretsConfig,
  type SessionConfigOption,
} from "@orca/core";
import type { AgentHost, AgentProcessHandle, ProcessExit } from "./host.js";
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
  CODEX_VERIFIED_IMAGES,
  codexImageTarget,
  codexVersionForImage,
  fileImageIdentity,
  ownChildImageDigest,
  type ImageIdentity,
} from "./codex-image.js";
import type { CodexAppServerHook } from "./native-tool-hook-session.js";
import type { FileUpdateChange } from "./codex-protocol/0.171.0/v2/FileUpdateChange.js";
import {
  codexAskRequest,
  codexAskResponse,
  isCodexPolicyAsk,
  codexEnvironmentForeign,
  codexEnvironmentProblem,
  type CodexAskOutcome,
  type CodexMcpCall,
  type CodexPolicyAsk,
} from "./codex-app-server-asks.js";
import {
  codexForeignMcpServer,
  codexForeignMcpServers,
  codexMcpServersConfig,
  codexMcpStartupProblem,
  type CodexMcpServerStatus,
} from "./codex-app-server-mcp.js";
import type { PermissionInvocation } from "./acp-session.js";
import { judgedLane } from "./judged-lane.js";
import {
  loadEffectivePermissionPolicy,
  resolvePermission,
  type PermissionRuleRecord,
  type ProtectedPaths,
} from "./permissions.js";
import type { JudgePermission } from "./review-judge/plain-rule.js";
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
  fillMcpSecrets,
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
  /**
   * Who answers an ask ORCA's policy puts to a person (#1159), as on the ACP route: the chosen
   * option (`accept` or `decline`), or undefined to decline. Omitted, such an ask is declined.
   */
  askPermission?: (
    req: acp.RequestPermissionRequest,
    invocation?: PermissionInvocation,
    judged?: JudgedDecision,
  ) => Promise<string | undefined>;
  /** Permission sidecars layered under the agent's configured rules, as on the ACP route. */
  permissionFiles?: readonly string[];
  /** ORCA's own files, which no ask Codex makes may reach whatever the policy says (C4-01). */
  policyProtectedPaths?: ProtectedPaths;
  /** The judge for plain-language rules: command advice only, as on the ACP route (#701). */
  judgePermission?: JudgePermission;
  judgeKinds?: { command?: JudgePermission | undefined };
  /** Each ask's decision, with what decided it (#702), as on the ACP route. */
  onPermission?: (info: { toolCallId?: string; title: string; decision: string; rule?: PermissionRuleRecord }) => void;
  /** Called with what ORCA verified of Codex's config, on open and after each restart. */
  onVerifiedConfig?: (config: CodexVerifiedConfig) => void;
  /**
   * Called with each startup report Codex sends for one of the agent's MCP servers (#1163), a
   * failed start included. Codex's reason is redacted of the session's secrets.
   */
  onMcpServerStatus?: (status: CodexMcpServerStatus) => void;
  /** Called with the account Codex runs on, at open and whenever Codex reports it changed (#1164). */
  onAccount?: (account: CodexAccountStatus) => void;
  /**
   * Called with Codex's usage limits whenever it reports them, merged with what was known
   * (#1164); `null` when what was reported no longer holds (the account is being read again, or a
   * new app-server took over). No limits are reported while the account is unconfirmed or refused.
   */
  onRateLimits?: (limits: CodexRateLimits | null) => void;
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
  /**
   * Handed every secret value each app-server was given, a restarted one included, before ORCA
   * sends it anything, so the caller can redact them from what the run records.
   */
  onSecretValues?: (values: readonly string[]) => void;
  /**
   * ORCA's pre-tool hook (#1161), from `NativeToolHookSession.codexAppServer()` after `prepare`:
   * installed through the session flags, required by the config check as the only hook, and
   * admitted (fail-closed line and probe) against each app-server ORCA starts before a thread
   * starts or resumes on it. The context file's environment must reach Codex through `env`.
   */
  nativeToolHook?: CodexAppServerHook;
  /** For tests: how the Codex executable is checked before ORCA starts it (#1162). */
  imageFile?: (path: string) => Promise<ImageIdentity | { error: string }>;
  /** For tests: how the image of the app-server ORCA started is attested (#1162). */
  imageDigest?: (pid: number | undefined) => Promise<ImageIdentity | { error: string }>;
  /** For tests: this machine's `<platform>-<arch>`, the key of the verified images. */
  imageTarget?: string;
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
  /** Codex reported a thread on this connection connected to an environment other than `local`. */
  foreignEnvironment?: boolean;
  /** The verified Codex version whose image ORCA attested for this process (#1162). */
  imageVersion?: string;
  /** The agent's MCP servers as this process's threads are given them, secrets filled (#1163). */
  mcpServers?: Record<string, Record<string, unknown>>;
  /** MCP servers ORCA did not configure that Codex reported starting on this connection (#1163). */
  foreignMcp?: string[];
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
  "mcpServerStatus/list",
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
  "thread/environment/connected",
  "mcpServer/startupStatus/updated",
]);

/** Codex's legacy (v1) approvals, which a v2 thread does not send: declined. */
const APPROVAL_ASKS: Readonly<Record<string, unknown>> = {
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
  /** Aborted when the turn is cancelled or ends: an ask still open then is no longer answered by anyone. */
  asks: AbortController;
  /** Resolved once turn/start answered with the turn's id, or the turn ended without one. */
  turnIdKnown: Promise<void>;
  knowTurnId: () => void;
  /** The file change items Codex started in this turn, by turn and item id: what its file change asks are about. */
  fileChanges: Map<string, FileUpdateChange[]>;
  /** The MCP tool calls Codex started in this turn and has not finished, by turn and item id (#1163). */
  mcpCalls: Map<string, CodexMcpCall>;
  /** Waiting on an account re-read, before any turn/start: a cancel ends the wait, nothing else. */
  waking?: () => void;
  grace?: ReturnType<typeof setTimeout>;
  /** The turn already failed (the cancel grace ran out, or the connection ended). */
  failed?: boolean;
  done: (turn: unknown) => void;
  fail: (error: Error) => void;
}

/** How long ORCA watches for Codex's own exit once its connection closed during the handshake. */
const STARTUP_EXIT_WAIT_MS = 1_000;

/** The process's exit if it is observed within `ms`, otherwise undefined. */
async function exitedWithin(exited: Promise<ProcessExit>, ms: number): Promise<ProcessExit | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.catch(() => undefined),
      new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Startup failures ORCA recognizes in Codex's stderr, each reported by a fixed reason and
 * diagnosis. Nothing captured (text, paths, values) is ever repeated.
 */
const CODEX_STARTUP_DIAGNOSES: readonly { pattern: RegExp; reason: string; diagnosis: string }[] = [
  {
    pattern: /approval_policy = "untrusted" is no longer supported/,
    reason: "untrusted-approval-policy",
    diagnosis: 'a Codex config sets approval_policy = "untrusted", which this Codex no longer supports',
  },
  {
    pattern: /CODEX_HOME points to .*, but that path (does not exist|is not a directory)/,
    reason: "codex-home-missing",
    diagnosis: "CODEX_HOME does not name an existing directory",
  },
];

/**
 * The failure for a Codex app-server that stopped answering before the handshake finished. It
 * carries no cause: the transport's close error can embed an underlying stream error's text.
 */
function codexStartupFailure(
  agentId: string,
  exit: ProcessExit | undefined,
  stopped: boolean,
  stderr: string,
): OrcaError {
  const known = CODEX_STARTUP_DIAGNOSES.find((d) => d.pattern.test(stderr));
  const how = !exit
    ? `closed its connection before ORCA's handshake finished, and ORCA ${stopped ? "stopped it" : "attempted to stop it but did not see it exit"}`
    : exit.code !== null
      ? `exited with code ${exit.code} before ORCA's handshake finished`
      : `was stopped by ${exit.signal ?? "a signal"} before ORCA's handshake finished`;
  const why = known
    ? `: ${known.diagnosis}`
    : ". ORCA does not recognize its reason and does not repeat Codex's output; run `codex app-server` as the account ORCA runs Codex as to see it";
  return new OrcaError("AGENT_TRANSPORT", `agent ${agentId}: the Codex app-server ${how}${why}`, {
    agentId,
    reason: known?.reason ?? "unrecognized",
    exited: exit !== undefined,
    ...(exit ? { exitCode: exit.code, signal: exit.signal } : { stopped }),
  });
}

/** ORCA refuses a Codex it cannot attest as a verified build for this machine (#1162). */
function codexImageRefusal(
  agentId: string,
  target: string,
  why: string,
  details: Record<string, unknown> = {},
): OrcaError {
  const verified = Object.keys(CODEX_VERIFIED_IMAGES).filter((v) => CODEX_VERIFIED_IMAGES[v]![target] !== undefined);
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agentId}: ${why}` +
      (verified.length ? `. ORCA verified Codex ${verified.join(", ")} for ${target}` : "") +
      `. ORCA does not start this session.`,
    { agentId, reason: "codex-image-unverified", platform: target, ...details },
  );
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
  // Codex 0.171.0 refuses approval_policy="untrusted" at startup, so on-request is the only
  // policy under which Codex asks before it acts outside its sandbox (#1269).
  if (
    !policy ||
    policy.approvalPolicy !== "on-request" ||
    !["read-only", "workspace-write"].includes(policy.sandbox as string)
  )
    throw new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agent.id}: a Codex app-server session needs the approval policy on-request (Codex no longer supports untrusted) and a sandbox (read-only or workspace-write)`,
      { agentId: agent.id },
    );
  if (opts.requireContextRecovery && !opts.resumeThreadId?.trim()) throw codexRecoveryFailure("missing-thread-id");
  // ORCA starts only a Codex build it verified for this machine (#1162): the file is checked
  // before it is started, and the process it started is then attested to run that same file.
  // A machine with no verified build is refused before anything starts.
  const imageTarget = opts.imageTarget ?? codexImageTarget();
  if (!Object.values(CODEX_VERIFIED_IMAGES).some((images) => images[imageTarget] !== undefined))
    throw codexImageRefusal(agent.id, imageTarget, `ORCA has no verified Codex build for ${imageTarget}`);

  const secretPlan = planSessionSecrets(opts.host, agent, opts.secrets);
  await checkSecretUse(secretPlan, opts.host, agent.id, opts.authorizeSecretUse);
  // The agent's MCP servers (#1163), checked before anything starts; each process's threads
  // get them with the secrets that process's host read.
  codexMcpServersConfig(agent.id, secretPlan.agent.mcpServers);
  const mcpNames: ReadonlySet<string> = new Set(agent.mcpServers.map((s) => s.name));
  const values: string[] = [];
  const redacted = <T>(work: () => Promise<T>) =>
    work().catch((error: unknown) => {
      throw redactError(error, values);
    });

  const launch = await codexAppServerLaunch(agent, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    sessionFlags: [...codexSessionFlags(opts.thread), ...(opts.nativeToolHook?.sessionFlags ?? [])],
  });
  // The file itself, not a link to it, is what is checked and then started: a link moved in
  // between cannot change what runs.
  let command: string;
  try {
    command = await realpath(launch.command);
  } catch (error) {
    throw codexImageRefusal(
      agent.id,
      imageTarget,
      `ORCA could not resolve the Codex at its command (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const spec: AgentSpec = { ...secretPlan.agent, command, args: launch.args };
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
    const published = limitBuckets.size > 0;
    limitBuckets.clear();
    limitReports = [];
    if (published) opts.onRateLimits?.(null);
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
    // While the account is being read again, or is refused, no one's usage is reported.
    if (pendingAccountCheck() || accountProblem) return;
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
    // What was reported of the usage limits, and any read begun before this, may describe an
    // account that is gone.
    forgetLimits();
    const check = (async () => {
      const then = sessionAccount.identity;
      const now = await rereadAccount(c);
      if (read !== accountReads || !then) return;
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
    const gen = accountGen;
    accountCheck = check.finally(() => {
      if (accountCheck === settled) accountCheck = undefined;
    });
    const settled = accountCheck;
    // Allowed again: its usage limits are read anew, bound to this check. Chained on it, so no
    // other update can come in between; and refused by readRateLimits once anything moved.
    void settled.then(() => readRateLimits(c, gen));
    return settled;
  };
  /**
   * Codex's usage limits, read once a ChatGPT login is in place (Codex answers no other login):
   * in the background, since the read goes to OpenAI, and only as diagnostics. Every bucket Codex
   * answers with is kept apart, and none overwrites an update Codex sent after the read began.
   */
  const readRateLimits = async (c: Connection, gen = accountGen) => {
    // Only for the live connection's confirmed, allowed account, as of `gen`.
    const current = () => conn === c && gen === accountGen && !pendingAccountCheck() && !accountProblem;
    if (!current() || c.account.status.kind !== "chatgpt") return;
    const read = { since: limitSeq, gen };
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
    // Begun before the account was read again or another app-server took over: dropped unread.
    if (!current()) return;
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

  /** ORCA's policy for this agent, read again for every ask, sidecars included. */
  const warnedSidecars = new Set<string>();
  const policyForAsk = () =>
    loadEffectivePermissionPolicy(
      agent,
      opts.permissionFiles ?? [],
      (file, e) => {
        if (warnedSidecars.has(file)) return;
        warnedSidecars.add(file);
        logger.warn("permission sidecar unreadable; asking instead of allowing anything it could have refused", {
          file,
          error: e instanceof Error ? e.message : String(e),
        });
      },
      (file, rule) => {
        const key = `${file}\0${JSON.stringify(rule)}`;
        if (warnedSidecars.has(key)) return;
        warnedSidecars.add(key);
        logger.warn("permission sidecar rule ignored: a wildcard allow belongs in the config, not the sidecar", {
          file,
          rule,
        });
      },
    );
  /** Rules ORCA writes are workspace-relative; ORCA's own files go ahead of every rule (C4-01). */
  const evalScope = {
    workspaceCwd: opts.cwd,
    ...(opts.policyProtectedPaths ? { protectedPaths: opts.policyProtectedPaths } : {}),
  };
  /** Command advice from a plain-language rule's judge, as on the ACP route (#702): it answers nothing. */
  const judged =
    opts.judgePermission && opts.judgeKinds?.command
      ? judgedLane({
          judge: opts.judgePermission,
          reload: policyForAsk,
          localHost: opts.host.spec.type === "local",
          command: opts.judgeKinds.command,
          redact: (text) => redactSecretValues(text, values),
          reads: false,
        })
      : undefined;
  /**
   * Codex's command, file change or permission ask on `c`, decided by ORCA's policy (#1159) and
   * answered once: `accept`, `decline` or `cancel`, never anything Codex would remember. Only an
   * ask about the live turn is decided; any other, and one after the turn is cancelled, is
   * declined. An ask still open when a person stops the turn is answered `cancel`.
   */
  const answerAsk = async (c: Connection, method: CodexPolicyAsk, params: unknown): Promise<unknown> => {
    const respond = (outcome: CodexAskOutcome, why: string, title = "") => {
      opts.onPermission?.({ title, decision: `codex:${outcome}:${why}` });
      logger.debug("Codex ask answered", { method, outcome, why });
      return codexAskResponse(method, outcome);
    };
    const turn = active;
    if (conn !== c || !turn || turn.cancelReason || turn.asks.signal.aborted || closing || isBroken())
      return respond("decline", "no-live-turn");
    // An ask can come before turn/start has answered with the turn's id.
    if (!turn.turnId) await turn.turnIdKnown;
    const live = () =>
      conn === c && active === turn && !turn.cancelReason && !turn.asks.signal.aborted && !closing && !isBroken();
    if (!live() || !turn.turnId) return respond("decline", "no-live-turn");
    // Only a change Codex started in this very turn is what the ask is about.
    const itemId = isObject(params) && typeof params.itemId === "string" ? params.itemId : undefined;
    const mapping = codexAskRequest(threadId, method, params, {
      changes: itemId ? turn.fileChanges.get(`${turn.turnId}\0${itemId}`) : undefined,
      mcpCalls: turn.mcpCalls.values(),
      mcpServers: mcpNames,
    });
    if (mapping.target && (mapping.target.threadId !== threadId || mapping.target.turnId !== turn.turnId))
      return respond("decline", "not-the-live-turn");
    if ("refused" in mapping) {
      logger.warn("Codex asked something ORCA declines without asking", { method, why: mapping.refused });
      return respond("decline", "refused");
    }
    // An MCP ask is bound to the one call it matched (#1163): no other ask is attributed to that
    // call, and the decision is given only while that very call still runs.
    const mcpKey = method === "mcpServer/elicitation/request" ? `${turn.turnId}\0${mapping.target.itemId}` : undefined;
    const mcpCall = mcpKey ? turn.mcpCalls.get(mcpKey) : undefined;
    if (mcpKey) {
      if (!mcpCall || mcpCall.asked) return respond("decline", "refused");
      mcpCall.asked = true;
    }
    const callLive = () => !mcpKey || turn.mcpCalls.get(mcpKey) === mcpCall;
    const { effects, review } = mapping;
    const title = review.toolCall.title ?? "";
    const invocation: PermissionInvocation = {
      sessionId: id,
      turnId: turn.turnId,
      invocationId: randomUUID(),
      signal: turn.asks.signal,
    };
    const askFailed = (error: unknown): never => {
      const failure =
        error instanceof Error ? error : new OrcaError("INTERNAL", "permission callback failed", {}, { cause: error });
      // A host that cannot hold or record the ask fails the turn, as on the ACP route.
      if (active === turn && !turn.asks.signal.aborted) {
        turn.fail(failure);
        requestCancel("permission callback failed");
      }
      throw failure;
    };
    /** The person, shown `review` (every effect): their option, or undefined once the turn moved on. */
    const askPerson = (said?: JudgedDecision): Promise<string | undefined> => {
      const signal = invocation.signal;
      if (signal.aborted) return Promise.resolve(undefined);
      return new Promise<string | undefined>((resolve, reject) => {
        const abort = () => resolve(undefined);
        signal.addEventListener("abort", abort, { once: true });
        (said ? opts.askPermission!(review, invocation, said) : opts.askPermission!(review, invocation)).then(
          (answer) => {
            signal.removeEventListener("abort", abort);
            resolve(signal.aborted ? undefined : answer);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", abort);
            reject(error instanceof Error ? error : new Error("permission callback failed", { cause: error }));
          },
        );
      }).catch(askFailed);
    };
    let accepted: boolean;
    try {
      const policy = await policyForAsk();
      if (effects.length === 1) {
        // One effect: decided as on the ACP route, the person shown it with Codex's context.
        const effect = effects[0]!;
        const { response, decision, rule } = await resolvePermission(policy, {
          request: effect,
          signal: invocation.signal,
          ...(opts.askPermission
            ? { ask: (_req: acp.RequestPermissionRequest, said?: JudgedDecision) => askPerson(said) }
            : {}),
          scope: evalScope,
          ...(judged ? { judged } : {}),
        });
        opts.onPermission?.({ toolCallId: effect.toolCall.toolCallId, title, decision, ...(rule ? { rule } : {}) });
        accepted = response.outcome.outcome === "selected" && response.outcome.optionId === "accept";
      } else {
        // Several effects, which Codex carries out as one: each is decided by the policy on its
        // own, any refused one declines them all, and a person is asked once, about all of them.
        let needsPerson = false;
        let refused = false;
        for (const effect of effects) {
          const { decision, rule } = await resolvePermission(policy, {
            request: effect,
            signal: invocation.signal,
            scope: evalScope,
          });
          opts.onPermission?.({
            toolCallId: effect.toolCall.toolCallId,
            title: effect.toolCall.title ?? "",
            decision,
            ...(rule ? { rule } : {}),
          });
          if (decision === "ask:no-answerer") needsPerson = true;
          else if (decision !== "allow") refused = true;
        }
        if (refused) accepted = false;
        else if (!needsPerson) accepted = true;
        else if (!opts.askPermission) {
          opts.onPermission?.({ toolCallId: review.toolCall.toolCallId, title, decision: "ask:no-answerer" });
          accepted = false;
        } else {
          const answer = await askPerson();
          opts.onPermission?.({
            toolCallId: review.toolCall.toolCallId,
            title,
            decision:
              answer === undefined ? "ask:cancelled" : `ask:${answer === "accept" ? "allow_once" : "reject_once"}`,
          });
          accepted = answer === "accept";
        }
      }
    } catch {
      return respond(turn.cancelReason ? "cancel" : "decline", "ask-failed", title);
    }
    // A person stopped the turn while it was asked: cancel. Otherwise only a live turn is allowed.
    if (turn.cancelReason) return respond("cancel", "turn-cancelled", title);
    if (!live()) return respond("decline", "turn-ended", title);
    if (!callLive()) return respond("decline", "call-ended", title);
    return codexAskResponse(method, accepted ? "accept" : "decline");
  };

  const onNotification = (method: string, params: unknown) => {
    if (!isObject(params)) {
      if (HANDLED_NOTIFICATIONS.has(method)) throw new PayloadProblem("params that are not an object");
      return;
    }
    if (threadId && typeof params.threadId === "string" && params.threadId !== threadId) return;
    switch (method) {
      // Fenced on the connection (see connect); here only its payload is checked.
      case "thread/environment/connected":
        check(codexEnvironmentProblem(params));
        return;
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
        // What a file change ask is about: Codex starts the item before it asks (#1159).
        // Keyed by its turn too: it can come before turn/start has answered with the turn's id.
        if (item.type === "fileChange" && active && typeof params.turnId === "string")
          active.fileChanges.set(`${params.turnId}\0${item.id}`, item.changes);
        // What an MCP ask is about (#1163): the call Codex started, until it finishes.
        if (item.type === "mcpToolCall" && active && typeof params.turnId === "string") {
          const key = `${params.turnId}\0${item.id}`;
          if (method === "item/started" && item.status === "inProgress")
            active.mcpCalls.set(key, {
              itemId: item.id,
              turnId: params.turnId,
              server: item.server,
              tool: item.tool,
              arguments: item.arguments,
            });
          else active.mcpCalls.delete(key);
        }
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
        if (active.turnId === turnId) {
          // Ended: no ask of it is answered from now on, before the prompt even settles.
          active.asks.abort();
          active.done(turn);
        }
        // Only while this session's turn/start is still unanswered: its turn may finish first,
        // and then none of its asks is answered either.
        else if (active.turnId === undefined) {
          active.finishedEarly.set(turnId, turn);
          active.asks.abort();
        }
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
    // The executable is checked before it is started, on every start: nothing it is not runs,
    // and no secret is read for it (the host reads them as it starts the process). A restart
    // onto another build ends the session (#1162).
    const file = await (opts.imageFile ?? fileImageIdentity)(spec.command);
    // A close or cancel during the check wins: nothing is started, and no secret resolved,
    // after it.
    const early = stopped();
    if (early) throw early;
    const fileVersion = "sha256" in file ? codexVersionForImage(file.sha256, imageTarget) : undefined;
    if (fileVersion === undefined) {
      const refusal = codexImageRefusal(
        agent.id,
        imageTarget,
        "sha256" in file
          ? "the Codex at its command is not a build ORCA verified. Set the agent's command to the native codex binary of a verified version (an npm install's codex command is a Node script, which then starts that binary)"
          : `ORCA could not check the Codex at its command before starting it: ${file.error}`,
        "sha256" in file ? { sha256: file.sha256 } : {},
      );
      if (replacement) breakSession(refusal);
      throw refusal;
    }
    const checked = file as ImageIdentity;
    const proc = await opts.host.spawnAgent(spec, {
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      ...ENV_SECRET_DELIVERY.spawnOptions(secretPlan),
    });
    values.push(...(proc.secretValues?.values() ?? []));
    const cleanup = processCleanup(proc, opts.exitGraceMs);
    const c = { proc, cleanup } as Connection;
    const mcpConfig = codexMcpServersConfig(
      agent.id,
      fillMcpSecrets(secretPlan, proc.secretValues ?? new Map<string, string>()),
    );
    if (mcpConfig) c.mcpServers = mcpConfig;
    owned.add(c);
    if (replacement) starting = c;
    const fail = async (reason: unknown): Promise<never> => {
      await cleanup().catch(() => undefined);
      // Built once the stop was attempted, from whether the process was then seen gone.
      const error =
        typeof reason === "function"
          ? (reason as (stopped: boolean) => unknown)((await exitedWithin(proc.exited, 0)) !== undefined)
          : reason;
      const failure = redactError(error instanceof Error ? error : new Error(String(error)), values);
      throw withStartupTermination(failure, proc.exited);
    };
    // Before the handshake, and once the process is owned: nothing it says reaches the run
    // before its values do. A run that cannot take them cannot redact this process's output,
    // so the open, or the whole session on a restart, stops; the callback's own error is not
    // repeated.
    if (proc.secretValues?.size && opts.onSecretValues)
      try {
        opts.onSecretValues([...values]);
      } catch {
        const refusal = new OrcaError(
          "AGENT_TRANSPORT",
          `agent ${agent.id}: ORCA could not register the Codex app-server's secret values for redaction, so it stops the app-server`,
          { agentId: agent.id, reason: "codex-secret-redaction" },
        );
        if (replacement) breakSession(refusal);
        return fail(refusal);
      }
    // Corroboration, before ORCA sends it anything: the process ORCA just started runs the
    // very file checked above (same inode, same digest), read from the kernel's view of the
    // child, never from a path or a version the process reports. Otherwise it is stopped before
    // any thread starts, and a restart ends the session (#1162).
    const image = await (opts.imageDigest ?? ownChildImageDigest)(proc.pid);
    const bound =
      "sha256" in image && image.sha256 === checked.sha256 && image.dev === checked.dev && image.ino === checked.ino;
    if (!bound) {
      // A process that exited before its image could be read gets the startup diagnosis it
      // would have had at the handshake (a restart counts it as a crash, as before): ORCA never
      // talks to it either way.
      const exit = "error" in image ? await exitedWithin(proc.exited, STARTUP_EXIT_WAIT_MS) : undefined;
      if (exit !== undefined)
        return fail((stopped: boolean) => codexStartupFailure(agent.id, exit, stopped, proc.stderrTail()));
      const refusal = codexImageRefusal(
        agent.id,
        imageTarget,
        "sha256" in image
          ? "the process ORCA started does not run the Codex file ORCA checked before starting it"
          : `ORCA could not attest the Codex it started: ${image.error}`,
        "sha256" in image ? { sha256: image.sha256 } : {},
      );
      if (replacement) breakSession(refusal);
      return fail(refusal);
    }
    const imageVersion = fileVersion;
    c.imageVersion = imageVersion;
    const why = stopped();
    if (why) return fail(why);
    if (!proc.stdio)
      return fail(new OrcaError("NOT_SUPPORTED", `host ${opts.host.id} cannot give an agent's raw stdio`));
    /** This connection's life: aborted when its client closes (a close, a cancel, an exit). */
    const lifetime = new AbortController();
    const client: CodexAppServerClient = new CodexAppServerClient(stdioLineTransport(proc.stdio()), {
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
      onNotification: (method, params) => {
        // Noted for a connection not yet live too: it is not published until it is re-read.
        if (method === "account/updated") c.accountUpdated = true;
        // ORCA's checks read this machine's filesystem: a thread Codex connects anywhere else
        // (or a connection report ORCA cannot read) fences this connection, whether it is live,
        // opening or a replacement being resumed (#1154).
        if (method === "thread/environment/connected" && codexEnvironmentForeign(params)) {
          c.foreignEnvironment = true;
          if (conn === c && open) {
            const error = foreignEnvironmentRefusal();
            active?.fail(error);
            breakSession(error);
          }
        }
        // An MCP server ORCA did not configure fences the connection the same way (#1163); a
        // report for one of ORCA's is the session's diagnostics.
        if (method === "mcpServer/startupStatus/updated" && isObject(params) && !codexMcpStartupProblem(params)) {
          const name = params.name as string;
          if (!mcpNames.has(name)) {
            c.foreignMcp = [...new Set([...(c.foreignMcp ?? []), name])];
            if (conn === c && open) {
              const error = codexForeignMcpServer(agent.id, c.foreignMcp);
              active?.fail(error);
              breakSession(error);
            }
            return;
          }
          const status: CodexMcpServerStatus = {
            server: name,
            status: params.status as CodexMcpServerStatus["status"],
            ...(typeof params.error === "string" ? { error: redactSecretValues(params.error, values) } : {}),
          };
          if (status.status === "failed") logger.warn("an MCP server failed to start", { ...status });
          else logger.debug("MCP server status", { ...status });
          opts.onMcpServerStatus?.(status);
        }
        if (conn !== c) return;
        try {
          onNotification(method, params);
        } catch (error) {
          if (!(error instanceof PayloadProblem)) throw error;
          client.closeOnProtocolError(`a ${method} notification with ${error.message}`);
        }
      },
      // Command, file change and permission asks go through ORCA's policy (#1159). The legacy
      // v1 approvals are declined; anything else is refused.
      onServerRequest: async (method, params) => {
        if (isCodexPolicyAsk(method)) return answerAsk(c, method, params);
        const answer = APPROVAL_ASKS[method];
        if (answer !== undefined) {
          logger.warn("Codex sent a legacy approval ask; ORCA declines it", { method });
          return answer;
        }
        throw new CodexRpcError(-32601, `ORCA does not answer ${method} yet`);
      },
      onClose: (error) => {
        // Whatever still runs for this connection (the hook's admission, #1161) stops with it.
        lifetime.abort(error);
        connectionClosed(c, error);
      },
    });
    c.client = client;
    try {
      const { version } = await initializeCodexAppServer(client, {
        agentId: agent.id,
        orcaVersion: opts.orcaVersion ?? "0.0.0",
        requiredMethods: CODEX_SESSION_METHODS,
      });
      if (version !== imageVersion)
        throw codexImageRefusal(
          agent.id,
          imageTarget,
          `the Codex it started reports version ${version}, but its image is the verified Codex ${imageVersion} build`,
          { version },
        );
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
      // ORCA's hook, when installed, is admitted against this very process before any thread
      // starts or resumes on it; a restart that cannot be admitted ends the session (#1161).
      // The admission is bound to this connection: a close, a cancel or the process ending
      // stops the probe, and the caller's own outcome (closed, cancelled) is reported as such,
      // not as a refusal of the hook.
      if (opts.nativeToolHook) {
        const before = stopped();
        if (before) throw before;
        if (lifetime.signal.aborted) throw client.closed ?? new OrcaError("AGENT_TRANSPORT", "the app-server closed");
        try {
          await opts.nativeToolHook.admit(proc.pid, lifetime.signal);
        } catch (error) {
          const why = stopped();
          if (why) throw why;
          if (lifetime.signal.aborted) throw client.closed ?? error;
          if (replacement && error instanceof OrcaError && error.code === "NOT_SUPPORTED") breakSession(error);
          throw error;
        }
        const late = stopped();
        if (late) throw late;
      }
      return c;
    } catch (error) {
      // Codex stopped answering before the handshake finished. Its stderr may hold the user's
      // own profile, paths or provider diagnostics, which ORCA does not know to redact, so the
      // failure names only a fixed diagnosis for output ORCA recognizes, and says whether the
      // process was seen to exit on its own before ORCA stopped it.
      if (client.closed !== undefined && error instanceof OrcaError && error.code === "AGENT_TRANSPORT") {
        const exit = await exitedWithin(proc.exited, STARTUP_EXIT_WAIT_MS);
        client.close("closed after a refused open");
        return fail((stopped: boolean) => codexStartupFailure(agent.id, exit, stopped, proc.stderrTail()));
      }
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
  function foreignEnvironmentRefusal() {
    return new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agent.id}: Codex connected a thread to an environment other than this machine, whose filesystem ORCA's checks do not read; ORCA stops the session`,
      { agentId: agent.id, reason: "codex-foreign-environment" },
    );
  }
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
    let verified: CodexVerifiedConfig;
    try {
      verified = codexConfigCheck(
        agent.id,
        opts.thread,
        { config, requirements, hooks },
        opts.nativeToolHook?.command,
        [...mcpNames],
      );
    } catch (error) {
      throw configRefusal(error as OrcaError);
    }
    // On the thread: the MCP servers Codex runs for it are ORCA's only (#1163). One still
    // starting is not listed yet; its startup report is checked as it comes.
    if (thread) {
      const foreign: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; ; page++) {
        const answer: unknown = await c.client.request("mcpServerStatus/list", {
          threadId: thread,
          ...(cursor ? { cursor } : {}),
        });
        foreign.push(...codexForeignMcpServers(agent.id, answer, mcpNames));
        const next = (answer as { nextCursor?: unknown }).nextCursor;
        if (next === null || next === undefined) break;
        if (typeof next !== "string" || page >= 20)
          throw new OrcaError("AGENT_PROTOCOL", `agent ${agent.id}: mcpServerStatus/list did not end`, {
            agentId: agent.id,
          });
        cursor = next;
      }
      if (foreign.length) throw codexForeignMcpServer(agent.id, [...new Set(foreign)]);
    }
    if (c.foreignMcp) throw codexForeignMcpServer(agent.id, c.foreignMcp);
    return verified;
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
        // Servers run per thread: a resumed thread is given ORCA's again (#1163).
        ...(c.mcpServers ? { config: { mcp_servers: c.mcpServers } } : {}),
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
  /**
   * Stop the opening app-server and fail the open: the failure carries the process's exit, so a
   * caller can wait for it when the stop could not be confirmed.
   */
  const refuseOpen = async (error: unknown): Promise<never> => {
    const c = conn!;
    closing = true;
    c.client.close("closed after a refused open");
    await c.cleanup().catch(() => undefined);
    throw withStartupTermination(
      redactError(error instanceof Error ? error : new Error(String(error)), values),
      c.proc.exited,
    );
  };
  let verified: CodexVerifiedConfig;
  try {
    await verifyConfig(conn);
    let opened: ReturnType<typeof acceptThread> | undefined;
    if (opts.resumeThreadId) {
      // The environment fence, synchronously before the thread is resumed (and below, before
      // it is started, and before the session is published).
      if (conn.foreignEnvironment) throw foreignEnvironmentRefusal();
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
        // ORCA's MCP servers, in the request and never on the command line: their environment
        // can carry secrets (#1163).
        ...(conn.mcpServers
          ? { config: { mcp_servers: conn.mcpServers } as NonNullable<ThreadStartParams["config"]> }
          : {}),
      };
      if (conn.foreignEnvironment) throw foreignEnvironmentRefusal();
      opened = acceptThread("thread/start", await conn.client.request("thread/start", params));
      threadId = opened.id;
    }
    verified = await verifyConfig(conn, threadId);
    model = opened.model;
    effort = opened.effort;
    configOptions = await readConfigOptions(conn.client, model, effort, logger);
  } catch (error) {
    return refuseOpen(error);
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
    if (refusal) return refuseOpen(refusal);
  }
  // From here to the session's publication nothing is awaited: this is the last fence for an
  // environment connection Codex reported during the open, the account re-reads included.
  if (conn.foreignEnvironment) return refuseOpen(foreignEnvironmentRefusal());
  if (conn.foreignMcp) return refuseOpen(codexForeignMcpServer(agent.id, conn.foreignMcp));
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
      // The synchronous `accountUpdated` test right before thread/resume is sent (and below, right
      // before the replacement is published) fences any update Codex sent during the awaits.
      await checkAccount(c);
      while (c.accountUpdated) await checkAccount(c);
      // And the same synchronous fence for an environment connection, before the resume and
      // right before the replacement is published.
      if (c.foreignEnvironment) refused(configRefusal(foreignEnvironmentRefusal()));
      const resumed = await resumeOn(c, threadId).catch(refused);
      const reverified = await verifyConfig(c, threadId).catch(refused);
      await checkAccount(c);
      while (c.accountUpdated) await checkAccount(c);
      if (c.foreignEnvironment) refused(configRefusal(foreignEnvironmentRefusal()));
      if (c.foreignMcp) refused(codexForeignMcpServer(agent.id, c.foreignMcp));
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
    // An ask a person is answering is answered `cancel` now (#1159).
    turn.asks.abort();
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
        let knowTurnId!: () => void;
        const turnIdKnown = new Promise<void>((r) => (knowTurnId = r));
        const ended = new Promise<unknown>((resolve, reject) => {
          turn = {
            done: resolve,
            fail: (error) => {
              turn.failed = true;
              reject(error);
            },
            finishedEarly: new Map(),
            streamed: new Set(),
            asks: new AbortController(),
            turnIdKnown,
            knowTurnId,
            fileChanges: new Map(),
            mcpCalls: new Map(),
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
          // The account gate, passed with no await between it and turn/start going out: a pending
          // account re-read holds the turn until it answers, under the prompt's cancel and
          // deadline (once either fires, no turn/start goes out). After a restart the gate runs
          // again, since the replacement's handoff to this prompt is itself an await.
          let c: Connection;
          for (;;) {
            for (let check = pendingAccountCheck(); check && !turn.cancelReason; check = pendingAccountCheck()) {
              const woken = new Promise<void>((r) => (turn.waking = r));
              await Promise.race([check, woken]);
              delete turn.waking;
            }
            if (turn.cancelReason) return { stopReason: "cancelled", durationMs: clock.now() - started };
            const brokenSince = isBroken();
            if (brokenSince) throw brokenSince;
            if (accountProblem) throw accountProblem;
            if (closing) throw new OrcaError("RUN_STATE", "the session is closed");
            const live = conn;
            if (live) {
              c = live;
              break;
            }
            // The last app-server exited: a new one on the same thread first.
            const r = restart(turn);
            restarting = r;
            try {
              await r;
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
          turn.knowTurnId();
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
          turn.asks.abort();
          turn.knowTurnId();
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
