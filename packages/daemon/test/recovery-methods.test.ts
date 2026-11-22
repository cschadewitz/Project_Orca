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
