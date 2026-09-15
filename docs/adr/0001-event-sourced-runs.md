# ADR 0001 — Event‑sourced runs

**Status:** accepted

## Context
Runs last minutes to hours, span processes and machines, and must be auditable
("what did the reviewer actually see?"). UIs and upstream ACP clients need live progress.

## Decision
Every state change is an immutable `OrcaEvent` appended to a per‑run log; `RunState` is a
pure projection (`reduceRun`). Stores assign gap‑free `seq` per run and fan out to
subscribers after persistence. Resume = re‑reduce and continue.

## Consequences
+ Crash‑safe resume, replayable history, trivial streaming to UIs (`orchestrator.subscribe`).
+ Same model as T3 Code's decider/projector, easing a future integration.
− Executors must never mutate state directly; all writes go through `ctx.emit()`.
− Chatty agents could bloat logs; text chunks are coalesced and tool calls summarised.
