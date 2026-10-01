/** #330: the wire shapes of typed launch inputs and the reserved preflight. */
import { describe, expect, it } from "vitest";
import { WorkflowInputSchemaSchema } from "@orca/core/schemas";
import {
  WORKFLOWS_VALIDATE_INPUTS_METHOD,
  WorkflowInputSchemaViewSchema,
  WorkflowViewSchema,
  WorkflowsValidateInputsParamsSchema,
  WorkflowsValidateInputsResultSchema,
} from "@orca/protocol";

describe("workflows.validateInputs (#330)", () => {
  it("reserves the method name", () => {
    expect(WORKFLOWS_VALIDATE_INPUTS_METHOD).toBe("workflows.validateInputs");
  });

  it("defaults omitted vars to none", () => {
    expect(WorkflowsValidateInputsParamsSchema.parse({ workflowId: "w" })).toEqual({ workflowId: "w", vars: {} });
    expect(WorkflowsValidateInputsParamsSchema.parse({ workflowId: "w", version: "2", vars: { n: 1 } })).toEqual({
      workflowId: "w",
      version: "2",
      vars: { n: 1 },
    });
    expect(WorkflowsValidateInputsParamsSchema.safeParse({ workflowId: "" }).success).toBe(false);
  });

  it("carries the version, revision and ValidationResult - and nothing resolved", () => {
    const result = {
      workflowId: "w",
      version: "2",
      revision: "sha256:abc",
      validation: { ok: false, errors: [{ path: "vars.n", message: "is required" }], warnings: [] },
    };
    expect(WorkflowsValidateInputsResultSchema.parse(result)).toEqual(result);
    expect(WorkflowsValidateInputsResultSchema.parse({ ...result, vars: { n: 1 } })).not.toHaveProperty("vars");
  });
});

describe("input declarations on the workflow view (#330)", () => {
  it("accept everything the core declaration accepts", () => {
    const declared = WorkflowInputSchemaSchema.parse({
      unknown: "warn",
      fields: {
        n: { type: "integer", required: true, minimum: 1, default: 2, enum: [1, 2] },
        repo: { type: "object", properties: { url: { type: "string", pattern: "^git" } }, additionalProperties: false },
        tags: { type: "array", items: { type: "string" }, maxItems: 3 },
      },
    });
    expect(WorkflowInputSchemaViewSchema.parse(declared)).toEqual(declared);
  });

  it("read a newer daemon's declaration instead of failing", () => {
    const newer = { unknown: "audit", fields: { at: { type: "date-time", format: "rfc3339", items: undefined } } };
    expect(WorkflowInputSchemaViewSchema.parse(newer)).toMatchObject({
      unknown: "audit",
      fields: { at: { type: "date-time", format: "rfc3339" } },
    });
  });

  it("are optional on a workflow view", () => {
    const view = { id: "w", name: "w", version: "1", start: "s", nodes: [], edges: [] };
    expect(WorkflowViewSchema.parse(view)).toEqual(view);
    expect(WorkflowViewSchema.parse({ ...view, inputSchema: { fields: { n: { type: "integer" } } } })).toMatchObject({
      inputSchema: { fields: { n: { type: "integer" } } },
    });
  });
});
