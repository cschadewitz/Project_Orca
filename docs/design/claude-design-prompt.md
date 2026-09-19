# Design system brief: ORCA desktop app

## Who you are and what I want

You are designing a **design system** for a new **Electron desktop app** for ORCA. I want a
system, not a one-off screen: foundations (tokens, themes), a component library spec, an
information architecture, and a small set of key screens that prove the system against real
layouts. Before committing, propose **two or three visual directions** with a short rationale
each, then continue with the one I pick.

Ask me clarifying questions whenever a choice would materially change the design. Do not
invent product features that are not described here; if a screen needs data ORCA does not
have, say so.

## What ORCA is

ORCA (Orchestration Runtime for Coding Agents) sits one level above individual coding agents
such as Claude Code, Codex or Gemini CLI. It takes a large request ("Add SSO"), breaks it into
work items, plans them against everything else it is tracking, and drives each item through a
software delivery loop (plan, design, build, test, review, deploy) by handing artifacts
(intent.md, spec.md, plan.md, test report, review) from one agent to the next. Every step runs
a user-defined **workflow graph**. Agents talk the Agent Client Protocol (ACP) and run locally
or on other machines over SSH. ORCA itself can also be driven from inside other tools
(GitKraken Kepler, Zed) as if it were a single agent.

Today ORCA is a CLI. The app is the first graphical surface. The core concepts the UI must
represent:

- **Request** — what a human asked for. Produces a tree of **work items** (epic, feature,
  task). Items move `pending → in-progress → done | failed | cancelled | blocked`.
- **Workflow** — a directed graph of nodes. Node types: `start`, `end`, `agent` (an agent turn
  that produces artifacts), `decision` (branch on an expression, an artifact, an agent, a human,
  or a decision matrix), `gate` (human approval, sometimes auto-approved), `set`, `loop`,
  `parallel` (fan-out into child runs with a join), `subworkflow`. Two shipped workflows: a
  **program** workflow (decompose → plan → decide → schedule → gate → dispatch) and a per-item
  **ai-sdlc** workflow (plan → design → gate → build → test → review → deploy, with retry loops
  back to build and "changes requested" loops back from review).
- **Run** — one execution of a workflow. Status `created → running ⇄ waiting → completed |
  failed | cancelled`. Runs nest: a program run spawns child runs per work item, loops and
  parallel branches spawn child runs too, so the natural view is a **run tree**. Each step
  records attempts, retries, the agent it used, streamed agent output and tool calls, and the
  artifacts it produced. A crashed run can be **resumed**.
- **Event log** — everything is event-sourced. The app's timeline is a replay of events
  (step started, agent update, artifact produced, human requested, human answered, run paused,
  and so on). Events are the source of truth; there is no separate "current state" store.
- **Artifacts** — versioned markdown/JSON documents handed between steps. Users will want to
  read them, diff versions, and see which step produced and consumed each one.
- **Human gates** — a run can **pause** waiting for a person to pick an option
  (approve / request changes / cancel, or a custom option list). Several runs can be waiting
  at once. Answering a gate is the single most important action in the app. Agents may also
  ask for **permission** mid-turn (run a command, write a file) which is a similar but more
  urgent interruption.
- **Plan** (long-term, across requests) — work items can depend on other items, on a
  **decision**, or on something **external**. Dependencies are `blocks`, `soft`, or `informs`
  and are `open`, `satisfied`, `failed`, or `waived`. **Risks** are scored on a likelihood ×
  impact matrix and can hold work back when exposure exceeds an appetite. **Decisions** are
  made with weighted decision matrices (options scored against criteria), can have a due date,
  and can be superseded. The **scheduler** classifies each item as `unschedulable`, `waiting`,
  `held`, `ready`, or `running`, and can **explain** why for any item. A **journal** records
  every plan change.
- **Agents and hosts** — hosts are local or SSH; each hosts one or more agents; agents are
  assigned to **roles** (planner, builder, reviewer). Each agent has a permission policy. The
  app should show handshake health per agent and which run currently **claims** which work
  item.
- **Configuration** — a YAML config file lists hosts, agents, roles, the human-input channel,
  and store locations. Workflows and prompt templates are files too.

## Who uses it and how that changes over time

**Phase 1 (now):** a single developer, me, using the app while developing ORCA itself. The
primary job is **watching test runs**: is the run progressing, what did the agent just do,
why did a step retry, which gate is waiting for me, what does the artifact say. Speed of
comprehension matters more than polish. Read-mostly, with gate answering and run
cancel/resume as the writes.

**Phase 2:** the app becomes the **first-class interface for configuration and monitoring**:
editing the config (hosts, agents, roles, policies), viewing and eventually editing workflow
graphs, inspecting and steering the long-term plan (waive a dependency, record a decision,
accept a risk). Later still, **orchestration** from the app: submit requests, dispatch
deferred work, run workflows by hand.

Design the system so phase 1 screens are not throwaway: the same components should carry
the configuration and orchestration surfaces without a re-skin.

## Surfaces to cover

1. **Runs** — run list, run tree with nested child runs, step detail (attempts, agent output
   stream, tool calls, artifacts), event timeline, waiting gates with answer controls,
   cancel and resume.
2. **Plan** — work items across requests, dependency graph, risk matrix, decision matrices,
   schedule view with per-item explanation, journal.
3. **Agents and hosts** — fleet view, per-agent health and role, permission policy, active
   claims.
4. **Config and workflows** — config editor (form over YAML, with the raw file available),
   workflow graph viewer with node detail, template viewer. Editing the graph is a later
   phase, but the viewer should be designed so editing can be added.

Plus the cross-cutting pieces: window and sidebar structure, a command palette, global
"needs your attention" surface for waiting gates and permission asks, notifications, and
deep links (opening the app straight to a run or a gate from another tool).

## Data connection states

The app connects to a long-lived ORCA daemon over WebSocket, and can fall back to reading the
event log and artifact files directly in a read-only mode. Design explicit states for:
connected and live, reconnecting, disconnected with last-known data, read-only file mode,
and "daemon version mismatch". Streaming agent output and event timelines must read well
while updating live and remain scannable when the run is finished.

## Visual character

A **calm developer tool**: clean, restrained, keyboard-first, in the spirit of Linear, Zed, or
Raycast. Density should be available (a run tree with hundreds of steps must still work) but
not the default. Status colour carries meaning and must be used sparingly and consistently:
running, waiting-on-human, succeeded, failed, cancelled, blocked, held, stale. No existing
brand; propose a palette and identity from scratch. The name suggests black and white
contrast but nothing is fixed.

## Deliverables

1. **Foundations / tokens** — colour (semantic first, primitives beneath), type scale
   (including a monospace track for logs, ids and artifacts), spacing, radius, elevation,
   motion, focus and selection styles, and status semantics. **Light and dark themes** as
   equals: tokens must hold up in both, not a dark theme with a light afterthought.
2. **Information architecture and navigation** — how runs, plan, agents and config relate;
   window layout; sidebar; command palette; attention surface; deep-link targets.
3. **Component library spec** — each component with purpose, anatomy, states, variants, and
   which surfaces use it. At minimum: run tree row, step status chip, event timeline entry,
   agent output / log pane, tool-call row, artifact viewer with version switcher, gate answer
   card, permission ask card, dependency graph node and edge, risk matrix cell, decision matrix
   table, schedule classification badge, agent health card, config form field with "raw YAML"
   affordance, workflow graph node per node type, empty / loading / error / disconnected
   states.
4. **Key screens** — high-fidelity mockups of: run tree with one step expanded and a gate
   waiting; step detail with live agent output; plan schedule with an item's explanation open;
   risk matrix; agent fleet; config editor; workflow graph viewer. Show at least one screen in
   both themes.

## Constraints

- Electron, host-agnostic: do not lean on any one OS's chrome, title bar, or system font.
  Specify a font stack that works on Linux, macOS and Windows.
- Accessibility: WCAG AA contrast in both themes, full keyboard operation, visible focus,
  status never conveyed by colour alone.
- Long-running content: runs can last hours and produce very long output; design for
  virtualised lists, sticky context, and "jump to latest" without losing your place.
- Many things can wait at once: the design must make "what needs me" obvious from any screen.
- Prefer conventions that translate directly to code (CSS custom properties, a small set of
  component primitives) since this will be implemented by developers, not a design team.

## Questions I expect you to ask me

Ask about anything that would change the design, for example: how a workflow graph should
read when a run is overlaid on it, whether artifacts are shown inline or in a side panel,
how much agent output is shown by default, and how requests, work items and runs should be
cross-linked. Ask before you draw, not after.
