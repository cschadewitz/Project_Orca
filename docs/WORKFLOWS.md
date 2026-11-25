# Authoring workflows

This page is for people who write ORCA workflows and configure the agents that run them. It is
the reference for node types, routing, gates, permissions, completion, session caps, delegation
to another daemon, MCP servers, skills, secrets and templates.

Workflows are YAML or JSON files matching `WorkflowDefinitionSchema`. Check them with
`orca validate` (errors block, warnings inform) and draw one with `orca graph <id>`.

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

- `inputs: {name: description}` is documentation only.
- `inputSchema` declares typed `fields` with constraints, defaults, sensitivity and an explicit
  policy for unknown fields. Schema defaults apply first, then workflow `vars`, then launch
  vars. There is no implicit coercion. Workflows without a schema behave as before.
- Call `workflows.validateInputs` before launching and pass its version and revision to
  `runs.start` (CLI: `--workflow-version`, `--expected-workflow-revision`). Admission validates
  before it creates a run or a workspace. A resumed run uses its pinned definition and inputs.
- Sensitive values go to protected execution storage, not public run or event views.

See [typed workflow inputs](workflow-inputs.md).

## Node types

| Type | Purpose | Key fields |
| --- | --- | --- |
| `start` / `end` | Entry and exit. `end.outcome` is `success` (default), `failure` or `cancelled`. | `end.message`; `start` has none |
| `agent` | Run an agent turn and collect artifacts | `agent`, `template`/`prompt`, `inputs`, `produces`, `completion`, `vars` |
| `decision` | Choose a branch | `source` (`expression`, `artifact`, `agent`, `human`, `matrix`), `options`, `defaultOption` |
| `gate` | Human approval; can auto-approve | `question`, `options`, `autoApproveWhen`, `autoOption` |
| `set` | Assign run vars | `vars` |
| `loop` | Repeat a nested graph or workflow as child runs | `mode` (`while`, `until`, `forEach`), `condition`/`items`, `itemVar`, `indexVar`, `maxIterations`, `body`, `breakOnFailure` |
| `parallel` | Fan out child runs | `branches{}` or `forEach{items, body, key, dependsOn, workflow, workItemId}`, `concurrency`, `join` (`all`, `any`), `failFast` (default `true`) |
| `subworkflow` | Run a registered workflow as a child | `workflow`, `vars` |
| `custom:<kebab-name>` | Anything a plugin registers | Free-form |
| `custom:plan-register` | Decomposition artifact → plan | `artifact`, `plan`, `planName` |
| `custom:decision-matrix` | Score a `decision-matrix` artifact, record the decision, expose `choice` | `artifact`, `decision` |
| `custom:plan-schedule` | Compute the schedule → `vars.schedule` and `schedule.md` | `plan`, `artifactPath`, `policy`, `record` |
| `custom:plan-dispatch` | Run the item workflow for ready items, in dependency order; claims each item | `workflow` (default `vars.itemWorkflow`), `concurrency`, `scope` (`request`, `plan`), `leavesOnly` (default `true`), `onWaiting` (`defer`, `wait`), `pollMs` (default 5000), `waitTimeoutMs` (default 30 min; `0` waits forever), `failFast`, `policy` |
| `custom:plan-await` | In item workflows: wait for this item's `phase` dependencies | `phase`, `pollMs`, `timeoutMs` |
| `custom:jev-eval` | Plugin ([INTEGRATIONS](INTEGRATIONS.md)): ask JEV questions over input artifacts → `evaluation` artifact | `inputs`, `context`, `model`, `rubric`, `questions`, `maxStateChars`, `timeoutMs`, `onError`, `repeatable`, `produces` |

The plan nodes are described in [PLANNING](PLANNING.md).

**Common fields.** Every node takes `name`, `description` and `meta`. Edges take `label`. A
workflow takes `description`, `inputs` (informational) and `meta`.

**Defaults not shown above:** `loop.itemVar` `item`, `loop.indexVar` `index`,
`loop.maxIterations` 10, `parallel.concurrency` 4, `completion.maxFollowUps` 1,
`completion.maxAttempts` 1.

**`produces[]`** entries take `name`, `mediaType`, `required` and `validate` (`requiredFields`,
`fieldValues`, `minBodyLength`). **`inputs[]`** entries take `kind`/`name`, `fromNode` and `as`
(the alias under `inputs.<as>` in the prompt context).

**Field paths.** A `field` in a decision source or a validation rule reads an exact top-level
front-matter key first, then a dotted path: `answers.conflict.choice` reaches the nested value
when no key has that exact name.

**Expressions in `vars`.** Wherever a node takes `vars` (`set`, `agent`, `subworkflow`), a string
starting with `=` is an expression; anything else is a literal:
`vars: { slug: "=vars.workItem.slug", stage: "build" }`.

**Custom nodes.** A plugin executor with `validate(node)` checks its node's fields during
`orca validate` and bootstrap, so a missing field fails before any agent turn
([EXTENSIBILITY](EXTENSIBILITY.md)). A custom type no loaded plugin registers is a warning that
its fields were not checked.

### Loop iterations

Each iteration is its own child run, but it can read artifacts from earlier finished siblings
of the same `loop` step. So a review-then-fix loop works: the builder declares
`inputs: [{ kind: review, required: false }]` and gets iteration N-1's review. The same holds for
children a plugin's `custom:*` container runs one after another.

Fan-out branches never see each other: not `parallel` branches, not `custom:plan-dispatch` item
runs (even when one starts only after another finished), and not siblings bound to different
work items. In a plan, what an item needs from its dependencies arrives in `vars.upstream`.

### Parallel fan-out

- `concurrency` bounds branches in flight. `join: all` needs every branch to succeed; `join: any`
  needs one.
- With `failFast` (default), the node stops as soon as the join is decided. Unstarted branches
  are skipped and running ones cancelled. A branch parked at a gate decides nothing; the parent
  parks with it. `failFast: false` runs every branch to the end.

A `forEach` fan-out can be a small DAG. Each field is an expression per item, with
`itemVar`/`indexVar` in scope:

| Field | Meaning |
| --- | --- |
| `key` | Stable branch key (default: the index). Resume re-attaches by it. |
| `dependsOn` | Keys that must succeed first (string or list). |
| `workflow` | Workflow to run for this item instead of `body`, when non-empty. |
| `workItemId` | The `WorkItem` this branch stands for. Its child run is bound to it. |

An item whose prerequisite failed, was cancelled or was skipped never starts: the step records
`branch.skipped` with `reason: dependency`, and `join: all` fails. A prerequisite parked at a gate
just makes its dependants wait.

**Claims.** A branch with a `workItemId` claims the item first, with an atomic compare-and-set
in the `ClaimStore`. Two fan-outs over the same items cannot both launch one. The loser is
skipped with `reason: claimed`, and under `join: all` its step fails. A run re-claims its own
branches, so resume and retry work. Claims are never released automatically.

- `orca claims` lists who holds what, with the owner's status.
- `orca claims release <workItemId>` frees an item whose owner finished or whose log is gone.
  Add `--force` for a run that is paused and abandoned.

A request-scoped fan-out over `custom:materialize-work-items`' `vars.leafWorkItems` looks like
this. The shipped `program.yaml` uses `custom:plan-dispatch` instead.

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

The result has a `branches` list (`branch`, `workItemId`, `runId`, `status`, `outcome`, `ok`)
and `skipped`. `custom:plan-dispatch` publishes the same as `vars.dispatched` and
`vars.dispatchOutcome`, which `templates/program/summary.md` renders.

## Routing rules

1. Edges are evaluated in file order. The first truthy `when` wins; otherwise the first
   unconditional edge; otherwise the run fails with `WORKFLOW_INVALID`. Validation rejects more
   than one unconditional edge on built-in node types.
2. Decision and gate nodes expose `choice`. Write `when: "choice == 'x'"`, where `x` is the
   option's **id**, never its label.
3. Any node may have conditional edges, for example on `steps.build.result.data.stopReason` or
   `artifacts.spec.data.risk`.
4. Back-edges are allowed; `ai-sdlc` retries `build` that way. Bound them with vars and a `set`
   node. Use a `loop` node to repeat a whole sub-graph as isolated child runs.

## Options (`decision` and `gate`)

An option is a bare word or a record. You can mix both in one list.

```yaml
  ship-it:
    type: gate
    question: "Ship {{ workItem.slug }}?"
    options:
      - approve                        # short form: id and label are the same word
      - id: reject
        label: "Send back"
        consequence: "The build runs again from the spec."
      - id: abandon
        label: "Abandon the work item"
        consequence: "The run ends as a failure and the claim is released."
        destructive: true
```

| Field | Meaning |
| --- | --- |
| `id` | What the answer is. Used by `defaultOption`, `autoOption`, `when` edges and `human.answered`. |
| `label` | The words a person reads. Change it freely. |
| `consequence` | One clause on what the choice does. The app shows it under the label. |
| `destructive` | Safe choices sort first, then destructive ones. The first nine get number keys. If all are destructive, the first still gets `1`, but none is preselected. |

`approve` alone means `{ id: approve, label: approve }`, so older workflows need no change. A
`gate` with no `options` defaults to approve / reject.

## Human gates

`gate` nodes and `decision` nodes with `source: { kind: human }` use the `humanInput` channel in
`orca.config.yaml`:

| Channel | Behaviour |
| --- | --- |
| `pause` (default) | The run parks (`human.requested`, `step.waiting`, `run.paused`) and the process exits with code 3, printing the request id. Parents park with their children. `orca answer <requestId> <option>` from any process with store access appends `human.answered`, resumes the topmost run and re-attaches to the same children. `orca answer` alone lists open questions; `orca status <runId>` shows them too. |
| `cli` | Prompts on the terminal running ORCA. |
| `auto` | Picks the first option, or `option:`. For demos and tests. |
| ACP host (`orca acp`) | Gates are forwarded as `session/request_permission`. |

Agent `ask` permissions cannot be parked; see [Unanswerable asks](#unanswerable-asks).

## Permissions

Each `session/request_permission` is decided by the agent's policy in `orca.config.yaml`: a
`default` and an ordered list of `rules`. First match wins.

```yaml
    permissions:
      default: ask
      rules:
        - { match: { kind: execute, titlePattern: "rm -rf|git push --force" }, decision: deny }
        - { match: { kind: edit, scope: workspace }, decision: allow }
        - { match: { kind: read, path: config/keys.env }, decision: deny }
```

A `match` can name:

- `kind`, the tool kind;
- `titlePattern`, a regular expression over the tool call title;
- `path` (exact) or `pathPrefix`. Paths match as written and relative to the workspace, so a
  rule survives a new git worktree;
- `scope`: `workspace` when every location is inside the run's workspace, `outside-workspace`
  when any is not.

`decision` is `allow`, `deny` or `ask`.

**Default policy (#140).** An agent with no `permissions:`, or with no `default:`, may read,
search, edit, delete and move inside the workspace. Everything else is `ask`: `execute`
anywhere, the network, any path outside. ORCA sees a shell command only as a title, so it cannot
scope `execute`. This depends on the agent's config, not on how the run was launched. For a
sandbox, opt out in one line:

```yaml
    permissions: { default: allow }
```

### The three layers

Rules are checked in this order; first match wins:

1. your `rules:` in `orca.config.yaml`;
2. `orca.permissions.json`, the sidecar that "allow always" and "reject always" write to;
3. the defaults (the in-workspace allows above, plus `think`), **only if you left `default:`
   out**.

Then `default:` (`ask` if omitted) decides anything unmatched.

- A hand-written `deny` beats everything. Nothing a machine wrote can undo a rule you wrote
  (ADR 0009).
- **Writing `default:` turns off layer 3**, whether it is `ask` or `allow`.
  `permissions: { default: ask }` with no rules asks about everything, workspace reads included.
- Copying the defaults into your `rules:` does not restore them unchanged: it moves them ahead of
  the sidecar, where a recorded `reject_always` cannot reach them.
- `config.get` labels each effective rule with its layer (`config`, `permissions`, `default`).
- A sidecar `allow` that does not narrow anything (no `kind`; a kind and nothing else; an
  `execute` without `titlePattern`) is ignored with a warning. ORCA writes only scoped grants.
  Put wildcards in `orca.config.yaml`.
- An unreadable sidecar turns every later `allow` into `ask` until it is fixed, so its `deny`
  rules are never skipped.

### ORCA's own files

Ahead of all three layers, and beyond any rule, an agent may not:

- edit, write, move or delete the config file, `orca.permissions.json` or the store (`.orca`, or
  your `storeDir`);
- read `auth/` or the store's key directories.

`default: allow` does not change this. ORCA's `fs/read_text_file` and `fs/write_text_file`
handlers enforce it too. The store's `work/` and `program/` stay under the policy, because
deliverables go there when the workspace holds the store. An agent's built-in tools do not ask
ORCA, so in a hardened setup keep the config directory outside the workspace (ADR 0009).

### Calls the agent does not ask about

An agent asks ORCA only when its own check has no answer. Once it remembers a grant (Claude's
"always allow", a rule in its own settings), that call never reaches ORCA again, so revoking a
grant in ORCA does not affect it.

For the Claude and Codex ACP adapters on the daemon's own machine, ORCA can install a
`PreToolUse` hook in the agent's sessions to close that gap (#704, #705).

> **Experimental and not guard-qualified.** No agent has passed ORCA's enforcement acceptance
> suite (#706); the support matrix gives every agent tier `none`. Acceptance runs against the
> real agents with a scripted model show the behaviour below at the pinned versions. That is
> diagnostic evidence, not a qualification, and says nothing about an agent that tries to evade
> the hook. ORCA checks the adapter, the runtime and (for Codex) the hook's installation **once,
> when the session opens**, and not again. [Agent hook coverage](agent-hook-coverage.md) lists
> the calls the hook does not see. Treat it as an extra layer, not a sandbox.

> **Codex: the IPC caveat.** The hook decides whether Codex may run a command or apply a patch.
> It does not see what an allowed command then connects to: unix sockets, local TCP ports or
> named pipes such as a session bus, a container engine, an SSH or credential agent, or a local
> server. ORCA has not verified that Codex's sandbox keeps commands away from them. When a Codex
> session opens with the hook, ORCA logs the endpoints it can see from its own daemon. That list
> is a diagnostic, not a control. When it finds none, the log says "None detected at startup;
> isolation has not been verified." Opting in does not loosen Codex's sandbox or approvals. See
> [the IPC caveat](agent-hook-coverage.md#the-ipc-caveat).

Opt in per agent with `experimental`, which acknowledges the above:

```yaml
  - id: claude
    command: claude-agent-acp
    nativeToolHook: experimental
```

| `nativeToolHook` | Result |
| --- | --- |
| omitted or `off` | No hook is installed and nothing is refused. |
| `experimental` | The hook is installed, after the checks below. |
| `on` | Refused: it is reserved for a qualified hook. Use `experimental`. |

With the hook, the agent runs it before every hooked tool call, remembered or not. The hook
decides against the same three layers, read fresh each time:

| ORCA decides | Claude | Codex |
| --- | --- | --- |
| `allow` | Nothing added; Claude's own check still runs. ORCA never allows more than Claude would. | The same; Codex's approval and sandbox still apply. |
| `ask` | Claude asks even if it remembers a grant, and the ask comes to ORCA. | **Blocked.** A Codex hook cannot pause for a person. Give the agent `rules:` for what it should run. |
| `deny` | The call does not run. | The call does not run. |

- ORCA's own files and the hook program are refused to the agent's built-in tools too, Codex
  patches included. A hook that cannot decide blocks the call.
- An allowed call whose working directory is outside the workspace is asked about (in Codex,
  blocked).
- Calls the agent's own allow rules used to let through now follow ORCA's rules, so an
  unattended run may meet new asks (or Codex blocks). Add `rules:` for them.
- Because Codex blocks asks, the plain-language rule judge does not reach Codex
  ([plain-language rules](plain-language-rules.md#codex)).

**Where ORCA allows it.** ORCA refuses a hooked session anywhere it has not tested the hook:

1. The adapter must be `@agentclientprotocol/claude-agent-acp` or
   `@agentclientprotocol/codex-acp` at a verified version, and must say so at startup.
2. The runtime must be the exact build verified with that adapter. ORCA does not trust the
   adapter's or runtime's word. It learns only which process to inspect, checks that the process
   runs under the agent ORCA started, and hashes the image it runs against the pinned digest.
   Nothing it is told to look at is executed. For Claude, a session-start hook records its parent
   before `session/new` returns; for Codex, ORCA finds the Codex `app-server` among the agent's
   processes. Verified pairs today: **adapter 0.109.1 with Claude Code 2.1.330 (linux-x64)** and
   **codex-acp 2.9.0 with Codex 0.171.0 (linux-x64)**.
3. The agent runs on the daemon's machine, on Linux x64.
4. For Codex, ORCA also checks at startup that Codex lists ORCA's hook as trusted and enabled,
   and runs the hook once as Codex will on a call it must block. It must block with a receipt
   only ORCA's hook can sign; an exit status is not proof. The probe runs in the account's login
   shell from the user database with `-c` (not `$SHELL`, not as a login shell), with the
   environment of the running Codex process, `codex-path` first on `PATH`. A login shell other
   than bash, zsh or sh is refused. A refused probe reports a fixed reason code with bounded
   numbers, never the command's output. An agent whose own `CODEX_CONFIG` sets hooks is refused.

Until the checks pass, the session is **held**: started, but ORCA answers none of its file reads
or writes and forwards none of its asks. A session that fails is refused everything it asked for
while waiting. Only the daemon's session factory installs the hook. `orca ping` with no daemon
answering, and `orca-daemon` delegation, refuse an agent with `nativeToolHook: experimental`
instead of starting it unhooked. Ping it through a running daemon.

**MCP servers with the hook.** Claude Code would start a session's MCP servers itself, before ORCA
checked it, and would get their commands and secrets. With the hook on, ORCA runs a Claude
agent's `mcpServers` itself and serves them over the ACP connection (MCP over ACP):

- Claude Code learns each server's name only.
- A server starts on the first request after the session's checks pass. Each request is checked
  again when sent.
- Listing tools needs a live session. A tool call needs the live prompt turn, and ORCA's rules
  decide `<server>: <tool>` (kind `other`) at that moment. A deny never reaches the server; an ask
  goes to a person as a one-time allow.
- Each call is decided again when it reaches the head of the server's queue. A request has 10
  minutes from arrival for everything it waits on: admission, a person's answer, server start and
  the policy read. One that times out starts no server.
- Other MCP requests (resources, prompts) are refused. A request ends with its turn or deadline,
  and the server is told it was cancelled. A request still queued at that point is never sent.
- A server that has not answered `initialize` within 30 seconds, is still starting when the
  session closes, or loses the agent connection, is stopped. A server that answers in a way MCP
  does not allow fails that request; one whose answer matches no request is restarted.
- Servers run without the variables ORCA withholds from the agent. Their errors reach the agent
  as a code and a short, redacted message.
- A Claude adapter without MCP over ACP is refused when the agent has servers. Codex keeps its
  servers as configured; its runtime is checked before `session/new` hands them over.

**The agent's own secrets.** A `{ secret: … }` in the agent's `env` reaches it as an environment
variable, hook or not. An agent can print its environment if asked; ORCA's logs and errors redact
the values. Delivery is one strategy (`ENV_SECRET_DELIVERY`), replaceable by a key store or broker.

**What the hook does not see** ([details](agent-hook-coverage.md)): it is not an OS boundary and
sees one call's input, not every file a command touches. In Codex, text typed into a running
command (`write_stdin`) and hosted web search never reach it, and Codex's hook runner (not ORCA)
lets a call through if the hook cannot run, which is why ORCA probes it at session open.

**Other agents.** Gemini and pi take no hook yet (#705). With `nativeToolHook: experimental` they
are refused; without it, ORCA decides only what they ask about. `orca agents` shows an advisory
(not a guard) of settings it sees in an agent's command line and environment that let calls skip
ORCA: for Gemini CLI, YOLO or auto-edit in a trusted workspace, allowed-tools and policy flags, a
trusted workspace, the user's own Gemini home; for pi, always, because pi never asks. It reads no
settings files, so an empty advisory proves nothing.

#### Codex through ORCA's gate (`codexExecGate`, experimental, refused for now)

A second route for Codex, separate from the hook (#1026): every command, every byte typed into a
running command, every patch and every file request would go through ORCA's gate into an executor
in namespaces ORCA creates and checks. Opt in per agent, never with `nativeToolHook`:

```yaml
  - id: codex
    command: codex-acp
    codexExecGate: experimental
```

**Every session that asks for it is refused today**, before the agent starts, with each reason
numbered. Nothing falls back to the hook or to running without the gate; remove `codexExecGate`
to run the agent without it. Reasons, in order:

1. **Layout.** ORCA's config directory, its store, and the directory of a `--config` file (where
   named and, for a link, where it leads) must be outside every directory the agent may write,
   and none of those may be inside them, by resolved path. The default layout (config directory
   is the workspace) is refused: set `workspace:` outside the config directory.
2. **Host.** Linux x64, the system's bubblewrap and `unshare`, and no `/etc/codex`.
3. **The closed executor.** Stated gaps, not probed: a named pipe a program outside reads, what a
   command leaves in writable directories, and that the filter in place is not read back. A
   separate probe (`tools/codex-exec-host-probe.mjs`) checks whether a host can create the
   executor.
4. **Wiring.** ORCA does not start Codex on this route yet.

The route claims no support tier.

### Unanswerable asks

An `ask` goes to the `humanInput` channel, or upstream when ORCA runs as an ACP agent. **An ask
nobody can answer is refused, never parked**: a permission cannot outlive its session. `pause`
cancels it; `auto` refuses it, unless `option:` names one of the agent's own option ids (the
agent's first option is usually "allow once", so taking it would defeat the policy). Either way
the agent is told `cancelled`, the tool call fails, and the run continues. The `agent.permission`
event records `ask:allow`, `ask:deny`, `ask:cancelled` or `ask:no-answerer`.

## Completion policies (agent steps)

| Field | Meaning |
| --- | --- |
| `mode: turn-end` (default) | Wait for the prompt turn to end, then collect. |
| `mode: artifact-present` | Poll while the turn runs and cancel it once all **required** files exist. Optional files are not watched, so all-optional deliverables behave like `turn-end` (`orca validate` warns). One host round trip per poll, about every 1.5 s, never overlapping; a slow host is polled less often, up to 30 s apart. |
| `maxFollowUps` | "Your deliverable is missing or invalid" follow-ups in the same session before the attempt fails. |
| `maxAttempts` | Whole-step retries with a fresh session. Any node can set it; on an agent node the node-level value wins over `completion.maxAttempts`. A step is retried only for a retryable failure that cannot have acted outside ORCA. An agent step that already sent a prompt is not retried; it waits for a [side-effect review](recovery.md#side-effect-review). So for agent nodes, `maxAttempts` covers failures before the first prompt. |
| `timeoutMs` | Per-turn wall clock (default: the agent's `turnTimeoutMs`). ORCA then sends `session/cancel`. An agent that does not end the turn within `cancelGraceMs` (default 10 s) is killed and the step fails with `AGENT_TRANSPORT`. |

## Agent session caps

Nothing limits how many sessions a daemon opens unless you set a cap. Three optional caps bound
the whole daemon (#873):

```yaml
limits:
  maxAgentSessions: 6        # every agent session this daemon holds open, across all runs
  agentSlotWaitMs: 3600000   # optional: fail a step that waited an hour for a slot
hosts:
  - { id: box-b, type: ssh, host: box-b.example, maxSessions: 3 }   # sessions on that host
agents:
  - { id: claude, command: claude-code-acp, maxSessions: 2 }        # one provider/account
```

1. **Unlimited by default.** A cap applies only when written, as a positive integer.
2. **Slots.** Opening a session takes one slot from every cap that applies. The slot returns only
   once the agent process is confirmed gone: after the step, at the end of the run for `per-run`
   sessions, after a failed open once its process exited, or after a dropped connection is
   cleaned up. A queued open never starts beside a process still shutting down.
3. **Waiting.** Runs are admitted at once. A step without a slot waits before spawning anything,
   with `step.waiting`, `on: agent-slot` and a detail such as
   `waiting for an agent slot: 3 of 3 in use on host box-b`. `orca plan explain <slug>` shows it.
   Cancelling removes the step from the queue. A daemon restart loses nothing.
4. **Order.** Plan steps by plan priority, others by age, the two sides by age. A step for a
   different host or agent is not held up by a full one.
5. **Live config.** Caps are re-read each time, so raising one releases waiters at once.
6. **Impossible waits fail.** When a cap is full only of `per-run` sessions of the waiting step's
   own run, no slot can return. The step fails at once with `CONFIG_INVALID`, naming the cap and
   agents. Raise the cap or make those agents `per-step`.
7. **Possibly endless waits do not fail.** When slots are held by runs above the step, or by runs
   whose children wait in the queue, the wait reason adds "it may never be granted". Only
   `limits.agentSlotWaitMs`, if set, fails such a wait, with `STEP_TIMEOUT`.
8. **Remote caps (#884).** A `type: orca-daemon` agent is also held to its remote daemon's
   `limits.maxAgentSessions`, as its `hello` reports it. Until a remote has answered once since
   startup, its cap is taken as 1. The remote also enforces its cap, which bounds several parents.
9. **Unconfirmed exits.** A slot whose process exit cannot be confirmed stays held; `agents.list`
   reports `teardownUnconfirmed` and the log warns.
10. **Cancel wins.** A step cancelled while waiting, or after getting a slot but before opening,
    spawns nothing and returns the slot.
11. **Reporting.** `hello` reports the daemon cap, open sessions and queue depth. `agents.list`
    adds per-agent and per-host caps and use.

## Delegating steps to another daemon

An agent of `type: orca-daemon` starts no process. It hands each step to another ORCA daemon,
which runs a named workflow as one of its own runs (#883). The remote is reached over SSH through
the same tunnel as the app's SSH profiles (#874), with typed fields only and no ssh config file. A
remote takes delegated steps only once enrolled, and only over the enrolled host keys with the
enrolled credential. [Running across machines](MULTI-MACHINE.md) compares the options.

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
    # gitRef: refs/heads/release/0.8      # a full branch or tag the remote allows (below)
    roles: [builder]
```

### Enrolling a remote

```sh
# on build-box: its host key's fingerprint
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
# on this machine
orca remote enroll build-box --host-key SHA256:...    # plus --jump-host-key for a jump host
```

1. **Host keys.** Enrollment trusts a key only if it is pinned in
   `auth/remotes/<id>.known_hosts` (`.jump` for a jump host) or matches a fingerprint you give.
   Any other key is refused before anything is sent.
2. **Credential.** With none saved, the remote's own CLI issues one over the verified ssh:
   `<serverCommand> auth issue delegate-<this workspace id> --preset client --workflow-scope
   <each delegated workflow>` (plus `--config <serverConfig>` when set). It may start only those
   workflows and see only its own runs. It is saved as `auth/remotes/<id>.<credential id>.token`,
   readable only by this user. Enrolling again reuses it while route and host keys are unchanged;
   `orca remote enroll <id> --issue` replaces it. The ssh login must be able to run
   `remotes[].serverCommand` (default `orca`).
3. **Checks.** Before saving, enrollment checks that the remote takes delegated runs and that the
   credential can start every delegated workflow. An issued credential must be scoped to exactly
   those workflows and its own runs; one that no longer fits is replaced.
4. **Record.** Enrollment pins the keys and writes `auth/remotes/<id>.json` last, naming the
   remote's workspace, principal and credential id (never the secret). A failed or interrupted
   enrollment leaves the previous one in use.

Rules around enrollment:

- One enrollment per remote at a time (`auth/remotes/<id>.json.lock`; a lock from a dead process
  is taken over). None runs while delegations to that remote are in progress.
- A delegated step that starts during an enrollment waits for it. If the record it was about to
  use was replaced, the step is refused with nothing sent and can be retried.
- Each file is flushed with its directory, so the order survives a power loss. Windows cannot
  flush a directory, so there enrollment does not issue credentials; save one by hand.
- Every issued credential has a unique label and is listed in
  `auth/remotes/<id>.json.pending-revoke` before the request and before a newer enrollment
  replaces it. A listed credential is revoked only on the daemon that issued it, over the same
  route and keys, once that daemon lists the label. Anything that cannot be proven or revoked
  stays listed with a reason and a warning; the next enrollment retries. Otherwise run
  `orca auth revoke <credential id>` on that daemon and remove the entry.
- Enroll again after replacing the credential, or after the remote's workspace or host keys
  change on purpose (delete the old `known_hosts` file first for new keys).

To use a hand-issued credential, save it, then enroll as above:

```sh
# on build-box, in the remote daemon's workspace
orca auth issue parent-daemon --preset client --json > build-box.token
# on this machine
install -m 600 build-box.token auth/remotes/build-box.token   # or set remotes[].credentialFile
```

From then on, a delegated step opens SSH trusting only the enrolled keys, sends the bearer only if
the credential file still holds the enrolled credential, and admits nothing unless the remote names
the enrolled workspace and principal.

### How a delegated step runs

- **One remote run per task.** The rendered prompt (without ORCA's deliverable instructions) goes
  to the remote workflow's `prompt` variable. The run is admitted with `runs.admit` under a key
  derived from this run and the step's first attempt. A receipt is written under the store's
  `delegations/` first, bound to the enrollment, target and workflow; after re-enrollment or
  retargeting, an old receipt is never acted on. A retry or restart reads the receipt: it resends
  the same key while the answer is unknown, follows an admitted run, brings back artifacts of one
  that succeeded, and starts new work only once the earlier run is known to have failed or never
  been admitted.
- **Protected values stay protected (#363).** If the task holds a value this run protects (a
  `sensitive` input or a secret read for the run), the admission names the prompt variable in
  `sensitiveVars` and sends each value in `protectedValues`. The remote stores the prompt
  encrypted and redacts each value in run views, events, notifications, logs and served artifact
  bodies. The value stays in bytes the agent wrote.
  - Only a remote whose `hello` lists both fields in `admitFields` (protocol 2.11) gets such a
    task. Each admission opens its own connection, checks `hello` names the enrolled workspace and
    lists both fields, and admits on that same connection. Otherwise: reason `protocol` (fields
    missing) or `scope-changed` (other or no workspace). A broken connection restarts the
    attempt with a new check.
  - An artifact that held a protected value comes back redacted. The remote's `maxBytes` applies
    to the redacted body. The copy is checked against the size and digest the remote reports;
    that proves it arrived intact, not that redaction was complete.
  - Detection matches values as they appear in the task. A transformed value (encoded, split) is
    not recognised. Keep sensitive inputs out of delegated prompts where you can.
- **The work belongs to the remote daemon.** It shows in that daemon's run list, owned by the
  credential's principal.
- **Origin.** A remote whose `hello` lists `origin` in `admitFields` (protocol 2.6) records this
  daemon's workspace id, parent run and step as the run's `origin`. The origin is what the
  principal stated; the principal is what the remote authenticated. A step whose earlier
  admission stated an origin is refused (reason `protocol`) by a remote that no longer takes it.
- **Progress** from the remote shows as the step's agent output.
- **Remote gates are asked here** and answered back. Free-text remote questions are answered on
  the remote.
- **Cancel** cancels the remote run and never starts one. So does the turn timeout
  (`turnTimeoutMs`, default 30 minutes). If cancelled while an admission's answer is unknown, the
  key is fenced (`admissions.fence`) so no late admission can start a run. A cancel is done only
  once the remote run is seen ended.
- **Dropped connections reattach** using the stored run id and log position, until the turn's
  deadline.
- **Artifacts come back** when the remote run succeeds. Each `produces` entry is matched to an
  artifact of the remote run's succeeded steps by `name` (or `kind`), checked against the
  remote's size and sha256, and written where the step collects it.
- **Typed failures.** `DELEGATION_REFUSED` (not retried): refused credential, incompatible
  protocol, a daemon that admits no runs, unknown workflow, not enrolled, wrong credential, wrong
  workspace or principal, changed host key, failed SSH sign-in. `AGENT_TRANSPORT`: unreachable.
  `DELEGATED_RUN_FAILED`: the remote run ended without success; its error is in the step's
  details.
- **Not supported yet:** binary artifacts, and `secretEnv` on a delegating step.

### Working from a named git ref

With `gitRef`, each remote run works from that full branch or tag name (`refs/heads/feature/login`,
`refs/tags/v1.2.0`). Short names and commit ids are refused. The remote checks the ref, fetches it
from `workspace.fetchRemote` (default `origin`), and gives the run its own checkout, recorded as
`workspace.rootProvisioning` (`ref`, `baseCommit`). A retried or resumed run keeps that commit.

Choosing a ref is the remote administrator's decision. A `runs.admit` grant never lets a caller
pick one. The remote lists allowed refs in `workspace.allowedRefs` (full refs or prefixes ending
in `/*`); every other ref is refused, and all are refused when the list is empty. It also needs a
workspace that gives each run its own checkout:

```yaml
# the remote daemon's config
workspace:
  provider: git-worktree
  repo: /srv/checkouts/app
  isolateRoots: true          # each root run gets its own worktree (local Linux host)
  allowedRefs:                # the refs a delegated run may name; none by default
    - refs/heads/main
    - refs/heads/release/*
  # fetchRemote: origin
```

- **Exact ref.** The remote looks the ref up under exactly its name (never Git's suffix matching),
  remembers the object (the tag object for an annotated tag), fetches only that ref into a
  run-private ref, and refuses if the fetched object differs. The admission keeps that object, so
  creating and recovering the run use it without looking the ref up again.
- **A moved ref (#956).** If the ref moved before the run was created, admission ends with
  `GIT_REF_MOVED`. That is final for the idempotency key, even if the ref moves back. The step
  fails with `DELEGATION_REFUSED`, reason `git-ref`; a retry admits again under a new key. The
  refusal is stored with the reserved run's write-once record, so an older worker never creates
  that run. If the worker cannot record it, it answers a reconcilable failure instead.
- **A quiet fetch.** No remote-tracking refs, pruning, `FETCH_HEAD`, tags, submodules or automatic
  maintenance. No prompts (no terminal, askpass or credential manager; batch-mode SSH unless
  `core.sshCommand` is set). Deadlines: 30 seconds to list, 2 minutes to fetch.
- **A safe checkout.** Prepared outside any agent sandbox: no hooks, no fsmonitor, no submodule
  recursion, every filter driver off. Git LFS files arrive as pointers.
- **ORCA never pushes.** The ref must already be on the remote.
- **Refusals.** Another workspace provider, a disallowed, unknown or short ref, or a failing fetch
  fails the step with `DELEGATION_REFUSED`, reason `git-ref`, before admission. A remote whose
  `hello` does not list `gitRef` in `admitFields` (before protocol 2.7) is refused with reason
  `protocol`.

## MCP servers and skills for agent steps

ORCA can give an agent session **outbound** MCP servers (in ACP `session/new`) and **skills**
(#335). This is unrelated to ORCA's **inbound** MCP interface (`orca mcp`,
[MCP operator](mcp-operator.md)).

Define each server and skill once in a catalog, then select at four scopes, each applied over the
one before:

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

### Selection rules

- A selection is `replace: [...]`, or `enable` and/or `disable`. `replace` cannot be combined with
  the others.
- The config scopes (`capabilities.workspace`, `agents[].capabilities`) may list `available`:
  off by default, but a workflow or node may turn it on.
- **A workflow or node never grants more than the config permits.** It may enable only what the
  workspace or agent scope enabled or made `available`; an agent-scope `disable` or `replace`
  removes that. Anything else fails before the run, naming the field, for example
  `workflow.nodes.migrate.capabilities.mcpServers.enable[0]: ... agent 'claude' is not permitted to use it`.
- Unknown ids, duplicates, an id in both `enable` and `disable`, and a legacy inline server named
  like a catalog entry are errors at the field that caused them. Config scopes are checked at
  load; workflow and node scopes at validation and again at launch.
- **Legacy `agents[].mcpServers` still work**, as if enabled at the agent scope. Workflows and
  nodes can `disable` one by `name`.
- **One resolver decides**, used by validation, the launch preview, the launch record and session
  open. The preview lists every agent step (nested ones under qualified ids such as
  `review-loop::review`) with each server's and skill's id and deciding scope (`source`), plus a
  skill's version and digest. Never a command, argument or environment value. A nested graph uses
  its workflow's scope; a `subworkflow` uses its own workflow's.
- **Who decides.** The workspace and agent scopes are in `orca.config.yaml`, which needs config
  authority. A role override picks another configured agent, whose ceiling then applies. The host
  is the agent's configured `hostId`; a run cannot move it.
- A `per-run` session is reused only by steps with the same set.

### When a catalog server is delivered

The agent's own inline `mcpServers` are delivered as configured. A catalog server reaches a
session only when, at that session open (#337):

1. **One** current credential of the run's owner has `capabilities.use` with a grant covering the
   step's whole set, each server as defined now, on the agent's host and endpoint
   (`orca auth issue <principal> --mcp-server github@local`, or `--mcp-server '*'`; the `owner`
   preset grants all). Grants on two credentials do not combine. A grant does not follow a server
   redefined to another command or a host id moved to another machine. The decision is asked
   again after a slot wait, right before `session/new`, and before every prompt. A `per-run`
   session refused there is closed.
2. The command resolves on the **agent's host** to an executable regular file, and the agent gets
   that absolute path. Over SSH that is one `command -v`. ORCA never installs a server or tries
   another host.

Otherwise the step is refused before anything starts, naming step and server. A run with no
recorded owner, or a daemon with no use decision, refuses catalog servers at launch.

What a named grant covers:

| Part | Rule |
| --- | --- |
| Executable | Only a **trusted executable**, checked on the agent's host at every delivery: an absolute, canonical path (no symlink, `.` or `..`, no extension appended, no `PATH`), an executable regular file, owned with every parent directory up to `/` by root or the agent's account, writable by neither group nor others, with no ACL. Anything else (under `/tmp`, a symlinked `/bin/...`, a group-writable `/usr/local`, any Windows host) needs `'*'`. Bare names and relative paths need `'*'`; `orca auth issue` refuses a named grant for them. |
| Arguments | Passed exactly as configured and pinned by the grant. |
| Environment | The server's `env` is pinned, with secret references read on the agent's host under `secrets.use`. Anything else is inherited from the agent process; ORCA does not control that. |

A present executable does not prove the server works; the agent starts it over stdio.

**Availability is not permission.** ORCA decides which servers a session gets and evaluates the
[permission requests](#permissions) the agent sends. MCP calls an agent makes without asking are
between it and the server. Nothing in a skill grants anything.

### Skills

A skill is a directory or single file on the daemon's machine. ORCA never fetches or installs one.

- **Identity:** catalog id, the author's `version` label, and a content digest (`sha256:` over each
  file's relative path, size and bytes). Symlinks inside are refused.
- **Pinning:** set `digest: sha256:...` on the entry. A skill that no longer matches is refused,
  and the error shows the digest found. A step whose skill changed since launch is refused.
- **Delivery (#337):** in the prompt, not through any file system. Every prompt the step sends
  starts with each skill file as an ACP `resource` block, inline, named
  `orca-skill://<id>/<file>?digest=<sha256:...>`. Skills reach SSH hosts the same way.
- **Grant:** the run owner's single credential with `capabilities.use` must cover servers and
  skills together. A named skill grant pins the digest (`orca auth issue <principal> --skill review`),
  so an edited skill needs a new grant. `--skill '*'` and the `owner` preset cover all skills.
  Wildcards are per kind. The decision is asked again before every prompt.
- **Reading:** once at session open, hashed over exactly the bytes sent. The path is resolved once;
  every parent directory must be changeable only by root or the daemon's account (sticky
  directories like `/tmp` are fine). The walk uses open descriptors and never follows symlinks, so
  it needs a Linux daemon; elsewhere only single-file skills work, and none on Windows.
- **Budget per step:** 256 KiB in total (content plus each naming block) and 64 files and
  directories. Files must be UTF-8; a leading byte-order mark is kept.
- **Agent support:** the agent must report `promptCapabilities.embeddedContext` at `initialize`.
  Otherwise it is refused before `session/new` configures any MCP server, and the step fails. ORCA
  never drops the skill or pastes it as plain text.
- **A skill is instructions, not authority.** ORCA cannot stop an agent loading its own skills
  (for example from the user's home); those are not shown as selected.

## Secret references

An agent's `env`, or an MCP server's `env`, can name a credential instead of holding it (#336):

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

- **Delivered only under a grant.** At every session open the daemon asks whether the run's owner
  (the root run's recorded starter) may use each secret, with its provider, on its host, from
  their credentials as they are now. One credential must cover the whole use, the run's workflow
  included. Grant with `orca auth issue <principal> --secret github-token@local` (repeatable) or
  `--secret '*'`. The `owner` preset (used by the local bootstrap credential) grants all; no other
  preset grants any. A denial fails the step before anything is read, with `reason: unauthorized`.
  - Standalone mode (no credentials file): the verified OS user owns the config and its secrets.
  - `orca serve --unauthenticated-loopback`: every local run may use every reference.
  - A direct `orca run` with `--cwd` or `--agent`/`--model` records no owner and cannot use
    references. `agents.ping` never starts an agent that uses one.
  - See [secret use authority](secret-use-authority.md).
- **Only the location is configured.** `provider: env` reads a variable from the host's
  environment (the daemon's locally; the remote login shell's over SSH). `provider: file` reads an
  absolute path whole, dropping one trailing newline.
- **Read only on its own host.** Each secret is bound to one `host`. An agent may refer only to
  secrets on its `hostId`, or the config fails to load, naming the field:
  `agents[0].env.GITHUB_TOKEN: secret 'db-password' is bound to host 'build-box', but this agent runs on 'local'`.
  There is no fallback. A catalog MCP server's reference is read on its agent's host.
- **Read at every session open**, right before the agent starts, never cached. A missing value
  refuses the step before anything spawns
  (`secret 'github-token' is unavailable: environment variable GITHUB_TOKEN is not set on host 'local'`).
  A `per-run` session keeps its values for its lifetime.
- **One connection.** Locally the daemon reads values just before starting the agent. Over SSH the
  remote shell reads them, exports them, reports them back on the same connection (for redaction
  and MCP env), then becomes the agent. The remote needs `base64` and `printenv`.
- **Never on a command line.** Values travel only through environment and shell variables.
- **Only through a reference.** Every variable a `provider: env` secret reads is removed from what
  agents on that host inherit, `orca agent ping` included.
- **Never written.** Config, drafts, launch records, events and logs hold the reference, not the
  value. A read value is also replaced with `[REDACTED]` in later events and logs of the run and
  its parents, in artifact bodies before they are stored or parsed, and in session errors and
  stderr tails. This catches verbatim copies only, and does not touch files in the agent's
  workspace.
- **Moving from literals.** A literal in `env` still works but is stored in plain text and shown
  to config readers. Put the value where the host can read it, add a `secrets` entry, and replace
  the literal with `{ secret: <id> }`.

### Choosing the secret at launch

A workflow can let whoever starts the run choose which configured secret a step uses (#363):

```yaml
inputSchema:
  fields:
    deployToken: { type: secret, required: true }
nodes:
  deploy:
    type: agent
    agent: { role: deployer }
    prompt: "Deploy {{ vars.target }}; the token is in $DEPLOY_TOKEN."
    secretEnv: { DEPLOY_TOKEN: deployToken }
```

- **The launcher names a secret, never a value:** `orca run deploy --var deployToken=prod-deploy`.
  An unknown id, or one bound to another host than the step's agent, is refused before the run is
  written (`reason` `not-found` or `wrong-host`).
- **Agent environment only.** The session gets `{ secret: <id> }` under that variable and reads it
  like any reference. The value never enters the prompt or the store; `{{ vars.deployToken }}`
  renders the id.
- **Sealed at launch.** The id comes from the launch record in the private store, never from
  working vars, so a later step cannot redirect it. Inline graphs (loop bodies, parallel branches)
  get the same choice. A registered child workflow is launched on its own inputs.
- **A process per step.** A `secretEnv` step always gets its own agent process, even for a
  `per-run` agent, and holds its slot for that step only. An idle pooled session is closed first
  so it does not hold the slot (one mid-turn is closed when the turn ends). Each step asks for the
  grant and reads the value again.
- **Validated:** every `secretEnv` entry must name a top-level `secret` input. Nested `secret`
  inputs are refused.
- **Not across daemons:** a delegating step cannot use `secretEnv` (`reason: unsupported`). A daemon
  with no use check refuses it with `reason: unauthorized`.

## Templates

Templates are Markdown with front matter (`id`, `name`, `description`, `version`, `requires`,
`produces`; anything else goes to `meta`). They support `{{ expr }}`,
`{{#if}}…{{else}}…{{/if}}`, `{{#each xs as x, i}}…{{/each}}`, `{{> partial-id}}` and
`{{!-- comments --}}`. The expression language is in `packages/core/src/expr/README.md`; the
context in [DATA-MODEL](DATA-MODEL.md).

ORCA appends the **deliverables block** to every node that declares `produces`. Do not list the
files by hand. Tell the agent what good looks like: sections and front-matter fields.

### Template packs

A pack lets a run swap some templates without editing the workflow (#191). It is a directory
`templates/<pack>/` whose files have front-matter ids `<pack>/<id>`; the default `templates` glob
loads it.

- Select it with `--template-pack <name>` (CLI), `orca/template-pack` (ACP session) or
  `overrides.templatePack` (selection record).
- Every agent step resolves `<pack>/<id>` first, then `<id>`. Partials are not looked up in the
  pack.
- `orca validate --template-pack <name>` lists which templates the pack overrides and which are
  inherited. A pack that overrides nothing fails with `TEMPLATE_NOT_FOUND`, and `run`, `submit`
  and `plan dispatch` refuse it the same way.
- The shipped example is `templates/strict/`, which replaces `sdlc/review`.

## Shipped workflows

| Workflow | Flow |
| --- | --- |
| `workflows/ai-sdlc.yaml` | plan → design → spec-gate → await-deps → build ⇄ test → review ⇄ build → deploy. High-risk specs stop at the gate; `await-deps` holds the build until build-phase dependencies are met; test and review loop back with bounded budgets. |
| `workflows/program.yaml` | decompose → register → assess-risks → decide (a matrix per open decision) → schedule → plan-gate → dispatch → summarize. |
| `workflows/plan-resume.yaml` | schedule → gate → dispatch with `scope: plan`. Picks up deferred work (`orca plan dispatch`). |

**Which item workflow runs.** Neither shipped program pins it on `custom:plan-dispatch`. Both
default `vars.itemWorkflow` to `ai-sdlc`, and `orca submit` and `orca plan dispatch` set it from
`program.itemWorkflow` in `orca.config.yaml`. First match wins:

1. the item's own `workflowId`;
2. the node's `workflow`;
3. `overrides.itemWorkflow` (#186), set by `--item-workflow <id>` on `orca submit` and
   `orca plan dispatch`;
4. `vars.itemWorkflow`.

A node pin that differs from the selection logs a warning. The dispatch result's
`itemWorkflowSource` says which applied (`node`, `override`, `var`). `--workflow` on
`orca plan dispatch` picks the program workflow to run instead of `plan-resume`, never the item
workflow; one without a `custom:plan-dispatch` node is refused with `CONFIG_INVALID` (#126).

Draw any of them as Mermaid with `pnpm run orca graph <id>` or `orca validate --mermaid`.
