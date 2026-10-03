/** Real authenticated daemon aliases use the existing admission services and guards. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { OrcaError, parseWorkflow } from "@orca/core";
import { PausingHumanInput, type ExecutionResumeAuthority } from "@orca/engine";
import { executionEvents, fileStores } from "@orca/store";
import { OperatorMutationContracts, PROTOCOL_VERSION, type ResponseMessage } from "@orca/protocol";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { DirectAdmissionService } from "../../engine/src/direct-admission.js";
import { RequestSubmissionService } from "../../engine/src/program/request-submission.js";
import { MemoryAdmissionStore } from "../../engine/src/program/submission-store.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { AdmissionRetryModel, neverAttached } from "../src/admission-retry.js";
import { RequestSubmissionModel } from "../src/request-submission.js";
import { CredentialStore, OwnershipStore, orchestratorResolver } from "../src/auth/index.js";
import { ReadModel } from "../src/read-model.js";
import { ControlModel } from "../src/control.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";
import { startDaemon } from "../src/server.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(installed = true, workflowId = "program") {
  const dir = await mkdtemp(join(tmpdir(), "orca-operator-composition-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const stores = fileStores(dir);
  const f = submissionFixture(stores, new MemoryAdmissionStore(), { nativeCorrelation: true });
  if (workflowId === "review")
    f.orc.workflows.register(
      parseWorkflow(`id: review
name: Review
version: "1"
start: start
nodes:
  start: {type: start}
  gate: {type: gate, question: Continue?, options: [approve, reject]}
  end: {type: end}
edges: [{from: start, to: gate}, {from: gate, to: end, when: "choice == 'approve'"}, {from: gate, to: end, when: "choice == 'reject'"}]
`),
    );
  f.orc.humanInput = new PausingHumanInput();
  await f.ready();
  const faults = {
    conflict: () => new OrcaError("RETRY_CONFLICT", "Intent conflict"),
    limit: () => new OrcaError("RETRY_LIMIT", "Intent limit"),
  };
  const claims = new RegisteredRetryClaims(
    new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults }),
    faults,
  );
  const requests = new RequestSubmissionService({
    orchestrator: f.orc,
    admissions: f.admissions,
    retries: claims,
    captureLaunch: (selection) => f.generations.captureLaunch({ ...selection, purpose: "request" }),
    restoreLaunch: f.generations.restoreLaunch,
  });
  const direct = new DirectAdmissionService({
    orchestrator: f.orc,
    retries: claims,
    captureLaunch: (selection) => f.generations.captureLaunch(selection),
    restoreLaunch: f.generations.restoreDirectLaunch,
  });
  const tasks = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let observeFirstExecution!: (completion: Promise<void>) => void;
  const firstExecution = new Promise<void>((resolve) => {
    observeFirstExecution = resolve;
  });
  void firstExecution.catch(() => {});
  const execute = (runId: string, authority?: ExecutionResumeAuthority) => {
    const task = runtime.withResumeAuthority(runId, authority, () => f.orc.run(runId)).then(() => {});
    observeFirstExecution(task);
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
    return task;
  };
  let requestDispatch = true;
  const requestSubmissions = new RequestSubmissionModel({
    service: requests,
    execute,
    shouldDispatch: (id) => (requestDispatch ? neverAttached(f.orc, id) : Promise.resolve(false)),
    checkResumeAuthority: (id, authority) => runtime.checkResumeAuthority(id, authority),
    executionFailed: (id) => failures.push(id),
  });
  const admissionRetries = new AdmissionRetryModel({
    claims,
    requests,
    direct,
    orchestrator: f.orc,
    execute,
    executionFailed: (id) => failures.push(id),
  });
  const credentials = new CredentialStore({ file: join(dir, "credentials.json") });
  const owner = await credentials.issue({ principal: "owner", preset: "owner" });
  const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
  const ownership = new OwnershipStore(join(dir, "ownership.json"));
  const reads = new ReadModel({ orchestrator: f.orc });
  const workspaceId = randomUUID();
  const identity = { workspaceId, instanceId: randomUUID() };
  const runtime = daemonExecutionRuntime({ ...identity, orchestrator: f.orc, credentials, ownership });
  f.orc.liveInput = runtime;
  f.orc.admissionExecution = { authorize: (policy) => runtime.authorizeAdmissionExecution(policy) };
  cleanups.push(async () => runtime.close());
  const daemon = await startDaemon({
    orcaVersion: "test",
    capabilities: [],
    workspaceId,
    identity,
    submissionWorkspaceId: workspaceId,
    reads,
    control: new ControlModel({ orchestrator: f.orc, reads }),
    source: f.orc,
    operatorSources: {
      events: stores.events,
      leases: stores.leases,
      generations: f.generations,
      liveState: (target) => runtime.port.inspect(target),
      liveRevision: () => runtime.port.observationRevision,
    },
    ...(installed ? { requestSubmissions, admissionRetries } : {}),
    auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(f.orc) },
  });
  cleanups.push(async () => {
    await new Promise<void>((r) => setImmediate(r));
    await Promise.allSettled([...tasks]);
    await daemon.close();
  });
  const call = async (method: string, params: unknown, token = owner.token): Promise<ResponseMessage> => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "request", id: randomUUID(), method, params }),
    });
    return response.json() as Promise<ResponseMessage>;
  };
  const discovery = await call("operator.discover", {});
  if (!discovery.ok) throw new Error(JSON.stringify(discovery));
  const target = (discovery.result as { target: { workspaceId: string; instanceId: string } }).target;
  const preflight = await call("operator.preflight", { target, purpose: "workflow", workflowId, vars: {} });
  if (!preflight.ok) throw new Error(JSON.stringify(preflight));
  const p = preflight.result as {
    workflowId: string;
    workflowVersion: string;
    expectedWorkflowRevision: string;
    expectedConfigGeneration: string;
  };
  const command = {
    workflowId: p.workflowId,
    workflowVersion: p.workflowVersion,
    expectedWorkflowRevision: p.expectedWorkflowRevision,
    expectedConfigGeneration: p.expectedConfigGeneration,
    vars: {},
  };
  return {
    call,
    target,
    command,
    owner,
    viewer,
    credentials,
    stores,
    failures,
    firstExecution,
    runtime,
    discovery,
    setRequestDispatch: (enabled: boolean) => {
      requestDispatch = enabled;
    },
  };
}
function value(response: ResponseMessage): unknown {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  if (!response.ok) throw new Error(JSON.stringify(response));
  return response.result;
}

it("installs only real services and filters their alias discovery by current grants", async () => {
  const absent = await fixture(false);
  expect(value(await absent.call("operator.discover", {}))).toMatchObject({
    operations: expect.not.arrayContaining([
      "operator.admitRun",
      "operator.submitRequest",
      "operator.revise",
      "operator.continueRun",
    ]),
  });
  const f = await fixture();
  const hello = value(await f.call("hello", { client: "test", protocol: PROTOCOL_VERSION }));
  expect(hello).toMatchObject({
    methods: expect.arrayContaining(["operator.admitRun", "operator.submitRequest"]),
    capabilities: expect.arrayContaining(["operator.admitRun", "operator.submitRequest"]),
  });
  expect(value(await f.call("operator.discover", {}, f.viewer.token))).toMatchObject({
    operations: expect.not.arrayContaining(["operator.admitRun", "operator.submitRequest", "operator.answer"]),
  });
  expect(await f.call("operator.admitRun", { malformed: true }, f.viewer.token)).toMatchObject({
    ok: false,
    error: { code: "AUTH_FORBIDDEN" },
  });
});

it("preserves actual direct and Request retry receipts, conflicts and authorized lookups", async () => {
  const f = await fixture();
  const params = { target: f.target, command: f.command, retry: { idempotencyKey: "direct-key" } };
  const first = OperatorMutationContracts["operator.admitRun"].result.parse(
    value(await f.call("operator.admitRun", params)),
  );
  expect(first).toMatchObject({ state: "resolved", replayed: false, result: { state: "accepted" } });
  const replay = value(await f.call("operator.admitRun", params));
  expect(replay).toMatchObject({ ...first, replayed: true });
  expect(JSON.stringify(first)).not.toContain("direct-key");
  const inspected = value(await f.call("operator.admission", { target: f.target, operationId: first.operationId }));
  expect(inspected).toMatchObject({ state: "resolved", operationId: first.operationId });
  expect(
    await f.call("operator.admitRun", { ...params, command: { ...f.command, vars: { changed: true } } }),
  ).toMatchObject({ ok: false, error: { code: "RETRY_CONFLICT" } });
  const requestParams = {
    target: f.target,
    command: { ...f.command, title: "Operator request", body: "Synthetic task" },
    retry: { idempotencyKey: "request-key" },
  };
  const request = OperatorMutationContracts["operator.submitRequest"].result.parse(
    value(await f.call("operator.submitRequest", requestParams)),
  );
  expect(request).toMatchObject({
    state: "resolved",
    replayed: false,
    result: { state: "accepted", requestId: expect.any(String) },
  });
  expect(value(await f.call("operator.submitRequest", requestParams))).toMatchObject({ ...request, replayed: true });
  expect(
    value(await f.call("operator.admission", { target: f.target, operationId: request.operationId })),
  ).toMatchObject({ state: "resolved", operationId: request.operationId, result: { requestId: expect.any(String) } });
});

it("rejects changed targets before admission and revoked credentials on receipt reads", async () => {
  const f = await fixture();
  const params = {
    target: { ...f.target, instanceId: randomUUID() },
    command: f.command,
    retry: { idempotencyKey: "untouched" },
  };
  expect(await f.call("operator.admitRun", params)).toMatchObject({ ok: false, error: { code: "RUN_STATE" } });
  const receipt = OperatorMutationContracts["operator.admitRun"].result.parse(
    value(await f.call("operator.admitRun", { ...params, target: f.target })),
  );
  await f.credentials.revoke(f.owner.credential.id);
  expect(await f.call("operator.admission", { target: f.target, operationId: receipt.operationId })).toMatchObject({
    ok: false,
    error: { code: "AUTH_INVALID" },
  });
});

it("ordinary answers retain exact step identity, explicit lease refusal, note and no-resume semantics", async () => {
  const f = await fixture(true, "review");
  const admitted = OperatorMutationContracts["operator.admitRun"].result.parse(
    value(
      await f.call("operator.admitRun", {
        target: f.target,
        command: f.command,
        retry: { idempotencyKey: "gate-run" },
      }),
    ),
  );
  if (admitted.state !== "resolved" || admitted.result.state !== "accepted") throw new Error("not admitted");
  const runId = admitted.result.runId;
  // Admission acknowledges durable acceptance before its scheduled interpreter parks.
  // Observe that actual execution completion instead of assuming a one-second window.
  await f.firstExecution;
  const page = value(await f.call("inputs.list", { runId })) as { inputs: { id: string; stepRunId: string }[] };
  const input = page.inputs[0];
  expect(input).toBeDefined();
  const decision = {
    lifetime: "durable",
    runId,
    requestId: input!.id,
    stepRunId: input!.stepRunId,
    optionId: "approve",
    note: "Private ordinary rationale",
    resume: false,
  };
  const command = { target: f.target, decision };
  expect(await f.call("operator.answer", { ...command, decision: { ...decision, stepRunId: "wrong" } })).toMatchObject({
    ok: false,
    error: { code: "RUN_STATE" },
  });
  const lease = await f.stores.leases.acquire({ resource: `run:${runId}`, holder: "external-writer" });
  try {
    expect(await f.call("operator.answer", command)).toMatchObject({
      ok: false,
      error: { code: "RUN_LEASED_ELSEWHERE" },
    });
  } finally {
    await f.stores.leases.release(lease);
  }
  expect((await f.stores.events.read(runId)).filter((e) => e.type === "human.answered")).toHaveLength(0);
  expect(value(await f.call("operator.answer", command))).toMatchObject({ runId, requestId: input!.id });
  const events = await f.stores.events.read(runId);
  expect(events.filter((e) => e.type === "human.answered")).toHaveLength(1);
  expect(events.filter((e) => e.type === "run.resumed")).toHaveLength(0);
  expect((await executionEvents(events, f.stores.execution)).find((e) => e.type === "human.answered")).toMatchObject({
    payload: { note: "Private ordinary rationale" },
  });
  expect(
    value(await f.call("operator.cancel", { target: f.target, runId, reason: "Synthetic cancellation" })),
  ).toMatchObject({ runId });
  expect((await f.stores.events.read(runId)).filter((e) => e.type === "run.cancelled")).toHaveLength(1);
});

it("Request inspection never attaches and explicit reconciliation reuses one accepted run", async () => {
  const f = await fixture();
  f.setRequestDispatch(false);
  const params = {
    target: f.target,
    command: { ...f.command, title: "Recover", body: "Task" },
    retry: { idempotencyKey: "recover-request" },
  };
  const receipt = OperatorMutationContracts["operator.submitRequest"].result.parse(
    value(await f.call("operator.submitRequest", params)),
  );
  if (receipt.state !== "resolved" || receipt.result.state !== "accepted") throw new Error("not admitted");
  const runId = receipt.result.runId;
  await new Promise<void>((r) => setImmediate(r));
  value(await f.call("operator.admission", { target: f.target, operationId: receipt.operationId }));
  expect((await f.stores.events.read(runId)).filter((e) => e.type === "run.started")).toHaveLength(0);
  f.setRequestDispatch(true);
  const reconciled = value(
    await f.call("operator.reconcileAdmission", { target: f.target, operationId: receipt.operationId }),
  );
  expect(reconciled).toMatchObject({ state: "resolved", operationId: receipt.operationId, result: receipt.result });
  await f.firstExecution;
  expect((await f.stores.events.read(runId)).some((e) => e.type === "run.completed")).toBe(true);
  value(await f.call("operator.reconcileAdmission", { target: f.target, operationId: receipt.operationId }));
  await new Promise<void>((r) => setImmediate(r));
  expect((await f.stores.events.read(runId)).filter((e) => e.type === "run.started")).toHaveLength(1);
});

it("live snapshot metadata is opaque, stable, and invalidated by actual port movement", async () => {
  const f = await fixture(true, "review");
  const admitted = OperatorMutationContracts["operator.admitRun"].result.parse(
    value(
      await f.call("operator.admitRun", {
        target: f.target,
        command: f.command,
        retry: { idempotencyKey: "live-observation" },
      }),
    ),
  );
  if (admitted.state !== "resolved" || admitted.result.state !== "accepted") throw new Error("not admitted");
  const runId = admitted.result.runId;
  await f.firstExecution;
  expect((value(await f.call("inputs.list", { runId })) as { inputs: unknown[] }).inputs).toHaveLength(1);
  const params = { target: f.target, collection: "inputs", runId };
  const raw = f.runtime.port.observationRevision;
  const first = value(await f.call("operator.page", params)) as { revision: string; items: unknown[] };
  expect(JSON.stringify(first)).not.toContain(raw);
  expect(first.revision).not.toContain(f.runtime.port.instanceId);
  expect(value(await f.call("operator.page", params))).toMatchObject({
    revision: first.revision,
    restartRequired: false,
  });
  const read = f.stores.events.readRange.bind(f.stores.events);
  let moved = false;
  const spy = vi.spyOn(f.stores.events, "readRange").mockImplementation(async (id, query) => {
    const rows = await read(id, query);
    if (!moved && query?.types?.includes("human.requested")) {
      moved = true;
      f.runtime.port.close();
    }
    return rows;
  });
  expect(value(await f.call("operator.page", params))).toMatchObject({ items: [], restartRequired: true });
  spy.mockRestore();
  const changed = value(await f.call("operator.page", params)) as { revision: string };
  expect(changed.revision).not.toBe(first.revision);
  expect(JSON.stringify(changed)).not.toContain(f.runtime.port.observationRevision);
});
