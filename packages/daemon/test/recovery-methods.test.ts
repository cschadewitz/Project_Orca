/**
 * #357 phase 2: recovery over the wire. `runs.recovery` reads the assessment, `runs.reviewEffect`
 * records a review, and `runs.recover` starts a checkpoint attempt through retry-safe admission
 * and drives it, once per key, under the same first-attachment policy as an admitted run.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  OrcaError,
  parseOrcaConfig,
  parseWorkflow,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
} from "@orca/core";
import {
  builtinExecutors,
  CheckpointAdmissionService,
  checkpointAttempts,
  completed,
  failed,
  LocalWorkspaceProvider,
  Orchestrator,
} from "@orca/engine";
import {
  HelloResultSchema,
  PROTOCOL_VERSION,
  RunsGetResultSchema,
  RunsRecoverResultSchema,
  RunsRecoveryResultSchema,
  RunsReviewEffectResultSchema,
} from "@orca/protocol";
import { FileExecutionStore, memoryStores } from "@orca/store";
import { ControlModel, ReadModel, dispatch, methodsFor, type MethodContext } from "@orca/daemon";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { ConfigurationGenerations } from "../../engine/src/configuration-generation.js";
import { AdmissionRetryModel, type AdmissionAuthorities } from "../src/admission-retry.js";
import { Maintenance } from "../src/maintenance.js";
import { harness as securityHarness, putArtifact } from "./security-harness.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const definition = parseWorkflow(`
id: flow
name: Flow
version: "1"
start: s
nodes:
  s: { type: start }
  a: { type: set, vars: { reached: a } }
  b: { type: "custom:once" }
  e: { type: end, outcome: success }
edges: [{ from: s, to: a }, { from: a, to: b }, { from: b, to: e }]
`);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-recovery-methods-"));
  dirs.push(dir);
  const stores = memoryStores();
  let failures = 1;
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(definition),
    templates: new TemplateRegistry(),
    // Fails once without saying it did nothing outside ORCA: its effect is uncertain.
    executors: builtinExecutors().register({
      type: "custom:once",
      execute: async () => (failures-- > 0 ? failed("ONCE", "not yet") : completed()),
    }),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    logger: silentLogger,
  });
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async () => ({ workflows: orchestrator.workflows.list(), templates: [] }),
    admission: {
      validateStartRun: (opts, material) => orchestrator.validateStartRun(opts, material),
      startRun: (opts, material) => orchestrator.startRun(opts, material),
    },
  });
  await generations.initialize(
    parseOrcaConfig({ agents: [], program: { workflow: "flow", itemWorkflow: "flow" } }),
    "t",
  );
  orchestrator.generations = generations;
  const actor = { principalId: "owner", credentialId: "credential-test" };
  const owned = new Set<string>();
  orchestrator.admissionExecution = {
    authorize: async (policy) => {
      if (!owned.has(policy.binding.runId)) throw new OrcaError("RUN_STATE", "ownership unavailable");
    },
  };
  const faults = {
    conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
    limit: () => new OrcaError("RETRY_LIMIT", "limit"),
  };
  const claims = new RegisteredRetryClaims(
    new FileRetryClaimStore({ storeDir: dir, execution: new FileExecutionStore(dir), faults }),
    faults,
  );
  const checkpoints = new CheckpointAdmissionService({ orchestrator, retries: claims });
  const execute = vi.fn(async (runId: string) => {
    await orchestrator.run(runId);
  });
  const admissionRetries = new AdmissionRetryModel({
    claims,
    direct: {} as never,
    requests: {} as never,
    checkpoints,
    orchestrator,
    execute,
    executionFailed: () => {},
  });
  const workflowsAuthorized: string[] = [];
  const authorities: AdmissionAuthorities = {
    principalId: actor.principalId,
    workspaceId: "workspace-test",
    check: async () => {},
    request: async () => {
      throw new OrcaError("NOT_SUPPORTED", "no requests here");
    },
    direct: async () => ({
      workspaceId: "workspace-test",
      actor,
      authorize: async (command) => {
        workflowsAuthorized.push(command.workflowId);
      },
      onRunAdmitted: async (runId) => {
        owned.add(runId);
      },
      verifyRunAdmitted: async (runId) => {
        if (!owned.has(runId)) throw new OrcaError("RUN_STATE", "ownership unavailable");
      },
    }),
  };
  const reads = new ReadModel({ orchestrator });
  const ctx: MethodContext = {
    orcaVersion: "test",
    capabilities: ["runs.read", "runs.control"],
    reads,
    control: new ControlModel({ orchestrator, reads }),
    admissionRetries,
    admissionAuthorities: async () => authorities,
    mutationActor: actor,
  };
  const source = await orchestrator.startAndRun({ workflowId: "flow", vars: {}, actor });
  expect(source.run.status).toBe("failed");
  const b = source.stepOrder.map((id) => source.steps[id]!).find((s) => s.nodeId === "b")!;
  return { orchestrator, stores, ctx, source, b, execute, workflowsAuthorized };
}

async function call(ctx: MethodContext, method: string, params?: unknown) {
  return (await dispatch(JSON.stringify({ kind: "request", id: 1, method, params }), methodsFor(ctx), ctx)) as {
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

it("reads the assessment, records a review, then starts one attempt per key and drives it", async () => {
  const f = await fixture();
  const hello = HelloResultSchema.parse(
    (await call(f.ctx, "hello", { client: "t", protocol: PROTOCOL_VERSION })).result,
  );
  for (const m of ["runs.recovery", "runs.reviewEffect", "runs.recover"]) expect(hello.methods).toContain(m);

  // The failed step may have acted: the checkpoint attempt is blocked until it is reviewed.
  const before = RunsRecoveryResultSchema.parse(
    (await call(f.ctx, "runs.recovery", { runId: f.source.run.id })).result,
  );
  expect(before.assessment.uncertain.map((s) => s.stepRunId)).toEqual([f.b.id]);
  expect(before.assessment.options.find((o) => o.kind === "checkpoint-attempt")).toMatchObject({
    readiness: "blocked",
    blockers: ["effect-unreviewed"],
  });
  const refused = await call(f.ctx, "runs.recover", { runId: f.source.run.id, idempotencyKey: "k1" });
  expect(refused).toMatchObject({ ok: false, error: { code: "RECOVERY_BLOCKED" } });

  const reviewed = await call(f.ctx, "runs.reviewEffect", {
    runId: f.source.run.id,
    stepRunId: f.b.id,
    decision: "run-again",
    note: "checked: nothing changed",
  });
  expect(reviewed.ok, JSON.stringify(reviewed.error)).toBe(true);
  RunsReviewEffectResultSchema.parse(reviewed.result);
  const source = RunsGetResultSchema.parse((await call(f.ctx, "runs.get", { runId: f.source.run.id })).result);
  expect(source.steps.find((s) => s.id === f.b.id)?.effectReview).toMatchObject({
    decision: "run-again",
    note: "checked: nothing changed",
  });
  const after = RunsRecoveryResultSchema.parse((await call(f.ctx, "runs.recovery", { runId: f.source.run.id })).result);
  expect(after.assessment.options.find((o) => o.kind === "checkpoint-attempt")?.readiness).not.toBe("blocked");

  // The refused key left no claim: the same key now starts the attempt.
  const started = await call(f.ctx, "runs.recover", { runId: f.source.run.id, idempotencyKey: "k1" });
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  const receipt = RunsRecoverResultSchema.parse(started.result);
  if (receipt.state !== "accepted") throw new Error(JSON.stringify(receipt));
  expect(receipt.sourceRunId).toBe(f.source.run.id);
  // An attempt is a new run of the source's workflow, authorized as one.
  expect(f.workflowsAuthorized).toContain("flow");

  await vi.waitFor(async () => expect((await f.orchestrator.getState(receipt.runId)).run.status).toBe("completed"));
  expect(f.execute).toHaveBeenCalledTimes(1);
  const attempt = RunsGetResultSchema.parse((await call(f.ctx, "runs.get", { runId: receipt.runId })).result);
  expect(attempt.run.checkpoint).toEqual({ runId: f.source.run.id, stepRunId: expect.any(String) });
  expect(attempt.steps.map((s) => [s.nodeId, s.reusedFrom?.runId])).toEqual([
    ["s", f.source.run.id],
    ["a", f.source.run.id],
    ["b", undefined],
    ["e", undefined],
  ]);

  // The same key returns the same attempt, and nothing new runs.
  const replay = RunsRecoverResultSchema.parse(
    (await call(f.ctx, "runs.recover", { runId: f.source.run.id, idempotencyKey: "k1" })).result,
  );
  expect(replay).toEqual(receipt);
  expect(await checkpointAttempts(f.stores, f.source.run.id)).toHaveLength(1);
  expect(f.execute).toHaveBeenCalledTimes(1);
  // Its receipt reads back through the ordinary admission lookup.
  const inspected = await call(f.ctx, "admissions.get", { operationId: receipt.operationId });
  expect(inspected).toMatchObject({
    ok: true,
    result: { state: "resolved", result: { state: "accepted", runId: receipt.runId } },
  });
  // A completed attempt has nothing to recover.
  expect(await call(f.ctx, "runs.recover", { runId: receipt.runId, idempotencyKey: "k2" })).toMatchObject({
    ok: false,
    error: { code: "RECOVERY_BLOCKED" },
  });
});

it("answers the read without control, and offers no writes", async () => {
  const f = await fixture();
  const { control: _control, admissionRetries: _admissions, ...readOnly } = f.ctx;
  const hello = HelloResultSchema.parse(
    (await call(readOnly, "hello", { client: "t", protocol: PROTOCOL_VERSION })).result,
  );
  expect(hello.methods).toContain("runs.recovery");
  expect(hello.methods).not.toContain("runs.reviewEffect");
  expect(hello.methods).not.toContain("runs.recover");
  const seq = await f.stores.events.lastSeq(f.source.run.id);
  expect((await call(readOnly, "runs.recovery", { runId: f.source.run.id })).ok).toBe(true);
  expect(
    await call(readOnly, "runs.reviewEffect", { runId: f.source.run.id, stepRunId: f.b.id, decision: "abandon" }),
  ).toMatchObject({ ok: false });
  expect(await f.stores.events.lastSeq(f.source.run.id)).toBe(seq);
});

it("keeps a reserved attempt uncreated while new admission is closed, and reconciles it after", async () => {
  const f = await fixture();
  let open = true;
  const ctx: MethodContext = {
    ...f.ctx,
    maintenance: new Maintenance(undefined, undefined, undefined, () => open),
  };
  await call(ctx, "runs.reviewEffect", { runId: f.source.run.id, stepRunId: f.b.id, decision: "run-again" });
  // Interrupted between reserving the attempt and creating it.
  const crash = vi.spyOn(f.orchestrator, "startRun").mockRejectedValueOnce(new Error("interrupted"));
  const first = RunsRecoverResultSchema.parse(
    (await call(ctx, "runs.recover", { runId: f.source.run.id, idempotencyKey: "k1" })).result,
  );
  crash.mockRestore();
  if (first.state !== "recoverable-failure" || !first.runId) throw new Error(JSON.stringify(first));
  const reserved = first.runId;

  // The operator endpoints have no checkpoint receipt: refused before anything can create it.
  const target = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
  };
  const operator: MethodContext = {
    ...ctx,
    identity: { ...target },
    operatorReads: { methods: [], model: async () => ({}) } as never,
    operatorMutations: {
      current: async (invocation) => invocation,
      invokeLegacy: async () => {
        throw new Error("not used");
      },
    },
  };
  for (const method of ["operator.reconcileAdmission", "operator.admission"])
    expect(await call(operator, method, { target, operationId: first.operationId })).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    });
  expect(await f.stores.events.lastSeq(reserved)).toBeUndefined();

  // A drain closes new admission: reconciling would create the run, so it is refused.
  open = false;
  expect(await call(ctx, "admissions.reconcile", { operationId: first.operationId })).toMatchObject({
    ok: false,
    error: { code: "PROTOCOL_MESSAGE" },
  });
  expect(await f.stores.events.lastSeq(reserved)).toBeUndefined();
  // Reading the receipt stays open, and stays read-only.
  expect(await call(ctx, "admissions.get", { operationId: first.operationId })).toMatchObject({
    ok: true,
    result: { state: "resolved", result: { state: "recoverable-failure", runId: reserved } },
  });
  expect(await f.stores.events.lastSeq(reserved)).toBeUndefined();
  expect(f.execute).not.toHaveBeenCalled();

  // Admission reopens: the same reconciliation creates exactly the reserved attempt and drives it.
  open = true;
  expect(await call(ctx, "admissions.reconcile", { operationId: first.operationId })).toMatchObject({
    ok: true,
    result: { state: "resolved", result: { state: "accepted", runId: reserved } },
  });
  await vi.waitFor(async () => expect((await f.orchestrator.getState(reserved)).run.status).toBe("completed"));
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("assesses without artifact reads or ids for a run reader who may not read artifacts", async () => {
  const h = await securityHarness();
  try {
    // A completed step of alice's run that produced an artifact.
    await putArtifact(h.stores, "art_private", h.runs.alice);
    const runId = h.runs.alice;
    await h.append({
      type: "step.scheduled",
      runId,
      payload: { stepRunId: "made-it", nodeId: "s", nodeType: "start", attempt: 1 },
    });
    await h.append({ type: "step.started", runId, payload: { stepRunId: "made-it", inputArtifactIds: [] } });
    await h.append({
      type: "step.completed",
      runId,
      payload: { stepRunId: "made-it", result: { artifactIds: ["art_private"], data: {} } },
    });
    const get = vi.spyOn(h.stores.artifacts, "get");
    const bytes = vi.spyOn(h.stores.artifacts, "bytes");

    // alice with runs.read alone: no artifact is opened or named; checkpoints are unverified.
    const narrow = await h.rpc(h.tokens.runsOnly, "runs.recovery", { runId });
    expect(narrow.body.ok, JSON.stringify(narrow.body.error)).toBe(true);
    expect(JSON.stringify(narrow.body.result)).not.toContain("art_private");
    expect(get).not.toHaveBeenCalled();
    expect(bytes).not.toHaveBeenCalled();
    const hidden = RunsRecoveryResultSchema.parse(narrow.body.result).assessment;
    const checkpoint = hidden.checkpoints.find((c) => c.stepRunId === "made-it")!;
    expect(checkpoint.unverified).toContain("artifacts-unchecked");
    expect(checkpoint.blockers).not.toContain("missing-artifact");

    // alice's own client credential may read artifacts: the same artifact is checked and named.
    const full = await h.rpc(h.tokens.alice, "runs.recovery", { runId });
    const shown = RunsRecoveryResultSchema.parse(full.body.result).assessment;
    expect(bytes).toHaveBeenCalled();
    const reused = shown.checkpoints.find((c) => c.stepRunId === "made-it")!;
    expect(reused.unverified).not.toContain("artifacts-unchecked");
    expect(reused.reused.flatMap((s) => s.artifactIds)).toContain("art_private");
    // Another principal cannot read alice's run at all.
    expect((await h.rpc(h.tokens.bob, "runs.recovery", { runId })).body.ok).toBe(false);
  } finally {
    await h.close();
  }
});
