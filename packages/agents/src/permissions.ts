/**
 * Permission policy evaluation for ACP `session/request_permission`.
 *
 * ORCA is usually unattended, so the default is to allow and to log. Rules can
 * deny or route specific tool kinds/paths to a human (or, in ACP-facade mode,
 * to the upstream client that launched ORCA).
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { PermissionDecision, PermissionPolicy } from "@orca/core";

export interface PermissionContext {
  request: acp.RequestPermissionRequest;
  /** Called for `ask`; returns the chosen optionId, or undefined to cancel. */
  ask?: (request: acp.RequestPermissionRequest) => Promise<string | undefined>;
}

export function decidePermission(policy: PermissionPolicy, request: acp.RequestPermissionRequest): PermissionDecision {
  const tc = request.toolCall;
  const title = tc.title ?? "";
  const kind = tc.kind ?? "other";
  const paths = (tc.locations ?? []).map((l) => l.path);
  for (const rule of policy.rules) {
    const m = rule.match;
    if (m.kind && m.kind !== kind) continue;
    if (m.titlePattern && !new RegExp(m.titlePattern).test(title)) continue;
    if (m.pathPrefix && !paths.some((p) => p.startsWith(m.pathPrefix!))) continue;
    return rule.decision;
  }
  return policy.default;
}

function pick(options: acp.PermissionOption[], kinds: acp.PermissionOptionKind[]): acp.PermissionOption | undefined {
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k);
    if (o) return o;
  }
  return undefined;
}

export async function resolvePermission(
  policy: PermissionPolicy,
  ctx: PermissionContext,
): Promise<{ response: acp.RequestPermissionResponse; decision: string }> {
  const decision = decidePermission(policy, ctx.request);
  const options = ctx.request.options;
  const select = (o: acp.PermissionOption | undefined, label: string) =>
    o
      ? { response: { outcome: { outcome: "selected" as const, optionId: o.optionId } }, decision: label }
      : { response: { outcome: { outcome: "cancelled" as const } }, decision: "cancelled" };
  switch (decision) {
    case "allow":
      return select(pick(options, ["allow_once", "allow_always"]), "allow");
    case "deny":
      return select(pick(options, ["reject_once", "reject_always"]), "deny");
    case "ask": {
      const chosen = ctx.ask ? await ctx.ask(ctx.request) : undefined;
      const o = chosen ? options.find((x) => x.optionId === chosen) : undefined;
      return o
        ? { response: { outcome: { outcome: "selected", optionId: o.optionId } }, decision: `ask:${o.kind}` }
        : { response: { outcome: { outcome: "cancelled" } }, decision: "ask:cancelled" };
    }
  }
}
