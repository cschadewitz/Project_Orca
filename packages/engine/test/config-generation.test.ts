import { describe, expect, it, vi } from "vitest";
import { parseOrcaConfig, parseWorkflow, parsePromptTemplate } from "@orca/core";
import { AgentRegistry } from "@orca/agents";
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
async function fixture(agents?: AgentRegistry, runtimeFingerprint?: string) {
  const records = new Map<string, GenerationSnapshot>();
  const workflows = new InMemoryWorkflowVersionStore();
  let assets: GenerationAssets = {
    workflows: [definition()],
    templates: [],
    ...(agents ? { agents } : {}),
    ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
  };
  const calls: { options: unknown; generation: GenerationMaterial }[] = [];
  const writes = vi.fn(async (id: string, value: GenerationSnapshot) => {
    records.set(id, structuredClone(value));
  });
  const options: ConstructorParameters<typeof ConfigurationGenerations>[0] = {
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
  };
  const generations = new ConfigurationGenerations(options);
  await generations.initialize(config(), "one");
  return {
    generations,
    restart: async () => {
      const next = new ConfigurationGenerations(options);
      await next.initialize({ ...config(), roles: { builder: "b" } }, "two");
      return next;
    },
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
    const replacement = { ...definition(), id: "replacement" };
    setAssets({ workflows: [replacement], templates: [] });
    await generations.apply(
      { ...config(), program: { ...config().program, workflow: "replacement", itemWorkflow: "replacement" } },
      "one",
      applied.status.activeGeneration,
      false,
      recheck,
    );
    expect(notify).toHaveBeenLastCalledWith(expect.anything(), [
      { id: "replacement", version: "1" },
      { id: "flow", version: "2", removed: true },
    ]);
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

it.each(["workflow", "itemWorkflow"] as const)("rejects removal of unchanged program.%s", async (field) => {
  const { generations, setAssets, writes } = await fixture();
  const initial = generations.current;
  const replacement = { ...definition(), id: "replacement" };
  setAssets({ workflows: [replacement], templates: [] });
  const other = field === "workflow" ? "itemWorkflow" : "workflow";
  const candidate = { ...config(), workflows: [], program: { ...config().program, [other]: "replacement" } };
  for (const validateOnly of [true, false]) {
    expect(await generations.apply(candidate, "two", initial.snapshot.id, validateOnly, recheck)).toMatchObject({
      outcome: "invalid",
      validation: { errors: [{ path: `program.${field}` }] },
    });
    expect(generations.current).toBe(initial);
    expect(writes).toHaveBeenCalledTimes(1);
  }
});

it("recovers an original Request admission after restart without weakening fresh capture", async () => {
  const { generations, restart, calls, records } = await fixture();
  const original = await generations.captureLaunch({ purpose: "request" });
  const next = await restart();
  await expect(
    next.captureLaunch({ purpose: "request", expectedConfigGeneration: original.generationId }),
  ).rejects.toMatchObject({ code: "CONFIG_STALE" });
  const recorded = { generationId: original.generationId, workflow: original.workflow, requestId: "req-original" };
  const recovered = await next.restoreLaunch(recorded);
  await recovered.validateStartRun({});
  await recovered.startRun({});
  expect(calls.map((call) => call.generation.agents.resolve({ role: "builder" }).agent.id)).toEqual(["a", "a"]);
  expect(calls[1]?.options).toMatchObject({ requestId: "req-original", workflowVersion: original.workflow.version });
  await expect(recovered.startRun({ requestId: "other" })).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(
    next.restoreLaunch({ ...recorded, workflow: { ...original.workflow, revision: "corrupt" } }),
  ).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
  records.delete(original.generationId);
  await expect(next.restoreLaunch(recorded)).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("retains effective registry registrations and refuses restoration by another provider", async () => {
  const agents = AgentRegistry.fromConfig(config());
  agents.mapRole("builder", "b");
  const { generations, restart, records } = await fixture(agents);
  const id = generations.current.snapshot.id;
  agents.mapRole("builder", "a");
  agents.resolve("b").agent.command = "changed-after-capture";
  expect((await generations.restore(id)).agents.resolve({ role: "builder" }).agent).toMatchObject({
    id: "b",
    command: "test",
  });
  expect(generations.current.agents.host("local")).toBe(agents.host("local"));
  const next = await restart();
  await expect(next.restore(id)).rejects.toMatchObject({ code: "RUN_STATE" });
  const saved = records.get(id)!;
  delete saved.effectiveAgents;
  await expect(generations.restore(id)).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("restores plugin-bound material in a later provider only for the same described runtime", async () => {
  const { generations, restart, setAssets } = await fixture(AgentRegistry.fromConfig(config()), "plugins-a");
  const id = generations.current.snapshot.id;
  const later = (runtimeFingerprint?: string, agents = AgentRegistry.fromConfig(config())) => {
    setAssets({
      workflows: [definition()],
      templates: [],
      agents,
      ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
    });
    return restart();
  };
  const same = AgentRegistry.fromConfig(config());
  same.mapRole("builder", "b");
  const restored = await (await later("plugins-a", same)).restore(id);
  // Executable hosts come from the matching boot; recorded specs and roles still win.
  expect(restored.agents.resolve({ role: "builder" }).agent.id).toBe("a");
  expect(restored.agents.host("local")).toBe(same.host("local"));
  await expect((await later("plugins-b")).restore(id)).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect((await later()).restore(id)).rejects.toMatchObject({ code: "RUN_STATE" });
  const extra = AgentRegistry.fromConfig(config());
  const host = Object.create(extra.host("local")) as ReturnType<AgentRegistry["host"]>;
  Object.defineProperty(host, "id", { value: "plugin-host" });
  extra.addHost(host);
  await expect((await later("plugins-a", extra)).restore(id)).rejects.toMatchObject({ code: "RUN_STATE" });
});
