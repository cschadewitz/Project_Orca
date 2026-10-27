# Decision: rule-scoped review versus a mandatory execution judge (#701)

Status: **proposal for owner decision. No production policy is changed.**
Baseline: `origin/main` at `4d5176c`. Related: [#701](https://github.com/cschadewitz/Project_Orca/issues/701)
(primary), [#699](https://github.com/cschadewitz/Project_Orca/issues/699),
[#702](https://github.com/cschadewitz/Project_Orca/issues/702). Inputs: the merged
[#744](https://github.com/cschadewitz/Project_Orca/pull/744) and
[#750](https://github.com/cschadewitz/Project_Orca/pull/750) findings and the
[#701 contract-question comment](https://github.com/cschadewitz/Project_Orca/issues/701#issuecomment-6422342610).

Executable companions, both run by the ordinary root Vitest configuration:

| File | Kind | What it proves |
| --- | --- | --- |
| [`required-judge-current-701.test.ts`](../../../packages/agents/test/required-judge-current-701.test.ts) | **Characterization** of current code | Where a required judge comes from today and what happens on each judge outcome. |
| [`mandatory-judge-proposal-701.ts`](../../../packages/agents/test/mandatory-judge-proposal-701.ts) | **Proposal model, test-only** | Three candidate contracts layered on the unchanged production evaluator. Not exported from any package. |
| [`mandatory-judge-proposal-701.test.ts`](../../../packages/agents/test/mandatory-judge-proposal-701.test.ts) | **Proposal decision matrix** | Every rule × floor × judge row; invariants; precedence and revocation rows. Every `describe` is prefixed `PROPOSAL`. |

The proposal matrix is anchored to production: for every rule delegation and judge
outcome, the `rule-scoped` model is checked against the real inactive
`createStrictPolicyPort`. If production changes, that anchor fails before the comparison
silently drifts.

## 1. The question

A "required judge" can mean two different things:

1. **Rule-scoped.** An approved rule says "allow this, but only after judge J says fit".
   The requirement belongs to that rule and applies only when that rule is the one
   that authorizes the action.
2. **Mandatory across rules.** A profile (or deployment) says "every automatic allow of
   this kind must be judged", whichever rule authorizes it, including a rule a human saves
   later.

Current code implements only the first. #744/#750 established that and left open whether
the second should exist and, if so, how an explicit new grant interacts with another
rule's required delegation.

### What was and was not established

- **Established (#750, characterized again here):** with a configured rule delegation, an
  actual required judge returning `not-fit` or `unavailable` does not allow, and a
  persistence-review attestation cannot be relabelled into execution authority.
- **Not established:** the earlier "snapshot-only bypass" claim in the original #744 text.
  That probe rewrote trusted snapshot metadata while the real producer had no configured
  execution judge. It is not a demonstrated production exploit and this document does not
  treat it as one.
- **Open:** precedence between an explicit new grant and another rule's required
  delegation, and whether any global/profile mandatory-judge requirement should exist.

## 2. Current behaviour (characterized)

Source: `packages/core/src/strict-permission.ts` (`evaluateStrictPermission`),
`packages/agents/src/strict-permission.ts` (`createStrictPolicyPort`),
`packages/agents/src/typed-sidecar.ts` (rule writes),
`packages/daemon/src/protected-scoped-permission-owner.ts` (protected Save).

Evaluation order, unchanged by anything here:

1. Mandatory denials: current authority, captured ceiling, protected access → `deny`.
   Missing → `indeterminate`.
2. Stale authority, incomplete identity, expiry, coverage/state, profile, policy
   availability, profile coverage and fact floors → `indeterminate`.
3. **First matching rule** (`strict-permission.ts:199`). No match → `require-human`.
4. Revoked → `deny`; not current → `indeterminate`; `deny` rule → `deny`.
5. Mandatory human ceiling or a `require-human` rule → `require-human`.
6. `allow` with no delegation → automatic rule allow. With delegation → review eligibility
   built **from that rule's delegation only** (`:217` onward).

Facts the characterization test pins:

| Situation | Today |
| --- | --- |
| Older broad rule with required delegation, then a newer exact grant (Save appends, `typed-sidecar.ts` `[...records, record]`) | Review required by the older rule. The new grant is shadowed for this action. |
| Older undelegated allow, then a newer rule with required delegation | Automatic allow by the older rule. **The later required delegation never runs.** |
| Older revoked or `deny` rule, then a newer exact grant | `deny`. The grant is shadowed. |
| Profile fields | `profileRef`, `minimumCoverage`, `facts`. **No judge field.** |
| Mandatory human / denied authority / no match | Decided before any delegation; no judge consulted. |
| Required + `unavailable` | `indeterminate judge-unavailable`, whatever `allowWhenUnavailable` says. |
| Advisory + `allowWhenUnavailable` + `unavailable` | Rule allow. |
| Advisory + `not-fit` | `deny` (the rule's `onNotFit`). *Advisory is binding when the judge answers.* |
| A grant inserted ahead of a delegated rule during a pending review | `indeterminate review-delegation-changed`; never an unreviewed allow. |
| Any profile change during a pending review, even a weakening one | `indeterminate review-eligibility-changed`. |

A protected Save never carries a delegation (`protected-scoped-permission-owner.ts:425`),
so a human-saved grant is always an undelegated allow rule.

## 3. Options compared

All three are modelled in the test-only proposal and run through the same matrix. In all
three the production evaluator runs first, so steps 1–5 above and first-match selection
are unchanged; an option can only add review in front of a production rule allow.

| | A. Rule-scoped only (status quo) | B. Explicit global/profile requirement only | C. Layered: profile floor + rule delegation |
| --- | --- | --- | --- |
| Source of review | Matched rule's delegation | Profile floor; rule delegation ignored | Both; strengthen-only composition |
| Order dependence | Yes: a later delegation is shadowed by an earlier undelegated allow | No | No for the floor; rule delegation stays first-match |
| New exact grant | Follows first match | Always subject to floor | Always subject to floor; cannot lower it |
| Existing required delegations | Kept | **Dropped** unless migrated (matrix row "migration hazard") | Kept |
| Floor `disabled`/absent | n/a | No review at all | Identical to A (matrix invariant) |
| New types | None | Profile field; delegation deprecated | One optional profile field |
| Per-rule methodology | Yes | No | Yes, but must name the same judge/destination/projection as the floor, else `indeterminate` |
| Can express "every automatic allow here must be judged" | **No** | Yes | Yes |

Matrix invariants (`PROPOSAL #701 invariants`, 80 rows):

- C with the floor absent or `disabled` equals A exactly.
- C never allows where A would not.
- If either source is `required`, C allows only on an actual `fit`; `unavailable` is
  `indeterminate judge-unavailable`.
- Every allow is attributed to the production-selected rule, never to the judge.

Rejected: **B**, because it silently weakens existing required delegations (demonstrated)
and removes per-rule methodology; it would need a migration that is itself C.
Also not proposed: "most restrictive delegation across *all* matching rules". It changes
first-match semantics for every rule, makes a rule's effect depend on unrelated rules,
and is not needed once a profile floor exists.

## 4. Recommendation: the smallest coherent contract

**Adopt C with these limits**, and do not claim a global mandatory-judge ceiling before it
ships.

1. Keep first-match rule selection and rule delegation exactly as they are.
2. Add one optional, versioned profile field, an **execution judge floor**:
   `mode: disabled | advisory | required`, plus judge config, projection policy,
   destination policy, maximum duration, `onNotFit`, `onIndeterminate`,
   `allowWhenUnavailable` (only meaningful for `advisory`).
3. The floor applies only to **automatic rule allows** produced by the deterministic
   coordinator. It does not apply to `deny`, `require-human`, `indeterminate` or a human's
   per-invocation answer.
4. Composition is strengthen-only: the stronger requirement, `deny` over `require-human`
   for not-fit, `indeterminate` over `require-human` for indeterminate, the shorter
   deadline, and the unavailable fallback only when every source allows it.
   A floor and a rule naming different judge, projection or destination is `indeterminate
   judge-requirement-conflict`; nothing is substituted or merged.
5. Absent floor means `disabled`: today's behaviour. No silent default change.

This closes the one real gap A has (an earlier undelegated allow, including a human-saved
grant, shadowing a later required delegation) only for operators who opt in, and changes
nothing for anyone else.

## 5. Contract details

### New scoped-grant precedence

- A protected Save creates an ordinary undelegated allow rule, appended. It remains subject
  to first match: an older matching rule (delegated, revoked or deny) still wins for that
  action, as today.
- Under C, a new grant can never lower the profile floor. Saving a grant is not a way to
  skip execution judgment.
- A grant does **not** inherit or override another rule's delegation. Whether the newest
  exact grant should instead take precedence over older broader rules (newest-first or
  most-specific-first) is a separate owner decision (§7), not part of the minimal contract.

### Explicit human approval

- A per-invocation human answer resolves a `require-human` verdict. It is human authority,
  not a rule allow, and the floor never puts a judge in front of it.
- A human Save is persistence approval for a future rule. It is not execution judgment and
  cannot satisfy a floor for any later invocation.

### Persistence review versus execution judgment

These stay separate records with separate authorities, as #744/#750 already found:

- **Persistence review**: whether saving this grant was reviewed/approved
  (`requiredReview` / `persistenceReview` on the protected Save record).
- **Execution judgment**: whether this invocation, under the authorizing rule and floor,
  was judged fit now, bound to the current action, authority stamp and deadline.

Neither can stand in for the other. A passed persistence review never produces an execution
`judgeResultRef`, and an execution fit never approves a Save.

### Modes

| Mode | Judge consulted | `fit` | `not-fit` | `indeterminate` | `unavailable` |
| --- | --- | --- | --- | --- | --- |
| `disabled` / absent | No | — | — | — | — (rule allow) |
| `advisory` | Yes | Rule allow | `onNotFit` | `onIndeterminate` | Rule allow only if `allowWhenUnavailable`, else `indeterminate` |
| `required` | Yes | Rule allow | `onNotFit` | `onIndeterminate` | `indeterminate judge-unavailable` (lane held) |

Today's `advisory` is binding when the judge answers. #701 describes advisory as
"unavailability is reported under the declared policy". If the owner wants a
**record-only** advisory (judge consulted, outcome logged, never blocks), that is a fourth
mode and should be named separately rather than changing `advisory` (§7).

### Unavailable judges

Unavailable, timed out, cancelled or malformed are not `fit`. No fallback to another
judge, provider, profile or to human approval happens implicitly. Under `required` the lane
is held as `indeterminate`; the owner may later choose `onUnavailable: require-human`
explicitly (§7).

### Revocation and change during review

The retained review is compared with a fresh evaluation at bind and completion. Revoking
the rule, inserting an earlier matching grant, changing the profile (including lowering the
floor) or changing authority stops the review (`indeterminate`, or the fresh `deny`). It
never completes under different terms. Production already does this for rule and profile
changes (characterized); the floor inherits it by being part of the profile.

### Authority and safety limits

The deterministic coordinator stays the only authority. Judge output is advice consumed by
the coordinator: it cannot create, widen or save a rule, approve a grant, change a profile
or floor, select a native option or bypass mandatory denials, the human ceiling,
coverage/fact floors or one-use permit consumption. The matrix checks that no floor or judge
outcome reaches a production final (`PROPOSAL #701 mandatory limits`).

## 6. Compatibility and migration

- Additive: absent floor ≡ `disabled` ≡ today. Existing rules, delegations and Save records
  are unchanged.
- The floor is part of the profile, so profile revision changes already invalidate pending
  reviews and cached advice.
- Versioning: a reader that does not understand the floor must treat a profile carrying one
  as `required-profile-unavailable` (indeterminate), not ignore it.
- No data migration. Operators who want a mandatory judge set the floor; nothing converts
  existing delegations.
- Changes needed when implemented (not in this PR): `StrictActionProfile` gains the
  optional field; `evaluateStrictPermission` composes it after rule selection;
  `ReviewEligibilityV1.delegation` gains a source marker so records say whether the rule,
  the floor or both required review; the profile reader and sidecar schema learn the field.

## 7. Decisions that need the owner

1. **Is a profile-level mandatory judge wanted at all?** If not, A stays, and #701 should
   state plainly that there is no global ceiling and that rule order decides review.
2. **New-grant precedence.** Keep first match with append (today), or make newest/most
   specific grant win? The latter would let a human Save override an older delegated rule
   for that exact action, which is a policy change and would need its own review.
3. **Can a profile floor be opted out of per rule or by a human Save?** Recommended: no.
4. **Meaning of `advisory`.** Keep today's binding-when-answered semantics, or add a
   separate record-only mode?
5. **Judge conflicts.** Refuse (recommended), or require both judges to return fit
   (an ensemble needs a versioned deterministic composition per #701)?
6. **Unavailable under `required`.** Hold the lane (`indeterminate`, recommended default) or
   allow an explicit `require-human` escalation.
7. **Scope of the floor.** Per profile (recommended), per workspace or per deployment.

## 8. Not in scope

No production evaluator, shared canonical type, UI, transport adapter, lockfile or
`tools/owned-read-proof` change. No keys, network judges, paid calls, deployment or upstream
contact. Transport preparation is owned elsewhere.
