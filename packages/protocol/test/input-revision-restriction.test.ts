/** A read-only action restriction is additive and never carries a revision capability. */
import { expect, it } from "vitest";
import { OpenInputViewSchema } from "../src/inputs.js";

const input = {
  id: "ask",
  kind: "decision",
  question: "Continue?",
  options: ["changes", "done"],
  context: {},
  runId: "run",
  runName: "Run",
  stepRunId: "step",
  requestedAt: "2026-10-02T00:00:00Z",
  waitingMs: 0,
  artifacts: [],
};
it("accepts an optional restriction without inventing revision mutation authority", () => {
  expect(OpenInputViewSchema.parse(input).revisionActionId).toBeUndefined();
  const restricted = OpenInputViewSchema.parse({ ...input, revisionActionId: "changes" });
  expect(restricted.revisionActionId).toBe("changes");
  expect(restricted.revision).toBeUndefined();
  expect(OpenInputViewSchema.safeParse({ ...input, revisionActionId: "" }).success).toBe(false);
  expect(OpenInputViewSchema.safeParse({ ...input, revisionActionId: { actionId: "changes" } }).success).toBe(false);
});
