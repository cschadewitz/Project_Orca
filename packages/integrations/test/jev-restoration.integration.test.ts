/** JEV restoration through the real orchestrator and memory/reopened file stores; HTTP remains injected. */
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
  serializeJevRestorationDescriptor,
  type JevRestorationContext,
  type JevRestorationDescriptor,
  type JevRestorationResult,
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
    const request = JSON.parse(typeof init?.body === "string" ? init.body : "") as { model: string };
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
      http.mock.calls.map(([url, init]) => [
        url,
        (JSON.parse(typeof init?.body === "string" ? init.body : "") as { model: string }).model,
      ]),
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

  it.each(["fail", "record"] as const)(
    "rejects the actually transmitted key after resolver cache rotation (onError: %s)",
    async (onError) => {
      const authority = context();
      const credential = { binding: { ...binding }, apiKey: KEY };
      authority.resolveCredential = async () => credential;
      const http = vi.fn<typeof fetch>(async (_url, init) => {
        expect(init?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
        credential.apiKey = "rotated-synthetic-key";
        return Response.json({
          model: "jev-1.13.0",
          answers: {
            accepted: {
              type: "score",
              score: 1,
              probabilities: { "0": 0, "1": 1 },
              confidence: 1,
              legend: { "1": KEY },
            },
          },
        });
      });
      vi.stubGlobal("fetch", http);
      const stores = memoryStores();
      const yaml = WORKFLOW.replace(
        "questions: {accepted: {type: noul, instructions: Is it accepted?}}",
        "questions: {accepted: {type: score, instructions: Grade?, criteria: [low, high]}}",
      ).replace("    rubric:", `    onError: ${onError}\n    rubric:`);
      const state = await runtime(
        unwrap(createJevEvalRestorationAdapter({ env: {} }, authority).restore(descriptor())),
        yaml,
        stores,
      ).startAndRun({ workflowId: "restore" });
      const bodies = await Promise.all(Object.keys(state.artifacts).map((id) => stores.artifacts.content(id)));
      expect(
        JSON.stringify(state) + JSON.stringify(await stores.events.read(state.run.id)) + bodies.join(""),
      ).not.toContain(KEY);
      expect(http).toHaveBeenCalledTimes(1);
      if (onError === "fail") {
        expect(state.run.status).toBe("failed");
        expect(state.artifacts).toEqual({});
      } else {
        expect(state.run.status).toBe("paused");
        expect(bodies.join("")).toContain("status: failed");
      }
    },
  );

  it.each(["apiKey", "binding", "provider", "account", "reference"] as const)(
    "sanitizes throwing credential-result %s getters before error or artifact publication",
    async (field) => {
      for (const onError of ["fail", "record"] as const) {
        const authority = context();
        const credential = { binding: { ...binding }, apiKey: KEY };
        Object.defineProperty(field === "apiKey" || field === "binding" ? credential : credential.binding, field, {
          enumerable: true,
          get() {
            throw new Error(KEY);
          },
        });
        authority.resolveCredential = async () => credential;
        const http = fakeHttp();
        const stores = memoryStores();
        const state = await runtime(
          unwrap(createJevEvalRestorationAdapter({ env: {} }, authority).restore(descriptor())),
          WORKFLOW.replace("    rubric:", `    onError: ${onError}\n    rubric:`),
          stores,
        ).startAndRun({ workflowId: "restore" });
        expect(http).not.toHaveBeenCalled();
        const bodies = await Promise.all(Object.keys(state.artifacts).map((id) => stores.artifacts.content(id)));
        expect(
          JSON.stringify(state) + JSON.stringify(await stores.events.read(state.run.id)) + bodies.join(""),
        ).not.toContain(KEY);
        if (onError === "fail") expect(state.run.status).toBe("failed");
        else {
          expect(state.run.status).toBe("paused");
          expect(bodies.join("")).toContain("status: failed");
        }
      }
    },
  );

  it("reads a credential accessor once and uses that captured value for the request", async () => {
    const authority = context();
    let reads = 0;
    authority.resolveCredential = async () => ({
      binding: { ...binding },
      get apiKey() {
        reads += 1;
        return reads === 1 ? KEY : "rotated-synthetic-key";
      },
    });
    const http = fakeHttp();
    const state = await runtime(
      unwrap(createJevEvalRestorationAdapter({ env: {} }, authority).restore(descriptor())),
    ).startAndRun({ workflowId: "restore" });
    expect(state.run.status).toBe("paused");
    expect(reads).toBe(1);
    expect(http.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(JSON.stringify(state)).not.toContain(KEY);
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
});
