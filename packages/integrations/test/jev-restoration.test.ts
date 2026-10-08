/** JEV adapter restoration through a provisional injected seam; all transport and authority are scripted. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import {
  builtinExecutors,
  LocalWorkspaceProvider,
  Orchestrator,
  PausingHumanInput,
  type NodeExecutor,
} from "@orca/engine";
import {
  createJevEvalRestorationAdapter,
  createRestorableJevEvalPlugin,
  readJevRestorationDescriptor,
  serializeJevRestorationDescriptor,
  type JevRestorationContext,
  type JevRestorationBridge,
  type JevRestorationDescriptor,
  type JevRestorationResult,
  type JevPluginRestoration,
} from "@orca/integrations";
import { fileStores, memoryStores, type Stores } from "@orca/store";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const KEY = "synthetic-private-value";
const binding = { provider: "typesafe", account: "account-a", reference: "env:TYPESAFE_API_KEY" } as const;
const context = (): JevRestorationContext => ({
  codeIdentity: `sha256:${"a".repeat(64)}`,
  dependencyIdentity: `sha256:${"b".repeat(64)}`,
  credentialBinding: { ...binding },
  resolveCredential: vi.fn(async () => ({ binding: { ...binding }, apiKey: KEY })),
});
const unwrap = <T>(result: JevRestorationResult<T>): T => {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
};
const descriptor = (): JevRestorationDescriptor =>
  unwrap(createJevEvalRestorationAdapter({ model: "jev-1.13.0", env: {} }, context()).capture());

const WORKFLOW = `
id: restore
name: restore
start: s
nodes:
  s: { type: start }
  jev:
    type: custom:jev-eval
    inputs: [{kind: review, required: false}]
    rubric: {id: test/restoration, version: 3}
    questions: {accepted: {type: noul, instructions: Is it accepted?}}
  gate: {type: gate, question: Continue?, options: [go]}
  end: {type: end}
edges: [{from: s, to: jev}, {from: jev, to: gate}, {from: gate, to: end}]
`;
function runtime(executor: NodeExecutor, yaml = WORKFLOW, stores: Stores = memoryStores()) {
  const workflows = new WorkflowRegistry().register(parseWorkflow(yaml));
  return new Orchestrator({
    stores,
    workflows,
    templates: new TemplateRegistry(),
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    executors: builtinExecutors().register(executor),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    humanInput: new PausingHumanInput(),
    clock: new FakeClock(),
  });
}
function fakeHttp() {
  const http = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { model: string };
    return Response.json({ model: request.model, answers: { accepted: { type: "noul", noul: 0.93 } } });
  });
  vi.stubGlobal("fetch", http);
  return http;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("JEV restoration adapter", () => {
  it("pins only non-secret defaults, including absent model, and keeps node overrides in the workflow", () => {
    const env = {
      ORCA_JEV_MODEL: "jev-1.13.0",
      TYPESAFE_BASE_URL: "https://original.example/",
      TYPESAFE_API_KEY: KEY,
      OTHER_SECRET: KEY,
    };
    const admitted = createJevEvalRestorationAdapter({ env }, context());
    env.ORCA_JEV_MODEL = "jev-2.0.0";
    env.TYPESAFE_BASE_URL = "https://new.example";
    const captured = unwrap(admitted.capture());
    expect(captured.defaults).toEqual({ model: "jev-1.13.0", baseUrl: "https://original.example" });
    const serialized = unwrap(serializeJevRestorationDescriptor(captured));
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("OTHER_SECRET");
    expect(serialized).not.toContain("questions");
    captured.defaults.model = "jev-9.0.0";
    expect(unwrap(admitted.capture()).defaults.model).toBe("jev-1.13.0");
    expect(unwrap(createJevEvalRestorationAdapter({ env: {} }, context()).capture()).defaults.model).toBeNull();
  });

  it("restores recorded model and endpoint while a new generation sees the new defaults", async () => {
    const http = fakeHttp();
    const authority = context();
    const historical = descriptor();
    historical.defaults.baseUrl = "https://original.example";
    const active = createJevEvalRestorationAdapter(
      { model: "jev-2.0.0", baseUrl: "https://new.example", env: {} },
      authority,
    );
    const executor = unwrap(active.restore(JSON.parse(unwrap(serializeJevRestorationDescriptor(historical)))));
    expect(authority.resolveCredential).not.toHaveBeenCalled();
    const old = await runtime(executor).startAndRun({ workflowId: "restore" });
    expect(old.run.status).toBe("paused");
    await runtime(unwrap(active.restore(unwrap(active.capture())))).startAndRun({ workflowId: "restore" });
    await runtime(
      executor,
      WORKFLOW.replace("    type: custom:jev-eval", "    type: custom:jev-eval\n    model: jev-3.0.0"),
    ).startAndRun({ workflowId: "restore" });
    expect(
      http.mock.calls.map(([url, init]) => [url, (JSON.parse(String(init?.body)) as { model: string }).model]),
    ).toEqual([
      ["https://original.example/v1/systemone", "jev-1.13.0"],
      ["https://new.example/v1/systemone", "jev-2.0.0"],
      ["https://original.example/v1/systemone", "jev-3.0.0"],
    ]);
    expect(http.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(JSON.stringify(old)).not.toContain(KEY);
  });

  it("does not fill an absent historical model from today's environment", async () => {
    const http = fakeHttp();
    const absent = unwrap(createJevEvalRestorationAdapter({ env: {} }, context()).capture());
    vi.stubEnv("ORCA_JEV_MODEL", "jev-9.0.0");
    const state = await runtime(unwrap(createJevEvalRestorationAdapter({}, context()).restore(absent))).startAndRun({
      workflowId: "restore",
    });
    expect(state.run.status).toBe("failed");
    expect(state.run.error?.code).toBe("JEV_NOT_CONFIGURED");
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { schemaVersion: 0 },
    { schemaVersion: 2 },
    { ...descriptor(), apiKey: KEY },
    { ...descriptor(), defaults: { model: "jev-latest", baseUrl: "https://api.typesafe.ai" } },
    { ...descriptor(), defaults: { model: "jev-preview", baseUrl: "https://api.typesafe.ai" } },
    { ...descriptor(), defaults: { model: null, baseUrl: "https://user:private@example.com" } },
    { ...descriptor(), defaults: { model: null, baseUrl: "https://example.com?key=private" } },
    { ...descriptor(), defaults: { model: null, baseUrl: "https://example.com/#private" } },
    { ...descriptor(), defaults: { model: null, baseUrl: "file:///private" } },
    { ...descriptor(), codeIdentity: "unknown" },
    { ...descriptor(), unknown: "x".repeat(16_384) },
  ])("refuses malformed/legacy/unsupported records without leaking input (%#)", (record) => {
    const result = createJevEvalRestorationAdapter({ env: {} }, context()).restore(record);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each(["codeIdentity", "dependencyIdentity"] as const)("refuses changed %s before credentials or HTTP", (field) => {
    const authority = context();
    const record = descriptor();
    record[field] = `sha256:${"c".repeat(64)}`;
    expect(createJevEvalRestorationAdapter({ env: {} }, authority).restore(record)).toMatchObject({
      ok: false,
      reason: "identity-incompatible",
    });
    expect(authority.resolveCredential).not.toHaveBeenCalled();
  });

  it.each([{ provider: { evaluate: vi.fn() } }, { apiKey: KEY }])(
    "classifies arbitrary callbacks and inline secrets as non-restorable (%#)",
    (options) => {
      const adapter = createJevEvalRestorationAdapter(options, context());
      expect(adapter.capture()).toMatchObject({ ok: false, reason: "options-unsupported" });
      expect(adapter.restore(descriptor())).toMatchObject({ ok: false, reason: "options-unsupported" });
    },
  );

  it("requires explicit current binding metadata and resolver", () => {
    const missing = context();
    delete missing.credentialBinding;
    expect(createJevEvalRestorationAdapter({ env: {} }, missing).capture()).toMatchObject({
      reason: "binding-unavailable",
    });
    expect(createJevEvalRestorationAdapter({ env: {} }, missing).restore(descriptor())).toMatchObject({
      reason: "binding-unavailable",
    });
    const noResolver = context();
    delete noResolver.resolveCredential;
    expect(createJevEvalRestorationAdapter({ env: {} }, noResolver).capture()).toMatchObject({
      reason: "binding-unavailable",
    });
    const changed = context();
    changed.credentialBinding = { ...binding, account: "account-b" };
    expect(createJevEvalRestorationAdapter({ env: {} }, changed).restore(descriptor())).toMatchObject({
      reason: "binding-incompatible",
    });
  });

  it.each(["absent", "revoked", "changed"] as const)(
    "refuses %s credentials at the current authorized boundary without a provider call",
    async (failure) => {
      const http = fakeHttp();
      const authority = context();
      authority.resolveCredential = vi.fn(async () => {
        if (failure === "revoked") throw new Error(KEY);
        return {
          binding: failure === "changed" ? { ...binding, account: "account-b" } : { ...binding },
          apiKey: failure === "absent" ? "" : KEY,
        };
      });
      const result = await runtime(
        unwrap(createJevEvalRestorationAdapter({ env: {} }, authority).restore(descriptor())),
      ).startAndRun({ workflowId: "restore" });
      expect(result.run.status).toBe("failed");
      expect(result.run.error?.message).toMatch(/credential/);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(http).not.toHaveBeenCalled();
    },
  );

  it("sanitizes HTTP error bodies and transport exceptions before durable failure records", async () => {
    for (const failure of [
      async () => new Response(KEY, { status: 403 }),
      async () => {
        throw new Error(KEY);
      },
    ]) {
      vi.stubGlobal("fetch", failure);
      const stores = memoryStores();
      const result = await runtime(
        unwrap(createJevEvalRestorationAdapter({ env: {} }, context()).restore(descriptor())),
        WORKFLOW.replace("    rubric:", "    onError: record\n    rubric:"),
        stores,
      ).startAndRun({ workflowId: "restore" });
      expect(result.run.status).toBe("paused");
      const serialized =
        JSON.stringify(result) +
        JSON.stringify(await stores.events.read(result.run.id)) +
        (await Promise.all(Object.keys(result.artifacts).map((id) => stores.artifacts.content(id)))).join("");
      expect(serialized).not.toContain(KEY);
      expect(serialized).toContain("JEV bound HTTP evaluation failed");
    }
  });

  it("rejects credential echoes in successful responses before they reach artifacts or validation errors", async () => {
    for (const apiKey of [KEY, 'synthetic-"escaped\\key']) {
      const authority = context();
      authority.resolveCredential = async () => ({ binding: { ...binding }, apiKey });
      vi.stubGlobal("fetch", async () =>
        Response.json({ model: apiKey, answers: { accepted: { type: "noul", noul: 0.9 } } }),
      );
      const stores = memoryStores();
      const state = await runtime(
        unwrap(createJevEvalRestorationAdapter({ env: {} }, authority).restore(descriptor())),
        WORKFLOW,
        stores,
      ).startAndRun({ workflowId: "restore" });
      expect(state.run.status).toBe("failed");
      expect(JSON.stringify(state) + JSON.stringify(await stores.events.read(state.run.id))).not.toContain(
        JSON.stringify(apiKey).slice(1, -1),
      );
      expect(state.artifacts).toEqual({});
    }
  });

  it("reports an interrupted in-flight HTTP evaluation under the existing timeout behavior without adapter replay", async () => {
    const http = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error(KEY)), { once: true });
        }),
    );
    vi.stubGlobal("fetch", http);
    const stores = memoryStores();
    const state = await runtime(
      unwrap(createJevEvalRestorationAdapter({ env: {} }, context()).restore(descriptor())),
      WORKFLOW.replace("    rubric:", "    timeoutMs: 20\n    rubric:"),
      stores,
    ).startAndRun({ workflowId: "restore" });
    expect(state.run.status).toBe("failed");
    expect(state.run.error?.code).toBe("STEP_TIMEOUT");
    expect(http).toHaveBeenCalledTimes(1);
    expect(state.artifacts).toEqual({});
    expect(JSON.stringify(state) + JSON.stringify(await stores.events.read(state.run.id))).not.toContain(KEY);
  });

  it("reconstructs an executor over reopened stores without reevaluating completed durable results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-jev-restoration-"));
    try {
      const http = fakeHttp();
      const first = runtime(
        unwrap(createJevEvalRestorationAdapter({ env: {} }, context()).restore(descriptor())),
        WORKFLOW,
        fileStores(dir),
      );
      const parked = await first.startAndRun({ workflowId: "restore" });
      expect(parked.run.status).toBe("paused");
      const artifacts = structuredClone(parked.artifacts);
      const second = runtime(
        unwrap(createJevEvalRestorationAdapter({ model: "jev-9.0.0", env: {} }, context()).restore(descriptor())),
        WORKFLOW,
        fileStores(dir),
      );
      const [pending] = await second.pendingInputs(parked.run.id);
      await second.answer(pending!.id, "go", parked.run.id);
      const done = await second.resume(parked.run.id);
      expect(done.run.status).toBe("completed");
      expect(done.artifacts).toEqual(artifacts);
      expect(http).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires a bridge and exposes the supported executor with no eager credential read", () => {
    const attach = vi.fn<JevRestorationBridge["attach"]>((plugin, _adapter) => plugin);
    const authority = context();
    const plugin = createRestorableJevEvalPlugin({ env: {} }, authority, { attach });
    expect(plugin.name).toBe("jev-eval");
    expect(attach).toHaveBeenCalledTimes(1);
    const adapter = attach.mock.calls[0]?.[1];
    expect(adapter).toBeDefined();
    expect(authority.resolveCredential).not.toHaveBeenCalled();
    expect(() => createRestorableJevEvalPlugin({ apiKey: KEY }, authority, { attach })).toThrow(/options-unsupported/);
  });

  it("maps capture/validation/isolated registration to #394's published provisional hook", () => {
    const authority = context();
    const plugin = createRestorableJevEvalPlugin({ model: "jev-1.13.0", env: {} }, authority) as ReturnType<
      typeof createRestorableJevEvalPlugin
    > & { restoration: JevPluginRestoration };
    const hook = plugin.restoration;
    expect(hook.identity).toEqual({
      id: "jev-eval",
      schemaVersion: 1,
      codeVersion: authority.codeIdentity,
      dependencyIdentity: authority.dependencyIdentity,
    });
    const data = hook.capture();
    expect(hook.validate(data)).toBe(true);
    expect(hook.validate({ ...data, schemaVersion: 2 })).toBe(false);
    const register = vi.fn();
    hook.restore(data, { executors: { register } });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: "custom:jev-eval" }));
    expect(() => hook.restore({ ...data, schemaVersion: 2 }, { executors: { register } })).toThrow(
      /schema-unsupported/,
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(authority.resolveCredential).not.toHaveBeenCalled();
  });

  it("validates descriptor serialization and rejects corrupt or unbounded content", () => {
    const record = descriptor();
    expect(unwrap(readJevRestorationDescriptor(JSON.parse(unwrap(serializeJevRestorationDescriptor(record)))))).toEqual(
      record,
    );
    expect(serializeJevRestorationDescriptor({})).toMatchObject({ ok: false });
    expect(
      readJevRestorationDescriptor({
        toJSON() {
          throw new Error(KEY);
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      readJevRestorationDescriptor({
        get schemaVersion() {
          throw new Error(KEY);
        },
      }),
    ).toMatchObject({ ok: false });
  });
});
