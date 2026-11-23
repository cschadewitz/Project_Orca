/**
 * The standing rule an "always" answer to a permission ask would write, and the reference
 * that binds a save to the preview a person saw (#702).
 *
 * `inputs.list` shows the preview (`OpenInputView.standing`) and `inputs.answer` must save
 * exactly that or nothing. So the preview carries a `ref`: a sha256 over the exact request,
 * the direction, the agent the rule is written for and the normalised rules. The answer sends
 * it back, and the daemon derives the rule again from the same recorded tool call and run
 * workspace and refuses (`CONFIG_STALE`, before anything is answered or written) when the
 * two no longer agree, so the person reviews again. Both sides call this one function, so the
 * preview and the check cannot drift.
 */
import { createHash } from "node:crypto";
import {
  broaderCommandPatterns,
  commandTextOf,
  derivePermissionRules,
  type HumanInputRequest,
  type PermissionRule,
  type RunState,
} from "@orca/core";
import type { StandingRulePreview } from "@orca/protocol";

/** One direction's preview, with the binding reference when there are rules to save. */
export function standingRulePreview(
  request: Pick<HumanInputRequest, "id" | "runId" | "stepRunId" | "kind" | "context">,
  state: Pick<RunState, "run">,
  agentId: string,
  decision: "allow" | "deny",
): StandingRulePreview | undefined {
  if (request.kind !== "permission") return undefined;
  const toolCall = request.context["toolCall"];
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const tc = toolCall as { kind?: unknown; title?: unknown; locations?: unknown; rawInput?: unknown };
  const derived = derivePermissionRules(
    {
      kind: typeof tc.kind === "string" ? tc.kind : undefined,
      title: typeof tc.title === "string" ? tc.title : undefined,
      paths: Array.isArray(tc.locations)
        ? tc.locations.flatMap((l: unknown) =>
            l && typeof l === "object" && typeof (l as { path?: unknown }).path === "string"
              ? [(l as { path: string }).path]
              : [],
          )
        : [],
      command:
        tc.kind === "execute"
          ? commandTextOf({ title: typeof tc.title === "string" ? tc.title : undefined, rawInput: tc.rawInput })
          : undefined,
      workspaceCwd: state.run.workspace.cwd,
    },
    decision,
  );
  if (!derived.ok) return { refused: { reason: derived.reason, detail: derived.detail } };
  // Wider command patterns are offered only for a standing deny: a family rule refuses the
  // whole family, and an allow for one is refused anyway (`COMMAND_ALLOW_REFUSED`).
  const text =
    tc.kind === "execute" && decision === "deny"
      ? commandTextOf({ title: typeof tc.title === "string" ? tc.title : undefined, rawInput: tc.rawInput })
      : undefined;
  const broader = (text === undefined ? [] : broaderCommandPatterns(text)).map((command) => {
    const rules: PermissionRule[] = [{ match: { kind: "execute", command }, decision }];
    return { rules, ref: standingRuleRef(request, agentId, decision, rules) };
  });
  return {
    rules: derived.rules,
    ref: standingRuleRef(request, agentId, decision, derived.rules),
    ...(broader.length > 0 ? { broader } : {}),
  };
}

/** The rules a save names by its `previewRef`, or undefined when it names none of them. */
export function chosenStandingRules(
  preview: StandingRulePreview,
  ref: string,
): { rules: PermissionRule[]; broader: boolean } | undefined {
  if (!("rules" in preview)) return undefined;
  if (preview.ref === ref) return { rules: preview.rules, broader: false };
  const wider = preview.broader?.find((entry) => entry.ref === ref);
  return wider ? { rules: wider.rules, broader: true } : undefined;
}

/** The binding: exact request identity, direction, agent and the rules in a fixed key order. */
function standingRuleRef(
  request: Pick<HumanInputRequest, "id" | "runId" | "stepRunId">,
  agentId: string,
  decision: "allow" | "deny",
  rules: readonly PermissionRule[],
): string {
  const normalized = rules.map((rule) => [
    rule.decision,
    rule.match.kind ?? null,
    rule.match.titlePattern ?? null,
    rule.match.path ?? null,
    rule.match.pathPrefix ?? null,
    rule.match.scope ?? null,
    rule.match.command ?? null,
  ]);
  const canonical = JSON.stringify([
    "orca-standing-rule-v1",
    request.runId,
    request.stepRunId,
    request.id,
    agentId,
    decision,
    normalized,
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
