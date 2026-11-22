/** `TurnContext.delegationId` (#883): one logical delegation across a step visit's retries. */
import { describe, expect, it } from "vitest";
import { firstAttemptOf } from "../src/executors/agent-step.js";

const step = (id: string, nodeId: string, attempt: number) => ({ id, nodeId, attempt });

describe("firstAttemptOf", () => {
  const steps = [
    step("a1", "plan", 1),
    step("b1", "hand", 1),
    step("b2", "hand", 2),
    step("b3", "hand", 3),
    step("c1", "review", 1),
    // A later visit of the same node through a back-edge starts a new delegation.
    step("b4", "hand", 1),
    step("b5", "hand", 2),
  ];
  const state = { stepOrder: steps.map((s) => s.id), steps: Object.fromEntries(steps.map((s) => [s.id, s])) };

  it("names every retry of a visit by the visit's first attempt", () => {
    expect(firstAttemptOf(state, steps[1]!)).toBe("b1");
    expect(firstAttemptOf(state, steps[2]!)).toBe("b1");
    expect(firstAttemptOf(state, steps[3]!)).toBe("b1");
  });

  it("starts again on a new visit of the same node", () => {
    expect(firstAttemptOf(state, steps[5]!)).toBe("b4");
    expect(firstAttemptOf(state, steps[6]!)).toBe("b4");
  });

  it("reads past other nodes' steps between attempts (parallel branches)", () => {
    const steps = { x1: step("x1", "x", 1), y1: step("y1", "y", 1), x2: step("x2", "x", 2) };
    expect(firstAttemptOf({ stepOrder: ["x1", "y1", "x2"], steps }, steps.x2)).toBe("x1");
  });

  it("stops where the attempt chain breaks", () => {
    const steps = { x1: step("x1", "x", 1), x3: step("x3", "x", 3) };
    expect(firstAttemptOf({ stepOrder: ["x1", "x3"], steps }, steps.x3)).toBe("x3");
  });
});
