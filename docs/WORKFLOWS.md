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
| `start` / `end` | entry and exit; `end.outcome` = `success` \| `failure` \| `cancelled` | `message` |
| `agent` | run an agent turn and collect artifacts | `agent`, `template`/`prompt`, `inputs`, `produces`, `completion`, `vars` |
| `decision` | choose a branch | `source` (`expression` \| `artifact` \| `agent` \| `human`), `options`, `defaultOption` |
| `gate` | human approval; can auto‑approve | `question`, `options`, `autoApproveWhen`, `autoOption` |
| `set` | assign run vars | `vars` |
| `loop` | repeat a nested graph / workflow as child runs | `mode` (`while` \| `until` \| `forEach`), `condition`/`items`, `itemVar`, `indexVar`, `maxIterations`, `body`, `breakOnFailure` |
| `parallel` | fan out child runs | `branches{}` or `forEach{items, body}`, `concurrency`, `join` (`all` \| `any`), `failFast` |
| `subworkflow` | run a registered workflow as a child | `workflow`, `vars` |
| `custom:<name>` | anything a plugin registers | free‑form |

In every `vars` map (`set`, `agent`, `subworkflow`) a string value starting with
`=` is an expression evaluated against the step context; anything else is a
literal.

## Routing rules

- Edges are evaluated in file order; the first `when` that is truthy wins; otherwise the
  single unconditional edge; otherwise the run fails with `WORKFLOW_INVALID`.
- Decision/gate nodes expose their choice as `choice`; write `when: "choice == 'x'"`.
- Any node may have conditional edges (e.g. `agent` → branch on
  `steps.build.result.data.stopReason` or `artifacts.spec.data.risk`).
- Loops in the *graph* (an edge pointing backwards) are allowed and are how `ai-sdlc`
  retries `build`; bound them with vars and a `set` node. `loop` *nodes* are for
  repeating a whole sub‑graph as isolated child runs.

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
- `auto`: pick the first option (or `option:`) — demos and tests.
- Inside an ACP host (`orca acp`) gates are forwarded as `session/request_permission`.

## Completion policies (agent steps)

- `mode: turn-end` (default): wait for the agent's prompt turn to finish, then collect.
- `mode: artifact-present`: poll the host while the turn runs and cancel the turn as soon
  as all **required** files exist (useful for chatty agents). Optional deliverables are not
  watched, so a step whose deliverables are all `required: false` behaves like `turn-end`
  (`orca validate` warns about that combination).
- `maxFollowUps`: how many "your deliverable is missing/invalid" follow‑ups to send in the
  same session before failing the attempt.
- `maxAttempts`: whole‑step retries (fresh session each time).
- `timeoutMs`: per‑turn wall clock (defaults to the agent's `turnTimeoutMs`).

## Templates

Markdown files with front matter (`id`, `name`, `requires`, `produces`), rendered with
`{{ expr }}`, `{{#if}}…{{else}}…{{/if}}`, `{{#each xs as x, i}}…{{/each}}`,
`{{> partial-id}}` and `{{!-- comments --}}`. The expression language is documented in
`packages/core/src/expr/README.md`; the context in `docs/DATA-MODEL.md`.

ORCA always appends the **deliverables block** to the rendered prompt; do not repeat the
file list by hand. Tell the agent *what good looks like* (sections, front‑matter fields).

## Shipped workflows

- `workflows/ai-sdlc.yaml` — plan → design → spec‑gate → build ⇄ test → review ⇄ build → deploy.
  High‑risk specs stop at the gate; tests and review loop back with bounded budgets.
- `workflows/program.yaml` — decompose → materialize → plan‑gate → dispatch (ai‑sdlc per item,
  dependency‑ordered) → summarize.

Render either as Mermaid with `npm run orca -- graph ai-sdlc`.
