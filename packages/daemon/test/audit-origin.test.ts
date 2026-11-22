/** #883: a caller-stated run origin never enters an audit target, on any operation or outcome. */
import { expect, it } from "vitest";
import { targetOf } from "../src/auth/audit.js";

it("leaves a stated origin out of audit targets", () => {
  const origin = {
    workspaceId: "0b6f3c1e-4a1d-4c7e-9a52-2d6f0f8f9a11",
    runId: "run_01JD0000000000000000000000",
    stepRunId: "step_01JD0000000000000000000000",
  };
  for (const params of [
    { workflowId: "remote-task", origin },
    { workflowId: "remote-task", origin: { ...origin, stepRunId: "private-token-value" } },
    { runId: "run_01JD0000000000000000000009", origin },
  ]) {
    const target = JSON.stringify(targetOf(params) ?? {});
    for (const value of [...Object.values(origin), "private-token-value", "origin"])
      expect(target).not.toContain(value);
  }
  expect(targetOf({ workflowId: "remote-task", origin })).toEqual({ workflowId: "remote-task" });
});
