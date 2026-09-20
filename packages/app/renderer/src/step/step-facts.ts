/**
 * The facts the step detail header shows that are in the log rather than on `StepView`.
 *
 * `StepView` carries the node, the attempt, the status, the duration and `agentId` — but
 * not the **host**, and the host is the difference between "the build failed" and "the
 * build failed on the machine that has no Docker". It is in `agent.session.opened`, which
 * names the step run and so comes back with the one `runs.events({ stepRunId })` page the
 * output pane already reads. That is why this is a fold over the log and not a second call.
 *
 * The header has room for exactly one more metric beside these, and it stays empty:
 * **cost is absent on purpose**. ACP does not necessarily carry token usage and the ORCA
 * model does not mention it, so there is no number to show and approximating one is what
 * rule 12 forbids (docs/design/60-implementation.md, "What the design assumes ORCA can
 * provide", item 3). When ORCA can supply it, it goes in that slot.
 */
import type { LogEvent } from "./line-buffer.js";

/** The agent session a step ran in, as the log opened it. Every field may be absent. */
export interface StepSession {
  sessionId?: string;
  agentId?: string;
  /** The host the agent ran on — the header's fifth metric. */
  hostId?: string;
  cwd?: string;
  /** Why the session ended, when it ended badly. */
  error?: { code: string; message: string };
  /** How the last turn stopped (`end_turn`, `max_tokens`, `refusal`, …). */
  stopReason?: string;
}

/**
 * The most recently opened session in this step's log. A step that re-opened a session
 * (a follow-up turn, a resumed attempt) is shown as the session it is in now, which is the
 * one a person acting on the screen would reach.
 */
export function sessionOf(events: readonly LogEvent[]): StepSession {
  const session: StepSession = {};
  for (const event of events) {
    switch (event.type) {
      case "agent.session.opened":
        session.sessionId = event.payload.sessionId;
        session.agentId = event.payload.agentId;
        session.hostId = event.payload.hostId;
        session.cwd = event.payload.cwd;
        delete session.error;
        break;
      case "agent.turn.completed":
        session.stopReason = event.payload.stopReason;
        break;
      case "agent.session.closed":
        if (event.payload.error) {
          session.error = { code: event.payload.error.code, message: event.payload.error.message };
        }
        break;
      default:
        break;
    }
  }
  return session;
}
