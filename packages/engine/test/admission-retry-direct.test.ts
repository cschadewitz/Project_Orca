import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaError, type OrcaEventInput } from "@orca/core";
import { FileExecutionStore } from "@orca/store";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../src/admission-retry.js";
import { DirectAdmissionService, type DirectCapturedLaunch } from "../src/direct-admission.js";
import { submissionFixture } from "./request-submission-fixture.js";
import type { DirectAdmissionAuthority } from "../../core/src/model/admission-retry.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(failAt?: "inputs" | "created" | "ownership") {
  const f = submissionFixture();
  const dir = await mkdtemp(join(tmpdir(), "orca-direct-"));
  dirs.push(dir);
  const faults = {
    conflict: () => new OrcaError("RUN_STATE", "conflict"),
    limit: () => new OrcaError("RUN_STATE", "limit"),
  };
  const store = new FileRetryClaimStore({ storeDir: dir, execution: new FileExecutionStore(dir), faults });
  const claims = new RegisteredRetryClaims(store, faults);
  let fail = true;
  const start = vi.fn<DirectCapturedLaunch["startRun"]>(async (options) => {
    if (!options.admissionRunId || !options.directAdmissionId) throw new Error("missing identity");
    const runId = options.admissionRunId;
    await f.stores.execution.putInputs({
      runId,
      workflowId: "program",
      workflowVersion: "1",
      vars: options.vars ?? {},
      sensitiveNames: [],
      secrets: [],
    });
    if (fail && failAt === "inputs") {
      fail = false;
      throw new Error("crash");
    }
    const created: Extract<OrcaEventInput, { type: "run.created" }> & { payload: { directAdmissionId: string } } = {
      runId,
      type: "run.created",
      payload: {
        workflowId: "program",
        workflowVersion: "1",
        vars: options.vars ?? {},
        workspace: { hostId: "local", cwd: process.cwd() },
        ...(options.actor ? { actor: options.actor } : {}),
        executionInputsStored: true,
        directAdmissionId: options.directAdmissionId,
      },
    };
    await f.stores.events.append(created);
    if (fail && failAt === "created") {
      fail = false;
      throw new Error("crash");
    }
    return runId;
  });
  const launch: DirectCapturedLaunch = {
    admissionRunIds: true,
    requestAdmissionCorrelation: true,
    generationId: "g1",
    workflow: { id: "program", version: "1", revision: "r1" },
    validateStartRun: async () => {},
    startRun: start,
  };
  const capture = vi.fn(async () => launch),
    restore = vi.fn(async () => launch);
  const authority: DirectAdmissionAuthority = {
    workspaceId: f.authority.workspaceId,
    actor: f.authority.actor,
    authorize: async () => {},
    onRunAdmitted: vi.fn(async (id) => {
      if (fail && failAt === "ownership") {
        fail = false;
        throw new Error("crash");
      }
      await f.authority.onRunAdmitted(id);
    }),
  };
  const service = new DirectAdmissionService({
    orchestrator: f.orc,
    retries: claims,
    captureLaunch: capture,
    restoreLaunch: restore,
  });
  const scope = {
    principalId: authority.actor.principalId,
    workspaceId: authority.workspaceId,
    authorize: async () => {
      await authority.authorize({ workflowId: "program" });
    },
  };
  return { ...f, claims, service, authority, start, capture, restore, scope };
}
it("admits a direct run without fabricating a Request or driving execution; retries retain identity", async () => {
  const f = await fixture();
  const first = await f.service.admitRun({ workflowId: "program" }, { idempotencyKey: "intent" }, f.authority);
  expect(first).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  expect(await f.stores.requests.list()).toEqual([]);
  const ids = await f.orc.listRuns();
  expect(ids).toHaveLength(1);
  expect((await f.orc.getState(ids[0]!)).run.status).toBe("created");
  expect(f.owners.get(ids[0]!)).toBe("owner");
  await f.orc.run(ids[0]!);
  const events = (await f.orc.events(ids[0]!)).length;
  expect(
    await f.service.admitRun({ workflowId: "program", vars: {} }, { idempotencyKey: "intent" }, f.authority),
  ).toEqual({ ...first, replayed: true });
  expect((await f.orc.events(ids[0]!)).length).toBe(events);
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
});
it.each(["created", "ownership"] as const)("reconciles original run after %s interruption", async (boundary) => {
  const f = await fixture(boundary);
  const first = await f.service.admitRun({ workflowId: "program" }, { idempotencyKey: "intent" }, f.authority);
  expect(first).toMatchObject({ state: "resolved", result: { state: "recoverable-failure" } });
  const result = await f.service.withRetryAuthority(f.authority, () => f.claims.reconcile(first.operationId, f.scope));
  expect(result).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.restore).not.toHaveBeenCalled();
  expect(await f.orc.listRuns()).toHaveLength(1);
});
it("does not repeat uncertain workspace provisioning after private input persistence", async () => {
  const f = await fixture("inputs");
  const first = await f.service.admitRun({ workflowId: "program" }, { idempotencyKey: "intent" }, f.authority);
  const result = await f.service.withRetryAuthority(f.authority, () => f.claims.reconcile(first.operationId, f.scope));
  expect(result).toMatchObject({ state: "resolved", result: { state: "recoverable-failure" } });
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(await f.orc.listRuns()).toEqual([]);
});
