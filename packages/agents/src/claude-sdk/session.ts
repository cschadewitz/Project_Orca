/**
 * The Claude Agent SDK session driver (#1120, tracking #1153).
 *
 * One ORCA session is one streaming-input `query()` of the Claude Agent SDK, which runs the
 * person's own `claude` (already resolved and checked by `claudeSdkPreflight`, #1118) with
 * `--input-format stream-json`. ORCA owns that process: it is spawned here, in its own process
 * group, so closing the session ends Claude and everything it started.
 *
 * - **Turns.** `prompt` sends one user message and settles on the turn's `result` message.
 *   `cancel` (or the prompt's signal or timeout) asks the SDK to `interrupt()`; a turn that
 *   still has not ended `cancelGraceMs` later is failed and the process stopped.
 * - **Updates.** Assistant text and thinking blocks, tool uses, tool results and `TodoWrite`
 *   plans are mapped to the ACP session updates every other ORCA session reports.
 * - **Fixed setup.** No settings files (`settingSources: []`), no MCP servers, no session
 *   files, Claude Code's own system prompt, permission mode `default`.
 * - **Tools, until #1122.** ORCA does not answer Claude's permission asks yet: every ask is
 *   denied. A `PreToolUse` hook denies every tool call but `Read` of a file ORCA does not
 *   protect, and `TodoWrite`, before it runs, also the ones
 *   Claude's own rules would have allowed. What it lets through still meets Claude's own
 *   permission check, so a read outside the working directory is asked, and denied.
 *
 * Nothing Claude prints reaches an ORCA error: the CLI's output is untrusted, and its stderr is
 * not read at all.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  query,
  type CanUseTool,
  type HookCallback,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { newId, OrcaError, silentLogger, systemClock, type AgentSpec, type Clock, type Logger } from "@orca/core";
import { protectedPathFor, type ProtectedPaths } from "../permissions.js";
import {
  summarizeUpdate,
  withStartupTermination,
  type AgentSession,
  type PromptOptions,
  type SessionUpdateEvent,
  type TurnResult,
} from "../session.js";
import type { ClaudeSdkPreflight } from "./launch.js";

export interface ClaudeSdkSessionOptions {
  agent: Pick<AgentSpec, "id" | "cancelGraceMs">;
  hostId: string;
  cwd: string;
  /** What `claudeSdkPreflight` found: the executable to run and the environment to run it with. */
  preflight: Pick<ClaudeSdkPreflight, "executable" | "env">;
  /** Paths no tool call may read (`noAccess`) — the read-only tools are checked against them. */
  protectedPaths?: ProtectedPaths | undefined;
  /** Aborts the open while it is starting. */
  signal?: AbortSignal | undefined;
  logger?: Logger | undefined;
  clock?: Clock | undefined;
  /** How long `claude` has to answer the SDK's `initialize`. */
  startupTimeoutMs?: number | undefined;
  /** How long a turn has to end after an interrupt. Default: the agent's `cancelGraceMs`. */
  cancelGraceMs?: number | undefined;
  /** How long `claude` has to exit after its input ends before its process group is killed. */
  exitGraceMs?: number | undefined;
}

export const CLAUDE_SDK_STARTUP_TIMEOUT_MS = 30_000;
export const CLAUDE_SDK_EXIT_GRACE_MS = 5_000;
/** How long cleanup waits for the exit after the kill before it gives up observing it. */
const KILL_SETTLE_MS = 1_000;

/** The tools a session may use before ORCA answers permission asks (#1122). */
// Glob and Grep stay denied too: a recursive search can reach a protected path below its
// starting path, or through a link, and ORCA cannot show it would not (#1274 review).
const NO_FILE_TOOLS = new Set(["TodoWrite"]);
const DENIED = "ORCA does not run this tool for a Claude Agent SDK session yet (#1122): it was denied before it ran.";
const ASK_DENIED = "ORCA does not answer Claude's permission asks yet (#1122): this one was denied.";

interface ActiveTurn {
  started: number;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  cancelReason?: string;
  grace?: ReturnType<typeof setTimeout>;
}

/**
 * The refusal on Windows. A session owns Claude and everything it starts through a POSIX process
 * group; Windows has no tested equivalent yet (a job object), so nothing is launched there.
 */
export function claudeSdkPlatformUnsupported(agentId: string): OrcaError {
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agentId} has driver: claude-agent-sdk, which runs only on Linux and macOS for now: ` +
      `on Windows ORCA cannot yet stop everything Claude starts. Leave driver out to run Claude over ACP.`,
    { agentId, platform: process.platform },
  );
}

/** Open a session that runs Claude through the Claude Agent SDK. */
export async function openClaudeSdkSession(options: ClaudeSdkSessionOptions): Promise<AgentSession> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const { executable, env } = options.preflight;
  const cwd = options.cwd;
  const cancelGraceMs = options.cancelGraceMs ?? options.agent.cancelGraceMs;
  const exitGraceMs = options.exitGraceMs ?? CLAUDE_SDK_EXIT_GRACE_MS;

  if (process.platform === "win32") throw claudeSdkPlatformUnsupported(options.agent.id);
  if (options.signal?.aborted)
    throw new OrcaError("CANCELLED", `opening agent ${options.agent.id} was cancelled before it started`);

  // ---- the owned process ------------------------------------------------------------------
  let child: ChildProcess | undefined;
  let spawned = false;
  let exitObserved = false;
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((r) => (resolveExit = r));
  const markExited = () => {
    exitObserved = true;
    resolveExit();
  };
  const killGroup = (signal: NodeJS.Signals) => {
    const pid = child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: the group is already gone.
    }
  };
  const spawnClaude = (o: SpawnOptions): SpawnedProcess => {
    if (spawned)
      throw new OrcaError("AGENT_PROTOCOL", "the Claude Agent SDK asked to start a second claude for one session");
    if (o.command !== executable)
      throw new OrcaError(
        "AGENT_PROTOCOL",
        "the Claude Agent SDK asked to start a program other than the checked claude",
        {
          executable,
        },
      );
    spawned = true;
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(o.env)) if (v !== undefined) childEnv[k] = v;
    const proc = spawn(o.command, o.args, {
      cwd: o.cwd ?? cwd,
      env: childEnv,
      // stderr is not read: nothing the CLI prints is kept (see the module comment).
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
      windowsHide: true,
    });
    child = proc;
    proc.once("exit", markExited);
    proc.once("error", () => {
      // A spawn that failed has no process to wait for.
      if (proc.pid === undefined) markExited();
    });
    // The SDK's forwarded signal fires only after its own stdin-EOF grace: stop everything.
    o.signal.addEventListener("abort", () => killGroup("SIGKILL"), { once: true });
    return proc;
  };
  // Once the process is gone, anything it started in its group goes too.
  const terminated: Promise<void> = exited.then(() => killGroup("SIGKILL"));

  // ---- input, tool gate, the query ----------------------------------------------------------
  const input = new InputQueue();
  const abort = new AbortController();
  // Only ever a denial: an `allow` from a hook would skip Claude Code's own permission check, so a
  // tool call the gate lets through still meets Claude's rules and, for an ask, `canUseTool`.
  const preToolUse: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const reason = toolRefusal(hookInput.tool_name, hookInput.tool_input, cwd, options.protectedPaths);
    if (!reason) return {};
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    };
  };
  const canUseTool: CanUseTool = async () => ({ behavior: "deny", message: ASK_DENIED });
  const q: Query = query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: executable,
      env: { ...env },
      cwd,
      abortController: abort,
      permissionMode: "default",
      settingSources: [],
      persistSession: false,
      mcpServers: {},
      strictMcpConfig: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse], onFailure: "block" }] },
      spawnClaudeCodeProcess: spawnClaude,
    },
  });

  let terminating: Promise<void> | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  /** End the input, give claude `exitGraceMs` to exit, then kill its group. Settles either way. */
  const terminate = (): Promise<void> =>
    (terminating ??= (async () => {
      input.end();
      if (spawned && !(await within(exited, exitGraceMs))) {
        logger.warn("claude did not exit after its input ended; killing it", { agentId: options.agent.id });
        killGroup("SIGKILL");
        abort.abort();
        await within(exited, KILL_SETTLE_MS);
      }
      abort.abort();
      try {
        q.close();
      } catch {
        // already closed
      }
      resolveClosed();
    })());

  // ---- startup ---------------------------------------------------------------------------
  const startupTimeoutMs = options.startupTimeoutMs ?? CLAUDE_SDK_STARTUP_TIMEOUT_MS;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let onOpenAbort: (() => void) | undefined;
  try {
    // Each loser of the race below must not become an unhandled rejection later.
    const initialized = q.initializationResult();
    initialized.catch(() => undefined);
    const exitedFirst = exited.then(() => Promise.reject(startupFailure("exited before it answered")));
    exitedFirst.catch(() => undefined);
    await Promise.race([
      initialized,
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => reject(startupFailure("did not answer in time")), startupTimeoutMs);
        onOpenAbort = () => reject(new OrcaError("CANCELLED", `opening agent ${options.agent.id} was cancelled`));
        options.signal?.addEventListener("abort", onOpenAbort, { once: true });
      }),
      exitedFirst,
    ]);
  } catch (e) {
    const error = e instanceof OrcaError ? e : startupFailure("refused to start a session", { sdkError: errorName(e) });
    await terminate();
    throw withStartupTermination(error, spawned && !exitObserved ? terminated : Promise.resolve());
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
    if (onOpenAbort) options.signal?.removeEventListener("abort", onOpenAbort);
  }

  function startupFailure(what: string, details: Record<string, unknown> = {}): OrcaError {
    return new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${options.agent.id}: Claude Code (${executable}) ${what} when the Claude Agent SDK started it`,
      { agentId: options.agent.id, executable, ...details },
    );
  }

  // ---- the session -----------------------------------------------------------------------
  const id = newId("sess", clock.now());
  const acpSessionId = randomUUID();
  const listeners = new Set<(e: SessionUpdateEvent) => void>();
  const tools = new Map<string, string>();
  let activeTurn: ActiveTurn | undefined;
  let ended: Error | undefined;

  const emit = (raw: acp.SessionUpdate) => {
    const event: SessionUpdateEvent = { sessionId: id, raw, summary: summarizeUpdate(raw), at: clock.now() };
    for (const l of listeners) {
      try {
        l(event);
      } catch (e) {
        logger.warn("session update listener threw", { error: String(e) });
      }
    }
  };

  const settle = (turn: ActiveTurn, outcome: TurnResult | Error) => {
    if (activeTurn !== turn) return;
    activeTurn = undefined;
    if (turn.grace) clearTimeout(turn.grace);
    if (outcome instanceof Error) turn.reject(outcome);
    else turn.resolve(outcome);
  };

  const handle = (m: SDKMessage) => {
    for (const update of sessionUpdates(m, tools)) emit(update);
    if (m.type === "result" && activeTurn) {
      const turn = activeTurn;
      settle(turn, turnOutcome(m, turn, clock.now(), options.agent.id));
    }
  };

  void (async () => {
    let end: OrcaError;
    try {
      for await (const m of q) handle(m);
      end = new OrcaError("AGENT_TRANSPORT", `agent ${options.agent.id}: Claude Code ended the session`);
    } catch (e) {
      end = new OrcaError("AGENT_TRANSPORT", `agent ${options.agent.id}: the Claude Agent SDK session failed`, {
        sdkError: errorName(e),
      });
    }
    ended = end;
    if (activeTurn) settle(activeTurn, end);
    await terminate();
  })();

  const requestCancel = (reason: string) => {
    const turn = activeTurn;
    if (!turn || turn.cancelReason) return;
    turn.cancelReason = reason;
    logger.debug("interrupting claude turn", { reason, graceMs: cancelGraceMs });
    void q.interrupt().catch(() => undefined /* the process may already be gone */);
    turn.grace = setTimeout(() => {
      settle(
        turn,
        new OrcaError(
          "AGENT_TRANSPORT",
          `agent ${options.agent.id}: Claude Code did not end its turn within ${cancelGraceMs}ms of an interrupt (${reason}); stopping it`,
          { reason },
        ),
      );
      void terminate();
    }, cancelGraceMs);
  };

  return {
    id,
    agentId: options.agent.id,
    hostId: options.hostId,
    cwd,
    acpSessionId,
    closed,
    terminated,
    promptCapabilities: { embeddedContext: false },
    configOptions: [],

    async prompt(promptInput, promptOptions: PromptOptions = {}): Promise<TurnResult> {
      if (ended || terminating)
        throw new OrcaError("AGENT_TRANSPORT", `agent ${options.agent.id}: the session has ended`);
      if (activeTurn) throw new OrcaError("RUN_STATE", "a prompt turn is already active on this session");
      if (promptOptions.signal?.aborted)
        throw new OrcaError("CANCELLED", String(promptOptions.signal.reason ?? "cancelled"));
      const content = claudeContent(promptInput);
      let turn!: ActiveTurn;
      const done = new Promise<TurnResult>((resolve, reject) => {
        turn = { started: clock.now(), resolve, reject };
      });
      activeTurn = turn;
      const onAbort = () => requestCancel(`aborted: ${String(promptOptions.signal?.reason ?? "cancelled")}`);
      promptOptions.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = promptOptions.timeoutMs
        ? setTimeout(() => requestCancel(`turn timed out after ${promptOptions.timeoutMs}ms`), promptOptions.timeoutMs)
        : undefined;
      input.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: "",
      } as SDKUserMessage);
      try {
        return await done;
      } finally {
        if (timer) clearTimeout(timer);
        promptOptions.signal?.removeEventListener("abort", onAbort);
      }
    },

    onUpdate(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async setConfigOption(configId) {
      throw new OrcaError(
        "NOT_SUPPORTED",
        `agent ${options.agent.id}: a Claude Agent SDK session has no config options yet (model and effort follow in #1120)`,
        { configId },
      );
    },

    async cancel() {
      requestCancel("cancel requested");
    },

    close() {
      return terminate();
    },
  };
}

/** Resolves true when `p` settles within `ms`, false otherwise. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms))),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The error's class name only: an SDK message may quote what the CLI printed. */
function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/** Streaming input for `query()`: one user message per turn, ended when the session closes. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
  private done = false;

  push(m: SDKUserMessage): void {
    if (this.done) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: m, done: false });
    } else this.items.push(m);
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => (this.waiting = r));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

type ClaudeContentBlock =
  { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** An ORCA prompt as Claude message content: text, images, and text resources as text. */
export function claudeContent(input: string | acp.ContentBlock[]): ClaudeContentBlock[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  return input.map((b): ClaudeContentBlock => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text };
      case "image":
        if (!IMAGE_TYPES.has(b.mimeType))
          throw new OrcaError("NOT_SUPPORTED", `a Claude Agent SDK prompt cannot carry an image of type ${b.mimeType}`);
        return { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } };
      case "resource_link":
        return { type: "text", text: `[${b.name}](${b.uri})` };
      default:
        throw new OrcaError("NOT_SUPPORTED", `a Claude Agent SDK prompt cannot carry a ${b.type} block yet`);
    }
  });
}

/**
 * Why a tool call is refused before it runs, or undefined to let it run. Until ORCA's permission
 * answers reach this driver (#1122) only `TodoWrite` and a `Read` of one file ORCA does not
 * protect from reads run. Recursive searches (`Glob`, `Grep`) are denied: their starting path
 * says nothing about what the search visits below it.
 */
export function toolRefusal(
  tool: string,
  toolInput: unknown,
  cwd: string,
  protectedPaths: ProtectedPaths | undefined,
): string | undefined {
  if (NO_FILE_TOOLS.has(tool)) return undefined;
  if (tool !== "Read") return DENIED;
  const args = (typeof toolInput === "object" && toolInput !== null ? toolInput : {}) as Record<string, unknown>;
  const path = args.file_path;
  if (typeof path !== "string" || path.length === 0) return DENIED;
  if (protectedPathFor(path, "read", protectedPaths, cwd) !== undefined)
    return "ORCA protects this path from agents; it was not read.";
  return undefined;
}

const TOOL_KINDS: Record<string, acp.ToolKind> = {
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  Glob: "search",
  Grep: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  TodoWrite: "think",
};

/** The ACP session updates one SDK message stands for. `tools` remembers tool names by id. */
export function sessionUpdates(m: SDKMessage, tools: Map<string, string>): acp.SessionUpdate[] {
  const updates: acp.SessionUpdate[] = [];
  if (m.type === "assistant") {
    for (const block of m.message.content as unknown as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0)
        updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
      else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0)
        updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
      else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        tools.set(block.id, block.name);
        const rawInput = block.input as Record<string, unknown> | undefined;
        const path = typeof rawInput?.file_path === "string" ? rawInput.file_path : undefined;
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: block.id,
          title: block.name,
          kind: TOOL_KINDS[block.name] ?? "other",
          status: "pending",
          ...(rawInput ? { rawInput } : {}),
          ...(path ? { locations: [{ path }] } : {}),
        });
        const plan = block.name === "TodoWrite" ? planEntries(rawInput) : undefined;
        if (plan) updates.push({ sessionUpdate: "plan", entries: plan });
      }
    }
  } else if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const block of m.message.content as unknown as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      if (!tools.has(block.tool_use_id)) continue;
      const text = toolResultText(block.content);
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: block.tool_use_id,
        status: block.is_error === true ? "failed" : "completed",
        ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
      });
    }
  }
  return updates;
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text);
  return parts.length ? parts.join("\n") : undefined;
}

const PLAN_STATUS = new Set(["pending", "in_progress", "completed"]);

function planEntries(input: Record<string, unknown> | undefined): acp.PlanEntry[] | undefined {
  if (!Array.isArray(input?.todos)) return undefined;
  return (input.todos as Array<Record<string, unknown>>)
    .filter((t) => typeof t?.content === "string")
    .map((t) => ({
      content: t.content as string,
      priority: "medium",
      status: PLAN_STATUS.has(t.status as string) ? (t.status as acp.PlanEntryStatus) : "pending",
    }));
}

/** How a turn ended, from its `result` message: a stop reason, or an error with no CLI text. */
function turnOutcome(
  m: Extract<SDKMessage, { type: "result" }>,
  turn: ActiveTurn,
  now: number,
  agentId: string,
): TurnResult | Error {
  const durationMs = now - turn.started;
  if (turn.cancelReason) return { stopReason: "cancelled", durationMs };
  if (m.subtype === "success" && !m.is_error) {
    const stopReason: acp.StopReason =
      m.stop_reason === "max_tokens" ? "max_tokens" : m.stop_reason === "refusal" ? "refusal" : "end_turn";
    return { stopReason, durationMs };
  }
  if (m.subtype === "error_max_turns") return { stopReason: "max_turn_requests", durationMs };
  return new OrcaError("AGENT_PROTOCOL", `agent ${agentId}: Claude ended the turn with an error (${m.subtype})`, {
    agentId,
    subtype: m.subtype,
  });
}
