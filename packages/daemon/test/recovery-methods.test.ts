/**
 * #357 phase 2: recovery over the wire. `runs.recovery` reads the assessment, `runs.reviewEffect`
 * records a review, and `runs.recover` starts a checkpoint attempt through retry-safe admission
 * and drives it, once per key, under the same first-attachment policy as an admitted run.
 */
import { expect, it, vi } from "vitest";
import { checkpointAttempts } from "@orca/engine";
import {
  HelloResultSchema,
  PROTOCOL_VERSION,
  RunsGetResultSchema,
  RunsRecoverResultSchema,
  RunsRecoveryResultSchema,
  RunsReviewEffectResultSchema,
} from "@orca/protocol";
import type { MethodContext } from "@orca/daemon";
import { Maintenance } from "../src/maintenance.js";
import { call, fixture } from "./recovery-methods-fixture.js";
import { harness as securityHarness, putArtifact } from "./security-harness.js";

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

it("reconciles only a checkpoint receipt when asked for one, before touching any other kind", async () => {
  const f = await fixture();
  await call(f.ctx, "runs.reviewEffect", { runId: f.source.run.id, stepRunId: f.b.id, decision: "run-again" });
  const crash = vi.spyOn(f.orchestrator, "startRun").mockRejectedValueOnce(new Error("interrupted"));
  const first = RunsRecoverResultSchema.parse(
    (await call(f.ctx, "runs.recover", { runId: f.source.run.id, idempotencyKey: "k1" })).result,
  );
  crash.mockRestore();
  if (first.state !== "recoverable-failure" || !first.runId) throw new Error(JSON.stringify(first));
  const reserved = first.runId;

  // The same call for a receipt of another kind (here a direct admission's) is refused after
  // reading its kind and before any reconciliation, of either kind, can begin.
  const kind = vi.spyOn(f.claims, "operationKind").mockResolvedValueOnce("run.admit");
  const generic = vi.spyOn(f.claims, "reconcile");
  const checkpoint = vi.spyOn(f.checkpoints, "reconcile");
  expect(
    await call(f.ctx, "admissions.reconcile", { operationId: first.operationId, kind: "run.recover" }),
  ).toMatchObject({ ok: false, error: { code: "NOT_SUPPORTED" } });
  expect(kind).toHaveBeenCalledTimes(1);
  expect(generic).not.toHaveBeenCalled();
  expect(checkpoint).not.toHaveBeenCalled();
  expect(await f.stores.events.lastSeq(reserved)).toBeUndefined();

  // The checkpoint receipt itself, named as one, reconciles as before.
  expect(
    await call(f.ctx, "admissions.reconcile", { operationId: first.operationId, kind: "run.recover" }),
  ).toMatchObject({ ok: true, result: { state: "resolved", result: { state: "accepted", runId: reserved } } });
  await vi.waitFor(async () => expect((await f.orchestrator.getState(reserved)).run.status).toBe("completed"));
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
