/** Admission recovery retains verified authority across a daemon bootstrap rotation. */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RunState, SubmissionResult } from "@orca/core";
import type { ExecutionResumeAuthority } from "@orca/engine";
import type { ResponseMessage } from "@orca/protocol";
import { fileStores } from "@orca/store";
import { ControlModel, ReadModel, startDaemon } from "@orca/daemon";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
import { FileAdmissionStore } from "../../engine/src/program/submission-store.js";
import { CredentialStore, OwnershipStore, orchestratorResolver, type IssueOptions } from "../src/auth/index.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";
import { RequestSubmissionModel } from "../src/request-submission.js";

const close: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const dispose of close.splice(0).reverse()) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, "Request fixture cleanup failed");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  // Preserve the rejecting promise for the test and teardown, even if it fails
  // before they await it. Background dispatch must not produce unhandled rejections.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
async function fixture(options: { beforeCompletion?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "orca-request-renewal-"));
  const boots: { closeDaemon: () => Promise<void> }[] = [];
  const cleanupStarted = deferred<void>();
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      cleanupStarted.resolve();
      const results = await Promise.allSettled(boots.map((boot) => boot.closeDaemon()));
      await rm(directory, { recursive: true, force: true });
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          "Request execution failed",
        );
    })());
  close.push(cleanup);
  const storeDir = join(directory, "store");
  const tokenFile = join(directory, "token");
  const credentialFile = join(directory, "credentials.json");
  const ownershipFile = join(directory, "ownership.json");
  const grants: IssueOptions = { principal: "owner", preset: "owner" };
  const executionFailed = vi.fn();
  async function boot(executeWork: boolean) {
    const f = submissionFixture(fileStores(storeDir), new FileAdmissionStore(storeDir), { nativeCorrelation: true });
    const credentials = new CredentialStore({ file: credentialFile });
    const ownership = new OwnershipStore(ownershipFile);
    const bootstrap = await credentials.bootstrap(grants, tokenFile);
    const token = (await readFile(tokenFile, "utf8")).trim();
    const runtime = daemonExecutionRuntime({
      instanceId: executeWork ? "new-boot" : "old-boot",
      workspaceId: "workspace-test",
      orchestrator: f.orc,
      credentials,
      ownership,
    });
    f.orc.liveInput = runtime;
    f.orc.admissionExecution = { authorize: (policy) => runtime.authorizeAdmissionExecution(policy) };
    const reads = new ReadModel({ orchestrator: f.orc });
    type Dispatch = {
      runId?: string;
      started: ReturnType<typeof deferred<void>>;
      completed: ReturnType<typeof deferred<RunState | undefined>>;
    };
    const dispatchContext = new AsyncLocalStorage<Dispatch>();
    const dispatches: Dispatch[] = [];
    const tracked = (operation: () => Promise<SubmissionResult>) => {
      const dispatch: Dispatch = { started: deferred<void>(), completed: deferred<RunState | undefined>() };
      return dispatchContext.run(dispatch, async () => {
        const result = await operation();
        if (result.state === "accepted") {
          dispatch.runId = result.runId;
          dispatches.push(dispatch);
        }
        return result;
      });
    };
    if (executeWork && options.beforeCompletion) {
      const append = f.orc.stores.events.append.bind(f.orc.stores.events);
      vi.spyOn(f.orc.stores.events, "append").mockImplementation(async (event) => {
        if (event.type === "run.completed") await options.beforeCompletion!();
        return append(event);
      });
    }
    const execute = vi.fn((runId: string, authority?: ExecutionResumeAuthority) => {
      const dispatch = dispatchContext.getStore();
      if (!dispatch) throw new Error("untracked Request execution");
      dispatch.started.resolve();
      const work = executeWork
        ? runtime.withResumeAuthority(runId, authority, () => f.orc.run(runId))
        : Promise.resolve(undefined);
      // Capture the actual interpreter promise, including lease release. Tests
      // await this completion instead of polling a public state projection.
      void work.then(dispatch.completed.resolve, dispatch.completed.reject);
      return work.then(() => undefined);
    });
    const model = new RequestSubmissionModel({
      service: f.service,
      checkResumeAuthority: (runId, authority) => runtime.checkResumeAuthority(runId, authority),
      execute,
      executionFailed: (runId) => {
        executionFailed(runId);
        const dispatch = dispatchContext.getStore();
        if (!dispatch) throw new Error("untracked Request dispatch failure");
        const error = new Error(`Request dispatch failed before execution completed: ${runId}`);
        dispatch.started.reject(error);
        dispatch.completed.reject(error);
      },
    });
    const submit = model.submit.bind(model);
    const reconcile = model.reconcile.bind(model);
    model.submit = (...args) => tracked(() => submit(...args));
    model.reconcile = (...args) => tracked(() => reconcile(...args));
    const dispatchFor = (runId: string) => {
      const dispatch = dispatches.find((entry) => entry.runId === runId);
      if (!dispatch) throw new Error(`no accepted Request dispatch: ${runId}`);
      return dispatch;
    };
    const daemon = await startDaemon({
      orcaVersion: "test",
      capabilities: ["runs.read", "runs.control"],
      reads,
      control: new ControlModel({ orchestrator: f.orc, reads }),
      source: f.orc,
      requestSubmissions: model,
      submissionWorkspaceId: "workspace-test",
      auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(f.orc) },
    });
    let closing: Promise<void> | undefined;
    const closeDaemon = () =>
      (closing ??= (async () => {
        // Accepted calls have already scheduled workers. A worker may still be
        // inspecting durable evidence and not have reached execute yet.
        const results = await Promise.allSettled(dispatches.map((dispatch) => dispatch.completed.promise));
        await daemon.close();
        runtime.close();
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (errors.length)
          throw new AggregateError(
            errors.map((result) => result.reason),
            "Request execution failed",
          );
      })());
    boots.push({ closeDaemon });
    const rpc = async (method: string, params: unknown, bearer = token): Promise<ResponseMessage> => {
      const response = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "request", id: 1, method, params }),
      });
      return (await response.json()) as ResponseMessage;
    };
    return { ...f, credentials, ownership, bootstrap, token, runtime, execute, dispatchFor, closeDaemon, rpc };
  }
  const first = await boot(false);
  const reply = await first.rpc("requests.submit", { title: "Recover me", body: "Original request" });
  if (!reply.ok) throw new Error("submission failed");
  const admitted = reply.result as SubmissionResult;
  if (admitted.state !== "accepted") throw new Error("not accepted");
  await first.dispatchFor(admitted.runId).started.promise;
  await first.dispatchFor(admitted.runId).completed.promise;
  expect(first.execute).toHaveBeenCalledOnce();
  expect((await first.orc.getState(admitted.runId)).run.status).toBe("created");
  await first.closeDaemon();
  const second = await boot(true);
  return { ...second, first, admitted, executionFailed, directory, cleanup, cleanupStarted: cleanupStarted.promise };
}

it("executes the original accepted root with the same principal's current authority after restart", async () => {
  const f = await fixture();
  expect(f.credentials.current(f.first.bootstrap.credentialId).ok).toBe(false);
  expect(await f.rpc("requests.reconcile", { admissionId: f.admitted.admissionId })).toMatchObject({
    ok: true,
    result: f.admitted,
  });
  await f.dispatchFor(f.admitted.runId).started.promise;
  await f.dispatchFor(f.admitted.runId).completed.promise;
  expect((await f.orc.getState(f.admitted.runId)).run.status).toBe("completed");
  expect(f.executionFailed).not.toHaveBeenCalled();
  expect(await f.orc.listRuns()).toEqual([f.admitted.runId]);
  expect(f.ownership.owner(f.admitted.runId)).toBe("owner");
  expect((await f.orc.events(f.admitted.runId))[0]).toMatchObject({
    payload: { actor: { principalId: "owner", credentialId: f.first.bootstrap.credentialId } },
  });
  expect(JSON.stringify(await f.orc.events(f.admitted.runId))).not.toContain("orca1.");
});

it.each([
  ["different principal", { principal: "someone-else", preset: "owner" }],
  ["missing launch", { principal: "owner", permissions: ["plan.write", "runs.control"] }],
  ["missing plan write", { principal: "owner", permissions: ["runs.start", "runs.control"] }],
] satisfies [string, IssueOptions][])("rejects recovery with %s", async (_label, grants) => {
  const f = await fixture();
  const issued = await f.credentials.issue({ scope: { workflows: "*", runs: "all" }, ...grants });
  const before = await f.orc.events(f.admitted.runId);
  expect(await f.rpc("requests.reconcile", { admissionId: f.admitted.admissionId }, issued.token)).toMatchObject({
    ok: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.execute).not.toHaveBeenCalled();
  expect(await f.orc.events(f.admitted.runId)).toEqual(before);
});

it("cannot renew without run control and can retry with a fully authorized credential", async () => {
  const f = await fixture();
  const issued = await f.credentials.issue({
    principal: "owner",
    permissions: ["runs.start", "plan.write"],
    scope: { workflows: "*", runs: "all" },
  });
  const before = await f.orc.events(f.admitted.runId);
  expect(await f.rpc("requests.reconcile", { admissionId: f.admitted.admissionId }, issued.token)).toMatchObject({
    ok: false,
    error: { code: "AUTH_FORBIDDEN" },
  });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.executionFailed).not.toHaveBeenCalled();
  expect(await f.orc.events(f.admitted.runId)).toEqual(before);
  expect(await f.orc.listLeases()).toEqual([]);
  await f.rpc("requests.reconcile", { admissionId: f.admitted.admissionId });
  await f.dispatchFor(f.admitted.runId).started.promise;
  await f.dispatchFor(f.admitted.runId).completed.promise;
  expect((await f.orc.getState(f.admitted.runId)).run.status).toBe("completed");
  expect(f.executionFailed).not.toHaveBeenCalled();
});

it("preflights recovery without installing reusable execution authority", async () => {
  const f = await fixture();
  const authority: ExecutionResumeAuthority = {
    actor: { principalId: "owner", credentialId: f.bootstrap.credentialId },
    authorize: vi.fn(async () => {}),
  };
  await f.runtime.checkResumeAuthority(f.admitted.runId, authority);
  const execute = vi.fn(() => f.orc.run(f.admitted.runId));
  await expect(f.runtime.withResumeAuthority(f.admitted.runId, undefined, execute)).rejects.toMatchObject({
    code: "RUN_STATE",
    details: { executionResumeRequired: true },
  });
  expect(execute).not.toHaveBeenCalled();
  expect(await f.orc.listLeases()).toEqual([]);
  expect((await f.orc.getState(f.admitted.runId)).run.status).toBe("created");
});

it("rejects revocation during asynchronous renewal preparation without attaching", async () => {
  const f = await fixture();
  const before = await f.orc.events(f.admitted.runId);
  const authority: ExecutionResumeAuthority = {
    actor: { principalId: "owner", credentialId: f.bootstrap.credentialId },
    authorize: async () => {
      await f.credentials.revoke(f.bootstrap.credentialId);
    },
  };
  await expect(f.runtime.checkResumeAuthority(f.admitted.runId, authority)).rejects.toMatchObject({
    code: "RUN_STATE",
    details: { executionResumeRequired: true },
  });
  expect(await f.orc.events(f.admitted.runId)).toEqual(before);
  expect(await f.orc.listLeases()).toEqual([]);
});

it("acknowledges reconciliation before slow execution completes and waits for it during teardown", async () => {
  const held = deferred<void>();
  const release = deferred<void>();
  const f = await fixture({
    beforeCompletion: async () => {
      held.resolve();
      await release.promise;
    },
  });
  let cleanupFinished = false;
  try {
    expect(await f.rpc("requests.reconcile", { admissionId: f.admitted.admissionId })).toMatchObject({
      ok: true,
      result: f.admitted,
    });
    const dispatch = f.dispatchFor(f.admitted.runId);
    await dispatch.started.promise;
    await held.promise;
    expect((await f.orc.getState(f.admitted.runId)).run.status).toBe("running");
    const cleanup = f.cleanup().then(() => {
      cleanupFinished = true;
    });
    await f.cleanupStarted;
    expect(cleanupFinished).toBe(false);
    expect((await stat(f.directory)).isDirectory()).toBe(true);
    release.resolve();
    const completed = await dispatch.completed.promise;
    expect(completed?.run.status).toBe("completed");
    expect(completed?.run.id).toBe(f.admitted.runId);
    await cleanup;
    expect(cleanupFinished).toBe(true);
    await expect(stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.executionFailed).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
});
