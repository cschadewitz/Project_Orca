/**
 * What happened to each operation ORCA's own file executor authorized (#703), read from the
 * run's events. The executor writes `agent.fs.authorized` and waits for it before the I/O can
 * start, then `agent.fs.completed` after it. An authorization with no outcome means the
 * daemon stopped (or the outcome could not be written) after the operation was allowed to
 * start: whether the file was read or written is not known, so it is `execution-unknown`,
 * never assumed done or not done, and ORCA never repeats it on its own.
 */
import type { OrcaEvent } from "./events.js";

export type OwnedFsExecutionState = "completed" | "failed" | "not-dispatched" | "execution-unknown";

export interface OwnedFsExecution {
  operationId: string;
  stepRunId: string;
  sessionId: string;
  access: "read" | "write";
  path: string;
  target?: string;
  decision: string;
  /** When it was authorized. */
  at: string;
  state: OwnedFsExecutionState;
}

/** Every authorized `fs/*` operation in `events`, in order, with its state. */
export function ownedFsExecutions(events: readonly OrcaEvent[]): OwnedFsExecution[] {
  const out = new Map<string, OwnedFsExecution>();
  for (const e of events) {
    if (e.type === "agent.fs.authorized") {
      const p = e.payload;
      // The first authorization for an id stands; a repeat cannot reset its outcome.
      if (out.has(p.operationId)) continue;
      out.set(p.operationId, {
        operationId: p.operationId,
        stepRunId: p.stepRunId,
        sessionId: p.sessionId,
        access: p.access,
        path: p.path,
        ...(p.target !== undefined ? { target: p.target } : {}),
        decision: p.decision,
        at: e.at,
        state: "execution-unknown",
      });
    } else if (e.type === "agent.fs.completed") {
      const op = out.get(e.payload.operationId);
      // An outcome is taken once, and only for an authorization it follows.
      if (op && op.state === "execution-unknown") op.state = e.payload.outcome;
    }
  }
  return [...out.values()];
}
