/**
 * ORCA's permission policy on a Claude Agent SDK session (#1122): every tool call Claude makes
 * is decided by the same rules, people and answerer as on the ACP route, and nothing Claude is
 * told lets it remember a grant.
 *
 * Two places in the SDK see a call, and both use them:
 *
 * - **The `PreToolUse` hook**, for every call, ahead of Claude's own rules. It never answers
 *   `allow`, which would skip Claude's permission check. A call ORCA's policy denies is denied
 *   there, before it runs. A call the policy would ask about is sent to Claude's ask
 *   (`permissionDecision: "ask"`), so that a call Claude would let through by itself (a read
 *   in its working directory) still reaches ORCA. A call the policy allows is left to Claude.
 * - **`canUseTool`**, for every ask Claude makes. The call is decided again, now, by the policy
 *   as it is now (`resolvePermission`): a typed rule, or the run's answerer (a person, or the
 *   upstream client). An allow is `{ behavior: "allow" }` for this call only, never with
 *   `updatedPermissions`, so the next identical call asks again. ORCA's own "always" answers go
 *   to ORCA's sidecar as on every route. A deny carries why to the model.
 *
 * Recursive searches (`Glob`, `Grep`) stay denied: their starting path says nothing about what
 * the search visits below it (#1274 review). An ask that arrives outside a live turn, or after
 * the turn was cancelled, is denied and the tool does not run.
 *
 * Every call is described to the policy by `claudeToolPolicyCall`, which titles it the way
 * Claude's ACP adapter does and keeps any call it cannot describe exactly strict (#1119).
 */
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { CanUseTool, HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { ConfiguredPermissionPolicy, JudgedDecision, Logger, PermissionPolicy } from "@orca/core";
import type { PermissionInvocation } from "../acp-session.js";
import type { McpRelayCall, McpRelayContext, McpRelayDispatch } from "../mcp-relay.js";
import { claudeToolPolicyCall } from "../claude-pre-tool-hook.js";
import {
  explainPermission,
  loadEffectivePermissionPolicy,
  resolvePermission,
  type PermissionEvalContext,
  type PermissionRuleRecord,
  type ProtectedPaths,
} from "../permissions.js";
import type { PolicyCall } from "../policy-call.js";
import { claudeLabel } from "./config-options.js";

/** Searches that stay denied: what they visit is not what their path names. */
export const CLAUDE_SDK_SEARCH_TOOLS: ReadonlySet<string> = new Set(["Glob", "Grep"]);
/** Tools that touch nothing outside Claude's own session state. */
const STATE_ONLY_TOOLS: ReadonlySet<string> = new Set(["TodoWrite"]);

/** What Claude (and so the model) is told. Fixed text: nothing a person or the CLI wrote. */
export const CLAUDE_SDK_DENIALS = {
  search:
    "ORCA does not run recursive searches (Glob, Grep) for a Claude Agent SDK session: what they visit cannot be checked. Read the files instead.",
  protected: "ORCA keeps this path from agents; the tool call was denied before it ran.",
  policy: "ORCA's permission policy denies this tool call.",
  declined: "The person declined this tool call.",
  noAnswerer: "ORCA's permission policy asks a person about this tool call, and nobody can answer in this run.",
  noTurn: "ORCA answers tool permission asks only during a live turn; this one was denied.",
  cancelled: "The turn was cancelled; the tool call was denied.",
  changed: "ORCA's permission policy denies this tool call now.",
  askedSince:
    "ORCA's permission policy now asks a person about this tool call, and nobody has answered it; it was denied.",
  failed: "ORCA could not decide this tool call; it was denied.",
} as const;

/** The turn an ask belongs to, while it is live (not ended, not cancelled). */
export interface ClaudeSdkLiveTurn {
  readonly id: string;
  readonly signal: AbortSignal;
}

export interface ClaudeSdkPermissionBridgeOptions {
  /** The agent and its configured rules; none configured is the defaults alone. */
  agent: { id: string; permissions?: ConfiguredPermissionPolicy | undefined };
  /** ORCA's session id, which a person's ask is filed under. */
  sessionId: string;
  cwd: string;
  protectedPaths?: ProtectedPaths | undefined;
  /** Permission sidecars layered under the agent's configured rules, read again on every call. */
  permissionFiles?: readonly string[] | undefined;
  /** The run's answerer for a call the policy asks about; absent, such a call is denied. */
  askPermission?:
    | ((
        req: acp.RequestPermissionRequest,
        invocation?: PermissionInvocation,
        judged?: JudgedDecision,
      ) => Promise<string | undefined>)
    | undefined;
  /** Each decision, for the run log. */
  onPermission?:
    ((info: { toolCallId?: string; title: string; decision: string; rule?: PermissionRuleRecord }) => void) | undefined;
  /** The live turn now, or undefined between turns and once a turn is cancelled. */
  liveTurn: () => ClaudeSdkLiveTurn | undefined;
  /** The tool call that started the subagent making this call, when one did. */
  parentOf: (toolUseId: string) => string | undefined;
  /** An answerer that failed: the turn is failed with it, as on the ACP route. */
  onAskFailed?: ((turnId: string, error: unknown) => void) | undefined;
  /**
   * How long reading and evaluating the policy may take before the call is denied: well inside
   * the SDK's own callback timeout, so ORCA's denial is the answer Claude gets. A person's
   * answer is not bounded by it.
   */
  decisionTimeoutMs?: number | undefined;
  /** Reads the effective policy; the agent's rules over `permissionFiles` when left out (tests replace it). */
  loadPolicy?: (() => Promise<PermissionPolicy>) | undefined;
  /** Aborts when the session ends: no MCP request is served after it (#1125). */
  sessionSignal?: AbortSignal | undefined;
  logger: Logger;
}

/** What Claude's ask decided for one MCP tool use, so the relayed call is not asked twice (#1125). */
interface McpGrant {
  turnId: string;
  server: string;
  tool: string;
  arguments: string;
  grantedBy: "allow" | "ask:allow_once";
}

/** The SDK's `canUseTool` context, as far as the ask card shows it. */
type AskContext = Parameters<CanUseTool>[2];

const MAX_CONTEXT = 300;

export function claudeSdkPermissionBridge(o: ClaudeSdkPermissionBridgeOptions): {
  preToolUse: HookCallback;
  canUseTool: CanUseTool;
  /** The relay's `authorize` for the session's ORCA-run MCP servers (#1125). */
  authorizeMcp: (call: McpRelayCall, request: AbortSignal, context?: McpRelayContext) => Promise<McpRelayDispatch>;
} {
  /** Claude's tool uses of ORCA-run MCP tools that ORCA allowed, by tool use id; each is used once. */
  const mcpGrants = new Map<string, McpGrant>();
  const scope: PermissionEvalContext = {
    workspaceCwd: o.cwd,
    ...(o.protectedPaths ? { protectedPaths: o.protectedPaths } : {}),
  };
  const agent = { id: o.agent.id, permissions: o.agent.permissions ?? { rules: [] } };
  const warned = new Set<string>();
  const decisionTimeoutMs = o.decisionTimeoutMs ?? CLAUDE_SDK_DECISION_TIMEOUT_MS;
  // A policy that cannot be read in time decides nothing: the caller denies (#1306 review).
  const policy = () =>
    bounded(
      o.loadPolicy?.() ??
        loadEffectivePermissionPolicy(agent, o.permissionFiles ?? [], (file) => {
          if (warned.has(file)) return;
          warned.add(file);
          o.logger.warn("permission sidecar unreadable; asking instead of allowing anything it could have refused", {
            file,
          });
        }),
      decisionTimeoutMs,
    );
  const record = (call: PolicyCall, toolUseId: string | undefined, decision: string, rule?: PermissionRuleRecord) =>
    o.onPermission?.({
      ...(toolUseId ? { toolCallId: toolUseId } : {}),
      title: call.title,
      decision,
      ...(rule ? { rule } : {}),
    });
  const describe = (toolName: string, toolInput: unknown, extra: Partial<PolicyCall> = {}): PolicyCall => ({
    ...claudeToolPolicyCall({ toolName, toolInput: asInput(toolInput), cwd: o.cwd }),
    ...extra,
  });

  const deny = (reason: string): HookJSONOutput => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });

  // Every failure on the way to a verdict is an explicit deny: a rejected callback is not one
  // (#1306 review), and nothing here relies on how the SDK treats it.
  const preToolUse: HookCallback = async (hookInput, toolUseId, options) => {
    try {
      return await gate(hookInput, toolUseId, options);
    } catch (error) {
      o.logger.warn("ORCA could not decide a Claude tool call; denying it", { error: errorName(error) });
      return deny(CLAUDE_SDK_DENIALS.failed);
    }
  };

  const gate: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const toolName = hookInput.tool_name;
    if (STATE_ONLY_TOOLS.has(toolName)) return {};
    const call = describe(toolName, hookInput.tool_input);
    const toolUseId = hookInput.tool_use_id;
    if (CLAUDE_SDK_SEARCH_TOOLS.has(toolName)) {
      record(call, toolUseId, "gate:deny:search");
      return deny(CLAUDE_SDK_DENIALS.search);
    }
    const turn = o.liveTurn();
    if (!turn) {
      record(call, toolUseId, "gate:no-turn");
      return deny(CLAUDE_SDK_DENIALS.noTurn);
    }
    const explained = explainPermission(await policy(), call, scope);
    if (o.liveTurn()?.id !== turn.id) {
      record(call, toolUseId, "gate:turn-ended");
      return deny(CLAUDE_SDK_DENIALS.noTurn);
    }
    if (explained.decision === "deny") {
      const isProtected = explained.basis === "protected";
      record(call, toolUseId, isProtected ? "gate:deny:protected" : "gate:deny", ruleOf(explained));
      return deny(isProtected ? CLAUDE_SDK_DENIALS.protected : CLAUDE_SDK_DENIALS.policy);
    }
    // To Claude's ask, so `canUseTool` decides it: a call Claude would let through by itself
    // still reaches ORCA's answerer.
    if (explained.decision === "ask")
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "ORCA's permission policy asks about this tool call.",
        },
      };
    // Allowed by ORCA: Claude's own check still runs, and any ask it makes comes to `canUseTool`.
    return {};
  };

  const canUseTool: CanUseTool = async (toolName, toolInput, ctx) => {
    try {
      return await answer(toolName, toolInput, ctx);
    } catch (error) {
      o.logger.warn("ORCA could not answer a Claude permission ask; denying it", { error: errorName(error) });
      return { behavior: "deny", message: CLAUDE_SDK_DENIALS.failed, toolUseID: ctx.toolUseID };
    }
  };

  const answer: CanUseTool = async (toolName, toolInput, ctx) => {
    const toolUseId = ctx.toolUseID;
    const parent = o.parentOf(toolUseId);
    const reason = claudeLabel(ctx.decisionReason, MAX_CONTEXT);
    const call = describe(toolName, toolInput, {
      ...(parent ? { caller: { parentToolCallId: parent } } : {}),
      ...(reason ? { reason } : {}),
    });
    const refuse = (decision: string, message: string, interrupt = false, rule?: PermissionRuleRecord) => {
      record(call, toolUseId, decision, rule);
      return { behavior: "deny" as const, message, ...(interrupt ? { interrupt: true } : {}), toolUseID: toolUseId };
    };
    if (CLAUDE_SDK_SEARCH_TOOLS.has(toolName)) return refuse("ask:deny:search", CLAUDE_SDK_DENIALS.search);
    const turn = o.liveTurn();
    if (!turn || ctx.signal.aborted) return refuse("ask:no-turn", CLAUDE_SDK_DENIALS.noTurn);
    const invocation: PermissionInvocation = {
      sessionId: o.sessionId,
      turnId: turn.id,
      invocationId: randomUUID(),
      signal: AbortSignal.any([turn.signal, ctx.signal]),
    };
    const live = () => o.liveTurn()?.id === turn.id && !invocation.signal.aborted;
    let resolved: Awaited<ReturnType<typeof resolvePermission>>;
    try {
      resolved = await resolvePermission(await policy(), {
        request: askRequest(o.sessionId, toolUseId, call, toolInput, ctx),
        call,
        signal: invocation.signal,
        scope,
        ...(o.askPermission
          ? {
              ask: async (request: acp.RequestPermissionRequest, judged?: JudgedDecision) => {
                try {
                  return await (judged
                    ? o.askPermission!(request, invocation, judged)
                    : o.askPermission!(request, invocation));
                } catch (error) {
                  // A retired ask has nothing left to fail; a live one fails its turn.
                  if (live()) o.onAskFailed?.(turn.id, error);
                  throw error;
                }
              },
            }
          : {}),
      });
    } catch {
      return refuse("ask:failed", CLAUDE_SDK_DENIALS.failed, !live());
    }
    const { decision, rule } = resolved;
    // The person stopped the turn while it was asked: Claude stops too.
    if (!live())
      return refuse(
        decision === "ask:expired" ? decision : `${decision}:turn-ended`,
        CLAUDE_SDK_DENIALS.cancelled,
        true,
        rule,
      );
    if (decision === "allow" || decision === "ask:allow_once") {
      // The policy may have changed meanwhile. A deny always wins. An automatic allow stands only
      // while the policy still allows: if it now asks, nobody answered this call, so it is refused.
      // A person's one-time allow stands while the policy still asks (or allows).
      const now = explainPermission(await policy(), call, scope);
      if (now.decision === "deny") return refuse(`${decision}:denied-since`, CLAUDE_SDK_DENIALS.changed, false, rule);
      if (decision === "allow" && now.decision !== "allow")
        return refuse("allow:ask-since", CLAUDE_SDK_DENIALS.askedSince, false, rule);
      if (!live()) return refuse(`${decision}:turn-ended`, CLAUDE_SDK_DENIALS.cancelled, true, rule);
      record(call, toolUseId, decision, rule);
      const mcp = mcpToolName(toolName);
      // An answer from an earlier turn can no longer be used: dropped, so the map stays small.
      for (const [id, g] of mcpGrants) if (g.turnId !== turn.id) mcpGrants.delete(id);
      if (mcp)
        mcpGrants.set(toolUseId, {
          turnId: turn.id,
          ...mcp,
          arguments: JSON.stringify(toolInput ?? null),
          grantedBy: decision,
        });
      // This call only. No `updatedPermissions`: Claude remembers nothing, and asks again.
      return { behavior: "allow", updatedInput: asInput(toolInput), toolUseID: toolUseId };
    }
    const message =
      decision === "deny:protected"
        ? CLAUDE_SDK_DENIALS.protected
        : decision === "deny"
          ? CLAUDE_SDK_DENIALS.policy
          : decision === "ask:no-answerer"
            ? CLAUDE_SDK_DENIALS.noAnswerer
            : decision.startsWith("ask:reject")
              ? CLAUDE_SDK_DENIALS.declined
              : CLAUDE_SDK_DENIALS.failed;
    return refuse(decision, message, false, rule);
  };

  /**
   * A request to one of the session's ORCA-run MCP servers (#1125), as the relay checks it at
   * dispatch, with the ACP route's rules: a listing needs a live session; a tool call needs the
   * live turn and ORCA's policy for `"<server>: <tool>"`, read now and again at the handoff.
   *
   * Claude asks ORCA about the tool use first (the hook, then `canUseTool`), so the relay asks
   * nobody: a call Claude's ask allowed for this tool use, in this turn, with these arguments,
   * stands as that answer did (a deny since wins; an automatic allow needs the policy still to
   * allow). Any other call is served only while the policy allows it outright. Each answer is
   * used once.
   */
  const authorizeMcp = async (
    call: McpRelayCall,
    request: AbortSignal,
    context?: McpRelayContext,
  ): Promise<McpRelayDispatch> => {
    const sessionSignal = o.sessionSignal ?? new AbortController().signal;
    if (sessionSignal.aborted) throw new Error("the session has ended");
    if (call.method !== "tools/call") {
      const check = () => {
        if (sessionSignal.aborted) throw new Error("the session ended before the request was sent");
      };
      return { signal: sessionSignal, dispatch: check, recheck: async () => check() };
    }
    const toolName = `mcp__${call.server}__${call.tool}`;
    const policyCall = describe(toolName, call.arguments);
    const refuse = (decision: string, reason: string): never => {
      record(policyCall, context?.toolUseId, `mcp:${decision}`);
      throw new Error(reason);
    };
    const turn = o.liveTurn();
    if (!turn) return refuse("no-turn", "no live turn: ORCA relays tool calls only in one");
    const live = () => o.liveTurn()?.id === turn.id && !sessionSignal.aborted && !request.aborted;
    let grantedBy: McpGrant["grantedBy"] | undefined;
    if (context?.toolUseId !== undefined) {
      const grant = mcpGrants.get(context.toolUseId);
      mcpGrants.delete(context.toolUseId);
      if (
        grant &&
        grant.turnId === turn.id &&
        grant.server === call.server &&
        grant.tool === call.tool &&
        grant.arguments === JSON.stringify(call.arguments ?? null)
      )
        grantedBy = grant.grantedBy;
    }
    const decide = async (stage: string) => {
      const now = explainPermission(await policy(), policyCall, scope).decision;
      if (now === "deny") return refuse(`${stage}denied`, "ORCA's policy denies it");
      if (now === "ask" && grantedBy !== "ask:allow_once")
        return refuse(`${stage}asks`, "ORCA's policy asks about it, and nobody was asked for this call");
      if (!live()) return refuse(`${stage}turn-ended`, "the turn ended before the tool call was sent");
    };
    await decide("");
    record(policyCall, context?.toolUseId, `mcp:${grantedBy ?? "allow"}`);
    return {
      signal: turn.signal,
      dispatch: () => {
        if (!live()) refuse("dispatch:turn-ended", "the turn ended before the tool call was sent");
      },
      // At the handoff to the server: the policy as it is now, the same turn.
      recheck: () => decide("recheck:"),
    };
  };

  return { preToolUse, canUseTool, authorizeMcp };
}

/** Claude's split of `mcp__<server>__<tool>` for a server name without `__` (`mcp-servers.ts`). */
function mcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return undefined;
  const tool = rest.slice(separator + 2);
  return tool ? { server: rest.slice(0, separator), tool } : undefined;
}

/** The default for `decisionTimeoutMs`: the SDK waits far longer for a callback. */
export const CLAUDE_SDK_DECISION_TIMEOUT_MS = 10_000;

/** `p`, or a rejection once `ms` pass. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the permission policy was not read in time")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

function ruleOf(explained: ReturnType<typeof explainPermission>): PermissionRuleRecord {
  return {
    basis: explained.basis,
    ...(explained.origin
      ? {
          layer: explained.origin.layer,
          index: explained.origin.index,
          ...(explained.origin.file !== undefined ? { file: explained.origin.file } : {}),
          ...(explained.origin.capped ? { capped: true } : {}),
        }
      : {}),
  };
}

function asInput(toolInput: unknown): Record<string, unknown> {
  return typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
    ? (toolInput as Record<string, unknown>)
    : {};
}

/**
 * The ask as a person sees it: the call as ORCA's policy read it, with what Claude said about
 * why it asks, cleaned (CLI text, never instructions). One-time options only; with
 * `defaultToNo` the decline comes first.
 */
function askRequest(
  sessionId: string,
  toolUseId: string,
  call: PolicyCall,
  toolInput: unknown,
  ctx: AskContext,
): acp.RequestPermissionRequest {
  const text = (v: unknown) => claudeLabel(v, MAX_CONTEXT);
  const sdk = {
    ...(call.toolName ? { toolName: call.toolName } : {}),
    ...(text(ctx.title) ? { title: text(ctx.title) } : {}),
    ...(text(ctx.description) ? { description: text(ctx.description) } : {}),
    ...(text(ctx.displayName) ? { displayName: text(ctx.displayName) } : {}),
    ...(call.reason ? { decisionReason: call.reason } : {}),
    ...(text(ctx.blockedPath) ? { blockedPath: text(ctx.blockedPath) } : {}),
    ...(ctx.mcpServer
      ? { mcpServer: { name: text(ctx.mcpServer.name) ?? "", source: text(ctx.mcpServer.source) ?? "" } }
      : {}),
    ...(text(ctx.agentID) ? { agentId: text(ctx.agentID) } : {}),
    ...(call.caller ? { parentToolCallId: call.caller.parentToolCallId } : {}),
    ...(ctx.suppressAlwaysAllowRule ? { suppressAlwaysAllowRule: true } : {}),
    ...(ctx.defaultToNo ? { defaultToNo: true } : {}),
  };
  const allow: acp.PermissionOption = { optionId: "allow", name: "Allow once", kind: "allow_once" };
  const reject: acp.PermissionOption = { optionId: "reject", name: "Reject", kind: "reject_once" };
  return {
    sessionId,
    toolCall: {
      toolCallId: toolUseId,
      title: call.title,
      kind: call.kind as acp.ToolKind,
      locations: call.locations.map((path) => ({ path })),
      rawInput: toolInput,
      _meta: { claudeAgentSdk: sdk },
    },
    options: ctx.defaultToNo ? [reject, allow] : [allow, reject],
  };
}
