/** Continuation wire commands cannot smuggle authority, live callbacks or standing grants. */
import { expect, it } from "vitest";
import { RunsContinueParamsSchema, RunsContinueResultSchema } from "../src/continuation-admission.js";

const command = {
  runId: "run-fixture",
  expectedBoundary: "issued-token",
  decision: { requestId: "input", optionId: "go" },
};
it("validates the frozen command/retry pair and rejects authority and live target fields", () => {
  expect(RunsContinueParamsSchema.parse({ command })).toEqual({ command, retry: {} });
  for (const extra of [{ actor: { principalId: "owner" } }, { live: {} }, { always: true }]) {
    expect(RunsContinueParamsSchema.safeParse({ command: { ...command, ...extra } }).success).toBe(false);
    expect(
      RunsContinueParamsSchema.safeParse({ command: { ...command, decision: { ...command.decision, ...extra } } })
        .success,
    ).toBe(false);
  }
  expect(RunsContinueParamsSchema.safeParse({ command, retry: { idempotencyKey: "x".repeat(129) } }).success).toBe(
    false,
  );
});

it("keeps admission and settlement distinct and requires safe operation correlation", () => {
  expect(
    RunsContinueResultSchema.safeParse({ state: "in-progress", operationId: "retry-id", recovery: "inspect-or-retry" })
      .success,
  ).toBe(true);
  const response = {
    state: "resolved",
    operationId: "retry-id",
    replayed: false,
    result: {
      operationId: "retry-id",
      continuationId: "ct-id",
      runId: command.runId,
      expectedBoundary: command.expectedBoundary,
      state: "accepted",
    },
  };
  expect(RunsContinueResultSchema.safeParse(response).success).toBe(true);
  expect(
    RunsContinueResultSchema.safeParse({ ...response, result: { ...response.result, state: "running" } }).success,
  ).toBe(false);
  expect(RunsContinueResultSchema.safeParse({ ...response, idempotencyKey: "secret-key" }).success).toBe(false);
});
