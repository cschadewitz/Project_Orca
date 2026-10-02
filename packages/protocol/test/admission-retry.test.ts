import { expect, it } from "vitest";
import {
  newAdmissionIntent,
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
