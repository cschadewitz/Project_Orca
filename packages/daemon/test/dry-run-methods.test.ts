/**
 * Dry runs over the daemon (#183, protocol 2.9): `workflowDrafts.dryRun` simulates the caller's
 * own draft and answers with the report, `runs.dryRunReport` reads it again, `runs.list` keeps
 * dry runs out of the work it lists unless asked, and a dry run its daemon never finished is
 * settled on the next start. A real interpreter over memory stores; the draft is a real file.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, OrcaError, TemplateRegistry, WorkflowRegistry, parseWorkflow, silentLogger } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput, startDryRun } from "@orca/engine";
import {
  RunsDryRunReportResultSchema,
  RunsGetResultSchema,
  RunsListResultSchema,
  WorkflowDraftDryRunResultSchema,
} from "@orca/protocol";
import { memoryStores } from "@orca/store";
import { ConfigModel, ControlModel, ReadModel, dispatch, methodsFor, type MethodContext } from "@orca/daemon";
import { WorkflowDraftService } from "../src/workflow-drafts.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const GATED = `id: gated
name: Gated
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

function orchestratorOver(stores = memoryStores(new FakeClock())) {
  const clock = new FakeClock();
  const sessionFactory = vi.fn(() => Promise.reject(new Error("a dry run opened a session")));
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry(clock).addHost(new LocalHost({ id: "local", type: "local" })),
    workflows: new WorkflowRegistry().register(parseWorkflow(GATED)),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    humanInput: new PausingHumanInput(),
    sessionFactory: sessionFactory,
    logger: silentLogger,
    clock,
  });
  return { orchestrator, stores, sessionFactory };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "orca-dry-run-methods-"));
  dirs.push(dir);
  await mkdir(join(dir, "workflows"));
  await writeFile(join(dir, "orca.config.yaml"), "workflows: ['workflows/*.yaml']\ntemplates: []\n");
  await writeFile(join(dir, "workflows", "gated.yaml"), GATED);
  const config = new ConfigModel({ configDir: dir });
  const readConfig = async () => {
    const view = await config.get();
    return {
      ...view,
      generation: {
        savedRevision: view.config.revision,
        activeRevision: view.config.revision,
        activeGeneration: "11111111-1111-4111-8111-111111111111",
        state: "active" as const,
        restartRequired: [],
      },
    };
  };
  const drafts = new WorkflowDraftService({
    baseDir: dir,
    readConfig,
    exclusive: async (command) => command(),
    validationContext: () => ({}),
    applyLocked: async () => {
      throw new Error("not under test");
    },
  });
  const o = orchestratorOver();
  const reads = new ReadModel({ orchestrator: o.orchestrator });
  const control = new ControlModel({ orchestrator: o.orchestrator, reads });
  const ctx: MethodContext = {
    orcaVersion: "0.8.0-test",
    capabilities: ["runs.read", "runs.subscribe", "runs.control"],
    identity: { workspaceId: "w", instanceId: "i" },
    reads,
    control,
    config: { canApply: true, workflowDrafts: drafts } as never,
  };
  return { ...o, drafts, reads, control, ctx };
}

async function call(ctx: MethodContext, method: string, params?: unknown) {
  const res = await dispatch(JSON.stringify({ kind: "request", id: 7, method, params }), methodsFor(ctx), ctx);
  return res as { ok: boolean; result?: unknown; error?: { code: string; message: string; details?: unknown } };
}

describe("workflowDrafts.dryRun", () => {
  it("simulates the caller's draft at the revision named, and answers with the report", async () => {
    const h = await harness();
    const draft = await h.drafts.open("gated", { principalId: "local", read: async () => {}, write: async () => {} });

    const res = await call(h.ctx, "workflowDrafts.dryRun", {
      workflowId: "gated",
      expectedRevision: draft.revision,
      fixtures: { choices: { gate: "hold" } },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const result = WorkflowDraftDryRunResultSchema.parse(res.result);
    expect(result.run).toMatchObject({ id: result.runId, dryRun: { draftRevision: draft.revision } });
    expect(result.report).toMatchObject({ runId: result.runId, status: "completed", outcome: "failure" });
    expect(result.report.choices).toEqual([
      expect.objectContaining({ nodeId: "gate", choice: "hold", source: expect.stringMatching(/fixture/) }),
    ]);
    expect(result.report.unreachedNodes).toEqual([expect.objectContaining({ nodeIds: ["shipped"] })]);
    // No question was parked for anybody, and no agent was asked.
    expect(await h.orchestrator.pendingInputs(result.runId)).toEqual([]);
    expect(h.sessionFactory).not.toHaveBeenCalled();

    // The run reads like any other, from the definition it simulated rather than a stored version.
    const got = await call(h.ctx, "runs.get", { runId: result.runId });
    expect(got.ok, JSON.stringify(got.error)).toBe(true);
    expect(RunsGetResultSchema.parse(got.result).run.dryRun).toMatchObject({ draftRevision: draft.revision });

    // And the report reads back the same.
    const again = await call(h.ctx, "runs.dryRunReport", { runId: result.runId });
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(RunsDryRunReportResultSchema.parse(again.result).report).toEqual(result.report);
  });

  it("refuses a revision the draft has moved past, and a workflow with no draft", async () => {
    const h = await harness();
    await h.drafts.open("gated", { principalId: "local", read: async () => {}, write: async () => {} });
    const stale = await call(h.ctx, "workflowDrafts.dryRun", { workflowId: "gated", expectedRevision: 3 });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("CONFIG_STALE");
    expect(await h.orchestrator.listRuns()).toEqual([]);
  });

  it("refuses a fixture that does not fit the draft, and starts nothing", async () => {
    const h = await harness();
    const draft = await h.drafts.open("gated", { principalId: "local", read: async () => {}, write: async () => {} });
    const res = await call(h.ctx, "workflowDrafts.dryRun", {
      workflowId: "gated",
      expectedRevision: draft.revision,
      fixtures: { choices: { gate: "maybe" } },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("DRY_RUN_FIXTURE_INVALID");
  });

  it("is not offered by a read-only daemon", async () => {
    const h = await harness();
    const { control: _control, ...readOnly } = h.ctx;
    expect(Object.keys(methodsFor(readOnly))).not.toContain("workflowDrafts.dryRun");
    expect(Object.keys(methodsFor(readOnly))).toContain("runs.dryRunReport");
  });
});

describe("ControlModel.dryRun's bound authority", () => {
  it("rechecks the caller before creating anything, and owns the root before it is driven", async () => {
    const h = await harness();
    const definition = parseWorkflow(GATED);
    await expect(
      h.control.dryRun(definition, 0, {}, undefined, {
        authorize: () => Promise.reject(new OrcaError("WORKFLOW_NOT_FOUND", "no")),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
    expect(await h.orchestrator.listRuns()).toEqual([]);

    const attributed: { runId: string; events: number }[] = [];
    const result = await h.control.dryRun(definition, 0, {}, undefined, {
      attributeStartedRun: async (runId) => {
        attributed.push({ runId, events: (await h.stores.events.read(runId)).length });
      },
    });
    // Called once, for the root, while its log held only `run.created`.
    expect(attributed).toEqual([{ runId: result.runId, events: 1 }]);
  });

  it("cancels the root undriven when ownership cannot be recorded", async () => {
    const h = await harness();
    await expect(
      h.control.dryRun(parseWorkflow(GATED), 0, {}, undefined, {
        attributeStartedRun: () => Promise.reject(new OrcaError("INTERNAL", "ownership could not be persisted")),
      }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    const [runId] = await h.orchestrator.listRuns();
    const state = await h.orchestrator.getState(runId!);
    expect(state.run.status).toBe("cancelled");
    expect(state.stepOrder).toEqual([]);
  });
});

describe("runs.list and runs.dryRunReport", () => {
  it("leaves dry runs out of the work it lists unless asked", async () => {
    const h = await harness();
    const live = await h.orchestrator.startAndRun({ workflowId: "gated" });
    const dry = await startDryRun(h.orchestrator, { definition: parseWorkflow(GATED) });
    await dry.done;

    const list = async (params: Record<string, unknown>) => {
      const res = await call(h.ctx, "runs.list", params);
      expect(res.ok, JSON.stringify(res.error)).toBe(true);
      return RunsListResultSchema.parse(res.result).runs.map((r) => r.id);
    };
    expect(await list({})).toEqual([live.run.id]);
    expect(await list({ dryRuns: "exclude" })).toEqual([live.run.id]);
    expect(await list({ dryRuns: "only" })).toEqual([dry.runId]);
    expect((await list({ dryRuns: "include" })).sort()).toEqual([live.run.id, dry.runId].sort());
    // Naming a run asks for it, dry or not.
    expect(await list({ runIds: [dry.runId] })).toEqual([dry.runId]);
  });

  it("refuses to report on a run that is not a dry run", async () => {
    const h = await harness();
    const live = await h.orchestrator.startAndRun({ workflowId: "gated" });
    const res = await call(h.ctx, "runs.dryRunReport", { runId: live.run.id });
    expect(res.ok).toBe(false);
    const missing = await call(h.ctx, "runs.dryRunReport", { runId: "run_nope" });
    expect(missing.ok).toBe(false);
  });
});

describe("settleInterruptedDryRuns", () => {
  it("cancels a dry run a stopped daemon left unfinished, and leaves finished and live runs alone", async () => {
    // A dry run as a daemon that died mid-run leaves it: the log up to its first step.
    const first = orchestratorOver();
    const dry = await startDryRun(first.orchestrator, { definition: parseWorkflow(GATED) });
    await dry.done;
    const events = await first.stores.events.read(dry.runId);
    const cut = events.findIndex((e) => e.type === "step.started");
    expect(cut).toBeGreaterThan(0);

    const h = await harness();
    for (const e of events.slice(0, cut + 1))
      await h.stores.events.append({ type: e.type, runId: e.runId, payload: e.payload } as never);
    const finished = await startDryRun(h.orchestrator, { definition: parseWorkflow(GATED) });
    await finished.done;
    const live = await h.orchestrator.startAndRun({ workflowId: "gated" });
    expect(live.run.status).toBe("paused");

    expect(await h.control.settleInterruptedDryRuns(0)).toEqual([dry.runId]);
    expect((await h.orchestrator.getState(dry.runId)).run.status).toBe("cancelled");
    expect((await h.orchestrator.getState(live.run.id)).run.status).toBe("paused");
    // Once settled there is nothing left to do.
    expect(await h.control.settleInterruptedDryRuns(0)).toEqual([]);
  });
});
