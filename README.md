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
mise install            # Node 24 + pnpm 12 (any Node >= 22 works)
pnpm install
pnpm test               # unit + end-to-end tests (scripted ACP agent, no LLM needed)
pnpm run orca validate --mermaid        # validate + draw the shipped workflows
pnpm run demo --dir /tmp/orca-demo      # full program run with scripted agents; prints the run tree (without --dir/--keep the temp workspace is removed afterwards)
```

`orca run`/`submit` need agents, so they need an `orca.config.yaml`; without one
they stop at `WORKFLOW_INVALID` (no agent fills the roles). The demo leaves a
ready-made one — scripted agents, no LLM — in its workspace, so single workflow
runs can be driven from there:

```bash
pnpm run orca --config /tmp/orca-demo/orca.config.yaml run ai-sdlc --var 'workItem={"slug":"x","title":"X"}'
pnpm run orca --config /tmp/orca-demo/orca.config.yaml runs        # runs, status <runId>, events <runId>
pnpm run orca answer <requestId> approve   # when a run pauses at a human gate (default humanInput mode)
pnpm run orca claims                       # who owns which work item; `claims release <id>` frees a dead run's
pnpm run orca leases                       # who is interpreting which run; `leases break <runId>` frees a dead one's
```

To use real agents, create `orca.config.yaml` (see `examples/orca.config.yaml`),
list your hosts/agents/roles, then `orca ping <agent>` to verify the ACP
handshake (works over SSH too) and `orca submit "Add SSO" --body-file req.md`.

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
| `packages/integrations` | ORCA as an ACP agent (proxy mode), Kepler task awareness, T3 Code adapter (groundwork). |
| `packages/cli` | `orca` command line and config bootstrap. |
| `packages/protocol` | The wire contract between the daemon and its clients: message envelope, handshake, error codes, protocol version. Zod schemas; depends on `core` only. |
| `packages/daemon` | `orca serve`: the long‑lived process that exposes the orchestrator over `protocol` (HTTP today, WebSocket for the event stream next). |
| `packages/app` | The Electron desktop app. Imports only `protocol` and `design`; everything it knows about ORCA comes over the wire from a daemon. |
| `packages/design` | The design system as code: token sources (`tokens.json`, `semantics.json`), the generator, the generated `css/tokens.css` and `src/tokens.ts`, the CSS component layer, and the contrast tests. |
| `packages/testing` | A deterministic scripted ACP agent used by tests and the demo. |
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

Groundwork release: the data model, event‑sourced engine, ACP transport (local +
SSH), workflow language, SDLC templates, the long‑term planning layer
(dependencies across requests, risk matrix, decision matrices, explainable
scheduling) and CLI are implemented and tested end‑to‑end against a real ACP
subprocess. The daemon (`orca serve`), its wire protocol and the Electron desktop app
exist as scaffolding: the handshake works end to end, no run or plan methods are served
yet (ADR 0008). The app's design system — tokens, both themes, the CSS component layer
and the surface specs — is in place (`packages/design`, `docs/design/`); the React layer
over it is not. See
`docs/ROADMAP.md` for what is deliberately left open (T3 Code WebSocket transport,
daemon methods and the event stream, capacity‑aware scheduling).
