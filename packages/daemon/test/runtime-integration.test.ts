/** Cross-story admission, attribution and standing-permission regressions. */
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AgentRegistry, LocalHost, type AgentSession } from "@orca/agents";
import {
  OrcaError,
  AgentSpecSchema,
  TemplateRegistry,
  WorkflowRegistry,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from "@orca/core";
import {
  Orchestrator,
  PausingHumanInput,
  LocalWorkspaceProvider,
  LiveHumanInput,
  runLeaseResource,
} from "@orca/engine";
import { memoryStores } from "@orca/store";
import {
  ControlModel,
  ReadModel,
  WorkflowInputsModel,
  orchestratorDefinitionResolver,
  CredentialStore,
  OwnershipStore,
  orchestratorResolver,
  startDaemon,
  type DaemonHandle,
} from "@orca/daemon";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const definition = (id = "typed", version = "1", minimum = 1): WorkflowDefinition =>
  WorkflowDefinitionSchema.parse({
    id,
    version,
    name: id,
    inputSchema: { fields: { count: { type: "integer", required: true, minimum } } },
    start: "s",
    nodes: {
      s: { type: "start" },
      gate: { type: "gate", question: "Ship?", options: ["ship", "hold"] },
      e: { type: "end" },
    },
    edges: [
      { from: "s", to: "gate" },
      { from: "gate", to: "e" },
    ],
  });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-runtime-integration-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const stores = memoryStores();
  const workflows = new WorkflowRegistry().register(definition()).register(definition("hidden"));
  const workspaceProvider = new LocalWorkspaceProvider(dir);
  const livePort = new LiveHumanInput("integration-boot");
  const execution = new AbortController();
  cleanup.push(async () => {
    livePort.close();
  });
  const orchestrator = new Orchestrator({
    stores,
    workflows,
    agents: new AgentRegistry()
      .addHost(new LocalHost({ id: "local", type: "local" }))
      .addAgent(AgentSpecSchema.parse({ id: "builder", command: "unused", permissions: { default: "ask" } })),
    templates: new TemplateRegistry(),
    workspaceProvider,
    humanInput: new PausingHumanInput(),
    liveInput: { port: livePort, executionSignal: () => execution.signal },
  });
  const reads = new ReadModel({ orchestrator });
  const permissionsFile = join(dir, "orca.permissions.json");
  const control = new ControlModel({ orchestrator, reads, permissionsFile });
  const workflowInputs = new WorkflowInputsModel({ resolve: orchestratorDefinitionResolver(orchestrator) });
  const credentials = new CredentialStore();
  const ownership = new OwnershipStore();
  const owner = (await credentials.issue({ principal: "owner", preset: "owner" })).token;
  const viewer = (await credentials.issue({ principal: "viewer", preset: "viewer" })).token;
  const client = (
    await credentials.issue({
      principal: "client",
      preset: "client",
      scope: { workflows: ["typed"], runs: "owned" },
    })
  ).token;
  const daemon: DaemonHandle = await startDaemon({
    orcaVersion: "integration",
    capabilities: ["runs.read", "runs.control", "runs.subscribe"],
    reads,
    control,
    workflowInputs,
    source: orchestrator,
    liveInputs: livePort,
    auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(orchestrator) },
  });
  cleanup.push(() => daemon.close());
  const rpc = async (token: string | undefined, method: string, params: unknown = {}) => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as {
      ok: boolean;
      result?: Record<string, unknown>;
      error?: { code: string; message: string; details?: unknown };
    };
  };
  return {
    dir,
    stores,
    workflows,
    orchestrator,
    workspaceProvider,
    reads,
    control,
    workflowInputs,
    ownership,
    credentials,
    permissionsFile,
    owner,
    viewer,
    client,
    daemon,
    rpc,
    livePort,
  };
}

describe("authorized typed launch admission", () => {
  it("authenticates and authorizes before input validation or workflow discovery", async () => {
    const h = await fixture();
    const validate = vi.spyOn(h.workflowInputs, "validateInputs");
    expect((await h.rpc(undefined, "workflows.validateInputs", { workflowId: "typed", vars: {} })).error?.code).toBe(
      "AUTH_REQUIRED",
    );
    expect((await h.rpc(h.viewer, "workflows.validateInputs", { vars: "malformed" })).error?.code).toBe(
      "AUTH_FORBIDDEN",
    );
    const hidden = await h.rpc(h.client, "workflows.validateInputs", { workflowId: "hidden", vars: {} });
    const absent = await h.rpc(h.client, "workflows.validateInputs", { workflowId: "absent", vars: {} });
    expect(hidden.error?.code).toBe("WORKFLOW_NOT_FOUND");
    expect(JSON.stringify(hidden.error).replaceAll("hidden", "ID")).toBe(
      JSON.stringify(absent.error).replaceAll("absent", "ID"),
    );
    expect(validate).not.toHaveBeenCalled();
    const hello = await h.rpc(h.client, "hello", { client: "test", protocol: { major: 2, minor: 0 } });
    expect(hello.result?.methods).toContain("workflows.validateInputs");
    expect(hello.result?.capabilities).toContain("workflows.validateInputs");
    const viewerHello = await h.rpc(h.viewer, "hello", { client: "test", protocol: { major: 2, minor: 0 } });
    expect(viewerHello.result?.methods).not.toContain("workflows.validateInputs");
    expect(viewerHello.result?.capabilities).not.toContain("workflows.validateInputs");
  });

  it("records verified actors on start, answer and cancellation rather than trusting RPC fields", async () => {
    const h = await fixture();
    const started = await h.rpc(h.client, "runs.start", {
      workflowId: "typed",
      vars: { count: 3 },
      actor: { principalId: "forged" },
    });
    expect(started.ok).toBe(true);
    const runId = started.result!.runId as string;
    const input = (await h.orchestrator.pendingInputs(runId))[0]!;
    expect(
      (
        await h.rpc(h.owner, "inputs.answer", {
          runId,
          requestId: input.id,
          optionId: "ship",
          resume: false,
          actor: { principalId: "forged" },
        })
      ).ok,
    ).toBe(true);
    expect((await h.rpc(h.client, "runs.cancel", { runId, actor: { principalId: "forged" } })).ok).toBe(true);
    const events = await h.orchestrator.events(runId);
    expect(events.find((event) => event.type === "run.created")?.payload).toMatchObject({
      actor: { principalId: "client", credentialId: expect.any(String) },
    });
    expect(events.find((event) => event.type === "human.answered")?.payload).toMatchObject({
      actor: { principalId: "owner", credentialId: expect.any(String) },
    });
    expect(events.find((event) => event.type === "run.cancelled")?.payload).toMatchObject({
      actor: { principalId: "client", credentialId: expect.any(String) },
    });
    expect(JSON.stringify(events)).not.toContain("forged");
  });

  it("uses the same protected preflight contract over WebSocket", async () => {
    const h = await fixture();
    const socket = new WebSocket(h.daemon.socketUrl!, ["orca.v1", `orca.bearer.${h.client}`]);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    cleanup.push(async () => {
      socket.close();
    });
    let id = 0;
    const call = (method: string, params: unknown) =>
      new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: { code: string } }>((resolve) => {
        socket.once("message", (data) =>
          resolve(
            JSON.parse(
              (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString(
                "utf8",
              ),
            ) as never,
          ),
        );
        socket.send(JSON.stringify({ kind: "request", id: ++id, method, params }));
      });
    const good = await call("workflows.validateInputs", { workflowId: "typed", vars: { count: 3 } });
    expect(good.result?.validation).toMatchObject({ ok: true });
    expect(good.result).not.toHaveProperty("vars");
    const denied = await call("workflows.validateInputs", { workflowId: "hidden", vars: {} });
    expect(denied.error?.code).toBe("WORKFLOW_NOT_FOUND");
    const invalid = await call("runs.start", { workflowId: "typed", vars: { count: "invalid" } });
    expect(invalid.error?.code).toBe("WORKFLOW_INPUT_INVALID");
    expect(await h.orchestrator.listRuns()).toEqual([]);
  });

  it("rejects invalid vars and stale revision before recording definitions, provisioning or creating runs", async () => {
    const h = await fixture();
    const provision = vi.spyOn(h.workspaceProvider, "provision");
    const putDefinition = vi.spyOn(h.stores.workflows, "put");
    const bad = await h.rpc(h.client, "runs.start", { workflowId: "typed", vars: { count: "three" } });
    expect(bad.error?.code).toBe("WORKFLOW_INPUT_INVALID");
    const preflight = await h.rpc(h.client, "workflows.validateInputs", { workflowId: "typed", vars: { count: 3 } });
    expect(preflight.result?.validation).toMatchObject({ ok: true });
    h.workflows.register(definition("typed", "1", 2));
    const stale = await h.rpc(h.client, "runs.start", {
      workflowId: "typed",
      workflowVersion: preflight.result?.version,
      expectedWorkflowRevision: preflight.result?.revision,
      vars: { count: 3 },
    });
    expect(stale.error?.code).toBe("WORKFLOW_INVALID");
    expect(provision).not.toHaveBeenCalled();
    expect(putDefinition).not.toHaveBeenCalled();
    expect(await h.orchestrator.listRuns()).toEqual([]);
    const fresh = await h.rpc(h.client, "workflows.validateInputs", { workflowId: "typed", vars: { count: 3 } });
    const started = await h.rpc(h.client, "runs.start", {
      workflowId: "typed",
      workflowVersion: fresh.result?.version,
      expectedWorkflowRevision: fresh.result?.revision,
      vars: { count: 3 },
    });
    expect(started.ok).toBe(true);
    h.workflows.register(definition("typed", "2", 20));
    const historical = await h.rpc(h.client, "runs.start", {
      workflowId: "typed",
      workflowVersion: fresh.result?.version,
      expectedWorkflowRevision: fresh.result?.revision,
      vars: { count: 3 },
    });
    expect(historical.ok).toBe(true);
    expect((await h.orchestrator.getState(historical.result!.runId as string)).run.workflowVersion).toBe("1");
  });

  it("binds the exact returned run to its caller before execution, never an interleaved direct start", async () => {
    const h = await fixture();
    const originalStart = h.orchestrator.startRun.bind(h.orchestrator);
    let unrelated = "";
    vi.spyOn(h.orchestrator, "startRun").mockImplementationOnce(async (opts) => {
      unrelated = await originalStart({ workflowId: "typed", vars: { count: 5 } });
      return originalStart(opts);
    });
    const drive = h.orchestrator.run.bind(h.orchestrator);
    vi.spyOn(h.orchestrator, "run").mockImplementation((runId) => {
      expect(h.ownership.owner(runId)).toBe("client");
      expect(h.ownership.owner(unrelated)).toBeUndefined();
      return drive(runId);
    });
    const started = await h.rpc(h.client, "runs.start", { workflowId: "typed", vars: { count: 3 } });
    expect(started.ok).toBe(true);
    expect(h.ownership.owner(started.result!.runId as string)).toBe("client");
    expect(h.ownership.owner(unrelated)).toBeUndefined();
  });
});

async function permissionGate(h: Awaited<ReturnType<typeof fixture>>) {
  h.workflows.register(
    WorkflowDefinitionSchema.parse({
      id: "permission",
      name: "Permission",
      start: "work",
      nodes: { work: { type: "agent", agent: "builder", prompt: "Edit a.ts" }, end: { type: "end" } },
      edges: [{ from: "work", to: "end" }],
    }),
  );
  const answers: (string | undefined)[] = [];
  h.orchestrator.sessionFactory = async (options) => {
    const id = randomUUID();
    const lifetime = new AbortController();
    let closed!: () => void;
    const session: AgentSession = {
      id,
      agentId: options.agent.id,
      hostId: options.host.id,
      cwd: options.cwd,
      acpSessionId: id,
      configOptions: [],
      setConfigOption: async () => [],
      onUpdate: () => () => {},
      closed: new Promise<void>((resolve) => {
        closed = resolve;
      }),
      cancel: async () => {
        lifetime.abort();
      },
      close: async () => {
        lifetime.abort();
        closed();
      },
      prompt: async (_prompt, control) => {
        const answer = await options.askPermission!(
          {
            sessionId: id,
            toolCall: {
              toolCallId: "tool",
              title: "Edit a.ts",
              kind: "edit",
              locations: [{ path: join(h.dir, "a.ts") }],
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
          {
            sessionId: id,
            turnId: randomUUID(),
            invocationId: randomUUID(),
            signal: AbortSignal.any([lifetime.signal, ...(control?.signal ? [control.signal] : [])]),
          },
        );
        answers.push(answer);
        return { stopReason: "end_turn", durationMs: 1 };
      },
    };
    return session;
  };
  const runId = await h.orchestrator.startRun({ workflowId: "permission" });
  const done = h.orchestrator.run(runId);
  void done.catch(() => undefined);
  cleanup.push(async () => {
    h.livePort.close();
    await done.catch(() => undefined);
  });
  await vi.waitFor(async () => expect((await h.reads.inputsList({ runId })).inputs).toHaveLength(1));
  const input = (await h.reads.inputsList({ runId })).inputs[0]!;
  expect(input.live?.state).toBe("pending");
  return { params: { runId, requestId: input.id, live: input.live!.target }, done, answers };
}
const sidecar = async (path: string) =>
  readFile(path, "utf8").catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  });

describe("standing permission acceptance", () => {
  it("does not grant for an invalid option, stale gate, wrong run or foreign lease", async () => {
    const h = await fixture();
    const live = await permissionGate(h);
    const gate = live.params;
    const params = { ...gate, optionId: "allow", always: { decision: "allow" }, resume: true };
    expect((await h.rpc(h.owner, "inputs.answer", { ...params, optionId: "wrong" })).error?.code).toBe("RUN_STATE");
    expect(await sidecar(h.permissionsFile)).toBeUndefined();
    expect((await h.rpc(h.owner, "inputs.answer", { ...params, runId: "wrong-run" })).ok).toBe(false);
    expect(h.livePort.inspect(gate.live)).toBe("pending");
    // This is the original interpreter's lease, not a synthetic parked permission gate.
    await h.stores.leases.forceRelease(runLeaseResource(gate.runId));
    const foreign = await h.stores.leases.acquire({ resource: runLeaseResource(gate.runId), holder: "foreign" });
    const before = await h.orchestrator.events(gate.runId);
    expect((await h.rpc(h.owner, "inputs.answer", params)).error?.code).toBe("RUN_LEASED");
    await live.done.catch(() => undefined);
    expect(h.livePort.inspect(gate.live)).toBe("expired");
    expect(await h.orchestrator.events(gate.runId)).toEqual(before);
    expect(await sidecar(h.permissionsFile)).toBeUndefined();
    await h.stores.leases.release(foreign);
    const next = await permissionGate(h);
    expect((await h.rpc(h.owner, "inputs.answer", { ...next.params, optionId: "deny" })).ok).toBe(true);
    await next.done;
    expect((await h.rpc(h.owner, "inputs.answer", { ...params, ...next.params })).error).toMatchObject({
      code: "RUN_STATE",
      details: { liveInputState: "expired" },
    });
    expect(await sidecar(h.permissionsFile)).toBeUndefined();
  });
  it("refuses no-resume for a live callback without consuming the ask or writing a standing grant", async () => {
    const h = await fixture();
    const live = await permissionGate(h);
    expect(
      (
        await h.rpc(h.owner, "inputs.answer", {
          ...live.params,
          optionId: "allow",
          always: { decision: "allow" },
          resume: false,
        })
      ).error?.code,
    ).toBe("NOT_SUPPORTED");
    expect(h.livePort.inspect(live.params.live)).toBe("pending");
    expect(live.answers).toEqual([]);
    expect((await h.orchestrator.events(live.params.runId)).some((event) => event.type === "human.answered")).toBe(
      false,
    );
    expect(await sidecar(h.permissionsFile)).toBeUndefined();
  });
  it("persists only the accepted decision when concurrent always answers race", async () => {
    const h = await fixture();
    const live = await permissionGate(h);
    const gate = live.params;
    const accept = h.livePort.answer.bind(h.livePort);
    let arrivals = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(h.livePort, "answer").mockImplementation(async (...args) => {
      if (++arrivals === 2) release();
      await together;
      return accept(...args);
    });
    const replies = await Promise.all(
      ["allow", "deny"].map((decision) =>
        h.rpc(h.owner, "inputs.answer", { ...gate, optionId: decision, always: { decision }, resume: true }),
      ),
    );
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
    const winner = replies.find((reply) => reply.ok)!.result!.answer as string;
    const saved = JSON.parse((await sidecar(h.permissionsFile))!) as { agents: Record<string, unknown> };
    expect(JSON.stringify(saved)).toContain(`"decision":"${winner}"`);
    expect(JSON.stringify(saved)).not.toContain(`"decision":"${winner === "allow" ? "deny" : "allow"}"`);
    expect((await live.done).run.status).toBe("completed");
    expect(live.answers).toEqual([winner]);
    expect((await h.orchestrator.events(gate.runId)).filter((event) => event.type === "human.answered")).toMatchObject([
      { payload: { answer: winner, actor: { principalId: "owner" } } },
    ]);
  });
  it("refuses an always whose one-time answer goes the other way, before answering anything", async () => {
    const h = await fixture();
    const live = await permissionGate(h);
    const gate = live.params;
    // The agent's Deny is `reject_once`, so the ask marks it destructive.
    for (const [optionId, decision] of [
      ["allow", "deny"],
      ["deny", "allow"],
    ] as const) {
      const reply = await h.rpc(h.owner, "inputs.answer", { ...gate, optionId, always: { decision }, resume: true });
      expect(reply.ok).toBe(false);
      expect(reply.error?.code).toBe("NOT_SUPPORTED");
    }
    expect(await sidecar(h.permissionsFile)).toBeUndefined();
    expect(live.answers).toEqual([]);
    expect(h.livePort.inspect(gate.live)).toBe("pending");
    // Agreeing ones go through: this call is denied and so are the next ones.
    const reply = await h.rpc(h.owner, "inputs.answer", {
      ...gate,
      optionId: "deny",
      always: { decision: "deny" },
      resume: true,
    });
    expect(reply.ok).toBe(true);
    expect(JSON.stringify(JSON.parse((await sidecar(h.permissionsFile))!))).toContain(`"decision":"deny"`);
    await live.done;
    expect(live.answers).toEqual(["deny"]);
  });
  it("does not grant if the accepted-answer log write fails", async () => {
    const h = await fixture();
    const live = await permissionGate(h);
    const gate = live.params;
    const append = h.orchestrator.stores.events.append.bind(h.orchestrator.stores.events);
    vi.spyOn(h.orchestrator.stores.events, "append").mockImplementation(async (event) => {
      if (event.type === "human.answered") throw new Error("fixture append failed");
      return append(event);
    });
    const resume = vi.spyOn(h.orchestrator, "resume");
    const reply = await h.rpc(h.owner, "inputs.answer", { ...gate, optionId: "allow", always: { decision: "allow" } });
    expect(reply.ok).toBe(false);
    expect(await sidecar(h.permissionsFile)).toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
    expect((await live.done).run.status).toBe("failed");
    expect(live.answers).toEqual([]);
    expect(h.livePort.inspect(gate.live)).toBe("expired");
    expect((await h.orchestrator.events(gate.runId)).some((event) => event.type === "human.answered")).toBe(false);
    expect((await h.orchestrator.getState(gate.runId)).humanInputs[gate.requestId]?.answer).toBeUndefined();
    expect(await h.orchestrator.pendingInputs(gate.runId)).toEqual([]);
  });
  it("does not consume a non-permission gate when always is invalid", async () => {
    const h = await fixture();
    const state = await h.orchestrator.startAndRun({ workflowId: "typed", vars: { count: 3 } });
    const gate = (await h.orchestrator.pendingInputs(state.run.id))[0]!;
    const reply = await h.rpc(h.owner, "inputs.answer", {
      runId: state.run.id,
      requestId: gate.id,
      optionId: "ship",
      always: { decision: "allow" },
    });
    expect(reply.error?.code).toBe("NOT_SUPPORTED");
    expect(await sidecar(h.permissionsFile)).toBeUndefined();
    expect((await h.orchestrator.pendingInputs(state.run.id)).map((request) => request.id)).toContain(gate.id);
  });
  it("leaves a durably accepted one-time answer parked if the standing grant cannot be saved", async () => {
    const h = await fixture();
    const live = await permissionGate(h);
    const gate = live.params;
    await mkdir(h.permissionsFile);
    const resume = vi.spyOn(h.orchestrator, "resume");
    const reply = await h.rpc(h.owner, "inputs.answer", { ...gate, optionId: "allow", always: { decision: "allow" } });
    expect(reply.ok).toBe(false);
    expect(reply.error?.details).toMatchObject({ answerRecorded: true });
    expect(resume).not.toHaveBeenCalled();
    const state = await live.done;
    expect(state.run.status).toBe("paused");
    expect(state.humanInputs[gate.requestId]?.answer).toBe("allow");
    expect(live.answers).toEqual([]);
    expect(h.livePort.inspect(gate.live)).toBe("expired");
  });
});

it("recovers from an ownership persistence failure after a later durable write succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orca-owner-recovery-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "ownership.json");
  const ownership = new OwnershipStore(file);
  await mkdir(file);
  expect(() => ownership.record("first", "owner")).toThrow();
  await rm(file, { recursive: true });
  ownership.record("second", "owner");
  await ownership.flush();
  expect(ownership.lastError).toBeUndefined();
  expect(new OwnershipStore(file).owner("second")).toBe("owner");
});

it("keeps the first live cancellation reason and actor together under concurrent cancellation", async () => {
  const h = await fixture();
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.orchestrator.executors.register({
    type: "custom:wait",
    execute: async (ctx) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        ctx.signal.addEventListener("abort", () => reject(new OrcaError("CANCELLED", String(ctx.signal.reason))), {
          once: true,
        }),
      );
      throw new Error("unreachable");
    },
  });
  h.workflows.register(
    WorkflowDefinitionSchema.parse({
      id: "active",
      name: "Active",
      start: "work",
      nodes: { work: { type: "custom:wait" }, end: { type: "end" } },
      edges: [{ from: "work", to: "end" }],
    }),
  );
  const runId = await h.orchestrator.startRun({ workflowId: "active" });
  const running = h.orchestrator.run(runId);
  await active;
  await Promise.all([
    h.orchestrator.cancel(runId, "alice cancelled", { principalId: "alice" }),
    h.orchestrator.cancel(runId, "bob cancelled", { principalId: "bob" }),
  ]);
  await running;
  expect((await h.orchestrator.events(runId)).find((event) => event.type === "run.cancelled")?.payload).toMatchObject({
    reason: "alice cancelled",
    actor: { principalId: "alice" },
  });
});
