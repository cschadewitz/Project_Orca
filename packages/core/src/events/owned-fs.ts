/**
 * What happened to each operation ORCA's own file executor authorized (#703), read from the
 * run's events. The executor writes `agent.fs.authorized` and waits for it before the I/O can
 * start, then `agent.fs.completed` after it. An authorization with no outcome means the
 * daemon stopped (or the outcome could not be written) after the operation was allowed to
 * start: whether the file was read or written is not known, so it is `execution-unknown`,
 * never assumed done or not done, and ORCA never repeats it on its own. A write that failed
 * after it may have changed the file (`effect-unknown`) is execution-unknown too.
 */
import type { OrcaEvent } from "./events.js";

export type OwnedFsExecutionState = "completed" | "failed" | "not-dispatched" | "execution-unknown";

export interface OwnedFsExecution {
  operationId: string;
  stepRunId: string;
  sessionId: string;
  turnId: string;
  access: "read" | "write";
  /** Bounded, root-relative: what the record shows of the file. */
  display: string;
  linked?: true;
  /** `bound`, `compatibility` (best effort, outside the guarantee) or `unbound` (remote). */
  io: "bound" | "compatibility" | "unbound";
  decision: string;
  /** When it was authorized. */
  at: string;
  state: OwnedFsExecutionState;
  /** A write whose outcome was recorded as failing after it may have changed the file. */
  effectUnknown?: true;
}

/** Every authorized `fs/*` operation in `events`, in order, with its state. */
export function ownedFsExecutions(events: readonly OrcaEvent[]): OwnedFsExecution[] {
  const out = new Map<string, OwnedFsExecution>();
  const settled = new Set<string>();
  for (const e of events) {
    if (e.type === "agent.fs.authorized") {
      const p = e.payload;
      // The first authorization for an id stands; a repeat cannot reset its outcome.
      if (out.has(p.operationId)) continue;
      out.set(p.operationId, {
        operationId: p.operationId,
        stepRunId: p.stepRunId,
        sessionId: p.sessionId,
        turnId: p.turnId,
        access: p.access,
        display: p.display,
        ...(p.linked ? { linked: true as const } : {}),
        io: p.io,
        decision: p.decision,
        at: e.at,
        state: "execution-unknown",
      });
    } else if (e.type === "agent.fs.completed") {
      const p = e.payload;
      const op = out.get(p.operationId);
      // An outcome is taken once, only for an authorization it follows, and only from the same
      // step, session and turn: one from anywhere else says nothing about this operation.
      if (
        op &&
        op.state === "execution-unknown" &&
        !settled.has(p.operationId) &&
        op.stepRunId === p.stepRunId &&
        op.sessionId === p.sessionId &&
        op.turnId === p.turnId
      ) {
        settled.add(p.operationId);
        op.state = p.outcome === "effect-unknown" ? "execution-unknown" : p.outcome;
        if (p.outcome === "effect-unknown") op.effectUnknown = true;
      }
    }
  }
  return [...out.values()];
}
