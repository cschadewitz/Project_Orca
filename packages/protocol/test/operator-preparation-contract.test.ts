import { describe, expect, it } from "vitest";
import {
  OperatorMutationContracts,
  OperatorDirectCommandSchema,
  OperatorRequestCommandSchema,
} from "../src/operator-mutations.js";
import {
  OperatorBoundaryProjectionSchema,
  OperatorBoundaryPageResultSchema,
} from "../src/operator-boundary-projection.js";
import { OPERATOR_METHODS } from "../src/operator-reads.js";
import { RunsStartParamsSchema } from "../src/control.js";
import { RetryKeySchema } from "../src/admission-retry.js";
import { RevisionCommandSchema } from "../src/revision-input.js";
import {
  operatorGuards,
  operatorMutationParams,
  operatorOperationId,
  operatorProjectionFixture,
} from "./fixtures/operator-mutations.js";

describe("uninstalled operator preparation contracts", () => {
  it.each(Object.keys(operatorMutationParams) as (keyof typeof operatorMutationParams)[])(
    "validates the exact %s envelope without registering it",
    (method) => {
      expect(OperatorMutationContracts[method].params.safeParse(operatorMutationParams[method]).success).toBe(true);
      expect(
        OperatorMutationContracts[method].params.safeParse({ ...operatorMutationParams[method], principalId: "spoof" })
          .success,
      ).toBe(false);
      expect(OPERATOR_METHODS as readonly string[]).not.toContain(method);
    },
  );
  it.each(["a".repeat(128), "a".repeat(129), "é".repeat(64), "é".repeat(65), ""])(
    "uses the production UTF-8 retry bound",
    (key) => {
      const params = { ...operatorMutationParams["operator.admitRun"], retry: { idempotencyKey: key } };
      expect(OperatorMutationContracts["operator.admitRun"].params.safeParse(params).success).toBe(
        RetryKeySchema.safeParse(key).success,
      );
    },
  );
  it("requires retry intent and all captured launch guards", () => {
    const { retry: _retry, ...withoutRetry } = operatorMutationParams["operator.admitRun"];
    expect(OperatorMutationContracts["operator.admitRun"].params.safeParse(withoutRetry).success).toBe(false);
    for (const field of Object.keys(operatorGuards)) {
      const command: Record<string, unknown> = { ...operatorGuards };
      delete command[field];
      expect(OperatorDirectCommandSchema.safeParse(command).success).toBe(false);
    }
    expect(OperatorDirectCommandSchema.parse(operatorGuards)).toEqual(RunsStartParamsSchema.parse(operatorGuards));
    expect(OperatorDirectCommandSchema.safeParse({ ...operatorGuards, idempotencyKey: "nested" }).success).toBe(false);
    expect(OperatorDirectCommandSchema.safeParse({ ...operatorGuards, actor: "spoof" }).success).toBe(false);
    expect(
      OperatorRequestCommandSchema.safeParse({
        ...operatorGuards,
        title: "Request",
        body: "Work",
        vars: { request: {} },
      }).success,
    ).toBe(false);
  });
  it.each(["", "é".repeat(32768), "é".repeat(32769)])("reuses the production revision payload validation", (text) => {
    const params = operatorMutationParams["operator.revise"];
    const command = { ...params.command, payload: { kind: "text", text } };
    expect(OperatorMutationContracts["operator.revise"].params.safeParse({ ...params, command }).success).toBe(
      RevisionCommandSchema.safeParse(command).success,
    );
  });
  it("keeps Request identities and the real retry envelope, strips failure text, and refuses flat receipts", () => {
    const schema = OperatorMutationContracts["operator.admission"].result;
    const receipt = {
      state: "resolved",
      operationId: operatorOperationId,
      replayed: true,
      result: {
        state: "recoverable-failure",
        admissionId: "admission",
        requestId: "request",
        failure: { code: "RUN_STATE", message: "private detail", recovery: "reconcile" },
      },
    };
    expect(schema.parse(receipt)).toMatchObject({
      operationId: operatorOperationId,
      replayed: true,
      result: { requestId: "request", failure: { code: "RUN_STATE", recovery: "reconcile" } },
    });
    expect(JSON.stringify(schema.parse(receipt))).not.toContain("private detail");
    expect(schema.safeParse({ ...receipt.result, operationId: operatorOperationId }).success).toBe(false);
    expect(schema.safeParse({ ...receipt, result: { ...receipt.result, requestId: "" } }).success).toBe(false);
    expect(
      OperatorMutationContracts["operator.admission"].params.safeParse({
        ...operatorMutationParams["operator.admission"],
        operationId: "raw-key",
      }).success,
    ).toBe(false);
  });
  it("keeps durable answers decision-only and exact live ownership required", () => {
    const params = operatorMutationParams["operator.answer"];
    const schema = OperatorMutationContracts["operator.answer"].params;
    expect(schema.safeParse({ ...params, decision: { ...params.decision, resume: true } }).success).toBe(false);
    expect(
      schema.safeParse({ ...params, decision: { ...params.decision, always: { decision: "allow" } } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        target: params.target,
        decision: {
          lifetime: "live",
          optionId: "allow",
          live: { runId: "run", stepRunId: "step", requestId: "input" },
        },
      }).success,
    ).toBe(false);
  });
});

describe("trusted bounded row consistency validation", () => {
  it("accepts the exact pinned declaration and preserves failure/unsupported distinction", () => {
    expect(OperatorBoundaryProjectionSchema.safeParse(operatorProjectionFixture).success).toBe(true);
    for (const revisionState of ["unsupported", "unavailable"]) {
      const { revision: _revision, ...after } = operatorProjectionFixture.after;
      expect(
        OperatorBoundaryProjectionSchema.safeParse({ ...operatorProjectionFixture, after: { ...after, revisionState } })
          .success,
      ).toBe(true);
    }
  });
  it.each(["id", "runId", "stepRunId", "requestId", "kind"] as const)("rejects changed row %s", (field) => {
    expect(
      OperatorBoundaryProjectionSchema.safeParse({
        ...operatorProjectionFixture,
        after: { ...operatorProjectionFixture.after, [field]: "different" },
      }).success,
    ).toBe(false);
  });
  it("rejects contradictory states, cross-run guards, wrong filters, and undeclared/removed action restrictions", () => {
    const f = operatorProjectionFixture;
    const invalid = [
      { ...f, after: { ...f.after, revisionState: "unavailable" } },
      { ...f, after: { ...f.after, revision: undefined } },
      { ...f, after: { ...f.after, revisionActionId: undefined } },
      { ...f, declaredRevisionActionId: "other" },
      { ...f, declaredRevisionActionId: undefined },
      { ...f, params: { ...f.params, runId: undefined } },
      { ...f, params: { ...f.params, stepRunId: "other" } },
      {
        ...f,
        after: {
          ...f.after,
          revision: { ...f.after.revision, target: { ...f.after.revision.target, runId: "other" } },
        },
      },
      { ...f, after: { ...f.after, text: "injected" } },
    ];
    for (const value of invalid) expect(OperatorBoundaryProjectionSchema.safeParse(value).success).toBe(false);
  });
});

it("preserves validated enrichment in the prepared page schema without changing the installed legacy schema", () => {
  const parsed = OperatorBoundaryPageResultSchema.parse({
    target: operatorProjectionFixture.params.target,
    items: [operatorProjectionFixture.after],
    asOf: "2026-10-03T00:00:00Z",
    revision: "snapshot",
    truncated: false,
    restartRequired: false,
  });
  expect(parsed.items[0]?.revision?.target).toEqual(operatorProjectionFixture.after.revision.target);
  expect(parsed.items[0]?.revisionActionId).toBe("changes");
});
