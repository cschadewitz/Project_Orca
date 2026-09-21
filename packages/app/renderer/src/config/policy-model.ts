/**
 * The permission sidecar's arithmetic: the bytes in, one agent's editable rules out, and
 * the bytes back again (#176).
 *
 * It is a plain module beside `config-model.ts` for the same reason that one is: what is
 * most likely to be wrong when a grant is edited is not the markup but the document — which
 * rule is which after a removal, whether an untouched row kept its provenance, and whether
 * the bytes that go back are a document the daemon will take.
 *
 * Four decisions worth knowing before changing anything here:
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
 * row refuses the document. A `version` other than 1 is refused for the same reason — it is
 * a shape this app has not been taught, and rewriting it in the only shape it knows would
 * lose whatever the new version added.
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
  if (version !== undefined && version !== 1) return undefined;
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
  return { version: 1, agents: out };
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
const MATCH_KEYS: readonly string[] = ["kind", "titlePattern", "path", "pathPrefix", "scope"];

/** The keys of a rule, in that same writer's order. */
const RULE_KEYS: readonly string[] = ["match", "decision", "addedAt", "grantedFor"];

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
  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.includes(key) && raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

/**
 * The bytes, in the daemon's own key order and with `undefined` omitted.
 *
 * The order is `serialize()` in `packages/agents/src/permissions.ts`: `version` then
 * `agents` sorted by id, each rule `match` then `decision` then `addedAt` then `grantedFor`,
 * and a match's own keys in the vocabulary's order. Two spaces and a trailing newline, the
 * same, so that a save that changed one row produces a one-row diff. A key neither this app
 * nor that writer knows is written after the ones they do, rather than dropped.
 */
export function serializeSidecar(doc: SidecarDocument): string {
  const agents: Record<string, unknown> = {};
  for (const id of Object.keys(doc.agents).sort()) {
    agents[id] = { rules: rulesOf(doc, id).map(canonicalRule) };
  }
  // `version` and `agents`, and never a third key: the sidecar carries no `default`.
  return `${JSON.stringify({ version: doc.version, agents }, null, 2)}\n`;
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

/** A match with one key set, or removed when the value is empty. Never writes `""`. */
export function withMatch<K extends keyof RuleMatch>(match: RuleMatch, key: K, value: RuleMatch[K]): RuleMatch {
  const next: RuleMatch = { ...match };
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next;
}
