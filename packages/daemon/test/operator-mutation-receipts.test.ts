import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaError, type SubmissionService } from "@orca/core";
import { FileExecutionStore } from "@orca/store";
import type { DirectAdmissionAuthority } from "../../core/src/model/admission-retry.js";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { DirectAdmissionService } from "../../engine/src/direct-admission.js";
import { RequestSubmissionService } from "../../engine/src/program/request-submission.js";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { AdmissionRetryModel, neverAttached } from "../src/admission-retry.js";
import { authForbidden } from "../src/auth/errors.js";
import { RequestSubmissionModel } from "../src/request-submission.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(kind: "request" | "direct") {
  const f = submissionFixture();
  await f.ready();
  const directory = await mkdtemp(join(tmpdir(), "orca-operator-receipts-"));
  directories.push(directory);
  const faults = {
    conflict: () => new OrcaError("RUN_STATE", "conflicting intent"),
    limit: () => new OrcaError("RUN_STATE", "retry limit"),
  };
  const claims = new RegisteredRetryClaims(
    new FileRetryClaimStore({
      storeDir: directory,
      execution: new FileExecutionStore(directory),
      faults,
      lockTimeoutMs: 30,
    }),
    faults,
  );
  const requests = new RequestSubmissionService({
    orchestrator: f.orc,
    admissions: f.admissions,
    captureLaunch: f.capture,
    retries: claims,
  });
  const launch = await f.generations.captureLaunch({ purpose: "workflow", workflowId: "program" });
  let beforeStart: (() => Promise<void>) | undefined;
  const direct = new DirectAdmissionService({
    orchestrator: f.orc,
    retries: claims,
    captureLaunch: async () => ({
      ...launch,
      startRun: async (options) => {
        await beforeStart?.();
        return launch.startRun(options);
      },
    }),
    restoreLaunch: async () => launch,
  });
  const directAuthority: DirectAdmissionAuthority = {
    workspaceId: f.authority.workspaceId,
    actor: f.authority.actor,
    authorize: (command) => f.authority.authorize({ title: "Direct run", body: "", workflowId: command.workflowId }),
    onRunAdmitted: (runId) => f.authority.onRunAdmitted(runId),
    verifyRunAdmitted: (runId) => f.authority.verifyRunAdmitted!(runId),
  };
  const completed = vi.fn();
  const execute = vi.fn(async (runId: string) => {
    await f.orc.run(runId);
    completed();
  });
  const executionFailed = vi.fn();
  const requestModel = new RequestSubmissionModel({
    service: requests,
    execute,
    executionFailed,
    shouldDispatch: (runId) => neverAttached(f.orc, runId),
  });
  const directModel = new AdmissionRetryModel({
    claims,
    requests,
    direct,
    orchestrator: f.orc,
    execute,
    executionFailed,
  });
  const requestCommand = { title: "Operator Request", body: "Task", workflowId: "program" };
  const directCommand = { workflowId: "program" };
  const retry = { idempotencyKey: "operator-intent" };
  const serviceCall = kind === "request" ? vi.spyOn(requests, "submitRetry") : vi.spyOn(direct, "admitRun");
  return {
    ...f,
    execute,
    completed,
    executionFailed,
    requestModel,
    serviceCall,
    beforeStart: (action: () => Promise<void>) => {
      beforeStart = action;
      f.beforeStart(action);
    },
    submit: () =>
      kind === "request"
        ? requestModel.submitRetry(requestCommand, f.authority, retry)
        : directModel.admitRetry(directCommand, retry, directAuthority),
    seed: () =>
      kind === "request"
        ? requests.submitRetry(requestCommand, retry, f.authority)
        : direct.admitRun(directCommand, retry, directAuthority),
    legacy: () =>
      kind === "request"
        ? requestModel.submit(requestCommand, f.authority, retry)
        : directModel.admit(directCommand, retry, directAuthority),
  };
}

describe.each(["request", "direct"] as const)("%s retry model receipts", (kind) => {
  it("returns real accepted/replayed envelopes and preserves legacy results without executing an attached run twice", async () => {
    const f = await fixture(kind);
    const first = await f.submit();
    expect(first).toBe(await f.serviceCall.mock.results.at(-1)!.value);
    expect(first).toMatchObject({ state: "resolved", replayed: false, result: { state: "accepted" } });
    if (first.state !== "resolved" || first.result.state !== "accepted") throw new Error("not accepted");
    expect("requestId" in first.result).toBe(kind === "request");
    expect(f.execute).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.completed).toHaveBeenCalledOnce());
    const events = await f.orc.events(first.result.runId);

    const replay = await f.submit();
    expect(replay).toBe(await f.serviceCall.mock.results.at(-1)!.value);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await f.legacy()).toEqual(
      kind === "request" ? first.result : { ...first.result, operationId: first.operationId },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.executionFailed).not.toHaveBeenCalled();
    expect(await f.orc.events(first.result.runId)).toEqual(events);
    expect(await f.orc.listRuns()).toEqual([first.result.runId]);
    expect(await f.stores.requests.list()).toHaveLength(kind === "request" ? 1 : 0);
  });

  it("preserves a live writer's in-progress receipt while the legacy method still throws RUN_STATE", async () => {
    const f = await fixture(kind);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.beforeStart(async () => {
      started();
      await held;
    });
    const first = f.submit();
    await entered;
    try {
      const pending = await f.submit();
      expect(pending).toBe(await f.serviceCall.mock.results.at(-1)!.value);
      expect(pending).toEqual({
        state: "in-progress",
        operationId: expect.any(String),
        recovery: "inspect-or-retry",
      });
      await expect(f.legacy()).rejects.toMatchObject({ code: "RUN_STATE", details: pending });
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      release();
      await first;
    }
    await vi.waitFor(() => expect(f.completed).toHaveBeenCalledOnce());
    expect(await f.orc.listRuns()).toHaveLength(1);
  });

  it("preserves real recoverable failures and their replay without dispatch", async () => {
    const f = await fixture(kind);
    vi.mocked(f.authority.onRunAdmitted).mockRejectedValue(new Error("ownership write interrupted"));
    const first = await f.submit();
    expect(first).toBe(await f.serviceCall.mock.results.at(-1)!.value);
    expect(first).toMatchObject({ state: "resolved", replayed: false, result: { state: "recoverable-failure" } });
    const replay = await f.submit();
    expect(replay).toBe(await f.serviceCall.mock.results.at(-1)!.value);
    expect(replay).toEqual({ ...first, replayed: true });
    if (first.state !== "resolved") throw new Error("not resolved");
    expect(await f.legacy()).toEqual(
      kind === "request" ? first.result : { ...first.result, operationId: first.operationId },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.executionFailed).not.toHaveBeenCalled();
  });

  it("propagates current authority refusals unchanged before admission", async () => {
    const f = await fixture(kind);
    const revoked = authForbidden();
    vi.mocked(f.authority.authorize).mockRejectedValue(revoked);
    await expect(f.submit()).rejects.toBe(revoked);
    expect(await f.orc.listRuns()).toEqual([]);
    expect(await f.stores.requests.list()).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rechecks authority on the existing dispatch path after returning acceptance", async () => {
    const f = await fixture(kind);
    expect(await f.submit()).toMatchObject({ state: "resolved", result: { state: "accepted" } });
    vi.mocked(f.authority.authorize).mockRejectedValue(authForbidden());
    await vi.waitFor(() => expect(f.executionFailed).toHaveBeenCalledOnce());
    expect(f.execute).not.toHaveBeenCalled();
    await expect(f.submit()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(await f.orc.listRuns()).toHaveLength(1);
  });

  it("preserves an accepted replay while refusing dispatch to a leased, never-attached run", async () => {
    const f = await fixture(kind);
    const first = await f.seed();
    if (first.state !== "resolved" || first.result.state !== "accepted") throw new Error("not accepted");
    const runId = first.result.runId;
    await f.stores.leases.acquire({ resource: `run:${runId}`, holder: "other-worker" });
    const leaseRead = vi.spyOn(f.stores.leases, "get");
    expect(await f.submit()).toEqual({ ...first, replayed: true });
    await vi.waitFor(() => expect(leaseRead).toHaveBeenCalledWith(`run:${runId}`));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.executionFailed).not.toHaveBeenCalled();
    expect((await f.orc.getState(first.result.runId)).run.status).toBe("created");
  });
});

it("keeps legacy Request services constructible and truthfully refuses unavailable retry support", async () => {
  const f = submissionFixture();
  const service: SubmissionService = {
    submit: f.service.submit.bind(f.service),
    inspect: f.service.inspect.bind(f.service),
    reconcile: f.service.reconcile.bind(f.service),
    list: f.service.list.bind(f.service),
  };
  const execute = vi.fn(async () => {});
  const model = new RequestSubmissionModel({ service, execute, executionFailed: vi.fn() });
  expect(model.canSubmitRetry()).toBe(false);
  await expect(
    model.submitRetry({ title: "Old service", body: "Task" }, f.authority, { idempotencyKey: "intent" }),
  ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  expect(await f.orc.listRuns()).toEqual([]);
  expect(await model.submit({ title: "Old service", body: "Task" }, f.authority)).toMatchObject({ state: "accepted" });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  expect((await fixture("request")).requestModel.canSubmitRetry()).toBe(true);
});
