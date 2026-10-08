import { describe, expect, expectTypeOf, it } from "vitest";
import { RunsAdmitParamsSchema, RunsAdmitResultSchema } from "@orca/protocol";
import type {
  CheckoutEvidence,
  FieldShape,
  LaunchCommand,
  LaunchResponse,
} from "../src/configuration-launch-contract.js";

describe("shared configuration and launch boundaries", () => {
  it("keeps direct commands separate from Request overrides and retry transport", () => {
    const direct = { workflowId: "sample", vars: { count: 0, enabled: false, note: "" } };
    expect(RunsAdmitParamsSchema.parse(direct).vars).toEqual(direct.vars);
    expect(RunsAdmitParamsSchema.safeParse({ ...direct, overrides: { model: "m" } }).success).toBe(false);
    expectTypeOf<Extract<LaunchCommand, { mode: "direct" }>["params"]>().not.toHaveProperty("idempotencyKey");
    expectTypeOf<Extract<LaunchCommand, { mode: "request" }>["params"]>().toHaveProperty("overrides");
  });

  it("requires an accepted direct receipt's durable IDs instead of accepting a run ID alone", () => {
    expect(RunsAdmitResultSchema.safeParse({ state: "accepted", runId: "run" }).success).toBe(false);
    expect(
      RunsAdmitResultSchema.parse({ state: "accepted", runId: "run", operationId: "op", admissionId: "admit" }),
    ).toEqual({ state: "accepted", runId: "run", operationId: "op", admissionId: "admit" });
    expectTypeOf<Extract<LaunchResponse, { kind: "request" }>["receipt"]>().not.toHaveProperty("operationId");
    expectTypeOf<Extract<LaunchResponse, { kind: "retry" }>["receipt"]>().toHaveProperty("operationId");
  });

  it("requires independent input semantics on collection and union nodes", () => {
    expectTypeOf<Extract<FieldShape, { kind: "record" }>>().toHaveProperty("value");
    expectTypeOf<Extract<FieldShape, { kind: "union" }>>().toHaveProperty("branches");
    expectTypeOf<Extract<FieldShape, { kind: "array" }>>().toHaveProperty("acceptsAbsent");
    expectTypeOf<Extract<FieldShape, { kind: "object" }>>().toHaveProperty("acceptsNull");
  });

  it("does not invent a pre-admission cwd for an owned-root source observation", () => {
    expectTypeOf<Extract<CheckoutEvidence, { profile: "owned-local-linux-source" }>>().not.toHaveProperty("cwd");
    expectTypeOf<Extract<CheckoutEvidence, { profile: "prepared-local" }>>().toHaveProperty("cwd");
  });
});
