/** Rotation can authorize a new interpreter, never revive an old tool callback. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRegistry, type AgentSession } from "@orca/agents";
import {
  AgentSpecSchema,
  parseOrcaConfig,
  TemplateRegistry,
  WorkflowRegistry,
  parseWorkflow,
  silentLogger,
  type MutationActor,
} from "@orca/core";
import {
  ConfigurationGenerations,
  RequestSubmissionService,
  MemoryAdmissionStore,
  FileAdmissionStore,
  LocalWorkspaceProvider,
  Orchestrator,
  PausingHumanInput,
  type ExecutionResumeAuthority,
  type LiveAnswerAuthority,
  type SessionFactory,
} from "@orca/engine";
import { fileStores, memoryStores, type Stores } from "@orca/store";
import { ControlModel, ReadModel, startDaemon } from "@orca/daemon";
import {
  Authorizer,
  CredentialStore,
  MemoryAuditSink,
  OwnershipStore,
  orchestratorResolver,
  type IssueOptions,
} from "../src/auth/index.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";
import { submissionAuthority } from "../src/request-submission.js";

const runtimes: ReturnType<typeof daemonExecutionRuntime>[] = [];
const jobs: Promise<unknown>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.allSettled(jobs.splice(0));
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function track<T>(job: Promise<T>): Promise<T> {
  jobs.push(job);
  void job.catch(() => undefined);
  return job;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  options: {
    disk?: boolean;
    secondGate?: boolean;
    initialAgent?: boolean;
    request?: boolean;
    rememberedOnly?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "orca-resume-authority-"));
  directories.push(directory);
  const tokenFile = join(directory, "token");
  const credentialFile = join(directory, "credentials.json");
  const ownerFile = join(directory, "ownership.json");
  const storeDir = join(directory, "store");
  const originalStores = options.disk ? fileStores(storeDir) : memoryStores();
  const originalCredentials = new CredentialStore(options.disk ? { file: credentialFile } : {});
  const originalOwnership = new OwnershipStore(options.disk ? ownerFile : undefined);
  const grants: IssueOptions = {
    principal: "alice",
    permissions: [
      "runs.read",
      "runs.start",
      "runs.control",
      "inputs.answer",
      ...(options.request ? ["plan.write" as const] : []),
    ],
    scope: options.request ? { workflows: "*", runs: "all" } : { workflows: ["visible"], runs: "owned" },
  };
  const original = await originalCredentials.bootstrap(grants, tokenFile);
  const originalToken = (await readFile(tokenFile, "utf8")).trim();
  const actor = { principalId: "alice", credentialId: original.credentialId };
  const answers: (string | undefined)[] = [];
  const sessions: AgentSession[] = [];
  const sessionFactory: SessionFactory = async (opts) => {
    const id = `session-${sessions.length + 1}`;
    const closed = deferred();
    const abort = new AbortController();
    const session: AgentSession = {
      id,
      agentId: opts.agent.id,
      hostId: opts.host.id,
      cwd: opts.cwd,
      acpSessionId: id,
      configOptions: [],
      closed: closed.promise,
      setConfigOption: async () => [],
      onUpdate: () => () => {},
      cancel: async () => {
        abort.abort();
      },
      close: async () => {
        abort.abort();
        closed.resolve();
      },
      prompt: async (_input, promptOptions) => {
        answers.push(
          await opts.askPermission!(
            {
              sessionId: id,
              toolCall: { toolCallId: "same-tool", title: "Execute once?", kind: "execute" },
              options: [
                { optionId: "allow", name: "Allow", kind: options.rememberedOnly ? "allow_always" : "allow_once" },
              ],
            },
            {
              sessionId: id,
              turnId: `${id}-turn`,
              invocationId: `${id}-invocation`,
              signal: AbortSignal.any([abort.signal, ...(promptOptions?.signal ? [promptOptions.signal] : [])]),
            },
          ),
        );
        return { stopReason: "end_turn", durationMs: 1 };
      },
    };
    sessions.push(session);
    return session;
  };
  const agents = AgentRegistry.fromConfig({
    hosts: [{ id: "local", type: "local" }],
    agents: [AgentSpecSchema.parse({ id: "worker", command: "unused", permissions: { default: "ask" } })],
    roles: {},
  });
  const workflows = new WorkflowRegistry()
    .register(
      parseWorkflow(`
id: visible
name: Visible
start: s
nodes:
  s: {type: start}
  ${options.initialAgent ? "oldWork: {type: agent, agent: worker, prompt: Old turn}" : ""}
  gate: {type: gate, question: Continue?, options: [go]}
  work: {type: agent, agent: worker, prompt: Fresh turn}
  ${options.secondGate ? "again: {type: gate, question: Continue again?, options: [go]}\n  more: {type: agent, agent: worker, prompt: Another turn}" : ""}
  end: {type: end}
edges:
  - {from: s, to: ${options.initialAgent ? "oldWork" : "gate"}}
  ${options.initialAgent ? "- {from: oldWork, to: gate}" : ""}
  - {from: gate, to: work}
  - {from: work, to: ${options.secondGate ? "again" : "end"}}
  ${options.secondGate ? "- {from: again, to: more}\n  - {from: more, to: end}" : ""}
`),
    )
    .register(
      parseWorkflow(`
id: private-child
name: Child
start: s
nodes:
  s: {type: start}
  gate: {type: gate, question: Child?, options: [go]}
  end: {type: end}
edges: [{from: s, to: gate}, {from: gate, to: end}]
`),
    );
  async function boot(instanceId: string, stores: Stores, credentials: CredentialStore, ownership: OwnershipStore) {
    const orchestrator = new Orchestrator({
      stores,
      agents,
      workflows,
      templates: new TemplateRegistry(),
      sessionFactory,
      workspaceProvider: new LocalWorkspaceProvider(directory),
      humanInput: new PausingHumanInput(),
      logger: silentLogger,
    });
    if (options.request) {
      const generations = new ConfigurationGenerations({
        store: stores.execution,
        workflows: stores.workflows,
        loadAssets: async () => ({ workflows: workflows.list(), templates: [] }),
        admission: {
          validateStartRun: (input, material) => orchestrator.validateStartRun(input, material),
          startRun: (input, material) => orchestrator.startRun(input, material),
        },
      });
      await generations.initialize(
        parseOrcaConfig({
          agents: [AgentSpecSchema.parse({ id: "worker", command: "unused", permissions: { default: "ask" } })],
          program: { workflow: "visible" },
        }),
        "fixture",
      );
      orchestrator.generations = generations;
    }
    const runtime = daemonExecutionRuntime({
      instanceId,
      workspaceId: "workspace",
      orchestrator,
      credentials,
      ownership,
      revalidateMs: 60_000,
    });
    runtimes.push(runtime);
    orchestrator.liveInput = runtime;
    orchestrator.admissionExecution = { authorize: (policy) => runtime.authorizeAdmissionExecution(policy) };
    const reads = new ReadModel({ orchestrator });
    return { orchestrator, runtime, reads, control: new ControlModel({ orchestrator, reads }) };
  }
  const first = await boot("boot-a", originalStores, originalCredentials, originalOwnership);
  let runId: string;
  if (options.request) {
    const generations = first.orchestrator.generations!;
    const submissions = new RequestSubmissionService({
      orchestrator: first.orchestrator,
      admissions: options.disk ? new FileAdmissionStore(storeDir) : new MemoryAdmissionStore(),
      captureLaunch: generations.captureLaunch,
      restoreLaunch: generations.restoreLaunch,
    });
    const authority = submissionAuthority({
      workspaceId: "workspace",
      actor,
      authorizer: new Authorizer({ ownership: originalOwnership, resolver: orchestratorResolver(first.orchestrator) }),
      principal: async () => {
        const current = originalCredentials.current(original.credentialId);
        if (!current.ok) throw new Error("fixture credential unavailable");
        return current.principal;
      },
    });
    const admitted = await submissions.submit({ title: "Task", body: "", workflowId: "visible" }, authority);
    if (admitted.state !== "accepted") throw new Error("fixture admission failed");
    runId = admitted.runId;
  } else {
    runId = await first.orchestrator.startRun({ workflowId: "visible", actor });
    originalOwnership.record(runId, "alice");
    await originalOwnership.flush(runId);
  }
  const initial = track(first.orchestrator.run(runId));
  const oldInput = options.initialAgent ? await permission(first, runId) : undefined;
  if (oldInput) first.runtime.close();
  expect((await initial).run.status).toBe("paused");
  const gate = (await first.orchestrator.pendingInputs(runId)).find((input) => input.kind === "decision")!;
  expect(gate).toBeDefined();
  first.runtime.close();
  const stores = options.disk ? fileStores(storeDir) : originalStores;
  const credentials = options.disk ? new CredentialStore({ file: credentialFile }) : originalCredentials;
  const ownership = options.disk ? new OwnershipStore(ownerFile) : originalOwnership;
  const rotated = await credentials.bootstrap(grants, tokenFile);
  const token = (await readFile(tokenFile, "utf8")).trim();
  const currentActor = { principalId: "alice", credentialId: rotated.credentialId };
  const second = await boot("boot-b", stores, credentials, ownership);
  return {
    ...second,
    first,
    stores,
    credentials,
    ownership,
    runId,
    gate,
    oldInput,
    actor,
    currentActor,
    token,
    originalToken,
    answers,
    sessions,
    grants,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function permission(f: { reads: ReadModel }, runId: string) {
  await vi.waitFor(async () =>
    expect((await f.reads.inputsList({ runId })).inputs.some((input) => input.live?.state === "pending")).toBe(true),
  );
  return (await f.reads.inputsList({ runId })).inputs.find((input) => input.live?.state === "pending")!;
}
function resumeAuthority(f: Fixture, actor: MutationActor = f.currentActor) {
  return { actor, authorize: vi.fn(async () => {}) } satisfies ExecutionResumeAuthority;
}
async function recordGate(f: Fixture) {
  return f.control.answerInput({ runId: f.runId, requestId: f.gate.id, optionId: "go", resume: false }, f.currentActor);
}
async function answerPermission(
  f: Fixture,
  input: Awaited<ReturnType<typeof permission>>,
  actor: MutationActor = f.currentActor,
) {
  const authority: LiveAnswerAuthority = { actor, authorize: async () => {} };
  return f.control.answerInput(
    { runId: f.runId, requestId: input.id, optionId: "allow", live: input.live!.target, resume: true },
    authority.actor,
    authority,
  );
}

it.each([false, true])(
  "requires explicit rotation attachment after a reconstructed runtime (file stores=%s)",
  async (disk) => {
    const f = await fixture({ disk, secondGate: true });
    expect(f.credentials.current(f.actor.credentialId).ok).toBe(false);
    expect(f.credentials.current(f.currentActor.credentialId).ok).toBe(true);
    await expect(
      f.control.answerInput({ runId: f.runId, requestId: f.gate.id, optionId: "go", resume: true }, f.currentActor),
    ).rejects.toMatchObject({
      code: "RUN_STATE",
      details: { answerRecorded: true, executionResumeRequired: true },
    });
    expect(f.sessions).toHaveLength(0);
    expect((await f.orchestrator.getState(f.runId)).run.status).toBe("paused");
    expect((await f.orchestrator.events(f.runId)).filter((event) => event.type === "human.answered")).toMatchObject([
      { payload: { actor: f.currentActor, answer: "go" } },
    ]);
    const authority = resumeAuthority(f);
    const resumed = track(f.control.resumeRun({ runId: f.runId }, authority));
    const fresh = await permission(f, f.runId);
    expect(fresh.live!.target.instanceId).toBe("boot-b");
    expect(f.sessions).toHaveLength(1);
    expect(f.answers).toEqual([]);
    await answerPermission(f, fresh);
    expect((await resumed).run.status).toBe("waiting");
    expect(authority.authorize).toHaveBeenCalledTimes(2);
    const again = (await f.orchestrator.pendingInputs(f.runId)).find((input) => input.kind === "decision")!;
    const continued = track(
      f.control.answerInput({ runId: f.runId, requestId: again.id, optionId: "go", resume: true }, f.currentActor),
    );
    const next = await permission(f, f.runId);
    expect(next.live!.target.sessionId).not.toBe(fresh.live!.target.sessionId);
    await expect(answerPermission(f, fresh)).rejects.toMatchObject({ code: "RUN_STATE" });
    await answerPermission(f, next);
    await continued;
    expect((await f.orchestrator.getState(f.runId)).run.status).toBe("completed");
    expect(f.answers).toEqual(["allow", "allow"]);
    expect(authority.authorize).toHaveBeenCalledTimes(3);
    expect(await f.orchestrator.listLeases()).toEqual([]);
    const events = await f.orchestrator.events(f.runId);
    expect(events[0]).toMatchObject({ payload: { actor: f.actor } });
    expect(events.filter((event) => event.type === "run.cancelled")).toEqual([]);
    const log = JSON.stringify(events);
    expect(log).not.toContain(f.originalToken);
    expect(log).not.toContain(f.token);
    expect(log).not.toContain("orca1.");
  },
);

it("never revives a real old-boot permission callback when attaching a fresh interpreter", async () => {
  const f = await fixture({ disk: true, initialAgent: true });
  expect(f.answers).toEqual([undefined]);
  expect(f.first.runtime.port.inspect(f.oldInput!.live!.target)).toBe("expired");
  await recordGate(f);
  const resumed = track(f.control.resumeRun({ runId: f.runId }, resumeAuthority(f)));
  const fresh = await permission(f, f.runId);
  expect(fresh.live!.target.sessionId).not.toBe(f.oldInput!.live!.target.sessionId);
  await expect(answerPermission(f, f.oldInput!)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.runtime.port.inspect(fresh.live!.target)).toBe("pending");
  await answerPermission(f, fresh);
  await resumed;
  expect(f.answers).toEqual([undefined, "allow"]);
  expect(
    (await f.orchestrator.events(f.runId)).filter(
      (event) => event.type === "human.answered" && event.payload.requestId === f.oldInput!.id,
    ),
  ).toEqual([]);
});

it.each([
  ["different principal", { principal: "bob" }],
  ["missing start", { permissions: ["runs.read", "runs.control"] }],
  ["missing control", { permissions: ["runs.read", "runs.start"] }],
  ["wrong workflow scope", { scope: { workflows: ["other"], runs: "owned" } }],
] satisfies [string, Partial<IssueOptions>][])("rejects explicit attachment with %s", async (_reason, changes) => {
  const f = await fixture();
  await recordGate(f);
  const issued = await f.credentials.issue({ ...f.grants, ...changes });
  const authority = resumeAuthority(f, {
    principalId: issued.credential.principal,
    credentialId: issued.credential.id,
  });
  const before = await f.orchestrator.events(f.runId);
  await expect(f.control.resumeRun({ runId: f.runId }, authority)).rejects.toMatchObject({
    code: "RUN_STATE",
    details: { executionResumeRequired: true },
  });
  expect(f.sessions).toHaveLength(0);
  expect(await f.orchestrator.events(f.runId)).toEqual(before);
  expect(await f.orchestrator.listLeases()).toEqual([]);
  await expect(f.control.resumeRun({ runId: f.runId })).rejects.toMatchObject({
    details: { executionResumeRequired: true },
  });
  const replacement = await f.credentials.issue(f.grants);
  const replacementActor = { principalId: "alice", credentialId: replacement.credential.id };
  const retried = track(f.control.resumeRun({ runId: f.runId }, resumeAuthority(f, replacementActor)));
  await answerPermission(f, await permission(f, f.runId), replacementActor);
  expect((await retried).run.status).toBe("succeeded");
  expect(f.answers).toEqual(["allow"]);
});

it("requires plan.write again for a sealed Request-admitted origin", async () => {
  const f = await fixture({ request: true });
  await recordGate(f);
  const issued = await f.credentials.issue({ ...f.grants, permissions: ["runs.read", "runs.start", "runs.control"] });
  await expect(
    f.control.resumeRun(
      { runId: f.runId },
      resumeAuthority(f, { principalId: "alice", credentialId: issued.credential.id }),
    ),
  ).rejects.toMatchObject({ details: { executionResumeRequired: true } });
  expect(f.sessions).toHaveLength(0);
});

it.each(["authorization", "owner lease"])(
  "rechecks revocation after awaiting %s and discards failed attachment",
  async (barrier) => {
    const f = await fixture();
    await recordGate(f);
    const entered = deferred();
    const release = deferred();
    const authority = resumeAuthority(f);
    if (barrier === "authorization") {
      authority.authorize = vi.fn(async () => {
        entered.resolve();
        await release.promise;
      });
    } else {
      const acquire = f.stores.leases.acquire.bind(f.stores.leases);
      vi.spyOn(f.stores.leases, "acquire").mockImplementationOnce(async (request) => {
        entered.resolve();
        await release.promise;
        return acquire(request);
      });
    }
    const before = await f.orchestrator.events(f.runId);
    const resumed = track(f.control.resumeRun({ runId: f.runId }, authority));
    await entered.promise;
    await f.credentials.revoke(f.currentActor.credentialId);
    release.resolve();
    await expect(resumed).rejects.toMatchObject({ code: "RUN_STATE", details: { executionResumeRequired: true } });
    expect(f.sessions).toHaveLength(0);
    expect(await f.orchestrator.events(f.runId)).toEqual(before);
    expect(await f.orchestrator.listLeases()).toEqual([]);
    await expect(f.control.resumeRun({ runId: f.runId })).rejects.toMatchObject({
      details: { executionResumeRequired: true },
    });
    const replacement = await f.credentials.issue(f.grants);
    const replacementActor = { principalId: "alice", credentialId: replacement.credential.id };
    const retried = track(f.control.resumeRun({ runId: f.runId }, resumeAuthority(f, replacementActor)));
    await answerPermission(f, await permission(f, f.runId), replacementActor);
    expect((await retried).run.status).toBe("succeeded");
    expect(f.answers).toEqual(["allow"]);
  },
);

it("refuses an authority handoff while an old interpreter is still attached", async () => {
  const f = await fixture();
  await recordGate(f);
  const resumed = track(f.control.resumeRun({ runId: f.runId }, resumeAuthority(f)));
  const input = await permission(f, f.runId);
  const replacement = await f.credentials.rotate(f.currentActor.credentialId);
  const authority = resumeAuthority(f, { principalId: "alice", credentialId: replacement.credential.id });
  await expect(f.control.resumeRun({ runId: f.runId }, authority)).rejects.toMatchObject({
    code: "RUN_LEASED_ELSEWHERE",
  });
  expect(authority.authorize).not.toHaveBeenCalled();
  expect(f.sessions).toHaveLength(1);
  expect(f.runtime.executionSignal(f.runId).aborted).toBe(true);
  await resumed;
  expect(f.answers).toEqual([undefined]);
  await expect(answerPermission(f, input)).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("authorizes sealed root lineage when explicitly attaching a child", async () => {
  const f = await fixture();
  const child = await f.orchestrator.startRun({
    workflowId: "private-child",
    parentRunId: f.runId,
    parentStepRunId: "spawn",
    actor: { principalId: "substituted", credentialId: "unknown" },
  });
  const grandchild = await f.orchestrator.startRun({
    workflowId: "private-child",
    parentRunId: child,
    parentStepRunId: "spawn-again",
  });
  expect(f.ownership.owner(child)).toBeUndefined();
  const authority = resumeAuthority(f);
  expect((await f.control.resumeRun({ runId: grandchild }, authority)).run.status).toBe("waiting");
  expect(authority.authorize).toHaveBeenCalledWith({
    rootId: f.runId,
    workflowId: "visible",
    request: false,
    actor: f.actor,
  });
  expect(authority.authorize).toHaveBeenCalledTimes(2);
  const gate = (await f.orchestrator.pendingInputs(grandchild))[0]!;
  // Resume the child only here: ancestor continuation is a separate interpreter action.
  await f.control.answerInput({ runId: grandchild, requestId: gate.id, optionId: "go", resume: false }, f.currentActor);
  expect((await f.control.resumeRun({ runId: grandchild })).run.status).toBe("succeeded");
  expect(authority.authorize).toHaveBeenCalledTimes(3);
  expect((await f.orchestrator.events(grandchild))[0]).toMatchObject({ payload: { parentRunId: child } });
});

it("runs guarded HTTP resume with current launch authority, audits identity, and accepts only the fresh callback", async () => {
  const f = await fixture({ disk: true });
  const audit = new MemoryAuditSink();
  const daemon = await startDaemon({
    orcaVersion: "test",
    capabilities: ["runs.read", "runs.control", "runs.subscribe"],
    reads: f.reads,
    control: f.control,
    source: f.orchestrator,
    auth: {
      mode: "token",
      credentials: f.credentials,
      ownership: f.ownership,
      resolver: orchestratorResolver(f.orchestrator),
      audit,
    },
  });
  const rpc = async (token: string, method: string, params: unknown) => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as { ok: boolean; error?: { code: string; details?: unknown }; result?: unknown };
  };
  try {
    expect(
      await rpc(f.token, "inputs.answer", { runId: f.runId, requestId: f.gate.id, optionId: "go", resume: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "RUN_STATE", details: { answerRecorded: true, executionResumeRequired: true } },
    });
    expect(f.sessions).toHaveLength(0);
    expect(await rpc(f.originalToken, "runs.resume", { runId: f.runId })).toMatchObject({
      ok: false,
      error: { code: "AUTH_INVALID" },
    });
    const controlOnly = await f.credentials.issue({ ...f.grants, permissions: ["runs.read", "runs.control"] });
    expect(await rpc(controlOnly.token, "runs.resume", { runId: f.runId })).toMatchObject({
      ok: false,
      error: { code: "AUTH_FORBIDDEN" },
    });
    const startOnly = await f.credentials.issue({ ...f.grants, permissions: ["runs.read", "runs.start"] });
    expect(await rpc(startOnly.token, "runs.resume", { runId: f.runId })).toMatchObject({
      ok: false,
      error: { code: "AUTH_FORBIDDEN" },
    });
    const outOfScope = await f.credentials.issue({ ...f.grants, scope: { workflows: ["other"], runs: "owned" } });
    expect(await rpc(outOfScope.token, "runs.resume", { runId: f.runId })).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_FOUND" },
    });
    const differentPrincipal = await f.credentials.issue({ principal: "bob", preset: "owner" });
    expect(await rpc(differentPrincipal.token, "runs.resume", { runId: f.runId })).toMatchObject({
      ok: false,
      error: { code: "RUN_STATE", details: { executionResumeRequired: true } },
    });
    expect(f.sessions).toHaveLength(0);
    const resumed = track(rpc(f.token, "runs.resume", { runId: f.runId }));
    const input = await permission(f, f.runId);
    expect(
      await rpc(f.token, "inputs.answer", {
        runId: f.runId,
        requestId: input.id,
        optionId: "allow",
        live: input.live!.target,
        resume: true,
      }),
    ).toMatchObject({ ok: true });
    expect(await resumed).toMatchObject({ ok: true, result: { run: { status: "succeeded" } } });
    expect(f.answers).toEqual(["allow"]);
    expect(audit.records).toContainEqual(
      expect.objectContaining({
        operation: "runs.resume",
        outcome: "succeeded",
        actor: { principal: "alice", kind: "credential", credential: f.currentActor.credentialId },
      }),
    );
    const log = JSON.stringify({ events: await f.orchestrator.events(f.runId), audit: audit.records });
    for (const token of [
      f.token,
      f.originalToken,
      controlOnly.token,
      startOnly.token,
      outOfScope.token,
      differentPrincipal.token,
    ])
      expect(log).not.toContain(token);
    expect(log).not.toContain("orca1.");
  } finally {
    f.runtime.close();
    await Promise.allSettled(jobs);
    await daemon.close();
  }
});

it("keeps the recorded-answer recovery hint when renewed authority is revoked during the next resume lease", async () => {
  const f = await fixture({ secondGate: true });
  const daemon = await startDaemon({
    orcaVersion: "test",
    capabilities: ["runs.read", "runs.control"],
    reads: f.reads,
    control: f.control,
    source: f.orchestrator,
    auth: {
      mode: "token",
      credentials: f.credentials,
      ownership: f.ownership,
      resolver: orchestratorResolver(f.orchestrator),
    },
  });
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as { ok: boolean; error?: { code: string; details?: unknown } };
  };
  const release = deferred();
  try {
    await recordGate(f);
    const resumed = track(rpc("runs.resume", { runId: f.runId }));
    await answerPermission(f, await permission(f, f.runId));
    expect(await resumed).toMatchObject({ ok: true });
    const again = (await f.orchestrator.pendingInputs(f.runId)).find((input) => input.kind === "decision")!;
    const entered = deferred();
    const acquire = f.stores.leases.acquire.bind(f.stores.leases);
    let acquisitions = 0;
    vi.spyOn(f.stores.leases, "acquire").mockImplementation(async (request) => {
      if (++acquisitions === 2) {
        entered.resolve();
        await release.promise;
      }
      return acquire(request);
    });
    const answered = track(rpc("inputs.answer", { runId: f.runId, requestId: again.id, optionId: "go", resume: true }));
    await entered.promise;
    await f.credentials.revoke(f.currentActor.credentialId);
    release.resolve();
    expect(await answered).toMatchObject({
      ok: false,
      error: { code: "RUN_STATE", details: { answerRecorded: true, executionResumeRequired: true } },
    });
    expect(f.sessions).toHaveLength(1);
    expect((await f.orchestrator.getState(f.runId)).run.status).toBe("paused");
    expect(
      (await f.orchestrator.events(f.runId)).filter(
        (event) => event.type === "human.answered" && event.payload.requestId === again.id,
      ),
    ).toHaveLength(1);
    expect(await f.orchestrator.listLeases()).toEqual([]);
  } finally {
    release.resolve();
    f.runtime.close();
    await Promise.allSettled(jobs);
    await daemon.close();
  }
});

it("cancels remembered-only agent permission options without publishing an unanswerable live card", async () => {
  const f = await fixture({ rememberedOnly: true });
  await recordGate(f);
  await f.control.resumeRun({ runId: f.runId }, resumeAuthority(f));
  expect(f.sessions).toHaveLength(1);
  expect(f.answers).toEqual([undefined]);
  expect(
    (await f.orchestrator.events(f.runId)).filter(
      (event) => event.type === "human.requested" && event.payload.kind === "permission",
    ),
  ).toEqual([]);
});
