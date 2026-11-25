/** Real scoped admission, captured providers, leases and continuation receipts over disposable Git. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSession, OpenSessionOptions } from "@orca/agents";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { PausingHumanInput, readAdmissionExecutionStatus } from "@orca/engine";
import { executionEvents } from "@orca/store";
import { bootstrap } from "../../cli/src/bootstrap.js";
import { FileContinuationLocatorStore } from "../../store/src/continuation-admission-store.js";
import { directAdmissionAuthority } from "../src/admission-retry.js";
import { Authorizer, CredentialStore, OwnershipStore, orchestratorResolver } from "../src/auth/index.js";
import { ContinuationAdmissionModel } from "../src/continuation-admission.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-owned-attachment-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base");
  await writeFile(
    join(dir, "owned.yaml"),
    `
id: owned
name: Owned
start: start
nodes:
  start: {type: start}
  gate: {type: gate, question: Go?, options: [go]}
  work: {type: agent, agent: local-agent, prompt: go}
  end: {type: end}
edges:
  - {from: start, to: gate}
  - {from: gate, to: work}
  - {from: work, to: end}
`,
  );
  const app = await bootstrap({
    configDir: dir,
    config: parseOrcaConfig({
      storeDir: "store",
      workflows: ["*.yaml"],
      templates: [],
      agents: [{ id: "local-agent", command: "unused" }],
      workspace: { provider: "git-worktree", repo: "repo", worktreeRoot: "trees", isolateRoots: true },
    }),
    logger: silentLogger,
    humanInput: new PausingHumanInput(),
  });
  const orc = app.orchestrator;
  const spawn = vi.fn(async (opts: OpenSessionOptions): Promise<AgentSession> => ({
    id: "session",
    agentId: opts.agent.id,
    hostId: opts.host.id,
    cwd: opts.cwd,
    acpSessionId: "acp",
    closed: new Promise(() => {}),
    configOptions: [],
    setConfigOption: async () => [],
    prompt: async () => ({ stopReason: "end_turn", durationMs: 1 }),
    onUpdate: () => () => {},
    cancel: async () => {},
    close: async () => {},
  }));
  orc.sessionFactory = spawn;
  const credentials = new CredentialStore({ file: join(dir, "credentials.json") });
  const issued = await credentials.issue({
    principal: "alice",
    permissions: ["runs.read", "artifacts.read", "workflows.read", "runs.start", "runs.control", "inputs.answer"],
    scope: { workflows: ["owned"], runs: "owned" },
  });
  const current = async () => {
    const result = credentials.current(issued.credential.id);
    if (!result.ok) throw new Error("fixture credential unavailable");
    return result.principal;
  };
  const ownership = new OwnershipStore(join(dir, "ownership.json"));
  const authorizer = new Authorizer({ ownership, resolver: orchestratorResolver(orc) });
  const workspaceId = "owned-workspace";
  const actor = { principalId: "alice", credentialId: issued.credential.id };
  const authority = directAdmissionAuthority({ workspaceId, actor, principal: current, authorizer });
  const runtime = daemonExecutionRuntime({
    instanceId: "test",
    workspaceId,
    orchestrator: orc,
    credentials,
    ownership,
  });
  cleanups.push(async () => runtime.close());
  orc.liveInput = runtime;
  orc.admissionExecution = { authorize: (policy) => runtime.authorizeAdmissionExecution(policy) };
  const admitted = await app.directAdmissions!.admitRun({ workflowId: "owned" }, { idempotencyKey: "root" }, authority);
  if (admitted.state !== "resolved" || admitted.result.state !== "accepted") throw new Error("not admitted");
  const runId = admitted.result.runId;
  // Observe the real mutation fence, not just the existence of a lease file.
  let inFence = false;
  const withOwnership = orc.stores.leases.withOwnership.bind(orc.stores.leases);
  vi.spyOn(orc.stores.leases, "withOwnership").mockImplementation((lease, operation) =>
    withOwnership(lease, async () => {
      inFence = true;
      try {
        return await operation();
      } finally {
        inFence = false;
      }
    }),
  );
  const makeProvider = orc.generationWorkspaceProvider!;
  orc.generationWorkspaceProvider = (generation) => {
    const provider = makeProvider(generation);
    const validate = provider.validate!.bind(provider);
    provider.validate = async (workspace) => {
      expect(inFence).toBe(true);
      expect(await orc.stores.leases.get(`run:${runId}`)).toBeDefined();
      await validate(workspace);
    };
    return provider;
  };
  const workspace = (await orc.getState(runId)).run.workspace;
  const receiptPath = join(repo, ".git", "orca-root-workspaces", `${runId}.json`); // rename-keep: persisted name kept on purpose
  const receipt = await readFile(receiptPath, "utf8");
  await writeFile(join(workspace.cwd, "partial"), "keep work");
  const access = { current, workspaceId, authorizer };
  const model = new ContinuationAdmissionModel({
    claims: app.retryClaims!,
    orchestrator: orc,
    executionRuntime: runtime,
    locators: new FileContinuationLocatorStore({
      storeDir: join(dir, "store"),
      execution: orc.stores.execution,
      retries: app.retryClaimStore!,
    }),
    schedule: () => {},
  });
  cleanups.push(() => model.drain());
  const retained = async () => {
    expect(await readFile(receiptPath, "utf8")).toBe(receipt);
    expect(await readFile(join(workspace.cwd, "partial"), "utf8")).toBe("keep work");
    expect(await orc.stores.leases.get(`run:${runId}`)).toBeUndefined();
    expect(await orc.listRuns()).toEqual([runId]);
  };
  return { app, orc, runId, workspace, spawn, model, access, retained, authority };
}

async function changeRegistration(cwd: string, kind: "branch" | "registration") {
  if (kind === "branch") {
    const original = git(cwd, "branch", "--show-current");
    git(cwd, "checkout", "-qb", "changed");
    return async () => {
      git(cwd, "checkout", original);
    };
  }
  const path = join(git(cwd, "rev-parse", "--absolute-git-dir"), "gitdir");
  const original = await readFile(path, "utf8");
  await writeFile(path, join(cwd, "missing", ".git"));
  return () => writeFile(path, original);
}

it.each(["branch", "registration"] as const)(
  "refuses admitted root with changed %s before consuming first-start evidence",
  async (kind) => {
    const f = await fixture();
    const restore = await changeRegistration(f.workspace.cwd, kind);
    const before = await f.orc.events(f.runId);
    const put = vi.spyOn(f.orc.stores.execution, "putGeneration");
    await expect(f.orc.run(f.runId)).rejects.toThrow();
    expect(await f.orc.events(f.runId)).toEqual(before);
    expect((await f.orc.getState(f.runId)).run.status).toBe("created");
    expect(await readAdmissionExecutionStatus(f.orc.stores, f.runId)).toMatchObject({ state: "ready" });
    expect(
      put.mock.calls.some(
        ([key]) => key.startsWith("admission-execution-attempt:") || key.startsWith("admission-execution-start:"),
      ),
    ).toBe(false);
    expect(f.spawn).not.toHaveBeenCalled();
    await f.retained();
    await restore();
    expect((await f.orc.run(f.runId)).run.status).toBe("paused");
    expect((await f.orc.events(f.runId)).filter((event) => event.type === "run.started")).toHaveLength(1);
    // A consumed successful start still cannot be retried as ordinary first execution.
    await expect(f.orc.run(f.runId)).rejects.toMatchObject({ code: "RUN_STATE" });
    await f.retained();
  },
);

it.each(["branch", "registration"] as const)(
  "blocks paused owned continuation with changed %s before attachment, then reconciles the same intent",
  async (kind) => {
    const f = await fixture();
    expect((await f.orc.run(f.runId)).run.status).toBe("paused");
    const expectedBoundary = (await f.model.expectedBoundary(f.runId, f.access))!;
    const input = (await f.orc.pendingInputs(f.runId))[0]!;
    const admitted = await f.model.admit(
      { runId: f.runId, expectedBoundary, decision: { requestId: input.id, optionId: "go" } },
      { idempotencyKey: "continue" },
      f.access,
    );
    if (admitted.state !== "resolved") throw new Error("not resolved");
    const id = admitted.result.continuationId;
    const restore = await changeRegistration(f.workspace.cwd, kind);
    const attach = vi.spyOn(f.orc, "attachContinuation");
    expect(await f.model.reconcile(id, f.access)).toMatchObject({ state: "blocked", continuationId: id });
    await f.model.drain();
    expect(attach).toHaveBeenCalledTimes(1);
    await expect(attach.mock.results[0]!.value).rejects.toThrow();
    const events = await executionEvents(await f.orc.events(f.runId), f.orc.stores.execution);
    const entries = events.filter((event) => event.type === "continuation.recorded");
    expect(entries.map((event) => event.payload.entry?.dispatch)).toEqual(["needed", "needed"]);
    expect(entries.filter((event) => event.payload.decision)).toHaveLength(1);
    expect(events.some((event) => event.type === "run.resumed")).toBe(false);
    expect((await f.orc.getState(f.runId)).run.status).toBe("paused");
    expect(f.spawn).not.toHaveBeenCalled();
    await f.retained();
    await restore();
    expect(await f.model.reconcile(id, f.access)).toMatchObject({ state: "accepted", continuationId: id });
    await f.model.drain();
    expect(await f.model.inspect(id, f.access)).toMatchObject({ state: "settled", continuationId: id });
    expect((await f.orc.getState(f.runId)).run.status).toBe("completed");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    await f.retained();
  },
);
