/**
 * Permission policy evaluation for ACP `session/request_permission`, and the sidecar file
 * that "allow always" writes to.
 *
 * ORCA is usually unattended, so an agent that declares no policy gets the conservative one
 * (`DEFAULT_PERMISSION_POLICY` in `@orca/core`): reads, searches and edits inside the run's
 * workspace are allowed and logged, and everything else — `execute`, the network, a path in
 * a sibling checkout — is `ask`. Rules can deny, allow or route specific tool kinds/paths to
 * a human (or, in ACP-facade mode, to the upstream client that launched ORCA).
 *
 * An `ask` nobody can answer is refused, not parked: `resolvePermission` with no `ask`
 * callback, and a `PausingHumanInput` that declines to persist a permission question,
 * both come back `cancelled`, which ends the tool call rather than the run.
 *
 * A policy has two halves and a floor. The configured half is `agents[].permissions` in
 * `orca.config.yaml`: hand-curated, and no place for a machine to append. The written half
 * is `orca.permissions.json` beside it — the workspace sidecar, added to whenever someone
 * answers a prompt with "always", and layered *under* the configured rules so configuration
 * always outranks it. The file is plain JSON with provenance on every rule because a
 * standing permission grant ought to be something a teammate can read in a diff. The floor
 * is `DEFAULT_PERMISSION_POLICY`, appended last by `loadEffectivePermissionPolicy`, so that
 * a `deny` from either half outranks it (#140).
 *
 * The sidecar is read *per ask*, not per session (#271): `openAcpSession` calls
 * `loadEffectivePermissionPolicy` from its `session/request_permission` handler, so a rule
 * recorded while a run is in flight — somebody answering "always" in the app — decides the
 * very next tool call rather than only the next session. The file is two levels of nesting
 * deep and an ask is already a round trip to an agent, so re-reading it costs nothing worth
 * caching against.
 *
 * Ahead of every layer sit ORCA's own files (`ProtectedPaths`, C4-01). With no `workspace:`
 * configured the run's workspace *is* the config directory, so the config, the sidecar, the
 * store and `auth/` are all "inside the workspace" — and an agent allowed to edit the sidecar
 * could allow itself everything. No rule reaches them: configured, written or default.
 *
 * The schemas, the layering and the derivation are in `@orca/core`
 * (`model/agent.ts`), which is node-free; the reading, writing, locking and the physical
 * path checks are here.
 */
import { createHash } from "node:crypto";
import { readlinkSync, realpathSync, statSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { revisionOf, withPolicyLock } from "./permission-file.js";
import type { JudgedLane } from "./judged-lane.js";
import type * as acp from "@agentclientprotocol/sdk";
import {
  commandCatches,
  unverifiedExecuteAllowed,
  commandTextOf,
  mcpToolClaimOf,
  mcpToolTitle,
  neutralPart,
  parseCommand,
  parseCommandPattern,
  derivePermissionRules,
  effectivePermissionPolicy,
  isJudgedPermissionRule,
  isSidecarJudgedRule,
  isWildcardPermissionRule,
  OrcaError,
  PERMISSION_POLICY_FILENAME,
  PermissionPolicyFileSchema,
  permissionPathForms,
  permissionPolicyFileVersion,
  permissionRuleExpired,
  PERMISSION_JUDGED_VERSION,
  PERMISSION_LIFETIME_VERSION,
  samePermissionRule,
  SidecarJudgedPermissionRuleSchema,
  workspaceRelativePath,
  WritablePermissionPolicyFileSchema,
} from "@orca/core";
import type {
  CommandPart,
  ConfiguredPermissionPolicy,
  PermissionDecision,
  PermissionDeriveRefusal,
  PermissionExplanation,
  PermissionPolicy,
  PermissionPolicyFile,
  PermissionRule,
  PermissionRuleOrigin,
  JudgedPermissionRule,
  JudgedPolicyRule,
  RecordedPermissionRule,
  SidecarJudgedPermissionRule,
  SidecarPermissionRule,
} from "@orca/core";

export interface PermissionContext {
  request: acp.RequestPermissionRequest;
  /** Called for `ask`; returns the chosen optionId, or undefined to cancel. */
  ask?: (request: acp.RequestPermissionRequest) => Promise<string | undefined>;
  /** Passed through to `decidePermission`, so workspace-relative rules can resolve. */
  scope?: PermissionEvalContext | undefined;
  /** The exact invocation's lifetime; late answers cannot authorize a subsequent turn. */
  signal?: AbortSignal;
  /**
   * The judged lane (#702), when this session has a judge. Without one, judged rules are not
   * consulted and the typed rules decide alone.
   */
  judged?: JudgedLane | undefined;
}

/**
 * What a rule's paths are relative to. Rules ORCA writes are workspace-relative so that the
 * same grant still fires in the next run's git worktree, which sits at a different absolute
 * path; without a workspace only absolute rules can match.
 */
export interface PermissionEvalContext {
  /** Absolute path of the run's workspace (`Run.workspace.cwd`). */
  workspaceCwd?: string | undefined;
  /** ORCA's own files: a call that would touch one is denied ahead of every rule (C4-01). */
  protectedPaths?: ProtectedPaths | undefined;
}

export function decidePermission(
  policy: PermissionPolicy,
  request: acp.RequestPermissionRequest,
  ctx?: PermissionEvalContext,
): PermissionDecision {
  return explainPermission(policy, request, ctx).decision;
}

/**
 * `decidePermission`'s answer with what decided it (#702): ORCA's protected paths, the rule
 * that matched (its index in `policy.rules` and, when the loader recorded one, its origin), the
 * fallthrough, or the command restriction. This is the one evaluation; `decidePermission` is
 * its decision.
 */
export function explainPermission(
  policy: PermissionPolicy,
  request: acp.RequestPermissionRequest,
  ctx?: PermissionEvalContext,
): PermissionExplanation {
  if (protectedLocation(request, ctx) !== undefined) return { decision: "deny", basis: "protected" };
  const found = decideByRules(policy, request, ctx);
  if (found.ruleIndex === undefined) return found;
  const origins = policy.origins;
  const origin = origins && origins.length === policy.rules.length ? origins[found.ruleIndex] : undefined;
  return origin ? { ...found, origin } : found;
}

/**
 * A configured judged rule as the evaluated policy carries it (#702): its id names it in its
 * layer, and its revision is the sha256 of its canonical content, so an edit is a new rule.
 */
export function judgedPolicyRule(rule: JudgedPermissionRule, ruleId: string): JudgedPolicyRule {
  const match = Object.fromEntries(
    Object.entries(rule.match)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ) as PermissionRule["match"];
  const ruleRevision = createHash("sha256")
    .update(JSON.stringify({ match, judge: { criterion: rule.judge.criterion } }))
    .digest("hex");
  return { match, criterion: rule.judge.criterion, ruleId, ruleRevision };
}

/**
 * The `rule` an `agent.permission` event records for an explanation (#702). It never includes
 * the sidecar `revision`: that is a deterministic digest of the whole permission file, and an
 * ordinary event would carry it into every reader and export of the run log, where it could
 * correlate one workspace's policy across runs (#702 review). The layer and index say which
 * rule decided without it; the exact revision stays in memory for owner-private audit data.
 */
export function permissionRuleRecord(explained: PermissionExplanation): PermissionRuleRecord {
  const o = explained.origin;
  return {
    basis: explained.basis,
    ...(o
      ? {
          layer: o.layer,
          index: o.index,
          ...(o.file !== undefined ? { file: o.file } : {}),
          ...(o.capped ? { capped: true } : {}),
        }
      : {}),
    ...(explained.judged ? { judge: judgedRecord(explained.judged) } : {}),
  };
}

/**
 * What the event says about the judged lane (#702): the verdict, the reason code, which rule
 * allowed by its id (`config:3`) and which judge decided. Not the rule's revision, which is a
 * digest of its content, for the same reason the sidecar's is kept out (#702 review).
 */
function judgedRecord(j: NonNullable<PermissionExplanation["judged"]>): NonNullable<PermissionRuleRecord["judge"]> {
  return {
    verdict: j.verdict,
    ...(j.ruleId ? { ruleId: j.ruleId } : {}),
    ...(j.reasonCode ? { reasonCode: j.reasonCode } : {}),
    ...(j.judgeConfigRef ? { judgeConfigRef: j.judgeConfigRef } : {}),
  };
}

export interface PermissionRuleRecord {
  basis: PermissionExplanation["basis"];
  layer?: PermissionRuleOrigin["layer"];
  index?: number;
  file?: number;
  capped?: boolean;
  judge?: { verdict: string; ruleId?: string; reasonCode?: string; judgeConfigRef?: string };
}

/**
 * The policy's answer, first match wins, with nothing ahead of it.
 *
 * A `command` rule (#702) is matched per simple command: an `execute` call's command is split
 * on `&&`, `;`, `|` and the like, each part is decided by the first rule that matches *it*,
 * and one denied part denies the call. Otherwise the call is asked: once any layer restricts
 * commands by their words, no `execute` call is allowed without a person, whether the allow
 * would have come from an older title rule, a kindless rule or the fallthrough, and whether or
 * not the agent sent the command apart from its title (`unverifiedExecuteAllowed`, #702
 * review). Every other kind of rule matches the call as a whole, as before, and a policy with
 * no `command` rule decides exactly as it did.
 */
function decideByRules(
  policy: PermissionPolicy,
  request: acp.RequestPermissionRequest,
  ctx?: PermissionEvalContext,
): PermissionExplanation {
  const { kind, commandLike, claimed, claimedTitle, matches } = callFacts(request, ctx);
  let byClaim = false;
  const matchesCall = (m: PermissionRule["match"], decision: PermissionDecision) => matches(m, decision, byClaim);
  const tc = request.toolCall;
  // Once commands are restricted by their words, no allow decides an `execute`, an
  // unclassified call or one whose input carries a command (#702 review): skipping them lets a restriction later in the list still
  // be reached, and nothing approves a call whose command ORCA cannot vouch for.
  const restricted = (kind === "execute" || commandLike) && !unverifiedExecuteAllowed(policy);
  const decide = (part: CommandPart | undefined): PermissionExplanation => {
    for (const [ruleIndex, rule] of policy.rules.entries()) {
      const m = rule.match;
      if ((restricted || claimed) && rule.decision === "allow") continue;
      if (!matchesCall(m, rule.decision)) continue;
      if (m.command !== undefined) {
        // A command is only ever an `execute`'s, and a part that is not there matches no rule.
        // A command rule never allows (`COMMAND_ALLOW_REFUSED`): the loaders refuse or ignore
        // one, and this skips any that got here another way.
        if (!restricted || part === undefined || rule.decision === "allow") continue;
        const pattern = parseCommandPattern(m.command);
        if (pattern === undefined || !commandCatches(pattern, part)) continue;
      }
      return { decision: rule.decision, basis: "rule", ruleIndex };
    }
    if (claimed && policy.default === "allow") return { decision: "ask", basis: "unverified-identity" };
    return { decision: policy.default, basis: "default" };
  };
  const evaluate = (): PermissionExplanation => (restricted ? decideParts() : decide(undefined));
  // A policy with command rules: decide each part, take the strictest, and never allow. An
  // allow from an older rule, a kindless rule or the fallthrough is unverified (#702 review).
  const decideParts = (): PermissionExplanation => {
    const text = commandTextOf(tc);
    const parts = text === undefined ? [] : parseCommand(text).parts.filter((p) => !neutralPart(p));
    const decisions = parts.length === 0 ? [decide(undefined)] : parts.map(decide);
    // The first denied part is what denied the call. Otherwise it is asked, and the record cites
    // the first part an explicit ask rule decided, ahead of any part that only fell through to
    // an ask default; failing both, the restriction itself, when every part would have been
    // allowed. Only the attribution depends on this order, never the outcome (#702 review).
    const denied = decisions.find((d) => d.decision === "deny");
    if (denied) return denied;
    return (
      decisions.find((d) => d.decision === "ask" && d.basis === "rule") ??
      decisions.find((d) => d.decision === "ask") ?? { decision: "ask", basis: "command-restricted" }
    );
  };
  const plain = evaluate();
  if (claimedTitle === undefined) return plain;
  // With first match wins, a rule one title form meets could shadow a stricter one later in the
  // list that only the other form meets. So the call is decided once by the agent's title and
  // once by the claimed `server: tool`, and the stricter answer stands. A call is never
  // decided more loosely than its title alone would decide it, and a call with no claim is
  // decided exactly as before (#1021 review).
  byClaim = true;
  const claimedAnswer = evaluate();
  const stricter = strictness(claimedAnswer.decision) - strictness(plain.decision);
  // On a tie only the attribution can differ: a rule the claim met is cited ahead of a fallthrough.
  return stricter > 0 || (stricter === 0 && plain.basis !== "rule" && claimedAnswer.basis === "rule")
    ? claimedAnswer
    : plain;
}

/**
 * The facts about one call that every rule is matched against: its kind, whether it could be a
 * command, and whether a rule's `match` holds for it. Command words are not compared here;
 * a `command` match is decided per part by `decideByRules`.
 */
export function callFacts(
  request: acp.RequestPermissionRequest,
  ctx?: PermissionEvalContext,
): {
  kind: string;
  commandLike: boolean;
  /** The call claims an MCP tool ORCA cannot verify (#1021): no allow decides it. */
  claimed: boolean;
  /** The claimed `server: tool`, when the claim names both plainly. */
  claimedTitle: string | undefined;
  /**
   * Whether a rule's `match` holds, its title tested against the agent's title or, with
   * `byClaim`, against the claimed `server: tool` (which no allow is ever matched by).
   */
  matches: (m: PermissionRule["match"], decision: PermissionDecision, byClaim?: boolean) => boolean;
} {
  const tc = request.toolCall;
  // An MCP tool the call's own metadata names (#1021): Gemini CLI leaves the server out of its
  // title and puts it only there. The agent wrote it and ORCA cannot check it, so it is a
  // claim: a deny or ask rule is tested against the claimed `server: tool` as well as the
  // agent's title, so a restriction written for either form holds, but no allow of any kind
  // decides the call. It stays on the one-time path, asked each time unless something denies
  // it, and a grant on one server cannot reach the same tool name on another. Matching by the
  // claim may only add restrictions, never weaken one (#1021 review): see `decideByRules`.
  const claim = mcpToolClaimOf(tc);
  const claimedTitle = claim?.identity ? mcpToolTitle(claim.identity) : undefined;
  const title = tc.title ?? "";
  const kind = tc.kind ?? "other";
  // A call the agent did not classify could be a command under another name, and so could one
  // that carries a command in its input whatever kind it claims: the kind is the adapter's
  // advice, not a fact ORCA checked (#702 review).
  const raw = tc.rawInput;
  const rawCommand = raw !== null && typeof raw === "object" ? (raw as { command?: unknown }).command : undefined;
  const commandLike = kind === "other" || (rawCommand !== undefined && rawCommand !== null && rawCommand !== "");
  const cwd = ctx?.workspaceCwd;
  const locations = (tc.locations ?? []).map((l) => l.path);
  const paths = locations.flatMap((p) => permissionPathForms(p, cwd));
  // Both are false for a call with no locations, so `scope` never matches one (#140).
  const allInside = locations.length > 0 && locations.every((p) => workspaceRelativePath(p, cwd) !== undefined);
  const anyOutside = locations.some((p) => workspaceRelativePath(p, cwd) === undefined);
  const titleMatches = (pattern: string, decision: PermissionDecision, byClaim: boolean): boolean => {
    // A pattern that is not a regular expression fails closed (#701 review): it never matches
    // for an allow, and always matches for a deny or an ask.
    const test = (text: string): boolean => {
      try {
        return new RegExp(pattern).test(text);
      } catch {
        return decision !== "allow";
      }
    };
    if (!byClaim) return test(title);
    return decision !== "allow" && claimedTitle !== undefined && test(claimedTitle);
  };
  const matchesCall = (m: PermissionRule["match"], decision: PermissionDecision, byClaim = false): boolean => {
    // A command rule also reaches a command-like call of another kind, so its restriction is
    // not dodged by leaving the kind out or giving a wrong one.
    if (m.kind && m.kind !== kind && !(m.command !== undefined && commandLike)) return false;
    if (m.scope === "workspace" && !allInside) return false;
    if (m.scope === "outside-workspace" && !anyOutside) return false;
    if (m.titlePattern && !titleMatches(m.titlePattern, decision, byClaim)) return false;
    if (m.path !== undefined) {
      const wanted = permissionPathForms(m.path, cwd);
      if (!wanted.some((w) => paths.includes(w))) return false;
    }
    if (m.pathPrefix) {
      const prefixes = permissionPathForms(m.pathPrefix, cwd).filter((p) => p !== "");
      if (prefixes.length > 0 && !paths.some((p) => prefixes.some((prefix) => p.startsWith(prefix)))) return false;
    }
    return true;
  };
  return { kind, commandLike, claimed: claim !== undefined, claimedTitle, matches: matchesCall };
}

function strictness(decision: PermissionDecision): number {
  return decision === "deny" ? 2 : decision === "ask" ? 1 : 0;
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
): Promise<{ response: acp.RequestPermissionResponse; decision: string; rule?: PermissionRuleRecord }> {
  if (ctx.signal?.aborted) return { response: { outcome: { outcome: "cancelled" } }, decision: "ask:expired" };
  const explained = ctx.judged
    ? await ctx.judged(policy, ctx.request, ctx.scope, ctx.signal ?? new AbortController().signal)
    : explainPermission(policy, ctx.request, ctx.scope);
  // A judge may take a while: a turn that ended meanwhile is answered as expired, never allowed.
  if (ctx.signal?.aborted)
    return {
      response: { outcome: { outcome: "cancelled" } },
      decision: "ask:expired",
      rule: permissionRuleRecord(explained),
    };
  // What decided it travels with the answer (#702), so the event says which rule it was.
  return { ...(await answerPermission(explained, ctx)), rule: permissionRuleRecord(explained) };
}

async function answerPermission(
  explained: PermissionExplanation,
  ctx: PermissionContext,
): Promise<{ response: acp.RequestPermissionResponse; decision: string }> {
  // `decidePermission`'s own check, kept apart here so the decision can say why it denied.
  const guarded = explained.basis === "protected";
  const decision = explained.decision;
  const options = ctx.request.options;
  const select = (o: acp.PermissionOption | undefined, label: string) =>
    o
      ? { response: { outcome: { outcome: "selected" as const, optionId: o.optionId } }, decision: label }
      : { response: { outcome: { outcome: "cancelled" as const } }, decision: "cancelled" };
  switch (decision) {
    case "allow": {
      // Only a one-time option (#702). `allow_always` would have the *agent* remember the
      // grant and stop asking, so a rule that later expires, is removed or is narrowed would
      // never be consulted again for that tool: ORCA's own rule is the standing grant, and
      // the agent is told yes for this one call. An ask that offers no one-time allow is
      // refused and says why, rather than widened.
      const once = pick(options, ["allow_once"]);
      return once
        ? select(once, "allow")
        : { response: { outcome: { outcome: "cancelled" } }, decision: "allow:no-one-time-option" };
    }
    case "deny":
      return select(pick(options, ["reject_once", "reject_always"]), guarded ? "deny:protected" : "deny");
    case "ask": {
      // Nothing to ask through: the run has no human-input channel at all. Say so in the
      // decision rather than logging a bare "cancelled", because "the policy wanted a person
      // and there was none" is the one a person reading the log has to act on (#140).
      if (!ctx.ask) return { response: { outcome: { outcome: "cancelled" } }, decision: "ask:no-answerer" };
      const chosen = await permissionWhileLive(() => ctx.ask!(ctx.request), ctx.signal);
      if (ctx.signal?.aborted) return { response: { outcome: { outcome: "cancelled" } }, decision: "ask:expired" };
      const o = chosen ? options.find((x) => x.optionId === chosen) : undefined;
      return o
        ? { response: { outcome: { outcome: "selected", optionId: o.optionId } }, decision: `ask:${o.kind}` }
        : { response: { outcome: { outcome: "cancelled" } }, decision: "ask:cancelled" };
    }
  }
}

/** Release a dead callback even if its host never settles; detach the abort listener on both paths. */
function permissionWhileLive(
  ask: () => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!signal) return ask();
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => (signal.aborted ? undefined : ask()))
      .then(
        (answer) => {
          signal.removeEventListener("abort", abort);
          resolve(signal.aborted ? undefined : answer);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error instanceof Error ? error : new Error("permission callback failed", { cause: error }));
        },
      );
  });
}

/* -------------------------------------------------------------------------- *
 * Protected paths
 * -------------------------------------------------------------------------- */

/**
 * ORCA's own files, which no permission rule can open to an agent (C4-01).
 *
 * With no `workspace:` configured, a run's workspace is the config directory, and that holds
 * what decides what an agent may do and who may answer it: the config, the permission
 * sidecar, the store with its key, and `auth/` with an owner token. The default policy allows
 * edits inside the workspace and the sidecar is re-read on every ask, so an agent that could
 * write `{"match":{},"decision":"allow"}` into the sidecar would have every later `execute`
 * approved without anybody being asked.
 *
 * So these are checked before the rules, and nothing overrides them — a configured rule, a
 * sidecar rule, the defaults or `default: allow`. Changing them is a person's job, in the
 * config or on the Config surface, never an agent's through a tool call. The ACP session
 * checks its `fs/*` handlers against the same list. An agent's own native tools can still
 * reach these files without asking ORCA at all; the answer to that is keeping the config
 * directory out of every agent root (`workspace:`, `isolateRoots`), and for a hard boundary
 * an operating-system one (ADR 0009).
 */
export interface ProtectedPaths {
  /** An agent may read these, but never edit, write, move or delete them. */
  readonly readOnly: readonly string[];
  /** An agent may not touch these at all, reads included: credentials and key material. */
  readonly noAccess: readonly string[];
  /**
   * Directories inside a read-only path that are the agent's after all, and so the policy's
   * to decide — the store's `work/` and `program/`, where ORCA's own workflows have agents
   * write their deliverables when the store sits in the workspace. Each is placed by its
   * parent, so a link standing in its place does not carry the rest of the store with it.
   */
  readonly agentAreas?: readonly string[] | undefined;
}

/**
 * The protected path `path` falls under for this kind of access, or undefined when it is free.
 * `remove` — a delete or a move — also refuses a directory that holds one, since taking the
 * directory away takes the protected path with it.
 *
 * Both sides are compared as the file system resolves them — symlinks followed, and `..` taken
 * from where a link leads rather than from where it was written, the way the agent's own open
 * would — and segment by segment. So a link to `auth/` is `auth/`,
 * `sub/../orca.permissions.json` is the sidecar, and `.orca-notes` is not `.orca`. A relative
 * path is taken against the workspace, as a rule's is; the ACP session always passes one.
 *
 * What a path *is* depends on the access (#706 review):
 *
 * - a **read** opens what the path leads to, links followed, a link whose target does not
 *   exist yet included;
 * - a **remove** (delete, move, rename) acts on the directory entry itself: its directory is
 *   resolved, its last name is not. Removing a link to the sidecar removes the link; removing
 *   or renaming over a sidecar that *is* a link replaces the sidecar's entry, whatever it
 *   points at;
 * - a **write** is both: an open follows the last link, and a write by temporary file and
 *   rename replaces the entry. It is refused when either is protected.
 *
 * A protected root is held in both forms too, so neither a link standing at a protected name
 * nor what it leads to is free.
 *
 * Only "not there yet" is an answer. Any other error resolving either side (no permission,
 * a loop of links, a component that is a file) cannot be shown to be free, so the path is
 * reported as protected: `path` itself is returned.
 *
 * This is a decision-time check on names. It is not an operating-system boundary: the files
 * can change between this check and the agent's open, which is ADR 0009's to answer.
 */
export function protectedPathFor(
  path: string,
  access: "read" | "write" | "remove",
  protectedPaths: ProtectedPaths | undefined,
  workspaceCwd?: string,
): string | undefined {
  if (!protectedPaths) return undefined;
  if (!isAbsolute(path) && !workspaceCwd) return undefined;
  // Joined as text, not with `join`: that would fold `sub/..` lexically before the links in it are followed.
  const full = isAbsolute(path) ? path : `${workspaceCwd}${sep}${path}`;
  try {
    const targets =
      access === "read"
        ? [pathSegments(physicalPath(full))]
        : access === "remove"
          ? [pathSegments(entryPath(full))]
          : [pathSegments(physicalPath(full)), pathSegments(entryPath(full))];
    const forms = (root: string) => [pathSegments(physicalPath(root)), pathSegments(entryPath(root))];
    const covers = (guard: readonly string[], target: readonly string[]) =>
      within(target, guard) || (access === "remove" && within(guard, target));
    const unreadable = protectedPaths.noAccess.find((root) =>
      forms(root).some((guard) => targets.some((target) => covers(guard, target))),
    );
    if (unreadable !== undefined || access === "read") return unreadable;
    const areas = (protectedPaths.agentAreas ?? []).map((area) => pathSegments(entryPath(area)));
    return protectedPaths.readOnly.find((root) =>
      forms(root).some((guard) =>
        targets.some(
          (target) =>
            covers(guard, target) &&
            // An area exempts its enclosing store, never an explicit authority path inside it.
            // Config/sidecar paths may themselves live (or resolve through a link) under work/.
            !areas.some((area) => guard.length < area.length && within(area, guard) && within(target, area)),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof UnresolvablePathError) return path;
    throw error;
  }
}

/**
 * Whether the existing directory `dir` is the existing directory `root` or below it, both
 * resolved by the file system. False on any doubt: either missing, either not a directory, or
 * any error resolving them. Unlike `protectedPathFor`, where "cannot tell" means protected,
 * "cannot tell" here must mean no, because a yes grants something (a cwd inside the workspace).
 * No prospective-file resolution: a directory that does not exist is not inside anything.
 */
export function existingDirectoryWithin(dir: string, root: string): boolean {
  try {
    const [d, r] = [realpathSync.native(dir), realpathSync.native(root)];
    if (!statSync(d).isDirectory() || !statSync(r).isDirectory()) return false;
    return within(pathSegments(d), pathSegments(r));
  } catch {
    return false;
  }
}

/** Whether `inner` is `outer` or below it, segment by segment. */
function within(inner: readonly string[], outer: readonly string[]): boolean {
  return outer.length <= inner.length && outer.every((segment, i) => segment === inner[i]);
}

/**
 * The first location of a tool call that touches a protected path in a way its kind could.
 * `read` and `search` only look; every other kind — `execute` and `other` included — may
 * change what it touches, so it is held to the stricter list.
 */
function protectedLocation(
  request: acp.RequestPermissionRequest,
  ctx: PermissionEvalContext | undefined,
): string | undefined {
  if (!ctx?.protectedPaths) return undefined;
  const kind = request.toolCall.kind ?? "other";
  const access =
    kind === "read" || kind === "search" ? "read" : kind === "delete" || kind === "move" ? "remove" : "write";
  return (request.toolCall.locations ?? [])
    .map((l) => l.path)
    .find((p) => protectedPathFor(p, access, ctx.protectedPaths, ctx.workspaceCwd) !== undefined);
}

/**
 * `path` as the local file system resolves it, links followed (dangling ones included) and the
 * part that does not exist yet appended (#703). Undefined when it cannot be resolved for any
 * reason but absence: no permission, a loop of links, a component that is not a directory.
 */
export function physicalPathOf(path: string): string | undefined {
  try {
    return physicalPath(path);
  } catch (error) {
    if (error instanceof UnresolvablePathError) return undefined;
    throw error;
  }
}

/** How many links `physicalPath` follows before giving up, as the kernel's `ELOOP` does. */
const MAX_LINK_HOPS = 40;

/** A path that could not be resolved for a reason other than "not there yet". */
class UnresolvablePathError extends Error {}

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/**
 * `path` as the file system resolves it. The part that does not exist yet — a file about to be
 * created — is appended to the deepest ancestor that does, which is what an open of it reaches.
 *
 * A link whose target does not exist yet is followed too (#706, B05): `realpath` fails on it,
 * but an open that creates a file follows it and creates the target. Taking the link's own name
 * as "a file about to be created" would let a write through `work/innocent.json ->
 * ../orca.permissions.json` create the sidecar while being judged a write inside the workspace.
 *
 * Throws `UnresolvablePathError` for anything but absence: no permission, too many links, a
 * component that is not a directory.
 */
function physicalPath(path: string, hops = 0): string {
  const missing: string[] = [];
  for (let head = path; ;) {
    try {
      return join(realpathSync.native(head), ...missing);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw new UnresolvablePathError(head, { cause: error });
      const link = linkTarget(head);
      if (link !== undefined) {
        if (hops >= MAX_LINK_HOPS) throw new UnresolvablePathError(head);
        // Joined as text, like the caller's path: the target's own `..` is resolved physically.
        const target = isAbsolute(link) ? link : `${dirname(head)}${sep}${link}`;
        return physicalPath(missing.length === 0 ? target : `${target}${sep}${missing.join(sep)}`, hops + 1);
      }
      const parent = dirname(head);
      if (parent === head) return join(head, ...missing);
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * The directory entry `path` names: its directory resolved, its last name kept as written.
 * A last name of `.` or `..` names no entry of its own, so the whole path is resolved.
 */
function entryPath(path: string): string {
  const name = basename(path);
  const parent = dirname(path);
  if (name === "" || name === "." || name === ".." || parent === path) return physicalPath(path);
  return join(physicalPath(parent), name);
}

/** Where the link at `path` points, or undefined when there is no link there. */
function linkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "EINVAL") return undefined;
    throw new UnresolvablePathError(path, { cause: error });
  }
}

/** Windows and macOS file systems ignore case by default, so a comparison has to as well. */
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

function pathSegments(path: string): string[] {
  return (FOLD_CASE ? path.toLowerCase() : path).split(sep === "\\" ? /[\\/]+/ : /\/+/).filter((s) => s !== "");
}

/* -------------------------------------------------------------------------- *
 * The sidecar
 * -------------------------------------------------------------------------- */

const EMPTY_POLICY_FILE: PermissionPolicyFile = { version: 1, agents: {} };

/** Where the workspace sidecar lives: beside `orca.config.yaml`, in the config directory. */
export function permissionPolicyPath(configDir: string): string {
  return join(configDir, PERMISSION_POLICY_FILENAME);
}

/**
 * Read a sidecar. A file that is not there is an empty policy — nobody has answered
 * "always" yet. A file that is there and unreadable is `CONFIG_INVALID`, not an empty
 * policy: silently ignoring a corrupt permissions file would quietly widen what an agent
 * may do, and this is the one file where that is never an acceptable failure mode.
 */
export async function readPermissionPolicyFile(file: string): Promise<PermissionPolicyFile> {
  return (await readPermissionPolicyFileRevision(file)).doc;
}

/**
 * `readPermissionPolicyFile` with the sha256 of the very bytes it parsed (#702), the same
 * revision `revisionOf` gives, so a decision can name the file version its rule came from
 * without a second read that could see a later write. A missing file's revision is "".
 */
export async function readPermissionPolicyFileRevision(
  file: string,
): Promise<{ doc: PermissionPolicyFile; revision: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { doc: { ...EMPTY_POLICY_FILE }, revision: "" };
    throw e;
  }
  const revision = createHash("sha256").update(bytes).digest("hex");
  return { doc: parsePolicyFileText(file, bytes.toString("utf8")), revision };
}

function parsePolicyFileText(file: string, text: string): PermissionPolicyFile {
  if (text.trim() === "") return { ...EMPTY_POLICY_FILE };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new OrcaError("CONFIG_INVALID", `${file}: ${(e as Error).message}`, {}, { cause: e });
  }
  const parsed = PermissionPolicyFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new OrcaError("CONFIG_INVALID", `${file}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/**
 * The rules a sidecar contributes for one agent, in file order, without their provenance —
 * less any wildcard `allow` (`isWildcardPermissionRule` in `@orca/core`), which is reported
 * to `onIgnored` and never evaluated. ORCA only ever writes scoped grants, and a wildcard in
 * this file is how an agent that reached it would allow itself everything (C4-01); a person
 * who means one writes it in the config. A rule whose `expiresAt` has passed at `now` is
 * left out too (#702).
 */
export function permissionOverlayFor(
  doc: PermissionPolicyFile,
  agentId: string,
  onIgnored?: (rule: PermissionRule) => void,
  now: number = Date.now(),
): PermissionRule[] {
  return permissionOverlayEntries(doc, agentId, onIgnored, now).map((e) => e.rule);
}

/** `permissionOverlayFor`'s rules with each one's index in the file's list for the agent (#702). */
function permissionOverlayEntries(
  doc: PermissionPolicyFile,
  agentId: string,
  onIgnored?: (rule: PermissionRule) => void,
  now: number = Date.now(),
): { rule: PermissionRule; index: number }[] {
  const rules: { rule: PermissionRule; index: number }[] = [];
  for (const [index, r] of (doc.agents[agentId]?.rules ?? []).entries()) {
    // A saved judged rule is not a typed rule (#701): `sidecarJudgedRules` carries it apart.
    if (isSidecarJudgedRule(r)) continue;
    // A rule whose lifetime has run out decides nothing (#702). It is not reported as
    // ignored: it was a scoped grant that ended, not a wildcard somebody slipped in.
    if (permissionRuleExpired(r, now)) continue;
    const rule: PermissionRule = { match: { ...r.match }, decision: r.decision };
    if (isWildcardPermissionRule(rule)) onIgnored?.(rule);
    else rules.push({ rule, index });
  }
  return rules;
}

/**
 * The judged rules a sidecar holds for one agent (#701), in file order, less any whose lifetime
 * has run out at `now`. Each is named `sidecar:N` by its index in the agent's list as written,
 * expired and typed entries counted, so the id names the entry a person sees in the file; a
 * second sidecar's are `sidecar.F:N`. A typed rule's id is its place too: an edit or a removal
 * above it renames it, and the judged lane's re-check then refuses an allow judged against the
 * old name (`changed-since`) rather than crediting another rule.
 */
export function sidecarJudgedRules(
  doc: PermissionPolicyFile,
  agentId: string,
  fileIndex = 0,
  now: number = Date.now(),
): JudgedPolicyRule[] {
  const out: JudgedPolicyRule[] = [];
  for (const [index, r] of (doc.agents[agentId]?.rules ?? []).entries()) {
    if (!isSidecarJudgedRule(r) || permissionRuleExpired(r, now)) continue;
    out.push(
      judgedPolicyRule(
        { match: r.match, judge: { criterion: r.judge.criterion } },
        fileIndex === 0 ? `sidecar:${index}` : `sidecar.${fileIndex}:${index}`,
      ),
    );
  }
  return out;
}

/**
 * The policy to evaluate for an agent: its configured rules first, then each sidecar in the
 * order given, then `DEFAULT_PERMISSION_POLICY`'s rules last — if they apply. Today `files`
 * is one entry, the workspace sidecar. A user-scoped file layers *under* it by being passed
 * after it; nothing else about this has to change.
 *
 * The ordering and the "if they apply" are both `effectivePermissionPolicy`'s in `@orca/core`,
 * not this function's, which only adds the file reading. This is the one production path to
 * an evaluated policy: `acp-session.ts` calls it per ask (#271), with no files when nothing
 * wired a sidecar, so "no sidecar" is the same code reaching the same answer rather than a
 * second evaluation that has to be kept in step with this one.
 *
 * A file that is missing contributes nothing, so a workspace where nobody has ever answered
 * "always" evaluates exactly as it did before this existed.
 *
 * `onUnreadable` decides what a *corrupt* sidecar means to the caller, and the two answers
 * are both right in their place. Omit it and the `CONFIG_INVALID` propagates, which is what
 * a caller reading the file to show or edit it wants. Pass one — `openAcpSession` does — and
 * the file is skipped and reported instead: a live agent asking for permission must not be
 * taken down by a sidecar somebody hand-edited badly.
 *
 * Skipping alone is not the conservative direction, though this comment used to say it was.
 * A sidecar holds `deny` and `ask` rules too — `reject_always` writes one — and the layers
 * after it were written on the assumption that it was read first: drop it and a recorded
 * `deny` on an in-workspace edit falls through to the default `allow` (ADR 0009). So once a
 * file cannot be read, every `allow` decided *after* it — a later sidecar's, a default rule's,
 * the fallthrough's — becomes `ask`. The configured rules ahead of it decide as before, except
 * that the file might have held a command restriction, so the policy is marked
 * `commandsRestricted` and no `execute` or unclassified call is allowed at all (#702 review).
 * What the unreadable file might have said is put to a person rather than assumed, so what is
 * lost is grants and never a restriction.
 *
 * `onIgnored` hears each wildcard `allow` that `permissionOverlayFor` dropped from a sidecar
 * that could be read.
 */
export async function loadEffectivePermissionPolicy(
  agent: { id: string; permissions: ConfiguredPermissionPolicy },
  files: readonly string[],
  onUnreadable?: (file: string, error: unknown) => void,
  onIgnored?: (file: string, rule: PermissionRule) => void,
  /** The clock rule lifetimes are judged against (#702); injectable for tests. */
  now: () => number = Date.now,
): Promise<PermissionPolicy> {
  const overlays: PermissionRule[][] = [];
  // Where each rule came from, in evaluation order (#702): config, each sidecar, defaults.
  // Config indexes count every rule as written, judged ones included, so `config:N` names the
  // Nth entry a person sees; judged rules are carried apart from the typed ones (#702).
  const origins: PermissionRuleOrigin[] = [];
  const judged: JudgedPolicyRule[] = [];
  agent.permissions.rules.forEach((rule, index) => {
    if (isJudgedPermissionRule(rule)) judged.push(judgedPolicyRule(rule, `config:${index}`));
    else origins.push({ layer: "config", index });
  });
  const typedConfigured = origins.length;
  /** How many rules come before the first sidecar that could not be read. */
  let readable: number | undefined;
  for (const [fileIndex, file] of files.entries()) {
    try {
      const { doc, revision } = await readPermissionPolicyFileRevision(file);
      const entries = permissionOverlayEntries(
        doc,
        agent.id,
        onIgnored ? (rule) => onIgnored(file, rule) : undefined,
        now(),
      );
      overlays.push(entries.map((e) => e.rule));
      for (const e of entries) origins.push({ layer: "sidecar", index: e.index, file: fileIndex, revision });
      // Saved judged rules come after every hand-written one (#701 design, decided 2026-11-23).
      judged.push(...sidecarJudgedRules(doc, agent.id, fileIndex, now()));
    } catch (e) {
      if (!onUnreadable) throw e;
      onUnreadable(file, e);
      readable ??= overlays.reduce((n, overlay) => n + overlay.length, typedConfigured);
    }
  }
  const layered = effectivePermissionPolicy(agent.permissions, ...overlays);
  for (let index = 0; origins.length < layered.rules.length; index++) origins.push({ layer: "default", index });
  const policy: PermissionPolicy = { ...layered, origins, ...(judged.length ? { judged } : {}) };
  if (readable === undefined) return policy;
  const capFrom = readable;
  const cap = (decision: PermissionDecision): PermissionDecision => (decision === "allow" ? "ask" : decision);
  return {
    default: cap(policy.default),
    rules: policy.rules.map((rule, i) => (i < capFrom ? rule : { ...rule, decision: cap(rule.decision) })),
    origins: origins.map((origin, i) =>
      i >= capFrom && policy.rules[i]?.decision === "allow" ? { ...origin, capped: true } : origin,
    ),
    // Nor is any judged rule asked: the file might have held the deny or ask that closes the
    // judged lane, so `judged` is left out (#702).
    // The file might have held a command restriction (#702 review), so commands and
    // unclassified calls are treated as restricted: not even the rules ahead of it allow one.
    commandsRestricted: true,
  };
}

export interface RecordAlwaysOptions {
  /** The sidecar to append to; `permissionPolicyPath(configDir)` for the workspace one. */
  file: string;
  /** The agent whose policy is being added to. */
  agentId: string;
  /** The request that was answered. */
  request: acp.RequestPermissionRequest;
  /** `allow` for an `allow_always` answer, `deny` for `reject_always`. */
  decision: "allow" | "deny";
  /** Absolute path of the run's workspace. Without it, no path-scoped rule can be written. */
  workspaceCwd?: string | undefined;
  /**
   * When the written rule stops deciding (#702), as an ISO-8601 instant. Absent: it stands
   * until somebody removes it, which is what "always" meant before rules had lifetimes.
   */
  expiresAt?: string | undefined;
  /**
   * Write these rules instead of deriving them from the request: a wider `command` rule the
   * person chose in the review (#702). The caller has already shown exactly these.
   */
  rules?: readonly PermissionRule[] | undefined;
  /** Injectable clock, for tests. */
  now?: (() => Date) | undefined;
  /** Lock tuning; the defaults are fine. */
  lock?: { timeoutMs?: number; staleMs?: number } | undefined;
}

/**
 * What the caller tells the person. `#160`'s `inputs.answer` result says which rules were
 * added and where, so `#161`'s button can promise it honestly — including promising nothing
 * when `refused` is set and the answer could only be honoured once.
 */
export interface RecordAlwaysResult {
  file: string;
  agentId: string;
  /** The rules this answer implies: appended now, or already there from a previous answer. */
  rules: PermissionRule[];
  /**
   * The subset this call wrote: appended, or an equivalent rule already in the file whose
   * lifetime this answer extended (an expired one, or one ending sooner than this answer's).
   */
  added: PermissionRule[];
  /** The subset already recorded for at least as long, so the file was not rewritten for them. */
  alreadyPresent: PermissionRule[];
  /** Set when nothing could be derived. The caller must fall back to allowing this one call. */
  refused?: { reason: PermissionDeriveRefusal; detail: string };
}

/**
 * Append the rules an "always" answer justifies, and say what was written.
 *
 * The derivation — what generalises and what this refuses to generalise — is
 * `derivePermissionRules` in `@orca/core`. Everything here is the file: read, append,
 * rewrite, under a lock, so that two runs answering "always" at the same moment both land
 * instead of the second silently overwriting the first.
 */
export async function recordAlwaysDecision(opts: RecordAlwaysOptions): Promise<RecordAlwaysResult> {
  const tc = opts.request.toolCall;
  // An MCP tool the agent claims but ORCA cannot verify is never granted standing (#1021),
  // whichever way the rules arrive: derived here, or handed in already chosen.
  const mcpClaim = mcpToolClaimOf(tc);
  const unverified =
    mcpClaim !== undefined && opts.decision === "allow" ? derivePermissionRules({ mcpClaim }, "allow") : undefined;
  const derived: ReturnType<typeof derivePermissionRules> =
    unverified ??
    (opts.rules
      ? { ok: true, rules: opts.rules.map((rule) => ({ match: { ...rule.match }, decision: opts.decision })) }
      : derivePermissionRules(
          {
            kind: tc.kind,
            title: tc.title,
            // A standing deny for a claimed MCP tool names it as `server: tool` (#1021).
            mcpClaim,
            paths: (tc.locations ?? []).map((l) => l.path),
            command: tc.kind === "execute" ? commandTextOf(tc) : undefined,
            workspaceCwd: opts.workspaceCwd,
          },
          opts.decision,
        ));
  if (!derived.ok)
    return {
      file: opts.file,
      agentId: opts.agentId,
      rules: [],
      added: [],
      alreadyPresent: [],
      refused: { reason: derived.reason, detail: derived.detail },
    };

  const at = opts.now?.() ?? new Date();
  const addedAt = at.toISOString();
  const expiresAt = opts.expiresAt;
  if (expiresAt !== undefined && !(Date.parse(expiresAt) > at.getTime()))
    throw new OrcaError("CONFIG_INVALID", `a standing rule cannot expire at ${expiresAt}: that is not after now`);
  const grantedFor = (tc.title ?? "").trim();
  /** How long a rule lasts, for "does this answer outlast the one on file". */
  const until = (rule: SidecarPermissionRule): number =>
    rule.expiresAt === undefined ? Infinity : Date.parse(rule.expiresAt);
  const wanted = expiresAt === undefined ? Infinity : Date.parse(expiresAt);
  return withPolicyLock(opts.file, opts.lock, async (checkOwnership) => {
    const { doc, revision } = await readPermissionPolicyFileRevision(opts.file);
    const rules: SidecarPermissionRule[] = [...(doc.agents[opts.agentId]?.rules ?? [])];
    const added: PermissionRule[] = [];
    const alreadyPresent: PermissionRule[] = [];
    const recorded = (rule: PermissionRule): RecordedPermissionRule => ({
      ...rule,
      addedAt,
      ...(grantedFor === "" ? {} : { grantedFor }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    for (const rule of derived.rules) {
      const same = rules.flatMap((r, index) => (!isSidecarJudgedRule(r) && samePermissionRule(r, rule) ? [index] : []));
      if (same.some((index) => until(rules[index]!) >= wanted)) alreadyPresent.push(rule);
      else if (same.length > 0) {
        // The grant is on file but ends sooner (or has ended): this answer extends it in place
        // rather than appending a twin, so the file keeps one line per grant.
        rules[same[0]!] = recorded(rule);
        added.push(rule);
      } else {
        rules.push(recorded(rule));
        added.push(rule);
      }
    }
    if (added.length > 0)
      await writePolicyFile(
        opts.file,
        { ...doc, agents: { ...doc.agents, [opts.agentId]: { rules } } },
        { revision, checkOwnership },
      );
    return { file: opts.file, agentId: opts.agentId, rules: derived.rules, added, alreadyPresent };
  });
}

export interface SaveJudgedRuleOptions {
  /** The sidecar to save to; `permissionPolicyPath(configDir)` for the workspace one. */
  file: string;
  /** The agent whose policy the rule joins. */
  agentId: string;
  /** The deterministic gate. It must name a kind in `SAVED_JUDGED_KINDS`, and no command. */
  match: PermissionRule["match"];
  /** The plain-language criterion a judge applies to calls the match holds for. */
  criterion: string;
  /** When the rule stops deciding, as an ISO-8601 instant after now. Absent: until removed. */
  expiresAt?: string | undefined;
  /** The caller's current authority, checked under the lock and again just before the write. */
  authorize?: (() => Promise<void>) | undefined;
  /** Injectable clock, for tests. */
  now?: (() => Date) | undefined;
  /** Lock tuning; the defaults are fine. */
  lock?: { timeoutMs?: number; staleMs?: number } | undefined;
}

export interface SaveJudgedRuleResult {
  file: string;
  agentId: string;
  /** The rule's id as the judged lane names it, `sidecar:N`. */
  ruleId: string;
  /**
   * `added`: appended. `extended`: the same rule was on file and ended sooner (or had ended),
   * so its lifetime was moved out in place. `already-present`: on file for at least as long;
   * nothing was written.
   */
  outcome: "added" | "extended" | "already-present";
  /** The rule as it is now on file. */
  rule: SidecarJudgedPermissionRule;
}

/**
 * Save one plain-language rule a person wrote or accepted (#701, `plain-language-rules.md`
 * section 2): the app's save method for judged rules. It lands in the sidecar, after every
 * hand-written rule, and the file becomes version 4 (`PERMISSION_JUDGED_VERSION`), which every
 * earlier reader refuses rather than reading the rule as a plain allow.
 *
 * Only what the judged lane could ever use is accepted: a kind from `SAVED_JUDGED_KINDS`, no
 * command, paths written relative to the workspace (ADR 0009) and a bounded title pattern that
 * compiles, so a saved rule can never be a match-everything rule or name a file outside the
 * workspace. The checks are `SidecarJudgedPermissionRuleSchema`'s, so a whole-file
 * `config.set` and the loader refuse the same rows. A saved rule allows nothing
 * by itself: the lane asks a judge only when a session was given one, only after the typed
 * rules answered `ask`, and only inside its hard boundaries.
 *
 * The same rule (same match, same criterion) is never appended twice: one already on file for
 * at least as long is reported `already-present`, and one ending sooner is extended in place,
 * as `recordAlwaysDecision` does for a typed grant. Everything happens under the sidecar's
 * `link()` lock, so a save racing an "always" answer or a Config-surface edit loses neither.
 */
export async function saveJudgedRule(opts: SaveJudgedRuleOptions): Promise<SaveJudgedRuleResult> {
  const at = opts.now?.() ?? new Date();
  const expiresAt = opts.expiresAt;
  if (expiresAt !== undefined && !(Date.parse(expiresAt) > at.getTime()))
    throw new OrcaError("CONFIG_INVALID", `a saved rule cannot expire at ${expiresAt}: that is not after now`);
  const parsed = SidecarJudgedPermissionRuleSchema.safeParse({
    match: opts.match,
    judge: { criterion: opts.criterion },
    addedAt: at.toISOString(),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  if (!parsed.success)
    throw new OrcaError("CONFIG_INVALID", parsed.error.issues[0]?.message ?? "invalid judged rule", {
      issues: parsed.error.issues,
    });
  const rule = parsed.data;
  const until = (r: { expiresAt?: string | undefined }): number =>
    r.expiresAt === undefined ? Infinity : Date.parse(r.expiresAt);
  const wanted = until(rule);
  return withPolicyLock(opts.file, opts.lock, async (checkOwnership) => {
    await opts.authorize?.();
    const { doc, revision } = await readPermissionPolicyFileRevision(opts.file);
    const rules: SidecarPermissionRule[] = [...(doc.agents[opts.agentId]?.rules ?? [])];
    const same = rules.flatMap((r, index) => (isSidecarJudgedRule(r) && sameJudgedRule(r, rule) ? [index] : []));
    const kept = same.find((index) => until(rules[index]!) >= wanted);
    const result = (index: number, outcome: SaveJudgedRuleResult["outcome"]): SaveJudgedRuleResult => ({
      file: opts.file,
      agentId: opts.agentId,
      ruleId: `sidecar:${index}`,
      outcome,
      rule: rules[index] as SidecarJudgedPermissionRule,
    });
    if (kept !== undefined) return result(kept, "already-present");
    let index: number;
    let outcome: SaveJudgedRuleResult["outcome"];
    if (same.length > 0) {
      index = same[0]!;
      rules[index] = rule;
      outcome = "extended";
    } else {
      index = rules.push(rule) - 1;
      outcome = "added";
    }
    await writePolicyFile(
      opts.file,
      { ...doc, agents: { ...doc.agents, [opts.agentId]: { rules } } },
      { revision, checkOwnership, authorize: opts.authorize },
    );
    return result(index, outcome);
  });
}

/** The same saved judged rule: the same match and the same criterion, provenance aside. */
function sameJudgedRule(a: SidecarJudgedPermissionRule, b: SidecarJudgedPermissionRule): boolean {
  return (
    a.judge.criterion === b.judge.criterion &&
    samePermissionRule({ match: a.match, decision: "allow" }, { match: b.match, decision: "allow" })
  );
}

/**
 * Replace a sidecar wholesale, under the same lock `recordAlwaysDecision` takes.
 *
 * This is the operator's half of ADR 0009: `config.set` on the `permissions` document
 * (#266) edits or removes a grant a machine wrote. It goes through here rather than through
 * a second writer in the daemon for one reason worth being blunt about - a `link()` lock is
 * only a lock if *every* writer takes it. A daemon that opened the file itself would be a
 * second path with its own tmp name and its own idea of atomicity, and the case it would
 * lose is exactly the one #266 asks to be tested: a run answering "always" at the moment an
 * operator saves an edit.
 *
 * The document is validated with `WritablePermissionPolicyFileSchema`, which refuses a
 * `default`, and serialised with the same fixed key order a machine write uses, so an
 * operator's save and ORCA's own append produce the same shape of diff.
 *
 * It is a replace and not a merge. The caller read a revision, edited it and sends the whole
 * document back; deciding here which of two concurrent versions of a rule list was meant is
 * a guess, and refusing it as stale is the honest answer.
 *
 * Which is why `expectedRevision` is checked **here**, inside the lock, and not by the
 * caller. A daemon that compared revisions and then called this had a window between the two
 * exactly wide enough for a run answering "always" to append a grant, and the replace then
 * dropped it - the one case #266 names and the one this lock exists to prevent. It is the
 * sha256 hex of the file's current bytes, `""` for a file that is not there; omit it and the
 * replace is unconditional, which is what a caller with no revision to quote should do
 * deliberately rather than by default.
 */
export async function replacePermissionPolicyFile(
  file: string,
  doc: unknown,
  opts?: {
    lock?: { timeoutMs?: number; staleMs?: number } | undefined;
    /** sha256 hex of the bytes the caller's edit was based on; `""` for "there was no file". */
    expectedRevision?: string | undefined;
    /** Current caller authority, checked under the lock and immediately before replacement. */
    authorize?: (() => Promise<void>) | undefined;
  },
): Promise<PermissionPolicyFile> {
  const parsed = parsePermissionPolicyDocument(doc);
  const expected = opts?.expectedRevision;
  await withPolicyLock(file, opts?.lock, async (checkOwnership) => {
    await opts?.authorize?.();
    const actual = await revisionOf(file);
    if (expected !== undefined) {
      if (actual !== expected)
        throw new OrcaError(
          "CONFIG_STALE",
          `${file} has changed since you read it: write again against the current revision`,
          { file, expectedRevision: expected, actualRevision: actual },
        );
    }
    await refuseUnsupportedPolicyReplacement(file);
    await writePolicyFile(file, parsed, { revision: actual, checkOwnership, authorize: opts?.authorize });
  });
  return parsed;
}

/**
 * Input validation alone does not protect a newer document: a legacy client can send a
 * valid v1 replacement for bytes it cannot interpret. Refuse explicit incompatible
 * versions under the shared lock, even for an unconditional replacement. Keep the
 * existing operator repair path for malformed/empty legacy documents.
 *
 * This protects only binaries containing this guard. Earlier replacements never read
 * the current version; adding this check cannot make those binaries safe to downgrade.
 */
async function refuseUnsupportedPolicyReplacement(file: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return;
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    "version" in raw &&
    raw.version !== 1 &&
    raw.version !== PERMISSION_LIFETIME_VERSION &&
    raw.version !== PERMISSION_JUDGED_VERSION
  )
    throw new OrcaError("CONFIG_INVALID", `${file}: refusing to replace an unsupported permission document version`);
}

/**
 * Validate a sidecar document a client sent, refusing a `default`. Exported beside the
 * writer so a `validateOnly` call can ask the same question without taking the lock.
 */
export function parsePermissionPolicyDocument(doc: unknown): PermissionPolicyFile {
  const parsed = WritablePermissionPolicyFileSchema.safeParse(doc ?? {});
  if (!parsed.success)
    throw new OrcaError("CONFIG_INVALID", parsed.error.issues[0]?.message ?? "invalid permission document", {
      issues: parsed.error.issues,
    });
  const { default: _refused, ...rest } = parsed.data;
  return rest;
}

/* ----------------------------- file mechanics ----------------------------- */

/** Keys in a fixed order and `undefined` omitted, so a rewrite produces a minimal diff. */
function serialize(doc: PermissionPolicyFile): string {
  const rule = (r: SidecarPermissionRule): Record<string, unknown> => {
    const match: Record<string, unknown> = {};
    for (const key of ["kind", "titlePattern", "path", "pathPrefix", "scope", "command"] as const)
      if (r.match[key] !== undefined) match[key] = r.match[key];
    if (isSidecarJudgedRule(r)) {
      // A saved judged rule (#701): its criterion in place of a decision.
      const out: Record<string, unknown> = { match, judge: { criterion: r.judge.criterion } };
      if (r.addedAt !== undefined) out["addedAt"] = r.addedAt;
      if (r.expiresAt !== undefined) out["expiresAt"] = r.expiresAt;
      return out;
    }
    const out: Record<string, unknown> = { match, decision: r.decision };
    if (r.addedAt !== undefined) out["addedAt"] = r.addedAt;
    if (r.grantedFor !== undefined) out["grantedFor"] = r.grantedFor;
    if (r.expiresAt !== undefined) out["expiresAt"] = r.expiresAt;
    return out;
  };
  const agents: Record<string, unknown> = {};
  for (const id of Object.keys(doc.agents).sort()) agents[id] = { rules: (doc.agents[id]?.rules ?? []).map(rule) };
  // The version follows the content, never the input (#702): any lifetime moves the file to
  // the version released 0.7.x readers refuse, any judged rule to version 4 (#701), and
  // removing the last one moves it back.
  return `${JSON.stringify({ version: permissionPolicyFileVersion(doc), agents }, null, 2)}\n`;
}

/**
 * Write a sidecar, as every writer does. At commit, just before the rename, the writer must
 * still hold the lock it read under and the file must still be the bytes it read (`revision`,
 * `""` for no file), so a writer paused past the lock's staleness cannot overwrite a later
 * edit, grant or removal made by whoever took the lock over (#701 review). Then the caller's
 * authority is checked again.
 */
async function writePolicyFile(
  file: string,
  doc: PermissionPolicyFile,
  commit: {
    revision: string;
    checkOwnership: () => Promise<void>;
    authorize?: (() => Promise<void>) | undefined;
  },
): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, serialize(doc), "utf8");
    await commit.checkOwnership();
    const now = await revisionOf(file);
    if (now !== commit.revision)
      throw new OrcaError("CONFIG_STALE", `${file} changed under this write; nothing was written`, {
        file,
        expectedRevision: commit.revision,
        actualRevision: now,
      });
    await commit.authorize?.();
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}
