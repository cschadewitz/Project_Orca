# ORCA

This page is for anyone new to the repository. It says what ORCA does, how to run it on your
machine in a few minutes, and where to read next.

ORCA is orchestration for coding agents. It sits one level above individual agents. You give
it a large feature or system request. It:

1. breaks the request into work items;
2. plans them against everything else it tracks: dependencies, risks and decisions;
3. drives each item through the
   [AI-native SDLC](https://academy.claude.com/courses/ai-native-sdlc-playbook/introduction)
   loop: Plan → Design → Build → Test → Review → Deploy.

Each step hands **artifacts** (intent.md, spec.md, plan.md, a test report, a review, …) to the
next agent. A step's prompt is rendered from a **template plus the previous artifacts**. ORCA
watches the agent, collects and validates the artifact it produced, and moves to the next node
of a **workflow graph** you define. Graphs can have decisions, loops, parallel branches,
sub-workflows and human gates.

An agent is anything that speaks the [Agent Client Protocol (ACP)](https://agentclientprotocol.com),
such as Claude Code, Codex, Gemini CLI or OpenCode. It can run locally or on another machine
over SSH. ORCA can also act as an ACP agent itself, so GitKraken Kepler, Zed or any ACP client
can drive it. T3 Code is not an ACP client, so the T3 Code integration does not work yet
([INTEGRATIONS](docs/INTEGRATIONS.md)).

```
                    ┌───────────────────────────────────────────────────────────────┐
  Request ───────▶  │ program workflow: decompose → plan (deps, risks, decisions)    │
  (issue, Kepler    │                → decide → schedule → gate → dispatch          │
   task, ACP prompt)│      ai-sdlc workflow per item:     ▼                          │
                    │   plan ─▶ design ─▶ gate ─▶ build ─▶ test ─▶ review ─▶ deploy │
                    │     │        │              ▲  │       │  ▲     │              │
                    │  intent.md  spec.md         └──┘ retry  └──┘ changes-requested │
                    └────────┬──────────────────────┬──────────────────────┬─────────┘
                             │ ACP over stdio       │ ACP over ssh -T      ╎ T3 Code threads
                          local agent            remote agent       t3code server (groundwork)
```

## Quick start

```bash
mise install                            # Node 24 and pnpm 12
pnpm install --frozen-lockfile
pnpm test                               # unit and end-to-end tests; a scripted ACP agent, no LLM
pnpm run orca validate --mermaid        # validate and draw the shipped workflows
pnpm run demo --dir /tmp/orca-demo      # a full program run with scripted agents
```

The demo prints the run tree. Without `--dir` or `--keep` it deletes its temporary workspace
afterwards. Pick a new `--dir`: the demo changes files and runs agents there.

`orca run` and `orca submit` need agents, so they need an `orca.config.yaml`. Without one
they stop at `WORKFLOW_INVALID`. The demo leaves a config with scripted agents in its
workspace, so you can run single workflows from there:

```bash
pnpm run orca --config /tmp/orca-demo/orca.config.yaml run ai-sdlc --var 'workItem={"slug":"x","title":"X","description":"Implement X"}'
pnpm run orca --config /tmp/orca-demo/orca.config.yaml runs
pnpm run orca --config /tmp/orca-demo/orca.config.yaml claims
pnpm run orca --config /tmp/orca-demo/orca.config.yaml leases
```

Answering a gate, releasing a claim and breaking a lease change state. Check the workspace and
owner first. [DEVELOPMENT](docs/DEVELOPMENT.md) separates checks from actions that change a
host.

## Using real agents

1. Create `orca.config.yaml` from `examples/orca.config.yaml`. List your hosts, agents and
   roles.
2. Run `orca ping <agent>` to check the ACP handshake. It works over SSH too.
3. Run `orca submit "Add SSO" --body-file req.md`.

Choose agents and models per run with flags, not config edits. All flags below work on `run`,
`submit` and `plan dispatch` unless noted.

| Flag | Does |
| --- | --- |
| `--agent <role>=<agentId>` | Picks the agent for a role. Repeatable. |
| `--model <agentId>=<modelId>` | Picks a model. Repeatable. A bare `--model <modelId>` works when the run uses one agent. |
| `--item-workflow <id>` | `submit` and `plan dispatch` only: the workflow each work item runs. |
| `--template-pack <name>` | Renders prompts from `templates/<name>/`. The shipped `strict` pack is the example. |

An unknown role, agent, model or workflow is refused before the run starts, with the known
values listed. `orca agents` lists each agent's declared models.

### Default permissions

An agent with no `permissions:` block may read, search and change files inside its run's
workspace. A shell command, or anything outside the workspace, is `ask` (#140).

Rules are matched in this order:

1. the agent's own `rules:`;
2. grants recorded in `orca.permissions.json` when someone answered "always";
3. the defaults above.

Writing `default:` at all turns the defaults off. `permissions: { default: allow }` is a
sandbox. `permissions: { default: ask }` with no rules asks about everything, including reads
in the workspace. See "Permissions" in [WORKFLOWS](docs/WORKFLOWS.md).

## The desktop app

Run `pnpm run orca serve` with `pnpm --filter @orca/app dev` beside it. To use a daemon
elsewhere, set `ORCA_DAEMON_URL`. **File ▸ Open a store…** opens a workspace read-only.

| Surface | What you do there |
| --- | --- |
| Attention | Answer a gate or a permission ask. |
| Runs | Run tree, event timeline, step detail, artifacts. |
| Plan | The schedule with the scheduler's reasons, requests, journal, dependency graph, risk matrix and decision matrix. |
| Agents | Health cards, and each agent's permission policy. |
| Config | `orca.config.yaml` as a form beside the raw file, with the permission sidecar as a second document. |
| Workflows | Viewer, drafts, visual editor, validation and publishing. |

The command palette (answer, cancel, resume, start a run, waive, decide, reopen, update a
risk, release a claim) works across them.

- Saving config and activating it are separate steps. Reloadable roles, program defaults and
  assets affect new launches. Agent, host and provider changes need a restart
  ([configuration generations](docs/configuration-generations.md)).
- Permission sidecars are re-read on each permission ask.
- A live permission ask survives only while its process, session, turn and lease are valid.
  Workflow gates park and resume separately. Sessions are not recovered after a daemon restart
  ([live input continuity](docs/live-input-continuity.md)).

`orca serve` uses token authentication by default. The source-built app can read the token from
`ORCA_DAEMON_TOKEN_FILE`. Remote connections need explicit credentials and HTTPS
([daemon connections](docs/daemon-connection.md)).

## Other ways in

- **From an ACP client** (Kepler, Zed, …): register `orca acp` as an agent command. Prompts
  become Requests, and progress streams back as ACP plan and tool-call updates
  ([INTEGRATIONS](docs/INTEGRATIONS.md)).
- **From an assistant over MCP:** the [inbound MCP operator](docs/mcp-operator.md) lets an
  authorized assistant inspect and operate work through the daemon. It is separate from the MCP
  servers ORCA offers to agents.

## The long-term plan

Requests add to one plan. Work items can depend on each other across requests, on a decision,
or on something external. Risks are scored on a likelihood × impact matrix and can hold work
for a person. Decisions use weighted decision matrices before the work that needs them starts.

- Inspect and steer: `orca plan show | schedule | explain <slug> | risks | decisions | graph |
  journal | depend | waive | satisfy | decide | risk`.
- Resume deferred work: `orca plan dispatch`.
- Resume a run after a crash: `orca resume <runId>`.

See [PLANNING](docs/PLANNING.md).

## Repository map

| Path | What lives there |
| --- | --- |
| `packages/core` | Domain model, event schema and reducer, planning algorithms, expression language, template renderer, config schema. No transports or process spawning. |
| `packages/store` | Persistence: event log, content-addressed artifact store, document and plan stores, journal, claim store. |
| `packages/agents` | Hosts (local, SSH), ACP client sessions, permission policies. |
| `packages/engine` | The orchestrator, node executors, program service, `PlanService` and plan nodes, workspace providers, plugin API. |
| `packages/integrations` | ORCA as an ACP agent, Kepler task awareness, T3 Code adapter (groundwork), the `custom:jev-eval` plugin (proof of concept). |
| `packages/cli` | The `orca` command line and config bootstrap. |
| `packages/protocol` | The wire contract between daemon and clients. Zod schemas; depends on `core` only. |
| `packages/daemon` | `orca serve`: `POST /rpc` plus `WS /socket` for pushes. |
| `packages/app` | The Electron desktop app. Imports only `protocol` and `design`. |
| `packages/design` | The design system as code: tokens, generator, CSS component layer, contrast tests. |
| `packages/testing` | A scripted ACP agent for tests and the demo. |
| `packages/maintenance-mcp` | A read-only maintenance contract. Not an active host-management service. |
| `workflows/` | Shipped workflows: `ai-sdlc.yaml`, `program.yaml`, `plan-resume.yaml`. |
| `templates/` | Prompt templates per SDLC stage and program step, plus the `strict` pack. |
| `docs/` | All documentation. Start at the [index](docs/README.md). |

To read the code, start with [ARCHITECTURE](docs/ARCHITECTURE.md), then
`workflows/ai-sdlc.yaml` beside `templates/sdlc/*.md`, then
`packages/engine/src/orchestrator.ts` and `packages/engine/src/executors/agent-step.ts`. For
planning, read [PLANNING](docs/PLANNING.md), then `packages/core/src/plan/schedule.ts` and
`packages/engine/src/plan/service.ts`.

## Status

[![CI](https://github.com/cschadewitz/Project_Orca/actions/workflows/ci.yml/badge.svg)](https://github.com/cschadewitz/Project_Orca/actions/workflows/ci.yml)

The [capability ledger](docs/ROADMAP.md) says what works, what is limited and which issue owns
each gap. The [CHANGELOG](CHANGELOG.md) lists what each release shipped. Upgrade the daemon and
its clients together.
