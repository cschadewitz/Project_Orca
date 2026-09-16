/**
 * HumanInputPort - how the engine asks a person something (gate decisions,
 * `ask` permissions, free questions). Implementations: auto (tests/demos),
 * pausing (the run is parked in its event log until `orca answer` records an
 * answer and resumes it), CLI prompt, or an upstream ACP client when ORCA runs
 * as an agent inside Kepler/Zed/T3 Code.
 */
import { isOrcaError, OrcaError } from "@orca/core";

export interface HumanInputQuery {
  runId: string;
  stepRunId: string;
  requestId: string;
  kind: "decision" | "permission" | "question";
  question: string;
  options: string[];
  context: Record<string, unknown>;
}

export interface HumanInputPort {
  /** Resolve with the chosen option / free text, or undefined to cancel. */
  ask(query: HumanInputQuery): Promise<string | undefined>;
}

/** Always answers with `option` (or the first option). */
export function autoHumanInput(option?: string): HumanInputPort {
  return { ask: async (q) => option ?? q.options[0] };
}

/**
 * Thrown by a port that cannot answer in-process. The orchestrator turns it
 * into `run.paused`; the request stays pending in the run state until
 * `Orchestrator.answer()` appends `human.answered` and the run is resumed.
 */
export class HumanInputPending extends OrcaError {
  override readonly name = "HumanInputPending";
  constructor(readonly query: HumanInputQuery) {
    super("HUMAN_INPUT_PENDING", `waiting for a human: ${query.question}`, { requestId: query.requestId, stepRunId: query.stepRunId });
  }
}

export function isHumanInputPending(e: unknown): e is HumanInputPending {
  return isOrcaError(e, "HUMAN_INPUT_PENDING");
}

/**
 * Persisted wait: decisions and questions park the run (see HumanInputPending)
 * so that any process with access to the store can answer later with
 * `orca answer <requestId> <option>`. Agent `ask` permissions cannot outlive
 * the agent session that raised them, so they are cancelled instead.
 */
export class PausingHumanInput implements HumanInputPort {
  async ask(query: HumanInputQuery): Promise<string | undefined> {
    if (query.kind === "permission") return undefined;
    throw new HumanInputPending(query);
  }
}
