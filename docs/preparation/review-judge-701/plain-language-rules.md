# Plain-language permission rules, decided by a review judge (#701)

Status: **design for review (Cal) and owner decisions (Casey).** Only `judgePermission` (section 5)
is built, with fake judges, and nothing calls it yet. It stays inactive until the real sender and
the evaluation slot have each had their own independent review.
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
        - match: { kind: read, scope: workspace }   # deterministic gate, kind required
          judge:
            criterion: "Reading source, tests and docs, but never .env files, keys or credentials."
```

The first rollout judges known read-only operations only (section 3). Rules about commands, such as
"read-only git commands", are the goal of a later stage once ORCA can verify what a command
actually does (section 3, "Later stage").

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

The judged lane sits inside hard boundaries that are checked in code before any judge is asked.
Rule order decides between allows; it never lets a model past a restriction.

```
protected path?                                   → deny            (no judge, ever)
any deterministic deny rule matches, anywhere     → no judged allow (the typed rules decide as today)
any mandatory-human (ask) rule matches, anywhere  → no judged allow (the person is asked)
outside the safe action envelope                  → no judged allow (the person is asked)
first matching rule is typed                      → its decision
first matching rule is judged                     → judge: allow ──► allow once
                                                            no-match ──► continue to the next rule
no rule left                                      → default (usually ask → person)
```

**Hard boundaries, regardless of order.** Before calling the judge, the evaluation slot checks the
action against **every** deterministic `deny` and every mandatory-human `ask` rule in the agent's
whole policy (configured and sidecar), not only those above the judged rule. If any matches, the
judged lane is closed for that ask (`hard-boundary`). A person who wrote "always ask me about
`git push`" or "deny `rm -rf`" anywhere in their list gets exactly that, even if a broad judged rule
sits above it. A model can never turn an action a person reserved for themselves, or explicitly
denied, into an automatic allow.

**Safe action envelope (first rollout).** A judged rule can only allow inside a deterministic
envelope, and the person is asked otherwise (`outside-envelope`):
- the kind is a known read-only operation: `read` or `search`. Commands (`execute`) and writes
  (`edit`, `delete`, `move`) always go to the person for now, as do fetch, mode switches and unknown
  kinds;
- the call names at least one target;
- ORCA itself verified every target (`targetsVerified`): it resolved the real path the read will
  open (symlinks followed) and found it inside the workspace and outside every protected path. A
  tool-reported working directory or a lexically relative path does not establish containment, so
  neither counts;
- as a second, lexical line behind that check, every location is workspace-relative (not absolute,
  no `..`, no home or drive prefix).

`restrictions` and `targetsVerified` passed to `judgePermission` are the **output** of the slot's
trusted checks, never a substitute for them. The helper refuses without them, but it cannot verify
them itself.

**Later stage: commands and writes.** These need effect evidence ORCA verifies, not a judge's
reading of a title: for example #703's ORCA-owned executor (the real argv and working directory,
resolved), #702's typed command words, and a known read-only command set whose targets are
verified like reads. That stage gets its own design and review before any command or write can be
allowed by a judged rule.

These checks are the authorization boundary. The judge, the tripwires in section 6 and the
canonical reply shape only decide whether an action *inside* them is covered; none of them is a
boundary on its own.

- The judge only ever answers **allow** or **no match**. It never denies.
- **Decided (Casey, 2026-11-23):** a saved judged rule never sits *above* configured rules, for
  now. Saved rules, judged or not, always come after hand-written ones, as today.

**Shadowing.** Judged rules only allow, so when several cover a call the outcome is the same
(allow once). Only the credit differs, and the record lists every rule the batch judged covered,
not just the first. A broad judged rule can't shadow a typed restriction, because of the hard
boundaries above. It *can* shadow the exceptions inside a narrower judged rule: with "allow git
commands" above "allow git commands except push or delete", a `git push` is allowed by the first,
because a judged rule's exceptions only narrow that rule. To keep `git push` with the person, write
it as an ask rule. Two follow-ups make that easier (**Casey chose both, 2026-11-23**; built in a
later PR, section 12):
- plain-language "always ask me" rules, judged in the same batch, which close the judged lane when
  they match. Being judged, they can only add prompts, never remove them;
- "Tidy my rules" flags a narrower judged rule that a broader one above it fully covers, and offers
  to fold the exception into the broad rule or turn it into an ask rule.

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
    restrictions: { deny: boolean; ask: boolean };  // any deterministic deny / ask match, anywhere
    action: { kind: string; title: string; locations: string[]; inWorkspace: boolean;
              targetsVerified: boolean };  // the slot's own real-path check
  },
  signal: AbortSignal,
): Promise<{
  outcome: "allow" | "no-match";
  verdict: "covered" | "not-covered" | "unsure" | "unavailable" | "malformed" | "timeout"
         | "over-budget" | "injection-suspected" | "hard-boundary" | "outside-envelope";
  ruleId?: string; ruleRevision?: string;    // with allow: the earliest rule judged covered
  reasonCode?: ReasonCode;                    // fixed code; ORCA words it locally
  verdicts: { ruleId: string; verdict: "covered" | "not-covered" | "unsure"; reasonCode: ReasonCode }[];
  judgeConfigRef: string;                     // which judge, model, prompt and limits decided
}>
```

`ReasonCode` is a closed set, one family per verdict: `matches-criterion` (covered);
`outside-criterion`, `excluded-by-criterion` (not covered); `action-ambiguous`,
`criterion-ambiguous` (unsure). The judge never returns prose. What a person sees and what the
audit records is ORCA's own wording for the code, so an otherwise valid reply can't echo the
command or the criterion into a prompt or the record.

The slot gathers, in first-match order, every judged rule whose deterministic `match` holds, stopping
at the first typed rule that matches. Then it makes one call. The earliest rule judged covered
allows, which is exactly what judging them one at a time in order would give. On `no-match`, that
first matching typed rule decides, or the default when there is none. At most `maxRules` (20) are
sent, and rules past that cannot allow.

It never throws. Any failure is `no-match`, with a verdict saying why. With `restrictions` set or
outside the envelope it returns without calling the judge, as a second line behind the slot's own
checks.

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
exactly one `{ ruleId, ruleRevision, verdict, reasonCode }` per rule sent, in the order sent, in
canonical JSON, with a reason code from the verdict's own family. Anything else, including free
text, is `malformed`.

| Judge says | ORCA does |
| --- | --- |
| `covered` for one or more rules, every entry matching a rule sent | `allow` by the earliest → allow once |
| an entry for another rule, revision, request, or out of order | `no-match` (`malformed`) |
| `not-covered`, `unsure` | `no-match`. The next rule or the default decides, and an eventual prompt shows ORCA's wording for the reason code |
| unavailable, timeout, cancelled, malformed, over budget, injection suspected | `no-match` (never a silent allow, never a deny) |
| a deterministic deny or ask matches anywhere, or the action is outside the envelope | `no-match` without calling the judge (`hard-boundary`, `outside-envelope`) |

After the verdict, the evaluation slot re-reads the rule (same id and revision, not deleted) and
re-checks its match and protected paths in the same turn as it answers the agent. A rule edited
or deleted while the judge was thinking is not honoured.

## 6. Prompt injection

The judge reads agent-controlled text, so assume the command will try to talk it into "covered".

- The hard boundaries and the envelope (section 3) and the rule's deterministic `match` bound the
  blast radius: whatever the judge says, it can only allow a call inside all three. It can never
  reach a protected path or get past any deny or mandatory ask, and it allows only once. The rest
  of this section lowers the rate of false "covered" inside that space; none of it is an
  authorization boundary.
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

- Per-call deadline 5 s (configurable, max 15 s) → person on timeout. The deadline and cancellation
  end the wait at once, even if the transport ignores its abort.
- Concurrency cap per daemon (2) and per run (1); excess asks go to the person rather than queue.
  A send keeps its slot until it actually settles, not when the caller stops waiting, so a stuck
  provider can't pile up hidden requests.
- Budget in cost units per run and per day (owner-declared, reserved per call as in the existing
  connection). Out of budget → person, and the run log says so once.
- Optional exact-repeat cache: the same rule revision, kind, command and locations, with the same
  judge config, within the run reuses a `covered` verdict. Gates and protected paths are still
  re-checked, and any rule edit, judge change or new run clears it. Off by default.

## 8. Audit and what the person sees

Every plain-rule decision appends to the run's event log:
`permission.decided { decision: "allow:plain-rule" | "ask:plain-rule-<outcome>", ruleId,
ruleRevision, judgeConfigRef, verdict, reasonCode, latencyMs, costUnits }`. Nothing secret, no
model prose, and no command text beyond what the existing permission event already records.

In the app:
- An automatic allow shows "Allowed by your rule: *Reading source, tests and docs…*" with a link
  to the rule.
- When the judge declined, the prompt shows ORCA's wording for the reason code ("Your rule doesn't
  cover this.").
- The prompt gets a third choice next to Allow once and Save: **"Write a rule for things like
  this"**, prefilled with a suggested sentence the person edits. ORCA never saves a rule the
  person didn't confirm.

## 9. Suggested and rewritten rules

ORCA helps write the rules, but **never applies one the person hasn't accepted**. Every suggestion
and every rewrite is shown as a diff (old rule list → new rule list) with Accept / Edit / Dismiss.

**Suggestions from repeated approvals.** When the person answers "Allow once" for similar calls
several times (default 3 times in 7 days, configurable; same agent and kind), the prompt offers "Make a rule
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
5. Later stage: commands and writes, with verified effect evidence (section 3), separately designed
   and reviewed.
6. Suggestions from repeated approvals and "Tidy my rules", with replay diffs (section 9) and the
   shadowing warning (section 3).
7. Plain-language "always ask me" rules: judged in the same batch, a match closes the judged lane.
   Needs the `judge` field to accept an `ask` effect (#702's schema).

## 13. Decisions for Casey

All decided (Casey, 2026-11-23):

1. **Saved judged rules above hand-written rules:** no, for now. Saved rules always come after
   hand-written ones. With the hard boundaries in section 3, position can't get past a restriction
   anyway.
2. **First real judge:** a small hosted model with your own key.
3. **Default budget and deadline:** 5 s per call, 200 judge calls per day, repeat cache off. All
   configurable.
4. **Suggestions and Tidy:** suggest a rule after 3 approvals in 7 days, and Tidy may propose
   removing rules unused for 30 days, as a suggestion only. The threshold, window and unused period
   are configurable, and suggestions can be turned off.
5. **Plain-language "always ask me" rules and Tidy's shadowing warning:** both (section 3).
