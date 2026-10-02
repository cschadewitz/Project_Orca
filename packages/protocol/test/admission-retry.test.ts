import { expect, it } from "vitest";
import {
  newAdmissionIntent,
  RunsAdmitResultSchema,
  AdmissionInProgressSchema,
  RetryKeySchema,
  RetryRequestsSubmitParamsSchema,
  RunsAdmitParamsSchema,
} from "../src/admission-retry.js";
it("keeps a retained intent stable across serialized retries and creates new identity only for new work", () => {
  const first = newAdmissionIntent();
  expect(newAdmissionIntent(first.idempotencyKey)).toEqual(first);
  expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  expect(newAdmissionIntent()).not.toEqual(first);
  expect(Object.isFrozen(first)).toBe(true);
});
it("accepts additive retry keys and rejects injected authority, identities and callbacks", () => {
  expect(
    RetryRequestsSubmitParamsSchema.parse({ title: "ask", body: "body", idempotencyKey: "key" }).idempotencyKey,
  ).toBe("key");
  expect(RunsAdmitParamsSchema.parse({ workflowId: "program", idempotencyKey: "key" }).vars).toEqual({});
  for (const field of ["actor", "principalId", "runId", "admissionId", "operation", "callback"])
    expect(RunsAdmitParamsSchema.safeParse({ workflowId: "program", [field]: "forged" }).success).toBe(false);
  expect(RetryKeySchema.safeParse("é".repeat(64)).success).toBe(true);
  expect(RetryKeySchema.safeParse("é".repeat(65)).success).toBe(false);
});

it("requires operationId for every successful receipt and keeps in-progress out of success", () => {
  const operationId = "retry_00000000-0000-0000-0000-000000000001";
  for (const receipt of [
    { state: "prepared", admissionId: "admission" },
    { state: "accepted", admissionId: "admission", runId: "run" },
    {
      state: "recoverable-failure",
      admissionId: "admission",
      failure: { code: "RUN_STATE", message: "recover", recovery: "reconcile" },
    },
  ]) {
    expect(RunsAdmitResultSchema.safeParse(receipt).success).toBe(false);
    expect(RunsAdmitResultSchema.parse({ ...receipt, operationId })).toEqual({ ...receipt, operationId });
    expect(RunsAdmitResultSchema.safeParse({ ...receipt, operationId, idempotencyKey: "secret" }).success).toBe(false);
  }
  const pending = { state: "in-progress", operationId, recovery: "inspect-or-retry" };
  expect(AdmissionInProgressSchema.parse(pending)).toEqual(pending);
  expect(RunsAdmitResultSchema.safeParse(pending).success).toBe(false);
});
it("accepts a stable expected scope but refuses credentials and transient instances in it", () => {
  const params = {
    workflowId: "program",
    expectedScope: { principalId: "alice", workspaceId: "00000000-0000-4000-8000-000000000001" },
  };
  expect(RunsAdmitParamsSchema.parse(params).expectedScope).toEqual(params.expectedScope);
  for (const field of ["instanceId", "credentialId", "token"])
    expect(
      RunsAdmitParamsSchema.safeParse({ ...params, expectedScope: { ...params.expectedScope, [field]: "no" } }).success,
    ).toBe(false);
});
