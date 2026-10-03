# Workflow state machine findings and issue coverage

ORCA implements an event-sourced, hierarchical extended state machine. Its strongest
guarantees concern event projection, execution ownership, and workflow versioning.
Recovery semantics, condition evaluation, and progress guarantees need additional work.
Four reproduced defects do not have explicit coverage in the existing issue backlog.

This report is for maintainers deciding which existing work to reuse and which gaps
need focused follow-ups. The implementation baseline is
`e8678ebaa06f4deb883143df288275300f762b3e`. The review and issue inventory were completed
on 3 October 2026. Issue states below are historical observations on that date, not
claims about their state when this report is read. Source references are pinned to
the audited commit; this report does not claim to audit later main revisions.

The review covered workflow schemas and validation, expression evaluation, the
interpreter, executors, event reducers, and relevant storage and planning code.
It inventoried 281 issues (80 open and 201 closed), searched relevant terms across
issues, and read the discussions on the closest recovery, validation, and ownership
issues. “No exact coverage found” describes that search, not proof that no related
discussion exists anywhere. No issue was created, reopened, or modified by this review.

**Capabilities and mathematical model.** A run executes one node at a time. It supports
ordered conditional routing, variable updates, decisions, human gates, retries, and
terminal outcomes. Loops, parallel branches, and subworkflows create child runs.
Parallel execution supports local concurrency limits, branch dependencies, all/any
joins, and cancellation. This composition follows [ADR 0003][adr].

A useful abstract state for a run is `S = (q, status, V, P, A, H, C)`: control location,
lifecycle status, variables, step/attempt history, artifacts, human inputs, and child
relationships. The graph has finite control structure, while the abstract data and
run-tree domains are unbounded. The whole system is an asynchronous composition of
these extended state machines, rather than just the finite run-status enum.

Two transition systems need separate contracts:

- Projection folds accepted events: `S[n+1] = R(S[n], event[n+1])`.
- Execution uses state and environment to produce effects and events:
  `(S, environment) -> (S', events)`. The environment includes time, human answers,
  agent responses, external documents, and other runs.

Deterministic projection does not establish deterministic recovery of execution.
An invariant `I` requires both an initial-state argument and preservation:
`I(S) && Allowed(S, event) => I(R(S, event))`. A complete executable definition of
`Allowed`, including recovery, is not currently centralized in the reviewed code.

Routing selects the first true conditional edge, then an unconditional fallback.
It is deterministic for identical evaluated context even if guards overlap: order
defines priority. It is partial because no edge may match. See [the interpreter][interpreter].

| Property | Assessment at the baseline |
| --- | --- |
| Definition and event shape | Schemas, structural checks, and expression syntax checks provide a strong foundation. |
| Deterministic projection | The same accepted event history determines the same projection. |
| Legal lifecycle transitions | Enforcement depends on writers; the reducer is not a comprehensive history validator. |
| Execution ownership | Ownership checks and execution writes share a lease mutation mutex, subject to supported storage topology and use of that boundary. |
| Concurrency | Bounded locally per fan-out, not globally over nested runs or arbitrary external work. |
| Workflow and configuration identity | Snapshot/version and configuration-generation foundations exist, with explicit compatibility limits. |
| Crash-equivalent execution | Does not hold generally; F1 and F2 are concrete counterexamples. |
| Exactly-once effects | Not established for arbitrary external effects or all internal variable updates. |
| Eventual completion | Requires workflow and environment assumptions; structural validity alone is insufficient. |
| Formal verification | Tests and carefully designed boundaries exist; no workflow-wide proof or model-checking harness was found in the reviewed implementation. |

**F1 — recovery can bypass a definitive retry decision.** Normal execution appends
`step.failed` with `willRetry: false`, then `run.failed`. If execution stops between
these writes, recovery schedules the failed node with `attempt + 1` without honoring
the persisted decision. The observation fixture reproduces attempt 2 executing after
a non-retryable failure on a node with `maxAttempts: 1`. See [recovery handling][recovery].
Recovery should finish the recorded failure or continue the recorded retry decision.

**F2 — an interrupted set can apply an update twice.** The [set executor][set] commits
`vars.set` before the interpreter commits `step.completed`. For
`count = count + 1`, interruption in that window leaves the increment durable and the
step unfinished. Recovery evaluates the expression again. The fixture produces 2
where uninterrupted execution produces 1. This is an internal state-consistency gap,
independent of external agent effects. Committed effects need correlation with a
logical step visit or an atomic completion boundary that recovery understands.

**F3 — condition truthiness is inconsistent.** [Edge conditions][truthiness] treat empty
arrays and empty objects as false using ORCA's `truthy`. Gates and loop conditions
use JavaScript truthiness on evaluated values. The fixture shows `[]` evaluating
false as an edge condition while [automatically approving a gate][gate]. All condition
sites should share one Boolean interpretation.

**F4 — a settled any join can remain paused.** [Parallel result handling][join] checks
for parked children before resolving the final join. With a parked branch followed
by a successful branch, `join: any`, `concurrency: 1`, and `failFast: true`, the fixture
leaves the parent paused. The intended result algebra requires
`any(success, pending) = success`. Join determination should precede parking, with
an explicit cleanup policy for remaining children.

**F5 — the reducer does not enforce legal histories.** A synthetic `run.completed`
followed by `run.resumed` produces a running state retaining its terminal outcome.
The [reducer][reducer] also does not comprehensively validate sequence monotonicity,
run identity, or lifecycle ordering. This demonstrates a projection boundary, not
that a public API accepts the synthetic sequence. A history validator can preserve
legacy compatibility while making legal event ordering explicit.

**F6 — validation does not establish terminal reachability or termination.** The
[validator][validator] accepts a reachable endless cycle with an unreachable end,
reporting the unreachable end only as a warning. This was reproduced without
executing the endless workflow. Existence of an end node, reachability of an end,
and termination of every execution are three different properties. A termination
argument needs a decreasing measure or finite execution budget, together with
assumptions that external operations eventually settle.

**F7 — a loop limit is not a convergence result.** The [loop executor][loop] can exhaust
an `until: false` loop's `maxIterations` and return ordinary completion with `ok: true`
when its children succeeded; the fixture reproduces this with two iterations.
The source also truncates `forEach` at `maxIterations`. This is a contract limitation:
condition satisfied, input exhausted, and limit exhausted should be distinguishable.
Whether exhaustion is a failure or an explicit alternate outcome needs a policy
decision. Local limits do not bound arbitrary graph back-edges or recursive workflows.

**F8 — recovery can recompute routes using changed runtime context.** This is a
source-level finding, not one of the seven executed observations. Recovery routes a
completed step again, and [expression context][context] includes current time and
reread documents. Pinned workflow/configuration identity therefore does not make
every next route a function solely of the recorded step result. Persisting the
selected route, or the inputs required to reproduce it, would strengthen recovery.

**Existing issue coverage.** Direct coverage means the issue explicitly owns the
relevant outcome. Partial coverage means a broader issue is suitable but lacks the
specific scenario. Related closed work is an existing foundation, not an open fix
for the finding.

| Finding | Existing issues and state on review date | Coverage and remaining gap |
| --- | --- | --- |
| F1: retry decision bypass | [#357][i357] open; [#29][i29] and [#290][i290] closed | Partial. Checkpoint recovery is planned; generic retry budgets and terminal-result recovery addressed other cases. Persisted `willRetry: false` recovery needs explicit acceptance. |
| F2: duplicate set effect | [#357][i357] and [#338][i338] open; [#6][i6] closed | Partial. Recovery and transaction boundaries are planned. Child reuse from #6 does not cover reevaluation of a committed variable update. |
| F3: truthiness mismatch | No matching issue found | Uncovered. Needs a focused consistency fix for all condition sites. |
| F4: paused any join | [#13][i13] closed | Related completed work. #13 establishes fail-fast/early-success behavior, but does not describe the parked-sibling case. |
| F5: legal event histories | [#338][i338] open | Related storage work, not an explicit workflow lifecycle-validation contract. No exact issue found. |
| F6: graph validation | [#180][i180] and [#182][i182] open | Directly planned in part: unreachable nodes, missing decision defaults, loops without exits, and cycles outside loops. Does not prove global termination. |
| F7: loop exhaustion | [#183][i183] open | Related bounded simulation only. No exact production loop-exhaustion contract found. |
| F8: dynamic route inputs | [#332][i332] closed; [#394][i394] open | Partial foundations: pinned configuration and plugin restoration. Neither explicitly persists routing inputs such as current time. |
| Storage consistency and durability contracts | [#338][i338] and [#339][i339] open | Direct coverage of store guarantees/conformance and a durable SQLite implementation. |
| Workflow-wide invariant testing or model checking | #338, #357, and #183 provide narrower foundations | No explicit owner for a workflow transition specification and comprehensive invariant/crash-prefix testing was found. |

[#331][i331] covers Request/run admission idempotency. It should not be counted as
coverage for F1 or F2, which concern execution inside an already-admitted run.

There is a design decision to resolve within #180: its proposed prohibition on
cycles outside loop nodes is stricter than [ADR 0003][adr], which permits back-edges
bounded by variables. Publishing stronger validation must reconcile those contracts.

**Delivered foundations and deployment limits.** [#97][i97] (closed) supplied shared
event sequencing. [#101][i101], [#197][i197], and [#267][i267] (closed) supplied and
hardened execution leases/fencing. [#179][i179] (closed) supplied workflow version
pinning. [#290][i290] (closed) supplied recovery of persisted terminal outcomes.
The reviewed source and focused tests support these foundations; the assessment
does not infer delivery merely from closed issue states.

The [ownership boundary][ownership] validates ownership and executes the write under
one mutex. That protects participating execution writes; it does not automatically
fence arbitrary external agent effects. [#103][i103], open, explicitly tracks
shared-file locking across PID namespaces and the NFS/link-atomicity assumption.
Claims about multi-process safety must retain the supported deployment assumptions.

The planning layer already implements strongly connected component detection,
topological operations, and deterministic handling of optional cycle-closing edges
in [plan/graph.ts][plan-graph]. These are useful foundations for stronger workflow
diagnostics, while preserving intentional workflow cycles.

**Recommended follow-up.** These are proposed actions, not issues created by this audit.

1. Add four focused bug follow-ups for F1–F4, cross-referencing the existing work above.
   Preserve retry decisions and committed effects; unify truthiness; resolve joins
   before deciding to park. Keep small correctness fixes independently testable.
2. Reuse #180 for graph-validation policy, #338 for storage contracts, and #357 for
   broader recovery semantics. Add the missing concrete acceptance scenarios.
3. Assign explicit ownership for loop-exhaustion policy and legal event histories.
   Distinguish failure retries, interrupted execution, and resumption of parked work.
4. Add generated invariant tests and interruption after each relevant append. Compare
   recovered observable results with uninterrupted execution, allowing documented
   differences such as attempt IDs. Check terminal-state absorption, retry bounds,
   child identity, join laws, and full/incremental projection agreement. A bounded
   model checker could then explore interleavings against the same transition contract.

**Validation and reproduction.** The audit ran 169 existing tests and seven temporary
observation cases: 176 tests across 14 files passed. The observations deliberately
assert the behavior at the baseline; passing them confirms the findings, not fixes.
The full repository suite, real agents, external side effects, and power-loss
durability were not tested by this audit.

The [observation fixture](observations.test.ts.txt) is stored as text so that historical
bug behavior is not added to the normal regression suite. To rerun the exact focused
selection from the repository root with dependencies installed, first ensure that
`packages/engine/test/state-machine-audit.tmp.test.ts` does not already exist, then run:

```sh
(
  set -eu
  audit_fixture=packages/engine/test/state-machine-audit.tmp.test.ts
  test ! -e "$audit_fixture"
  cp docs/reviews/workflow-state-machine/observations.test.ts.txt "$audit_fixture"
  trap 'rm -f "$audit_fixture"' EXIT
  pnpm exec vitest run "$audit_fixture" \
    packages/engine/test/containers.test.ts \
    packages/engine/test/terminal-recovery.test.ts \
    packages/engine/test/node-policy.test.ts \
    packages/core/test/reduce.test.ts \
    packages/core/test/workflow.test.ts \
    packages/engine/test/run-lease.test.ts \
    packages/engine/test/workflow-pinning.test.ts \
    packages/engine/test/delivery-outcome.test.ts \
    packages/engine/test/work-item-claims.test.ts \
    packages/engine/test/human-input.test.ts \
    packages/store/test/lease-store.test.ts \
    packages/store/test/jsonl-log.test.ts \
    packages/core/test/plan.test.ts
)
```

GitHub issue URLs and pinned source files were resolved through authenticated GitHub
reads during the review. Later issue edits may change the scope/state described here;
the observation fixture and source permalinks preserve the implementation evidence.

[adr]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/docs/adr/0003-single-token-interpreter.md
[interpreter]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/engine/src/orchestrator.ts#L1233-L1387
[recovery]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/engine/src/orchestrator.ts#L1245-L1271
[set]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/engine/src/executors/basic.ts#L30-L37
[truthiness]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/core/src/expr/evaluate.ts#L49-L66
[gate]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/engine/src/executors/basic.ts#L158-L165
[join]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/engine/src/executors/containers.ts#L382-L388
[reducer]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/core/src/events/reduce.ts#L37-L75
[validator]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/core/src/workflow/validate.ts#L69-L118
[loop]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/engine/src/executors/containers.ts#L63-L103
[context]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/engine/src/run-context.ts#L303-L367
[ownership]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/store/src/lease-store.ts#L338-L348
[plan-graph]: https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/core/src/plan/graph.ts
[i6]: https://github.com/cschadewitz/Project_Orca/issues/6
[i13]: https://github.com/cschadewitz/Project_Orca/issues/13
[i29]: https://github.com/cschadewitz/Project_Orca/issues/29
[i97]: https://github.com/cschadewitz/Project_Orca/issues/97
[i101]: https://github.com/cschadewitz/Project_Orca/issues/101
[i103]: https://github.com/cschadewitz/Project_Orca/issues/103
[i179]: https://github.com/cschadewitz/Project_Orca/issues/179
[i180]: https://github.com/cschadewitz/Project_Orca/issues/180
[i182]: https://github.com/cschadewitz/Project_Orca/issues/182
[i183]: https://github.com/cschadewitz/Project_Orca/issues/183
[i197]: https://github.com/cschadewitz/Project_Orca/issues/197
[i267]: https://github.com/cschadewitz/Project_Orca/issues/267
[i290]: https://github.com/cschadewitz/Project_Orca/issues/290
[i331]: https://github.com/cschadewitz/Project_Orca/issues/331
[i332]: https://github.com/cschadewitz/Project_Orca/issues/332
[i338]: https://github.com/cschadewitz/Project_Orca/issues/338
[i339]: https://github.com/cschadewitz/Project_Orca/issues/339
[i357]: https://github.com/cschadewitz/Project_Orca/issues/357
[i394]: https://github.com/cschadewitz/Project_Orca/issues/394
