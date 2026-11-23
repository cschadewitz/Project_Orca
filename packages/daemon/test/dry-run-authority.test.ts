/**
 * Dry runs behind the token guard (#183): `workflowDrafts.dryRun` is a launch of the draft's
 * workflow, checked as one, and the root it creates is owned by its caller the same durable way
 * `runs.start` owns one - so the caller's own-runs credential can list and reopen its dry run,
 * root and child, across a restart, and a principal it is not owned by cannot.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { FakeClock, TemplateRegistry, WorkflowRegistry, parseWorkflow, silentLogger } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "@orca/engine";
import { RunsDryRunReportResultSchema, RunsListResultSchema, WorkflowDraftDryRunResultSchema } from "@orca/protocol";
import { memoryStores, type Stores } from "@orca/store";
import {
  ConfigModel,
  ControlModel,
  ReadModel,
  startDaemon,
  type ConfigGenerationProvider,
  type DaemonHandle,
} from "@orca/daemon";
import { CredentialStore, MemoryAuditSink, OwnershipStore, orchestratorResolver } from "../src/auth/index.js";

const gated = (id: string) => `id: ${id}
name: ${id}
version: "1"
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

/** A draftable workflow whose dry run has a child: the registered `gated`. */
const PARENT = `id: parent
name: parent
version: "1"
start: s
nodes:
  s: { type: start }
  sub: { type: subworkflow, workflow: gated }
  e: { type: end }
edges:
  - { from: s, to: sub }
  - { from: sub, to: e }
`;

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const STATUS = {
  savedRevision: "r",
  activeRevision: "r",
  activeGeneration: "11111111-1111-4111-8111-111111111111",
  state: "active" as const,
  restartRequired: [],
};
const generations: ConfigGenerationProvider = {
  effectiveConfig: () => ({}),
  validationContext: () => ({}),
  status: () => STATUS,
  apply: async () => ({ outcome: "unchanged", status: STATUS, validation: { errors: [] } }),
  onChange: () => () => {},
};

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "orca-dry-run-authority-"));
  dirs.push(dir);
  await mkdir(join(dir, "workflows"));
  await writeFile(join(dir, "orca.config.yaml"), "workflows: ['workflows/*.yaml']\ntemplates: []\n");
  await writeFile(join(dir, "workflows", "parent.yaml"), PARENT);
  const clock = new FakeClock();
  const credentials = new CredentialStore();
  // Drafting is a workspace-wide grant, so whoever starts a dry run is unrestricted; whoever
  // reads one back may be limited to its own runs, or to some workflows.
  const author = (principal: string) =>
    credentials.issue({
      principal,
      permissions: ["config.read", "config.write", "runs.start", "runs.read"],
      scope: { workflows: "*", runs: "all" },
    });
  const reader = (principal: string, workflows: "*" | string[] = "*") =>
    credentials.issue({ principal, permissions: ["runs.read"], scope: { workflows, runs: "owned" } });
  return {
    dir,
    clock,
    stores: memoryStores(clock),
    credentials,
    ownershipFile: join(dir, "ownership.json"),
    alice: await author("alice"),
    aliceReader: await reader("alice"),
    aliceNarrow: await reader("alice", ["gated"]),
    bobReader: await reader("bob"),
  };
}

/** A token-guarded daemon over `stores`; a second call is the daemon after a restart. */
async function serve(w: Awaited<ReturnType<typeof workspace>>, stores: Stores) {
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry(w.clock),
    workflows: new WorkflowRegistry().register(parseWorkflow(gated("gated"))).register(parseWorkflow(PARENT)),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    humanInput: new PausingHumanInput(),
    logger: silentLogger,
    clock: w.clock,
    lease: { ttlMs: 120_000 },
  });
  const reads = new ReadModel({ orchestrator });
  const config = new ConfigModel({ configDir: w.dir, generations });
  const control = new ControlModel({ orchestrator, reads, config });
  const daemon = await startDaemon({
    orcaVersion: "0.0.0-dry-run",
    capabilities: ["runs.read", "runs.subscribe", "runs.control"],
    workspaceId: "11111111-1111-4111-8111-111111111112",
    reads,
    control,
    config,
    source: orchestrator,
    auth: {
      mode: "token",
      credentials: w.credentials,
      ownership: new OwnershipStore(w.ownershipFile),
      resolver: orchestratorResolver(orchestrator),
      audit: new MemoryAuditSink(),
    },
  });
  daemons.push(daemon);
  const rpc = async (token: string, method: string, params: unknown = {}) => {
    const res = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await res.json()) as {
      ok: boolean;
      result?: unknown;
      error?: { code: string; message: string; details?: unknown };
    };
  };
  return { daemon, orchestrator, rpc };
}

const open = async (rpc: Awaited<ReturnType<typeof serve>>["rpc"], token: string, workflowId: string) => {
  const r = await rpc(token, "workflowDrafts.open", { workflowId });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return (r.result as { revision: number }).revision;
};

describe("workflowDrafts.dryRun behind the guard (#183)", () => {
  it("cannot be granted to a caller whose workflow or run scope is restricted", async () => {
    const w = await workspace();
    // The draft grants are workspace-wide, so a restricted credential cannot carry them, and
    // the call refuses one that somehow does at the guard and again before creating anything.
    await expect(
      w.credentials.issue({
        principal: "carol",
        permissions: ["config.read", "config.write", "runs.start"],
        scope: { workflows: ["parent"], runs: "owned" },
      }),
    ).rejects.toThrow(/cannot be granted to a restricted scope/);
    const s = await serve(w, w.stores);
    const r = await s.rpc(w.aliceReader.token, "workflowDrafts.dryRun", { workflowId: "parent", expectedRevision: 0 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("AUTH_FORBIDDEN");
    expect(await s.orchestrator.listRuns()).toEqual([]);
  });

  it("owns the root for its creator, so the creator's own-runs credential can list and reopen it after a restart", async () => {
    const w = await workspace();
    const first = await serve(w, w.stores);
    const revision = await open(first.rpc, w.alice.token, "parent");
    const r = await first.rpc(w.alice.token, "workflowDrafts.dryRun", {
      workflowId: "parent",
      expectedRevision: revision,
    });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const { runId, report } = WorkflowDraftDryRunResultSchema.parse(r.result);
    expect(report.runs).toHaveLength(2);
    const childId = report.runs[1]!.runId;
    await first.daemon.close();

    // Durable, not this process's memory: a fresh ownership store reads it from disk.
    expect(new OwnershipStore(w.ownershipFile).owner(runId)).toBe("alice");
    const s = await serve(w, w.stores);
    const listed = await s.rpc(w.aliceReader.token, "runs.list", { dryRuns: "only" });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(
      RunsListResultSchema.parse(listed.result)
        .runs.map((run) => run.id)
        .sort(),
    ).toEqual([runId, childId].sort());
    for (const id of [runId, childId]) {
      const again = await s.rpc(w.aliceReader.token, "runs.dryRunReport", { runId: id });
      expect(again.ok, JSON.stringify(again.error)).toBe(true);
      expect(RunsDryRunReportResultSchema.parse(again.result).report.runId).toBe(id);
    }

    // bob may read his own runs only, and this one is not his.
    const theirs = await s.rpc(w.bobReader.token, "runs.list", { dryRuns: "only" });
    expect(RunsListResultSchema.parse(theirs.result).runs).toEqual([]);
    // alice limited to another workflow does not see it either: the scope applies to dry runs.
    const narrow = await s.rpc(w.aliceNarrow.token, "runs.list", { dryRuns: "only" });
    expect(RunsListResultSchema.parse(narrow.result).runs).toEqual([]);
    for (const token of [w.bobReader.token, w.aliceNarrow.token])
      for (const id of [runId, childId]) {
        const hidden = await s.rpc(token, "runs.dryRunReport", { runId: id });
        expect(hidden.ok).toBe(false);
        expect(hidden.error?.code).toBe("RUN_NOT_FOUND");
      }
  });
});
