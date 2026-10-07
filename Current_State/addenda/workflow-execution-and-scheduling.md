# Workflow execution and scheduling

ORCA workflows combine agent work, deterministic control flow and extensible executors. Individual runs follow graph edges; parallel containers schedule child branches; plan dispatchers rank work items and launch their workflows. There is no single global queue ranking every pending step.

This addendum records the workflow findings discussed after the current-state review. It describes the implementation reviewed at `09f32690ffca5d9c79f6d8702481f6efe30a4cf3`, with the [corrections](corrections.md) applied. Source inspection establishes these contracts; it does not establish runtime or external-service reliability. [Review index](../README.md).

## Workflow definitions

A definition is a YAML or JSON directed graph with a start node ID, a node map and an edge array. It also has an ID, name, version, default variables and informational input descriptions. Input descriptions do not constitute a required-input or type validator; see [C04](corrections.md#c04-run-variables-are-merged-without-a-workflow-specific-input-validator).

### Node types

| Type | Behavior |
| --- | --- |
| `start` | Entry point; each graph must contain exactly one. |
| `end` | Ends the run with `success` (default), `failure` or `cancelled`, optionally with a message. |
| `agent` | Invokes an agent with a template or inline prompt, input artifacts and expected deliverables. Completion policies support turn completion or required-artifact presence, follow-ups, retries and timeouts. |
| `decision` | Resolves an allowed option from an expression, artifact field, agent, human or decision matrix. An optional default handles a value outside the allowed options. |
| `gate` | Human approval with configurable options, defaulting to approve/reject. An expression can automatically select an option. |
| `set` | Assigns run variables; values prefixed with `=` are expressions. |
| `loop` | Runs a child body in `while`, `until` or `forEach` mode, with an iteration limit and configurable stopping on child failure. |
| `parallel` | Runs named branches or fans out over a collection, with a concurrency limit, `all`/`any` join and `failFast`. Collection items can carry stable keys, sibling dependencies and workflow selection. |
| `subworkflow` | Invokes a registered workflow as a child run with supplied variables. |
| `custom:<name>` | Invokes a registered executor. Custom fields are permitted but require executor-specific validation. |

Loop bodies and parallel branches may reference registered workflows or contain inline graphs. Loop, parallel and subworkflow execution uses child runs. Common node fields include a name, description, retry budget and extension metadata.

Evidence: [workflow schema](../../packages/core/src/model/workflow.ts), [authoring](../architecture/core-authoring.md), [node execution](../architecture/engine-execution.md).

### Edges and routing

There is one edge shape: `from`, `to`, optional `when` and optional `label`. Conditional and unconditional edges are forms of this shape, not separate type discriminators.

```yaml
edges:
  - from: review
    to: implement
    when: "choice == 'revise'"
    label: Needs revision
  - from: review
    to: finish
```

The interpreter selects the first true conditional edge in definition order, then falls back to an unconditional edge. An unconditional edge appearing earlier does not override a matching condition. Decision and gate choices compare option IDs, not display labels. No matching route fails a nonterminal run. Multiple outgoing edges do not launch concurrent work; a parallel node supplies that behavior.

Validation checks endpoint references and condition syntax, rejects edges into the start node or out of an end node, and restricts multiple unconditional exits on built-in nonterminal nodes. Back-edges can revisit nodes; workflow graphs need not be acyclic. Artifact references and parallel-item `dependsOn` are separate from graph edges.

Evidence: [graph validation](../../packages/core/src/workflow/validate.ts), [interpreter routing](../../packages/engine/src/orchestrator.ts#L1074).

## Deterministic evaluation

With the same input state, built-in expressions calculate the same result. They support arithmetic, comparisons, Boolean logic, ternaries, field/index access, string matching and helpers such as `all`, `any`, `count`, `min` and `max`. The evaluator processes a parsed expression rather than arbitrary JavaScript.

| Component | Deterministic operation |
| --- | --- |
| Edge | Evaluate `when` and select the next route. |
| Expression decision | Compute an option from variables, artifacts or step state. |
| Artifact decision | Read a recorded artifact field and match its value to an option. |
| Matrix decision | Rank weighted criteria, honoring a valid explicitly chosen option when supplied. |
| Gate | Evaluate `autoApproveWhen`; otherwise request human input. |
| Set and variable bindings | Assign literals or expression results. |
| Loop | Evaluate conditions or a collection and enforce an iteration limit. |
| Parallel | Evaluate items, keys, dependencies and workflow selection; concurrent settlement order can still depend on timing. |

An evaluation that only chooses the next route can be an expression or artifact decision. An evaluation that runs tests, invokes a service or produces a report needs an executor to perform that work, followed by routing on its result. A decision can also ask an agent directly, but that is model judgment rather than deterministic evaluation.

For example, this node fragment evaluates existing results; it does not run tests:

```yaml
evaluate:
  type: decision
  source:
    kind: expression
    expr: "vars.testsPassed && vars.score >= 0.9 ? 'pass' : 'revise'"
  options: [pass, revise]
```

Artifact validation also provides mechanical checks on deliverables, including required fields and allowed field values. Those checks do not establish semantic correctness of an agent's report. Fixed routing does not guarantee reproducible whole-run behavior: agents, humans, external services, concurrent timing and changes to definitions or templates can affect results. Version labels alone do not guarantee immutable replay; see [C01](corrections.md#c01-workflow-version-identity-is-conditional).

Evidence: [expression evaluator](../../packages/core/src/expr/evaluate.ts), [basic executors](../../packages/engine/src/executors/basic.ts), [artifact schema](../../packages/core/src/model/artifact.ts), [matrix resolution](../../packages/engine/src/plan/executors.ts#L227).

## Execution without an agent

The orchestrator calls a custom executor's `execute(ctx)` directly. A plugin can therefore execute code or call an external service without opening an agent session or asking a model to make a tool call. Executors can return structured step data, record artifacts and report completion or failure.

The host interface already exposes `exec(command, { cwd, stdin, timeoutMs })`, with local and SSH implementations. A custom executor can reach a configured host through the agent registry and run test commands, Python, Node.js or an installed TypeScript runner. A plugin can also implement JavaScript logic directly. Required interpreters and runners must exist on the execution host.

There is no shipped general-purpose shell, Python, JavaScript/TypeScript or `eval` workflow node. Supporting a reusable command node requires implementing and registering an executor, including its configuration validation, command construction, output capture, cancellation and result contract. The existing host execution method does not itself accept an abort signal; cancellation needs explicit handling in that executor or an extended host interface.

The existing `custom:jev-eval` plugin demonstrates direct external execution: it calls an evaluation service over HTTP and records results without an agent session. Its evaluation is model-based, not deterministic script execution.

A possible flow after implementing a test executor is: agent implementation → custom test execution → decision on recorded results → advance or revise. If test failure should route to revision, the executor must return a completed step with a failing test result or choice; returning an executor failure instead invokes the interpreter's retry/failure path.

Evidence: [plugin API](../../packages/engine/src/plugin.ts), [example plugin](../../examples/plugin-example.ts), [executor context and outcomes](../../packages/engine/src/executors/types.ts), [host interface](../../packages/agents/src/host.ts), [built-in executor registry](../../packages/engine/src/executors/index.ts), [JEV integration](../architecture/integration-jev.md).

## Execution order

### Steps within a run

The interpreter starts at the graph's start node, records `step.scheduled`, awaits the executor, and records its result. It chooses the next node only after completion; it does not enqueue every downstream node or score their priority.

A retryable failure repeats the current node within its retry budget. Exhausted or nonretryable failure fails the run. A paused executor parks the run. A result carrying a terminal outcome ends execution regardless of node type.

On resume, recorded state determines where to continue: route onward from the last completed step, or reattempt an interrupted step. Container reattempts can reattach existing child runs. Reattempting a step does not guarantee exactly-once external side effects.

Evidence: [run interpreter](../architecture/engine-interpreter.md), [execution loop](../../packages/engine/src/orchestrator.ts#L934).

### Branches within a parallel node

The branch scheduler scans the defined/generated branch order and starts eligible branches while its local concurrency slots remain. Dependencies must succeed before a dependent branch starts. Failed or missing prerequisites cause dependent branches to be skipped; paused prerequisites leave them unstarted pending resume.

Branch completion frees slots for further work. Join and fail-fast policies determine when remaining work is unnecessary and should be skipped or cancelled. Parallel branches do not use the plan scheduler's weighted priorities.

Evidence: [FanOut and branch scheduling](../../packages/engine/src/executors/containers.ts).

### Work items within a plan

A submitted request creates a program run. Workflows can register decomposition results as work items; a `custom:plan-dispatch` node then starts an item workflow for each eligible item. This is the level at which task priority is evaluated.

The scheduler first classifies the current plan snapshot:

| Class | Meaning |
| --- | --- |
| Ready | Eligible to start. |
| Waiting | Blocking prerequisites are not yet satisfied. |
| Held | Risk exposure exceeds the configured appetite. |
| Unschedulable | A hard dependency cycle or failed blocking dependency prevents execution. |
| Running | Already executing. |
| Settled | Done, failed or cancelled. |

Dependencies needed at a later phase can permit an item to start once its upstream item is underway, with a later dependency check before the required phase. Soft dependencies influence ordering calculations but do not block eligibility. Persisted satisfied/waived dependencies remain satisfied/waived until explicitly changed; see the [dependency clarification](corrections.md#documentation-clarifies-one-uncertainty-without-changing-source-facts).

Ready items sort by a weighted score over normalized factors: remaining downstream path length using estimates, downstream dependent count, risk exposure, risk mitigation, explicit item priority and age. Scores sort descending, with slug as the tie-breaker. Estimates contribute to ordering, not an elapsed-time prediction.

| Strategy | Weight emphasis |
| --- | --- |
| `critical-path` | Default; emphasizes remaining downstream path length, with other factors contributing. |
| `risk-first` | Emphasizes risk exposure and mitigation. |
| `most-dependents` | Emphasizes work that unblocks more items. |
| `fifo` | Emphasizes age but also includes explicit priority; not strict arrival order. |

Policy can override the preset weights. Default plan concurrency is two. The dispatcher fills its available slots from the ranked ready list, obtaining a persistent work-item claim before each launch. Resumable children from an interrupted attempt are reattached before new ready items launch.

The dispatcher recomputes the schedule when children settle or relevant local plan journal events arrive, with a polling fallback. Readiness and scores can change between passes. A newly higher-priority item does not preempt an already running child. When work is waiting or held and no children are running, dispatch can wait subject to its configured deadline or defer the remaining work. Paused children park their parent for later resumption.

For example, with two slots, A and independent item C can start while B waits on A. Once A satisfies B's prerequisite, B joins the ready list and competes for a free slot. Each item's own workflow still orders its internal steps through graph edges.

Evidence: [request flow](../architecture/engine-program.md), [planning algorithms](../architecture/core-planning.md), [schedule calculation](../../packages/core/src/plan/schedule.ts), [policy defaults](../../packages/core/src/model/plan.ts#L294), [dispatcher](../../packages/engine/src/plan/executors.ts#L512).

### Ownership and capacity limits

Persistent claims prevent competing dispatchers from launching the same work item. Renewable run leases prevent concurrent interpretation of the same run. These are distinct from capacity allocation.

Concurrency limits belong to individual dispatchers and parallel containers. There is no durable global job queue or shared host-wide quota in this implementation. Multiple dispatchers or nested containers can therefore collectively exceed any one container's limit. Plan-service serialization is local to one service instance, not an interprocess transaction or a global capacity reservation.

Evidence: [dispatch limits](../architecture/engine-dispatch.md), [plan service limits](../architecture/engine-plan.md), [claims and leases](../architecture/store-ownership.md).
