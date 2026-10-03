import { expect, it } from "vitest";
import { OperatorMutationContracts } from "../src/operator-mutations.js";
import { RevisionCommandSchema } from "../src/revision-input.js";
import { operatorMutationParams, operatorOperationId } from "./fixtures/operator-mutations.js";

it("retains real Request/direct retry identities without fabricating replay state", () => {
  for (const method of [
    "operator.submitRequest",
    "operator.admitRun",
    "operator.admission",
    "operator.reconcileAdmission",
  ] as const) {
    const request = method !== "operator.admitRun";
    const result = {
      state: "accepted",
      admissionId: "admission",
      runId: "run",
      ...(request ? { requestId: "request" } : {}),
    };
    const receipt = { state: "resolved", operationId: operatorOperationId, replayed: true, result };
    const schema = OperatorMutationContracts[method].result;
    expect(schema.parse(receipt)).toEqual(receipt);
    expect(schema.safeParse(result).success).toBe(false);
    expect(schema.safeParse({ ...receipt, replayed: undefined }).success).toBe(false);
    expect(
      schema.parse({ state: "in-progress", operationId: operatorOperationId, recovery: "inspect-or-retry" }),
    ).not.toHaveProperty("replayed");
  }
});
it("uses production revision JSON depth, finite values and nonempty UTF-8 constraints", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 40; i++) deep = { child: deep };
  for (const payload of [
    { kind: "text", text: "" },
    { kind: "text", text: "é".repeat(32769) },
    { kind: "values", values: { deep } },
    { kind: "values", values: { value: Infinity } },
  ]) {
    const params = operatorMutationParams["operator.revise"];
    const command = { ...params.command, payload };
    expect(RevisionCommandSchema.safeParse(command).success).toBe(false);
    expect(OperatorMutationContracts["operator.revise"].params.safeParse({ ...params, command }).success).toBe(false);
  }
});
it("refuses unknown secret fields in strict continuation and revision receipts", () => {
  const continuation = {
    operationId: "op",
    continuationId: "ct",
    runId: "run",
    expectedBoundary: "guard",
    state: "accepted",
  };
  expect(OperatorMutationContracts["operator.continuation"].result.parse(continuation)).toEqual(continuation);
  expect(
    OperatorMutationContracts["operator.continuation"].result.safeParse({ ...continuation, secret: "PRIVATE" }).success,
  ).toBe(false);
  const receipt = {
    revisionId: "revision",
    target: operatorMutationParams["operator.revise"].command.target,
    state: "pending",
    attemptId: "attempt",
    currentRevisionId: "revision",
    expectedRevision: "previous",
  };
  const result = { state: "resolved", operationId: "op", replayed: true, result: receipt };
  expect(OperatorMutationContracts["operator.revise"].result.parse(result)).toEqual(result);
  expect(
    OperatorMutationContracts["operator.revise"].result.safeParse({
      ...result,
      result: { ...receipt, payload: "PRIVATE" },
    }).success,
  ).toBe(false);
});
