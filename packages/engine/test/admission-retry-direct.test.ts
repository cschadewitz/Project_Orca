import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { LocalHost } from "@orca/agents";
import { GitWorktreeProvider } from "../src/workspace/git-worktree.js";
import { OrcaError } from "@orca/core";
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
async function fixture(failAt?: "inputs" | "created" | "ownership" | "publication", isolated = false) {
  const f = submissionFixture();
  const dir = await mkdtemp(join(tmpdir(), "orca-direct-"));
  dirs.push(dir);
  if (isolated) {
    execFileSync("git", ["init", "-q", "-b", "main"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    f.orc.workspaceProvider = new GitWorktreeProvider({
      host: new LocalHost({ id: "local", type: "local" }),
      repo: dir,
      worktreeRoot: join(dir, "trees"),
      isolateRoots: true,
      allowedRefs: ["refs/heads/*"],
    });
  }
  const faults = {
    conflict: () => new OrcaError("RUN_STATE", "conflict"),
    limit: () => new OrcaError("RUN_STATE", "limit"),
  };
  const store = new FileRetryClaimStore({ storeDir: dir, execution: new FileExecutionStore(dir), faults });
  const claims = new RegisteredRetryClaims(store, faults);
  let fail = true;
  if (failAt === "publication") {
    const append = f.stores.events.append.bind(f.stores.events);
    vi.spyOn(f.stores.events, "append").mockImplementation(async (event) => {
      if (event.type === "run.created") throw new Error("before publication");
      return append(event);
    });
  }
  await f.ready();
  const baseLaunch = await f.generations.captureLaunch({ purpose: "workflow", workflowId: "program" });
  if (failAt === "inputs") {
    const putInputs = f.stores.execution.putInputs.bind(f.stores.execution);
    vi.spyOn(f.stores.execution, "putInputs").mockImplementation(async (inputs) => {
      await putInputs(inputs);
      if (fail && inputs.runId.startsWith("run_")) {
        fail = false;
        throw new Error("crash");
      }
    });
  }
  const start = vi.fn<DirectCapturedLaunch["startRun"]>(async (options) => {
    const runId = await baseLaunch.startRun(options);
    if (fail && failAt === "created") {
      fail = false;
      throw new Error("crash");
    }
    return runId;
  });
  const launch: DirectCapturedLaunch = { ...baseLaunch, startRun: start };
  const capture = vi.fn(async () => launch),
    restore = vi.fn(async () => launch);
  const authority: DirectAdmissionAuthority = {
    workspaceId: f.authority.workspaceId,
    actor: f.authority.actor,
    authorize: async () => {},
    verifyRunAdmitted: (runId) => f.authority.verifyRunAdmitted!(runId),
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
  return { ...f, dir, claims, service, authority, start, capture, restore, scope };
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
  // Fresh validation and preparation each capture; accepted replay does neither.
  expect(f.capture).toHaveBeenCalledTimes(2);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it("isolated duplicate admissions retain one workspace and never repeat execution after acknowledgement loss", async () => {
  const f = await fixture(undefined, true);
  const command = {
    workflowId: "program",
    vars: { repo: "/untrusted", workspace: "/untrusted", branchPrefix: "untrusted/" },
  };
  const first = await f.service.admitRun(command, { idempotencyKey: "owned-root" }, f.authority);
  expect(first).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  const [runId] = await f.orc.listRuns();
  const workspace = (await f.orc.getState(runId!)).run.workspace;
  expect(workspace.cwd).toBe(join(f.dir, "trees", runId!));
  expect(workspace.branch).toBe(`orca/roots/${runId}`);
  const duplicate = await Promise.all(
    [1, 2].map(() => f.service.admitRun(command, { idempotencyKey: "owned-root" }, f.authority)),
  );
  expect(duplicate).toEqual([
    { ...first, replayed: true },
    { ...first, replayed: true },
  ]);
  await f.orc.run(runId!);
  await f.orc.run(runId!);
  expect((await f.orc.events(runId!)).filter((event) => event.type === "run.started")).toHaveLength(1);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(await f.stores.requests.list()).toEqual([]);
  expect(await f.stores.workItems.list()).toEqual([]);
});

it("keeps exact owned receipt and private-input guard after provisioning but before publication", async () => {
  const f = await fixture("publication", true);
  const first = await f.service.admitRun({ workflowId: "program" }, { idempotencyKey: "failed-root" }, f.authority);
  if (first.state !== "resolved" || first.result.state !== "recoverable-failure") throw new Error("expected failure");
  const runId = first.result.runId!;
  const receiptPath = join(f.dir, ".git", "orca-root-workspaces", `${runId}.json`); // rename-keep: persisted name kept on purpose
  const receipt = await readFile(receiptPath, "utf8");
  expect(JSON.parse(receipt)).toMatchObject({ runId, repo: f.dir, path: join(f.dir, "trees", runId) });
  expect(await f.stores.execution.getInputs(runId)).toBeDefined();
  const result = await f.service.withRetryAuthority(f.authority, () => f.claims.reconcile(first.operationId, f.scope));
  expect(result).toMatchObject({ operationId: first.operationId, result: { state: "recoverable-failure", runId } });
  expect(await readFile(receiptPath, "utf8")).toBe(receipt);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(await f.orc.listRuns()).toEqual([]);
});
it("reconciles original run after ownership interruption", async () => {
  const boundary = "ownership";
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

it("refuses a root whose creation acknowledgement was lost before policy publication", async () => {
  const f = await fixture("created");
  const first = await f.service.admitRun({ workflowId: "program" }, { idempotencyKey: "intent" }, f.authority);
  expect(first).toMatchObject({ state: "resolved", result: { state: "recoverable-failure" } });
  expect(
    await f.service.withRetryAuthority(f.authority, () => f.claims.reconcile(first.operationId, f.scope)),
  ).toMatchObject({
    operationId: first.operationId,
    state: "resolved",
    result: { state: "recoverable-failure" },
  });
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(await f.orc.listRuns()).toHaveLength(1);
});

it("records a stated origin on the admitted run, and a key replayed with another origin conflicts (#883)", async () => {
  const f = await fixture();
  const origin = {
    workspaceId: "8c1f2d3e-0a4b-4c5d-8e6f-7a8b9c0d1e2f",
    runId: "run_01JD0000000000000000000000",
    stepRunId: "step_01JD0000000000000000000000",
  };
  const first = await f.service.admitRun({ workflowId: "program", origin }, { idempotencyKey: "origin" }, f.authority);
  expect(first).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  const runId = (first as { result: { runId: string } }).result.runId;
  expect((await f.orc.getState(runId)).run.origin).toEqual(origin);
  // The same key and origin replay the admission; another origin is another command.
  await expect(
    f.service.admitRun({ workflowId: "program", origin }, { idempotencyKey: "origin" }, f.authority),
  ).resolves.toMatchObject({ replayed: true });
  await expect(
    f.service.admitRun(
      { workflowId: "program", origin: { ...origin, runId: "run_01JD0000000000000000000009" } },
      { idempotencyKey: "origin" },
      f.authority,
    ),
  ).rejects.toThrow("conflict");
  expect(await f.orc.listRuns()).toHaveLength(1);
  // Execution's first-attachment fence checks the origin the admission recorded.
  await f.orc.run(runId);
  const after = (await f.orc.getState(runId)).run;
  expect(after).toMatchObject({ status: "completed" });
});

it("refuses a named git ref the workspace cannot check out, before anything is admitted (#883)", async () => {
  const f = await fixture();
  await expect(
    f.service.admitRun({ workflowId: "program", gitRef: "refs/heads/feature" }, { idempotencyKey: "ref" }, f.authority),
  ).rejects.toMatchObject({ code: "NOT_SUPPORTED", details: { gitRef: "refs/heads/feature" } });
  expect(await f.orc.listRuns()).toEqual([]);
  expect(f.start).not.toHaveBeenCalled();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** An isolated-roots fixture whose `origin` has `refs/heads/feature`, and a way to move it. */
async function refFixture() {
  const f = await fixture(undefined, true);
  const upstream = join(f.dir, "..", `${f.dir.split("/").pop()}-upstream.git`);
  dirs.push(upstream);
  git(f.dir, "clone", "-q", "--bare", f.dir, upstream);
  git(upstream, "branch", "feature", "main");
  git(f.dir, "remote", "add", "origin", upstream);
  const original = git(upstream, "rev-parse", "feature");
  const moved = git(
    f.dir,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "moved",
  );
  git(f.dir, "push", "-q", "origin", `${moved}:refs/heads/moved-source`);
  const moveTo = (commit: string) => git(upstream, "update-ref", "refs/heads/feature", commit);
  const receipts = () => readdir(join(f.dir, ".git", "orca-root-workspaces")).catch(() => [] as string[]); // rename-keep: persisted name kept on purpose
  return { ...f, upstream, original, moved, moveTo, receipts };
}

it("admits a root run on its own checkout of a named git ref, and attaches it (#883)", async () => {
  const f = await fixture(undefined, true);
  const run = git;
  const upstream = join(f.dir, "..", `${f.dir.split("/").pop()}-upstream.git`);
  dirs.push(upstream);
  run(f.dir, "clone", "-q", "--bare", f.dir, upstream);
  run(upstream, "branch", "feature", "main");
  run(f.dir, "remote", "add", "origin", upstream);
  const admitted = await f.service.admitRun(
    { workflowId: "program", gitRef: "refs/heads/feature" },
    { idempotencyKey: "ref-ok" },
    f.authority,
  );
  expect(admitted).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  const runId = (admitted as { result: { runId: string } }).result.runId;
  const workspace = (await f.orc.getState(runId)).run.workspace;
  const head = run(upstream, "rev-parse", "feature");
  expect(workspace.rootProvisioning).toMatchObject({ runId, ref: "refs/heads/feature", refObject: head });
  expect(run(workspace.cwd, "rev-parse", "HEAD")).toBe(head);
  await f.orc.run(runId);
  const after = (await f.orc.getState(runId)).run;
  expect(after).toMatchObject({ status: "completed" });
});

it("refuses a run whose ref moved after runs.admit checked it, finally, never checking out the new commit (#883, #956)", async () => {
  const f = await refFixture();
  const provider = f.orc.workspaceProvider as GitWorktreeProvider;
  const checkRef = provider.checkRef.bind(provider);
  let checks = 0;
  vi.spyOn(provider, "checkRef").mockImplementation(async (ref) => {
    const object = await checkRef(ref);
    // The intake check and the reserved preparation's check pass; then the ref moves on the
    // remote before creation provisions it.
    if (++checks === 2) f.moveTo(f.moved);
    return object;
  });
  const admitted = await f.service.admitRun(
    { workflowId: "program", gitRef: "refs/heads/feature" },
    { idempotencyKey: "ref-moved" },
    f.authority,
  );
  // A distinct, final failure naming the ref (#956), not an incomplete admission to reconcile.
  const final = {
    state: "recoverable-failure",
    failure: { code: "GIT_REF_MOVED", message: expect.stringContaining("refs/heads/feature") },
  };
  expect(admitted).toMatchObject({ state: "resolved", result: final });
  // Creation was asked for exactly the object admission pinned, and refused the moved ref.
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls[0]![0]).toMatchObject({ gitRef: "refs/heads/feature", gitRefObject: f.original });
  expect(await f.orc.listRuns()).toEqual([]);
  expect(await f.receipts()).toEqual([]);
  // Reconciling answers the same refusal and creates nothing, even once the ref is back where
  // it was pinned: the reserved run is never created under this key.
  const reconcile = () =>
    f.service.withRetryAuthority(f.authority, () => f.claims.reconcile(admitted.operationId, f.scope));
  expect(await reconcile()).toMatchObject({ state: "resolved", result: final });
  f.moveTo(f.original);
  expect(await reconcile()).toMatchObject({ state: "resolved", result: final });
  expect(f.start).toHaveBeenCalledTimes(1);
  // Admitting again under the same key replays it too.
  expect(
    await f.service.admitRun(
      { workflowId: "program", gitRef: "refs/heads/feature" },
      { idempotencyKey: "ref-moved" },
      f.authority,
    ),
  ).toMatchObject({ state: "resolved", result: final });
  // Across a rollback to a worker that does not read the refusal (#956 review): the record is
  // the reserved run's private inputs, which every reserving version already treats as "never
  // create this run here". Its recovery answers only the reconcile failure ...
  const reserved = (admitted as { result: { runId: string } }).result.runId;
  const unaware = vi.spyOn(f.service as unknown as { refused(): Promise<unknown> }, "refused");
  unaware.mockResolvedValue(undefined);
  expect(await reconcile()).toMatchObject({
    state: "resolved",
    result: { state: "recoverable-failure", runId: reserved, failure: { code: "RUN_STATE" } },
  });
  unaware.mockRestore();
  expect(f.start).toHaveBeenCalledTimes(1);
  // ... and its creation of the reserved run, the one path that could make it, refuses.
  await expect(f.orc.startRun({ workflowId: "program", admissionRunId: reserved })).rejects.toMatchObject({
    code: "RUN_STATE",
  });
  expect(await f.orc.listRuns()).toEqual([]);
  // Back on this version, reconciling answers the final refusal again.
  expect(await reconcile()).toMatchObject({ state: "resolved", result: final });
  expect(await f.orc.listRuns()).toEqual([]);
  f.moveTo(f.moved);
  // A new admission checks again, and pins what the ref names now.
  const fresh = await f.service.admitRun(
    { workflowId: "program", gitRef: "refs/heads/feature" },
    { idempotencyKey: "ref-moved-again" },
    f.authority,
  );
  expect(fresh).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  const runId = (fresh as { result: { runId: string } }).result.runId;
  const workspace = (await f.orc.getState(runId)).run.workspace;
  expect(workspace.rootProvisioning).toMatchObject({ baseCommit: f.moved, refObject: f.moved });
});

it("refuses finally when the ref is found moved only when provisioning fetches it (#956)", async () => {
  const f = await refFixture();
  const provider = f.orc.workspaceProvider as GitWorktreeProvider;
  const checkRef = provider.checkRef.bind(provider);
  let checks = 0;
  vi.spyOn(provider, "checkRef").mockImplementation(async (ref) => {
    const object = await checkRef(ref);
    // Every check before creation passes, creation's own included; the ref moves on the remote
    // after that, so only the fetch while provisioning sees it.
    if (++checks === 3) f.moveTo(f.moved);
    return object;
  });
  const admitted = await f.service.admitRun(
    { workflowId: "program", gitRef: "refs/heads/feature" },
    { idempotencyKey: "ref-moved-at-fetch" },
    f.authority,
  );
  const final = {
    state: "recoverable-failure",
    failure: { code: "GIT_REF_MOVED", message: expect.stringContaining("after it was checked") },
  };
  expect(admitted).toMatchObject({ state: "resolved", result: final });
  expect(checks).toBe(3);
  const reserved = (admitted as { result: { runId: string } }).result.runId;
  // Creation got as far as the run's own private inputs record; no run was created.
  expect(await f.orc.stores.execution.getInputs(reserved)).toMatchObject({ runId: reserved, workflowId: "program" });
  expect(await f.orc.listRuns()).toEqual([]);
  expect(f.start).toHaveBeenCalledTimes(1);
  // Same-key reconciliation and replay answer the same final refusal, even with the ref back.
  const reconcile = () =>
    f.service.withRetryAuthority(f.authority, () => f.claims.reconcile(admitted.operationId, f.scope));
  expect(await reconcile()).toMatchObject({ state: "resolved", result: final });
  f.moveTo(f.original);
  expect(await reconcile()).toMatchObject({ state: "resolved", result: final });
  expect(
    await f.service.admitRun(
      { workflowId: "program", gitRef: "refs/heads/feature" },
      { idempotencyKey: "ref-moved-at-fetch" },
      f.authority,
    ),
  ).toMatchObject({ state: "resolved", result: final });
  expect(f.start).toHaveBeenCalledTimes(1);
  // A worker that does not read the refusal still never creates the run: the run's own inputs
  // record is the existing fence.
  const unaware = vi.spyOn(f.service as unknown as { refused(): Promise<unknown> }, "refused");
  unaware.mockResolvedValue(undefined);
  expect(await reconcile()).toMatchObject({
    state: "resolved",
    result: { state: "recoverable-failure", runId: reserved, failure: { code: "RUN_STATE" } },
  });
  unaware.mockRestore();
  await expect(f.orc.startRun({ workflowId: "program", admissionRunId: reserved })).rejects.toMatchObject({
    code: "RUN_STATE",
  });
  expect(await reconcile()).toMatchObject({ state: "resolved", result: final });
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(await f.orc.listRuns()).toEqual([]);
});

it("recovers an admission interrupted before its workspace receipt from the pinned ref object (#883)", async () => {
  const f = await refFixture();
  // Interrupted after the admission material is reserved, before creation provisions anything.
  f.start.mockImplementationOnce(async () => {
    throw new Error("crash");
  });
  const first = await f.service.admitRun(
    { workflowId: "program", gitRef: "refs/heads/feature" },
    { idempotencyKey: "ref-recover" },
    f.authority,
  );
  expect(first).toMatchObject({ state: "resolved", result: { state: "recoverable-failure" } });
  expect(await f.receipts()).toEqual([]);
  const reconcile = () =>
    f.service.withRetryAuthority(f.authority, () => f.claims.reconcile(first.operationId, f.scope));
  // Recovery admits exactly the pinned object while the ref still names it.
  expect(await reconcile()).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  expect(f.start.mock.calls.at(-1)![0]).toMatchObject({ gitRefObject: f.original });
  const [runId] = await f.orc.listRuns();
  const workspace = (await f.orc.getState(runId!)).run.workspace;
  expect(workspace.rootProvisioning).toMatchObject({
    ref: "refs/heads/feature",
    refObject: f.original,
    baseCommit: f.original,
  });
  expect(git(workspace.cwd, "rev-parse", "HEAD")).toBe(f.original);
  await f.orc.run(runId!);
  expect((await f.orc.getState(runId!)).run).toMatchObject({ status: "completed" });
});

it("reports a refusal it could not record as the reconcilable failure, and decides again on reconcile (#956)", async () => {
  const f = await refFixture();
  const provider = f.orc.workspaceProvider as GitWorktreeProvider;
  const checkRef = provider.checkRef.bind(provider);
  let checks = 0;
  vi.spyOn(provider, "checkRef").mockImplementation(async (ref) => {
    const object = await checkRef(ref);
    if (++checks === 2) f.moveTo(f.moved);
    return object;
  });
  // The refusal's record cannot be written this once.
  const { execution } = f.orc.stores;
  const put = execution.putInputs.bind(execution);
  let failNext = false;
  vi.spyOn(execution, "putInputs").mockImplementation(async (inputs) => {
    if (failNext || inputs.workflowId !== "orca:refused-admission") return put(inputs); // rename-keep: persisted name kept on purpose
    failNext = true;
    throw new OrcaError("RUN_STATE", "protected execution record or key could not be written safely");
  });
  const admitted = await f.service.admitRun(
    { workflowId: "program", gitRef: "refs/heads/feature" },
    { idempotencyKey: "ref-moved-unrecorded" },
    f.authority,
  );
  // Not final: nothing durable says so.
  expect(admitted).toMatchObject({
    state: "resolved",
    result: { state: "recoverable-failure", failure: { code: "RUN_STATE" } },
  });
  // The ref is still moved: reconciling refuses it again, records it, and that is final.
  const again = await f.service.withRetryAuthority(f.authority, () =>
    f.claims.reconcile(admitted.operationId, f.scope),
  );
  expect(again).toMatchObject({
    state: "resolved",
    result: { state: "recoverable-failure", failure: { code: "GIT_REF_MOVED" } },
  });
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(await f.orc.listRuns()).toEqual([]);
});

it("refuses finally when the ref moves before an interrupted admission is recovered (#956)", async () => {
  const f = await refFixture();
  f.start.mockImplementationOnce(async () => {
    throw new Error("crash");
  });
  const first = await f.service.admitRun(
    { workflowId: "program", gitRef: "refs/heads/feature" },
    { idempotencyKey: "ref-recover-moved" },
    f.authority,
  );
  // An interruption is not final: it is reconciled.
  expect(first).toMatchObject({
    state: "resolved",
    result: { state: "recoverable-failure", failure: { code: "RUN_STATE" } },
  });
  const reconcile = () =>
    f.service.withRetryAuthority(f.authority, () => f.claims.reconcile(first.operationId, f.scope));
  // The ref moves before recovery: recovery refuses the moved ref, and that is final.
  f.moveTo(f.moved);
  const final = { state: "recoverable-failure", failure: { code: "GIT_REF_MOVED" } };
  expect(await reconcile()).toMatchObject({ state: "resolved", result: final });
  expect(f.start.mock.calls.at(-1)![0]).toMatchObject({ gitRefObject: f.original });
  const calls = f.start.mock.calls.length;
  f.moveTo(f.original);
  expect(await reconcile()).toMatchObject({ state: "resolved", result: final });
  expect(f.start.mock.calls.length).toBe(calls);
  expect(await f.orc.listRuns()).toEqual([]);
  expect(await f.receipts()).toEqual([]);
});

it("refuses an origin that is not canonical ids before anything is claimed or admitted (#883)", async () => {
  const f = await fixture();
  for (const origin of [
    { workspaceId: "workspace", runId: "run_01JD0000000000000000000000" },
    { workspaceId: "8c1f2d3e-0a4b-4c5d-8e6f-7a8b9c0d1e2f", runId: "private-token-value" },
  ])
    await expect(
      f.service.admitRun({ workflowId: "program", origin }, { idempotencyKey: "bad-origin" }, f.authority),
    ).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
  expect(await f.orc.listRuns()).toEqual([]);
});
