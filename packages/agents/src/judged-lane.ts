/**
 * The judged lane (#702): where a plain-language rule gets to allow one call.
 *
 * A judged rule (`JudgedPermissionRuleSchema` in `@orca/core`) has a deterministic `match` and
 * a criterion a judge applies (#701's `judgePermission`). The typed rules decide first and as
 * before; this only ever turns their `ask` or `deny` into an `allow` for this one call, and only
 * inside hard boundaries checked here in code before any judge is asked
 * (`docs/preparation/review-judge-701/plain-language-rules.md`, section 3):
 *
 * - ORCA's protected paths deny ahead of everything, judged or not;
 * - any typed `deny` or `ask` rule that matches the call anywhere in the policy closes the lane
 *   (`hard-boundary`), so a judge never overrides a restriction a person wrote, whatever the
 *   rule order;
 * - the call must be inside the safe envelope (`outside-envelope` otherwise): a known
 *   read-only kind (`read`, `search`), not command-like, with every target a single regular
 *   file ORCA itself resolved inside the workspace and outside every protected path
 *   (`verifyPlainRuleTargets`);
 * - after an allow, the policy is read again: the rule must still be there with the same id and
 *   revision, still match, no restriction may have appeared, and the targets are verified
 *   again. Anything else and the typed answer stands.
 *
 * The judge sees only the candidate rules' criteria and ORCA's own description of the call
 * (kind, title, the verified workspace-relative locations). Every failure is no match: the
 * typed rules, or the default, decide, and nothing is ever denied by a judge.
 *
 * The lane is off unless a session is given a judge. Turning it on is a setting (#701).
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { JudgedDecision, PermissionExplanation, PermissionPolicy } from "@orca/core";
import { callFacts, explainPermission, type PermissionEvalContext } from "./permissions.js";
import {
  PLAIN_RULE_JUDGED_KINDS,
  type JudgePermission,
  type PlainRuleJudgeOutcome,
} from "./review-judge/plain-rule.js";
import { verifyPlainRuleTargets, type PlainRuleTargetIo } from "./verified-targets.js";

export interface JudgedLaneOptions {
  /** #701's judge. It never throws; a throw here is treated as `unavailable`. */
  judge: JudgePermission;
  /** The policy as it is now, read again after the verdict and before answering. */
  reload: () => Promise<PermissionPolicy>;
  /** Tests only: the file system the target check reads. */
  io?: PlainRuleTargetIo;
}

/** Decides one call with the judged lane open: the typed answer, or an allow once by a judged rule. */
export type JudgedLane = (
  policy: PermissionPolicy,
  request: acp.RequestPermissionRequest,
  ctx: PermissionEvalContext | undefined,
  signal: AbortSignal,
) => Promise<PermissionExplanation>;

export function judgedLane(options: JudgedLaneOptions): JudgedLane {
  return async (policy, request, ctx, signal) => {
    const typed = explainPermission(policy, request, ctx);
    // Protected paths and a typed allow need no judge: the one can't be opened, the other is
    // already the most a judged rule could give.
    if (typed.basis === "protected" || typed.decision === "allow") return typed;
    const first = gate(policy, request, ctx, options.io);
    if (first.state === "closed") return first.verdict ? { ...typed, judged: { verdict: first.verdict } } : typed;
    let outcome: PlainRuleJudgeOutcome;
    try {
      outcome = await options.judge(
        {
          rules: first.candidates.map((r) => ({
            ruleId: r.ruleId,
            ruleRevision: r.ruleRevision,
            criterion: r.criterion,
          })),
          // Both are false here: the gate closed the lane otherwise. The judge checks again.
          restrictions: { deny: false, ask: false },
          action: {
            kind: first.callKind,
            title: request.toolCall.title ?? "",
            locations: first.locations,
            inWorkspace: true,
            targetsVerified: true,
          },
        },
        signal,
      );
    } catch {
      return { ...typed, judged: { verdict: "unavailable" } };
    }
    const said: JudgedDecision = {
      verdict: outcome.verdict,
      ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
      judgeConfigRef: outcome.judgeConfigRef,
    };
    if (outcome.outcome !== "allow" || signal.aborted) return { ...typed, judged: said };
    const allowed = first.candidates.find(
      (r) => r.ruleId === outcome.ruleId && r.ruleRevision === outcome.ruleRevision,
    );
    // An allow must name a rule that was sent, at the revision sent.
    if (!allowed) return { ...typed, judged: { ...said, verdict: "malformed" } };
    // The wait may have been long: the rule, the restrictions and the targets are checked again
    // against the policy as it is now, before the answer (#701 design, section 5).
    let now: PermissionPolicy;
    try {
      now = await options.reload();
    } catch {
      return { ...typed, judged: { ...said, verdict: "unavailable" } };
    }
    if (signal.aborted) return { ...typed, judged: said };
    const after = explainPermission(now, request, ctx);
    if (after.basis === "protected" || after.decision === "allow") return after;
    const again = gate(now, request, ctx, options.io);
    const still =
      again.state === "open" &&
      again.candidates.some((r) => r.ruleId === allowed.ruleId && r.ruleRevision === allowed.ruleRevision);
    if (!still) return { ...after, judged: { ...said, verdict: "changed-since" } };
    return {
      decision: "allow",
      basis: "judged",
      judged: { ...said, ruleId: allowed.ruleId, ruleRevision: allowed.ruleRevision },
    };
  };
}

type Gate =
  | { state: "closed"; verdict?: string }
  | {
      state: "open";
      candidates: NonNullable<PermissionPolicy["judged"]>;
      callKind: string;
      /** The verified real paths, workspace-relative: what the judge sees. */
      locations: readonly string[];
    };

/**
 * Whether the judged lane is open for this call under `policy`, and which judged rules it would
 * ask about, in order. Closed without a verdict when no judged rule's match holds: the lane
 * never looked, so nothing is recorded.
 */
function gate(
  policy: PermissionPolicy,
  request: acp.RequestPermissionRequest,
  ctx: PermissionEvalContext | undefined,
  io: PlainRuleTargetIo | undefined,
): Gate {
  const { kind, commandLike, claimed, matches } = callFacts(request, ctx);
  const candidates = (policy.judged ?? []).filter((rule) => matches(rule.match, "allow"));
  if (candidates.length === 0) return { state: "closed" };
  // Any typed deny or ask that holds for the call, wherever it sits, closes the lane. A
  // command rule is a restriction on a command-like call, which is outside the envelope anyway.
  const restricted = policy.rules.some(
    (rule) =>
      rule.decision !== "allow" &&
      (rule.match.command !== undefined
        ? commandLike
        : matches(rule.match, rule.decision) || matches(rule.match, rule.decision, true)),
  );
  if (restricted) return { state: "closed", verdict: "hard-boundary" };
  if (policy.commandsRestricted === true) return { state: "closed", verdict: "hard-boundary" };
  // A call claiming an MCP tool ORCA cannot verify is never allowed by anything (#1021).
  if (claimed || commandLike || !PLAIN_RULE_JUDGED_KINDS.has(kind))
    return { state: "closed", verdict: "outside-envelope" };
  const check = verifyPlainRuleTargets({
    kind,
    locations: (request.toolCall.locations ?? []).map((l) => l.path),
    workspaceCwd: ctx?.workspaceCwd,
    protectedPaths: ctx?.protectedPaths,
    ...(io ? { io } : {}),
  });
  if (!check.targetsVerified) return { state: "closed", verdict: "outside-envelope" };
  return { state: "open", candidates, callKind: kind, locations: check.locations };
}
