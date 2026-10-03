/** Production revision sources cross real authenticated transports without exposing protected journal fields. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  OrcaError,
  parseWorkflow,
  reduceRun,
  silentLogger,
  systemClock,
  TemplateRegistry,
  WorkflowRegistry,
} from "@orca/core";
import {
  createRevisionInputServices,
  createRevisionRuntime,
  Orchestrator,
  workflowRevision,
  type RevisionBoundary,
} from "@orca/engine";
import { executionEvents, fileStores } from "@orca/store";
import {
  HelloResultSchema,
  InputsListResultSchema,
  InputsListParamsSchema,
  PendingRevisionViewSchema,
  OperatorDiscoverySchema,
  PendingRevisionsDiscoverySchema,
  PROTOCOL_VERSION,
  RevisionResultSchema,
  type ResponseMessage,
} from "@orca/protocol";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { RunContext } from "../../engine/src/run-context.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { CredentialStore, OwnershipStore, orchestratorResolver, type Permission } from "../src/auth/index.js";
import { ControlModel } from "../src/control.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";
import { ReadModel } from "../src/read-model.js";
import { startDaemon, type DaemonOptions } from "../src/server.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const required: Permission[] = ["runs.read", "inputs.answer", "runs.control"];
const revisionMethods = ["inputs.revise", "inputs.revisionPending", "inputs.replaceRevision"] as const;
const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "limit"),
};
function result(response: ResponseMessage): unknown {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.result;
}
function resolved(response: ResponseMessage) {
  const value = RevisionResultSchema.parse(result(response));
  expect(value.state).toBe("resolved");
  if (value.state !== "resolved") throw new Error("revision unresolved");
  return value;
}
async function fixture(mode: "enabled" | "missing" | "read-only" | "loopback" | "no-identity" = "enabled") {
  const dir = await mkdtemp(join(tmpdir(), "orca-revision-transport-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const stores = fileStores(dir);
  const credentialFile = join(dir, "credentials.json");
  const credentials = new CredentialStore({ file: credentialFile });
  const issue = (permissions: Permission[], principal = "alice") =>
    credentials.issue({ principal, permissions, scope: { workflows: ["revise"], runs: "owned" } });
  const alice = await issue(required);
  const owner = await credentials.issue({ principal: "owner", preset: "owner" });
  const reader = await issue(["runs.read"]);
  const answerOnly = await issue(["runs.read", "inputs.answer"]);
  const controlOnly = await issue(["runs.read", "runs.control"]);
  const noRead = await issue(["inputs.answer", "runs.control"]);
  const bob = await issue(required, "bob");
  const ownership = new OwnershipStore(join(dir, "ownership.json"));
  const definition = parseWorkflow(`
id: revise
name: Revise
version: '1'
start: gate
nodes:
  gate:
    type: gate
    question: Continue?
    options: [changes, done]
    revision:
      actionId: changes
      destinationNodeId: agent
      payload: {kind: text, maxBytes: 1024}
      composition: replace-revision-slot
  agent: {type: agent, agent: worker, prompt: Original}
  end: {type: end}
edges:
  - {from: gate, to: agent, when: "choice == 'changes'"}
  - {from: gate, to: end, when: "choice == 'done'"}
  - {from: agent, to: end}
`);
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(definition),
    templates: new TemplateRegistry(),
    logger: silentLogger,
  });
  const execution = daemonExecutionRuntime({
    instanceId: "revision-transport",
    orchestrator: orc,
    credentials,
    ownership,
  });
  cleanups.push(async () => execution.close());
  const adapter = createRevisionRuntime({ stores, authorizeExecution: (runId) => execution.authorizeExecution(runId) });
  const declare = async (runId: string, principalId?: string, parentRunId?: string) => {
    const def = parentRunId ? { ...definition, id: "private-child" } : definition;
    await stores.workflows.put(def);
    await stores.events.append({
      runId,
      type: "run.created",
      payload: {
        workflowId: def.id,
        workflowVersion: def.version,
        workflowStored: true,
        vars: {},
        workspace: { hostId: "local", cwd: dir },
        ...(parentRunId ? { parentRunId, parentStepRunId: "spawn" } : {}),
        provenance: {
          configGeneration: "PRIVATE-GENERATION",
          workflow: { id: def.id, version: def.version, revision: workflowRevision(def) },
          inputs: [],
          selections: [],
        },
      },
    });
    await stores.events.append({ runId, type: "run.started", payload: {} });
    if (principalId) {
      ownership.record(runId, principalId);
      await ownership.flush(runId);
    }
    const rc = await RunContext.load(runId, def, {
      stores,
      clock: systemClock,
      logger: silentLogger,
      loadState: async (id) => reduceRun(await executionEvents(await stores.events.read(id), stores.execution)),
    });
    rc.lease = await stores.leases.acquire({ resource: `run:${runId}`, holder: randomUUID() });
    try {
      await rc.emit({
        type: "step.scheduled",
        payload: { stepRunId: `${runId}-gate`, nodeId: "gate", nodeType: "gate", attempt: 1 },
      });
      await rc.emit({ type: "step.started", payload: { stepRunId: `${runId}-gate` } });
      const query = {
        runId,
        stepRunId: `${runId}-gate`,
        requestId: `${runId}-ask`,
        kind: "decision" as const,
        question: "Continue?",
        options: [
          { id: "changes", label: "Changes" },
          { id: "done", label: "Done" },
        ],
        context: {},
      };
      await rc.emit({ type: "human.requested", payload: query });
      await adapter.runtime.forStep(rc, rc.state.steps[`${runId}-gate`]!).declareRevision!(query);
      await rc.emit({ type: "step.waiting", payload: { stepRunId: `${runId}-gate`, on: "human" } });
      await rc.emit({ type: "run.paused", payload: {} });
    } finally {
      await stores.leases.release(rc.lease);
    }
    return (await adapter.readBoundaries(runId))[0]!;
  };
  const boundary = await declare("owned", "alice");
  const other = await declare("unowned", "bob");
  await declare("legacy");
  const child = await declare("child", undefined, "owned");
  const claims = new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults });
  const retries = new RegisteredRetryClaims(claims, faults);
  const services = createRevisionInputServices({
    journal: adapter.journal,
    readJournal: adapter.readJournal,
    retries: adapter.fenceRetries(retries),
    assertRetryFence: adapter.assertRetryFence,
    stale: () => new OrcaError("REVISION_STALE", "stale"),
  });
  services.register(retries);
  const readBoundaries = vi.fn((runId: string) => adapter.readBoundaries(runId));
  const placeholder = vi.fn(async () => {
    throw new OrcaError("NOT_SUPPORTED", "no revision service");
  });
  const reads = new ReadModel({ orchestrator: orc });
  const daemonOptions: DaemonOptions = {
    orcaVersion: "test",
    capabilities: ["runs.read", "runs.subscribe", "runs.control", ...revisionMethods],
    ...(mode === "no-identity" ? {} : { workspaceId: "eb09f154-67b9-42f7-9f58-36c919e9d3d3" }),
    reads,
    ...(mode === "read-only" ? {} : { control: new ControlModel({ orchestrator: orc, reads }) }),
    source: orc,
    operatorSources: { events: stores.events, leases: stores.leases },
    revisionInputs: placeholder,
    ...(mode === "missing" ? {} : { revisionSources: { services, readBoundaries } }),
    auth:
      mode === "loopback"
        ? { mode: "loopback-unauthenticated" }
        : {
            mode: "token",
            credentials,
            ownership,
            resolver: orchestratorResolver(orc),
          },
  };
  let daemon = await startDaemon(daemonOptions);
  cleanups.push(() => daemon.close());
  const restart = async () => {
    await daemon.close();
    const restoredStores = fileStores(dir);
    const restoredCredentials = new CredentialStore({ file: credentialFile });
    const restoredOwnership = new OwnershipStore(join(dir, "ownership.json"));
    const restoredOrc = new Orchestrator({
      stores: restoredStores,
      agents: new AgentRegistry(),
      workflows: new WorkflowRegistry().register(definition),
      templates: new TemplateRegistry(),
      logger: silentLogger,
    });
    const restoredExecution = daemonExecutionRuntime({
      instanceId: "revision-transport-restarted",
      orchestrator: restoredOrc,
      credentials: restoredCredentials,
      ownership: restoredOwnership,
    });
    cleanups.push(async () => restoredExecution.close());
    const restoredAdapter = createRevisionRuntime({
      stores: restoredStores,
      authorizeExecution: (runId) => restoredExecution.authorizeExecution(runId),
    });
    const restoredRetries = new RegisteredRetryClaims(
      new FileRetryClaimStore({ storeDir: dir, execution: restoredStores.execution, faults }),
      faults,
    );
    const restoredServices = createRevisionInputServices({
      journal: restoredAdapter.journal,
      readJournal: restoredAdapter.readJournal,
      retries: restoredAdapter.fenceRetries(restoredRetries),
      assertRetryFence: restoredAdapter.assertRetryFence,
      stale: () => new OrcaError("REVISION_STALE", "stale"),
    });
    restoredServices.register(restoredRetries);
    const restoredReads = new ReadModel({ orchestrator: restoredOrc });
    daemon = await startDaemon({
      ...daemonOptions,
      reads: restoredReads,
      control: new ControlModel({ orchestrator: restoredOrc, reads: restoredReads }),
      source: restoredOrc,
      revisionSources: { services: restoredServices, readBoundaries: restoredAdapter.readBoundaries },
      operatorSources: { events: restoredStores.events, leases: restoredStores.leases },
      auth: {
        mode: "token",
        credentials: restoredCredentials,
        ownership: restoredOwnership,
        resolver: orchestratorResolver(restoredOrc),
      },
    });
  };
  const http = async (method: string, params: unknown = {}, token = alice.token): Promise<ResponseMessage> => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as ResponseMessage;
  };
  const socket = async (token = alice.token) => {
    const ws = new WebSocket(daemon.socketUrl!, ["orca.v1", `orca.bearer.${token}`]);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
    });
    cleanups.push(async () => ws.close());
    let id = 0;
    return async (method: string, params: unknown = {}): Promise<ResponseMessage> => {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 5_000);
        const listener = (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data)) as ResponseMessage;
          if (frame.kind === "response" && frame.id === requestId) {
            clearTimeout(timer);
            ws.removeEventListener("message", listener);
            resolve(frame);
          }
        };
        ws.addEventListener("message", listener);
        ws.send(JSON.stringify({ kind: "request", id: requestId, method, params }));
      });
    };
  };
  const params = {
    command: { target: boundary.target, actionId: "changes", payload: { kind: "text", text: "PRIVATE CORRECTION" } },
    retry: { idempotencyKey: "same-revision" },
  };
  const changeGrants = async (permissions: Permission[]) => {
    const file = JSON.parse(await readFile(credentialFile, "utf8")) as {
      credentials: { id: string; permissions: Permission[] }[];
    };
    file.credentials.find((credential) => credential.id === alice.credential.id)!.permissions = permissions;
    await writeFile(credentialFile, JSON.stringify(file));
  };
  return {
    stores,
    dir,
    credentials,
    ownership,
    alice,
    owner,
    reader,
    answerOnly,
    controlOnly,
    noRead,
    bob,
    adapter,
    services,
    claims,
    readBoundaries,
    placeholder,
    daemon,
    http,
    socket,
    boundary,
    other,
    child,
    params,
    changeGrants,
    reads,
    restart,
  };
}

it.each(["missing", "read-only", "loopback", "no-identity"] as const)(
  "omits revision discovery without real authenticated writable composition: %s",
  async (mode) => {
    const f = await fixture(mode);
    const hello = HelloResultSchema.parse(
      result(await f.http("hello", { protocol: PROTOCOL_VERSION, client: "revision-transport-test" })),
    );
    for (const method of revisionMethods) {
      expect(hello.methods).not.toContain(method);
      expect(hello.capabilities).not.toContain(method);
      expect(await f.http(method, {})).toMatchObject({ ok: false, error: { code: "PROTOCOL_METHOD" } });
    }
    if (hello.methods?.includes("operator.discover")) {
      const discovery = OperatorDiscoverySchema.parse(result(await f.http("operator.discover")));
      for (const method of revisionMethods) expect(discovery.operations).not.toContain(method);
    }
    const page = InputsListResultSchema.parse(result(await f.http("inputs.list")));
    expect(page.inputs.every((input) => input.revision === undefined)).toBe(true);
    expect(f.placeholder).not.toHaveBeenCalled();
    expect(f.readBoundaries).not.toHaveBeenCalled();
  },
);

it.each(["http", "socket"] as const)("%s discovers and projects only safe owned-root boundaries", async (transport) => {
  const f = await fixture();
  const call = transport === "http" ? f.http : await f.socket();
  const hello = HelloResultSchema.parse(
    result(await call("hello", { protocol: PROTOCOL_VERSION, client: "revision-transport-test" })),
  );
  for (const method of revisionMethods) {
    expect(hello.methods).toContain(method);
    expect(hello.capabilities).toContain(method);
  }
  const discovery = OperatorDiscoverySchema.parse(result(await call("operator.discover")));
  for (const method of revisionMethods) expect(discovery.operations).toContain(method);
  expect(discovery.principalId).toBe("alice");
  const page = InputsListResultSchema.parse(result(await call("inputs.list")));
  expect(page.inputs.map((input) => input.runId).sort()).toEqual(["child", "owned"]);
  expect(page.waiting).toBe(2);
  for (const input of page.inputs) {
    expect(input.revision).toEqual({
      target: input.runId === "owned" ? f.boundary.target : f.child.target,
      capability: f.boundary.capability,
      destinationDescription: "agent",
    });
    expect(Object.keys(input.revision!).sort()).toEqual(["capability", "destinationDescription", "target"]);
  }
  const serialized = JSON.stringify(page);
  for (const secret of [
    "PRIVATE-GENERATION",
    "PRIVATE-WORKFLOW-REVISION",
    "attemptId",
    "generationId",
    "provenance",
    "currentRevisionId",
    "unowned-ask",
    "legacy-ask",
  ])
    expect(serialized).not.toContain(secret);
  expect(f.readBoundaries.mock.calls.map(([runId]) => runId).sort()).toEqual(["child", "owned"]);
  expect(InputsListResultSchema.parse(result(await call("inputs.list", { runId: "unowned" })))).toMatchObject({
    inputs: [],
    waiting: 0,
  });
});

it.each(["http", "socket"] as const)(
  "%s authenticates before mutation schemas and hides projection without both grants",
  async (transport) => {
    const f = await fixture();
    for (const credential of [f.reader, f.answerOnly, f.controlOnly]) {
      const call =
        transport === "http"
          ? (method: string, params: unknown = {}) => f.http(method, params, credential.token)
          : await f.socket(credential.token);
      const hello = HelloResultSchema.parse(
        result(await call("hello", { protocol: PROTOCOL_VERSION, client: "revision-transport-test" })),
      );
      for (const method of ["inputs.revise", "inputs.replaceRevision"]) {
        expect(hello.methods).not.toContain(method);
        expect(hello.capabilities).not.toContain(method);
        expect(await call(method, { deliberately: "invalid" })).toMatchObject({
          ok: false,
          error: { code: "AUTH_FORBIDDEN" },
        });
      }
      expect(hello.methods).toContain("inputs.revisionPending");
      const discovery = OperatorDiscoverySchema.parse(result(await call("operator.discover")));
      expect(discovery.operations).not.toContain("inputs.revise");
      expect(discovery.operations).not.toContain("inputs.replaceRevision");
      const page = InputsListResultSchema.parse(result(await call("inputs.list")));
      expect(page.inputs).toHaveLength(2);
      expect(page.inputs.every((input) => !input.revision)).toBe(true);
    }
    expect(f.readBoundaries).not.toHaveBeenCalled();
    const allowed = transport === "http" ? f.http : await f.socket();
    expect(await allowed("inputs.revise", { deliberately: "invalid" })).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MESSAGE" },
    });
    expect(await f.http("inputs.list", {}, f.noRead.token)).toMatchObject({
      ok: false,
      error: { code: "AUTH_FORBIDDEN" },
    });
  },
);

it.each(["http", "socket"] as const)(
  "%s commits and replays through real protected claims, then rechecks current authority",
  async (transport) => {
    const f = await fixture();
    const call = transport === "http" ? f.http : await f.socket();
    const first = resolved(await call("inputs.revise", f.params));
    expect(first.replayed).toBe(false);
    const record = await f.adapter.journal.withRun("owned", (tx) => tx.record(first.result.revisionId));
    expect(record?.provenance.actor).toEqual({ principalId: "alice", credentialId: f.alice.credential.id });
    expect(resolved(await call("inputs.revise", f.params))).toEqual({ ...first, replayed: true });
    const alternate = transport === "http" ? await f.socket() : f.http;
    expect(resolved(await alternate("inputs.revise", f.params))).toEqual({ ...first, replayed: true });
    const target = {
      runId: "owned",
      revisionId: first.result.revisionId,
      destinationId: first.result.target.destinationId,
      attemptId: first.result.attemptId,
    };
    expect(PendingRevisionViewSchema.parse(result(await call("inputs.revisionPending", { target })))).toMatchObject({
      payload: { kind: "text", text: "PRIVATE CORRECTION" },
      replacementAllowed: true,
    });
    const publicPending = PendingRevisionViewSchema.parse(
      result(await f.http("inputs.revisionPending", { target }, f.reader.token)),
    );
    expect(publicPending).not.toHaveProperty("payload");
    expect(publicPending.replacementAllowed).toBe(false);
    expect(await f.http("inputs.revisionPending", { target }, f.bob.token)).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_FOUND" },
    });
    const before = await readFile(join(f.dir, "runs", "owned.jsonl"), "utf8");
    expect(before).not.toContain("PRIVATE CORRECTION");
    expect(
      (await f.stores.events.read("owned")).filter(
        (event) => event.type === "revision.recorded" && event.payload.decision,
      ),
    ).toHaveLength(1);
    await f.changeGrants(["runs.read", "inputs.answer"]);
    expect(await call("inputs.revise", f.params)).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
    expect(
      PendingRevisionViewSchema.parse(result(await call("inputs.revisionPending", { target }))),
    ).not.toHaveProperty("payload");
    expect(await readFile(join(f.dir, "runs", "owned.jsonl"), "utf8")).toBe(before);
    // A separate owner credential never substitutes for the caller's revoked original.
    await f.credentials.revoke(f.alice.credential.id);
    expect(await f.http("inputs.revise", f.params)).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect(await readFile(join(f.dir, "runs", "owned.jsonl"), "utf8")).toBe(before);
  },
);

it("replaces a pending revision through the same registered authenticated service", async () => {
  const f = await fixture();
  const first = resolved(await f.http("inputs.revise", f.params));
  const params = {
    command: {
      target: {
        runId: "owned",
        revisionId: first.result.revisionId,
        destinationId: first.result.target.destinationId,
        attemptId: first.result.attemptId,
      },
      expectedRevision: first.result.expectedRevision,
      payload: { kind: "text", text: "PRIVATE REPLACEMENT" },
    },
    retry: { idempotencyKey: "replace-revision" },
  };
  const socket = await f.socket();
  const replacement = resolved(await socket("inputs.replaceRevision", params));
  expect(replacement.result.revisionId).not.toBe(first.result.revisionId);
  expect(resolved(await f.http("inputs.replaceRevision", params))).toEqual({ ...replacement, replayed: true });
  const target = { ...params.command.target, revisionId: replacement.result.revisionId };
  expect(result(await socket("inputs.revisionPending", { target }))).toMatchObject({
    payload: { kind: "text", text: "PRIVATE REPLACEMENT" },
  });
  expect(JSON.stringify(await f.stores.events.read("owned"))).not.toContain("PRIVATE REPLACEMENT");
});

it("never fabricates cached acceptance when the authoritative publication marker is missing", async () => {
  const f = await fixture();
  const eventPath = join(f.dir, "runs", "owned.jsonl");
  const before = await readFile(eventPath, "utf8");
  resolved(await f.http("inputs.revise", f.params));
  await writeFile(eventPath, before);
  expect(await f.http("inputs.revise", f.params)).toMatchObject({
    ok: false,
    error: { code: "RUN_STATE", details: { reason: "revision-publication-uncertain" } },
  });
  expect(await readFile(eventPath, "utf8")).toBe(before);
});

it.each(["ambiguous", "malformed", "moved", "wrong-input"] as const)(
  "omits optional %s boundaries without inventing a destination",
  async (kind) => {
    const f = await fixture();
    const boundary = structuredClone(f.boundary);
    if (kind === "malformed") boundary.capability.payload.maxBytes = 0;
    if (kind === "moved") boundary.status = "moved";
    if (kind === "wrong-input") boundary.target.stepRunId = "other-step";
    f.readBoundaries.mockResolvedValue(kind === "ambiguous" ? [boundary, structuredClone(boundary)] : [boundary]);
    const page = InputsListResultSchema.parse(result(await f.http("inputs.list", { runId: "owned" })));
    expect(page.inputs).toHaveLength(1);
    expect(page.inputs[0]).not.toHaveProperty("revision");
  },
);

it("allows only schema-approved boundary fields and ignores legacy read-model enrichment", async () => {
  const f = await fixture();
  const poisoned: RevisionBoundary = {
    ...f.boundary,
    ...{ payload: { kind: "text", text: "PRIVATE PAYLOAD" }, provenance: { actor: "PRIVATE ACTOR" } },
  };
  f.readBoundaries.mockResolvedValue([poisoned]);
  const page = result(await f.http("inputs.list", { runId: "owned" }));
  expect(JSON.stringify(page)).not.toContain("PRIVATE");
  const legacy = await f.reads.inputsList({ runId: "owned" });
  legacy.inputs[0]!.revision = {
    target: f.boundary.target,
    capability: f.boundary.capability,
    destinationDescription: "UNTRUSTED",
  };
  vi.spyOn(f.reads, "inputsList").mockResolvedValue(legacy);
  const denied = InputsListResultSchema.parse(result(await f.http("inputs.list", {}, f.reader.token)));
  expect(denied.inputs[0]).not.toHaveProperty("revision");
});

it("observes an actively leased boundary but surfaces unexpected store failures", async () => {
  const f = await fixture();
  const lease = await f.stores.leases.acquire({ resource: "run:owned", holder: "interpreter" });
  try {
    const page = InputsListResultSchema.parse(result(await f.http("inputs.list", { runId: "owned" })));
    expect(page.inputs[0]?.revision?.target).toEqual(f.boundary.target);
    expect((await f.stores.leases.get("run:owned"))?.guardedId).toBe(lease.guardedId);
  } finally {
    await f.stores.leases.release(lease);
  }
  f.readBoundaries.mockRejectedValueOnce(new OrcaError("STORE_WRITE", "failed"));
  expect(await f.http("inputs.list", { runId: "owned" })).toMatchObject({ ok: false, error: { code: "STORE_WRITE" } });
});

it("rechecks the original credential after a protected boundary read", async () => {
  const f = await fixture();
  f.readBoundaries.mockImplementationOnce(async (runId) => {
    const boundaries = await f.adapter.readBoundaries(runId);
    await f.credentials.revoke(f.alice.credential.id);
    return boundaries;
  });
  expect(await f.http("inputs.list", { runId: "owned" })).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
});

it.each(["principal", "credential"] as const)(
  "rejects changed current %s identity before protected revision access",
  async (changed) => {
    const f = await fixture();
    const current = f.credentials.current.bind(f.credentials);
    vi.spyOn(f.credentials, "current").mockImplementation((credentialId) => {
      const checked = current(credentialId);
      return checked.ok && credentialId === f.alice.credential.id
        ? {
            ok: true,
            principal: {
              ...checked.principal,
              ...(changed === "principal" ? { id: "owner" } : { credentialId: f.owner.credential.id }),
            },
          }
        : checked;
    });
    const journal = vi.spyOn(f.adapter.journal, "withRun");
    expect(await f.http("inputs.revise", f.params)).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
    expect(await f.http("inputs.list", { runId: "owned" })).toMatchObject({
      ok: false,
      error: { code: "AUTH_FORBIDDEN" },
    });
    expect(journal).not.toHaveBeenCalled();
    expect(f.readBoundaries).not.toHaveBeenCalled();
  },
);

it.each(["mutation", "replay"] as const)(
  "rechecks the original credential after acquiring the protected fence for %s",
  async (mode) => {
    const f = await fixture();
    if (mode === "replay") resolved(await f.http("inputs.revise", f.params));
    const eventPath = join(f.dir, "runs", "owned.jsonl");
    const before = await readFile(eventPath, "utf8");
    const acquire = f.stores.leases.acquire.bind(f.stores.leases);
    vi.spyOn(f.stores.leases, "acquire").mockImplementationOnce(async (request) => {
      const lease = await acquire(request);
      await f.credentials.revoke(f.alice.credential.id);
      return lease;
    });
    expect(await f.http("inputs.revise", f.params)).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect(await readFile(eventPath, "utf8")).toBe(before);
  },
);

it("rechecks root ownership before cached replay and protected boundary projection", async () => {
  const f = await fixture();
  resolved(await f.http("inputs.revise", f.params));
  f.ownership.forget("owned", "alice");
  await f.ownership.flush("owned");
  const journal = vi.spyOn(f.adapter.journal, "withRun");
  expect(await f.http("inputs.revise", f.params)).toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } });
  const page = InputsListResultSchema.parse(result(await f.http("inputs.list")));
  expect(page).toMatchObject({ inputs: [], waiting: 0 });
  expect(journal).not.toHaveBeenCalled();
  expect(f.readBoundaries).not.toHaveBeenCalled();
});

it.each(["http", "socket"] as const)(
  "%s rediscovers current pending metadata after the answered gate and a daemon restart",
  async (transport) => {
    const f = await fixture();
    const first = resolved(await f.http("inputs.revise", f.params));
    await f.restart();
    const call = transport === "http" ? f.http : await f.socket();
    const page = InputsListResultSchema.parse(result(await call("inputs.list", { runId: "owned" })));
    expect(page.inputs).toEqual([]);
    expect(page.waiting).toBe(0);
    expect(page.pendingRevisions).toEqual({
      items: [
        {
          target: {
            runId: "owned",
            revisionId: first.result.revisionId,
            destinationId: first.result.target.destinationId,
            attemptId: first.result.attemptId,
          },
          expectedRevision: first.result.expectedRevision,
          state: "pending",
        },
      ],
      incomplete: false,
    });
    const summary = page.pendingRevisions!.items[0]!;
    expect(result(await call("inputs.revisionPending", { target: summary.target }))).toMatchObject({
      payload: { kind: "text", text: "PRIVATE CORRECTION" },
    });
    for (const hidden of [
      "PRIVATE",
      "capability",
      "payload",
      "provenance",
      "generationId",
      "replacementAllowed",
      "inputSchema",
    ])
      expect(JSON.stringify(page.pendingRevisions)).not.toContain(hidden);
    const events = await f.stores.events.read("owned");
    expect(events.filter((event) => event.type === "revision.recorded" && event.payload.decision)).toHaveLength(1);
    expect(events.filter((event) => event.type === "human.answered")).toHaveLength(0);
  },
);

it("discovers only the current replacement, separate from unanswered input counts", async () => {
  const f = await fixture();
  const first = resolved(await f.http("inputs.revise", f.params));
  const command = {
    target: {
      runId: "owned",
      revisionId: first.result.revisionId,
      destinationId: first.result.target.destinationId,
      attemptId: first.result.attemptId,
    },
    expectedRevision: first.result.expectedRevision,
    payload: { kind: "text", text: "PRIVATE REPLACEMENT" },
  };
  const next = resolved(await f.http("inputs.replaceRevision", { command, retry: {} }));
  const page = InputsListResultSchema.parse(
    result(await f.http("inputs.list", { revisionRunIds: ["owned", "unowned", "does-not-exist", "legacy"] })),
  );
  expect(page.waiting).toBe(1); // The child gate remains unanswered; the correction is not another gate.
  expect(page.inputs.map((input) => input.runId)).toEqual(["child"]);
  expect(page.pendingRevisions).toMatchObject({
    incomplete: false,
    items: [
      {
        target: { revisionId: next.result.revisionId },
        expectedRevision: next.result.expectedRevision,
        state: "pending",
      },
    ],
  });
  expect(page.pendingRevisions!.items).toHaveLength(1);
  expect(JSON.stringify(page.pendingRevisions)).not.toContain(first.result.revisionId);
});

it.each(["delivered", "cancelled", "delivery-uncertain"] as const)(
  "reports authoritative %s state without reopening the gate",
  async (state) => {
    const f = await fixture();
    const first = resolved(await f.http("inputs.revise", f.params));
    if (state === "cancelled") await f.stores.events.append({ runId: "owned", type: "run.cancelled", payload: {} });
    else
      await f.adapter.journal.withRun("owned", async (tx) => {
        const record = (await tx.record(first.result.revisionId))!;
        const claimed = {
          ...record,
          delivery: "claimed" as const,
          prompt: "PRIVATE PROMPT",
          handoffId: randomUUID(),
          receipt: { ...record.receipt, expectedRevision: randomUUID() },
        };
        await tx.transition(claimed, record.receipt.expectedRevision);
        await tx.transition(
          {
            ...claimed,
            delivery: state === "delivered" ? "confirmed" : "uncertain",
            receipt: {
              ...claimed.receipt,
              expectedRevision: randomUUID(),
              state: state === "delivered" ? "delivered" : "pending",
            },
          },
          claimed.receipt.expectedRevision,
        );
      });
    const page = InputsListResultSchema.parse(result(await f.http("inputs.list", { runId: "owned" })));
    expect(page).toMatchObject({
      inputs: [],
      waiting: 0,
      pendingRevisions: {
        incomplete: false,
        items: [
          {
            target: { revisionId: first.result.revisionId },
            state: state === "delivered" ? "delivered" : state === "cancelled" ? "rejected" : "pending",
            unavailableReason: state,
          },
        ],
      },
    });
    expect(JSON.stringify(page)).not.toContain("PRIVATE");
  },
);

it("keeps global discovery incomplete while exact leased observations remain readable", async () => {
  const f = await fixture();
  resolved(await f.http("inputs.revise", f.params));
  expect(result(await f.http("inputs.list"))).toMatchObject({
    pendingRevisions: { items: [], incomplete: true, reason: "run-scope-required" },
  });
  const lease = await f.stores.leases.acquire({ resource: "run:owned", holder: "interpreter" });
  try {
    expect(result(await f.http("inputs.list", { revisionRunIds: ["owned"] }))).toMatchObject({
      pendingRevisions: { items: [expect.objectContaining({ state: "pending" })], incomplete: false },
    });
  } finally {
    await f.stores.leases.release(lease);
  }
  f.readBoundaries.mockRejectedValueOnce(
    new OrcaError("RUN_STATE", "uncertain protected journal", { reason: "revision-publication-uncertain" }),
  );
  expect(await f.http("inputs.list", { runId: "owned" })).toMatchObject({
    ok: false,
    error: { code: "RUN_STATE", details: { reason: "revision-publication-uncertain" } },
  });
});

it("authorizes run batches before reading metadata and supplies no data-bearing denied omissions", async () => {
  const f = await fixture();
  const first = resolved(await f.http("inputs.revise", f.params));
  f.readBoundaries.mockClear();
  const readerPage = InputsListResultSchema.parse(
    result(await f.http("inputs.list", { runId: "owned" }, f.reader.token)),
  );
  expect(readerPage.pendingRevisions).toMatchObject({
    incomplete: false,
    items: [{ target: { revisionId: first.result.revisionId } }],
  });
  expect(JSON.stringify(readerPage.pendingRevisions)).not.toContain("PRIVATE");
  expect(
    result(
      await f.http("inputs.revisionPending", { target: readerPage.pendingRevisions!.items[0]!.target }, f.reader.token),
    ),
  ).not.toHaveProperty("payload");
  f.readBoundaries.mockClear();
  const denied = result(
    await f.http("inputs.list", { runId: "owned", revisionRunIds: ["owned", "legacy", "absent"] }, f.bob.token),
  );
  expect(denied).toMatchObject({ inputs: [], waiting: 0, pendingRevisions: { items: [], incomplete: false } });
  expect(f.readBoundaries).not.toHaveBeenCalled();
  await f.credentials.revoke(f.alice.credential.id);
  expect(await f.http("inputs.list", { runId: "owned" })).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
});

it("requires strict bounded run batches and unambiguous incomplete summaries", async () => {
  const f = await fixture();
  for (const revisionRunIds of [[], ["owned", "owned"], Array.from({ length: 21 }, (_, i) => `run-${i}`), [""]]) {
    expect(InputsListParamsSchema.safeParse({ revisionRunIds }).success).toBe(false);
    expect(await f.http("inputs.list", { revisionRunIds })).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MESSAGE" },
    });
    expect(await f.http("inputs.list", { revisionRunIds }, f.noRead.token)).toMatchObject({
      ok: false,
      error: { code: "AUTH_FORBIDDEN" },
    });
  }
  for (const invalid of [
    { items: [], incomplete: true },
    { items: [], incomplete: false, reason: "limit" },
    { items: [], incomplete: true, reason: "secret-run", runId: "private" },
  ])
    expect(PendingRevisionsDiscoverySchema.safeParse(invalid).success).toBe(false);
});

it.each(["ambiguous", "malformed"] as const)("marks %s current revision discovery incomplete", async (kind) => {
  const f = await fixture();
  resolved(await f.http("inputs.revise", f.params));
  const boundary = (await f.adapter.readBoundaries("owned"))[0]!;
  if (kind === "malformed") boundary.attemptId = "";
  f.readBoundaries.mockResolvedValue(kind === "ambiguous" ? [boundary, structuredClone(boundary)] : [boundary]);
  expect(result(await f.http("inputs.list", { runId: "owned" }))).toMatchObject({
    inputs: [],
    waiting: 0,
    pendingRevisions: { items: [], incomplete: true, reason: "boundary-unavailable" },
  });
});

it("caps protected metadata reads before collecting an oversized batch and reports the limit", async () => {
  const f = await fixture();
  resolved(await f.http("inputs.revise", f.params));
  const boundary = (await f.adapter.readBoundaries("owned"))[0]!;
  f.readBoundaries.mockResolvedValue(
    Array.from({ length: 60 }, (_, index) =>
      index === 0 ? boundary : { ...boundary, target: { ...boundary.target, destinationId: `unavailable-${index}` } },
    ),
  );
  const forAccess = f.services.forAccess.bind(f.services);
  const targets: unknown[] = [];
  vi.spyOn(f.services, "forAccess").mockImplementation((access) => {
    const service = forAccess(access);
    return {
      ...service,
      readPending: async (target) => {
        targets.push(target);
        return service.readPending(target);
      },
    };
  });
  const page = InputsListResultSchema.parse(result(await f.http("inputs.list", { runId: "owned" })));
  expect(targets).toHaveLength(50);
  expect(page.pendingRevisions).toMatchObject({ incomplete: true, reason: "limit" });
  expect(page.pendingRevisions!.items).toHaveLength(1);
  const summary = page.pendingRevisions!.items[0]!;
  expect(
    PendingRevisionsDiscoverySchema.safeParse({ incomplete: false, items: Array.from({ length: 51 }, () => summary) })
      .success,
  ).toBe(false);
  expect(
    PendingRevisionsDiscoverySchema.safeParse({ incomplete: false, items: [{ ...summary, payload: "PRIVATE" }] })
      .success,
  ).toBe(false);
});

it.each(["credential", "ownership"] as const)(
  "rechecks current %s after pending-boundary discovery",
  async (change) => {
    const f = await fixture();
    resolved(await f.http("inputs.revise", f.params));
    f.readBoundaries.mockImplementationOnce(async (runId) => {
      const boundaries = await f.adapter.readBoundaries(runId);
      if (change === "credential") await f.credentials.revoke(f.alice.credential.id);
      else {
        f.ownership.forget("owned", "alice");
        await f.ownership.flush("owned");
      }
      return boundaries;
    });
    const response = await f.http("inputs.list", { runId: "owned" });
    if (change === "credential") expect(response).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    // A visibility change after enrichment starts refuses the whole response, including
    // already-projected input restrictions, pending metadata and omission counts.
    else expect(response).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
  },
);

it.each(["http", "ws"] as const)(
  "keeps retry keys unclaimed while an external execution owner holds the run over %s",
  async (transport) => {
    const f = await fixture();
    const call = transport === "http" ? f.http : await f.socket();
    const claim = vi.spyOn(f.claims, "claim");
    const lease = await f.stores.leases.acquire({ resource: "run:owned", holder: "external-execution-owner" });
    try {
      expect(await call("inputs.revise", f.params)).toMatchObject({ ok: false, error: { code: "RUN_LEASED" } });
      expect(claim).not.toHaveBeenCalled();
      expect(await f.adapter.readBoundaries("owned")).toHaveLength(1);
    } finally {
      await f.stores.leases.release(lease);
    }
    expect(await f.stores.leases.get("run:owned")).toBeUndefined();
    const accepted = resolved(await call("inputs.revise", f.params));
    const replay = resolved(await call("inputs.revise", f.params));
    expect(replay.operationId).toBe(accepted.operationId);
    expect(replay.result).toEqual(accepted.result);
    expect(replay.replayed).toBe(true);
    const events = await f.stores.events.read("owned");
    expect(events.filter((event) => event.type === "revision.recorded" && event.payload.decision)).toHaveLength(1);
  },
);

it.each(["stale", "payload"] as const)("refuses fresh %s input before consuming its retry key", async (failure) => {
  const f = await fixture();
  const refused = structuredClone(f.params);
  if (failure === "stale") refused.command.target.expectedRevision = "not-current";
  else refused.command.payload.text = "x".repeat(1025);
  expect(await f.http("inputs.revise", refused)).toMatchObject({
    ok: false,
    error: { code: failure === "stale" ? "REVISION_STALE" : "WORKFLOW_INPUT_INVALID" },
  });
  expect(await f.claims.batch()).toEqual([]);
  const accepted = resolved(await f.http("inputs.revise", f.params));
  expect(resolved(await f.http("inputs.revise", f.params)).result).toEqual(accepted.result);
  expect(await f.http("inputs.revise", refused)).toMatchObject({ ok: false, error: { code: "RETRY_CONFLICT" } });
});

it.each(["http", "ws"] as const)(
  "does not let a held authenticated observational read take the writer lease over %s",
  async (transport) => {
    const f = await fixture();
    const call = transport === "http" ? f.http : await f.socket();
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshot = f.stores.events.readObservation!.bind(f.stores.events);
    vi.spyOn(f.stores.events, "readObservation").mockImplementationOnce(async (...args) => {
      const value = await snapshot(...args);
      entered();
      await held;
      return value;
    });
    const reading = call("inputs.list", { runId: "owned" });
    await enteredPromise;
    let accepted;
    try {
      expect(await f.stores.leases.get("run:owned")).toBeUndefined();
      accepted = resolved(await call("inputs.revise", f.params));
    } finally {
      release();
    }
    expect(await reading).toMatchObject({ ok: false, error: { code: "RUN_STATE" } });
    expect(resolved(await call("inputs.revise", f.params)).operationId).toBe(accepted.operationId);
    const target = {
      runId: "owned",
      revisionId: accepted.result.revisionId,
      destinationId: accepted.result.target.destinationId,
      attemptId: accepted.result.attemptId,
    };
    expect(PendingRevisionViewSchema.parse(result(await call("inputs.revisionPending", { target }))).payload).toEqual(
      f.params.command.payload,
    );
    expect(
      (await f.stores.events.read("owned")).filter(
        (event) => event.type === "revision.recorded" && event.payload.decision,
      ),
    ).toHaveLength(1);
  },
);

it.each(["http", "ws"] as const)(
  "rechecks current authority after the final observational snapshot over %s",
  async (transport) => {
    const f = await fixture();
    const call = transport === "http" ? f.http : await f.socket();
    const accepted = resolved(await call("inputs.revise", f.params));
    const target = {
      runId: "owned",
      revisionId: accepted.result.revisionId,
      destinationId: accepted.result.target.destinationId,
      attemptId: accepted.result.attemptId,
    };
    const snapshot = f.stores.events.readObservation!.bind(f.stores.events);
    vi.spyOn(f.stores.events, "readObservation").mockImplementation(async (...args) => {
      const value = await snapshot(...args);
      return {
        events: value.events,
        verifyUnchanged: async () => {
          await value.verifyUnchanged();
          await f.credentials.revoke(f.alice.credential.id);
        },
      };
    });
    const response = await call("inputs.revisionPending", { target });
    expect(response).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect(JSON.stringify(response)).not.toContain("PRIVATE CORRECTION");
  },
);
