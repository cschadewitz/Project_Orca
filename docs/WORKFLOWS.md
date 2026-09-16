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
| `decision` | choose a branch | `source` (`expression` \| `artifact` \| `agent` \| `human` \| `matrix`), `options`, `defaultOption` |
| `gate` | human approval; can auto‑approve | `question`, `options`, `autoApproveWhen`, `autoOption` |
| `set` | assign run vars (values starting with `=` are expressions) | `vars` |
| `loop` | repeat a nested graph / workflow as child runs | `mode` (`while` \| `until` \| `forEach`), `condition`/`items`, `itemVar`, `indexVar`, `maxIterations`, `body`, `breakOnFailure` |
| `parallel` | fan out child runs | `branches{}` or `forEach{items, body}`, `concurrency`, `join` (`all` \| `any`), `failFast` |
| `subworkflow` | run a registered workflow as a child | `workflow`, `vars` |
| `custom:<name>` | anything a plugin registers | free‑form |
| `custom:plan-register` | decomposition artifact → plan (items, dependencies, risks, decisions) | `artifact`, `plan`, `planName` |
| `custom:decision-matrix` | score a `decision-matrix` artifact, record the decision, expose `choice` | `artifact`, `decision` (template) |
| `custom:plan-schedule` | compute the schedule → `vars.schedule` + `schedule.md` | `artifactPath`, `policy`, `record` |
| `custom:plan-dispatch` | run the item workflow for ready items, dependency‑ordered across the plan | `workflow`, `concurrency`, `scope` (`request` \| `plan`), `onWaiting` (`defer` \| `wait`), `failFast`, `policy` |
| `custom:plan-await` | (in item workflows) wait for this item's `phase` dependencies | `phase`, `pollMs`, `timeoutMs` |

The plan nodes are described in `docs/PLANNING.md`.

## Routing rules

- Edges are evaluated in file order; the first `when` that is truthy wins; otherwise the
  single unconditional edge; otherwise the run fails with `WORKFLOW_INVALID`.
- Decision/gate nodes expose their choice as `choice`; write `when: "choice == 'x'"`.
- Any node may have conditional edges (e.g. `agent` → branch on
  `steps.build.result.data.stopReason` or `artifacts.spec.data.risk`).
- Loops in the *graph* (an edge pointing backwards) are allowed and are how `ai-sdlc`
  retries `build`; bound them with vars and a `set` node. `loop` *nodes* are for
  repeating a whole sub‑graph as isolated child runs.

## Completion policies (agent steps)

- `mode: turn-end` (default): wait for the agent's prompt turn to finish, then collect.
- `mode: artifact-present`: poll the host while the turn runs and cancel the turn as soon
  as all required files exist (useful for chatty agents).
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

- `workflows/ai-sdlc.yaml` — plan → design → spec‑gate → await‑deps → build ⇄ test → review ⇄ build → deploy.
  High‑risk specs stop at the gate; `await-deps` holds the build until build‑phase
  dependencies are satisfied; tests and review loop back with bounded budgets.
- `workflows/program.yaml` — decompose → register (plan) → assess‑risks → decide (matrix per
  open decision) → schedule → plan‑gate → dispatch (ai‑sdlc per item, dependency‑ordered
  across the plan) → summarize.
- `workflows/plan-resume.yaml` — schedule → gate → dispatch with `scope: plan`; picks up
  work deferred by earlier requests (`orca plan dispatch`).

Render either as Mermaid with `npm run orca -- graph ai-sdlc`.
