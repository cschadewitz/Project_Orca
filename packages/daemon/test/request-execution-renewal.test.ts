/** Admission recovery retains verified authority across a daemon bootstrap rotation. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SubmissionResult } from "@orca/core";
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
  for (const dispose of close.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orca-request-renewal-"));
  close.push(() => rm(directory, { recursive: true, force: true }));
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
    close.push(() => runtime.close());
    f.orc.liveInput = runtime;
    f.orc.admissionExecution = { authorize: (policy) => runtime.authorizeAdmissionExecution(policy) };
    const reads = new ReadModel({ orchestrator: f.orc });
    const execute = vi.fn(async (runId: string, authority?: ExecutionResumeAuthority) => {
      if (executeWork) await runtime.withResumeAuthority(runId, authority, () => f.orc.run(runId));
    });
    const daemon = await startDaemon({
      orcaVersion: "test",
      capabilities: ["runs.read", "runs.control"],
      reads,
      control: new ControlModel({ orchestrator: f.orc, reads }),
      source: f.orc,
      requestSubmissions: new RequestSubmissionModel({
        service: f.service,
        checkResumeAuthority: (runId, authority) => runtime.checkResumeAuthority(runId, authority),
        execute,
        executionFailed,
      }),
      submissionWorkspaceId: "workspace-test",
      auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(f.orc) },
    });
    let closed = false;
    const closeDaemon = async () => {
      if (closed) return;
      closed = true;
      await daemon.close();
    };
    close.push(closeDaemon);
    const rpc = async (method: string, params: unknown, bearer = token): Promise<ResponseMessage> => {
      const response = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "request", id: 1, method, params }),
      });
      return (await response.json()) as ResponseMessage;
    };
    return { ...f, credentials, ownership, bootstrap, token, runtime, execute, closeDaemon, rpc };
  }
  const first = await boot(false);
  const reply = await first.rpc("requests.submit", { title: "Recover me", body: "Original request" });
  if (!reply.ok) throw new Error("submission failed");
  const admitted = reply.result as SubmissionResult;
  if (admitted.state !== "accepted") throw new Error("not accepted");
  await vi.waitFor(() => expect(first.execute).toHaveBeenCalledOnce());
  expect((await first.orc.getState(admitted.runId)).run.status).toBe("created");
  await first.closeDaemon();
  first.runtime.close();
  const second = await boot(true);
  return { ...second, first, admitted, executionFailed };
}

it("executes the original accepted root with the same principal's current authority after restart", async () => {
  const f = await fixture();
  expect(f.credentials.current(f.first.bootstrap.credentialId).ok).toBe(false);
  expect(await f.rpc("requests.reconcile", { admissionId: f.admitted.admissionId })).toMatchObject({
    ok: true,
    result: f.admitted,
  });
  await vi.waitFor(async () => expect((await f.orc.getState(f.admitted.runId)).run.status).toBe("completed"));
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
  await vi.waitFor(async () => expect((await f.orc.getState(f.admitted.runId)).run.status).toBe("completed"));
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
