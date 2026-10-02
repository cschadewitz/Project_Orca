import { expect, it, vi } from "vitest";
import { ProgramService } from "@orca/engine";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
import { RequestSubmissionModel, submissionAuthority } from "../src/request-submission.js";
import { Authorizer } from "../src/auth/guard.js";
import { OwnershipStore } from "../src/auth/ownership.js";
import { PERMISSIONS, UNRESTRICTED, type Principal } from "../src/auth/principal.js";
import { RequestsSubmitParamsSchema } from "../../protocol/src/request-submission.js";

const command = { title: "Build it", body: "Task" };
it("returns admission while execution is still pending, and never starts failed admissions", async () => {
  const f = submissionFixture();
  const execute = vi.fn(() => new Promise<void>(() => {}));
  const model = new RequestSubmissionModel({ service: f.service, execute, executionFailed: vi.fn() });
  const result = await model.submit(command, f.authority);
  expect(result.state).toBe("accepted");
  expect(execute).not.toHaveBeenCalled();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(execute).toHaveBeenCalledOnce();
  if (result.state !== "accepted") throw new Error("not accepted");
  expect(execute).toHaveBeenCalledWith(result.runId);
  expect(await model.inspect(result.admissionId, f.authority)).toEqual(result);
  vi.mocked(f.authority.onRunAdmitted).mockRejectedValueOnce(new Error("disk failed"));
  expect((await model.submit(command, f.authority)).state).toBe("recoverable-failure");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(execute).toHaveBeenCalledOnce();
});

it("the daemon and ProgramService adapters preserve the same links, actor and lifecycle", async () => {
  const f = submissionFixture();
  const program = new ProgramService(f.orc, "program", undefined, {
    admissions: f.admissions,
    captureLaunch: f.capture,
    authority: f.authority,
  });
  const model = new RequestSubmissionModel({
    service: program.submissions!,
    execute: async (id) => {
      await program.settle(await f.orc.run(id));
    },
    executionFailed: vi.fn(),
  });
  const daemon = await model.submit(command, f.authority);
  const cli = await program.submitAndRun(command);
  if (daemon.state !== "accepted") throw new Error("not accepted");
  await vi.waitFor(async () => {
    expect((await f.stores.requests.get(daemon.requestId))?.status).toBe("completed");
  });
  expect((await f.stores.events.read(daemon.runId)).map((e) => e.type)).toEqual(
    (await f.stores.events.read(cli.state.run.id)).map((e) => e.type),
  );
  for (const [requestId, runId] of [
    [daemon.requestId, daemon.runId],
    [cli.request.id, cli.state.run.id],
  ]) {
    expect(await f.stores.requests.get(requestId!)).toMatchObject({
      title: command.title,
      body: command.body,
      status: "completed",
      programRunId: runId,
    });
    expect((await f.stores.events.read(runId!))[0]).toMatchObject({
      type: "run.created",
      payload: { requestId, actor: f.authority.actor },
    });
  }
});

it("uses live verified permissions and exact ownership; caller source is never identity", async () => {
  const f = submissionFixture();
  const ownership = new OwnershipStore();
  const authorizer = new Authorizer({
    ownership,
    resolver: {
      run: async () => undefined,
      inputRun: async () => undefined,
      artifactRun: async () => undefined,
      claimRun: async () => undefined,
      workflowExists: () => true,
    },
  });
  let principal: Principal = {
    id: "owner",
    kind: "credential",
    permissions: new Set(PERMISSIONS),
    scope: UNRESTRICTED,
  };
  const authority = submissionAuthority({
    workspaceId: "workspace-test",
    actor: { principalId: "owner" },
    principal: async () => principal,
    authorizer,
  });
  principal = { ...principal, permissions: new Set(["runs.start"]) };
  await expect(f.service.submit(command, authority)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  expect(await f.stores.requests.list()).toEqual([]);
  principal = { ...principal, permissions: new Set(PERMISSIONS) };
  const result = await f.service.submit({ ...command, source: { kind: "api", clientId: "attacker" } }, authority);
  if (result.state !== "accepted") throw new Error("not accepted");
  expect(ownership.owner(result.runId)).toBe("owner");
  principal = { ...principal, permissions: new Set() };
  await expect(f.service.reconcile(result.admissionId, authority)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  await expect(f.service.inspect(result.admissionId, authority)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  expect(RequestsSubmitParamsSchema.safeParse({ ...command, principalId: "owner" }).success).toBe(false);
});

it("the daemon worker also refuses authority revoked during acceptance", async () => {
  const f = submissionFixture();
  const put = f.admissions.records.put.bind(f.admissions.records);
  vi.spyOn(f.admissions.records, "put").mockImplementation(async (record) => {
    await put(record);
    if (record.state === "accepted")
      vi.mocked(f.authority.authorize).mockRejectedValue(new Error("revoked after acceptance"));
  });
  const execute = vi.fn(async () => {});
  const executionFailed = vi.fn();
  const model = new RequestSubmissionModel({ service: f.service, execute, executionFailed });
  const result = await model.submit(command, f.authority);
  expect(result.state).toBe("accepted");
  await vi.waitFor(() => expect(executionFailed).toHaveBeenCalledOnce());
  expect(execute).not.toHaveBeenCalled();
});
