/**
 * What the one polite live region says, as arithmetic: a `step.changed` or a `run.changed`
 * in, one sentence or nothing out (docs/design/50-accessibility-and-keyboard.md, #167).
 *
 * It is a plain module with no React and no bridge in it for the reason `card-model.ts` is:
 * the part most likely to be wrong here is *what is worth saying*, and a DOM test reads
 * that badly. `announcer.tsx` is the twenty lines that put the sentence in a region.
 *
 * Three decisions, and each is the spec's rather than this file's:
 *
 * - **Transitions and terminal states only.** The spec's rule is that streaming output is
 *   never a live region — forty lines a second would make the app unusable with a screen
 *   reader — and that what *is* announced is "step transitions and terminal states only
 *   ('build step failed, 3 attempts')". So `agent.update` and `event.appended` are not read
 *   here at all, and a run is announced only when it stops.
 * - **A step that succeeded says nothing.** Success is quiet (RULES.md rule 6): a run of
 *   forty steps would otherwise announce forty times to say nothing went wrong, and the
 *   run's own terminal state is the sentence that matters. Failure, waiting, blocked and
 *   held are the transitions a person is waiting to hear.
 * - **Never a name ORCA does not have.** `step.changed` carries `nodeId` on
 *   `step.scheduled` and on nothing after it, so the node's name is remembered from the
 *   frame that introduced the step; a step this window never saw scheduled is announced by
 *   its id rather than by a name invented for it (rule 12). The same goes for a run: the
 *   wire carries a `runId` and no name, so the id is what is said.
 */
import { STATUS_PRESENTATION, type RunStatus } from "@orca/design";
import type { RunChangedParams, StepChangedParams } from "@orca/protocol";
import { isTerminal } from "../runs/run-rows.js";

/** What a `step.scheduled` said about a step, kept until the step stops. */
export interface StepFacts {
  /** The node's name, which only `step.scheduled` carries. */
  nodeId?: string | undefined;
  /** Which attempt this step run is, so a failure can say how many there have been. */
  attempt?: number | undefined;
}

/**
 * Everything the announcer remembers between frames. Held as one value rather than as a
 * mutable map so that folding a frame is a function with a test, not a side effect.
 */
export interface AnnouncerState {
  /** By `stepRunId`, in the order the steps were first heard of. */
  readonly steps: ReadonlyMap<string, StepFacts>;
}

export const EMPTY_ANNOUNCER: AnnouncerState = { steps: new Map() };

/**
 * How many steps are remembered at once. A window left open on a long workflow would
 * otherwise hold a fact per step for as long as it stayed open; steps are forgotten when
 * they stop, and this is the bound for the ones that never do (a window that reconnects
 * into the middle of a run hears their terminal frames on nobody's behalf).
 */
export const MAX_REMEMBERED_STEPS = 500;

/** The statuses worth interrupting a person's reading for. `succeeded` is deliberately not one. */
const ANNOUNCED_STEP: readonly RunStatus[] = ["running", "waiting", "failed", "blocked", "held"];

/** What a step's transition reads as, before the attempt count and the retry note. */
const STEP_PHRASE: Partial<Record<RunStatus, string>> = {
  running: "step started",
  waiting: "step is waiting",
  failed: "step failed",
  blocked: "step is blocked",
  held: "step is held",
};

/** The fold of one `step.changed`: the new memory, and the sentence if there is one. */
export interface Folded {
  state: AnnouncerState;
  /** Absent when this transition is not worth saying out loud. */
  say?: string;
}

/**
 * Fold a `step.changed` into the announcer.
 *
 * The memory is written before the sentence is composed, so the frame that introduces a
 * step (`step.scheduled`, the only one carrying `nodeId`) names every later frame about it
 * — including its own, which is why a step scheduled and started in one breath still reads
 * as "build step started".
 */
export function foldStep(state: AnnouncerState, params: StepChangedParams): Folded {
  const steps = new Map(state.steps);
  const known = steps.get(params.stepRunId);
  const facts: StepFacts = {
    nodeId: params.nodeId ?? known?.nodeId,
    attempt: params.attempt ?? known?.attempt,
  };

  if (isTerminal(params.status)) {
    // A step that has stopped will not be heard from again, so nothing is kept for it.
    steps.delete(params.stepRunId);
  } else {
    steps.set(params.stepRunId, facts);
    // Insertion order is oldest first, so the bound drops the step heard of longest ago.
    while (steps.size > MAX_REMEMBERED_STEPS) {
      const oldest = steps.keys().next().value;
      if (oldest === undefined) break;
      steps.delete(oldest);
    }
  }

  const say = stepSentence(params, facts);
  return say === undefined ? { state: { steps } } : { state: { steps }, say };
}

/** "build step failed, 3 attempts, retrying" — or nothing at all. */
function stepSentence(params: StepChangedParams, facts: StepFacts): string | undefined {
  const phrase = ANNOUNCED_STEP.includes(params.status) ? STEP_PHRASE[params.status] : undefined;
  if (phrase === undefined) return undefined;

  // The node's name if this window ever heard it, the step run's id if it did not.
  const parts = [`${facts.nodeId ?? params.stepRunId} ${phrase}`];
  // "attempt 1" is what every step is, so it is not news; a second attempt is.
  if (facts.attempt !== undefined && facts.attempt > 1) parts.push(`${facts.attempt} attempts`);
  // What the step is parked on is the whole of why it is waiting.
  if (params.status === "waiting" && params.waitingOn !== undefined) parts.push(`on ${params.waitingOn}`);
  // A retry is not a red row and it is not a dead end either; saying so is the difference
  // between "go and look" and "wait".
  if (params.status === "failed" && params.willRetry === true) parts.push("retrying");
  return parts.join(", ");
}

/**
 * A run's terminal state — the second half of what the spec announces. A run that started,
 * paused or was re-driven says nothing here: its steps are the transitions, and a person
 * hears those.
 */
export function foldRun(params: RunChangedParams): string | undefined {
  if (!isTerminal(params.status)) return undefined;
  return `Run ${params.runId} ${STATUS_PRESENTATION[params.status].word}`;
}
