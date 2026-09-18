# ADR 0003 — Single‑token interpreter, child runs for containers

**Status:** accepted

## Context
Users need decisions, loops, parallel branches and sub‑workflows. A full Petri‑net/BPMN
engine with join semantics inside one run is large and hard to reason about.

## Decision
One run executes one node at a time. `loop`, `parallel` and `subworkflow` spawn **child
runs** (own id, own log, parent links) and wait. `parallel` is the fan-out node:
`forEach.dependsOn` makes it a small DAG, so the program level needs no fan-out node of
its own. `custom:plan-dispatch` drives the launch loop itself, because its branch set is
recomputed from the live plan rather than fixed up front — but over the same `FanOut`
(`executors/containers.ts`), so concurrency, cancellation and fail-fast are defined once (#96).
Inline nested graphs are addressable (`parent::node::branch`) so they resolve on resume.
Graph back‑edges are allowed for simple retry loops, bounded by vars.

## Consequences
+ Interpreter fits in one file; every node type composes with every container.
+ Child runs are first‑class: independent workspaces, cancellation, artifact visibility.
− No cross‑branch joins inside one run; model those as sibling child runs plus a decision.
