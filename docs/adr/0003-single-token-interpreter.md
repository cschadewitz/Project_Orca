# ADR 0003 — Single‑token interpreter, child runs for containers

**Status:** accepted

## Context
Users need decisions, loops, parallel branches and sub‑workflows. A full Petri‑net/BPMN
engine with join semantics inside one run is large and hard to reason about.

## Decision
One run executes one node at a time. `loop`, `parallel`, `subworkflow` and
`custom:dispatch-work-items` spawn **child runs** (own id, own log, parent links) and wait.
Inline nested graphs are addressable (`parent::node::branch`) so they resolve on resume.
Graph back‑edges are allowed for simple retry loops, bounded by vars.

## Consequences
+ Interpreter fits in one file; every node type composes with every container.
+ Child runs are first‑class: independent workspaces, cancellation, artifact visibility.
− No cross‑branch joins inside one run; model those as sibling child runs plus a decision.
