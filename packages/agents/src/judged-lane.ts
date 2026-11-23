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
 * - the targets are checked on the daemon's own file system, so the lane is open only for a
 *   session whose host is positively local; a remote host's files are not what the daemon
 *   sees, and checking these would verify nothing about them (#702 review);
 * - after an allow, the policy is read again: the rule must still be there with the same id and
 *   revision, still match, no restriction may have appeared, and the targets are verified
 *   again and must be the very files the judge was shown (same real paths, same file-system
 *   identities), not merely files that are still eligible. Anything else and the typed answer
 *   stands.
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
  /**
   * The experimental `command` judge (#701 per-kind switches): asked about a command the agent asks to run, for a
   * recommendation recorded with the ask. It never allows: the person still answers.
   */
  command?: JudgePermission | undefined;
  /** The policy as it is now, read again after the verdict and before answering. */
  reload: () => Promise<PermissionPolicy>;
  /**
   * Whether the session's tool calls run on the daemon's own machine. Only then are the targets
   * the check resolves the ones the agent reads; anything else keeps the lane closed.
   */
  localHost: boolean;
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
    if (!options.localHost) {
      const remote = gate(policy, request, ctx, options.io, false);
      return remote.state === "closed" && remote.verdict ? { ...typed, judged: { verdict: remote.verdict } } : typed;
    }
    if (options.command && typed.decision === "ask") {
      const advice = await adviseCommand(options.command, policy, request, ctx, signal);
      if (advice) return { ...typed, judged: advice };
    }
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
      again.candidates.some((r) => r.ruleId === allowed.ruleId && r.ruleRevision === allowed.ruleRevision) &&
      // The allow is for the files the judge was shown: the same ones, not ones still eligible.
      sameList(again.locations, first.locations) &&
      sameList(again.identities, first.identities);
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
      /** Their file-system identities, which the allow is bound to. */
      identities: readonly string[];
    };

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

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
  verify = true,
): Gate {
  const { kind, commandLike, claimed, matches } = callFacts(request, ctx);
  // A rule about one relayed MCP tool is the MCP lane's alone (#701): its match is deliberately empty.
  const candidates = (policy.judged ?? []).filter((rule) => rule.mcp === undefined && matches(rule.match, "allow"));
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
  if (!verify) return { state: "closed", verdict: "outside-envelope" };
  const check = verifyPlainRuleTargets({
    kind,
    locations: (request.toolCall.locations ?? []).map((l) => l.path),
    workspaceCwd: ctx?.workspaceCwd,
    protectedPaths: ctx?.protectedPaths,
    ...(io ? { io } : {}),
  });
  if (!check.targetsVerified) return { state: "closed", verdict: "outside-envelope" };
  return { state: "open", candidates, callKind: kind, locations: check.locations, identities: check.identities };
}

/* ------------------------------------------------------------------------------------------------ *
 * The experimental classes (#701 per-kind switches, Cal on #701, 2026-11-23). Each is off unless the
 * owner turns it on in `review.plainRules.experimental.kinds` and grants its own disclosure, and each
 * keeps the same hard boundaries as the read lane: protected paths, any typed deny or ask that holds
 * for the call, an unreadable layer, and a policy read again after the verdict. A judge's yes allows
 * one operation once and is never saved as a standing grant.
 * ------------------------------------------------------------------------------------------------ */

/** Whether any typed restriction holds for the call, or a layer could not be read: the lane stays closed. */
function restricted(policy: PermissionPolicy, facts: ReturnType<typeof callFacts>): boolean {
  if (policy.commandsRestricted === true) return true;
  return policy.rules.some(
    (rule) =>
      rule.decision !== "allow" &&
      (rule.match.command !== undefined
        ? facts.commandLike
        : facts.matches(rule.match, rule.decision) || facts.matches(rule.match, rule.decision, true)),
  );
}

const sameCandidate = (policy: PermissionPolicy, rule: { ruleId: string; ruleRevision: string }): boolean =>
  (policy.judged ?? []).some((r) => r.ruleId === rule.ruleId && r.ruleRevision === rule.ruleRevision);

/** The command text an `execute` ask carries, as the agent wrote it; the title when it sent none. */
function commandText(request: acp.RequestPermissionRequest): string {
  const raw = request.toolCall.rawInput;
  const command = raw !== null && typeof raw === "object" ? (raw as { command?: unknown }).command : undefined;
  if (typeof command === "string" && command !== "") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
  return request.toolCall.title ?? "";
}

/**
 * A recommendation on a command the agent asks to run (`command`, advisory). Undefined when no judged rule names
 * `execute` for it, or the lane is closed; otherwise the judge's verdict, marked advisory. The typed answer stands.
 */
async function adviseCommand(
  judge: JudgePermission,
  policy: PermissionPolicy,
  request: acp.RequestPermissionRequest,
  ctx: PermissionEvalContext | undefined,
  signal: AbortSignal,
): Promise<JudgedDecision | undefined> {
  const facts = callFacts(request, ctx);
  if (facts.kind !== "execute" || facts.claimed) return undefined;
  const candidates = (policy.judged ?? []).filter(
    (rule) => rule.mcp === undefined && rule.match.kind === "execute" && facts.matches(rule.match, "allow"),
  );
  if (candidates.length === 0) return undefined;
  const base = { kind: "command" as const, advisory: true };
  if (restricted(policy, facts)) return { ...base, verdict: "hard-boundary" };
  const command = commandText(request);
  if (command === "") return { ...base, verdict: "outside-envelope" };
  let outcome: PlainRuleJudgeOutcome;
  try {
    outcome = await judge(
      {
        rules: candidates.map((r) => ({ ruleId: r.ruleId, ruleRevision: r.ruleRevision, criterion: r.criterion })),
        restrictions: { deny: false, ask: false },
        action: {
          kind: "execute",
          title: request.toolCall.title ?? "",
          locations: [],
          inWorkspace: false,
          targetsVerified: false,
          command,
        },
      },
      signal,
    );
  } catch {
    return { ...base, verdict: "unavailable" };
  }
  return {
    ...base,
    verdict: outcome.verdict,
    ...(outcome.outcome === "advise" && outcome.ruleId ? { ruleId: outcome.ruleId } : {}),
    ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
    judgeConfigRef: outcome.judgeConfigRef,
  };
}

/** What an experimental lane answered: allowed once, or not, with what the judge said for the record. */
export type JudgedOperation =
  | {
      readonly allowed: true;
      readonly judged: JudgedDecision;
      /** Whether the allowing rule is still in `policy`, at the same revision: checked again at dispatch. */
      readonly stillCovered: (policy: PermissionPolicy) => boolean;
    }
  | { readonly allowed: false; readonly judged?: JudgedDecision };

/**
 * The `edits` class: a write ORCA's own file gate performs (`fs/writeTextFile`), when the typed answer is `ask`.
 * Only a judged rule naming kind `edit` is asked about, the target must be one existing regular file ORCA resolves
 * inside the workspace and outside every protected path (read-only ones included), and only on the daemon's own
 * machine. After an allow, the policy is read again and the same file must still qualify, with the same identity:
 * the allow is for that operation on that file. New files and edits the agent makes itself are not this lane's.
 */
export function judgedEditLane(options: {
  judge: JudgePermission;
  reload: () => Promise<PermissionPolicy>;
  localHost: boolean;
  /** The typed answer for the write under a policy: what the file gate decides by. */
  explain: (policy: PermissionPolicy) => PermissionExplanation;
  io?: PlainRuleTargetIo;
}): (
  policy: PermissionPolicy,
  write: { request: acp.RequestPermissionRequest; ctx: PermissionEvalContext | undefined },
  signal: AbortSignal,
) => Promise<JudgedOperation> {
  const base = { kind: "edit" as const };
  const look = (
    policy: PermissionPolicy,
    write: { request: acp.RequestPermissionRequest; ctx?: PermissionEvalContext | undefined },
  ) => {
    const facts = callFacts(write.request, write.ctx);
    const candidates = (policy.judged ?? []).filter(
      (rule) => rule.mcp === undefined && rule.match.kind === "edit" && facts.matches(rule.match, "allow"),
    );
    if (candidates.length === 0) return { state: "none" as const };
    if (facts.kind !== "edit" || facts.claimed || facts.commandLike || restricted(policy, facts))
      return { state: "closed" as const, verdict: "hard-boundary" };
    const check = verifyPlainRuleTargets({
      kind: "edit",
      locations: (write.request.toolCall.locations ?? []).map((l) => l.path),
      workspaceCwd: write.ctx?.workspaceCwd,
      protectedPaths: write.ctx?.protectedPaths,
      ...(options.io ? { io: options.io } : {}),
    });
    if (!check.targetsVerified) return { state: "closed" as const, verdict: "outside-envelope" };
    return { state: "open" as const, candidates, locations: check.locations, identities: check.identities };
  };
  return async (policy, write, signal) => {
    if (!options.localHost) return { allowed: false };
    const typed = options.explain(policy);
    if (typed.decision !== "ask") return { allowed: false };
    const first = look(policy, write);
    if (first.state === "none") return { allowed: false };
    if (first.state === "closed") return { allowed: false, judged: { ...base, verdict: first.verdict } };
    let outcome: PlainRuleJudgeOutcome;
    try {
      outcome = await options.judge(
        {
          rules: first.candidates.map((r) => ({
            ruleId: r.ruleId,
            ruleRevision: r.ruleRevision,
            criterion: r.criterion,
          })),
          restrictions: { deny: false, ask: false },
          action: {
            kind: "edit",
            // ORCA's own words for its own operation, with the verified path: never the absolute path.
            title: `Write ${first.locations[0]!}`,
            locations: first.locations,
            inWorkspace: true,
            targetsVerified: true,
          },
        },
        signal,
      );
    } catch {
      return { allowed: false, judged: { ...base, verdict: "unavailable" } };
    }
    const said: JudgedDecision = {
      ...base,
      verdict: outcome.verdict,
      ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
      judgeConfigRef: outcome.judgeConfigRef,
    };
    if (outcome.outcome !== "allow" || signal.aborted) return { allowed: false, judged: said };
    const allowed = first.candidates.find(
      (r) => r.ruleId === outcome.ruleId && r.ruleRevision === outcome.ruleRevision,
    );
    if (!allowed) return { allowed: false, judged: { ...said, verdict: "malformed" } };
    let now: PermissionPolicy;
    try {
      now = await options.reload();
    } catch {
      return { allowed: false, judged: { ...said, verdict: "unavailable" } };
    }
    if (signal.aborted) return { allowed: false, judged: said };
    const again = look(now, write);
    const still =
      options.explain(now).decision === "ask" &&
      again.state === "open" &&
      sameCandidate(now, allowed) &&
      sameList(again.locations, first.locations) &&
      sameList(again.identities, first.identities);
    if (!still) return { allowed: false, judged: { ...said, verdict: "changed-since" } };
    return {
      allowed: true,
      judged: { ...said, ruleId: allowed.ruleId, ruleRevision: allowed.ruleRevision },
      stillCovered: (p) => sameCandidate(p, allowed),
    };
  };
}

/**
 * The `mcpCalls` class: a tool call to an MCP server ORCA itself runs and relays, when the typed answer is `ask`.
 * The server, tool and arguments are ORCA's own facts about this one request. Only a judged rule whose `mcp` names
 * this exact server and tool, as identifiers and never through the display title, is asked about (#701 review).
 * The judge sees only the top-level arguments those rules list, as they will be sent; if a session secret is among
 * them, the judge would not see what is sent, so the person is asked instead. After an allow, the policy is read
 * again: the typed answer must still be `ask` and the rule must still be there at the same revision.
 */
export function judgedMcpLane(options: {
  judge: JudgePermission;
  reload: () => Promise<PermissionPolicy>;
  /** The typed answer for the relayed call under a policy: what the relay decides by. */
  explain: (policy: PermissionPolicy) => PermissionExplanation;
  /** Replaces the session's secret values in a text; a change means the text held one. */
  redact: (text: string) => string;
}): (
  policy: PermissionPolicy,
  call: {
    server: string;
    tool: string;
    arguments: unknown;
    request: acp.RequestPermissionRequest;
    ctx: PermissionEvalContext | undefined;
  },
  signal: AbortSignal,
) => Promise<JudgedOperation> {
  const base = { kind: "mcp" as const };
  const look = (
    policy: PermissionPolicy,
    call: {
      server: string;
      tool: string;
      request: acp.RequestPermissionRequest;
      ctx?: PermissionEvalContext | undefined;
    },
  ) => {
    const facts = callFacts(call.request, call.ctx);
    const candidates = (policy.judged ?? []).filter(
      (rule) =>
        rule.mcp !== undefined &&
        rule.mcp.server === call.server &&
        rule.mcp.tool === call.tool &&
        Object.entries(rule.match).every(([k, v]) => v === undefined || (k === "kind" && v === "other")),
    );
    if (candidates.length === 0) return { state: "none" as const };
    if (facts.claimed || restricted(policy, facts)) return { state: "closed" as const, verdict: "hard-boundary" };
    return { state: "open" as const, candidates };
  };
  return async (policy, call, signal) => {
    if (options.explain(policy).decision !== "ask") return { allowed: false };
    const first = look(policy, call);
    if (first.state === "none") return { allowed: false };
    if (first.state === "closed") return { allowed: false, judged: { ...base, verdict: first.verdict } };
    const args = disclosedArguments(call.arguments, first.candidates, options.redact);
    if (args === undefined) return { allowed: false, judged: { ...base, verdict: "outside-envelope" } };
    let outcome: PlainRuleJudgeOutcome;
    try {
      outcome = await options.judge(
        {
          rules: first.candidates.map((r) => ({
            ruleId: r.ruleId,
            ruleRevision: r.ruleRevision,
            criterion: r.criterion,
          })),
          restrictions: { deny: false, ask: false },
          action: {
            kind: "other",
            title: `${call.server}: ${call.tool}`,
            locations: [],
            inWorkspace: false,
            // ORCA runs this server and relays this request: the identity is its own, not the agent's claim.
            targetsVerified: true,
            mcp: { server: call.server, tool: call.tool, arguments: args },
          },
        },
        signal,
      );
    } catch {
      return { allowed: false, judged: { ...base, verdict: "unavailable" } };
    }
    const said: JudgedDecision = {
      ...base,
      verdict: outcome.verdict,
      ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
      judgeConfigRef: outcome.judgeConfigRef,
    };
    if (outcome.outcome !== "allow" || signal.aborted) return { allowed: false, judged: said };
    const allowed = first.candidates.find(
      (r) => r.ruleId === outcome.ruleId && r.ruleRevision === outcome.ruleRevision,
    );
    if (!allowed) return { allowed: false, judged: { ...said, verdict: "malformed" } };
    let now: PermissionPolicy;
    try {
      now = await options.reload();
    } catch {
      return { allowed: false, judged: { ...said, verdict: "unavailable" } };
    }
    if (signal.aborted) return { allowed: false, judged: said };
    const again = look(now, call);
    const still = options.explain(now).decision === "ask" && again.state === "open" && sameCandidate(now, allowed);
    if (!still) return { allowed: false, judged: { ...said, verdict: "changed-since" } };
    return {
      allowed: true,
      judged: { ...said, ruleId: allowed.ruleId, ruleRevision: allowed.ruleRevision },
      stillCovered: (p) => sameCandidate(p, allowed),
    };
  };
}

/**
 * The arguments a judge may see for a relayed tool call (#701 review): only the top-level names the
 * candidate rules list, with their values exactly as they will be sent, as a JSON object string.
 * `undefined` when the judge could not see what is needed: arguments that are not an object while
 * a name is listed, or a listed value holding a session secret, which would reach the judge only
 * redacted. The person decides those instead.
 */
function disclosedArguments(
  args: unknown,
  rules: readonly { mcp?: { arguments?: readonly string[] | undefined } | undefined }[],
  redact: (text: string) => string,
): string | undefined {
  const names = [...new Set(rules.flatMap((rule) => rule.mcp?.arguments ?? []))].sort();
  if (names.length === 0) return "{}";
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const picked: Record<string, unknown> = {};
  for (const name of names)
    if (Object.prototype.hasOwnProperty.call(args, name)) picked[name] = (args as Record<string, unknown>)[name];
  let text: string;
  try {
    text = JSON.stringify(picked);
  } catch {
    return undefined;
  }
  return redact(text) === text ? text : undefined;
}
