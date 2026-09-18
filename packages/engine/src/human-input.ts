/**
 * HumanInputPort - how the engine asks a person something (gate decisions,
 * `ask` permissions, free questions). Implementations: auto (tests/demos),
 * pausing (the run is parked in its event log until `orca answer` records an
 * answer and resumes it), CLI prompt, or an upstream ACP client when ORCA runs
 * as an agent inside Kepler/Zed.
 */
import { isOrcaError, newId, OrcaError, type Clock, type OrcaEventInput } from "@orca/core";

export interface HumanInputQuery {
  runId: string;
  stepRunId: string;
  requestId: string;
  kind: "decision" | "permission" | "question";
  question: string;
  options: string[];
  context: Record<string, unknown>;
  /**
   * Fires when the run is cancelled while the question is still open. Ports
   * that park questions (a queue, a chat thread, a web UI) should drop the
   * request and reject with `CANCELLED`; the engine stops waiting either way.
   */
  signal?: AbortSignal;
}

export interface HumanInputPort {
  /** Resolve with the chosen option / free text, or undefined to cancel. */
  ask(query: HumanInputQuery): Promise<string | undefined>;
}

/** The error a port should reject with once `query.signal` has fired. */
export function humanInputCancelled(signal?: AbortSignal): OrcaError {
  return new OrcaError("CANCELLED", String(signal?.reason ?? "cancelled"));
}

/** Always answers with `option` (or the first option). */
export function autoHumanInput(option?: string): HumanInputPort {
  return { ask: async (q) => option ?? q.options[0] };
}

/**
 * Wraps a port so `ask` rejects with `CANCELLED` as soon as `signal` fires,
 * even if the underlying port never settles. The signal is also forwarded on
 * the query so cooperative ports can clean up.
 */
export function abortableHumanInput(port: HumanInputPort, signal: AbortSignal): HumanInputPort {
  return {
    ask(query) {
      if (signal.aborted) return Promise.reject(humanInputCancelled(signal));
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(humanInputCancelled(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        port
          .ask({ ...query, signal })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
  };
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
 * `orca answer <requestId> <option>`. Nothing stays live in this process, so
 * `query.signal` is irrelevant here: cancelling a parked run is an event-log
 * operation. Agent `ask` permissions cannot outlive the agent session that
 * raised them, so they are cancelled instead.
 */
export class PausingHumanInput implements HumanInputPort {
  async ask(query: HumanInputQuery): Promise<string | undefined> {
    if (query.kind === "permission") return undefined;
    throw new HumanInputPending(query);
  }
}

/**
 * The full human-input protocol for one question: mint a request id, announce
 * it (`human.requested`), park the step on it (`step.waiting`), ask the port,
 * and record the answer (`human.answered`). Gates, human decisions and agent
 * `ask` permissions all go through here so the facade and the CLI see the same
 * event sequence whoever asked.
 *
 * `onRequested` runs between the two emits (the permission path counts the ask
 * there), `onSettled` after the port settles - including when it throws, which
 * is how a pausing port parks the run (HumanInputPending) or a cancelled run
 * aborts the wait.
 */
export async function askHumanInput(opts: {
  port: HumanInputPort;
  emit(input: Omit<OrcaEventInput, "runId">): Promise<unknown>;
  clock: Clock;
  runId: string;
  stepRunId: string;
  kind: HumanInputQuery["kind"];
  question: string;
  options: string[];
  context?: Record<string, unknown>;
  onRequested?(query: HumanInputQuery): void;
  onSettled?(query: HumanInputQuery): Promise<void> | void;
}): Promise<string | undefined> {
  const { emit, stepRunId } = opts;
  const query: HumanInputQuery = {
    runId: opts.runId,
    stepRunId,
    requestId: newId("hi", opts.clock.now()),
    kind: opts.kind,
    question: opts.question,
    options: opts.options,
    context: opts.context ?? {},
  };
  await emit({ type: "human.requested", payload: { stepRunId, requestId: query.requestId, kind: query.kind, question: query.question, options: query.options, context: query.context } });
  opts.onRequested?.(query);
  await emit({ type: "step.waiting", payload: { stepRunId, on: "human-input", detail: query.requestId } });
  try {
    const answer = await opts.port.ask(query);
    await emit({ type: "human.answered", payload: { stepRunId, requestId: query.requestId, answer: answer ?? "" } });
    return answer;
  } finally {
    await opts.onSettled?.(query);
  }
}
