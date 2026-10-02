import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError, type SubmissionCommand } from "@orca/core";
import { fileStores } from "@orca/store";
import { ProgramService } from "@orca/engine";
import { RequestSubmissionService } from "../src/program/request-submission.js";
import { FileAdmissionStore } from "../src/program/submission-store.js";
import { submissionFixture } from "./request-submission-fixture.js";

const command = { title: "Build it", body: "A useful feature" };
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("admits linked, owned work without executing it; explicit runs remain Request-free", async () => {
  const f = submissionFixture();
  const result = await f.service.submit(command, f.authority);
  expect(result.state).toBe("accepted");
  if (result.state !== "accepted") throw new Error("not accepted");
  expect(f.owners.get(result.runId)).toBe("owner");
  expect(await f.orc.getState(result.runId)).toMatchObject({
    run: { status: "created", requestId: result.requestId, vars: { request: { id: result.requestId } } },
  });
  expect(await f.stores.requests.get(result.requestId)).toMatchObject({
    programRunId: result.runId,
    status: "decomposing",
  });
  expect(await f.service.inspect(result.admissionId, f.authority)).toEqual(result);
  const direct = await f.orc.startRun({ workflowId: "program" });
  expect((await f.orc.getState(direct)).run.requestId).toBeUndefined();
  expect(await f.stores.requests.list()).toHaveLength(1);
  expect(await f.stores.events.read(result.runId)).toMatchObject([
    { type: "run.created", payload: { actor: f.authority.actor } },
  ]);
});

it.each([
  { title: "" },
  { vars: { request: { id: "forged" } } },
  { requestId: "missing" },
  { workItemId: "missing" },
  { principalId: "other" },
  { actor: { principalId: "other" } },
  { admissionId: "retry" },
  { programRunId: "run-x" },
  { overrides: { nope: true } },
])("rejects invalid/unsupported associations before side effects: %j", async (patch) => {
  const f = submissionFixture();
  await expect(f.service.submit({ ...command, ...patch } as SubmissionCommand, f.authority)).rejects.toMatchObject({
    code: "WORKFLOW_INPUT_INVALID",
  });
  expect(await f.admissions.records.list()).toEqual([]);
  expect(await f.stores.requests.list()).toEqual([]);
  expect(await f.orc.listRuns()).toEqual([]);
});

it("checks authority before invalid-input diagnostics and capture", async () => {
  const f = submissionFixture();
  vi.mocked(f.authority.authorize).mockRejectedValue(new OrcaError("NOT_SUPPORTED", "denied"));
  await expect(f.service.submit({ title: "", body: "" }, f.authority)).rejects.toThrow("denied");
  expect(f.capture).not.toHaveBeenCalled();
  expect(await f.admissions.records.list()).toEqual([]);
});

it.each([
  { workflowId: "missing" },
  { workflowVersion: "absent" },
  { expectedWorkflowRevision: "changed" },
  { expectedConfigGeneration: "stale" },
  { vars: { token: 12 } },
  { overrides: { roles: { builder: "missing" } } },
])("preflights all launch choices before Request creation: %j", async (patch) => {
  const f = submissionFixture();
  await expect(f.service.submit({ ...command, ...patch }, f.authority)).rejects.toThrow();
  expect(await f.admissions.records.list()).toEqual([]);
  expect(await f.stores.requests.list()).toEqual([]);
  expect(await f.orc.listRuns()).toEqual([]);
});

describe("durable write boundaries", () => {
  it.each([
    "request-before",
    "request-after",
    "run-before",
    "run-after",
    "owner",
    "link-before",
    "link-after",
    "accepted-before",
    "accepted-after",
  ])("reconciles %s without a second root", async (boundary) => {
    const f = submissionFixture();
    const fault = () => {
      throw new Error("secret failure details");
    };
    if (boundary.startsWith("request") || boundary.startsWith("link")) {
      const original = f.stores.requests.put.bind(f.stores.requests);
      vi.spyOn(f.stores.requests, "put").mockImplementation(async (request) => {
        const match = boundary.startsWith("link") ? !!request.programRunId : !request.programRunId;
        if (match && boundary.endsWith("before")) fault();
        await original(request);
        if (match && boundary.endsWith("after")) fault();
      });
    } else if (boundary.startsWith("run")) {
      const original = f.orc.startRun.bind(f.orc);
      vi.spyOn(f.orc, "startRun").mockImplementation(async (options) => {
        if (boundary.endsWith("before")) fault();
        await original(options);
        return fault();
      });
    } else if (boundary === "owner")
      vi.mocked(f.authority.onRunAdmitted).mockRejectedValue(new Error("owner write failed"));
    else {
      const original = f.admissions.records.put.bind(f.admissions.records);
      vi.spyOn(f.admissions.records, "put").mockImplementation(async (record) => {
        if (record.state === "accepted" && boundary.endsWith("before")) fault();
        await original(record);
        if (record.state === "accepted" && boundary.endsWith("after")) fault();
      });
    }
    const failed = await f.service.submit(command, f.authority);
    expect(failed.state).toBe("recoverable-failure");
    expect(JSON.stringify(failed)).not.toContain("secret");
    const existing = await f.orc.listRuns();
    vi.restoreAllMocks();
    vi.mocked(f.authority.onRunAdmitted).mockImplementation(async (id) => {
      f.owners.set(id, "owner");
    });
    const restarted = new RequestSubmissionService({
      orchestrator: f.orc,
      admissions: f.admissions,
      captureLaunch: f.capture,
    });
    const [a, b] = await Promise.all([
      restarted.reconcile(failed.admissionId, f.authority),
      f.service.reconcile(failed.admissionId, f.authority),
    ]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ state: "accepted", requestId: failed.requestId, admissionId: failed.admissionId });
    if (a.state !== "accepted") throw new Error("not accepted");
    expect(await f.orc.listRuns()).toEqual([a.runId]);
    if (existing.length) expect(a.runId).toBe(existing[0]);
    expect(f.owners.get(a.runId)).toBe("owner");
  });
});

it("keeps prepared discoverable when both Request and failure-marker writes fail", async () => {
  const f = submissionFixture();
  vi.spyOn(f.stores.requests, "put").mockRejectedValue(new Error("disk full"));
  const original = f.admissions.records.put.bind(f.admissions.records);
  vi.spyOn(f.admissions.records, "put").mockImplementation(async (r) => {
    if (r.state !== "prepared") throw new Error("disk full");
    await original(r);
  });
  const failed = await f.service.submit(command, f.authority);
  expect(await f.service.list(f.authority)).toEqual([
    { state: "prepared", admissionId: failed.admissionId, requestId: failed.requestId },
  ]);
});

it("does not expose other principals/workspaces, missing material, or launch on an ambiguous scan", async () => {
  const f = submissionFixture();
  const accepted = await f.service.submit(command, f.authority);
  const other = { ...f.authority, actor: { principalId: "other" } };
  expect(await f.service.list(other)).toEqual([]);
  for (const authority of [other, { ...f.authority, workspaceId: "elsewhere" }]) {
    await expect(f.service.inspect(accepted.admissionId, authority)).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(f.service.reconcile(accepted.admissionId, authority)).rejects.toMatchObject({ code: "RUN_STATE" });
  }
  vi.spyOn(f.stores.events, "readRange").mockRejectedValue(new Error("unreadable log"));
  expect((await f.service.reconcile(accepted.admissionId, f.authority)).state).toBe("recoverable-failure");
  expect(await f.orc.listRuns()).toHaveLength(1);
});

it("keeps one captured generation even if configuration changes before launch", async () => {
  const f = submissionFixture();
  f.beforeStart(async () => {
    f.setGeneration("fixture-generation-2");
  });
  const result = await f.service.submit(command, f.authority);
  if (result.state !== "accepted") throw new Error("not accepted");
  expect((await f.orc.getState(result.runId)).run.vars.capturedGeneration).toBe("fixture-generation-1");
  expect(f.capture).toHaveBeenCalledTimes(1);
});

it("fails closed if restart cannot restore the original generation; never silently uses current choices", async () => {
  const f = submissionFixture();
  vi.spyOn(f.orc, "startRun").mockRejectedValueOnce(new Error("launch failed"));
  const result = await f.service.submit(command, f.authority);
  f.setGeneration("fixture-generation-2");
  expect((await f.service.reconcile(result.admissionId, f.authority)).state).toBe("recoverable-failure");
  expect(await f.orc.listRuns()).toEqual([]);
});

it("rechecks revocation before creation and ownership, preserving discoverable recovery", async () => {
  const f = submissionFixture();
  f.beforeStart(async () => {
    vi.mocked(f.authority.authorize).mockRejectedValue(new Error("revoked"));
  });
  const result = await f.service.submit(command, f.authority);
  expect(result.state).toBe("recoverable-failure");
  expect(f.authority.onRunAdmitted).not.toHaveBeenCalled();
  await expect(f.service.reconcile(result.admissionId, f.authority)).rejects.toThrow("revoked");
});

it("the configured ProgramService compatibility wrapper uses the same admission and settles execution", async () => {
  const f = submissionFixture();
  const program = new ProgramService(f.orc, "program", undefined, {
    admissions: f.admissions,
    captureLaunch: f.capture,
    authority: f.authority,
  });
  const result = await program.submitAndRun(command);
  expect(result.request.status).toBe("completed");
  expect(await program.submissions!.list(f.authority)).toMatchObject([
    { state: "accepted", runId: result.state.run.id, requestId: result.request.id },
  ]);
});

it("recovers from actual file stores after restart, retaining ciphertext and original run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-submission-"));
  dirs.push(dir);
  const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
  vi.mocked(f.authority.onRunAdmitted).mockRejectedValueOnce(new Error("crash before owner"));
  const result = await f.service.submit({ ...command, vars: { token: "secret-caller-token" } }, f.authority);
  expect(result.state).toBe("recoverable-failure");
  const before = await f.orc.listRuns();
  const next = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
  const peer = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
  const [accepted, concurrent] = await Promise.all([
    next.service.reconcile(result.admissionId, next.authority),
    peer.service.reconcile(result.admissionId, peer.authority),
  ]);
  expect(concurrent).toEqual(accepted);
  expect(accepted).toMatchObject({ state: "accepted", runId: before[0], requestId: result.requestId });
  expect(await next.orc.listRuns()).toEqual(before);
  expect(await readFile(join(dir, "request-admissions.json"), "utf8")).not.toContain("secret-caller-token");
  for (const name of await readdir(join(dir, "private-execution"))) {
    expect(await readFile(join(dir, "private-execution", name), "utf8")).not.toContain("secret-caller-token");
  }
  if (accepted.state !== "accepted") throw new Error("not accepted");
  expect((await next.orc.getState(accepted.runId)).run.vars.token).toBe("[REDACTED]");
  expect((await next.stores.execution.getInputs(accepted.runId))?.vars.token).toBe("secret-caller-token");
  await next.orc.run(accepted.runId);
  expect((await next.orc.getState(accepted.runId)).run.status).toBe("completed");
});

it("redacts Request metadata that repeats protected values without corrupting structural source tags", async () => {
  const f = submissionFixture();
  const result = await f.service.submit(
    {
      title: "api feature",
      body: "api",
      source: { kind: "api", clientId: "api" },
      labels: ["api"],
      vars: { token: "api" },
    },
    f.authority,
  );
  if (result.state !== "accepted") throw new Error("not accepted");
  expect(await f.stores.requests.get(result.requestId)).toMatchObject({
    title: "[REDACTED] feature",
    body: "[REDACTED]",
    source: { kind: "api", clientId: "[REDACTED]" },
    labels: ["[REDACTED]"],
  });
  expect((await f.stores.execution.getInputs(result.runId))?.vars.request).toMatchObject({
    title: "api feature",
    body: "api",
  });
});

it.each(["sealed", "index-before", "index-after"])(
  "handles uncertain initial %s persistence without invisible work or raw errors",
  async (boundary) => {
    const f = submissionFixture();
    if (boundary === "sealed")
      vi.spyOn(f.stores.execution, "putInputs").mockRejectedValueOnce(new Error("secret path"));
    else {
      const put = f.admissions.records.put.bind(f.admissions.records);
      vi.spyOn(f.admissions.records, "put").mockImplementationOnce(async (record) => {
        if (boundary === "index-after") await put(record);
        throw new Error("secret path");
      });
    }
    await expect(f.service.submit(command, f.authority)).rejects.toMatchObject({
      code: "STORE_WRITE",
      message: "Request admission could not be prepared; inspect admissions before retrying",
    });
    expect(await f.stores.requests.list()).toEqual([]);
    expect(await f.orc.listRuns()).toEqual([]);
    const visible = await f.service.list(f.authority);
    if (boundary === "index-after") {
      expect(visible).toHaveLength(1);
      expect((await f.service.reconcile(visible[0]!.admissionId, f.authority)).state).toBe("accepted");
    } else expect(visible).toEqual([]);
  },
);

it("authenticates the recovery binding and refuses missing protected input instead of substituting defaults", async () => {
  const f = submissionFixture();
  const result = await f.service.submit(command, f.authority);
  const record = await f.admissions.records.get(result.admissionId);
  await f.admissions.records.put({ ...record!, generationId: "forged-generation" });
  await expect(f.service.reconcile(result.admissionId, f.authority)).rejects.toMatchObject({ code: "RUN_STATE" });
  vi.spyOn(f.stores.execution, "getInputs").mockResolvedValue(undefined);
  await expect(f.service.reconcile(result.admissionId, f.authority)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(await f.orc.listRuns()).toHaveLength(1);
});
