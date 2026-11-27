/**
 * One tool call as ORCA's policy sees it (#1119), whichever route it arrived by.
 *
 * The policy (`explainPermission`), the judged lane, the protected-path check and the
 * "always" recorder used to read ACP's `session/request_permission` shape directly. A second
 * route, the Claude Agent SDK's `canUseTool` and hook inputs, would otherwise need its own
 * copy of that security-critical code. So both routes map their calls into `PolicyCall`, and
 * only this shape is decided.
 *
 * The mapping from ACP keeps what the policy read before exactly: the agent's title (empty
 * when it sent none), its kind (`other` when it sent none), its raw input, its locations in
 * order, and the MCP tool its metadata claims. The rest (`toolName`, `caller`, `reason`) is
 * context a route may know. The policy does not decide by it.
 */
import type * as acp from "@agentclientprotocol/sdk";
import { mcpToolClaimOf, type McpToolClaim } from "@orca/core";

export interface PolicyCall {
  /** The agent's own display title: matched by title rules, never trusted as a fact. */
  readonly title: string;
  /** The tool kind the agent reported (an ACP `ToolKind`), or `other`: advice, not a checked fact. */
  readonly kind: string;
  /** The tool's own input as the agent sent it, when it did: a command is read from `input.command`. */
  readonly input?: unknown;
  /** The paths the call says it touches, as written: relative ones read against the call's cwd. */
  readonly locations: readonly string[];
  /** An MCP tool the call's metadata claims to run and ORCA cannot verify (#1021). */
  readonly mcpClaim?: McpToolClaim | undefined;
  /**
   * Other forms of the title the same call takes on another route (the hook's own, #1119
   * review): a deny or an ask title rule that matches any of them holds. No allow is matched
   * by one.
   */
  readonly titleForms?: readonly string[] | undefined;
  /**
   * ORCA cannot reproduce how an ACP ask would describe this call (its title, or the locations
   * it would name), so a rule written against that ask may or may not hold for it (#1119
   * review). It is decided at least as strictly as the ask would be: no allow rule decides it,
   * a deny or ask title rule whose other conditions hold decides it, and a fallthrough `allow`
   * asks instead (`unverified-identity`).
   */
  readonly approximate?: true | undefined;
  /** The agent's own name for the tool (`Bash`, `mcp__github__create_issue`), when the route has one. */
  readonly toolName?: string | undefined;
  /** Who made the call: the root agent, or a subagent started by the parent tool call named. */
  readonly caller?: { readonly parentToolCallId: string } | undefined;
  /** Why the agent says it asks, when it says: shown to people, never decided by. */
  readonly reason?: string | undefined;
}

/** `request` as the policy reads it: the call ACP describes. */
export function policyCallFromAcp(request: acp.RequestPermissionRequest): PolicyCall {
  return policyCallFromAcpToolCall(request.toolCall);
}

/** One ACP tool call (an ask's, or one built in ACP shape) as the policy reads it. */
export function policyCallFromAcpToolCall(tc: acp.ToolCallUpdate): PolicyCall {
  const mcpClaim = mcpToolClaimOf(tc);
  return {
    title: tc.title ?? "",
    kind: tc.kind ?? "other",
    ...(tc.rawInput !== undefined ? { input: tc.rawInput } : {}),
    locations: (tc.locations ?? []).map((l) => l.path),
    ...(mcpClaim !== undefined ? { mcpClaim } : {}),
  };
}

/**
 * The call a policy function was given: a `PolicyCall` as it is, an ACP request mapped. The
 * policy's exported functions take either, so the ACP route and its tests keep calling them
 * as before while another route passes its own mapping.
 */
export type PolicyCallInput = PolicyCall | acp.RequestPermissionRequest;

export function asPolicyCall(call: PolicyCallInput): PolicyCall {
  return isAcpRequest(call) ? policyCallFromAcp(call) : call;
}

function isAcpRequest(call: PolicyCallInput): call is acp.RequestPermissionRequest {
  return (
    typeof (call as { toolCall?: unknown }).toolCall === "object" && (call as { toolCall?: unknown }).toolCall !== null
  );
}

/** The text a command rule reads: the shape `commandTextOf` takes, from a `PolicyCall`. */
export function commandSource(call: PolicyCall): { title: string; rawInput?: unknown } {
  return call.input !== undefined ? { title: call.title, rawInput: call.input } : { title: call.title };
}
