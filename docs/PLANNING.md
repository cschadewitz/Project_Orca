# Long-term planning: dependencies, risks and decisions

The program workflow turns one request into work items and runs them. The
**planning layer** is what lets ORCA do that *across* requests and over time:
it keeps a durable graph of every work item it is tracking, the dependencies
between them (including on decisions not yet made and on things outside ORCA),
the risks that bear on them, and the decisions that gate them. The scheduler
reads that graph to decide which item an agent gets next, in which order, and
records why.

```
                 Request A                 Request B                  orca plan ...
                    │                         │                            │
              decompose (agent)         decompose (agent)          depend / decide / risk
                    │                         │                            │
   ┌────────────────▼─────────────────────────▼────────────────────────────▼───────────────┐
   │                                     PLAN  (key: default)                              │
   │   WorkItem ──dependency──▶ WorkItem      Risk ──affects──▶ WorkItem                   │
   │   WorkItem ──dependency──▶ Decision      Risk ──mitigatedBy──▶ WorkItem               │
   │   WorkItem ──dependency──▶ external      Decision ──blocks──▶ WorkItem                │
   │                                          journal: every change, who/what/when          │
   └──────────────────────────────────────────▲────────────────────────────────────────────┘
                                              │ artifacts (spec.md risks:, dependencies:, decision-matrix, risk-register)
                          scheduler ──▶ ready / waiting (why) / held (risk) / cannot run
                                │
                       custom:plan-dispatch ──▶ ai-sdlc run per item ──▶ custom:plan-await (build-phase deps)
```

Everything is data plus pure functions (`packages/core/src/model/plan.ts`,
`packages/core/src/plan/`), one service that owns mutations
(`packages/engine/src/plan/service.ts`), five node types
(`packages/engine/src/plan/executors.ts`) and a CLI (`orca plan`).

## Concepts

| Entity | What it is | Key fields |
| --- | --- | --- |
| **Plan** | The long-lived container; requests join it. One per product/roadmap is typical; the default key comes from `planning.plan` in `orca.config.yaml`. | `key`, `requestIds`, `policy` (scheduling), `riskMatrix` |
| **WorkItem** (extended) | One deliverable slice, now with `planId`, `priority`, `produced` (artifact kind -> id, drives stage-level dependencies) and `deferredReason`. Slugs are unique per plan; a clash with an earlier request gets a `-2` suffix. | see `docs/DATA-MODEL.md` |
| **Dependency** | An edge from a dependent item to what it waits for: another item (optionally a *stage* of it), a decision, or something external. | `type` (`blocks` / `soft` / `informs`), `requiredBy` (phase), `status`, `origin` |
| **Risk** | Something that could go wrong, scored likelihood x impact on the plan's matrix, attached to the items it affects and to the items that mitigate it. | `likelihood`, `impact`, `status`, `affects`, `mitigatedBy`, `mitigation`, `triggers` |
| **Decision** | A choice that must be made, with a weighted **decision matrix** (criteria x options) and an outcome. Items can depend on it. | `criteria`, `options`, `result`, `chosen`, `decidedBy`, `blocks` |
| **Journal** | Append-only log of every plan change with its origin (decomposition, artifact, agent, human, system). | `plans/<planId>.jsonl` |

### Dependency references

Agents (and humans) write dependencies with a small grammar, in decomposition
`dependsOn`, spec `dependencies`, or `orca plan depend`:

| Reference | Meaning |
| --- | --- |
| `other` | hard: this item cannot start until `other` is done |
| `other@spec` | stage-level: may start once `other` has produced a `spec` artifact (pipelining) |
| `other#build` | phase: may start now, but its `build` phase waits until `other` is done |
| `other@implementation#build` | both: build waits for `other`'s implementation |
| `soft:other` | preferred ordering only; never blocks, never fails |
| `informs:other@spec` | no ordering; `other`'s artifacts are handed to this item's agents (`vars.upstream`) |
| `decision:key` | wait for the decision `key` to be made (an unknown key opens a placeholder decision and warns) |
| `external:key` | wait for something outside ORCA; a human marks it satisfied (`orca plan satisfy`) |

`blocks:other` is accepted as the explicit form of the default. The object form
`{ on, type, stage, requiredBy, rationale }` is equivalent, with one difference:
`type` and `requiredBy` must be given as fields. Inside `on` only `decision:` /
`external:` and `@stage` are honoured; a `soft:` / `informs:` prefix or `#phase`
suffix written there is ignored (#77).
A reference to a slug that is not in the plan yet is recorded as an `external`
placeholder and **bound automatically** when a later request registers that
slug. That is how one request can depend on work that another request will
deliver.

### The risk matrix

`score = likelihood x impact` on a 1..`scale` grid (default 5). Levels come
from `riskMatrix.thresholds` (defaults: medium >= 5, high >= 10, critical >= 16).
An item's **exposure** is the highest level (and the sum of scores) of the
*open* risks that list it in `affects`. Open means `open`, `mitigating` or
`realized`; `mitigated`, `accepted` and `closed` risks no longer count.

The policy's `riskAppetite` (default `high`) is the highest exposure an item
may carry and still be dispatched. Above it the item is **held** until a human
accepts or the risk is mitigated (`orca plan risk <key> --status accepted`).
Items listed in a risk's `mitigatedBy` get a priority boost when
`mitigateFirst` is on, so de-risking work runs early.

### Decision matrices

A decision has criteria (`weight`, `direction: maximize | minimize`) and
options with a score per criterion on `scale` (0..10 by default). ORCA
computes:

- the weighted sum per option (minimize criteria are inverted: `scale - score`),
- a ranking, the **margin** between the top two, and a confidence
  (`clear` >= 0.1, `close`, `tie`),
- **pivotal criteria**: any criterion whose removal flips the recommendation.

The artifact's `chosen` wins when it names a known option, or when the decision
has no options recorded at all (the agent or human
overrode the arithmetic, `decidedBy: agent|human`); otherwise the top-ranked
option is chosen (`decidedBy: matrix`). A gate can route on
`steps.<node>.result.data.confidence` to send close calls to a human.

## How agents feed the plan

Agents never call a planning API (ADR 0002). They write artifacts; ORCA lifts
**planning signals** from front matter when the artifact is recorded
(`packages/core/src/plan/signals.ts`, `PlanService.onArtifactRecorded`):

| Artifact | Front matter read | Effect |
| --- | --- | --- |
| `decomposition` | `items[].dependsOn`, `items[].priority`, `items[].risks`, `risks[]`, `decisions[]` | `custom:plan-register` creates items, dependencies, risks, decisions |
| `risk-register` | `risks[]` | risks upserted by key; `affects`/`mitigatedBy` slugs resolved |
| `decision-matrix` | criteria, options, `chosen`, `rationale` | a valid `chosen` decides on intake; otherwise `custom:decision-matrix` evaluates the matrix and decides. Re-submitting the same choice is a no-op: one `decision.resolved` per resolution |
| any other (`spec`, `intent`, `review`, ...) | `risks`, `decisions`, `dependencies` (alias `discoveredDependencies`) | risks attach to the producing item (a bare string becomes a risk keyed by its slugified title); discovered dependencies are added from it; a decision with `chosen` is decided |

Every artifact recorded by an item's run also updates `WorkItem.produced`,
keyed by artifact kind *and* name, which is what stage-level dependencies test
(`other@spec` and `other@<artifactName>` both work). Intake happens *inline* in the
orchestrator, so the next node always sees the updated plan, and it is
**serialised per plan**: sibling item runs record artifacts at the same time, so
they take turns rather than interleaving their read-modify-write updates and
each raising the same risk. Risks, decisions and dependencies also carry ids
derived from their key, so a duplicate can only overwrite, never accumulate.

Each signal is applied on its own. One the plan refuses (a `chosen` that is not
one of the options, malformed front matter) never stops the ones behind it: the
run keeps going and the rejection is reported as a `plan.signals.rejected` run
event and a `signals.rejected` journal entry.

Plugins can add extractors (`api.plan.addSignalExtractor`) to lift signals
from their own artifact kinds.

## The scheduler

`computeSchedule()` (`packages/core/src/plan/schedule.ts`) is pure. Given a
snapshot it classifies every unsettled item that is in scope and not already
running (running items are reported separately as `schedule.running`):

1. **unschedulable** - in a `blocks` dependency cycle, or a `blocks` dependency has
   *failed* (upstream failed/cancelled/blocked, decision superseded, external
   marked failed);
2. **waiting** - a `blocks` dependency required by `start` is not satisfied,
   or a later-phase dependency's upstream has not *started* yet (an item
   should not occupy a slot only to wait);
3. **held** - exposure above the risk appetite (`holdAboveAppetite`);
4. **ready** - everything else, ordered by priority.

`open` and `failed` dependencies are evaluated **live** against the current
items and decisions, never from a stale persisted status; `satisfied` and
`waived` are sticky once persisted. The service persists transitions so the
journal records *when* each dependency cleared.

Priority is a weighted sum of normalised factors; the ones that dominate
(dependents, critical path, risk, mitigation, a non‑normal priority) are
reported as human‑readable reasons (`orca plan explain <slug>`):

| factor | meaning |
| --- | --- |
| `criticalPath` | heaviest chain of dependents below the item (estimates: XS .5, S 1, M 2, L 3, XL 5) |
| `dependents` | how many items it transitively unblocks |
| `risk` | its own exposure (surface problems early) |
| `mitigation` | it mitigates an open risk (level-weighted: low .25 ... critical 1) |
| `priority` | `critical` / `high` / `normal` / `low` from the decomposition |
| `age` | older items first |

Cycle detection runs over `blocks` edges only: a `soft` edge is an ordering
preference that never blocks, so a soft back-reference must not strand the
items it points at. With `orderSoftDependencies` (the default) soft edges still
shape the **waves**, the **critical path** and the dependent counts - except
for the ones that would close a cycle, which are left out of that view and
listed in `schedule.ignoredSoftDependencies`.

Waves and the critical path describe the **remaining** work: settled items
(done, failed, cancelled) are left out of the graph, so an edge to a done item
disappears and `criticalPath.length` is the estimate still ahead. A stage-level
edge (`other@spec`) exists so that work can overlap, so along it the chain is
charged half of the upstream estimate rather than all of it. Every item on the
reported path carries the reason `on the critical path`, and a cycle is listed
in edge order from its smallest slug (`a -> c -> b -> a`).

Strategies are weight presets: `critical-path` (default), `risk-first`,
`most-dependents`, `fifo`; `policy.weights` overrides individual weights. The
schedule also reports topological **waves**, the **critical path**, cycles, a
risk summary and open decisions (with the items whose `blocks` dependency on
them is still waiting) - all of which `custom:plan-schedule` writes into a
`schedule` artifact for the gate and exposes as `vars.schedule`.

## Node types

| Node | Where | What it does |
| --- | --- | --- |
| `custom:plan-register` | program, after `decompose` | decomposition -> plan; sets `vars.planId`, `vars.workItems`, `vars.openDecisions` |
| `custom:decision-matrix` | inside the `decide` loop (or anywhere) | evaluates a `decision-matrix` artifact, records the decision, returns the choice (`decision:` is a template, e.g. `{{ vars.decision.key }}`) |
| `custom:plan-schedule` | before the gate | computes the schedule, writes `schedule.md`, sets `vars.schedule`, journals; `plan`, `artifactPath` (default `.orca/plans/{{ vars.plan }}/schedule.md`, empty disables), `policy`, `record` |
| `custom:plan-dispatch` | after the gate | runs the item workflow for ready items, re-schedules after every completion *and* on every plan change; `workflow` (default `vars.itemWorkflow`), `concurrency`, `scope: request \| plan`, `leavesOnly` (default true), `failFast`, `onWaiting: defer \| wait`, `pollMs` (5 s), `waitTimeoutMs` (default 30 min, `0` = forever), `policy` |
| `custom:plan-await` | inside `ai-sdlc` before `build` | blocks until the item's dependencies for `phase` are satisfied; refreshes `vars.upstream`; a no-op without a plan; `pollMs`, `timeoutMs` (default 30 min) |

The `decision` node also accepts `source: { kind: matrix, artifact, decision }`
for decisions whose options are fixed in the workflow.

`custom:plan-dispatch` does **not** write the items' `status` / `runId`. Those are a
projection of the dispatch step's own log (`child.spawned` / `child.finished` /
`branch.skipped`, ADR 0001 and
`engine/program/work-items.ts`); the plan side journals each transition the projection makes
(`work-item.updated`) and re-evaluates the dependencies it clears, so `orca plan journal` and
`orca plan show` cannot disagree even if the process dies between a child finishing and the
dispatch step resuming. `custom:plan-dispatch` never skips a branch, so within plan
dispatch no run log can produce `blocked` - an item the scheduler refused to start never
gets a branch. That status the plan owns, through `PlanService.deferWorkItem`, which
writes the reason and journals `dispatch.deferred` together and never overwrites a status
the projection set. (A plain `parallel` fan‑out does project `blocked`, from
`branch.skipped` with `reason: dependency`.)

`custom:plan-dispatch` finishes with `vars.dispatchOutcome` = `complete`,
`partial` (items deferred: waiting on another request, an external, an open
decision, or held; claimed by another dispatcher; or in scope but never offered)
or fails when items failed/blocked. Deferred items keep `deferredReason` and are picked up by the
next dispatch that sees them: `orca plan dispatch <key>` runs
`workflows/plan-resume.yaml` (schedule -> gate -> dispatch with `scope: plan`).

The loop itself is the `FanOut` `parallel` uses (`engine/executors/containers.ts`), driven
over a ready set recomputed from the live plan instead of a branch list fixed up front. So
`concurrency` and `failFast` mean the same thing in both: with `failFast` the first failure
stops new launches *and* cancels the items still running, which report as `cancelled` in
`vars.dispatched` rather than as failures of their own. Each pass subscribes to the plan
journal before it reads the plan, so a change landing while the scheduler runs wakes it
immediately rather than at the next `pollMs`; changes this run wrote itself are skipped, since
it already knows about them. `onWaiting: wait` emits one `step.waiting` per distinct reason
(not per poll) and gives up after `waitTimeoutMs` — 30 minutes by default, `0` to wait
indefinitely — after which what is left is deferred exactly as `onWaiting: defer` leaves it.

`plan.policy.concurrency` bounds *one* dispatcher, so it cannot stop two of them —
a program run dispatching with `scope: request` while an operator runs `orca plan
dispatch` over the same plan — from both being offered the same ready item. Each
launch therefore claims its work item first (`ClaimStore`, an atomic
compare-and-set outside the event logs); the dispatcher that loses the claim
reports the item as `claimed` in `vars.dispatched`, leaves its WorkItem document
to the owner, and drops it from its own ready set. A dispatcher re-claims what it
already owns, so resuming an interrupted dispatch re-attaches as before.

Human gates inside an item run behave as they do everywhere else (`humanInput.mode:
pause`): the child parks, `plan-dispatch` parks the program run with it (the item stays
`in-progress`, nothing is recorded as failed), and `orca answer` + resume re-attempts the
dispatch step, which re-attaches to the child runs the interrupted attempt had launched
instead of spawning them again. The same re-attach happens after a crash mid-dispatch.

## Shipped program flow

```
decompose ─▶ register ─▶ assess-risks ─▶ decide (loop: matrix ─▶ resolve) ─▶ schedule ─▶ plan-gate ─▶ dispatch ─▶ summarize
```

- `assess-risks` (template `program/assess-risks`) produces the risk register.
- `decide` iterates `vars.openDecisions`; each iteration is a child run whose
  `program/decide` prompt carries the decision, its candidate options and the
  items waiting on it.
- `plan-gate` auto-approves unless the breakdown is large, an open risk is
  critical, or something can never run.
- Inside `ai-sdlc`, `await-deps` sits between the spec gate and the first build.

Run `pnpm run demo` to see it without an LLM: a decision (`session-store`) is
made by matrix, `login-api` waits for it and for `schema`, `docs` receives
`login-api`'s spec, and two risks are tracked.

## CLI

```
orca plan                                 # list plans
orca plan show [key]                      # items, dependencies, risks, decisions
orca plan schedule [key]                  # ready order with reasons, waiting (why), held, waves, critical path
orca plan explain <slug> [key]            # everything about one item
orca plan graph [key]                     # Mermaid dependency graph
orca plan risks [key] | decisions [key] | journal [key]
orca plan depend <slug> <ref> [key]       # add a dependency
orca plan waive <depId> | satisfy <depId> [--rationale ...]   # human overrides (externals, waivers)
orca plan decide <decisionKey> <option> [--rationale ...]
orca plan risk <riskKey> --status accepted|mitigated|closed|...
orca plan dispatch [key] [--workflow id] [--quiet]   # resume: schedule -> gate -> dispatch across the plan
```

Every subcommand except `list` accepts the plan key positionally or as `--plan <key>`
(default: the configured `planning.plan`). The read-only ones (`list`, `show`, `schedule`, `risks`,
`decisions`, `journal`) also take `--json`.

## Known limitations

Reviewed when the layer was rebased onto main; tracked as issues #77 and #81–#84 (label
`planning`), #88, #104 and #105. In short: the scheduler still re‑reads the whole plan on every
wake, which grows with plan age (#83, `docs/ROADMAP.md` item 12); a dead run's claims can
only be released by editing the store (#88); a *different* choice re-decides a `decided`
decision without `reopenDecision`, so the decide loop can undo a human's `orca plan decide`
(#104); artifact intake reconciles even when a signal changed nothing (#105). See
`docs/ROADMAP.md` item 13. Fixed since: cycle
detection ignores `soft` edges (#71); a work-item claim stops two dispatchers from launching one item twice (#72);
artifact intake is serialised per plan (#73); work‑item status is projected from the event
log, with the plan side following it (#74); the dispatcher loop runs on the same `FanOut` as
`parallel`, so `failFast` cancels the items still in flight, and `onWaiting: wait` announces
one `step.waiting` per distinct reason under a default `waitTimeoutMs` instead of one per
poll (#96); scheduler explanations, the critical path and cycle messages agree with each
other (#80); the JSONL event store and plan journal number events on disk under a lock
file, so two processes over one store extend one log (#97); a decision the artifact intake
already made is not re-decided by `custom:decision-matrix` (#79).

## Configuration

```yaml
planning:
  plan: default              # plan requests join unless `--var plan=<key>` says otherwise
  planName: Product roadmap
  policy:
    strategy: critical-path  # critical-path | risk-first | most-dependents | fifo
    concurrency: 2
    riskAppetite: high       # hold items whose open risk exceeds this
    holdAboveAppetite: true
    mitigateFirst: true
    orderSoftDependencies: true
    weights: { risk: 3 }     # optional per-factor overrides
  riskMatrix:
    scale: 5
    thresholds: { medium: 5, high: 10, critical: 16 }
```

Per-plan values can be changed later through `PlanService.updatePlan`; the
`custom:plan-dispatch` / `custom:plan-schedule` nodes accept `policy` overrides.

## Extending

- **Signal extractors**: `api.plan.addSignalExtractor(fn)` to read planning
  data from custom artifact kinds (`SignalExtractor` in `core/plan/signals.ts`).
- **Strategies**: express a new ordering as `policy.weights`; or compute your
  own ranking from `computeSchedule()`'s `priorities` / `factors`.
- **Stores**: `PlanStores` (`store/plan-store.ts`) is four document
  collections and a journal; implement them over SQLite/Postgres like the
  other stores.
- **Nodes**: everything the shipped nodes do goes through `ctx.plan`
  (`PlanService`), so a plugin node can register items, raise risks, decide,
  or wait on dependencies in its own way.
- **Human channels**: `orca plan decide/risk/waive/satisfy` are thin wrappers
  around the service; a web UI or chat bot would call the same methods with
  `origin: { kind: "human", actor }`.

## Limits and follow-ups

- The scheduler evaluates the whole plan on every call (fine for hundreds of
  items; index by request/plan before thousands).
- Later-phase dependencies (`#build`) on *decisions* or *externals* cannot be
  "started", so the item starts and waits inside its run.
- Cross-plan dependencies are not supported; use one plan per product.
- See `docs/ROADMAP.md` for milestones, capacity-aware scheduling and the
  Maintain-stage loop (realised risks reopening work).
