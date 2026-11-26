/**
 * The Codex app-server session driver (#1157): one `codex app-server` process and one Codex
 * thread, presented as an ORCA `AgentSession`, so nothing above `packages/agents` changes.
 *
 * **Not reachable from a run yet.** The session factory, the ACP launch and delegation still
 * refuse `driver: codex-app-server` (`codex-app-server.ts`) until ORCA's policy answers Codex's
 * asks (#1159) and the thread's configuration is verified (#1160). Until then this opens a
 * session only for a caller that names the thread's approval policy and sandbox itself.
 *
 * - **Open:** the user's Codex CLI started as `codex app-server` on ORCA's own host
 *   (`codexAppServerLaunch`, secrets delivered as for any agent), the pinned handshake, the
 *   login check (`account/read`), then `thread/start` with the given approval policy and
 *   sandbox and the reviewer `user`. The session is refused, and the process stopped, when the
 *   thread comes back with another reviewer, another approval policy or another working
 *   directory: ORCA never lets `auto_review` or `guardian_subagent` decide an ask.
 * - **Turns:** `turn/start` per prompt; the turn ends on Codex's `turn/completed` for that turn
 *   (`completed` → `end_turn`, `interrupted` → `cancelled`, `failed` → an error with Codex's
 *   message). Cancel, abort and timeout send `turn/interrupt`; a turn Codex does not end within
 *   the cancel grace kills the process, as on the ACP route.
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
import type { AgentHost } from "./host.js";
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
  checkSecretUse,
  ENV_SECRET_DELIVERY,
  planSessionSecrets,
  redactError,
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

/** The approval policy and sandbox a caller gives the thread. `never` and full access are not offered. */
export interface CodexThreadPolicy {
  approvalPolicy: "untrusted" | "on-request";
  sandbox: "read-only" | "workspace-write";
}

export interface OpenCodexAppServerSessionOptions {
  host: AgentHost;
  agent: AgentSpec;
  cwd: string;
  /** The thread's approval policy and sandbox. Required: there is no default until #1160. */
  thread: CodexThreadPolicy;
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
}

/** Methods every session of this driver calls; the handshake refuses a protocol without them. */
export const CODEX_SESSION_METHODS = [
  "account/read",
  "thread/start",
  "turn/start",
  "turn/interrupt",
  "thread/unsubscribe",
  "model/list",
] as const;

/** Asks that are approvals, declined until ORCA's policy answers them (#1159). */
const APPROVAL_ASKS: Readonly<Record<string, unknown>> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  execCommandApproval: { decision: "denied" },
  applyPatchApproval: { decision: "denied" },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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
export function codexStopReason(agentId: string, turn: unknown): acp.StopReason {
  const t = isObject(turn) ? turn : {};
  if (t.status === "completed") return "end_turn";
  if (t.status === "interrupted") return "cancelled";
  const error = isObject(t.error) && typeof t.error.message === "string" ? t.error.message : undefined;
  throw new OrcaError(
    "AGENT_PROTOCOL",
    t.status === "failed"
      ? `agent ${agentId}: Codex failed the turn${error ? `: ${error}` : ""}`
      : `agent ${agentId}: Codex ended the turn with status ${JSON.stringify(t.status)}`,
    { agentId, status: t.status ?? null },
  );
}

interface ActiveTurn {
  /** Codex's turn id, once `turn/start` answers. */
  turnId?: string;
  cancelReason?: string;
  grace?: ReturnType<typeof setTimeout>;
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

  const secretPlan = planSessionSecrets(opts.host, agent, opts.secrets);
  await checkSecretUse(secretPlan, opts.host, agent.id, opts.authorizeSecretUse);
  const values: string[] = [];
  const redacted = <T>(work: () => Promise<T>) =>
    work().catch((error: unknown) => {
      throw redactError(error, values);
    });

  const launch = await codexAppServerLaunch(agent, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } });
  const spec: AgentSpec = { ...secretPlan.agent, command: launch.command, args: launch.args };
  const proc = await opts.host.spawnAgent(spec, {
    cwd: opts.cwd,
    ...(opts.env ? { env: opts.env } : {}),
    ...ENV_SECRET_DELIVERY.spawnOptions(secretPlan),
  });
  values.push(...(proc.secretValues?.values() ?? []));
  const cleanup = processCleanup(proc);
  const stop = async (error: unknown): Promise<never> => {
    await cleanup().catch(() => undefined);
    const failure = redactError(error instanceof Error ? error : new Error(String(error)), values);
    throw withStartupTermination(failure, proc.exited);
  };
  if (!proc.stdio) return stop(new OrcaError("NOT_SUPPORTED", `host ${opts.host.id} cannot give an agent's raw stdio`));

  const logger = (opts.logger ?? silentLogger).child({ agent: agent.id, host: opts.host.id });
  const clock = opts.clock ?? systemClock;
  const listeners = new Set<(e: SessionUpdateEvent) => void>();
  const id = newId("sess", clock.now());
  let threadId = "";
  let active: ActiveTurn | undefined;
  /** Turns Codex finished before `turn/start` answered with their id. */
  const finishedEarly = new Map<string, unknown>();
  /** Agent message items that streamed deltas, so their completion does not repeat the text. */
  const streamed = new Set<string>();
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => (closedResolve = r));

  const emit = (update: acp.SessionUpdate) => {
    const e: SessionUpdateEvent = {
      sessionId: threadId,
      raw: update,
      summary: summarizeUpdate(update),
      at: clock.now(),
    };
    for (const l of listeners) l(e);
  };

  const onNotification = (method: string, params: unknown) => {
    if (!isObject(params)) return;
    if (threadId && typeof params.threadId === "string" && params.threadId !== threadId) return;
    switch (method) {
      case "item/agentMessage/delta":
        if (typeof params.itemId === "string") streamed.add(params.itemId);
        if (typeof params.delta === "string" && params.delta)
          emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.delta } });
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        if (typeof params.delta === "string" && params.delta)
          emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: params.delta } });
        return;
      case "item/started":
      case "item/completed": {
        if (!isObject(params.item) || typeof params.item.id !== "string" || typeof params.item.type !== "string")
          return;
        const item = params.item as ThreadItem;
        if (method === "item/completed" && item.type === "agentMessage" && !streamed.has(item.id) && item.text)
          emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } });
        const update = codexItemUpdate(item, method === "item/started" ? "started" : "completed");
        if (update) emit(update);
        return;
      }
      case "turn/plan/updated":
        if (Array.isArray(params.plan)) emit(codexPlanUpdate(params.plan as TurnPlanStep[]));
        return;
      case "thread/tokenUsage/updated":
        if (isObject(params.tokenUsage)) opts.onTokenUsage?.(params.tokenUsage as ThreadTokenUsage);
        return;
      case "turn/completed": {
        const turn = params.turn;
        const turnId = isObject(turn) && typeof turn.id === "string" ? turn.id : undefined;
        if (!turnId) return;
        if (active?.turnId === turnId) active.done(turn);
        else finishedEarly.set(turnId, turn);
        return;
      }
      default:
        return;
    }
  };

  const client = new CodexAppServerClient(stdioLineTransport(proc.stdio()), {
    requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
    onNotification,
    // Until ORCA's policy answers asks (#1159): approvals declined, anything else refused.
    onServerRequest: async (method) => {
      const answer = APPROVAL_ASKS[method];
      if (answer !== undefined) {
        logger.warn("Codex asked for approval; declined until ORCA's ask bridge (#1159)", { method });
        return answer;
      }
      throw new CodexRpcError(-32601, `ORCA does not answer ${method} yet`);
    },
    onClose: (error) => {
      active?.fail(error);
      closedResolve();
    },
  });

  let configOptions: SessionConfigOption[] = [];
  let model: string | undefined;
  let effort: string | null = null;
  try {
    await initializeCodexAppServer(client, {
      agentId: agent.id,
      orcaVersion: opts.orcaVersion ?? "0.0.0",
      requiredMethods: CODEX_SESSION_METHODS,
    });
    const login = codexLoginRefused(agent.id, await client.request("account/read", CODEX_ACCOUNT_READ_PARAMS));
    if (login) throw login;
    const params: ThreadStartParams = {
      cwd: opts.cwd,
      approvalPolicy: opts.thread.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: opts.thread.sandbox,
      ...(agent.defaultModel ? { model: agent.defaultModel } : {}),
    };
    const started = await client.request("thread/start", params);
    const t = isObject(started) ? started : {};
    const thread = isObject(t.thread) ? t.thread : {};
    if (typeof thread.id !== "string" || !thread.id)
      throw new OrcaError("AGENT_PROTOCOL", `agent ${agent.id}: thread/start answered without a thread id`);
    threadId = thread.id;
    const refuse = (what: string, got: unknown) =>
      new OrcaError(
        "NOT_SUPPORTED",
        `agent ${agent.id}: Codex started the thread with ${what} ${JSON.stringify(got)}, not what ORCA asked for. ORCA refuses the session.`,
        { agentId: agent.id, [what.replace(/ /g, "_")]: got ?? null },
      );
    if (t.approvalsReviewer !== "user") throw refuse("approvals reviewer", t.approvalsReviewer);
    if (t.approvalPolicy !== opts.thread.approvalPolicy) throw refuse("approval policy", t.approvalPolicy);
    if (typeof t.cwd !== "string" || !samePath(t.cwd, opts.cwd)) throw refuse("working directory", t.cwd);
    model = typeof t.model === "string" ? t.model : undefined;
    effort = typeof t.reasoningEffort === "string" ? t.reasoningEffort : null;
    configOptions = await readConfigOptions(client, model, effort, logger);
  } catch (error) {
    client.close("closed after a refused open");
    return stop(error);
  }

  const cancelGraceMs = opts.cancelGraceMs ?? agent.cancelGraceMs;
  let terminating: Promise<void> | undefined;
  const terminate = () =>
    (terminating ??= (async () => {
      if (!client.closed) {
        await client.request("thread/unsubscribe", { threadId }, { timeoutMs: 5_000 }).catch(() => undefined);
        client.close();
      }
      await cleanup();
      closedResolve();
    })());
  const terminated = (async () => {
    await proc.exited;
  })();

  const requestCancel = (reason: string) => {
    const turn = active;
    if (!turn || turn.cancelReason) return;
    turn.cancelReason = reason;
    const interrupt = () => {
      if (turn.turnId) void client.request("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => undefined);
    };
    // Before turn/start answers there is no turn id yet; the prompt sends the interrupt then.
    interrupt();
    turn.grace = setTimeout(() => {
      const err = new OrcaError(
        "AGENT_TRANSPORT",
        `agent '${agent.id}' did not end its turn within ${cancelGraceMs}ms of turn/interrupt (${reason}); killing it`,
        { reason, stderr: proc.stderrTail() },
      );
      turn.fail(err);
      void terminate();
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
        if (active) throw new OrcaError("RUN_STATE", "a prompt turn is already active on this session");
        if (options.signal?.aborted) throw new OrcaError("CANCELLED", String(options.signal.reason ?? "cancelled"));
        if (client.closed) throw client.closed;
        const blocks: acp.ContentBlock[] = typeof input === "string" ? [{ type: "text", text: input }] : input;
        const other = blocks.find((b) => b.type !== "text");
        if (other)
          throw new OrcaError(
            "NOT_SUPPORTED",
            `agent ${agent.id}: the Codex app-server driver takes text prompts only, not ${other.type}`,
          );
        const started = clock.now();
        let turn!: ActiveTurn;
        const ended = new Promise<unknown>((resolve, reject) => {
          turn = { done: resolve, fail: reject };
        });
        ended.catch(() => undefined);
        active = turn;
        const onAbort = () => requestCancel(`aborted: ${String(options.signal?.reason ?? "cancelled")}`);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = options.timeoutMs
          ? setTimeout(() => requestCancel(`turn timed out after ${options.timeoutMs}ms`), options.timeoutMs)
          : undefined;
        try {
          const answer = await client.request("turn/start", {
            threadId,
            clientUserMessageId: randomUUID(),
            input: blocks.map((b) => ({ type: "text", text: (b as { text: string }).text, text_elements: [] })),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          });
          const turnId =
            isObject(answer) && isObject(answer.turn) && typeof answer.turn.id === "string"
              ? answer.turn.id
              : undefined;
          if (!turnId)
            throw new OrcaError("AGENT_PROTOCOL", `agent ${agent.id}: turn/start answered without a turn id`);
          turn.turnId = turnId;
          if (finishedEarly.has(turnId)) {
            turn.done(finishedEarly.get(turnId));
            finishedEarly.delete(turnId);
          } else if (turn.cancelReason) {
            void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          }
          const finished = await ended;
          return { stopReason: codexStopReason(agent.id, finished), durationMs: clock.now() - started };
        } finally {
          if (timer) clearTimeout(timer);
          if (turn.grace) clearTimeout(turn.grace);
          options.signal?.removeEventListener("abort", onAbort);
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
        configOptions = await readConfigOptions(client, model, effort, logger);
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
