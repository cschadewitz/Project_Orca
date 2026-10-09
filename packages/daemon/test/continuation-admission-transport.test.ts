/** Real token transports and durable stores; no permissive continuation authority fixture. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRegistry } from "@orca/agents";
import { OrcaError, parseOrcaConfig, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { executionEvents, fileStores } from "@orca/store";
import { builtinExecutors, completed, LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "@orca/engine";
import { ControlModel, ReadModel, startDaemon } from "@orca/daemon";
import {
  PROTOCOL_VERSION,
  OperatorDiscoverySchema,
  ContinuationReceiptSchema,
  RunsContinueResultSchema,
  RunsGetResultSchema,
  type ResponseMessage,
} from "@orca/protocol";
import { ConfigurationGenerations } from "../../engine/src/configuration-generation.js";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { FileContinuationLocatorStore } from "../../store/src/continuation-admission-store.js";
import { ContinuationAdmissionModel } from "../src/continuation-admission.js";
import { CredentialStore, OwnershipStore, orchestratorResolver, type IssueOptions } from "../src/auth/index.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";
import { createRevisionRuntime } from "../../engine/src/revision-runtime.js";
import { scriptedAgentSpec } from "@orca/testing";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function result(response: ResponseMessage): unknown {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.result;
}
const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "limit"),
};

it.each(["http", "socket"] as const)(
  "operator continuation aliases preserve real receipt and one attachment over %s",
  async (transport) => {
    const f = await fixture({ operator: true });
    const call = transport === "http" ? (method: string, params: unknown) => f.http(method, params) : await f.socket();
    const target = OperatorDiscoverySchema.parse(result(await call("operator.discover", {}))).target;
    expect(result(await call("operator.page", { target, collection: "runs", runId: f.runId }))).toMatchObject({
      items: [{ id: f.runId, continuationState: "available", expectedBoundary: f.params.command.expectedBoundary }],
      restartRequired: false,
    });
    const receipt = RunsContinueResultSchema.parse(result(await call("operator.continueRun", { target, ...f.params })));
    if (receipt.state !== "resolved") throw new Error("not resolved");
    await f.entered.wait;
    expect(f.effects).toHaveBeenCalledTimes(1);
    expect(result(await call("operator.continueRun", { target, ...f.params }))).toMatchObject({
      ...receipt,
      replayed: true,
    });
    const lookup = { target, continuationId: receipt.result.continuationId };
    expect(result(await call("operator.continuation", lookup))).toMatchObject({
      continuationId: receipt.result.continuationId,
    });
    expect(await call("operator.reconcileContinuation", lookup)).toMatchObject({
      ok: false,
      error: { code: "RUN_LEASED" },
    });
    expect(f.effects).toHaveBeenCalledTimes(1);
    f.finish.release();
    await f.model.drain();
    expect(result(await call("operator.reconcileContinuation", lookup))).toMatchObject({
      continuationId: receipt.result.continuationId,
      state: "settled",
    });
    expect(f.effects).toHaveBeenCalledTimes(1);
  },
);
async function fixture(
  options: { manualDispatch?: boolean; readOnly?: boolean; operator?: boolean; revision?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "orca-continuation-transport-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const credentialsFile = join(dir, "credentials.json"),
    ownershipFile = join(dir, "ownership.json");
  const credentials = new CredentialStore({ file: credentialsFile });
  const grants: IssueOptions = {
    principal: "alice",
    permissions: ["runs.read", "runs.control", "inputs.answer", "runs.start"],
    scope: { workflows: ["continuation"], runs: "owned" },
  };
  const alice = await credentials.issue(grants);
  const owner = await credentials.issue({ principal: "owner", preset: "owner" });
  const observer = await credentials.issue({
    principal: "observer",
    permissions: ["runs.read"],
    scope: { workflows: ["continuation"], runs: "all" },
  });
  const outsider = await credentials.issue({ ...grants, principal: "outsider" });
  const controlOnly = await credentials.issue({ ...grants, permissions: ["runs.read", "runs.control"] });
  const finish = latch(),
    entered = latch();
  const effects = vi.fn();
  const definition = parseWorkflow(`
id: continuation
name: Continuation
version: '1'
start: start
nodes:
  start: {type: start}
  gate:
    type: gate
    question: Go?
    options: ${options.revision ? "[go, changes]" : "[go]"}
    ${
      options.revision
        ? "revision: {actionId: changes, destinationNodeId: revise, payload: {kind: text, maxBytes: 1024}, composition: replace-revision-slot}"
        : ""
    }
  work: {type: 'custom:work'}
  ${options.revision ? "revise: {type: agent, agent: worker, prompt: Original}" : ""}
  end: {type: end}
edges:
  - {from: start, to: gate}
  - {from: gate, to: work${options.revision ? ", when: \"choice == 'go'\"" : ""}}
  ${options.revision ? "- {from: gate, to: revise, when: \"choice == 'changes'\"}\n  - {from: revise, to: end}" : ""}
  - {from: work, to: end}
`);
  const config = parseOrcaConfig({ agents: options.revision ? [scriptedAgentSpec({ id: "worker" })] : [] });
  async function boot(readOnly = options.readOnly ?? false) {
    const stores = fileStores(dir);
    const currentCredentials = new CredentialStore({ file: credentialsFile });
    const ownership = new OwnershipStore(ownershipFile);
    const executors = builtinExecutors().register({
      type: "custom:work",
      execute: async () => {
        effects();
        entered.release();
        await finish.wait;
        return completed();
      },
    });
    const orc: Orchestrator = new Orchestrator({
      stores,
      executors,
      agents: AgentRegistry.fromConfig(config),
      workflows: new WorkflowRegistry().register(definition),
      templates: new TemplateRegistry(),
      workspaceProvider: new LocalWorkspaceProvider(dir),
      humanInput: new PausingHumanInput(),
      ...(options.revision
        ? {
            revisionRuntime: createRevisionRuntime({
              stores,
              authorizeExecution: (runId) => runtime.authorizeExecution(runId),
            }).runtime,
          }
        : {}),
    });
    const runtime = daemonExecutionRuntime({
      instanceId: "transport-test",
      orchestrator: orc,
      credentials: currentCredentials,
      ownership,
    });
    orc.liveInput = runtime;
    const generations = new ConfigurationGenerations({
      store: stores.execution,
      workflows: stores.workflows,
      loadAssets: async () => ({ workflows: [definition], templates: [] }),
      admission: {
        validateStartRun: (opts, material) => orc.validateStartRun(opts, material),
        startRun: (opts, material) => orc.startRun(opts, material),
      },
      validateCustomNode: (node) => executors.validateNode(node),
    });
    await generations.initialize(config, "test");
    orc.generations = generations;
    const retries = new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults });
    const model = new ContinuationAdmissionModel({
      claims: new RegisteredRetryClaims(retries, faults),
      orchestrator: orc,
      locators: new FileContinuationLocatorStore({ storeDir: dir, execution: stores.execution, retries }),
      executionRuntime: runtime,
      ...(options.manualDispatch ? { schedule: () => {} } : {}),
    });
    const reads = new ReadModel({ orchestrator: orc });
    const daemon = await startDaemon({
      orcaVersion: "test",
      capabilities: ["runs.read", "runs.subscribe", ...(readOnly ? [] : ["runs.control" as const])],
      reads,
      ...(readOnly ? {} : { control: new ControlModel({ orchestrator: orc, reads }) }),
      source: orc,
      continuationAdmissions: model,
      submissionWorkspaceId: options.operator ? "4c41c2ae-8064-419a-ae88-0b1ad89ca402" : "transport-workspace",
      ...(options.operator
        ? {
            workspaceId: "4c41c2ae-8064-419a-ae88-0b1ad89ca402",
            operatorSources: { events: stores.events, leases: stores.leases },
          }
        : {}),
      auth: { mode: "token", credentials: currentCredentials, ownership, resolver: orchestratorResolver(orc) },
    });
    cleanups.push(async () => {
      finish.release();
      await model.drain();
      runtime.close();
      await daemon.close();
    });
    const http = async (method: string, params: unknown, token = alice.token): Promise<ResponseMessage> => {
      const response = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: "request", id: 1, method, params }),
      });
      return (await response.json()) as ResponseMessage;
    };
    const socket = async (token = alice.token) => {
      const ws = new WebSocket(daemon.socketUrl!, ["orca.v1", `orca.bearer.${token}`]);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
      });
      cleanups.push(async () => {
        ws.close();
      });
      let id = 0;
      return async (method: string, params: unknown): Promise<ResponseMessage> => {
        const requestId = ++id;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 5_000);
          const listener = (event: MessageEvent) => {
            const frame = JSON.parse(String(event.data)) as ResponseMessage;
            if (frame.kind === "response" && frame.id === requestId) {
              clearTimeout(timer);
              ws.removeEventListener("message", listener);
              resolve(frame);
            }
          };
          ws.addEventListener("message", listener);
          ws.send(JSON.stringify({ kind: "request", id: requestId, method, params }));
        });
      };
    };
    return { stores, ownership, orc, runtime, generations, model, daemon, http, socket };
  }
  const first = await boot();
  const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "continuation" });
  const runId = await launch.startRun({ actor: { principalId: "alice", credentialId: alice.credential.id } });
  first.ownership.record(runId, "alice");
  await first.ownership.flush(runId);
  expect((await first.orc.run(runId)).run.status).toBe("paused");
  const input = (await first.orc.pendingInputs(runId))[0]!;
  const read = RunsGetResultSchema.parse(result(await first.http("runs.get", { runId })));
  expect(read.continuation?.expectedBoundary).toMatch(/^cb1_[A-Za-z0-9_-]{43}$/);
  const params = {
    command: {
      runId,
      expectedBoundary: read.continuation!.expectedBoundary,
      decision: { requestId: input.id, optionId: "go", note: "private-note-SECRET" },
    },
    retry: { idempotencyKey: "same-intent" },
  };
  return {
    ...first,
    dir,
    boot,
    credentials,
    grants,
    alice,
    owner,
    observer,
    outsider,
    controlOnly,
    finish,
    entered,
    effects,
    runId,
    input,
    params,
  };
}

it.each(["http", "socket"] as const)(
  "%s operator refuses fresh revision-action continuation without consuming its key",
  async (transport) => {
    const f = await fixture({ operator: true, revision: true, manualDispatch: true });
    const call = transport === "http" ? (method: string, params: unknown) => f.http(method, params) : await f.socket();
    const target = OperatorDiscoverySchema.parse(result(await call("operator.discover", {}))).target;
    const params = { target, ...f.params };
    expect(
      await call("operator.continueRun", {
        ...params,
        command: { ...params.command, decision: { ...params.command.decision, optionId: "changes" } },
      }),
    ).toMatchObject({ ok: false, error: { code: "CONTINUATION_STALE" } });
    expect(await readdir(join(f.dir, "admission-retries"))).toEqual([]);
    // A revision action needs revision input; rejecting it must leave this key usable.
    expect(result(await call("operator.continueRun", params))).toMatchObject({ state: "resolved", replayed: false });
    expect(result(await call("operator.continueRun", params))).toMatchObject({ state: "resolved", replayed: true });
    expect(f.effects).not.toHaveBeenCalled();
  },
);

it.each(["http", "socket"] as const)(
  "%s operator rejects terminal Revision continuation without publishing a durable retry reservation",
  async (transport) => {
    const f = await fixture({ operator: true, revision: true });
    const call = transport === "http" ? (method: string, params: unknown) => f.http(method, params) : await f.socket();
    const target = OperatorDiscoverySchema.parse(result(await call("operator.discover", {}))).target;
    const params = { target, ...f.params };
    const original = RunsContinueResultSchema.parse(result(await call("operator.continueRun", params)));
    if (original.state !== "resolved") throw new Error("not resolved");
    await f.entered.wait;
    f.finish.release();
    await f.model.drain();
    expect((await f.orc.getState(f.runId)).run.status).toBe("completed");
    expect(await f.stores.events.readTypes(f.runId, ["revision.recorded"])).not.toHaveLength(0);
    // Inspect the host's actual catalog, encrypted generations and run journal,
    // independently of the connector response or its authorized read projection.
    const snapshot = async () => {
      const files: Record<string, string> = {};
      for (const area of ["admission-retries", "private-execution", "runs"]) {
        for (const entry of await readdir(join(f.dir, area), { recursive: true, withFileTypes: true })) {
          if (entry.isFile()) {
            const path = join(entry.parentPath, entry.name);
            files[path] = (await readFile(path)).toString("base64");
          }
        }
      }
      return files;
    };
    const before = await snapshot();
    const catalog = await readFile(join(f.dir, "admission-retries/catalog.json"), "utf8");
    for (const retry of [{ idempotencyKey: "fresh-terminal-revision" }, {}]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response =
          "idempotencyKey" in retry
            ? await call("operator.continueRun", { ...params, retry })
            : await call("runs.continue", { ...f.params, retry });
        expect(response).toMatchObject({
          ok: false,
          error: { code: "CONTINUATION_STALE" },
        });
        expect(await readFile(join(f.dir, "admission-retries/catalog.json"), "utf8")).toBe(catalog);
        expect(await snapshot()).toEqual(before);
      }
    }
    expect(result(await call("operator.continueRun", params))).toEqual({ ...original, replayed: true });
    await f.model.drain();
    expect(await snapshot()).toEqual(before);
    expect(f.effects).toHaveBeenCalledTimes(1);
    expect(await f.stores.leases.get(`run:${f.runId}`)).toBeUndefined();
  },
);

it.each(["http", "socket"] as const)(
  "%s authenticates context, validates identical schemas and promptly accepts once while execution blocks",
  async (transport) => {
    const f = await fixture();
    const call = transport === "http" ? (method: string, params: unknown) => f.http(method, params) : await f.socket();
    expect(await call("runs.continue", { ...f.params, actor: { principalId: "owner" } })).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MESSAGE" },
    });
    const admitted = RunsContinueResultSchema.parse(result(await call("runs.continue", f.params)));
    expect(admitted.state).toBe("resolved");
    if (admitted.state !== "resolved") throw new Error("not resolved");
    expect(admitted.result.state).toBe("accepted");
    await f.entered.wait;
    expect(f.effects).toHaveBeenCalledTimes(1);
    const duplicate = RunsContinueResultSchema.parse(result(await call("runs.continue", f.params)));
    expect(duplicate).toMatchObject({
      state: "resolved",
      operationId: admitted.operationId,
      replayed: true,
      result: { continuationId: admitted.result.continuationId },
    });
    expect(
      await call("runs.continue", {
        ...f.params,
        command: { ...f.params.command, decision: { ...f.params.command.decision, note: "different" } },
      }),
    ).toMatchObject({ ok: false, error: { code: "RETRY_CONFLICT" } });
    const otherTransport =
      transport === "http" ? await f.socket() : (method: string, params: unknown) => f.http(method, params);
    expect(result(await otherTransport("runs.continue", f.params))).toMatchObject({
      state: "resolved",
      operationId: admitted.operationId,
      replayed: true,
      result: { continuationId: admitted.result.continuationId },
    });
    const inspect = { continuationId: admitted.result.continuationId };
    expect(
      ContinuationReceiptSchema.parse(result(await f.http("continuations.get", inspect, f.observer.token))),
    ).toMatchObject({ state: "accepted" });
    expect(await f.http("continuations.reconcile", inspect, f.observer.token)).toMatchObject({
      ok: false,
      error: { code: "AUTH_FORBIDDEN" },
    });
    expect(await f.http("continuations.get", inspect, f.outsider.token)).toMatchObject({ ok: false });
    f.finish.release();
    await f.model.drain();
    expect(result(await call("continuations.get", inspect))).toMatchObject({ state: "settled" });
    expect(result(await call("runs.get", { runId: f.runId }))).not.toHaveProperty("continuation");
    const events = await executionEvents(await f.stores.events.read(f.runId), f.stores.execution);
    expect(events.filter((event) => event.type === "continuation.recorded" && event.payload.decision)).toHaveLength(1);
    expect(f.effects).toHaveBeenCalledTimes(1);
    const entry = events.find((event) => event.type === "continuation.recorded")!;
    expect(entry.payload).toMatchObject({
      entry: {
        actor: { principalId: "alice", credentialId: f.alice.credential.id },
        workspaceId: "transport-workspace",
      },
    });
    expect(JSON.stringify(await f.stores.events.read(f.runId))).not.toContain("private-note-SECRET");
  },
);

it("omits tokens for unsupported runs and denied reads; HTTP/socket enforce grants before malformed diagnostics", async () => {
  const f = await fixture({ manualDispatch: true });
  const observerSocket = await f.socket(f.observer.token);
  for (const call of [(method: string, params: unknown) => f.http(method, params, f.observer.token), observerSocket]) {
    expect(await call("runs.continue", { nonsense: true })).toMatchObject({
      ok: false,
      error: { code: "AUTH_FORBIDDEN" },
    });
    expect(await call("continuations.reconcile", { nonsense: true })).toMatchObject({
      ok: false,
      error: { code: "AUTH_FORBIDDEN" },
    });
  }
  expect(await f.http("runs.continue", f.params, f.controlOnly.token)).toMatchObject({
    ok: false,
    error: { code: "AUTH_FORBIDDEN" },
  });
  const denied = await f.http("runs.get", { runId: f.runId }, f.outsider.token);
  expect(denied).toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } });
  expect(JSON.stringify(denied)).not.toContain("cb1_");
  const legacy = await f.orc.startRun({ workflowId: "continuation", parentRunId: f.runId, parentStepRunId: "child" });
  await f.orc.run(legacy);
  expect(result(await f.http("runs.get", { runId: legacy }, f.owner.token))).not.toHaveProperty("continuation");
  expect((await f.orc.getState(f.runId)).humanInputs[f.input.id]!.answer).toBeUndefined();
  expect(f.effects).not.toHaveBeenCalled();
});

it("read-only daemon exposes dedicated inspection and boundary reads without continuation mutations", async () => {
  const f = await fixture({ manualDispatch: true });
  const admitted = RunsContinueResultSchema.parse(result(await f.http("runs.continue", f.params)));
  if (admitted.state !== "resolved") throw new Error("not resolved");
  const reader = await f.boot(true);
  const hello = result(
    await reader.http("hello", { client: "continuation-test", protocol: PROTOCOL_VERSION }, f.observer.token),
  ) as { methods: string[] };
  expect(hello.methods).toContain("continuations.get");
  expect(hello.methods).not.toContain("runs.continue");
  expect(hello.methods).not.toContain("continuations.reconcile");
  const inspect = { continuationId: admitted.result.continuationId };
  expect(result(await reader.http("continuations.get", inspect, f.observer.token))).toEqual(admitted.result);
  const socket = await reader.socket(f.observer.token);
  expect(result(await socket("continuations.get", inspect))).toEqual(admitted.result);
  expect(f.effects).not.toHaveBeenCalled();
});

it.each([false, true])(
  "startup recovers only stored original credential (rotated=%s), never owner fallback",
  async (rotated) => {
    const f = await fixture({ manualDispatch: true });
    const admitted = RunsContinueResultSchema.parse(result(await f.http("runs.continue", f.params)));
    if (admitted.state !== "resolved") throw new Error("not resolved");
    const inspect = { continuationId: admitted.result.continuationId };
    const replacement = rotated ? await f.credentials.rotate(f.alice.credential.id) : undefined;
    const restarted = await f.boot();
    expect(restarted.daemon.recoverContinuations).toBeTypeOf("function");
    await restarted.daemon.recoverContinuations!();
    if (replacement) {
      expect(result(await restarted.http("continuations.get", inspect, f.owner.token))).toMatchObject({
        state: "blocked",
        blockedReason: "authority-unavailable",
      });
      expect(f.effects).not.toHaveBeenCalled();
      expect(await restarted.http("runs.continue", f.params, f.alice.token)).toMatchObject({
        ok: false,
        error: { code: "AUTH_INVALID" },
      });
      const replay = RunsContinueResultSchema.parse(
        result(await restarted.http("runs.continue", f.params, replacement.token)),
      );
      expect(replay).toMatchObject({ state: "resolved", operationId: admitted.operationId, replayed: true });
      expect(await restarted.http("continuations.reconcile", inspect, f.controlOnly.token)).toMatchObject({
        ok: false,
        error: { code: "AUTH_FORBIDDEN" },
      });
      expect(result(await restarted.http("continuations.reconcile", inspect, replacement.token))).toMatchObject({
        state: "accepted",
      });
    }
    await f.entered.wait;
    expect(f.effects).toHaveBeenCalledTimes(1);
    f.finish.release();
    await restarted.model.drain();
    expect(result(await restarted.http("continuations.get", inspect, f.observer.token))).toMatchObject({
      state: "settled",
    });
    const events = await executionEvents(await restarted.stores.events.read(f.runId), restarted.stores.execution);
    expect(events.filter((event) => event.type === "continuation.recorded" && event.payload.decision)).toHaveLength(1);
    await f.credentials.revoke(f.observer.credential.id);
    expect(await restarted.http("continuations.get", inspect, f.observer.token)).toMatchObject({
      ok: false,
      error: { code: "AUTH_INVALID" },
    });
  },
);

it.each(["http", "socket"] as const)(
  "%s inspection refuses uncertain journal durability without writing or executing",
  async (transport) => {
    const f = await fixture({ manualDispatch: true });
    const admitted = RunsContinueResultSchema.parse(result(await f.http("runs.continue", f.params)));
    if (admitted.state !== "resolved") throw new Error("not resolved");
    const before = await f.stores.events.read(f.runId);
    const synchronize = vi
      .spyOn(f.stores.events, "synchronizeJournal")
      .mockRejectedValue(new Error("simulated fsync failure"));
    const append = vi.spyOn(f.stores.events, "appendDurableUnique");
    const call =
      transport === "http"
        ? (method: string, params: unknown) => f.http(method, params, f.observer.token)
        : await f.socket(f.observer.token);
    expect(await call("continuations.get", { continuationId: admitted.result.continuationId })).toMatchObject({
      ok: false,
      error: { code: "RUN_STATE", details: { uncertain: true, recovery: "reconcile" } },
    });
    expect(synchronize).toHaveBeenCalledWith(f.runId, expect.objectContaining({ kind: "continuation" }));
    expect(append).not.toHaveBeenCalled();
    expect(await f.stores.events.read(f.runId)).toEqual(before);
    expect(f.effects).not.toHaveBeenCalled();
    synchronize.mockRestore();
    append.mockRestore();
  },
);

it.each(["http", "socket"] as const)(
  "%s rechecks real credential revocation inside the durable admission fence",
  async (transport) => {
    const f = await fixture({ manualDispatch: true });
    const add = f.stores.execution.addSensitivity.bind(f.stores.execution);
    vi.spyOn(f.stores.execution, "addSensitivity").mockImplementation(async (...args) => {
      await add(...args);
      await f.credentials.revoke(f.alice.credential.id);
    });
    const call = transport === "http" ? (method: string, params: unknown) => f.http(method, params) : await f.socket();
    expect(await call("runs.continue", f.params)).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect((await f.orc.getState(f.runId)).humanInputs[f.input.id]!.answer).toBeUndefined();
    expect(await f.stores.events.readRange(f.runId, { types: ["continuation.recorded"], limit: 10 })).toEqual([]);
    expect(f.effects).not.toHaveBeenCalled();
  },
);

it("startup does not recover revoked original authority through a valid owner credential", async () => {
  const f = await fixture({ manualDispatch: true });
  const admitted = RunsContinueResultSchema.parse(result(await f.http("runs.continue", f.params)));
  if (admitted.state !== "resolved") throw new Error("not resolved");
  await f.credentials.revoke(f.alice.credential.id);
  const restarted = await f.boot();
  await restarted.daemon.recoverContinuations!();
  expect(
    result(
      await restarted.http("continuations.get", { continuationId: admitted.result.continuationId }, f.owner.token),
    ),
  ).toMatchObject({ state: "blocked", blockedReason: "authority-unavailable" });
  expect(f.effects).not.toHaveBeenCalled();
  const events = await executionEvents(await restarted.stores.events.read(f.runId), restarted.stores.execution);
  expect(events.filter((event) => event.type === "continuation.recorded" && event.payload.decision)).toHaveLength(1);
});

it.each(["http", "socket"] as const)(
  "%s receipt inspection never reconstructs a missing marker after journal rewind",
  async (transport) => {
    const f = await fixture({ manualDispatch: true });
    const path = join(f.dir, "runs", `${f.runId}.jsonl`);
    const before = await readFile(path, "utf8");
    const admitted = RunsContinueResultSchema.parse(result(await f.http("runs.continue", f.params)));
    if (admitted.state !== "resolved") throw new Error("not resolved");
    await writeFile(path, before);
    const call =
      transport === "http"
        ? (method: string, params: unknown) => f.http(method, params, f.observer.token)
        : await f.socket(f.observer.token);
    expect(await call("continuations.get", { continuationId: admitted.result.continuationId })).toMatchObject({
      ok: false,
      error: { code: "RUN_STATE" },
    });
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await f.orc.getState(f.runId)).humanInputs[f.input.id]!.answer).toBeUndefined();
    expect(f.effects).not.toHaveBeenCalled();
  },
);

it("rotated continuation control and answer grants cannot replace current execution launch authority", async () => {
  const f = await fixture({ manualDispatch: true });
  const admitted = RunsContinueResultSchema.parse(result(await f.http("runs.continue", f.params)));
  if (admitted.state !== "resolved") throw new Error("not resolved");
  await f.credentials.revoke(f.alice.credential.id);
  const limited = await f.credentials.issue({
    ...f.grants,
    permissions: ["runs.read", "runs.control", "inputs.answer"],
  });
  expect(result(await f.http("runs.continue", f.params, limited.token))).toMatchObject({
    state: "resolved",
    operationId: admitted.operationId,
    replayed: true,
  });
  expect(
    result(await f.http("continuations.reconcile", { continuationId: admitted.result.continuationId }, limited.token)),
  ).toMatchObject({ state: "blocked", blockedReason: "authority-unavailable" });
  expect(f.effects).not.toHaveBeenCalled();
});
