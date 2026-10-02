/**
 * A token-authenticated daemon over a real orchestrator, with principals that can and cannot
 * see each other's work - the fixture every `security*.test.ts` drives.
 *
 * Runs are started through `runs.start` by the principals themselves, so ownership is
 * attributed the way it is in production, and each parks at a gate (`PausingHumanInput`) so
 * there is a live decision to authorize. One more run is started on the orchestrator directly:
 * the run a CLI or a pre-authentication daemon would have left, which nobody owns.
 */
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { AgentRegistry } from "@orca/agents";
import {
  FakeClock,
  TemplateRegistry,
  WorkflowRegistry,
  parseWorkflow,
  silentLogger,
  type Artifact,
  type OrcaEventInput,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";
import { ConfigModel, ControlModel, ReadModel, startDaemon, type DaemonHandle } from "@orca/daemon";
import {
  CredentialStore,
  MemoryAuditSink,
  OwnershipStore,
  orchestratorResolver,
  type TokenAuthOptions,
} from "../src/auth/index.js";

const gated = (id: string) => `
id: ${id}
name: ${id}
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Ship it?", options: [ship, hold] }
  shipped: { type: end }
  held: { type: end, outcome: failure }
edges:
  - { from: s, to: gate }
  - { from: gate, to: shipped, when: "choice == 'ship'" }
  - { from: gate, to: held }
`;

export interface Rpc {
  status: number;
  headers: Headers;
  body: {
    kind: string;
    id: unknown;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string; details?: unknown };
  };
}

export interface Harness {
  daemon: DaemonHandle;
  clock: FakeClock;
  stores: Stores;
  orchestrator: Orchestrator;
  credentials: CredentialStore;
  ownership: OwnershipStore;
  audit: MemoryAuditSink;
  tokens: { owner: string; alice: string; bob: string; viewer: string; narrow: string; runsOnly: string };
  ids: { alice: string; bob: string; viewer: string };
  /** alice's and bob's parked runs, and the run nobody owns. */
  runs: { alice: string; bob: string; legacy: string };
  /** The open gate in each run. */
  gates: { alice: string; bob: string; legacy: string };
  rpc(token: string | undefined, method: string, params?: unknown, headers?: Record<string, string>): Promise<Rpc>;
  append(input: OrcaEventInput): Promise<number>;
  close(): Promise<void>;
}

export async function harness(extra: Partial<TokenAuthOptions> = {}, backingStores?: Stores): Promise<Harness> {
  const clock = new FakeClock();
  const stores = backingStores ?? memoryStores(clock);
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry(clock),
    workflows: new WorkflowRegistry()
      .register(parseWorkflow(gated("gated")))
      .register(parseWorkflow(gated("other")))
      .register(parseWorkflow(gated("secret"))),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    humanInput: new PausingHumanInput(),
    logger: silentLogger,
    clock,
    lease: { ttlMs: 120_000 },
  });
  const reads = new ReadModel({ orchestrator });
  const config = new ConfigModel({ configDir: tmpdir() });
  const control = new ControlModel({ orchestrator, reads, config });
  const credentials = extra.credentials ?? new CredentialStore();
  const ownership = extra.ownership ?? new OwnershipStore();
  const audit = new MemoryAuditSink();
  const issue = async (principal: string, preset: "owner" | "client" | "viewer", workflows?: string[]) =>
    await credentials.issue({
      principal,
      preset,
      ...(workflows ? { scope: { workflows, runs: "owned" as const } } : {}),
    });
  const owner = await issue("owner", "owner");
  const alice = await issue("alice", "client");
  const bob = await issue("bob", "client");
  const viewer = await issue("viewer", "viewer");
  const narrow = await issue("narrow", "client", ["gated"]);

  const runsOnly = await credentials.issue({
    principal: "alice",
    permissions: ["runs.read"],
    scope: { workflows: "*", runs: "owned" },
  });

  const daemon = await startDaemon({
    orcaVersion: "0.0.0-security",
    capabilities: ["runs.read", "runs.subscribe", "runs.control"],
    storeDir: "/srv/store",
    reads,
    control,
    config,
    source: orchestrator,
    auth: {
      mode: "token",
      credentials,
      ownership,
      resolver: orchestratorResolver(orchestrator),
      audit,
      ...extra,
    },
  });

  const rpc: Harness["rpc"] = async (token, method, params = {}, headers = {}) => {
    const res = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ kind: "request", id: 7, method, params }),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as Rpc["body"] };
  };
  const started = async (token: string, workflowId: string) => {
    const r = await rpc(token, "runs.start", { workflowId });
    if (!r.body.ok) throw new Error(`runs.start failed: ${JSON.stringify(r.body.error)}`);
    return (r.body.result as { runId: string }).runId;
  };
  const aliceRun = await started(alice.token, "gated");
  const bobRun = await started(bob.token, "gated");
  const legacy = (await orchestrator.startAndRun({ workflowId: "other" })).run.id;
  const gateOf = async (runId: string) => (await orchestrator.pendingInputs(runId))[0]!.id;

  return {
    daemon,
    clock,
    stores,
    orchestrator,
    credentials,
    ownership,
    audit,
    tokens: {
      owner: owner.token,
      alice: alice.token,
      bob: bob.token,
      viewer: viewer.token,
      narrow: narrow.token,
      runsOnly: runsOnly.token,
    },
    ids: { alice: alice.credential.id, bob: bob.credential.id, viewer: viewer.credential.id },
    runs: { alice: aliceRun, bob: bobRun, legacy },
    gates: { alice: await gateOf(aliceRun), bob: await gateOf(bobRun), legacy: await gateOf(legacy) },
    rpc,
    append: async (input) => (await stores.events.append(input)).seq,
    close: () => daemon.close(),
  };
}

/** An artifact in `runId`, put straight into the store. */
export async function putArtifact(stores: Stores, id: string, runId: string, body = "# secret\n"): Promise<void> {
  const a: Artifact = {
    id,
    kind: "spec",
    name: "spec",
    path: `/tmp/${id}.md`,
    mediaType: "text/markdown",
    contentHash: `sha256:${id}`,
    size: Buffer.byteLength(body),
    version: 1,
    producedBy: { runId, stepRunId: `${runId}-step`, agentId: "claude" },
    parents: [],
    data: {},
    createdAt: new Date(0).toISOString(),
  };
  await stores.artifacts.put(a, body);
}

/** A raw HTTP request, for the headers `fetch` will not let a test set (`Host`). */
export function raw(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; path?: string },
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: opts.path ?? "/rpc",
        method: opts.method ?? "POST",
        headers: opts.headers ?? {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(opts.body ?? JSON.stringify({ kind: "request", id: 1, method: "hello", params: {} }));
  });
}

/** Real JSON-object artifact, including the parsed data carried by artifact.recorded. */
export async function recordJsonArtifact(h: Harness, id: string): Promise<number> {
  const artifact: Artifact = {
    id,
    kind: "report",
    name: "report",
    path: `/tmp/${id}.json`,
    mediaType: "application/json",
    contentHash: `sha256:${id}`,
    size: 30,
    version: 1,
    producedBy: { runId: h.runs.alice, stepRunId: "artifact-step" },
    parents: [],
    data: { secret: "private-json-value" },
    createdAt: h.clock.isoNow(),
  };
  await h.stores.artifacts.put(artifact, JSON.stringify(artifact.data));
  return h.append({
    type: "artifact.recorded",
    runId: h.runs.alice,
    payload: { stepRunId: "artifact-step", artifact },
  });
}

/** Attach a real artifact to the pending gate so inputs.list must project its metadata. */
export async function recordGateArtifact(h: Harness, id: string): Promise<void> {
  await recordJsonArtifact(h, id);
  const gate = (await h.orchestrator.pendingInputs(h.runs.alice)).find((input) => input.id === h.gates.alice)!;
  await h.append({
    type: "step.inputs",
    runId: h.runs.alice,
    payload: { stepRunId: gate.stepRunId, artifactIds: [id] },
  });
}
