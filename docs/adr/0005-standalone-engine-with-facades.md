# ADR 0005 — Standalone engine with facades instead of forking Kepler or T3 Code

**Status:** accepted

## Context
The system could live inside Kepler (closed, ACP‑based, task/worktree model), inside
T3 Code (open, TypeScript, WebSocket + event‑sourced threads), or on its own.

## Decision
Build ORCA as a standalone TypeScript engine with three thin integration surfaces:
1. **ACP facade** (`orca acp`): ORCA *is* an agent to Kepler, Zed or any ACP client (T3
   Code is not an ACP client today); workflow progress maps onto ACP `plan`/`tool_call` updates, gates onto
   `request_permission`.
2. **Kepler workspace provider**: run on the task's worktrees; read task context.
3. **T3 Code session adapter**: drive T3 threads as agent sessions via its RPC.

## Consequences
+ No dependency on either product's internals or release cadence; both remain usable as
  the human‑facing UI while ORCA owns orchestration.
+ T3 Code's open contracts make a deeper integration possible later without redesign.
− Two hops (client → ORCA → agent) add latency per update; acceptable for step‑level work.
