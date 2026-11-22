import { expect, it, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  parseOrcaConfig,
  parsePromptTemplate,
  silentLogger,
  TemplateRegistry,
  WorkflowDefinitionSchema,
  WorkflowRegistry,
  type RunOverrides,
} from "@orca/core";
import {
  capabilityRefusal,
  ConfigurationGenerations,
  Orchestrator,
  type GenerationAssets,
  type GenerationMaterial,
  type StartRunOptions,
} from "@orca/engine";
import { InMemoryEventStore, memoryStores } from "@orca/store";
import { OperatorPreflightResultSchema, type OperatorRow } from "@orca/protocol";
import { eventSnapshot, OperatorReadModel, operatorGenerationCollections } from "../src/operator-read-model.js";
import { type Principal } from "../src/auth/principal.js";

const target = { workspaceId: crypto.randomUUID(), instanceId: crypto.randomUUID() };
const principal = (): Principal => ({
  id: "operator",
  kind: "credential",
  credentialId: "credential",
  scope: { runs: "all", workflows: "*" },
  permissions: new Set(["runs.start", "config.read", "workflows.read"]),
});
const draft = { title: "Build feature", body: "PRIVATE-DRAFT" };
async function fixture(
  schema = true,
  modelDeclarations = true,
  secondRootAgent = false,
  configuredItemWorkflow = "item",
) {
  const config = parseOrcaConfig({
    program: { workflow: "program", itemWorkflow: configuredItemWorkflow },
    agents: [
      {
        id: "a",
        command: "/PRIVATE-COMMAND",
        roles: ["decomposer", "builder"],
        models: modelDeclarations ? [{ id: "a-model", name: "A model" }] : [],
        env: { TOKEN: "PRIVATE-CREDENTIAL" },
      },
      {
        id: "b",
        command: "/PRIVATE-COMMAND",
        models: modelDeclarations ? [{ id: "b-model", name: "B model" }] : [],
        defaultModel: "b-model",
      },
    ],
    roles: { decomposer: "a" },
  });
  const definition = WorkflowDefinitionSchema.parse({
    id: "program",
    name: "Program",
    version: "1",
    start: "start",
    nodes: {
      start: { type: "start" },
      decompose: { type: "agent", agent: { role: "decomposer" }, template: "program/decompose" },
      ...(secondRootAgent ? { review: { type: "agent", agent: "a", template: "program/decompose" } } : {}),
      end: { type: "end" },
    },
    edges: [
      { from: "start", to: "decompose" },
      { from: "decompose", to: secondRootAgent ? "review" : "end" },
      ...(secondRootAgent ? [{ from: "review", to: "end" }] : []),
    ],
    ...(schema
      ? {
          inputSchema: {
            unknown: "reject",
            fields: {
              request: {
                type: "object",
                required: true,
                properties: { title: { type: "string", required: true }, body: { type: "string", required: true } },
              },
              itemWorkflow: { type: "string", required: true },
              token: { type: "string", sensitive: true, default: "PRIVATE-DEFAULT" },
              publicDefault: { type: "string", default: "public", enum: ["public"] },
              credentialRepeat: { type: "string", default: "PRIVATE-CREDENTIAL", enum: ["PRIVATE-CREDENTIAL"] },
              credentialObject: {
                type: "object",
                default: { value: "PRIVATE-CREDENTIAL" },
                properties: { value: { type: "string", enum: ["PRIVATE-CREDENTIAL"] } },
              },
            },
          },
        }
      : {}),
  });
  const item = WorkflowDefinitionSchema.parse({
    id: "item",
    name: "Item",
    version: "1",
    start: "start",
    nodes: { start: { type: "start" }, end: { type: "end" } },
    edges: [{ from: "start", to: "end" }],
  });
  const templates = ["program/decompose", "focused/program/decompose"].map((id) =>
    parsePromptTemplate(`---\nid: ${id}\n---\nPRIVATE-PROMPT`),
  );
  const assets: GenerationAssets = { workflows: [definition, item], templates };
  const stores = memoryStores();
  const provision = vi.fn(async () => ({ hostId: "local", cwd: "/PRIVATE-WORKSPACE" }));
  const orc = new Orchestrator({
    stores,
    agents: AgentRegistry.fromConfig(config),
    workflows: new WorkflowRegistry().register(definition).register(item),
    templates: new TemplateRegistry(),
    workspaceProvider: { name: "test", provision },
    logger: silentLogger,
  });
  const startRun = vi.fn((options: StartRunOptions, material: GenerationMaterial) => orc.startRun(options, material));
  const validateStartRun = vi.fn((options: StartRunOptions, material: GenerationMaterial) =>
    orc.validateStartRun(options, material),
  );
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async () => assets,
    admission: { startRun, validateStartRun },
  });
  await generations.initialize(config, "saved");
  orc.generations = generations;
  const putGeneration = vi.spyOn(stores.execution, "putGeneration");
  const putInputs = vi.spyOn(stores.execution, "putInputs");
  const putWorkflow = vi.spyOn(stores.workflows, "put");
  let currentPrincipal = principal();
  const model = new OperatorReadModel({
    target,
    orcaVersion: "test",
    protocol: { major: 1, minor: 10 },
    current: async () => currentPrincipal,
    allowsRun: async () => true,
    collections: operatorGenerationCollections(generations),
    operations: () => ["operator.preflight", "operator.page"],
    generations,
  });
  return {
    model,
    generations,
    stores,
    config,
    startRun,
    validateStartRun,
    provision,
    putGeneration,
    putInputs,
    putWorkflow,
    setPrincipal: (value: Principal) => {
      currentPrincipal = value;
    },
  };
}

it("validates the same Request defaults and overrides admission receives, returns effective safe selections, and writes no admission state", async () => {
  const f = await fixture();
  const result = await f.model.preflight({
    target,
    purpose: "request",
    request: draft,
    overrides: { roles: { decomposer: "b" }, model: { b: "b-model" }, itemWorkflow: "item", templatePack: "focused" },
  });
  expect(result.validation).toEqual({ ok: true, errors: [], warnings: [] });
  expect(result.selections).toEqual([
    {
      nodeId: "decompose",
      role: "decomposer",
      agent: { value: "b", source: "run.overrides.roles" },
      model: { value: "b-model", source: "run.overrides.model" },
      template: {
        value: "focused/program/decompose",
        revision: expect.any(String),
        source: "run.overrides.templatePack",
      },
      // No MCP servers or skills configured (#335): present and empty, so a reader can tell.
      capabilities: { mcpServers: [], skills: [] },
    },
  ]);
  expect(result.itemWorkflow).toEqual({ value: "item", source: "run.overrides.itemWorkflow" });
  expect(result.templatePack).toEqual({ value: "focused", source: "run.overrides.templatePack" });
  expect(result.inputSchema?.fields.token).toEqual({ type: "string", sensitive: true });
  expect(f.validateStartRun).toHaveBeenCalledOnce();
  expect(f.validateStartRun.mock.calls[0]?.[0]).toMatchObject({
    vars: {
      itemWorkflow: "item",
      request: { ...draft, source: { kind: "manual" }, labels: [], status: "decomposing", id: expect.any(String) },
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|host|partials|createdAt/);
  expect(await f.stores.events.listRuns()).toEqual([]);
  expect(await f.stores.requests.list()).toEqual([]);
  expect(await f.stores.workItems.list()).toEqual([]);
  for (const write of [f.startRun, f.provision, f.putGeneration, f.putInputs, f.putWorkflow])
    expect(write).not.toHaveBeenCalled();
});

it.each<[RunOverrides, string]>([
  [{ roles: { decomposer: "missing" } }, "overrides.roles"],
  [{ model: { b: "a-model" } }, "overrides.model.b"],
  [{ model: { missing: "unknown" } }, "overrides.model.missing"],
  [{ templatePack: "missing" }, "overrides.templatePack"],
  [{ itemWorkflow: "missing" }, "overrides.itemWorkflow"],
])("refuses unavailable declared Request selection %j before admitting work", async (overrides, path) => {
  const f = await fixture();
  const result = await f.model.preflight({ target, purpose: "request", request: draft, overrides });
  expect(result.validation).toMatchObject({ ok: false, errors: [{ path }] });
  expect(result.selections).toBeUndefined();
  expect(f.startRun).not.toHaveBeenCalled();
  expect(f.putInputs).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("checks legacy global models against each effective agent's declared choices after role resolution", async () => {
  const f = await fixture();
  for (const overrides of [{ model: "a-model" }, { roles: { decomposer: "b" }, model: "b-model" }])
    expect((await f.model.preflight({ target, purpose: "request", request: draft, overrides })).validation.ok).toBe(
      true,
    );
  const bad = await f.model.preflight({
    target,
    purpose: "request",
    request: draft,
    overrides: { roles: { decomposer: "b" }, model: "a-model" },
  });
  expect(bad.validation).toMatchObject({ ok: false, errors: [{ path: "overrides.model" }] });
  expect(bad.selections).toBeUndefined();
  const multiple = await fixture(true, true, true);
  expect(
    (
      await multiple.model.preflight({
        target,
        purpose: "request",
        request: draft,
        overrides: { roles: { decomposer: "b" }, model: "b-model" },
      })
    ).validation,
  ).toMatchObject({ ok: false, errors: [{ path: "overrides.model" }] });
  const dynamic = await fixture(true, false);
  expect(
    (
      await dynamic.model.preflight({
        target,
        purpose: "request",
        request: draft,
        overrides: { model: "runtime-discovered" },
      })
    ).validation.ok,
  ).toBe(true);
  expect(f.startRun).not.toHaveBeenCalled();
  expect(multiple.startRun).not.toHaveBeenCalled();
  expect(dynamic.startRun).not.toHaveBeenCalled();
});

it.each([
  { configured: "PRIVATE-MISSING-WORKFLOW", vars: {}, path: "program.itemWorkflow" },
  { configured: "item", vars: { itemWorkflow: "PRIVATE-MISSING-WORKFLOW" }, path: "vars.itemWorkflow" },
])(
  "refuses an unregistered effective Request item workflow at $path without echoing its value",
  async ({ configured, vars, path }) => {
    const f = await fixture(true, true, false, configured);
    const result = await f.model.preflight({ target, purpose: "request", request: draft, vars });
    expect(result.validation).toEqual({
      ok: false,
      errors: [{ path, message: "selection is unavailable or invalid" }],
      warnings: [],
    });
    expect(result.selections).toBeUndefined();
    expect(result.itemWorkflow).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(f.startRun).not.toHaveBeenCalled();
    expect(f.putInputs).not.toHaveBeenCalled();
    expect(await f.stores.events.listRuns()).toEqual([]);
    expect(await f.stores.requests.list()).toEqual([]);
  },
);

it("accepts a registered caller or override selection ahead of an unregistered configured item workflow", async () => {
  const f = await fixture(true, true, false, "PRIVATE-MISSING-WORKFLOW");
  for (const selection of [{ vars: { itemWorkflow: "item" } }, { overrides: { itemWorkflow: "item" } }]) {
    const result = await f.model.preflight({ target, purpose: "request", request: draft, ...selection });
    expect(result.validation.ok).toBe(true);
    expect(result.itemWorkflow?.value).toBe("item");
  }
  expect(f.startRun).not.toHaveBeenCalled();
});

it("marks configured-secret repeats sensitive and omits concealed defaults/enums at every depth", async () => {
  const f = await fixture();
  const result = await f.model.preflight({ target, purpose: "request", request: draft });
  expect(result.inputSchema?.fields.publicDefault).toEqual({ type: "string", default: "public", enum: ["public"] });
  expect(result.inputSchema?.fields.credentialRepeat).toEqual({ type: "string", sensitive: true });
  expect(result.inputSchema?.fields.credentialObject).toEqual({
    type: "object",
    sensitive: true,
    properties: { value: { type: "string", sensitive: true } },
  });
  expect(JSON.stringify(result.inputSchema)).not.toMatch(/PRIVATE|\[REDACTED\]/);
  expect(result.itemWorkflow).toEqual({ value: "item", source: "config.program.itemWorkflow" });
  const caller = await f.model.preflight({
    target,
    purpose: "request",
    request: draft,
    vars: { itemWorkflow: "item" },
  });
  expect(caller.itemWorkflow).toEqual({ value: "item", source: "caller.vars.itemWorkflow" });
});

it("preserves legacy unknown/no-input workflow calls and confirms the absent declaration", async () => {
  const f = await fixture(false);
  const result = await f.model.preflight({
    target,
    purpose: "workflow",
    workflowId: "item",
    vars: { unknown: "PRIVATE-VAR" },
  });
  expect(result.validation.ok).toBe(true);
  expect(result.inputSchema).toBeNull();
  expect(result.selections).toEqual([]);
  expect(
    OperatorPreflightResultSchema.parse({
      target,
      workflowId: "item",
      workflowVersion: "1",
      expectedWorkflowRevision: "revision",
      expectedConfigGeneration: "generation",
      validation: { ok: true, errors: [], warnings: [] },
      asOf: new Date().toISOString(),
    }).inputSchema,
  ).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("rejects caller Request/correlation vars and validates the real draft fields without echoing values", async () => {
  const f = await fixture();
  const result = await f.model.preflight({
    target,
    purpose: "request",
    request: draft,
    vars: { request: { title: "PRIVATE-FAKE" }, __orcaAdmissionId: "PRIVATE-FAKE" },
  });
  expect(result.validation.ok).toBe(false);
  expect(result.validation.errors).toEqual(
    expect.arrayContaining([
      { path: "vars.request", message: "is supplied by Request submission" },
      { path: "vars.__orcaAdmissionId", message: "is supplied by Request submission" },
    ]),
  );
  expect(f.validateStartRun).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  const missing = await f.model.preflight({ target, purpose: "request" });
  expect(missing.validation).toMatchObject({ ok: false, errors: [{ path: "vars.request" }] });
});

it("checks current authority and selected workflow scope before diagnostics or launch capture", async () => {
  const f = await fixture();
  const capture = vi.spyOn(f.generations, "captureLaunch");
  f.setPrincipal({ ...principal(), permissions: new Set() });
  await expect(
    f.model.preflight({ target, purpose: "request", ...{ overrides: { unknown: "PRIVATE" } } } as never),
  ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  f.setPrincipal({ ...principal(), scope: { runs: "owned", workflows: ["program"] } });
  await expect(
    f.model.preflight({ target, purpose: "request", request: draft, overrides: { itemWorkflow: "item" } }),
  ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
  expect(capture).not.toHaveBeenCalled();
  await expect(f.model.preflight({ target, purpose: "request", request: draft })).rejects.toMatchObject({
    code: "WORKFLOW_NOT_FOUND",
  });
  expect(f.validateStartRun).not.toHaveBeenCalled();
});

it("withholds detailed choice provenance without config-read and detects config-read revocation during validation", async () => {
  const f = await fixture();
  f.setPrincipal({ ...principal(), permissions: new Set(["runs.start", "workflows.read"]) });
  const allowed = await f.model.preflight({ target, purpose: "request", request: draft });
  expect(allowed.validation.ok).toBe(true);
  expect(allowed.selections).toBeUndefined();
  expect(allowed.itemWorkflow).toBeUndefined();
  expect(allowed.templatePack).toBeUndefined();
  f.setPrincipal(principal());
  const original = f.validateStartRun.getMockImplementation()!;
  f.validateStartRun.mockImplementationOnce(async (options, material) => {
    const result = await original(options, material);
    f.setPrincipal({ ...principal(), permissions: new Set(["runs.start", "workflows.read"]) });
    return result;
  });
  await expect(f.model.preflight({ target, purpose: "request", request: draft })).rejects.toMatchObject({
    code: "AUTH_FORBIDDEN",
  });
});

it("reports a step whose MCP servers or skills do not resolve under their own fields (#335)", async () => {
  const f = await fixture();
  f.validateStartRun.mockImplementationOnce(async () => {
    throw capabilityRefusal("decompose", [
      {
        path: "workflow.nodes.decompose.capabilities.mcpServers.enable[0]",
        message: "this node cannot turn on MCP server 'db': agent 'a' is not permitted to use it",
      },
    ]);
  });
  const result = await f.model.preflight({ target, purpose: "request", request: draft });
  expect(result.validation).toEqual({
    ok: false,
    errors: [
      {
        path: "workflow.nodes.decompose.capabilities.mcpServers.enable[0]",
        message: "this node cannot turn on MCP server 'db': agent 'a' is not permitted to use it",
      },
    ],
    warnings: [],
  });
  expect(result.selections).toBeUndefined();
  expect(await f.stores.events.listRuns()).toEqual([]);
});

it("refuses Request overrides for a direct workflow launch whose admission contract cannot carry them", async () => {
  const f = await fixture();
  await expect(
    f.model.preflight({ target, purpose: "workflow", workflowId: "item", overrides: { itemWorkflow: "item" } }),
  ).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
  expect(f.validateStartRun).not.toHaveBeenCalled();
});

it("guards exact workflow/generation identity and refuses a generation changed during validation", async () => {
  const f = await fixture();
  await expect(
    f.model.preflight({ target, purpose: "request", request: draft, expectedConfigGeneration: "stale" }),
  ).rejects.toMatchObject({ code: "CONFIG_STALE" });
  await expect(
    f.model.preflight({ target, purpose: "request", request: draft, expectedWorkflowRevision: "stale" }),
  ).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
  const original = f.validateStartRun.getMockImplementation()!;
  f.validateStartRun.mockImplementationOnce(async (options, material) => {
    const result = await original(options, material);
    await f.generations.apply(
      { ...f.config, roles: { decomposer: "b" } },
      "next",
      material.snapshot.id,
      false,
      async () => {},
    );
    return result;
  });
  await expect(f.model.preflight({ target, purpose: "request", request: draft })).rejects.toMatchObject({
    code: "CONFIG_STALE",
  });
  expect(f.startRun).not.toHaveBeenCalled();
});

it("projects coherent pack/item-workflow choices and implicit roles without executable fields", async () => {
  const f = await fixture();
  const result = await f.model.page({ target, collection: "choices", limit: 100 });
  expect(result.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "role", id: "builder", agentId: "a", source: "agent.roles" }),
      expect.objectContaining({ kind: "template-pack", templatePack: "focused" }),
      expect.objectContaining({ kind: "item-workflow", workflowId: "item", source: "configuration" }),
    ]),
  );
  expect(result.items.every((row) => row.configGeneration === result.revision)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|body|command|env|workspaceRoot/);
  const scopedPrincipal = { ...principal(), scope: { runs: "owned" as const, workflows: ["program"] } };
  const source = await operatorGenerationCollections(f.generations).choices!(
    { target, collection: "choices", limit: 100 },
    scopedPrincipal,
  );
  const rows: OperatorRow[] = [];
  for await (const row of source.rows) rows.push(row);
  expect(rows.filter((row) => row.kind === "item-workflow").map((row) => row.workflowId)).toEqual(["program"]);
});

it("projects persisted item-workflow dispatch defaults and template-pack provenance with workflow scope", async () => {
  const events = new InMemoryEventStore();
  await events.append({
    type: "run.created",
    runId: "run",
    payload: {
      workflowId: "program",
      workflowVersion: "1",
      vars: { token: "PRIVATE" },
      workspace: { hostId: "local", cwd: "/PRIVATE" },
      provenance: {
        configGeneration: "generation",
        workflow: { id: "program", version: "1", revision: "revision" },
        inputs: [],
        selections: [],
        itemWorkflow: { value: "item", source: "run.overrides.itemWorkflow" },
        templatePack: { value: "focused", source: "run.overrides.templatePack" },
      },
    },
  });
  let currentPrincipal = { ...principal(), permissions: new Set(["runs.read"] as const) };
  const model = new OperatorReadModel({
    target,
    orcaVersion: "test",
    protocol: { major: 1, minor: 10 },
    current: async () => currentPrincipal,
    allowsRun: async () => true,
    collections: { provenance: (params) => eventSnapshot(events, params) },
    operations: () => ["operator.page"],
  });
  const params = { target, collection: "provenance" as const, runId: "run", limit: 100 };
  const result = await model.page(params);
  expect(result.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "item-workflow-default",
        workflowId: "item",
        source: "run.overrides.itemWorkflow",
        configGeneration: "generation",
      }),
      expect.objectContaining({
        kind: "template-pack-selection",
        templatePack: "focused",
        source: "run.overrides.templatePack",
        configGeneration: "generation",
      }),
    ]),
  );
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  currentPrincipal = { ...currentPrincipal, scope: { runs: "owned", workflows: ["program"] } };
  const scoped = await model.page(params);
  expect(scoped.items.some((row) => row.kind === "item-workflow-default")).toBe(false);
  expect(scoped.items.some((row) => row.kind === "template-pack-selection")).toBe(true);
});
