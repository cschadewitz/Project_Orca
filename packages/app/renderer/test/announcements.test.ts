/**
 * What the one polite live region says, and — more of the time — what it does not.
 *
 * The announcer is the app's answer to the half of rule 11 that is not a refusal: streaming
 * output is never announced, so *something* has to tell a person a step failed. That makes
 * "which frames are worth a sentence" the decision most likely to be wrong here, and it is
 * a plain function, so this is a plain test over it rather than a DOM test that would read
 * the wording through three layers of markup. The region itself is asserted in
 * `a11y-sweep.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import type { RunChangedParams, StepChangedParams } from "@orca/protocol";
import {
  EMPTY_ANNOUNCER,
  MAX_REMEMBERED_STEPS,
  foldRun,
  foldStep,
  type AnnouncerState,
} from "../src/a11y/announcements.js";

const ENVELOPE = { subscriptionId: "sub-1", runId: "run-1", seq: 1, at: "2026-03-01T09:00:00.000Z" } as const;

const step = (params: Partial<StepChangedParams> & Pick<StepChangedParams, "status">): StepChangedParams => ({
  ...ENVELOPE,
  stepRunId: "sr-1",
  event: `step.${params.status}`,
  ...params,
});

const run = (params: Partial<RunChangedParams> & Pick<RunChangedParams, "status">): RunChangedParams => ({
  ...ENVELOPE,
  event: `run.${params.status}`,
  ...params,
});

/** Fold a sequence of step frames and keep every sentence it produced. */
function say(...frames: readonly StepChangedParams[]): { said: string[]; state: AnnouncerState } {
  let state = EMPTY_ANNOUNCER;
  const said: string[] = [];
  for (const frame of frames) {
    const folded = foldStep(state, frame);
    state = folded.state;
    if (folded.say !== undefined) said.push(folded.say);
  }
  return { said, state };
}

describe("what a step transition is worth saying", () => {
  it("names the node from the frame that introduced it, on every frame after it", () => {
    // `step.scheduled` is the only frame carrying `nodeId`, so a step announced by name
    // later is a step this window remembered rather than one the wire repeated.
    const { said } = say(
      step({ status: "waiting", nodeId: "build", attempt: 1, event: "step.scheduled" }),
      step({ status: "running" }),
      step({ status: "failed" }),
    );
    expect(said).toEqual(["build step is waiting", "build step started", "build step failed"]);
  });

  it("says the id when no frame ever named the node, rather than inventing one", () => {
    // Rule 12: a window that joined mid-run never heard `step.scheduled`, and an id it can
    // be asked about is honest where a made-up name is not.
    const { said } = say(step({ status: "failed", stepRunId: "sr-9" }));
    expect(said).toEqual(["sr-9 step failed"]);
  });

  it("counts the attempts on a failure, and says nothing about the first one", () => {
    // The spec's own example sentence, whole: "build step failed, 3 attempts".
    const third = say(
      step({ status: "running", nodeId: "build", attempt: 3, event: "step.scheduled" }),
      step({ status: "failed" }),
    );
    expect(third.said[1]).toBe("build step failed, 3 attempts");

    // Every step is attempt one; saying so on each of them is noise, not news.
    const first = say(step({ status: "failed", nodeId: "build", attempt: 1 }));
    expect(first.said).toEqual(["build step failed"]);
  });

  it("says a failure that will be retried is being retried", () => {
    // A retry is not a red row (`tree-rows.ts` says the same), and the difference between
    // "go and look" and "wait" is the whole of what this word buys.
    const { said } = say(step({ status: "failed", nodeId: "build", attempt: 2, willRetry: true }));
    expect(said).toEqual(["build step failed, 2 attempts, retrying"]);
  });

  it("says what a waiting step is parked on when the frame carries it", () => {
    const withReason = say(step({ status: "waiting", nodeId: "spec-gate", waitingOn: "a decision" }));
    expect(withReason.said).toEqual(["spec-gate step is waiting, on a decision"]);
    // And says only that it is waiting when it does not.
    const without = say(step({ status: "waiting", nodeId: "spec-gate" }));
    expect(without.said).toEqual(["spec-gate step is waiting"]);
  });

  it("announces blocked and held, and never a step that succeeded or was cancelled", () => {
    const loud = say(
      step({ status: "blocked", nodeId: "deploy" }),
      step({ status: "held", nodeId: "deploy", stepRunId: "sr-2" }),
    );
    expect(loud.said).toEqual(["deploy step is blocked", "deploy step is held"]);

    /* Success is quiet (RULES.md rule 6): a forty-step run would otherwise announce forty
       times to say nothing went wrong, and the run's own terminal state is the sentence
       that matters. A cancelled step follows its run's cancellation, which is announced. */
    const quiet = say(
      step({ status: "succeeded", nodeId: "build" }),
      step({ status: "cancelled", nodeId: "build" }),
      step({ status: "stale", nodeId: "build" }),
    );
    expect(quiet.said).toEqual([]);
  });
});

describe("what the announcer remembers", () => {
  it("forgets a step once it has stopped", () => {
    const { state } = say(
      step({ status: "running", nodeId: "build", attempt: 2, event: "step.scheduled" }),
      step({ status: "succeeded" }),
    );
    expect(state.steps.has("sr-1")).toBe(false);
  });

  it("keeps the newest facts when a later frame carries them", () => {
    // A re-read after a reconnection can name the node again; the attempt it carries with
    // it is the one that counts.
    const { said } = say(
      step({ status: "running", nodeId: "build", attempt: 1, event: "step.scheduled" }),
      step({ status: "failed", attempt: 4 }),
    );
    expect(said[1]).toBe("build step failed, 4 attempts");
  });

  it("is bounded, and drops the step it heard of longest ago", () => {
    let state = EMPTY_ANNOUNCER;
    for (let n = 0; n <= MAX_REMEMBERED_STEPS; n++) {
      state = foldStep(state, step({ status: "running", stepRunId: `sr-${n}`, nodeId: `node-${n}` })).state;
    }
    expect(state.steps.size).toBe(MAX_REMEMBERED_STEPS);
    expect(state.steps.has("sr-0")).toBe(false);
    expect(state.steps.has(`sr-${MAX_REMEMBERED_STEPS}`)).toBe(true);
  });
});

describe("a run's terminal state", () => {
  it("announces the three states a run stops in, by the design's own word", () => {
    expect(foldRun(run({ status: "failed" }))).toBe("Run run-1 failed");
    expect(foldRun(run({ status: "succeeded" }))).toBe("Run run-1 succeeded");
    expect(foldRun(run({ status: "cancelled" }))).toBe("Run run-1 cancelled");
  });

  it("says nothing about a run that is still going", () => {
    // The steps are the transitions; a run that started, paused or was re-driven is heard
    // through them rather than twice.
    for (const status of ["running", "waiting", "blocked", "held", "stale"] as const) {
      expect(foldRun(run({ status }))).toBeUndefined();
    }
  });
});
