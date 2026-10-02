import { describe, expect, it, vi } from "vitest";
import { parseOrcaConfig, parseWorkflow, parsePromptTemplate } from "@orca/core";
import { InMemoryWorkflowVersionStore } from "@orca/store";
import {
  ConfigurationGenerations,
  restartRequired,
  type GenerationSnapshot,
  type GenerationAssets,
  type GenerationMaterial,
} from "../src/configuration-generation.js";
import { launchProvenance } from "../src/configuration-provenance.js";

const definition = (version = "1", prompt = "initial") =>
  parseWorkflow(`
id: flow
name: Flow
version: '${version}'
start: start
nodes:
  start: {type: start}
  agent: {type: agent, agent: {role: builder}, prompt: '${prompt}'}
  done: {type: end}
edges:
  - {from: start, to: agent}
  - {from: agent, to: done}
`);
const config = () =>
  parseOrcaConfig({
    agents: [
      { id: "a", command: "test", roles: ["builder"], env: { TOKEN: "credential-canary" }, defaultModel: "first" },
      { id: "b", command: "test", defaultModel: "second" },
    ],
    roles: { builder: "a" },
    program: { workflow: "flow", itemWorkflow: "flow" },
  });
async function fixture() {
  const records = new Map<string, GenerationSnapshot>();
  const workflows = new InMemoryWorkflowVersionStore();
  let assets: GenerationAssets = { workflows: [definition()], templates: [] };
  const calls: { options: unknown; generation: GenerationMaterial }[] = [];
  const writes = vi.fn(async (id: string, value: GenerationSnapshot) => {
    records.set(id, structuredClone(value));
  });
  const generations = new ConfigurationGenerations({
    store: { getGeneration: async (id) => structuredClone(records.get(id)), putGeneration: writes },
    workflows,
    loadAssets: async () => assets,
    admission: {
      validateStartRun: async (options, generation) => {
        calls.push({ options, generation });
      },
      startRun: async (options, generation) => {
        calls.push({ options, generation });
        return "run";
      },
    },
  });
  await generations.initialize(config(), "one");
  return {
    generations,
    records,
    workflows,
    calls,
    writes,
    setAssets: (value: GenerationAssets) => {
      assets = value;
    },
  };
}
const recheck = async () => {};

describe("configuration generations", () => {
  it("distinguishes saved, validated, activated and restart-only changes", async () => {
    const { generations, writes } = await fixture();
    const initial = generations.current.snapshot.id;
    const candidate = { ...config(), roles: { builder: "b" } };
    expect(generations.status(candidate, "two")).toMatchObject({ state: "pending", activeGeneration: initial });
    expect((await generations.apply(candidate, "two", initial, true, recheck)).outcome).toBe("validated");
    expect(writes).toHaveBeenCalledTimes(1);
    expect(generations.current.snapshot.id).toBe(initial);
    const applied = await generations.apply(candidate, "two", initial, false, recheck);
    expect(applied).toMatchObject({ outcome: "applied", status: { state: "active", activeRevision: "two" } });
    expect(applied.status.activeGeneration).not.toBe(initial);
    expect((await generations.apply(candidate, "two", applied.status.activeGeneration, false, recheck)).outcome).toBe(
      "unchanged",
    );
    const restart = await generations.apply(
      { ...candidate, storeDir: "elsewhere" },
      "three",
      applied.status.activeGeneration,
      false,
      recheck,
    );
    expect(restart).toMatchObject({ outcome: "restart-required", status: { restartRequired: ["storeDir"] } });
    expect(generations.current.snapshot.id).toBe(applied.status.activeGeneration);
  });
  it("defaults new settings and security/agent transport changes to restart-only", () => {
    expect(
      restartRequired(
        { roles: {}, agents: [], hosts: [] },
        { roles: { builder: "x" }, agents: ["x"], hosts: ["y"], auth: {} },
      ),
    ).toEqual(["agents", "auth", "hosts"]);
  });
  it("rejects unknown fields rather than losing them to schema stripping", async () => {
    const { generations } = await fixture();
    const result = await generations.apply(
      { ...config(), network: { token: "credential-canary" } },
      "two",
      generations.current.snapshot.id,
      false,
      recheck,
    );
    expect(result.outcome).toBe("restart-required");
    expect(JSON.stringify(result)).not.toContain("credential-canary");
  });
  it("keeps generation registries immutable and refuses unknown nested settings", async () => {
    const { generations } = await fixture();
    expect(() => generations.current.workflows.register(definition("2"))).toThrow("immutable");
    expect(() => generations.current.agents.mapRole("builder", "b")).toThrow("immutable");
    expect(() => {
      generations.current.snapshot.config.roles.builder = "b";
    }).toThrow();
    const raw = { ...config(), program: { ...config().program, futureSetting: "credential-canary" } };
    expect(generations.status(raw, "two").restartRequired).toEqual(["program.futureSetting"]);
    const invalid = await generations.apply(
      { ...config(), roles: { builder: "missing" } },
      "two",
      generations.current.snapshot.id,
      false,
      recheck,
    );
    expect(invalid).toMatchObject({ outcome: "invalid", validation: { errors: [{ path: "roles.builder" }] } });
  });
  it("failed validation and same-version collisions leave activation unchanged", async () => {
    const { generations, setAssets } = await fixture();
    const initial = generations.current.snapshot.id;
    expect((await generations.apply({ agents: "credential-canary" }, "bad", initial, false, recheck)).outcome).toBe(
      "invalid",
    );
    setAssets({ workflows: [definition("1", "changed")], templates: [] });
    const result = await generations.apply(config(), "one", initial, false, recheck);
    expect(result.outcome).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("credential-canary");
    expect(generations.current.snapshot.id).toBe(initial);
  });
  it("captures without writes and keeps both admission callbacks on that generation across apply", async () => {
    const { generations, calls, writes, setAssets } = await fixture();
    const old = await generations.captureLaunch({ purpose: "request" });
    expect(writes).toHaveBeenCalledTimes(1);
    setAssets({ workflows: [definition("2")], templates: [] });
    await generations.apply({ ...config(), roles: { builder: "b" } }, "two", old.generationId, false, recheck);
    await old.validateStartRun({ vars: { input: "x" } });
    await old.startRun({ vars: { input: "x" } });
    const next = await generations.captureLaunch({ purpose: "workflow", workflowId: "flow" });
    await next.startRun({});
    expect(calls.map((call) => call.generation.agents.resolve({ role: "builder" }).agent.id)).toEqual(["a", "a", "b"]);
    expect(calls[0]?.options).toMatchObject({
      workflowId: "flow",
      workflowVersion: "1",
      expectedWorkflowRevision: old.workflow.revision,
    });
    expect(next.workflow.version).toBe("2");
    expect(next.generationId).not.toBe(old.generationId);
  });
  it("refuses stale capture guards and strips attempted runtime substitution", async () => {
    const { generations, calls } = await fixture();
    await expect(
      generations.captureLaunch({ purpose: "workflow", workflowId: "flow", expectedConfigGeneration: "stale" }),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
    await expect(
      generations.captureLaunch({ purpose: "workflow", workflowId: "flow", expectedWorkflowRevision: "stale" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
    await expect(generations.captureLaunch({ purpose: "workflow" })).rejects.toMatchObject({
      code: "WORKFLOW_NOT_FOUND",
    });
    const captured = await generations.captureLaunch({ purpose: "request" });
    const smuggled = { vars: {}, workflowId: "other", inline: { id: "other" } };
    await captured.startRun(smuggled);
    expect(calls[0]?.options).not.toHaveProperty("inline");
    expect(calls[0]?.options).toHaveProperty("workflowId", "flow");
  });
  it("captures Request item-workflow defaults while preserving explicit vars", async () => {
    const { generations, calls } = await fixture();
    const captured = await generations.captureLaunch({ purpose: "request" });
    await captured.startRun({});
    await captured.startRun({ vars: { itemWorkflow: "caller-choice" } });
    expect(calls[0]?.options).toMatchObject({ vars: { itemWorkflow: "flow" } });
    expect(calls[1]?.options).toMatchObject({ vars: { itemWorkflow: "caller-choice" } });
  });
  it("two concurrent apply operations have one activation winner", async () => {
    const { generations } = await fixture();
    const id = generations.current.snapshot.id;
    const results = await Promise.allSettled([
      generations.apply(config(), "two", id, false, recheck),
      generations.apply(config(), "three", id, false, recheck),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("notifies only activation, isolates observers, and includes changed/removed workflows", async () => {
    const { generations, setAssets } = await fixture();
    const notify = vi.fn();
    generations.onChange(() => {
      throw Error("broken observer");
    });
    const detach = generations.onChange(notify);
    const id = generations.current.snapshot.id;
    await generations.apply(config(), "one", id, true, recheck);
    expect(notify).not.toHaveBeenCalled();
    setAssets({ workflows: [definition("2")], templates: [] });
    const applied = await generations.apply(config(), "one", id, false, recheck);
    expect(notify).toHaveBeenCalledWith(applied.status, [{ id: "flow", version: "2" }]);
    setAssets({ workflows: [], templates: [] });
    await generations.apply(config(), "one", applied.status.activeGeneration, false, recheck);
    expect(notify).toHaveBeenLastCalledWith(expect.anything(), [{ id: "flow", version: "2", removed: true }]);
    detach();
  });
  it("restores admitted material and fails closed on missing generation or workflow pin", async () => {
    const { generations, records, workflows } = await fixture();
    const id = generations.current.snapshot.id;
    const restored = await generations.restore(id);
    expect(restored.agents.resolve({ role: "builder" }).agent.id).toBe("a");
    const snapshot = records.get(id)!;
    records.set(id, { ...snapshot, workflows: [{ id: "missing", version: "1", revision: "missing" }] });
    await expect(generations.restore(id)).rejects.toMatchObject({ code: "RUN_STATE" });
    records.delete(id);
    await expect(generations.restore(id)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(await workflows.versions("flow")).toEqual(["1"]);
  });
  it("a failed durable write or external edit during apply never replaces active material", async () => {
    const { generations, writes } = await fixture();
    const id = generations.current.snapshot.id;
    writes.mockRejectedValueOnce(Error("disk full"));
    await expect(generations.apply(config(), "two", id, false, recheck)).rejects.toThrow("disk full");
    expect(generations.current.snapshot.id).toBe(id);
    await expect(
      generations.apply(config(), "two", id, false, async () => {
        throw Error("external edit");
      }),
    ).rejects.toThrow("external edit");
    expect(generations.current.snapshot.id).toBe(id);
  });
  it("records resolution sources while withholding credentials and all artifact/input values", async () => {
    const { generations, setAssets } = await fixture();
    const template = parsePromptTemplate("---\nid: pack/prompt\n---\ncredential-canary");
    setAssets({ workflows: [definition("2")], templates: [template] });
    await generations.apply(config(), "two", generations.current.snapshot.id, false, recheck);
    const provenance = launchProvenance(
      generations.current,
      definition(),
      { secret: "credential-canary", artifact: "art_inaccessible" },
      { secret: "credential-canary" },
      { roles: { builder: "b" }, model: "chosen", templatePack: "pack" },
    );
    expect(provenance.selections[0]).toMatchObject({
      agent: { value: "b", source: "run.overrides.roles" },
      model: { value: "chosen", source: "run.overrides.model" },
      host: { value: "local" },
    });
    expect(provenance.inputs).toEqual([
      { name: "secret", source: "caller", value: "[REDACTED]" },
      { name: "artifact", source: "workflow", value: "[REDACTED]" },
    ]);
    expect(JSON.stringify(provenance)).not.toMatch(/credential-canary|art_inaccessible/);
  });
});
