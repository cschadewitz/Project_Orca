import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  const receiptPath = join(f.dir, ".git", "orca-root-workspaces", `${runId}.json`);
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
    f.service.admitRun({ workflowId: "program", gitRef: "feature" }, { idempotencyKey: "ref" }, f.authority),
  ).rejects.toMatchObject({ code: "NOT_SUPPORTED", details: { gitRef: "feature" } });
  expect(await f.orc.listRuns()).toEqual([]);
  expect(f.start).not.toHaveBeenCalled();
});

it("admits a root run on its own checkout of a named git ref, and attaches it (#883)", async () => {
  const f = await fixture(undefined, true);
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const upstream = join(f.dir, "..", `${f.dir.split("/").pop()}-upstream.git`);
  dirs.push(upstream);
  run(f.dir, "clone", "-q", "--bare", f.dir, upstream);
  run(upstream, "branch", "feature", "main");
  run(f.dir, "remote", "add", "origin", upstream);
  const admitted = await f.service.admitRun(
    { workflowId: "program", gitRef: "feature" },
    { idempotencyKey: "ref-ok" },
    f.authority,
  );
  expect(admitted).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  const runId = (admitted as { result: { runId: string } }).result.runId;
  const workspace = (await f.orc.getState(runId)).run.workspace;
  expect(workspace.rootProvisioning).toMatchObject({ runId, ref: "feature" });
  expect(run(workspace.cwd, "rev-parse", "HEAD")).toBe(run(upstream, "rev-parse", "feature"));
  await f.orc.run(runId);
  const after = (await f.orc.getState(runId)).run;
  expect(after).toMatchObject({ status: "completed" });
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
