/**
 * The permission sidecar's arithmetic: the bytes in, one agent's editable rules out, and
 * the bytes back again (#176).
 *
 * It is a plain module beside `config-model.ts` for the same reason that one is: what is
 * most likely to be wrong when a grant is edited is not the markup but the document — which
 * rule is which after a removal, whether an untouched row kept its provenance, and whether
 * the bytes that go back are a document the daemon will take.
 *
 * Six decisions worth knowing before changing anything here:
 *
 * - **A `default` is never written.** ADR 0009's central rule is that answering one prompt
 *   must not change the answer to every other one, so the sidecar has no fallthrough; the
 *   daemon *refuses* a document carrying one rather than stripping it. `serializeSidecar`
 *   writes `version` and `agents` and there is no branch here that could write a third key.
 * - **The key order is the daemon's writer's.** `@orca/agents` serialises with a fixed key
 *   order so a machine rewrite is a minimal diff, and it re-serialises whatever a client
 *   sends. Matching that order here is what keeps an edit's diff to the row that changed —
 *   but it is *not* how staleness is decided: `expectedRevision` is, and a client compares
 *   revisions rather than bytes precisely because the daemon may canonicalise them.
 * - **An untouched row is carried whole.** `addedAt` and `grantedFor` are the audit trail
 *   the file exists to keep, and a row nobody edited goes back exactly as it arrived,
 *   provenance included. That falls out of editing the parsed rules in place rather than
 *   rebuilding them from a form's fields.
 * - **A key this app does not know is carried, not dropped.** ADR 0009's document may grow
 *   a field before this panel learns about it, and a save that silently deleted one would
 *   turn an edit to row two into data loss in row five. An unrecognised key rides through
 *   `canonicalRule` after the known ones, so the round trip is lossless and the diff is
 *   still the row that changed. The one thing that is *not* carried is a document whose
 *   `version` is not 1: a shape this app cannot read is refused whole, the same way
 *   unparseable text is, rather than rewritten in a shape the writer guessed at.
 * - **A hand-added rule says it was added by hand.** It gets `addedAt` now and a
 *   `grantedFor` naming the app, because a reader of the diff is entitled to know which
 *   rules a run wrote in answer to a prompt and which a person typed. It starts narrow — one
 *   kind, inside the workspace — rather than matching everything, since a row that begins as
 *   "allow anything" is one Save away from being exactly that.
 * - **A draft is the edited agents' rules, never a copy of the file.** The daemon writes this
 *   file too — every "allow always" is a write — so a draft that held the whole document would
 *   carry a stale copy of every other agent's grants and put it back on Save. A draft holds
 *   the agents a person edited, each with the rules it began from (`GrantDraft`), and is
 *   written onto the file as it is when it is sent (`composeGrants`). Only a change on disk
 *   to an agent the person also edited is a conflict.
 */
import { PERMISSION_DECISIONS, type EffectivePermissionRule } from "@orca/protocol";

/** What a rule matches. The wire's own shape, minus the `source` the daemon tags it with. */
export type RuleMatch = EffectivePermissionRule["match"];
export type RuleDecision = EffectivePermissionRule["decision"];

/**
 * One rule as the sidecar holds it: a rule, plus the provenance ADR 0009 keeps beside it.
 *
 * The four keys here are the ones this app knows. A row read off the file may carry others
 * — a newer daemon's, a person's — and those stay on the object even though nothing here is
 * typed for them: the parsed row *is* the object the JSON produced, editing one spreads it,
 * and `canonicalRule` writes what it does not recognise back out.
 */
export interface SidecarRule {
  match: RuleMatch;
  decision: RuleDecision;
  addedAt?: string;
  grantedFor?: string;
  /** When the rule stops deciding (#702). Absent: until removed. */
  expiresAt?: string;
}

/**
 * Presentation only: mirrors `isWildcardPermissionRule` in core/src/model/agent.ts.
 * The renderer cannot import core (ADR 0008). Keep this projection aligned with that
 * predicate; the loader remains the authority. Do not reject or rewrite saved rows:
 * ignored allows may already exist, and deny/ask rules must never be labelled ignored.
 */
export function sidecarRuleWarning(rule: SidecarRule): string | undefined {
  if (rule.decision !== "allow") return undefined;
  const match = rule.match;
  if (match.command !== undefined)
    return /^\s*(?:sudo|doas|su|env|command|builtin|exec|eval|source|\.|xargs|nohup|time|nice|ionice|timeout|stdbuf|chroot|watch|parallel|script|unbuffer|sh|bash|zsh|dash|ksh|fish|csh|tcsh|busybox|pwsh|powershell|cmd|npx|pnpx|bunx|nix-shell|ssh)\s+\*\s*$/i.test(
      match.command,
    )
      ? "This sidecar allow is ignored by ORCA because it is a wildcard: a shell or wrapper followed by * runs any command. Name the command it may run instead."
      : undefined;
  let byTitle = false;
  if (match.titlePattern !== undefined) {
    try {
      const pattern = new RegExp(match.titlePattern);
      byTitle = !(pattern.test("") && pattern.test("\u0000"));
    } catch {
      // Core treats an invalid pattern as non-wildcard. Schema validation is separate.
      byTitle = true;
    }
  }
  const byPath = [match.path, match.pathPrefix].some((path) => path !== undefined && hasSidecarPath(path));
  const ignored =
    match.kind === undefined ||
    (match.kind === "execute" ? !byTitle : !byTitle && !byPath && match.scope !== "workspace");
  return ignored
    ? "This sidecar allow is ignored by ORCA because it is a wildcard. It must name a tool kind and narrow it by a path, path prefix, workspace scope or title pattern. Execute rules require a narrowing title pattern; paths and scope do not narrow commands. Saving keeps the rule but does not make it effective."
    : undefined;
}

/** Whether core's portable path normalization would leave a nonempty path. */
function hasSidecarPath(path: string): boolean {
  // Absolute, drive and UNC roots stay nonempty in normalizePermissionPath.
  if (path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)) return true;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.length > 0;
}

/** The sidecar document. No `default`, at any level — see the file header. */
export interface SidecarDocument {
  version: number;
  agents: Readonly<Record<string, { rules: readonly SidecarRule[] }>>;
}

/** What a rule a person typed here records as having been granted for. */
export const HAND_GRANT = "added by hand in the app";

/** The empty document, which is what a workspace with no sidecar has. */
export const EMPTY_SIDECAR: SidecarDocument = { version: 1, agents: {} };

/**
 * The sidecar the text holds, or `undefined` when it is not one.
 *
 * Empty text is the *empty document* rather than a failure: a workspace where nobody has
 * answered "always" has no sidecar at all, and `config.set` creates one. Text that does not
 * parse is undefined, which the editor renders as "this file cannot be edited here" instead
 * of guessing at a repair — the raw view on the Config surface is where a broken file is
 * fixed.
 *
 * "Does not parse" is a question about the *shape*, not only about the bytes. A `rules`
 * array whose rows are `null`, or carry no `match`, or name a decision the vocabulary does
 * not have, is a file this panel cannot edit: `describeRule` would throw on it and blank the
 * panel, which is a worse answer than the documented one. So each row is checked and one bad
 * row refuses the document. A `version` other than 1 or 3 is refused for the same reason — it
 * is a shape this app has not been taught, and rewriting it in a shape it knows would lose
 * whatever the new version added. Version 3 is version 1 plus rule lifetimes (#702); a
 * version 1 file carrying an `expiresAt` is refused, as the daemon's reader refuses it.
 */
export function parseSidecar(text: string): SidecarDocument | undefined {
  if (text.trim() === "") return EMPTY_SIDECAR;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const version = record["version"];
  if (version !== undefined && version !== 1 && version !== SIDECAR_LIFETIME_VERSION) return undefined;
  const agents = record["agents"];
  if (agents !== undefined && (typeof agents !== "object" || agents === null || Array.isArray(agents))) {
    return undefined;
  }
  const out: Record<string, { rules: readonly SidecarRule[] }> = {};
  for (const [id, entry] of Object.entries((agents ?? {}) as Record<string, unknown>)) {
    const rules = (entry as { rules?: unknown } | null)?.rules;
    if (!Array.isArray(rules)) return undefined;
    const checked: SidecarRule[] = [];
    for (const row of rules) {
      const rule = asRule(row);
      if (rule === undefined) return undefined;
      checked.push(rule);
    }
    out[id] = { rules: checked };
  }
  const v3 = Object.values(out).some((agent) => agent.rules.some(needsVersion3));
  if (v3 && version !== SIDECAR_LIFETIME_VERSION) return undefined;
  return { version: v3 ? SIDECAR_LIFETIME_VERSION : 1, agents: out };
}

/**
 * The version a sidecar with any timed rule carries: `PERMISSION_LIFETIME_VERSION` in
 * `@orca/core`, mirrored because the renderer cannot import core (ADR 0008).
 */
export const SIDECAR_LIFETIME_VERSION = 3;

/**
 * Whether a rule needs version 3: a lifetime, or a `command` match (#702). A release that
 * does not know `command` would drop it and keep `{kind: execute}`, which is every command.
 * Mirrors `permissionPolicyFileVersion` in core.
 */
function needsVersion3(rule: SidecarRule): boolean {
  return rule.expiresAt !== undefined || (rule.match as { command?: unknown }).command !== undefined;
}

/**
 * One row of `rules`, if it is one. The row is returned as it arrived — unknown keys and
 * all — because what this checks is that the panel can *render* it, not that the daemon
 * would take it: the daemon's own schema is the authority on that, and it sees the bytes.
 */
function asRule(value: unknown): SidecarRule | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const match = row["match"];
  if (typeof match !== "object" || match === null || Array.isArray(match)) return undefined;
  // Known match fields are optional strings. Refuse malformed hand edits before the
  // warning or form reads them; leave unknown keys intact for lossless round trips.
  const fields = match as Record<string, unknown>;
  for (const key of MATCH_KEYS) {
    if (fields[key] !== undefined && typeof fields[key] !== "string") return undefined;
  }
  const decision = row["decision"];
  if (typeof decision !== "string" || !(PERMISSION_DECISIONS as readonly string[]).includes(decision)) {
    return undefined;
  }
  return row as unknown as SidecarRule;
}

/** One agent's written rules, in the order the file holds them — which is evaluation order. */
export function rulesOf(doc: SidecarDocument, agentId: string): readonly SidecarRule[] {
  return doc.agents[agentId]?.rules ?? [];
}

/**
 * Each rule's name in the policy panel's list, in order: the key a grant row is drawn under,
 * and the name the panel's focus bookkeeping uses for it (`focusAfterLeaving`).
 *
 * **A rule is named by when it was added, not by where it is.** Removing a grant moves every
 * rule after it up one place, and a key that was the position — or carried it — would name
 * each of them anew: React would draw them all again, and the row that slid into the gap
 * would be one focus had never been in. `addedAt` is the provenance a run or the app stamped
 * on the rule, and nothing in the panel edits it, so it holds still while the rule's match
 * and decision are edited under it.
 *
 * Two rules can share a stamp, or have none — a sidecar somebody wrote by hand — so each is
 * also counted among the rules before it with the same stamp. Those few are named by their
 * order among themselves, which is what a position would have been, and nothing worse.
 */
export function grantKeys(rules: readonly SidecarRule[]): string[] {
  const seen = new Map<string, number>();
  return rules.map((rule) => {
    const stamp = rule.addedAt ?? "";
    const nth = seen.get(stamp) ?? 0;
    seen.set(stamp, nth + 1);
    return `${stamp}#${nth}`;
  });
}

/**
 * The document with one agent's rules replaced.
 *
 * An agent left with no rules loses its key rather than keeping an empty `rules: []`. The
 * two mean the same thing to `layerPermissionPolicies`, and the one that reads as "nothing
 * was ever granted to this agent" is the one with no entry — which is also the smaller diff.
 */
export function withRules(doc: SidecarDocument, agentId: string, rules: readonly SidecarRule[]): SidecarDocument {
  const agents: Record<string, { rules: readonly SidecarRule[] }> = { ...doc.agents };
  if (rules.length === 0) delete agents[agentId];
  else agents[agentId] = { rules };
  return { version: doc.version, agents };
}

/** The keys of a match, in the order `@orca/agents` writes them. */
const MATCH_KEYS: readonly string[] = ["kind", "titlePattern", "path", "pathPrefix", "scope", "command"];

/** The keys of a rule, in that same writer's order. */
const RULE_KEYS: readonly string[] = ["match", "decision", "addedAt", "grantedFor", "expiresAt"];

/**
 * One rule as it is written: the keys this app knows in the daemon's order, then any it
 * does not, in the order the file had them.
 *
 * It is one function rather than two because both callers have to agree. `serializeSidecar`
 * composes the bytes with it and `ruleChanges` compares rules with it, and when they
 * disagreed — raw `JSON.stringify` on one side, this projection on the other — a
 * hand-written sidecar whose keys were in a different order counted *every* row as changed
 * the moment one of them was edited, because no row's raw bytes matched its canonical form.
 * Canonicalising both sides is what makes "one edit" cost one.
 */
function canonicalRule(rule: SidecarRule): Record<string, unknown> {
  const raw = rule as unknown as Record<string, unknown>;
  const rawMatch = (rule.match ?? {}) as Record<string, unknown>;
  const match: Record<string, unknown> = {};
  for (const key of MATCH_KEYS) {
    const value = rawMatch[key];
    // `""` is the empty box a person left: the key goes, rather than being written empty.
    if (value !== undefined && value !== "") match[key] = value;
  }
  for (const key of Object.keys(rawMatch)) {
    if (!MATCH_KEYS.includes(key) && rawMatch[key] !== undefined) match[key] = rawMatch[key];
  }
  const out: Record<string, unknown> = { match, decision: rule.decision };
  if (rule.addedAt !== undefined) out["addedAt"] = rule.addedAt;
  if (rule.grantedFor !== undefined) out["grantedFor"] = rule.grantedFor;
  if (rule.expiresAt !== undefined) out["expiresAt"] = rule.expiresAt;
  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.includes(key) && raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

/**
 * The bytes, in the daemon's own key order and with `undefined` omitted.
 *
 * The order is `serialize()` in `packages/agents/src/permissions.ts`: `version` then
 * `agents` sorted by id, each rule `match` then `decision` then `addedAt` then `grantedFor`
 * then `expiresAt`,
 * and a match's own keys in the vocabulary's order. Two spaces and a trailing newline, the
 * same, so that a save that changed one row produces a one-row diff. A key neither this app
 * nor that writer knows is written after the ones they do, rather than dropped.
 */
export function serializeSidecar(doc: SidecarDocument): string {
  const agents: Record<string, unknown> = {};
  for (const id of Object.keys(doc.agents).sort()) {
    agents[id] = { rules: rulesOf(doc, id).map(canonicalRule) };
  }
  // `version` and `agents`, and never a third key: the sidecar carries no `default`. The
  // version follows the content, as the daemon's writer stamps it (#702).
  const v3 = Object.keys(doc.agents).some((id) => rulesOf(doc, id).some(needsVersion3));
  return `${JSON.stringify({ version: v3 ? SIDECAR_LIFETIME_VERSION : 1, agents }, null, 2)}\n`;
}

/** A rule a person adds here: narrow, and saying so in its own provenance. */
export function handRule(now: string): SidecarRule {
  return { match: { kind: "read", scope: "workspace" }, decision: "allow", addedAt: now, grantedFor: HAND_GRANT };
}

/**
 * How many rules a draft would change, over the whole document rather than over one agent.
 *
 * Over the whole document because the panel edits one agent at a time but sends the file
 * whole: a count of the agent in view would say "0 changes" over a draft that still holds an
 * edit to the agent looked at before it, and the bar would then offer to save nothing.
 *
 * Rules are matched by *identity* rather than by position, which is what makes the three
 * edits the panel offers each cost one: removing a rule is one gone, adding one is one new,
 * and editing one is a row gone and a row arrived, which is the same row changed. Comparing
 * by position would charge a removal for every row that shifted up behind it.
 *
 * Both sides go through `canonicalRule` on the way into the comparison, because one of them
 * is the file as a person wrote it and the other is the file as this app would write it. A
 * sidecar hand-edited with its keys in some other order is the same document; comparing it
 * raw against a canonicalised draft said every row had changed, over an edit to one.
 *
 * It follows that a pure *reordering* counts as no change at all — and order is evaluation
 * order, so that would be wrong if it could happen. It cannot: the editor offers no way to
 * move a rule. If one is ever added, this is the function that has to learn about it.
 */
export function ruleChanges(before: SidecarDocument, after: SidecarDocument): number {
  const ids = new Set([...Object.keys(before.agents), ...Object.keys(after.agents)]);
  let changes = 0;
  for (const id of ids) {
    // What the file had, struck off one by one as the draft accounts for it. Whatever is
    // left over is what went; whatever the draft could not account for is what arrived.
    const held = rulesOf(before, id).map((rule) => JSON.stringify(canonicalRule(rule)));
    let arrived = 0;
    for (const rule of rulesOf(after, id)) {
      const at = held.indexOf(JSON.stringify(canonicalRule(rule)));
      if (at === -1) arrived += 1;
      else held.splice(at, 1);
    }
    changes += Math.max(held.length, arrived);
  }
  return changes;
}

/** Whether two lists are the same rules in the same order: order is evaluation order. */
function sameRules(a: readonly SidecarRule[], b: readonly SidecarRule[]): boolean {
  return (
    a.length === b.length &&
    a.every((rule, at) => JSON.stringify(canonicalRule(rule)) === JSON.stringify(canonicalRule(b[at]!)))
  );
}

/**
 * One agent's grants as a draft holds them: what a person has made of the list, and the list
 * the file had for that agent when they began. `base` is what a conflict is measured from.
 */
export interface GrantDraft {
  readonly base: readonly SidecarRule[];
  readonly rules: readonly SidecarRule[];
}

/** The sidecar's draft: an entry for each agent with an edit, and nothing for the rest. */
export type GrantDrafts = Readonly<Record<string, GrantDraft>>;

const drafted = (agents: Record<string, GrantDraft>): GrantDrafts | undefined =>
  Object.keys(agents).length === 0 ? undefined : agents;

/**
 * The drafts with one agent's rules replaced. The agent's `base` is the file's rules for it at
 * its first edit and is kept after that; an agent whose rules are back to their base is not an
 * edit any more and leaves the draft, so a later edit begins again from the file.
 */
export function withGrantEdit(
  drafts: GrantDrafts | undefined,
  agentId: string,
  onDisk: readonly SidecarRule[],
  rules: readonly SidecarRule[],
): GrantDrafts | undefined {
  const agents: Record<string, GrantDraft> = { ...drafts };
  const base = agents[agentId]?.base ?? onDisk;
  if (sameRules(rules, base)) delete agents[agentId];
  else agents[agentId] = { base, rules };
  return drafted(agents);
}

/**
 * The drafts written onto the file as it is now: each edited agent's rules replaced, every
 * other agent's exactly as the file has them. This is the document Save sends and the one the
 * panel draws, so a grant the daemon wrote for another agent meanwhile is in both.
 *
 * `conflicts` names each edited agent whose rules on disk are neither the ones its edit began
 * from nor the ones it now holds: somebody else changed the same list, and writing over that
 * without saying so is the thing this function exists to prevent.
 */
export function composeGrants(
  onDisk: SidecarDocument,
  drafts: GrantDrafts,
): { document: SidecarDocument; conflicts: string[] } {
  let document = onDisk;
  const conflicts: string[] = [];
  for (const [agentId, { base, rules }] of Object.entries(drafts)) {
    const now = rulesOf(onDisk, agentId);
    if (!sameRules(now, base) && !sameRules(now, rules)) conflicts.push(agentId);
    document = withRules(document, agentId, rules);
  }
  return { document, conflicts };
}

/**
 * The drafts once a person has seen a conflict and pressed Reload: every edit kept, and each
 * agent's base moved to what the file now holds for it, so the Save after it writes them.
 */
export function rebaseGrants(drafts: GrantDrafts, onDisk: SidecarDocument): GrantDrafts | undefined {
  const agents: Record<string, GrantDraft> = {};
  for (const [agentId, { rules }] of Object.entries(drafts)) {
    const base = rulesOf(onDisk, agentId);
    if (!sameRules(rules, base)) agents[agentId] = { base, rules };
  }
  return drafted(agents);
}

/**
 * What is left of the drafts once `sent` has been written: only what was typed while the write
 * was out. An agent untouched since is in the file now and leaves the draft; one edited again
 * keeps its newer rules over a base that is what was written for it.
 */
export function grantsAfterWrite(current: GrantDrafts | undefined, sent: GrantDrafts): GrantDrafts | undefined {
  const agents: Record<string, GrantDraft> = {};
  for (const agentId of new Set([...Object.keys(sent), ...Object.keys(current ?? {})])) {
    const was = sent[agentId];
    const now = current?.[agentId];
    if (now !== undefined && now === was) continue;
    // The file holds what was sent for the agent, or what it had if the agent was not sent.
    const base = was?.rules ?? now!.base;
    // An agent edited back to its base while the write was out wants that base back.
    const rules = now?.rules ?? was!.base;
    if (!sameRules(rules, base)) agents[agentId] = { base, rules };
  }
  return drafted(agents);
}

/** A match with one key set, or removed when the value is empty. Never writes `""`. */
export function withMatch<K extends keyof RuleMatch>(match: RuleMatch, key: K, value: RuleMatch[K]): RuleMatch {
  const next: RuleMatch = { ...match };
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next;
}
