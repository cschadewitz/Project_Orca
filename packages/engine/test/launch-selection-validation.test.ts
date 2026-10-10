/** Selection validation is side-effect free and uses the captured generation's registries. */
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  FakeClock,
  TemplateRegistry,
  WorkflowRegistry,
  parseOrcaConfig,
  parsePromptTemplate,
  parseWorkflow,
} from "@orca/core";
import { memoryStores } from "@orca/store";
import { Orchestrator } from "../src/orchestrator.js";
import { submissionRequest } from "../src/program/request-submission.js";
import type { GenerationMaterial } from "../src/configuration-generation.js";
import { launchProvenance } from "../src/configuration-provenance.js";
import { RunProvenanceSchema } from "@orca/core/schemas";

const flow = parseWorkflow(`
id: flow
name: Flow
version: '1'
start: start
nodes:
  start: {type: start}
  done: {type: end}
edges: [{from: start, to: done}]
`);
function fixture() {
  const stores = memoryStores();
  const workflows = new WorkflowRegistry().register(flow);
  const templates = new TemplateRegistry()
    .register(parsePromptTemplate("---\nid: review\n---\nBase"))
    .register(parsePromptTemplate("---\nid: strict/review\n---\nStrict"));
  const agents = new AgentRegistry();
  const orchestrator = new Orchestrator({ stores, workflows, templates, agents });
  return { stores, workflows, templates, agents, orchestrator };
}
describe("launch selection validation", () => {
  it("refuses unavailable item workflows and packs before writing a run or workflow version", async () => {
    const f = fixture();
    for (const [overrides, code] of [
      [{ itemWorkflow: "missing" }, "WORKFLOW_NOT_FOUND"],
      [{ templatePack: "missing" }, "TEMPLATE_NOT_FOUND"],
    ] as const) {
      await expect(f.orchestrator.startRun({ workflowId: "flow", overrides })).rejects.toMatchObject({ code });
    }
    expect(await f.stores.events.listRuns()).toEqual([]);
    expect(await f.stores.workflows.get("flow", "1")).toBeUndefined();
  });
  it("accepts supported selections and preserves base fallback for a missing pack variant", async () => {
    const f = fixture();
    f.templates.register(parsePromptTemplate("---\nid: other\n---\nOther base"));
    const overrides = { itemWorkflow: "flow", templatePack: "strict" };
    await expect(f.orchestrator.validateStartRun({ workflowId: "flow", overrides })).resolves.toBeDefined();
    expect(f.templates.get("other", { pack: "strict" }).id).toBe("other");
    expect(await f.stores.events.listRuns()).toEqual([]);
  });
  it("uses captured selections even when the current registries no longer contain them", async () => {
    const f = fixture();
    const material: GenerationMaterial = {
      agents: f.agents,
      workflows: f.workflows,
      templates: f.templates,
      snapshot: {
        id: "captured",
        savedRevision: "saved",
        config: parseOrcaConfig({}),
        workflows: [],
        templates: [],
      },
    };
    const current = new Orchestrator({
      stores: f.stores,
      agents: f.agents,
      workflows: new WorkflowRegistry(),
      templates: new TemplateRegistry(),
    });
    await expect(
      current.validateStartRun(
        { workflowId: "flow", overrides: { itemWorkflow: "flow", templatePack: "strict" } },
        material,
      ),
    ).resolves.toBeDefined();
    await expect(
      current.validateStartRun({ workflowId: "flow", overrides: { itemWorkflow: "missing" } }, material),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
  });
  it("shares the exact defaulted Request input descriptor between preflight and admission", () => {
    const clock = new FakeClock();
    const request = submissionRequest({ title: "Task", body: "Instructions" }, clock, "fixture-request");
    expect(request).toEqual({
      id: "fixture-request",
      title: "Task",
      body: "Instructions",
      source: { kind: "manual" },
      labels: [],
      status: "decomposing",
      createdAt: clock.isoNow(),
      updatedAt: clock.isoNow(),
    });
  });
  it("persists the effective item-workflow source without storing input values", () => {
    const f = fixture();
    const material: GenerationMaterial = {
      agents: f.agents,
      workflows: f.workflows,
      templates: f.templates,
      snapshot: { id: "captured", savedRevision: "saved", config: parseOrcaConfig({}), workflows: [], templates: [] },
    };
    const vars = { itemWorkflow: "flow", privateInput: "PRIVATE" };
    for (const [supplied, overrides, injected, source] of [
      [{}, undefined, undefined, "workflow.vars.itemWorkflow"],
      [vars, undefined, undefined, "caller.vars.itemWorkflow"],
      [vars, undefined, "config.program.itemWorkflow", "config.program.itemWorkflow"],
      [vars, { itemWorkflow: "other" }, "config.program.itemWorkflow", "run.overrides.itemWorkflow"],
    ] as const) {
      const provenance = RunProvenanceSchema.parse(
        launchProvenance(material, flow, vars, supplied, overrides, injected),
      );
      expect(provenance.itemWorkflow).toEqual({ value: overrides?.itemWorkflow ?? "flow", source });
      expect(JSON.stringify(provenance)).not.toContain("PRIVATE");
    }
  });
});
