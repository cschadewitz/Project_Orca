# Authoring workflows

Workflows are YAML (or JSON) files matching `WorkflowDefinitionSchema`. Validate with
`orca validate` (errors block, warnings inform) and draw with `orca graph <id>`.

```yaml
id: ai-sdlc            # kebab-case, unique
name: AI-native SDLC loop
version: "1"
vars: { maxBuildAttempts: 3, buildAttempt: 0 }   # defaults; run inputs override
start: start
nodes:
  start: { type: start }
  build:
    type: agent
    agent: { role: builder }          # or an agent id, or { id: claude-local }
    template: sdlc/build              # or `prompt: |` inline
    inputs: [{ kind: spec }, { name: review, required: false }]
    produces:
      - kind: implementation
        path: ".orca/work/{{ workItem.slug }}/implementation.md"
        validate: { requiredFields: [status, branch] }
    completion: { mode: turn-end, maxFollowUps: 2, maxAttempts: 2 }
  verdict:
    type: decision
    source: { kind: artifact, artifact: review, field: verdict }
    options: [approve, changes-requested]
  done: { type: end, outcome: success }
edges:
  - { from: start, to: build }
  - { from: build, to: verdict }
  - { from: verdict, to: done, when: "choice == 'approve'" }
  - { from: verdict, to: build, when: "choice == 'changes-requested' && vars.buildAttempt < vars.maxBuildAttempts" }
  - { from: verdict, to: done }      # default edge (no `when`)
```

## Node types

| type | purpose | key fields |
| --- | --- | --- |
| `start` / `end` | entry and exit; `end.outcome` = `success` (default) \| `failure` \| `cancelled` | `end.message`; `start` takes no fields |
| `agent` | run an agent turn and collect artifacts | `agent`, `template`/`prompt`, `inputs`, `produces`, `completion`, `vars` |
| `decision` | choose a branch | `source` (`expression` \| `artifact` \| `agent` \| `human` \| `matrix`), `options` (see below), `defaultOption` (an option id) |
| `gate` | human approval; can auto‑approve | `question`, `options` (see below), `autoApproveWhen`, `autoOption` (an option id) |
| `set` | assign run vars | `vars` |
| `loop` | repeat a nested graph / workflow as child runs | `mode` (`while` \| `until` \| `forEach`), `condition`/`items`, `itemVar`, `indexVar`, `maxIterations`, `body`, `breakOnFailure` |
| `parallel` | fan out child runs | `branches{}` or `forEach{items, body, key, dependsOn, workflow, workItemId}`, `concurrency`, `join` (`all` \| `any`), `failFast` (default `true`: stop once the join is decided) |
| `subworkflow` | run a registered workflow as a child | `workflow`, `vars` |
| `custom:<kebab-name>` | anything a plugin registers | free‑form |
| `custom:plan-register` | decomposition artifact → plan (items, dependencies, risks, decisions) | `artifact`, `plan`, `planName` |
| `custom:decision-matrix` | score a `decision-matrix` artifact, record the decision, expose `choice` | `artifact`, `decision` (template) |
| `custom:plan-schedule` | compute the schedule → `vars.schedule` + `schedule.md` | `plan`, `artifactPath`, `policy`, `record` |
| `custom:plan-dispatch` | run the item workflow for ready items, dependency‑ordered across the plan; claims each item so two dispatchers cannot both launch it | `workflow` (default `vars.itemWorkflow`), `concurrency`, `scope` (`request` \| `plan`), `leavesOnly` (default `true`), `onWaiting` (`defer` \| `wait`), `pollMs` (default 5000), `waitTimeoutMs` (default 30 min, `0` = forever), `failFast` (cancels the items still running), `policy` |
| `custom:plan-await` | (in item workflows) wait for this item's `phase` dependencies | `phase`, `pollMs`, `timeoutMs` |

The plan nodes are described in `docs/PLANNING.md`. Every node also takes `name`,
`description` and `meta`; edges take `label`; a workflow takes `description`, `inputs`
(name → description, informational) and `meta`. Defaults not shown above: `loop.itemVar`
`item`, `loop.indexVar` `index`, `loop.maxIterations` 10, `parallel.concurrency` 4,
`completion.maxFollowUps` 1, `completion.maxAttempts` 1. `produces[]` entries carry
`name`, `mediaType`, `required` and `validate` (`requiredFields`, `fieldValues`,
`minBodyLength`); `inputs[]` entries carry `kind`/`name`, `fromNode` and `as` (the alias
under `inputs.<as>` in the prompt context).

Wherever a node takes `vars` (`set`, `agent`, `subworkflow`), a string value starting
with `=` is evaluated as an expression and anything else is a literal, e.g.
`vars: { slug: "=vars.workItem.slug", stage: "build" }`.

### Loop iterations

Each iteration is its own child run, but an iteration can read what the previous ones
produced: artifact visibility includes earlier siblings — children of the same `loop` step
that finished before this one was spawned. A review‑then‑fix loop therefore works as a
`loop` node, with the builder declaring `inputs: [{ kind: review, required: false }]` and
picking up iteration N‑1's review (unresolved on the first iteration). `parallel` branches
run concurrently and so never see each other.

### Parallel fan-out

`concurrency` bounds how many branches are in flight; `join` decides the node's outcome
(`all` — every branch must succeed, `any` — one is enough). With `failFast` (the default)
the node stops as soon as a branch settles the join: the first branch that does not succeed
under `join: all`, or the first that does under `join: any`. Branches that have not started
are skipped and branches still running are cancelled, so a doomed fan-out stops burning
agent turns. A branch parked at a human gate settles nothing — the parent parks with it as
usual. Set `failFast: false` to always run every branch to completion.

A `forEach` fan-out can also be a small DAG. Every field below is an expression evaluated
per item with `itemVar`/`indexVar` in scope:

| field | meaning |
| --- | --- |
| `key` | stable branch key for the item (default: its index); resume re-attaches by it |
| `dependsOn` | keys that must **succeed** first (a string or a list) |
| `workflow` | workflow id to run for this item instead of `body`, when non-empty |
| `workItemId` | the `WorkItem` this branch stands for; its child run is bound to it |

An item whose prerequisite failed, was cancelled or was itself skipped never starts: the
step records a `branch.skipped` event with `reason: dependency` and `join: all` fails. A
prerequisite parked at a human gate blocks nothing permanently — its dependants simply wait
for the resume.

A branch with a `workItemId` also **claims** that item before it starts (see
`ClaimStore`): the claim is an atomic compare-and-set outside the event logs, so two
fan-outs over the same items — a program run and a dispatcher an operator started
alongside it — cannot both launch one item into two workspaces. The branch that loses the
claim is skipped with `reason: claimed` and, under `join: all`, its step fails rather than
reporting work it never did. A run re-claims its own branches, so resume and retry are
unaffected. A claim is never released automatically — a finished run keeps its items so
they are not dispatched twice — so an item held by a run that is gone for good stays
`claimed` for every later fan-out; `orca claims` lists who holds what (with the owner's
status), and `orca claims release <workItemId>` frees an item whose owner is finished or
whose log is gone (`--force` for a run that is merely paused and abandoned). A
request‑scoped fan‑out over the items `custom:materialize-work-items` puts in
`vars.leafWorkItems` looks like this (the shipped `workflows/program.yaml` uses
`custom:plan-dispatch` instead, which re‑schedules from the live plan after each
completion):

```yaml
dispatch:
  type: parallel
  concurrency: 2
  forEach:
    items: vars.leafWorkItems
    itemVar: workItem
    key: workItem.slug
    dependsOn: workItem.dependsOn
    workItemId: workItem.id
    workflow: workItem.workflowId   # falls back to `body` when the item names none
    body: { workflow: ai-sdlc }
```

The node's result carries a per-branch `branches` list (`branch`, `workItemId`, `runId`,
`status`, `outcome`, `ok`) plus `skipped` that a later step can summarise.
`custom:plan-dispatch` publishes the equivalent as `vars.dispatched` /
`vars.dispatchOutcome`, which is what `templates/program/summary.md` renders.

## Routing rules

- Edges are evaluated in file order; the first `when` that is truthy wins; otherwise the
  first unconditional edge (validation rejects more than one on the built‑in node types);
  otherwise the run fails with `WORKFLOW_INVALID`.
- Decision/gate nodes expose their choice as `choice`; write `when: "choice == 'x'"`, where
  `x` is the option's **id** and never its label (see Options below).
- Any node may have conditional edges (e.g. `agent` → branch on
  `steps.build.result.data.stopReason` or `artifacts.spec.data.risk`).
- Loops in the *graph* (an edge pointing backwards) are allowed and are how `ai-sdlc`
  retries `build`; bound them with vars and a `set` node. `loop` *nodes* are for
  repeating a whole sub‑graph as isolated child runs.

## Options (`decision` and `gate`)

An option is either a bare word or a record. The two forms may be mixed in one list.

```yaml
  ship-it:
    type: gate
    question: "Ship {{ workItem.slug }}?"
    options:
      - approve                        # the short form: id and label are the same word
      - id: reject
        label: "Send back"
        consequence: "The build runs again from the spec."
      - id: abandon
        label: "Abandon the work item"
        consequence: "The run ends as a failure and the claim is released."
        destructive: true
```

| field | meaning |
| --- | --- |
| `id` | what the answer *is*. Compared by `defaultOption`, `autoOption` and every `when: "choice == '<id>'"` edge, and what `human.answered` records |
| `label` | the words a person reads. Reword it freely: no edge and no recorded answer depends on it |
| `consequence` | one clause on what choosing this does. The desktop app shows it under the label |
| `destructive` | marks the choice a UI must not make easy to hit by accident — it is never bound to a number key (`docs/design/20-attention-and-gates.md`) |

`approve` on its own means `{ id: approve, label: approve }`, so every workflow written
before options had fields keeps working unchanged and needs no migration. A `gate` with no
`options` still defaults to approve / reject.

## Human gates

`gate` nodes and `decision` nodes with `source: { kind: human }` go through the configured
`humanInput` channel (`orca.config.yaml`):

- `pause` (default): the run is parked — `human.requested`, `step.waiting`, `run.paused` — and
  the process exits with code 3, printing the request id. Parents park with their children, so a
  gate inside a work item's `ai-sdlc` run pauses the whole program run. `orca answer <requestId>
  <option>` (any process with access to the store) appends `human.answered`, resumes the topmost
  paused run and re‑attaches to the same child runs; the gate is re‑attempted and picks the
  recorded answer up. `orca answer` with no arguments lists open questions; `orca status <runId>`
  shows them too. Agent `ask` permissions cannot be parked and are cancelled in this mode.
- `cli`: prompt on the terminal running ORCA.
- `auto`: pick the first option (or `option:`) — demos and tests. An agent `ask` permission is
  *refused* in this mode rather than auto‑allowed, unless `option:` happens to name one of the
  ids the agent offered: a permission request's options are the agent's own and the first of
  them is conventionally "allow once", so taking it would undo the policy that asked.
- Inside an ACP host (`orca acp`) gates are forwarded as `session/request_permission`.

## Permissions

Every `session/request_permission` an agent raises is decided by that agent's policy in
`orca.config.yaml` — `default`, plus an ordered list of `rules`, first match wins:

```yaml
    permissions:
      default: ask
      rules:
        - { match: { kind: execute, titlePattern: "rm -rf|git push --force" }, decision: deny }
        - { match: { kind: edit, scope: workspace }, decision: allow }
        - { match: { kind: read, path: config/keys.env }, decision: deny }
```

A `match` may name a tool `kind`, a `titlePattern` (a regular expression over the tool call
title), an exact `path`, a `pathPrefix`, and a `scope` — `workspace` when every location of
the call is inside the run's workspace, `outside-workspace` when any of them is not. Paths
are matched both as written and workspace‑relative, so a rule survives the next git worktree.
The `decision` is `allow`, `deny` or `ask`.

**An agent that declares no `permissions:` gets a conservative policy** (#140): reads,
searches, edits, deletes and moves *inside the workspace* are allowed, and everything else —
`execute` anywhere, the network, any path outside the workspace — is `ask`. `execute` is asked
about wherever it runs because ORCA sees a shell command only as the permission title: the
agents that matter run commands in their own process rather than through ACP's `terminal`, so
there is nothing to scope by, and an agent that may run any command may do anything at all.

This is a property of the agent, not of how the run was launched — the same config behaves
the same way attended or not. Opt out in one explicit line, which is right for a sandbox:

```yaml
    permissions: { default: allow }
```

### The three layers

A permission is decided against three rule lists concatenated in this order, first match wins:

1. **your `rules:`**, exactly as `orca.config.yaml` spells them out;
2. **`orca.permissions.json`**, the sidecar "allow always" and "reject always" write to;
3. **the defaults** — the in‑workspace allows above, plus `think`.

Then `default:` (`ask` unless you wrote otherwise) decides anything none of them matched.

So a hand‑written `deny` beats everything, a recorded `reject_always` beats the default allow
that made the prompt appear, and nothing a machine wrote can undo a rule you wrote (ADR 0009).
The defaults are appended whatever `default:` says, `allow` included: they only ever *allow*,
and only inside the run's own workspace, so there is nothing for `default: allow` to be
protected from — what that line buys you is `allow` rather than `ask` for everything the
default rules do **not** match, which is the whole of `execute`, the network and the world
outside the workspace.

Spelling the default rules out in your own `rules:` is therefore not a no‑op: it moves them
*ahead* of the sidecar, where a recorded `reject_always` can no longer reach them. Leave them
out unless that is what you want. `config.get` labels every effective rule with the layer it
came from (`config`, `permissions`, `default`), so the Config surface shows which is which.

An `ask` is routed to the `humanInput` channel above, or upstream when ORCA runs as an ACP
agent. **An `ask` nobody can answer is refused, never parked**: a permission cannot outlive
the agent session that raised it, so `pause` cancels it, `auto` refuses it, and either way
the agent is told `cancelled` and the *tool call* fails while the run carries on. The
`agent.permission` event records which it was (`ask:allow`, `ask:deny`, `ask:cancelled`,
`ask:no-answerer`).

## Completion policies (agent steps)

- `mode: turn-end` (default): wait for the agent's prompt turn to finish, then collect.
- `mode: artifact-present`: poll the host while the turn runs and cancel the turn as soon
  as all **required** files exist (useful for chatty agents). Optional deliverables are not
  watched, so a step whose deliverables are all `required: false` behaves like `turn-end`
  (`orca validate` warns about that combination). The poll asks for all watched paths in a
  single host round trip, roughly every 1.5 s, and never starts a check while the previous
  one is still in flight — a slow host is simply polled less often (up to 30 s apart).
- `maxFollowUps`: how many "your deliverable is missing/invalid" follow‑ups to send in the
  same session before failing the attempt.
- `maxAttempts`: whole‑step retries (fresh session each time). Any node type can set
  `maxAttempts` directly on the node; for an agent node the node‑level value wins over
  `completion.maxAttempts`. A step is only retried when its executor reports the failure
  as retryable.
- `timeoutMs`: per‑turn wall clock (defaults to the agent's `turnTimeoutMs`).
  When it elapses ORCA sends `session/cancel`; an agent that does not end the turn within
  its `cancelGraceMs` (default 10s) is killed and the step fails with `AGENT_TRANSPORT`.

## Templates

Markdown files with front matter (`id`, `name`, `description`, `version`, `requires`,
`produces`; anything else lands in `meta`), rendered with
`{{ expr }}`, `{{#if}}…{{else}}…{{/if}}`, `{{#each xs as x, i}}…{{/each}}`,
`{{> partial-id}}` and `{{!-- comments --}}`. The expression language is documented in
`packages/core/src/expr/README.md`; the context in `docs/DATA-MODEL.md`.

ORCA appends the **deliverables block** to the rendered prompt of every node that declares
`produces`; do not repeat the file list by hand. Tell the agent *what good looks like* (sections, front‑matter fields).

## Shipped workflows

- `workflows/ai-sdlc.yaml` — plan → design → spec‑gate → await‑deps → build ⇄ test → review ⇄ build → deploy.
  High‑risk specs stop at the gate; `await-deps` holds the build until build‑phase
  dependencies are satisfied; tests and review loop back with bounded budgets.
- `workflows/program.yaml` — decompose → register (plan) → assess‑risks → decide (matrix per
  open decision) → schedule → plan‑gate → dispatch (the item workflow per item,
  dependency‑ordered across the plan) → summarize.
- `workflows/plan-resume.yaml` — schedule → gate → dispatch with `scope: plan`; picks up
  work deferred by earlier requests (`orca plan dispatch`).

Neither pins the item workflow on its `custom:plan-dispatch` node: both default
`vars.itemWorkflow` to `ai-sdlc`, and `orca submit` / `orca plan dispatch` override it with
`program.itemWorkflow` from `orca.config.yaml`, so the same setting steers both. An item that
names its own `workflowId` wins over either. (`--workflow` on `orca plan dispatch` picks the
*program* workflow to run instead of `plan-resume`, not the item workflow.)

Render any of them as Mermaid with `pnpm run orca graph <id>` (or `orca validate --mermaid`).
