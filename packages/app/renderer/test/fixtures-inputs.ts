/**
 * Open inputs for the Attention surface: five gates to clear in five keystrokes, a
 * permission ask, a gate with a destructive option and a gate whose artifacts are missing.
 *
 * Its own module rather than more entries in `fixtures.ts`, for the reason
 * `fixtures-artifacts.ts` and `fixtures-agents.ts` are: `fixtures.ts` is one small store
 * rendered through the read methods, and every screen test in the suite is written against
 * exactly what is in it. Five more gates in there would change what every other surface
 * shows. These are scripted onto the fake bridge by the tests that want them.
 *
 * The shapes are the protocol's and are parsed against `InputsListResultSchema` in the test
 * that uses them, so a protocol change breaks this file rather than a screen test.
 */
import type { ArtifactView, OpenInputView } from "@orca/protocol";

/** The fixture clock, shared with `fixtures.ts` so the two can be used in one test. */
const START = Date.UTC(2026, 2, 1, 9, 0, 0);
const at = (n: number): string => new Date(START + n * 1000).toISOString();

export const INPUTS_AS_OF = "2026-03-01T09:05:00.000Z";

const SPEC: ArtifactView = {
  id: "art-spec-v2",
  kind: "spec",
  name: "spec",
  version: 2,
  mediaType: "text/markdown",
  size: 412,
  createdAt: at(10),
  producedByStepRunId: "s-spec",
};

function gate(n: number, over: Partial<OpenInputView> = {}): OpenInputView {
  return {
    id: `gate-${n}`,
    kind: "decision",
    question: `Ship release ${n}?`,
    options: [
      { id: "approve", label: "Approve", consequence: "The release goes out now." },
      { id: "hold", label: "Hold", consequence: "The run stays parked." },
    ],
    context: {},
    runId: `run-${n}`,
    runName: `release ${n}`,
    stepRunId: `s-gate-${n}`,
    nodeId: "approve",
    requestedAt: at(n),
    // Longest-waiting first is the daemon's order, so the first one has waited longest.
    waitingMs: (6 - n) * 60_000,
    artifacts: [SPEC],
    ...over,
  };
}

/** Five gates, in the order `inputs.list` answers them: longest-waiting first. */
export const FIVE_GATES: readonly OpenInputView[] = [1, 2, 3, 4, 5].map((n) => gate(n));

/**
 * A gate offering a destructive option. `destructive` is the wire's own flag (#220), and the
 * card must not put this option on `1` and must not open with it selected.
 */
export const DESTRUCTIVE_GATE: OpenInputView = gate(6, {
  id: "gate-destructive",
  question: "The release is failing. Roll back?",
  options: [
    { id: "roll_back", label: "Roll back", consequence: "Reverts the deploy.", destructive: true },
    { id: "retry", label: "Retry the step", consequence: "Runs the deploy again." },
  ],
});

/**
 * A gate about an artifact the view did not carry. The app cannot show what the decision is
 * about, so it must not offer an answer to it.
 */
export const UNLOADED_GATE: OpenInputView = gate(7, {
  id: "gate-unloaded",
  question: "Approve the spec?",
  context: { artifact: "art-spec-v9" },
  artifacts: [],
});

/** A permission ask: tier 1, with the command verbatim in `context`. */
export const PERMISSION_ASK: OpenInputView = {
  id: "ask-1",
  kind: "permission",
  question: "Run a shell command?",
  options: [
    { id: "allow", label: "Allow once" },
    { id: "deny", label: "Deny", destructive: true },
  ],
  context: { command: "rm -rf build/" },
  runId: "run-1",
  runName: "release 1",
  stepRunId: "s-build",
  nodeId: "build",
  requestedAt: at(30),
  waitingMs: 30_000,
  artifacts: [],
};
