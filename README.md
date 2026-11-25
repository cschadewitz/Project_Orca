# ORCA — Orchestration Runtime for Coding Agents

ORCA sits **one level above** individual coding agents. It accepts a large feature or
system request, breaks it into work items, plans them against everything else it is
tracking (dependencies, risks, decisions), and drives each item through the
[AI‑native SDLC](https://academy.claude.com/courses/ai-native-sdlc-playbook/introduction)
loop — Plan → Design → Build → Test → Review → Deploy — by handing **artifacts**
(intent.md, spec.md, plan.md, test report, review, …) from one agent to the next.
Each step's prompt is rendered from a **template + the previous artifacts**; the
orchestrator watches the agent, picks up the artifact it produced, validates it,
and routes to the next node of a **user‑defined workflow graph** with decisions,
loops, parallel branches, sub‑workflows and human gates.

Agents are anything that speaks the [Agent Client Protocol (ACP)](https://agentclientprotocol.com)
— Claude Code, Codex, Gemini CLI, OpenCode, … — running **locally or on another
machine over SSH**. ORCA itself can be exposed **as an ACP agent**, so GitKraken
Kepler, Zed or any ACP client can drive it like a single agent (proxy mode).
T3 Code is *not* an ACP client today, so neither direction of the T3 Code
integration works yet — it is groundwork (see `docs/INTEGRATIONS.md`).

For an observing developer, start with the [documentation index](docs/README.md),
[architecture](docs/ARCHITECTURE.md) and [capability ledger](docs/ROADMAP.md).
The [25 October integration checkpoint](docs/archive/reviews/2026-10-25-integration-checkpoint.md)
records the current source pin, evidence classes and remaining acceptance. Reading
these needs no provider credential or running environment. Repository access is for insight;
it does not require a collaborator to install ORCA or make code changes.

```
                    ┌──────────────────────────── ORCA ─────────────────────────────┐
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
mise install            # Node 24 + pnpm 12; Node 24 is the supported floor
pnpm install --frozen-lockfile
pnpm test               # unit + end-to-end tests (scripted ACP agent, no LLM needed)
pnpm run orca validate --mermaid        # validate + draw the shipped workflows
pnpm run demo --dir /tmp/orca-demo      # full program run with scripted agents; prints the run tree (without --dir/--keep the temp workspace is removed afterwards)
```

`orca run`/`submit` need agents, so they need an `orca.config.yaml`; without one
they stop at `WORKFLOW_INVALID` (no agent fills the roles). The demo leaves a
ready-made one — scripted agents, no LLM — in its workspace, so single workflow
runs can be driven from there:

```bash
pnpm run orca --config /tmp/orca-demo/orca.config.yaml run ai-sdlc --var 'workItem={"slug":"x","title":"X","description":"Implement X"}'
pnpm run orca --config /tmp/orca-demo/orca.config.yaml runs
pnpm run orca --config /tmp/orca-demo/orca.config.yaml claims
pnpm run orca --config /tmp/orca-demo/orca.config.yaml leases
```

These commands create/use a disposable scripted workspace. Choose a new `--dir`;
the demo changes files and runs agents there. Gate answers, claim release and lease
break are operator mutations; inspect the exact workspace and owner before using
them. [Development](docs/DEVELOPMENT.md) separates checks from runtime and host actions.

A run's selections are flags, not config edits: `--agent <role>=<agentId>` and
`--model <agentId>=<modelId>` (both repeatable; a bare `--model <modelId>` when the run uses
exactly one agent) on `run`, `submit` and `plan dispatch`; `--item-workflow <id>` on `submit`
and `plan dispatch` to choose what each work item runs; `--template-pack <name>` to render
prompts from a pack under `templates/<name>/` (the shipped `strict` pack is the example).
An unknown role, agent, model or workflow is refused with the known set before the run
starts, and `orca agents` lists each agent's declared models.

To use real agents, create `orca.config.yaml` (see `examples/orca.config.yaml`),
list your hosts/agents/roles, then `orca ping <agent>` to verify the ACP
handshake (works over SSH too) and `orca submit "Add SSO" --body-file req.md`.
An agent with no `permissions:` block may read, search and change files **inside
its run's workspace**; running a shell command, and anything outside the
workspace, is `ask` (#140). Those default rules are the **last** layer — the
agent's own `rules:` are matched first, then the grants `orca.permissions.json`
recorded when somebody answered "always" — and writing `default:` at all opts
out of them: `permissions: { default: allow }` is the sandbox, and
`permissions: { default: ask }` with no rules now asks about everything,
in‑workspace reads included. See "Permissions" in `docs/WORKFLOWS.md`.

The **desktop app** is `pnpm run orca serve` with `pnpm --filter @orca/app dev`
beside it (or `ORCA_DAEMON_URL` at a daemon elsewhere; `File ▸ Open a store…`
re‑points it at a workspace with a read‑only daemon behind it). All six
surfaces have content: **Attention** (answer a gate or a permission ask),
**Runs** (run tree, event timeline, step detail, artifacts), **Plan** (the
schedule with the scheduler's own explanations, a requests sidebar and the
journal, dependency graph, risk matrix and decision matrix), **Agents** (health cards, and each agent's permission policy edited
where the grants live) and **Config** (`orca.config.yaml` as a form over the
schema the daemon describes, beside the raw file, with the permission sidecar as
its second document). **Workflows** is the sixth surface, with the viewer, owned drafts,
visual editor, validation and reviewed publication. The command palette exposes
operator actions — answer, cancel, resume, start a run, waive, decide, reopen, update a risk,
release a claim. Saving and activating are separate: [config apply](docs/configuration-generations.md)
uses exact revision/generation guards; reloadable roles, program defaults and assets
affect new launches, while agent/host/provider changes require restart. Permission
sidecars are reread on each agent permission ask. [Live permission callbacks](docs/live-input-continuity.md)
retain the original callback only while its owning process/session/turn and lease remain
valid; durable workflow gates park and resume separately. No automatic session recovery
across daemon restart is promised.

`orca serve` defaults to authenticated token mode. The source app can use
`ORCA_DAEMON_TOKEN_FILE` for that workspace; [daemon connections](docs/daemon-connection.md)
explain endpoint precedence, current authority and target/draft isolation. Remote
connections require explicit credentials and HTTPS. The [inbound MCP operator](docs/mcp-operator.md)
lets an authorized assistant inspect, preflight and operate supported work through the
same daemon services; it is distinct from MCP servers offered to downstream agents.

To run **inside Kepler / Zed / any ACP client**, register `orca acp` as an agent
command; prompts sent to it become Requests and progress streams back as ACP
plan/tool‑call updates (see `docs/INTEGRATIONS.md`).

Requests accumulate in a **long‑term plan**: work items from different requests can
depend on each other (or on a decision, or on something external), risks are scored
on a likelihood × impact matrix and can hold work for a human, and decisions are made
with weighted decision matrices before the work that needs them starts. Inspect and
steer it with `orca plan show | schedule | explain <slug> | risks | decisions | graph |
journal | depend | waive | satisfy | decide | risk` and resume deferred work across
requests with `orca plan dispatch` (see `docs/PLANNING.md`). A run interrupted by a
crash is picked up with `orca resume <runId>`.

## Repository map

| Path | What lives there |
| --- | --- |
| `packages/core` | Domain model (Request, WorkItem, Artifact, Workflow, Run, Plan/Dependency/Risk/Decision), event schema + reducer, planning algorithms (scheduler, risk matrix, decision matrix, signals), expression language, template renderer, config schema. No transports or process spawning; the only I/O is reading workflow/template files and the shared JSONL helper. |
| `packages/store` | Persistence ports and implementations: event log (memory / JSONL), artifact store (content‑addressed), document stores, plan stores + journal, work‑item claim store. |
| `packages/agents` | Hosts (local, SSH), ACP client sessions, permission policies. |
| `packages/engine` | The orchestrator (graph interpreter), node executors (agent, decision, gate, loop, parallel, subworkflow, set, custom), program service, **PlanService** and the plan nodes (`plan-register`, `decision-matrix`, `plan-schedule`, `plan-dispatch`, `plan-await`), workspace providers, plugin API. |
| `packages/integrations` | ORCA as an ACP agent (proxy mode), Kepler task awareness, T3 Code adapter (groundwork), the `custom:jev-eval` plugin (TypeSafe JEV judgments over artifacts, proof of concept). |
| `packages/cli` | `orca` command line and config bootstrap. |
| `packages/protocol` | The wire contract between the daemon and its clients: message envelope, handshake, error codes, protocol version. Zod schemas; depends on `core` only. |
| `packages/daemon` | `orca serve`: the long‑lived process that exposes the orchestrator, the workspace's configuration and the plan over `protocol` — `POST /rpc` plus `WS /socket` for the push channel. |
| `packages/app` | The Electron desktop app: `tsc`-built main and preload, a React renderer bundled by Vite. Imports only `protocol` and `design`; everything it knows about ORCA comes over the wire from a daemon. |
| `packages/design` | The design system as code: token sources (`tokens.json`, `semantics.json`), the generator, the generated `css/tokens.css` and `src/tokens.ts`, the CSS component layer, and the contrast tests. |
| `packages/testing` | A deterministic scripted ACP agent used by tests and the demo. |
| `packages/maintenance-mcp` | Independent read-only maintenance contract and refusal-only preparation; it is not an activated host-management service. |
| `workflows/` | Shipped workflow definitions: `ai-sdlc.yaml`, `program.yaml`, `plan-resume.yaml`. |
| `templates/` | Prompt templates per SDLC stage and program step (decompose, assess‑risks, decide, summary). |
| `docs/` | Architecture, data model, planning, workflow authoring, integrations, extensibility, ADRs. `docs/design/` is the desktop app's brand book, UI rules and surface specs. |

Start reading at `docs/ARCHITECTURE.md`, then `workflows/ai-sdlc.yaml` next to
`templates/sdlc/*.md`, then `packages/engine/src/orchestrator.ts` and
`packages/engine/src/executors/agent-step.ts`. For the planning layer read
`docs/PLANNING.md`, then `packages/core/src/plan/schedule.ts` and
`packages/engine/src/plan/service.ts`.

## Status

[![CI](https://github.com/cschadewitz/Project_Orca/actions/workflows/ci.yml/badge.svg)](https://github.com/cschadewitz/Project_Orca/actions/workflows/ci.yml)

The data model, event‑sourced engine, ACP transport (local + SSH), workflow language, SDLC
templates, the long‑term planning layer (dependencies across requests, risk matrix, decision
matrices, explainable scheduling) and the CLI are implemented and tested end‑to‑end against a
real ACP subprocess.

Current `main` uses **protocol 2.0** and **store epoch `operator-journals-v4`**;
the root package/release version remains **0.6.0**. Version equality does not prove that
a deployed binary contains current main. Upgrade protocol clients and daemon together.
`orca serve` answers authorized run, workflow, config and plan reads, drives runs,
edits configuration and pushes notifications over `WS /socket`; `--read-only` omits run/config/plan write methods from the handshake so
a client can hide unavailable controls (ADR 0008). Supervisor maintenance admission is
separate and remains available in read-only mode. The Electron
app provides six surfaces, including Workflows' visual editor, alongside configuration,
launch and monitoring. Document writes reread each collection
under a file lock (#196); this is not a
transaction across plan documents and their journal, nor cross-process push observation.

See the [current capability ledger and roadmap](docs/ROADMAP.md) for implemented behavior,
limitations and issue owners. Authenticated HTTP/WS, typed inputs, generation-bound
admission, durable retries, live permission continuity, protected human revisions and
production MCP composition are implemented on main. Structured collection editing,
guided Request/direct app launch, template/pack authoring and visual workflow editing
are also implemented. Core #333/#334/#355 and generic actual-Cal #393 are closed;
workflow acceptance issues #180–#182 remain open despite their shipped source.
Dry run, T3 Code transport and capacity-aware scheduling remain follow-ups.
Windows NSIS and managed Debian updating exist; Mac update/recovery composition and
delivery adapters are implemented with production activation held. Diagnostics have
composed producers and local Save/export, with production capture disabled. Signed
Apple Silicon delivery, installed N-to-N+1 recovery and unassisted physical journeys
remain unpassed. Exact-command approval #594 is still unsupported and mandatory before
Mac beta; merged offline contracts/prototypes do not supply installed-provider or
actual-Cal proof. See the [checkpoint](docs/archive/reviews/2026-10-25-integration-checkpoint.md)
for verified PRs, CI and owner decisions still pending.
The [historical architecture review](docs/archive/Current_State/README.md) preserves an earlier snapshot;
its [dated reconciliation](docs/archive/Current_State/addenda/2026-10-01-main-reconciliation.md) maps the findings to current code.
