/**
 * HumanInputPort - how the engine asks a person something (gate decisions,
 * `ask` permissions, free questions). Implementations: auto (tests/demos),
 * pausing (the run is parked in its event log until `orca answer` records an
 * answer and resumes it), CLI prompt, or an upstream ACP client when ORCA runs
 * as an agent inside Kepler/Zed.
 */
import {
  isOrcaError,
  newId,
  OrcaError,
  toGateOption,
  type Clock,
  type GateOption,
  type GateOptionInput,
  type OrcaEventInput,
} from "@orca/core";
import type { LiveInputBinding } from "./live-input.js";

export interface HumanInputQuery {
  runId: string;
  stepRunId: string;
  requestId: string;
  kind: "decision" | "permission" | "question";
  question: string;
  /**
   * Always normalised: a port sees `{ id, label, … }` whatever the caller passed.
   * Answer with the `id` - that is what is recorded and what the next attempt
   * compares against - and show the `label`.
   */
  options: GateOption[];
  context: Record<string, unknown>;
  /**
   * Fires when the run is cancelled while the question is still open. Ports
   * that park questions (a queue, a chat thread, a web UI) should drop the
   * request and reject with `CANCELLED`; the engine stops waiting either way.
   */
  signal?: AbortSignal;
  /** In-process lifetime and ownership; never persisted or accepted from a client. */
  live?: LiveInputBinding;
}

export interface HumanInputPort {
  /** Resolve with the chosen option / free text, or undefined to cancel. */
  ask(query: HumanInputQuery): Promise<string | undefined>;
  /** A live port records acceptance under the interpreter's lease before delivering it. */
  recordsAnswer?(query: HumanInputQuery): boolean;
}

/** The error a port should reject with once `query.signal` has fired. */
export function humanInputCancelled(signal?: AbortSignal): OrcaError {
  return new OrcaError("CANCELLED", String(signal?.reason ?? "cancelled"));
}

/**
 * Always answers with `option` (or the first option's id).
 *
 * With one exception, and it is the point of #140: a **permission** ask is not answered by
 * taking the first option. The options on a permission request are the agent's own, in the
 * agent's order, and the first of them is conventionally "allow once" — so picking it would
 * turn every `ask` in an unattended run back into an `allow`, silently, which is exactly
 * what the conservative default exists to stop. An unattended run has nobody to ask, so the
 * ask is refused (`undefined` → a `cancelled` outcome → the tool call fails, the run does
 * not). A sandbox that really does want blanket approval names the option it means
 * (`humanInput: { mode: auto, option: allow }`) and gets it when the agent offers that id —
 * or, better, says `permissions: { default: allow }` and is never asked in the first place.
 */
export function autoHumanInput(option?: string): HumanInputPort {
  return {
    ask: async (q) => {
      if (q.kind !== "permission") return option ?? q.options[0]?.id;
      return option !== undefined && q.options.some((o) => o.id === option) ? option : undefined;
    },
  };
}

/**
 * Wraps a port so `ask` rejects with `CANCELLED` as soon as `signal` fires,
 * even if the underlying port never settles. The signal is also forwarded on
 * the query so cooperative ports can clean up.
 */
export function abortableHumanInput(port: HumanInputPort, signal: AbortSignal): HumanInputPort {
  return {
    recordsAnswer: (query) => port.recordsAnswer?.(query) ?? false,
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
    super("HUMAN_INPUT_PENDING", `waiting for a human: ${query.question}`, {
      requestId: query.requestId,
      stepRunId: query.stepRunId,
    });
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
  emit: (input: Omit<OrcaEventInput, "runId">) => Promise<unknown>;
  clock: Clock;
  runId: string;
  stepRunId: string;
  kind: HumanInputQuery["kind"];
  question: string;
  /** Bare strings are accepted and normalised here; a workflow may still declare gate options as words. */
  options: GateOptionInput[];
  /**
   * The agent whose turn this ask is holding open, recorded on `human.requested` so an
   * attention card can name it (#248). Only the permission path has one - a workflow gate
   * is nobody's agent - and the field is absent rather than empty when it does not.
   */
  agent?: { id: string; hostId: string };
  context?: Record<string, unknown>;
  live?: LiveInputBinding;
  onRequested?: (query: HumanInputQuery) => void;
  onSettled?: (query: HumanInputQuery) => Promise<void> | void;
}): Promise<string | undefined> {
  const { emit, stepRunId } = opts;
  const query: HumanInputQuery = {
    runId: opts.runId,
    stepRunId,
    requestId: newId("hi", opts.clock.now()),
    kind: opts.kind,
    question: opts.question,
    // Normalised before the event is emitted, so nothing written from here on is a bare string.
    options: opts.options.map(toGateOption),
    context: opts.context ?? {},
    ...(opts.live ? { live: opts.live } : {}),
  };
  if (opts.live) query.context = { ...query.context, liveDecision: opts.live.identity };
  // Register before publishing input.opened, but fence acceptance until both opening
  // events are durable. A subscriber can immediately read/answer without seeing an
  // "expired" callback or recording human.answered before human.requested.
  let publish!: () => void;
  let refusePublication!: (error: unknown) => void;
  const published = new Promise<void>((resolve, reject) => {
    publish = resolve;
    refusePublication = reject;
  });
  void published.catch(() => undefined);
  const opening = new AbortController();
  const live = query.live;
  if (live && opts.port.recordsAnswer?.(query)) {
    query.live = {
      ...live,
      signal: AbortSignal.any([live.signal, opening.signal]),
      withOwnership: async (write) => {
        await published;
        return live.withOwnership(write);
      },
    };
  }
  const waiting = query.live && opts.port.recordsAnswer?.(query) ? opts.port.ask(query) : undefined;
  void waiting?.catch(() => undefined);
  let requested = false;
  try {
    await emit({
      type: "human.requested",
      payload: {
        stepRunId,
        requestId: query.requestId,
        kind: query.kind,
        question: query.question,
        options: query.options,
        ...(opts.agent ? { agent: opts.agent } : {}),
        context: query.context,
      },
    });
    requested = true;
    opts.onRequested?.(query);
    await emit({ type: "step.waiting", payload: { stepRunId, on: "human-input", detail: query.requestId } });
    publish();
    const answer = await (waiting ?? opts.port.ask(query));
    if (!opts.port.recordsAnswer?.(query))
      await emit({ type: "human.answered", payload: { stepRunId, requestId: query.requestId, answer: answer ?? "" } });
    return answer;
  } catch (error) {
    refusePublication(error);
    opening.abort("input opening failed");
    throw error;
  } finally {
    if (requested) await opts.onSettled?.(query);
  }
}
