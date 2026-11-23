# Plain-language permission rules, decided by a review judge (#701)

Status: **design for review (Cal) and owner decisions (Casey).** Only `judgePermission` (section 5)
is built, with fake judges, and nothing calls it yet.
Builds on: the live layered permission policy (`packages/agents/src/permissions.ts`), the
inactive judge adapters and connection (`packages/agents/src/review-judge/`), BYOK judge keys
(#964), and the typed command rules planned in #702.

## 1. What it is for

Today a person can only pre-approve what a typed rule can express: a tool kind, a path, a
scope, or a regular expression over the command text. Saved rules from a prompt are always
exact. Anything broader ("read-only git commands in this repo", "installing dev dependencies
with npm or pnpm", "running the test suite however the agent spells it") either needs a fragile
regex or gets asked about every time.

A **plain-language rule** is a sentence the person writes once. When an ask would otherwise go
to the person, a judge checks the request against the person's plain rules. If one rule clearly
covers it, ORCA answers **allow once** for them. Anything less than a clear match is the normal
prompt.

This is the first place a judge can **allow** rather than only make a decision stricter, so the
limits below are the core of the design.

## 2. Rule shape (agreed with the #702 thread)

A plain-language rule is an ordinary permission rule whose fixed `decision` is replaced by a
`judge` criterion:

```yaml
agents:
  - id: claude
    permissions:
      rules:
        - match: { kind: execute, scope: workspace }   # deterministic gate, kind required
          judge:
            criterion: "Read-only git commands (status, log, diff, show, branch listing)."
```

- `match` is the deterministic gate: the existing `kind`, `scope`, `path`, `pathPrefix`,
  `titlePattern` fields, plus #702's typed `command` match. A **saved** judged rule must name a
  `kind`, so the app can never write a match-everything judged rule. A hand-written one in the
  config may be wider, because only the config owner can write it. The judge can never apply it to a call its `match`
  does not cover.
- `criterion` is the methodology the judge applies.
- Each judged rule has a stable id and revision (derived from its content, like saved rules), so
  every decision can name exactly which sentence allowed it.
- Saved judged rules go in the sidecar under `agents.<agentId>.rules`, with the usual provenance
  and the same placement as typed rules. A sidecar holding a judged rule is format version 4,
  which older readers refuse instead of silently dropping the `judge` field and turning the rule
  into a plain allow. Hand-written ones go in the
  config. Both are ORCA-protected files, so an agent cannot write itself a rule.
- #702 owns the schema and the evaluation slot in `permissions.ts`. This thread owns the judge
  (`judgePermission`, section 5).

## 3. Where it sits in the decision

The order is unchanged: protected files → configured rules → sidecar rules → defaults, and the
first match wins. A judged rule takes part in that order like any other rule:

```
protected path?                        → deny            (no judge, ever)
first matching rule is typed           → its decision
first matching rule is judged          → judge: allow ──► allow once
                                                 no-match ──► continue to the next rule
no rule left                           → default (usually ask → person)
```

- The judge only ever answers **allow** or **no match**. It never denies, and it can't get past an
  earlier deny, because an earlier deny is the first match.
- An explicit typed `ask` rule placed before a judged rule wins through ordering. Saved judged
  rules land under the configured rules, so a hand-written "always ask me about `git push`"
  stays in force.
- **Decision for Casey:** may a saved judged rule ever sit *above* configured rules, for example
  by an explicit "put this first"? Recommendation: **no.** Saved rules, judged or not, always come
  after hand-written ones, as today.

**Shadowing.** Judged rules only allow, so when several cover a call the outcome is the same
(allow once). Only the credit differs, and the record lists every rule the batch judged covered,
not just the first. A broad judged rule placed *above* a typed `ask` or `deny` rule that it could
overlap would be reached first, so the app warns when saving a judged rule above such a rule (same
agent, overlapping `match`). If plain-language "ask" or "never" rules are added later, a
restriction will win over an allow regardless of order, instead of first match, so a broad allow
can never shadow a specific restriction.

## 4. The answer ORCA gives

- Only **allow once** (`allow_once`) from the options the agent itself offered. Never
  `allow_always`: that would let the agent's own permission cache remember the call and stop
  asking ORCA, so a later edit or deletion of the plain rule would not take effect. If the agent
  offers no `allow_once`, the ask goes to the person.
- ORCA never adds an option the agent didn't offer, so the agent's own sandbox and rules are never
  widened. A plain rule covers what the agent would have **asked** about, never what it refuses.
- With the #704 hooks, the hook still answers "ask" for anything ORCA would ask about, so the call
  reaches ORCA and this path decides it.

## 5. Judge contract

The interface the #702 evaluation slot calls (`packages/agents/src/review-judge/plain-rule.ts`).
It takes **one call per ask, for all candidate rules**:

```ts
judgePermission(
  input: {
    rules: { ruleId: string; ruleRevision: string; criterion: string }[]; // in first-match order
    action: { kind: string; title: string; locations: string[]; inWorkspace: boolean };
  },
  signal: AbortSignal,
): Promise<{
  outcome: "allow" | "no-match";
  verdict: "covered" | "not-covered" | "unsure" | "unavailable" | "malformed" | "timeout"
         | "over-budget" | "injection-suspected";
  ruleId?: string; ruleRevision?: string;    // with allow: the earliest rule judged covered
  reason?: string;                            // <= 200 chars, shown to the person
  verdicts: { ruleId: string; verdict: "covered" | "not-covered" | "unsure" }[];
  judgeConfigRef: string;                     // which judge, model, prompt and limits decided
}>
```

The slot gathers, in first-match order, every judged rule whose deterministic `match` holds, stopping
at the first typed rule that matches. Then it makes one call. The earliest rule judged covered
allows, which is exactly what judging them one at a time in order would give. On `no-match`, that
first matching typed rule decides, or the default when there is none. At most `maxRules` (20) are
sent, and rules past that cannot allow.

It never throws. Any failure is `no-match`, with a verdict saying why.

**Relation to the strict lane's types.** `judgePermission` does not take `JudgeRequestV1` or
`JudgeResultV1`. Those carry the strict lane's authority stamp, action binding, coverage id and
approved-projection binding, and the live layered policy cannot fill them honestly. Instead it
reuses the machinery underneath them: the same manifest, limits and `configRef` derivation, the
endpoint transport and connection, BYOK credentials and the budget. Its verdicts map one-to-one
(covered = `fit`, not-covered = `not-fit`, unsure = `indeterminate`, failures = `unavailable`), so
when the strict lane is switched on, a judged rule becomes an ordinary delegation there with no new
judge contract.

What the judge sees is built by ORCA, never by the agent: the one rule's criterion, and the
action's kind, command text (quoted as data, capped at 4 KiB), workspace-relative locations, and
whether the call is inside the workspace. It gets no secrets, file contents, run history, tools
or policy capability.

The judge's own output schema is closed: `orca-plain-rule-verdict/v1`, holding `requestId` plus
exactly one `{ ruleId, ruleRevision, verdict, reason }` per rule sent, in the order sent, in
canonical JSON. Anything else is `malformed`.

| Judge says | ORCA does |
| --- | --- |
| `covered` for one or more rules, every entry matching a rule sent | `allow` by the earliest → allow once |
| an entry for another rule, revision, request, or out of order | `no-match` (`malformed`) |
| `not-covered`, `unsure` | `no-match`. The next rule or the default decides, and an eventual prompt shows the reason |
| unavailable, timeout, cancelled, malformed, over budget, injection suspected | `no-match` (never a silent allow, never a deny) |

After the verdict, the evaluation slot re-reads the rule (same id and revision, not deleted) and
re-checks its match and protected paths in the same turn as it answers the agent. A rule edited
or deleted while the judge was thinking is not honoured.

## 6. Prompt injection

The judge reads agent-controlled text, so assume the command will try to talk it into "covered".

- The rule's deterministic `match` bounds the blast radius: whatever the judge says, it can only
  allow a call the rule's `match` already covers. It can never reach a protected path or get
  past an earlier deny, and it allows only once.
- The command is carried as a JSON string field, never spliced into instructions. The judge's
  system prompt says that text inside `action` is data and instructions in it are to be ignored.
- The output is closed and must cite a rule id and revision ORCA sent. A free-text "yes" is
  malformed.
- Heuristic tripwires return `no-match` (`injection-suspected`) without asking the judge: command over the cap, control
  characters, or text that addresses the reviewer (such as "ignore previous", "you are", or
  `orca-plain-rule-verdict`).
- Offline evaluation set before any live use: covered/not-covered pairs per rule plus adversarial
  commands (chained `&&`, `;`, subshells, `-C` flags, aliases, injected instructions, unicode
  look-alikes). We measure false allows, which should be 0 on the adversarial set, plus false
  asks and latency, and record the judge, model and prompt versions used (as #701 already
  requires).

## 7. Cost and latency

Performance is one judge call per ask, usually under a second, and zero calls when no judged rule
could apply:

1. **Free broad filter.** Each rule's deterministic `match` (kind, scope, paths, #702's command
   words) runs first in code. Rules that can't apply are never sent.
2. **One batched check** for every surviving rule, as in section 5.
3. **Two passes only past the batch limit** (later): if more than 20 rules survive, a cheap first
   pass shortlists, then the batch checks the shortlist.
4. **Exact-repeat cache** within a run (see below).

- Per-call deadline 5 s (configurable, max 15 s) → person on timeout.
- Concurrency cap per daemon (2) and per run (1); excess asks go to the person rather than queue.
- Budget in cost units per run and per day (owner-declared, reserved per call as in the existing
  connection). Out of budget → person, and the run log says so once.
- Optional exact-repeat cache: the same rule revision, kind, command and locations, with the same
  judge config, within the run reuses a `covered` verdict. Gates and protected paths are still
  re-checked, and any rule edit, judge change or new run clears it. Off by default.

## 8. Audit and what the person sees

Every plain-rule decision appends to the run's event log:
`permission.decided { decision: "allow:plain-rule" | "ask:plain-rule-<outcome>", ruleId,
ruleRevision, judgeConfigRef, verdict, reason, latencyMs, costUnits }`. Nothing secret, and no
command text beyond what the existing permission event already records.

In the app:
- An automatic allow shows "Allowed by your rule: *Allow read-only git commands…*" with a link
  to the rule.
- When the judge declined, the prompt shows its reason ("not read-only: `git push`").
- The prompt gets a third choice next to Allow once and Save: **"Write a rule for things like
  this"**, prefilled with a suggested sentence the person edits. ORCA never saves a rule the
  person didn't confirm.

## 9. Suggested and rewritten rules

ORCA helps write the rules, but **never applies one the person hasn't accepted**. Every suggestion
and every rewrite is shown as a diff (old rule list → new rule list) with Accept / Edit / Dismiss.

**Suggestions from repeated approvals.** When the person answers "Allow once" for similar calls
several times (default: 3 times in 7 days, same agent and kind), the prompt offers "Make a rule
for these?" with a drafted criterion and a deterministic `match`.
- The draft is generated from the approved calls only, never from calls the person declined or
  that were denied.
- Before it's shown, ORCA replays the drafted rule against recent history with the judge, offline:
  "this rule would have allowed these 3 calls you approved, and would **not** have allowed these 2
  you declined". If the draft would cover anything the person declined or anything outside the
  calls they approved, that is shown in red and needs a separate tick.
- `match.kind` is copied from the approved calls and never widened.

**"Tidy my rules."** A button in the rules view asks the judge to propose merges (two rules saying
the same thing), narrowing (a criterion vaguer than what it has actually allowed), and removal
(rules that haven't matched in 30 days).
- Each proposal is one diff, so the person can accept part of it.
- A rewrite can't widen silently. ORCA replays the old and new rules against recent history and
  shows every call whose outcome would change. Any new "would allow" is red and needs an explicit
  tick.
- Hand-written config rules are shown as suggestions to copy, never edited. Only sidecar rules are
  rewritten in place, and each accepted rewrite becomes a new revision with provenance
  `via: suggestion` and the person who accepted it.

**Cost.** Suggestion and tidy calls use the same judge and key, and count against the same daily
budget. They only run when the person opens the suggestion or presses Tidy, never in the
background. The replay uses recorded permission events, which hold only what the decision record
already holds.

**Safety.** A suggestion is text shown to the person, never authority. Accepting it goes through
the same judged-rule save method as writing one by hand (#702's), with the same version-4 sidecar
and provenance. The drafting prompt treats recorded command text as data, as in section 6, so an
agent can't plant a rule through its own command text: the person reviews every word, and the
replay shows exactly what the rule would cover.

## 10. Judge choice

- Tests and CI use deterministic fake judges only.
- First real judge (**Casey chose, 2026-11-23**): a small hosted model through **your own key**
  (#964, env-pinned secret), behind the HTTPS sender PR. Nothing runs until a key is configured and the feature is
  turned on.
- A local model and an ORCA-hosted judge are adapter choices on the same contract.

## 11. Coordination

- **#702 (approval rules thread), agreed:** #702 owns the `judge: { criterion }` rule field, its
  place in first-match evaluation, the allow-once-only answer, the post-verdict re-check, and the
  decision record (`ruleId`, `ruleRevision`, `verdict`, `judgeConfigRef`). This thread owns
  `judgePermission`, its fake, the real provider, budgets and the evaluation set. Typed
  command-word matching (`git -C x push` counts as push) is #702's and serves as a judged rule's
  gate too.
- **#703 (one-use enforcement):** a judged allow is an allow once, so it goes through the same
  one-use path when that lands.
- **#704/#705 (hooks):** no change. Hooks still never answer allow themselves.
- **Profile judge floor (option C, pending):** independent. The floor is about judging typed-rule
  allows. A judged rule's allow is already judged.

## 12. Proposed PR sequence

1. (#702 thread) The `judge` rule field and the evaluation slot. (This thread)
   `judgePermission` with a deterministic fake. Every row in the table in section 5 is tested.
2. HTTPS sender (bounded, no redirects or retries, key in a header) plus the plain-rule wire
   format and decoder.
3. App: "allowed by your rule" display, the judge's reason on prompts, and "write a rule for
   things like this", as its own save method. This comes after #970 merges, because #702 owns
   the prompt files until then. The decision record lands with #702's acp-session work, after
   #946 and #948.
4. Offline evaluation set and report. Turning it on stays behind a setting that is off by default.
5. Suggestions from repeated approvals and "Tidy my rules", with replay diffs (section 9).

## 13. Decisions for Casey

1. May a saved judged rule ever be placed above hand-written rules? (Recommended: no. Order
   already lets an explicit ask win.)
2. ~~First real judge~~: decided, a small hosted model with your own key.
4. Suggestion threshold (recommended: 3 approvals in 7 days) and whether "Tidy" may propose
   removing unused rules (recommended: yes, as a suggestion).
3. Default budget and deadline (recommended: 5 s, 200 judge calls per day, cache off).
