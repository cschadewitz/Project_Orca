/**
 * #357 acceptance: recovery fails safely. A checkpoint attempt (`runs.recover`) or a Resume
 * (`runs.resume`) that cannot be carried out is refused before anything is written, claimed or
 * run, with an error that says why and what to do instead: another principal's run, a stale
 * checkpoint, a missing artifact, a workflow or configuration version the run can no longer
 * continue on, and a permission revoked since the run started.
 */
import { expect, it, vi } from "vitest";
import { RECOVERY_BLOCKER_TEXT } from "@orca/core";
import { checkpointAttempts } from "@orca/engine";
import { RunsRecoverResultSchema, RunsRecoveryResultSchema } from "@orca/protocol";
import { authForbidden } from "../src/auth/errors.js";
import { call, fixture, type FixtureOptions } from "./recovery-methods-fixture.js";
import { harness as securityHarness } from "./security-harness.js";

/** A failed run whose uncertain step was reviewed, so a checkpoint attempt is otherwise allowed. */
async function recoverable(options: FixtureOptions = {}) {
  const f = await fixture(options);
  await f.orchestrator.reviewEffect(f.source.run.id, f.b.id, "run-again");
  const a = f.source.stepOrder.map((id) => f.source.steps[id]!).find((s) => s.nodeId === "a")!;
  return { ...f, a };
}

/** Nothing was written, claimed or run for the source, and no attempt exists. */
async function untouched(f: Awaited<ReturnType<typeof recoverable>>, seq: number | undefined) {
  expect(await f.stores.events.lastSeq(f.source.run.id)).toBe(seq);
  expect(await checkpointAttempts(f.stores, f.source.run.id)).toEqual([]);
  expect(f.execute).not.toHaveBeenCalled();
}

async function refusedRecover(f: Awaited<ReturnType<typeof recoverable>>, params: Record<string, unknown> = {}) {
  const seq = await f.stores.events.lastSeq(f.source.run.id);
  const response = await call(f.ctx, "runs.recover", { runId: f.source.run.id, idempotencyKey: "k1", ...params });
  expect(response.ok, JSON.stringify(response.result)).toBe(false);
  await untouched(f, seq);
  return response.error!;
}

/** The refused key left no claim behind: the same key starts the attempt once the cause is gone. */
async function keyStillFree(f: Awaited<ReturnType<typeof recoverable>>) {
  const started = await call(f.ctx, "runs.recover", { runId: f.source.run.id, idempotencyKey: "k1" });
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  expect(RunsRecoverResultSchema.parse(started.result).state).toBe("accepted");
}

it("refuses another principal's run, naming the reason and what to do", async () => {
  const f = await recoverable({ principalId: "mallory" });
  const error = await refusedRecover(f);
  expect(error).toMatchObject({ code: "RECOVERY_BLOCKED", details: { blockers: ["cross-principal"] } });
  expect(error.message).toContain(RECOVERY_BLOCKER_TEXT["cross-principal"]);
});

it("refuses a stale or unknown checkpoint, and a checkpoint that is not a completed step", async () => {
  const f = await recoverable();
  for (const checkpoint of ["step_gone", f.b.id]) {
    const error = await refusedRecover(f, { checkpoint });
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(error.message).toContain(`no completed step '${checkpoint}' to recover from`);
  }
  // The newest checkpoint still starts with the same key.
  await keyStillFree(f);
});

it("refuses a checkpoint whose artifact is gone, and points to an earlier one", async () => {
  // Named explicitly: left to choose, recovery picks the latest checkpoint that is not blocked.
  const f = await recoverable();
  const missing = vi.spyOn(f.stores.artifacts, "get").mockResolvedValue(undefined);
  const reuses = vi.spyOn(f.stores.artifacts, "bytes").mockRejectedValue(new Error("gone"));
  // `a` produced no artifact in this workflow: pretend it recorded one that is now missing.
  const state = await f.orchestrator.getState(f.source.run.id);
  const read = f.stores.events.read.bind(f.stores.events);
  vi.spyOn(f.stores.events, "read").mockImplementation(async (runId, ...rest) => {
    const events = await read(runId, ...rest);
    if (runId !== f.source.run.id) return events;
    return events.map((e) =>
      e.type === "step.completed" && (e.payload as { stepRunId: string }).stepRunId === f.a.id
        ? {
            ...e,
            payload: {
              ...e.payload,
              result: { ...(e.payload as { result: object }).result, artifactIds: ["art_gone"] },
            },
          }
        : e,
    ) as typeof events;
  });
  expect(state.steps[f.a.id]?.status).toBe("completed");
  const error = await refusedRecover(f, { checkpoint: f.a.id });
  expect(error).toMatchObject({ code: "RECOVERY_BLOCKED" });
  expect(error.details?.blockers).toContain("missing-artifact");
  expect(error.message).toContain(RECOVERY_BLOCKER_TEXT["missing-artifact"]);
  missing.mockRestore();
  reuses.mockRestore();
});

it("refuses when the configuration generation or the workflow version the run used cannot be continued", async () => {
  const f = await recoverable();
  const generationId = f.source.run.provenance!.configGeneration;
  const getGeneration = f.stores.execution.getGeneration.bind(f.stores.execution);
  const gone = vi
    .spyOn(f.stores.execution, "getGeneration")
    .mockImplementation(async (id) => (id === generationId ? undefined : getGeneration(id)));
  const generation = await refusedRecover(f);
  expect(generation).toMatchObject({ code: "RECOVERY_BLOCKED" });
  expect(generation.details?.blockers).toContain("generation-missing");
  expect(generation.message).toContain(RECOVERY_BLOCKER_TEXT["generation-missing"]);
  gone.mockRestore();

  const getWorkflow = f.stores.workflows.get.bind(f.stores.workflows);
  const changed = vi.spyOn(f.stores.workflows, "get").mockImplementation(async (id, version) => {
    const def = await getWorkflow(id, version);
    return def ? { ...def, name: `${def.name} (edited in place)` } : def;
  });
  const revision = await refusedRecover(f);
  expect(revision).toMatchObject({ code: "RECOVERY_BLOCKED" });
  expect(revision.details?.blockers).toContain("workflow-revision-mismatch");
  expect(revision.message).toContain(RECOVERY_BLOCKER_TEXT["workflow-revision-mismatch"]);
  changed.mockRestore();

  await keyStillFree(f);
});

it("refuses when permission to run the workflow was revoked since the run started", async () => {
  let granted = false;
  const f = await recoverable({
    authorizeWorkflow: async (workflowId) => {
      if (!granted && workflowId === "flow") throw authForbidden();
    },
  });
  const error = await refusedRecover(f);
  expect(error).toMatchObject({ code: "AUTH_FORBIDDEN" });
  granted = true;
  await keyStillFree(f);
});

it("refuses Resume and effect review of a parked run to another principal, a read-only credential and a revoked one", async () => {
  const h = await securityHarness();
  try {
    const runId = h.runs.alice;
    const seq = await h.stores.events.lastSeq(runId);
    const attempt = async (token: string) => {
      const resumed = await h.rpc(token, "runs.resume", { runId });
      const reviewed = await h.rpc(token, "runs.reviewEffect", { runId, stepRunId: "any", decision: "abandon" });
      return [resumed.body, reviewed.body];
    };
    // bob's credential is scoped to the runs bob owns: alice's run does not exist for him.
    for (const body of await attempt(h.tokens.bob))
      expect(body).toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } });
    // alice's read-only credential may read her run but not drive it.
    for (const body of await attempt(h.tokens.runsOnly))
      expect(body).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
    // alice's own client credential, revoked since she started the run.
    await h.credentials.revoke(h.ids.alice);
    for (const body of await attempt(h.tokens.alice))
      expect(body).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect(await h.stores.events.lastSeq(runId)).toBe(seq);
    expect((await h.orchestrator.getState(runId)).run.status).toBe("paused");
  } finally {
    await h.close();
  }
});

it("refuses Resume of a parked run whose workflow version can no longer be read, saying what to do", async () => {
  const h = await securityHarness();
  try {
    const runId = h.runs.alice;
    await h.orchestrator.answer(h.gates.alice, "ship", runId);
    const seq = await h.stores.events.lastSeq(runId);
    const preview = await h.rpc(h.tokens.alice, "runs.recovery", { runId });
    expect(preview.body.ok, JSON.stringify(preview.body.error)).toBe(true);
    const gone = vi.spyOn(h.stores.workflows, "get").mockResolvedValue(undefined);
    const blocked = await h.rpc(h.tokens.alice, "runs.recovery", { runId });
    const resume = RunsRecoveryResultSchema.parse(blocked.body.result).assessment.options.find(
      (o) => o.kind === "resume",
    );
    const response = await h.rpc(h.tokens.alice, "runs.resume", { runId });
    expect(response.body.ok).toBe(false);
    expect(await h.stores.events.lastSeq(runId)).toBe(seq);
    gone.mockRestore();
    expect({ resume: resume?.blockers, error: response.body.error }).toMatchObject({
      resume: ["workflow-missing"],
      error: { code: "WORKFLOW_VERSION_NOT_FOUND", details: { blockers: ["workflow-missing"] } },
    });
    expect(response.body.error?.message).toContain(RECOVERY_BLOCKER_TEXT["workflow-missing"]);
  } finally {
    await h.close();
  }
});
