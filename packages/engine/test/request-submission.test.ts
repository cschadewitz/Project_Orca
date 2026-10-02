import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrcaError,
  parseWorkflow,
  RequestSchema,
  SUBMISSION_CORRELATION_VAR,
  type SubmissionCommand,
} from "@orca/core";
import { fileStores } from "@orca/store";
import { ProgramService } from "@orca/engine";
import { RequestSubmissionService } from "../src/program/request-submission.js";
import { FileAdmissionStore, type Admission } from "../src/program/submission-store.js";
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
  { vars: { [SUBMISSION_CORRELATION_VAR]: "forged" } },
  { requestId: "missing" },
  { workItemId: "missing" },
  { principalId: "other" },
  { actor: { principalId: "other" } },
  { admissionId: "retry" },
  { requestAdmissionId: "forged" },
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

it.each(["submitAndRun", "split CLI"])("rechecks authority after acceptance before %s execution", async (adapter) => {
  const f = submissionFixture();
  const program = new ProgramService(f.orc, "program", undefined, {
    admissions: f.admissions,
    captureLaunch: f.capture,
    authority: f.authority,
  });
  const put = f.admissions.records.put.bind(f.admissions.records);
  vi.spyOn(f.admissions.records, "put").mockImplementation(async (record) => {
    await put(record);
    if (record.state === "accepted")
      vi.mocked(f.authority.authorize).mockRejectedValue(new Error("revoked after acceptance"));
  });
  const run = vi.spyOn(f.orc, "run");
  const execute =
    adapter === "submitAndRun"
      ? program.submitAndRun(command)
      : program.submit(command).then((admitted) => program.runSubmitted(admitted));
  await expect(execute).rejects.toThrow("revoked after acceptance");
  expect(run).not.toHaveBeenCalled();
  const [record] = await f.admissions.records.list();
  expect(record?.state).toBe("accepted");
  expect((await f.stores.events.read(record!.runId!)).map((event) => event.type)).toEqual(["run.created"]);
});

it.each(["recorded", "request-link", "neither-link"])(
  "recovers the original root with %s while other direct runs share its Request",
  async (links) => {
    const f = submissionFixture();
    f.orc.workflows.register(
      parseWorkflow(`id: direct-followup\nname: Followup\nstart: e\nnodes: { e: { type: end } }\nedges: []`),
    );
    const start = f.orc.startRun.bind(f.orc);
    let rootId: string | undefined;
    if (links === "neither-link") {
      vi.spyOn(f.orc, "startRun").mockImplementationOnce(async (options) => {
        rootId = await start(options);
        throw new Error("crash after run.created");
      });
    }
    const initial = await f.service.submit(command, f.authority);
    const record = (await f.admissions.records.get(initial.admissionId))!;
    rootId ??= record.runId;
    if (links === "request-link") {
      const { runId: _runId, ...withoutRoot } = record;
      await f.admissions.records.put(withoutRoot);
    }
    // Both a different workflow and another invocation of the same one are valid associations.
    for (const workflowId of ["direct-followup", "program"])
      await start({ workflowId, requestId: initial.requestId, actor: f.authority.actor });
    const recovered = await f.service.reconcile(initial.admissionId, f.authority);
    expect(recovered).toEqual({
      state: "accepted",
      admissionId: initial.admissionId,
      requestId: initial.requestId,
      runId: rootId,
    });
    expect((await f.stores.requests.get(initial.requestId))?.programRunId).toBe(rootId);
    expect(await f.orc.listRuns()).toHaveLength(3);
  },
);

it("recovers an unlinked root using protected correlation after file-store restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-root-correlation-"));
  dirs.push(dir);
  const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
  const start = f.orc.startRun.bind(f.orc);
  let rootId = "";
  vi.spyOn(f.orc, "startRun").mockImplementationOnce(async (options) => {
    // A sensitive value can match the correlation: public vars must not drive recovery.
    rootId = await start({
      ...options,
      vars: { ...options.vars, token: (options as { requestAdmissionId?: string }).requestAdmissionId },
    });
    throw new Error("crash after root publication");
  });
  const initial = await f.service.submit(command, f.authority);
  expect(initial.state).toBe("recoverable-failure");
  const [created] = await f.stores.events.read(rootId);
  const publicLog = await readFile(join(dir, "runs", `${rootId}.jsonl`), "utf8");
  expect(publicLog).not.toContain(initial.admissionId);
  expect(created?.payload).not.toHaveProperty(`vars.${SUBMISSION_CORRELATION_VAR}`);
  await start({ workflowId: "program", requestId: initial.requestId, actor: f.authority.actor });
  const reopened = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
  expect(await reopened.service.reconcile(initial.admissionId, reopened.authority)).toMatchObject({
    state: "accepted",
    runId: rootId,
  });
  expect(await reopened.orc.listRuns()).toHaveLength(2);
});

it("never replaces a recorded root whose protected inputs are missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-root-missing-inputs-"));
  dirs.push(dir);
  const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
  const initial = await f.service.submit(command, f.authority);
  if (initial.state !== "accepted") throw new Error("not accepted");
  await rm(join(dir, "private-execution", `${encodeURIComponent(initial.runId)}.inputs.json`));
  const reopened = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
  expect((await reopened.service.reconcile(initial.admissionId, reopened.authority)).state).toBe("recoverable-failure");
  expect(await reopened.orc.listRuns()).toEqual([initial.runId]);
});

it.each(["completed", "failed", "cancelled"] as const)(
  "preserves concurrent %s settlement across file-store reconciliation and restart",
  async (status) => {
    const dir = await mkdtemp(join(tmpdir(), "orca-reconcile-settlement-"));
    dirs.push(dir);
    const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
    const workflow = parseWorkflow(
      `id: settlement-program\nname: Settlement\nstart: e\nnodes: { e: { type: end, outcome: ${status === "failed" ? "failure" : "success"} } }\nedges: []`,
    );
    f.orc.workflows.register(workflow);
    const admitted = await f.service.submit({ ...command, workflowId: workflow.id }, f.authority);
    if (admitted.state !== "accepted") throw new Error("not accepted");
    const peer = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
    peer.orc.workflows.register(workflow);
    const program = new ProgramService(peer.orc);
    if (status === "cancelled") await peer.orc.cancel(admitted.runId, "operator cancelled");
    else await peer.orc.run(admitted.runId);
    const terminal = await peer.orc.getState(admitted.runId);
    vi.spyOn(peer.orc.clock, "isoNow").mockReturnValue("2030-01-01T00:00:00.000Z");
    const get = f.stores.requests.get.bind(f.stores.requests);
    let settled: Awaited<ReturnType<typeof program.settle>>;
    // Pause recovery at its projection read; another store instance settles the run
    // before recovery receives its stale Request snapshot.
    vi.mocked(f.authority.onRunAdmitted).mockImplementationOnce(async () => {
      vi.spyOn(f.stores.requests, "get").mockImplementationOnce(async (id) => {
        const stale = await get(id);
        expect(stale?.status).toBe("decomposing");
        settled = await program.settle(terminal);
        return stale;
      });
    });
    expect(await f.service.reconcile(admitted.admissionId, f.authority)).toEqual(admitted);
    expect(settled).toMatchObject({ status, updatedAt: "2030-01-01T00:00:00.000Z" });
    const restarted = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
    expect(await restarted.stores.requests.get(admitted.requestId)).toEqual(settled);
    // Repeated recovery after settlement must leave the same document intact too.
    expect(await restarted.service.reconcile(admitted.admissionId, restarted.authority)).toEqual(admitted);
    expect(await fileStores(dir).requests.get(admitted.requestId)).toEqual(settled);
    expect(await restarted.orc.listRuns()).toEqual([admitted.runId]);
  },
);

it.each([true, false])("admits strict workflow inputs with sensitive inputs=%s", async (sensitiveInputs) => {
  const f = submissionFixture(undefined, undefined, { strictInputs: true, sensitiveInputs });
  const admitted = await f.service.submit({ ...command, vars: { token: "valid-token" } }, f.authority);
  expect(admitted.state).toBe("accepted");
  if (admitted.state !== "accepted") throw new Error("not accepted");
  const [created] = await f.orc.stores.events.read(admitted.runId);
  expect(created?.executionPayloadRef).toBeDefined();
  const original = await f.stores.execution.getPayload(admitted.runId, created!.executionPayloadRef!, "run.created");
  expect(original).toMatchObject({ requestAdmissionId: admitted.admissionId });
  expect((await f.stores.execution.getInputs(admitted.runId))?.vars).toEqual({
    token: "valid-token",
    request: expect.objectContaining({ id: admitted.requestId }),
    capturedGeneration: "fixture-generation-1",
  });
  expect((await f.service.reconcile(admitted.admissionId, f.authority)).state).toBe("accepted");
});

it.each([{ unexpected: "caller-value" }, { token: 42 }])(
  "still rejects invalid caller inputs before strict-schema admission: %j",
  async (vars) => {
    const f = submissionFixture(undefined, undefined, { strictInputs: true });
    await expect(f.service.submit({ ...command, vars }, f.authority)).rejects.toMatchObject({
      code: "WORKFLOW_INPUT_INVALID",
    });
    expect(await f.admissions.records.list()).toEqual([]);
    expect(await f.stores.requests.list()).toEqual([]);
    expect(await f.orc.listRuns()).toEqual([]);
  },
);

it.each(["before-root", "after-root"])(
  "recovers strict workflow inputs after %s crash and file-store restart",
  async (boundary) => {
    const dir = await mkdtemp(join(tmpdir(), "orca-strict-correlation-"));
    dirs.push(dir);
    const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir), { strictInputs: true });
    const start = f.orc.startRun.bind(f.orc);
    let rootId: string | undefined;
    vi.spyOn(f.orc, "startRun").mockImplementationOnce(async (options) => {
      if (boundary === "after-root") rootId = await start(options);
      throw new Error("crash at root publication");
    });
    const initial = await f.service.submit({ ...command, vars: { token: "secret-token" } }, f.authority);
    expect(initial.state).toBe("recoverable-failure");
    expect((await f.admissions.records.get(initial.admissionId))?.runId).toBeUndefined();
    const peer = submissionFixture(fileStores(dir), new FileAdmissionStore(dir), { strictInputs: true });
    const recovered = await peer.service.reconcile(initial.admissionId, peer.authority);
    expect(recovered.state).toBe("accepted");
    if (recovered.state !== "accepted") throw new Error("not accepted");
    if (rootId) expect(recovered.runId).toBe(rootId);
    expect(await peer.orc.listRuns()).toEqual([recovered.runId]);
    expect((await peer.stores.execution.getInputs(recovered.runId))?.vars).not.toHaveProperty(
      SUBMISSION_CORRELATION_VAR,
    );
  },
);

it("refuses providers without the protected correlation contract before admission side effects", async () => {
  const f = submissionFixture();
  const capture = f.capture;
  const service = new RequestSubmissionService({
    orchestrator: f.orc,
    admissions: f.admissions,
    captureLaunch: async (selection) => {
      const launch = await capture(selection);
      Reflect.deleteProperty(launch, "requestAdmissionCorrelation");
      return launch;
    },
  });
  await expect(service.submit(command, f.authority)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  expect(await f.admissions.records.list()).toEqual([]);
  expect(await f.stores.requests.list()).toEqual([]);
  expect(await f.orc.listRuns()).toEqual([]);
});

it("refuses an uncorrelated root returned by a broken provider without replacing it", async () => {
  const f = submissionFixture();
  const service = new RequestSubmissionService({
    orchestrator: f.orc,
    admissions: f.admissions,
    captureLaunch: async (selection) => {
      const launch = await f.capture(selection);
      return { ...launch, startRun: ({ requestAdmissionId: _id, ...options }) => launch.startRun(options) };
    },
  });
  const result = await service.submit(command, f.authority);
  expect(result.state).toBe("recoverable-failure");
  const roots = await f.orc.listRuns();
  expect(roots).toHaveLength(1);
  expect((await service.reconcile(result.admissionId, f.authority)).state).toBe("recoverable-failure");
  expect(await f.orc.listRuns()).toEqual(roots);
});

it.each(["public-tamper", "private-missing"])("authenticates root correlation during %s recovery", async (fault) => {
  const dir = await mkdtemp(join(tmpdir(), "orca-authenticated-correlation-"));
  dirs.push(dir);
  const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir), {
    strictInputs: true,
    sensitiveInputs: false,
  });
  const start = f.orc.startRun.bind(f.orc);
  let runId = "";
  vi.spyOn(f.orc, "startRun").mockImplementationOnce(async (options) => {
    runId = await start(options);
    throw new Error("crash after root publication");
  });
  const result = await f.service.submit(command, f.authority);
  const [created] = await f.orc.stores.events.read(runId);
  expect(created?.executionPayloadRef).toBeDefined();
  if (fault === "public-tamper") {
    const file = join(dir, "runs", `${runId}.jsonl`);
    const publicLog = await readFile(file, "utf8");
    await writeFile(file, publicLog.replace(result.admissionId, "forged-public-correlation"));
  } else {
    await rm(join(dir, "private-execution", `${created!.executionPayloadRef!}.payload.json`));
  }
  const peer = submissionFixture(fileStores(dir), new FileAdmissionStore(dir), {
    strictInputs: true,
    sensitiveInputs: false,
  });
  expect((await peer.service.reconcile(result.admissionId, peer.authority)).state).toBe(
    fault === "public-tamper" ? "accepted" : "recoverable-failure",
  );
  expect(await peer.orc.listRuns()).toEqual([runId]);
});

it("recovers an existing v1 admission from its protected legacy marker", async () => {
  const f = submissionFixture();
  const launch = await f.capture({ purpose: "request" });
  const request = RequestSchema.parse({
    id: "req_legacy",
    ...command,
    status: "decomposing",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  const record: Admission = {
    id: "admission_legacy",
    requestId: request.id,
    workspaceId: f.authority.workspaceId,
    principalId: f.authority.actor.principalId,
    workflowId: launch.workflow.id,
    workflowVersion: launch.workflow.version,
    workflowRevision: launch.workflow.revision,
    generationId: launch.generationId,
    createdAt: request.createdAt,
    state: "prepared",
    correlationVersion: 1,
  };
  // Exact prior format: sealed v1 binding, vars marker, neither root link persisted.
  await f.stores.execution.putInputs({
    runId: record.id,
    workflowId: record.workflowId,
    workflowVersion: record.workflowVersion,
    vars: { command, request, admission: record, actor: f.authority.actor },
    sensitiveNames: ["command", "request", "admission", "actor"],
    secrets: [],
  });
  await f.admissions.records.put(record);
  await f.stores.requests.put(request);
  const runId = await f.orc.startRun({
    workflowId: record.workflowId,
    requestId: request.id,
    actor: f.authority.actor,
    vars: { request, [SUBMISSION_CORRELATION_VAR]: record.id, token: record.id },
  });
  expect(await f.service.reconcile(record.id, f.authority)).toEqual({
    admissionId: record.id,
    requestId: request.id,
    runId,
    state: "accepted",
  });
  expect(await f.orc.listRuns()).toEqual([runId]);
});

it("admits fresh work without scanning an unrelated unreadable protected run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-unrelated-run-"));
  dirs.push(dir);
  const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir));
  const unrelated = await f.orc.startRun({ workflowId: "program", vars: { token: "unrelated-secret" } });
  const created = (await f.stores.events.readRange(unrelated, { limit: 1 }))[0]!;
  expect(created.executionPayloadRef).toBeDefined();
  await rm(join(dir, "private-execution", `${created.executionPayloadRef}.payload.json`));
  await expect(f.stores.events.readRange(unrelated, { limit: 1 })).rejects.toThrow();
  const scan = vi.spyOn(f.orc, "listRuns");
  const accepted = await f.service.submit(command, f.authority);
  expect(accepted.state).toBe("accepted");
  expect(scan).not.toHaveBeenCalled();
  // Known correlation recovery still checks its own authenticated root.
  expect(await f.service.reconcile(accepted.admissionId, f.authority)).toEqual(accepted);
});

it("filters admissions no longer in workflow scope but propagates current-authority failures", async () => {
  const f = submissionFixture();
  const accepted = await f.service.submit(command, f.authority);
  const record = (await f.admissions.records.get(accepted.admissionId))!;
  await f.admissions.records.put({ ...record, id: "hidden-admission", workflowId: "hidden" });
  vi.mocked(f.authority.authorize).mockImplementation(async (candidate) => {
    if (candidate.workflowId === "hidden") throw new OrcaError("WORKFLOW_NOT_FOUND", "unavailable");
  });
  expect(await f.service.list(f.authority)).toEqual([accepted]);
  vi.mocked(f.authority.authorize).mockImplementation(async (candidate) => {
    if (candidate.workflowId) throw new Error("authority unavailable");
  });
  await expect(f.service.list(f.authority)).rejects.toThrow("authority unavailable");
});
