/**
 * #330: the daemon half of typed launch inputs - the reserved `workflows.validateInputs`
 * model (not yet registered as a method) and the declaration in the `workflows.get` view.
 */
import { describe, expect, it } from "vitest";
import { parseWorkflow, type WorkflowDefinition } from "@orca/core";
import { workflowRevision } from "@orca/engine";
import { WorkflowViewSchema, WorkflowsValidateInputsResultSchema } from "@orca/protocol";
import { orchestratorDefinitionResolver, WorkflowInputsModel } from "../src/workflow-inputs.js";
import { workflowView } from "../src/workflow-model.js";
import { emptyFixture } from "./fixture.js";

const TYPED = `
id: typed
name: typed
version: "3"
inputs: { count: How many }
vars: { apiKey: sk-workflow-secret, mode: fast }
inputSchema:
  fields:
    count: { type: integer, required: true, minimum: 1 }
    apiKey: { type: string, sensitive: true, default: sk-default-secret, enum: [sk-default-secret, sk-workflow-secret] }
    mode: { type: string, enum: [fast, slow] }
start: s
nodes:
  s: { type: start }
  e: { type: end }
edges:
  - { from: s, to: e }
`;

describe("workflows.validateInputs model (#330)", () => {
  const def = parseWorkflow(TYPED);
  const fixtureModel = () => {
    const calls: [string, string | undefined][] = [];
    const model = new WorkflowInputsModel({
      resolve: async (id, version) => {
        calls.push([id, version]);
        return def;
      },
    });
    return { model, calls };
  };

  it("answers the selected version, its revision and field-level failures", async () => {
    const { model, calls } = fixtureModel();
    const result = await model.validateInputs({ workflowId: "typed", version: "3", vars: { count: "2", mode: "x" } });
    expect(WorkflowsValidateInputsResultSchema.parse(result)).toEqual(result);
    expect(calls).toEqual([["typed", "3"]]);
    expect(result).toEqual({
      workflowId: "typed",
      version: "3",
      revision: workflowRevision(def),
      validation: {
        ok: false,
        errors: [
          { path: "vars.count", message: "expected integer, got string" },
          { path: "vars.mode", message: "must be one of: fast, slow" },
        ],
        warnings: [],
      },
    });
  });

  it("treats omitted vars as none and never echoes resolved values", async () => {
    const { model } = fixtureModel();
    const result = await model.validateInputs({ workflowId: "typed" });
    expect(result.validation.errors).toEqual([{ path: "vars.count", message: "is required" }]);
    const ok = await model.validateInputs({ workflowId: "typed", vars: { count: 1, apiKey: "sk-caller-secret" } });
    expect(ok.validation).toMatchObject({ ok: false });
    expect(JSON.stringify(ok)).not.toMatch(/secret/);
    expect(Object.keys(ok)).toEqual(["workflowId", "version", "revision", "validation"]);
  });

  it("lets a resolver's refusal through rather than inventing a result", async () => {
    const model = new WorkflowInputsModel({
      resolve: () => Promise.reject(Object.assign(new Error("nope"), { code: "WORKFLOW_NOT_FOUND" })),
    });
    await expect(model.validateInputs({ workflowId: "missing" })).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
  });

  it("guards a launch on exactly what the orchestrator admits, without starting anything", async () => {
    const f = emptyFixture();
    f.orchestrator.workflows.register(def);
    const model = new WorkflowInputsModel({ resolve: orchestratorDefinitionResolver(f.orchestrator) });

    const bad = await model.validateInputs({ workflowId: "typed", vars: { count: 0 } });
    expect(bad.validation.ok).toBe(false);
    expect(await f.stores.events.listRuns()).toEqual([]);
    expect(await f.stores.workflows.versions("typed")).toEqual([]);
    // The launch refuses with the same issues the preflight returned.
    await expect(f.orchestrator.startRun({ workflowId: "typed", vars: { count: 0 } })).rejects.toMatchObject({
      code: "WORKFLOW_INPUT_INVALID",
      details: { errors: bad.validation.errors, warnings: bad.validation.warnings },
    });

    const good = await model.validateInputs({ workflowId: "typed", vars: { count: 2 } });
    expect(good.validation).toEqual({ ok: true, errors: [], warnings: [] });
    const runId = await f.orchestrator.startRun({
      workflowId: "typed",
      vars: { count: 2 },
      workflowVersion: good.version,
      expectedWorkflowRevision: good.revision,
    });
    expect((await f.orchestrator.getState(runId)).run.workflowVersion).toBe("3");

    // An unknown version is the orchestrator's error, not a result about another version.
    await expect(model.validateInputs({ workflowId: "typed", version: "9" })).rejects.toMatchObject({
      code: "WORKFLOW_VERSION_NOT_FOUND",
    });
  });
});

describe("workflow view with an input declaration (#330)", () => {
  it("publishes the declaration, without sensitive defaults, enums or vars", () => {
    const view = workflowView(parseWorkflow(TYPED), ["3"]);
    expect(WorkflowViewSchema.parse(view)).toEqual(view);
    expect(view.inputs).toEqual({ count: "How many" });
    expect(view.inputSchema?.fields.apiKey).toEqual({ type: "string", sensitive: true });
    expect(view.inputSchema?.fields.mode).toEqual({ type: "string", enum: ["fast", "slow"] });
    expect(view.vars).toEqual({ mode: "fast" });
    expect(JSON.stringify(view)).not.toMatch(/secret/);
  });

  it("omits enclosing defaults and vars with sensitive object or array descendants", () => {
    const def = parseWorkflow(
      TYPED.replace(
        /vars:[\s\S]*?(?=start:)/,
        `
vars:
  credentials: { token: VAR_SECRET, label: visible }
  accounts: [{ token: ARRAY_VAR_SECRET }]
  tokens: [ITEM_VAR_SECRET]
  mode: fast
inputSchema:
  fields:
    credentials:
      type: object
      default: { token: DEFAULT_SECRET, label: visible }
      properties:
        token: { type: string, sensitive: true }
        label: { type: string }
    accounts:
      type: array
      default: [{ token: ARRAY_DEFAULT_SECRET }]
      items:
        type: object
        properties:
          token: { type: string, sensitive: true }
    tokens:
      type: array
      default: [ITEM_DEFAULT_SECRET]
      items: { type: string, sensitive: true }
    mode: { type: string, default: fast }
`,
      ),
    );
    const before = structuredClone(def);
    const view = workflowView(def, ["3"]);
    expect(WorkflowViewSchema.parse(view)).toEqual(view);
    expect(view.vars).toEqual({ mode: "fast" });
    for (const name of ["credentials", "accounts", "tokens"])
      expect(view.inputSchema?.fields[name]).not.toHaveProperty("default");
    expect(view.inputSchema?.fields.credentials?.properties?.token).toEqual({ type: "string", sensitive: true });
    expect(view.inputSchema?.fields.mode?.default).toBe("fast");
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(def).toEqual(before);
  });

  it("is unchanged for a workflow that only documents its inputs", () => {
    const legacy: WorkflowDefinition = parseWorkflow(TYPED.replace(/inputSchema:[\s\S]*?(?=start:)/, ""));
    const view = workflowView(legacy, ["3"]);
    expect(view.inputSchema).toBeUndefined();
    expect(view.vars).toEqual({ apiKey: "sk-workflow-secret", mode: "fast" });
  });
});
