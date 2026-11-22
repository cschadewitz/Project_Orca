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

## Typed launch inputs

`inputs: {name: description}` remains documentation. Optional `inputSchema` declares
`fields` with typed constraints, defaults and sensitivity, plus explicit unknown-field
policy. Defaults are resolved before workflow `vars`, then launch vars; there is no
implicit engine coercion. Workflows without a schema retain legacy input behavior.

Use authorized `workflows.validateInputs` before launching, and pass its returned version
and revision to `runs.start` (or CLI `--workflow-version` and
`--expected-workflow-revision`). Admission validates before creating a run or provisioning
its workspace. Persisted runs resume their pinned definition and authoritative inputs.

Sensitive values live in protected execution storage rather than public run/event views.
See [typed declarations](workflow-inputs.md) and [runtime integration](runtime-foundation-integration.md)
for examples, client parsing, storage/backup boundaries and migration details.

## Node types

| type | purpose | key fields |
| --- | --- | --- |
| `start` / `end` | entry and exit; `end.outcome` = `success` (default) \| `failure` \| `cancelled` | `end.message`; `start` takes no fields |
| `agent` | run an agent turn and collect artifacts | `agent`, `template`/`prompt`, `inputs`, `produces`, `completion`, `vars` |
| `decision` | choose a branch | `source` (`expression` \| `artifact` \| `agent` \| `human` \| `matrix`), `options` (see below), `defaultOption` (an option id). An `artifact` or `agent` source's `field` reads an exact front-matter key first, then a dotted path into the artifact's data: `answers.conflict.choice` reaches a nested value when no key with that exact name exists |
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
| `custom:jev-eval` | (plugin, `docs/INTEGRATIONS.md`) ask JEV Choice/Score/Noul questions over explicit input artifacts → `evaluation` artifact + `result.data.answers` | `inputs`, `context`, `model`, `rubric`, `questions`, `maxStateChars`, `timeoutMs`, `onError`, `repeatable`, `produces` |

The plan nodes are described in `docs/PLANNING.md`. Every node also takes `name`,
`description` and `meta`; edges take `label`; a workflow takes `description`, `inputs`
(name → description, informational) and `meta`. Defaults not shown above: `loop.itemVar`
`item`, `loop.indexVar` `index`, `loop.maxIterations` 10, `parallel.concurrency` 4,
`completion.maxFollowUps` 1, `completion.maxAttempts` 1. `produces[]` entries carry
`name`, `mediaType`, `required` and `validate` (`requiredFields`, `fieldValues`,
`minBodyLength`; a field name reads an exact top-level key first, then a dotted path, so
`answers.conflict.choice` checks the leaf when no exact key exists); `inputs[]` entries carry
`kind`/`name`, `fromNode` and `as` (the alias under `inputs.<as>` in the prompt context).

A `custom:*` node's fields are the plugin's to check, and a plugin whose executor has a
`validate(node)` gets to do it here: `orca validate` and bootstrap load the configured
plugins and report what the executor says under the node's path, so a missing field fails
the workflow before any agent has spent a turn (`docs/EXTENSIBILITY.md`). A custom node whose
type no loaded plugin registers is a warning saying its fields were not checked.

Wherever a node takes `vars` (`set`, `agent`, `subworkflow`), a string value starting
with `=` is evaluated as an expression and anything else is a literal, e.g.
`vars: { slug: "=vars.workItem.slug", stage: "build" }`.

### Loop iterations

Each iteration is its own child run, but an iteration can read what the previous ones
produced: artifact visibility includes earlier siblings — children of the same `loop` step
that finished before this one was spawned. A review‑then‑fix loop therefore works as a
`loop` node, with the builder declaring `inputs: [{ kind: review, required: false }]` and
picking up iteration N‑1's review (unresolved on the first iteration). The same holds for
the children a plugin's `custom:*` container runs one after another.

Fan‑out branches never see each other: not `parallel` branches, and not the item runs of
`custom:plan-dispatch`, even when a `concurrency` limit, `dependsOn` or a later wave starts
one only after another has finished. Nor do siblings bound to different work items, under
any container. So item B's first build never picks up item A's `review` or `testReport` as
feedback; in a plan, what an item needs from the items it depends on arrives explicitly, in
`vars.upstream`.

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
| `destructive` | marks the choice a UI must not make easy to hit by accident — safe choices sort first, then destructive choices; the first nine get number keys. If all choices are destructive, the first still gets `1`, although none is selected by default. The stronger design intent remains a verification item in the [historical review reconciliation](../Current_State/addenda/2026-10-01-main-reconciliation.md) |

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

**An agent that declares no `permissions:`, or declares one without a `default:`, gets a
conservative policy** (#140): reads,
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
3. **the defaults** — the in‑workspace allows above, plus `think` — *only if you left
   `default:` out*.

Then `default:` (`ask` when you left it out) decides anything none of them matched.

So a hand‑written `deny` beats everything, a recorded `reject_always` beats the default allow
that made the prompt appear, and nothing a machine wrote can undo a rule you wrote (ADR 0009).

**Writing `default:` opts out of the third layer entirely** — `ask` just as much as `allow`.
`permissions: { default: ask }` with no rules means what it says: ask about everything,
including reads inside the workspace. That is not the same as leaving `permissions:` off, and
it is the line to write when you want an agent on a short leash. `default: allow` is the other
end and is right for a sandbox. Leave `default:` out and you get the table above.

Spelling the default rules out in your own `rules:` is therefore not a way to get them back
unchanged: it moves them *ahead* of the sidecar, where a recorded `reject_always` can no longer
reach them. `config.get` labels every effective rule with the layer it came from (`config`,
`permissions`, `default`), so the Config surface shows which is which.

Two things about the sidecar are not yours to choose. An `allow` there that says nothing about
what it allows — no `kind`, or a kind and nothing that narrows it, or an `execute` without a
`titlePattern` — is ignored with a warning: ORCA only ever writes scoped grants, so a wildcard
in that file is the shape of an agent's work. Write a wildcard in `orca.config.yaml`, where it
still applies. And a sidecar that cannot be read makes every `allow` decided after it an `ask`
until it is repaired, because the `deny` it may hold would otherwise be skipped.

### ORCA's own files

Ahead of all three layers, and beyond the reach of any of them, an agent may not edit, write,
move or delete the config file, `orca.permissions.json` or the store (`.orca`, or your
`storeDir`), and may not even read `auth/` or the store's key directories. `default: allow`
does not change that. With no `workspace:` set, these files sit in the agent's workspace, and
an agent that could edit the sidecar could otherwise allow itself anything. The same applies to
ORCA's `fs/read_text_file` and `fs/write_text_file` handlers. The store's `work/` and
`program/` stay the policy's, because that is where the deliverables above go when the
workspace holds the store — so a deliverable you put under `.orca/` belongs in one of them. An
agent's own built‑in tools do not ask ORCA at all, so in a hardened setup keep the config
directory out of the workspace (ADR 0009).

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
  as retryable, and only when the failed attempt cannot have acted outside ORCA: an agent step
  that already sent the agent a prompt is not retried automatically (it waits for a
  [side-effect review](recovery.md#side-effect-review)), so for an agent node `maxAttempts`
  covers failures before the first prompt, such as the agent failing to start.
- `timeoutMs`: per‑turn wall clock (defaults to the agent's `turnTimeoutMs`).
  When it elapses ORCA sends `session/cancel`; an agent that does not end the turn within
  its `cancelGraceMs` (default 10s) is killed and the step fails with `AGENT_TRANSPORT`.

## Agent session caps

Nothing limits how many agent sessions a daemon opens unless you say so: `parallel`
concurrency and plan dispatch concurrency shape one run or one plan, and two runs can each
fan out. Three optional caps in `orca.config.yaml` bound the whole daemon (#873):

```yaml
limits:
  maxAgentSessions: 6        # every agent session this daemon holds open, across all runs
  agentSlotWaitMs: 3600000   # optional: fail a step that waited an hour for a slot
hosts:
  - { id: box-b, type: ssh, host: box-b.example, maxSessions: 3 }   # sessions on that host
agents:
  - { id: claude, command: claude-code-acp, maxSessions: 2 }        # one provider/account
```

- **The default is unlimited.** A cap applies only when it is written; none is derived
  from the machine's cores or memory. Each must be a positive integer.
- A step takes one slot from every cap that applies to it when it opens an agent session.
  The cap bounds live agent processes, so the slot comes back only once the session's
  process is confirmed gone - after the step, at the end of the run for a `per-run` session
  (which holds its slot for the whole run), after a failed open (once the process it spawned
  has exited, even if cleanup gave up waiting), or after the agent's
  connection drops and ORCA has cleaned the process up. A queued open never starts beside a
  process that is still shutting down.
- Runs are still admitted at once. A step that cannot have a slot waits *before* it spawns
  anything: `step.waiting` with `on: agent-slot` and a detail such as
  `waiting for an agent slot: 3 of 3 in use on host box-b`. The run shows as blocked, the
  timeline shows the reason, and `orca plan explain <slug>` lists it for a dispatched item.
  Cancelling the run takes the step out of the queue; restarting the daemon loses nothing,
  because a waiting step never opened a session.
- Waiters for the same cap go in order: steps in a plan by plan priority, other steps by
  age, and the two sides by age. A step bound for another host or agent is not held up by a
  full one.
- Caps are read from the current configuration each time, so applying an edit that raises
  one lets waiting steps go at once.
- A `per-run` agent keeps its slot until its run ends, and a run cannot move on while one of
  its own steps waits. So when a cap is full only of `per-run` sessions of the waiting step's
  **own** run (two `per-run` agents in one run under a daemon cap of one), no slot can ever
  come back: that step fails at once with `CONFIG_INVALID`, naming the cap and the agents
  holding it. Raise the cap or make those agents `per-step`.
- When the slots in the way are pinned by runs *above* the step, or by other runs whose own
  children wait on the queue, the wait may never end - but not provably (a `parallel` with
  `join: any` can finish another way and cancel the waiting branch). Those steps are never
  failed as impossible: their wait reason adds "it may never be granted", and
  `limits.agentSlotWaitMs`, when you set it, fails any wait longer than that with
  `STEP_TIMEOUT`. With no deadline set, a long queue is never cut off. A session already
  being torn down never counts as stuck.
- A slot whose agent process exit cannot be confirmed stays held - the process may still be
  running - and `agents.list` reports it as `teardownUnconfirmed`, with a warning in the log.
- A cancel always wins: a step cancelled while waiting, or after its slot was granted but
  before its session opened, spawns nothing and gives the slot back.
- `hello` reports the daemon-wide cap, sessions open and queue depth; `agents.list` adds the
  per-agent and per-host caps and use (optional fields; older clients ignore them).

## Delegating steps to another daemon

An agent of `type: orca-daemon` does not start a process: it hands each of its steps to
another ORCA daemon, which runs a named workflow there as one of its own runs (#883). The
remote is reached over SSH with the same tunnel the desktop app's SSH profiles use (#874):
typed fields only, no ssh config file read. A remote takes delegated steps only once it is
enrolled, and only over the host keys and with the credential enrollment recorded.

```yaml
remotes:
  - id: build-box
    name: Build box
    destination: ci@build-box.example     # user@host
    identityFile: /home/me/.ssh/id_ed25519
    # sshPort, jump: {destination, sshPort, identityFile}, remotePort (default 6722)
agents:
  - id: remote-builder
    type: orca-daemon
    profile: build-box                    # a remotes[].id
    workflow: build                       # the workflow the remote daemon runs per step
    # promptVar: prompt                   # the remote workflow variable the task arrives in
    roles: [builder]
```

One-time setup on the remote: issue this daemon a credential and save it beside this
daemon's config, readable only by its user:

```sh
# on build-box, in the remote daemon's workspace
orca auth issue parent-daemon --preset client --json > build-box.token
# on this machine
install -m 600 build-box.token auth/remotes/build-box.token   # or set remotes[].credentialFile
# on build-box: its host key's fingerprint
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
# on this machine
orca remote enroll build-box --host-key SHA256:...    # plus --jump-host-key for a jump host
```

`orca remote enroll` trusts a host key only when it is already pinned in
`auth/remotes/<id>.known_hosts` (`.jump` for the jump host) or matches a fingerprint you give.
A host that presents any other key is refused before anything, the credential included, is
sent to it. Enrollment then pins the keys, checks the credential, and records in
`auth/remotes/<id>.json` the workspace and principal the remote daemon names and the
credential's id (never the secret). From then on a delegated step:

- opens SSH trusting only the enrolled keys; a changed or missing key refuses the step before
  any byte reaches the remote;
- sends the bearer only if the credential file still holds the enrolled credential;
- refuses before admitting anything unless the remote daemon names the enrolled workspace and
  principal, and binds the admission to them.

Enroll again after replacing the credential, or after the remote's workspace or host keys
change on purpose (remove the old `known_hosts` file first for new host keys).

- **The step's task becomes a remote run, once.** The step's rendered prompt (without ORCA's
  deliverable instructions) is passed as the remote workflow's `prompt` variable, and the run
  is admitted with `runs.admit` under a key derived from this run and the step's first
  attempt. Before anything is sent, a receipt is written under the store's `delegations/`,
  bound to the enrollment and to the remote target and workflow: after a re-enrollment or a
  retarget, an earlier delegation's receipt is never acted on (its step is refused instead).
  A retried step, or this daemon after a restart, reads the receipt: it sends the same key
  again while the answer is unknown (the remote replays it), follows a run that was admitted
  (and brings back the artifacts of one that already succeeded: a succeeded run stays the
  step's result across its retries), and starts new remote work only once the earlier run is
  known to have ended without success, or known never to have been admitted.
- **The work is the remote daemon's.** It appears in that daemon's run list, owned by the
  credential's principal, and its audit log names that principal on the admission.
- **Progress shows on the step.** Remote step milestones and the remote agents' updates
  appear as the step's agent output.
- **Remote gates are asked here.** A question the remote run (or a child run the remote's
  records tie to it) opens is forwarded as a question on this step; the answer is sent back
  to the remote. Free-text remote questions
  are left to be answered on the remote daemon.
- **Cancelling cancels the remote run, and never starts one.** So does the step's turn
  timeout (`turnTimeoutMs`, 30 minutes by default; raise it for long remote work). Cancelled
  while an admission's answer is unknown, this daemon fences the key (`admissions.fence`:
  from then on no admission under it can start a run, however late it arrives) or, if a run
  was already admitted, cancels it. A cancel counts as done only once the remote run is seen
  ended; until then every later session to that remote takes it up again.
- **A dropped connection reattaches.** The session keeps the remote run id and its place in
  the run's log and keeps trying until the turn's deadline. Once the log shows the run ended,
  the session reads the run's result until it gets it.
- **Artifacts come back.** When the remote run succeeds, each of the step's `produces`
  entries is matched to an artifact of the remote run's own succeeded steps with the same
  `name` (or, without a name, the same `kind`). Its text is checked against the remote's
  record (size and sha256) and written where the step collects it.
- **Failures are typed.** `DELEGATION_REFUSED` (not retried) means the remote or the way to
  it refused for a reason a retry cannot fix: a refused credential, an incompatible
  protocol, a daemon that admits no runs (read-only, or an older ORCA), an unknown workflow,
  a remote that is not enrolled, a credential other than the enrolled one, a remote that
  names another workspace or principal, a changed or missing host key, failed SSH sign-in. `AGENT_TRANSPORT` means the remote could
  not be reached. `DELEGATED_RUN_FAILED` means the remote run ended without success; its
  error is in the step's error details.

Not yet: recording the parent run as the remote run's origin, fetching a named git ref on
the remote side, issuing the credential automatically over SSH, and binary artifacts.

## MCP servers and skills for agent steps

ORCA can pass an agent session **outbound** MCP servers (servers the *agent* talks to, given
in ACP `session/new`) and select **skills** for it (#335). This is unrelated to ORCA's own
**inbound** MCP interface (`orca mcp`, [mcp-operator.md](mcp-operator.md)), which lets an MCP
client drive ORCA.

Define each server and skill once, in a catalog in `orca.config.yaml`, then select from it at
four scopes, each applied over the one before:

```yaml
capabilities:
  mcpServers:                       # the catalog: id -> definition
    github: { command: github-mcp-server, args: [stdio] }
    db: { command: db-mcp }
  skills:
    review-checklist: { path: skills/review-checklist, version: "3" }   # relative to this file
  workspace:                        # workspace scope: what every agent starts with
    mcpServers: { enable: [github] }
agents:
  - id: claude
    command: claude-code-acp
    mcpServers: [{ name: notes, command: notes-mcp }]   # legacy inline form, still on
    capabilities:                   # agent scope
      mcpServers: { available: [db] }   # off by default; a workflow or node may turn it on
```

```yaml
# a workflow
capabilities:                       # workflow scope, for every agent step in this file
  mcpServers: { disable: [notes] }
nodes:
  migrate:
    type: agent
    agent: { role: builder }
    capabilities:                   # node scope, for this step only
      mcpServers: { enable: [db] }
```

- A selection is `replace: [...]`, or `enable: [...]` and/or `disable: [...]`. `replace` sets
  the whole list from that scope on and cannot be combined with the other two.
- The config scopes (`capabilities.workspace` and `agents[].capabilities`) may also list
  `available`: entries the agent does not get by default but a workflow or node may turn on.
- **A workflow or node can never grant more than the config permits.** It may turn on only
  what the workspace or agent scope enabled or listed as `available`, and an agent-scope
  `disable` or `replace` takes that permission away again. Anything else fails before the
  run starts, naming the field: `workflow.nodes.migrate.capabilities.mcpServers.enable[0]:
  ... agent 'claude' is not permitted to use it`.
- Unknown ids, an id listed twice, the same id in `enable` and `disable`, and a legacy inline
  server named like a catalog entry are all errors at the field that caused them: the config
  scopes when the config loads, workflow and node scopes when the workflow is validated and
  again when a run is launched under its role overrides.
- **Legacy `agents[].mcpServers` keep working unchanged.** Each inline server is on for its
  agent, as if it were in the catalog and enabled at the agent scope, so a config with no
  `capabilities` behaves exactly as before. Workflows and nodes can `disable` one by its `name`.
- One resolver decides what a step gets, and validation, the launch preview, the run's launch
  record and the session open all call it, so they agree. The preview lists every agent step,
  nested loop and parallel bodies included (a nested step under its qualified id, such as
  `review-loop::review`), with each server's and skill's id and the scope that decided it
  (`source`), plus a skill's version and content digest - never a command, argument or
  environment value. A nested graph runs under its workflow's scope; a `subworkflow` that
  names another workflow runs under that workflow's own.
- **What reaches an agent session.** The agent's own inline `mcpServers`, narrowed by any
  scope, as configured. A catalog server selected for a step reaches that step's session
  only when, at that session open (#337):
  1. the run's owner holds **one** current credential with `capabilities.use` whose grant
     covers the step's whole selected set: each server as it is defined now, on the
     agent's host and that host's endpoint (`orca auth issue <principal> --mcp-server
     github@local`, or `--mcp-server '*'`; the `owner` preset grants every server). Grants
     on two credentials do not combine. A grant does not follow a server redefined to
     another command or a host id pointed at another machine, and a revoked or expired
     credential stops the next step, even one that would reuse a `per-run` session. The
     decision is asked again after any wait for a session slot, immediately before
     `session/new` hands the agent its servers, and before every prompt, so authority
     revoked while a step waits is not used; a `per-run` session refused there is closed
     and never handed to another step;
  2. the server's command resolves on the **agent's host** to an executable regular file,
     and the agent is handed that absolute path, so it starts what was checked and does
     not search again. Over SSH that is one quiet `command -v` on that host. ORCA never
     installs one, and never tries another host.

  Otherwise the step is refused before anything starts, naming the step and the server. A
  run with no recorded owner, or a daemon with no use decision, refuses catalog servers at
  launch.

  What a grant covers when a server is launched:
  - **The executable.** A grant for named servers covers only a server whose `command` is
    a **trusted executable** on the agent's host, checked there at every delivery: an
    absolute path that is the file itself (no extension appended, no `PATH`), canonical
    (no symbolic link, `.` or `..` anywhere on it), an executable regular file, and owned,
    with every directory above it up to `/`, by root or the account the agent runs as,
    writable by neither group nor others and carrying no ACL. So only an administrator of
    that host, or the agent's own account, can put another program at the granted path.
    Anything else (a file under `/tmp`, a symlinked `/bin/...`, a group-writable
    `/usr/local`, any Windows machine, whose permissions this check cannot read) runs only
    under `'*'`. A bare name
    (searched on the server's literal `env.PATH`, else the agent's, else the host's) or a
    relative path (resolved against the session's working directory, which is the run's
    workspace) is covered only by `'*'`, and `orca auth issue` refuses to write a named
    grant for one.
  - **Arguments** are passed exactly as configured, and the grant pins them. ORCA does not
    resolve them; a relative path in an argument is the server's to interpret, in the
    session's working directory.
  - **Environment.** The server's configured `env` is pinned by the grant, with secret
    references read on the agent's host under `secrets.use`. Anything else the server
    inherits comes from the agent process that starts it: the agent's configured `env` and
    what the agent passes on. That is the agent's behaviour, not something ORCA enforces.

  The executable being there is not proof the server works: the agent starts it, over
  ACP's stdio transport, which every ACP agent supports. Skills are delivered under the
  same decision; see [Skills](#skills).
- **Who decides.** The workspace and agent scopes live in `orca.config.yaml`, which only
  config authority can change. A workflow or node can only narrow that, or turn on what the
  agent permits. A caller's role override picks a different configured agent, and then that
  agent's ceiling applies (an override cannot name an unconfigured agent). The host is the
  agent's configured `hostId`: a run cannot move an agent to another host.
- A `per-run` session is reused only by steps that resolve to the same set; a step with a
  different set gets its own session.
- **Availability is not permission, and ORCA does not see every MCP call.** ORCA decides
  which servers an agent session is given and evaluates the
  [permission requests](#permissions) the agent sends over ACP. Calls an agent makes to an
  MCP server without asking are between the agent and that server: whether a given agent
  asks before each MCP tool call is its own behaviour, not something ORCA enforces. Nothing
  in a skill grants anything.

### Skills

A skill is a directory (or a single file) on the daemon's machine. ORCA never fetches or
installs one. Its identity is its catalog id, the author's `version` label, and a content
digest: `sha256:` over every file's relative path, size and bytes. A symbolic link inside a
skill is refused rather than followed. Set `digest: sha256:...` on the catalog entry to pin
the content; a skill whose files no longer hash to the pin is refused, and the error shows
the digest it found so you can review the change and update the pin. A run is pinned to its
configuration, so only a skill's files could change under it: a step whose skill no longer
hashes to what its launch recorded is refused rather than given the edited skill.

**How a skill reaches a session (#337).** A step's selected skills travel in its prompts,
not through any host's filesystem: every prompt the step sends starts with each skill file
as an ACP `resource` block, its text inline, named
`orca-skill://<id>/<file>?digest=<sha256:...>`. So no host path is involved, and a skill
on the daemon's machine reaches an agent on an SSH host the same way.

- The run's owner must hold one current credential with `capabilities.use` whose grant
  covers the step's whole set, servers and skills together. A named skill grant pins the
  content digest (`orca auth issue <principal> --skill review`), so an edited skill needs a
  new grant; `--skill '*'` (and the `owner` preset) covers every skill. A wildcard is per
  kind: `--mcp-server '*'` grants no skill, and `--skill '*'` no server.
- The skill is read once at session open, hashed over exactly the bytes that are sent, and
  refused if that is not what the launch recorded. Each file and directory is opened
  without following a symbolic link and checked, by the open descriptor, to be the regular
  file or directory the walk found (on Linux the walk goes through the directories' open
  descriptors, so a rename meanwhile cannot lead it outside the skill). Each read stops at
  what is left of the step's budget: a step's skills together may be at most 256 KiB.
  Every file must be UTF-8 text; a leading byte-order mark is kept in the text, so what is
  sent is exactly the bytes the digest names.
- The use decision is asked again before every prompt that carries the skills, so a grant
  revoked while the step waits sends nothing.
- The agent must say at `initialize` that it accepts embedded context
  (`promptCapabilities.embeddedContext`). One that does not is refused right after
  `initialize`, before `session/new` or `session/load` configures any MCP server, and the
  step fails; a `per-run` session that could not take the skills is closed rather than kept
  in the pool. ORCA does not fall back to leaving the skill out or pasting it in as plain
  text.
- **A skill is instructions, not authority.** It grants nothing: tool calls still go through
  the agent's permission policy and ORCA's asks. ORCA delivers the skills it lists in the
  preview and nothing else, but it cannot stop an agent from also loading skills of its own
  (for example from the user's home directory); those are not shown as selected.

## Secret references

An agent's `env`, or an MCP server's `env`, can name a credential instead of holding it
(#336). Say once in `orca.config.yaml` where each credential lives and on which host, then
refer to it by id:

```yaml
secrets:
  github-token: { host: local, provider: env, name: GITHUB_TOKEN }    # the daemon's environment
  db-password:  { host: build-box, provider: file, path: /etc/orca/db-password }
agents:
  - id: claude
    command: claude-code-acp
    env:
      GITHUB_TOKEN: { secret: github-token }
      LOG_LEVEL: info                       # a literal, as before
    mcpServers:
      - name: github
        command: github-mcp-server
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: { secret: github-token } }
```

- **Delivered only under a grant.** At every session open the daemon asks whether the
  principal that owns the run (the root run's starter, as durably recorded) may use each
  secret, with its provider, on the host it is bound to, from that principal's credentials
  as they are *now*: a revoked or expired credential stops the next open. One credential
  must cover the whole use, including the run's workflow in its scope. A credential grants
  references with `orca auth issue <principal> --secret github-token@local` (repeatable) or
  `--secret '*'`; the `owner` preset, which the local client's bootstrap credential uses,
  grants every reference, and no other preset grants any. A denial fails that step before
  anything is read, with `reason: unauthorized`. In standalone mode (no credentials file)
  the verified OS user owns the config and its secrets outright; with `orca serve
  --unauthenticated-loopback` every local run may use every reference. A direct `orca run`
  with `--cwd` or `--agent`/`--model` overrides records no owner and cannot use references,
  and `agents.ping` never starts an agent that uses one. See
  [secret-use-authority.md](secret-use-authority.md).
- **Only where it lives is configured, never the value.** `provider: env` reads a variable
  from the host's environment: the daemon's own on a local host, the remote login shell's on
  an SSH host. `provider: file` reads a file on the host whole, dropping one trailing newline;
  the path must be absolute.
- **A secret is only ever read on its own host.** Each definition is bound to one `host`. An
  agent may only refer to secrets bound to the host it runs on (its `hostId`), and the config
  does not load otherwise, naming the field: `agents[0].env.GITHUB_TOKEN: secret
  'db-password' is bound to host 'build-box', but this agent runs on 'local'`. There is no
  fallback: ORCA never uses a value of the same name from the daemon's environment, another
  host, or an earlier session. A reference in a catalog MCP server is read on the host
  of the agent it is given to, like any other in that session (#337).
- **Read at every session open.** The value is read on the host immediately before the agent
  process starts, and not cached, so a rotated value is used by the next session and a
  revoked one stops working then. A missing or unreadable value refuses the step before
  anything is spawned (`secret 'github-token' is unavailable: environment variable
  GITHUB_TOKEN is not set on host 'local'`). A `per-run` session keeps the values it was
  started with for its lifetime; a step that needs a fresh value needs a fresh session.
- **Read and delivered in one step, on one connection.** A local host reads the values in
  the daemon immediately before it starts the agent. Over SSH, the remote shell that is about
  to start the agent reads them itself, exports them, reports them back to ORCA on that same
  connection (for redaction and for MCP server env), and then becomes the agent: the machine
  that read a value is always the machine the agent runs on, never a second connection to
  something with the same host name. The remote host needs `base64` and `printenv`
  (coreutils).
- **Never on a command line.** Values travel through environment and shell variables only,
  so neither machine's process list shows them.
- **Only through a reference.** Every environment variable a secret on a host is read from
  (`provider: env`) is removed from what each agent on that host inherits, the
  `orca agent ping` check included. An agent gets a credential only under the variables
  whose references name it.
- **Never written.** Config, drafts, launch records, provenance, events and logs hold the
  reference (`{ secret: github-token }`), never the value. As defense in depth, a value ORCA
  read is replaced with `[REDACTED]` in every event and log line the run writes afterwards,
  the run's parents included, in every artifact body ORCA records from then on (before it is
  stored, hashed, parsed for structured data or handed to planning), and in every error the
  session reports, its stderr tail included, before it is returned or written. This catches the
  value copied verbatim, not encodings, transformations or fragments of it, and it does not
  rewrite the files an agent leaves in its own workspace.
- **Moving from literal values.** A literal in `env` keeps working, but it is stored in
  `orca.config.yaml` as written, shown to anyone who can read the config, and only redacted
  from run output where ORCA recognises it as a credential. To move one, put the value where
  the host can read it (an environment variable of the daemon, or a file only the daemon's
  user can read), add a `secrets` entry bound to that host, and replace the literal with
  `{ secret: <id> }`.

## Templates

Markdown files with front matter (`id`, `name`, `description`, `version`, `requires`,
`produces`; anything else lands in `meta`), rendered with
`{{ expr }}`, `{{#if}}…{{else}}…{{/if}}`, `{{#each xs as x, i}}…{{/each}}`,
`{{> partial-id}}` and `{{!-- comments --}}`. The expression language is documented in
`packages/core/src/expr/README.md`; the context in `docs/DATA-MODEL.md`.

ORCA appends the **deliverables block** to the rendered prompt of every node that declares
`produces`; do not repeat the file list by hand. Tell the agent *what good looks like* (sections, front‑matter fields).

### Template packs

A workflow names its templates by literal id (`template: sdlc/review`), and a **template
pack** lets a run swap some of them without editing the YAML (#191). A pack is a directory
under `templates/<pack>/` whose files carry the front‑matter id `<pack>/<id>`; the default
`templates` glob loads it with everything else. When a run selects a pack — `--template-pack
<name>` on the CLI, `orca/template-pack` in an ACP session, `overrides.templatePack` on the
record — every agent step resolves `<pack>/<id>` first and falls back to `<id>`, so a pack
that overrides two of six templates inherits the other four. Partials (`{{> partials/… }}`)
are not looked up in the pack. `orca validate --template-pack <name>` lists which templates
the pack overrides and which the validated workflows inherit, and fails with
`TEMPLATE_NOT_FOUND` on a pack that overrides nothing, so a typo cannot silently run the base
set; `run`, `submit` and `plan dispatch` refuse such a pack the same way. The shipped example is
`templates/strict/`, which replaces `sdlc/review` with a stricter review.

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
`program.itemWorkflow` from `orca.config.yaml`, so the same setting steers both. The
precedence, stated once: an item that names its own `workflowId` wins; otherwise the node's
`workflow` pin, then `overrides.itemWorkflow` from the run's selection record (#186), then
`vars.itemWorkflow`. A pin that differs from the selection is logged as a warning, and the
dispatch result's `itemWorkflowSource` says which one applied (`node`, `override`, `var`).
On the command line, `--item-workflow <id>` on `orca submit` and `orca plan dispatch` writes
`overrides.itemWorkflow`, so it beats `program.itemWorkflow` for that one run without a config
edit. `--workflow` on `orca plan dispatch` keeps its meaning: it picks the *program* workflow
to run instead of `plan-resume`, never the item workflow, and one with no
`custom:plan-dispatch` node is refused with `CONFIG_INVALID` before anything starts (#126).

Render any of them as Mermaid with `pnpm run orca graph <id>` (or `orca validate --mermaid`).
