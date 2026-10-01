/** Independent-review regressions for inherited integrity, legacy adapters and schema-safe execution metadata. */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  OrcaEventSchema,
  OrcaError,
  parseWorkflow,
  RunStateSchema,
  TemplateRegistry,
  WorkflowRegistry,
  type WorkflowDefinition,
} from "@orca/core";
import { builtinExecutors, completed, Orchestrator, PausingHumanInput, type StepContext } from "@orca/engine";
import { fileStores, InMemoryEventStore, memoryStores, ProtectedEventStore, type Stores } from "@orca/store";

const SECRET = "review-boundary-secret-492f";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const simple = (id: string) =>
  parseWorkflow(`id: ${id}\nname: ${id}\nversion: '1'\nstart: e\nnodes: { e: { type: end } }\nedges: []`);
const sensitive = (id: string) =>
  parseWorkflow(
    `id: ${id}\nname: ${id}\nversion: '1'\ninputSchema:\n  fields: { token: { type: string, sensitive: true, default: ${SECRET} } }\nstart: e\nnodes: { e: { type: end } }\nedges: []`,
  );
function make(stores: Stores, defs: WorkflowDefinition[], probe: (ctx: StepContext) => Promise<void> = async () => {}) {
  const workflows = new WorkflowRegistry();
  defs.forEach((def) => workflows.register(def));
  const executors = builtinExecutors();
  executors.register({
    type: "custom:probe",
    execute: async (ctx) => {
      await probe(ctx);
      return completed();
    },
  });
  return new Orchestrator({
    stores,
    workflows,
    executors,
    agents: new AgentRegistry(),
    templates: new TemplateRegistry(),
    humanInput: new PausingHumanInput(),
    workspaceProvider: { name: "fake", provision: async () => ({ hostId: "local", cwd: "/tmp" }) },
  });
}

it("refuses an explicit-workspace child before writes when its parent's sealed sensitivity overlay is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-review-parent-"));
  dirs.push(dir);
  const parent = parseWorkflow(
    `id: parent\nname: Parent\nversion: '1'\nstart: sub\nnodes: { sub: { type: subworkflow, workflow: secret-child }, gate: { type: gate, question: Continue?, options: [yes] }, end: { type: end } }\nedges: [{ from: sub, to: gate }, { from: gate, to: end }]`,
  );
  const child = sensitive("secret-child");
  const stores = fileStores(dir);
  const parked = await make(stores, [parent, child]).startAndRun({ workflowId: parent.id });
  const existing = await stores.events.listRuns();
  const privateDir = join(dir, "private-execution");
  const overlay = (await readdir(privateDir)).find((name) => name.startsWith(`${parked.run.id}.sensitivity.`))!;
  expect(overlay).toBeTruthy();
  await rm(join(privateDir, overlay));
  const ordinary = simple("new-ordinary");
  const restarted = make(fileStores(dir), [parent, child, ordinary]);
  await expect(
    restarted.startRun({
      workflowId: ordinary.id,
      parentRunId: parked.run.id,
      vars: { copied: SECRET },
      workspace: { hostId: "local", cwd: "/tmp/explicit" },
    }),
  ).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(await stores.events.listRuns()).toEqual(existing);
  expect(await stores.workflows.versions(ordinary.id)).toEqual([]);
  for (const name of await readdir(join(dir, "runs")))
    expect(await readFile(join(dir, "runs", name), "utf8")).not.toContain(SECRET);
});

it("wraps a custom raw event store with the workflow-aware legacy guard", async () => {
  const base = memoryStores();
  const raw = new InMemoryEventStore();
  const legacy = sensitive("legacy");
  await base.workflows.put(legacy);
  await raw.append({
    type: "run.created",
    runId: "legacy-run",
    payload: {
      workflowId: legacy.id,
      workflowVersion: legacy.version,
      workflowStored: true,
      workspace: { hostId: "local", cwd: "/tmp" },
      vars: { token: SECRET },
    },
  });
  const ordinary = simple("new-child");
  const stores = { ...base, events: raw };
  const orc = make(stores, [legacy, ordinary]);
  expect(orc.stores.events).toBeInstanceOf(ProtectedEventStore);
  await expect(orc.getState("legacy-run")).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(orc.events("legacy-run")).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(
    orc.startRun({
      workflowId: ordinary.id,
      parentRunId: "legacy-run",
      vars: { copied: SECRET },
      workspace: { hostId: "local", cwd: "/tmp" },
    }),
  ).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(await raw.listRuns()).toEqual(["legacy-run"]);
  expect(await stores.workflows.versions(ordinary.id)).toEqual([]);
});

describe("legacy inherited sensitivity", () => {
  it.each(["root::loop", "registered-child"])(
    "withholds %s even without a child's own input declaration",
    async (workflowId) => {
      const base = memoryStores();
      const raw = new InMemoryEventStore();
      await base.workflows.put(sensitive("root"));
      if (!workflowId.includes("::")) await base.workflows.put(simple(workflowId));
      for (const [runId, id, parent] of [
        ["root-run", "root", undefined],
        ["middle-run", "middle", "root-run"],
        ["child-run", workflowId, workflowId.includes("::") ? undefined : "middle-run"],
      ] as const)
        await raw.append({
          type: "run.created",
          runId,
          payload: {
            workflowId: id,
            workflowVersion: "1",
            workflowStored: true,
            workspace: { hostId: "local", cwd: "/tmp" },
            vars: { token: SECRET },
            ...(parent ? { parentRunId: parent } : {}),
          },
        });
      const publicEvents = new ProtectedEventStore(raw, base.execution, base.workflows);
      for (const runId of ["root-run", "middle-run", "child-run"]) {
        await expect(publicEvents.read(runId)).rejects.toMatchObject({ code: "RUN_STATE" });
        await expect(publicEvents.readTypes(runId, ["run.created"])).rejects.toMatchObject({ code: "RUN_STATE" });
        await expect(publicEvents.readRange(runId, { limit: 1 })).rejects.toMatchObject({ code: "RUN_STATE" });
        await expect(publicEvents.append({ type: "run.started", runId, payload: {} })).rejects.toMatchObject({
          code: "RUN_STATE",
        });
        expect(await raw.lastSeq(runId)).toBe(0);
      }
    },
  );
});

it("does not retroactively withhold an ordinary parallel sibling when a secret sibling promotes the parent", async () => {
  const parent = parseWorkflow(
    `id: siblings\nname: Siblings\nstart: fan\nnodes:\n  fan:\n    type: parallel\n    concurrency: 2\n    branches:\n      ordinary: { workflow: ordinary }\n      secret: { workflow: secret }\n  end: { type: end }\nedges: [{ from: fan, to: end }]`,
  );
  const ordinary = parseWorkflow(
    `id: ordinary\nname: Ordinary\nstart: hold\nnodes: { hold: { type: custom:probe }, end: { type: end } }\nedges: [{ from: hold, to: end }]`,
  );
  const stores = memoryStores();
  let release!: () => void;
  const secretFinished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const unsubscribe = stores.events.subscribe((event) => {
    if (event.type === "child.finished") release();
  });
  const orc = make(stores, [parent, ordinary, sensitive("secret")], async () => {
    await secretFinished;
  });
  try {
    const result = await orc.startAndRun({ workflowId: parent.id });
    expect(result.run.status).toBe("completed");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    for (const id of await stores.events.listRuns()) expect((await orc.getState(id)).run.status).toBe("completed");
    const childStates = await Promise.all((await stores.events.listRuns()).map((id) => orc.getState(id)));
    const ordinaryState = childStates.find((state) => state.run.workflowId === "ordinary")!;
    expect(ordinaryState).toBeTruthy();
    expect(await stores.execution.getInputs(ordinaryState.run.id)).toBeUndefined();
    expect((await stores.execution.getInputs(result.run.id))?.secrets).toContain(SECRET);
  } finally {
    unsubscribe();
  }
});

it.each(["yes", "s", true, false, 1])(
  "preserves canonical workspace, gate and routing metadata with secret %s",
  async (secret) => {
    const def = parseWorkflow(
      `id: metadata\nname: Metadata\ninputSchema:\n  fields: { token: { type: ${typeof secret === "number" ? "number" : typeof secret === "boolean" ? "boolean" : "string"}, sensitive: true } }\nstart: s\nnodes:\n  s: { type: gate, question: Continue?, options: [{ id: yes, label: Yes, destructive: true }] }\n  end: { type: end }\nedges: [{ from: s, to: end, when: "choice == 'yes'" }]`,
    );
    const stores = memoryStores();
    const orc = make(stores, [def]);
    const id = await orc.startRun({
      workflowId: def.id,
      vars: { token: secret },
      workspace: { hostId: "yes", provider: "yes", cwd: "/tmp" },
    });
    await orc.run(id);
    const [gate] = await orc.pendingInputs(id);
    expect(gate!.options[0]).toMatchObject({ id: "yes", destructive: true });
    expect((await orc.answer(gate!.id, "yes", id)).answer).toBe("yes");
    const result = await orc.resume(id);
    expect(result.run.status).toBe("completed");
    expect(result.run.workspace).toMatchObject({ hostId: "yes", provider: "yes" });
    expect(result.run.vars.token).toBe("[REDACTED]");
    expect(
      Object.values(result.steps).find((step) => step.nodeId === "s" && step.status === "completed")?.result?.choice,
    ).toBe("yes");
    const events = await stores.events.read(id);
    expect(events.filter((event) => event.type === "decision.resolved").map((event) => event.payload.choice)).toEqual([
      "yes",
    ]);
    expect(
      events.find((event) => event.type === "step.scheduled" && event.payload.nodeId === "end")?.payload,
    ).toMatchObject({ viaEdge: { from: "s" } });
    expect(RunStateSchema.safeParse(result).success).toBe(true);
    for (const event of events) expect(OrcaEventSchema.safeParse(event).success).toBe(true);
  },
);

it.each([false, true])(
  "preserves prior-sibling artifacts or refuses corrupted protected replay (corrupt=%s)",
  async (corrupt) => {
    const dir = await mkdtemp(join(tmpdir(), "orca-review-sibling-"));
    dirs.push(dir);
    const flow = (id: string) =>
      parseWorkflow(
        `id: ${id}\nname: ${id}\nstart: probe\nnodes: { probe: { type: custom:probe }, end: { type: end } }\nedges: [{ from: probe, to: end }]`,
      );
    const parent = flow("coordinator");
    const producer = flow("producer");
    producer.inputSchema = { fields: { token: { type: "string", sensitive: true, default: SECRET } } };
    const consumer = flow("consumer");
    const stores = fileStores(dir);
    const visible: string[][] = [];
    const consumerStatuses: string[] = [];
    const orc = make(stores, [parent, producer, consumer], async (ctx) => {
      if (ctx.definition.id === producer.id) {
        await ctx.recordArtifact(
          { kind: "generic", name: "prior", path: join(dir, "prior.txt"), required: true },
          "prior artifact",
        );
        return;
      }
      if (ctx.definition.id === consumer.id) {
        const context = await ctx.evalContext();
        visible.push(Object.keys(context.artifacts as Record<string, unknown>));
        return;
      }
      const first = await ctx.runChild({ workflow: producer.id }, { branch: "first" });
      expect(first.run.status).toBe("completed");
      const artifact = (await stores.events.read(first.run.id)).find((event) => event.type === "artifact.recorded")!;
      expect(artifact.executionPayloadRef).toBeTruthy();
      if (corrupt) await rm(join(dir, "private-execution", `${artifact.executionPayloadRef!}.payload.json`));
      const second = await ctx.runChild({ workflow: consumer.id }, { branch: "second" });
      consumerStatuses.push(second.run.status);
      if (second.run.status !== "completed")
        throw new OrcaError("RUN_STATE", "consumer refused protected sibling state");
    });
    const result = await orc.startAndRun({ workflowId: parent.id });
    expect(result.run.status).toBe(corrupt ? "failed" : "completed");
    expect(consumerStatuses).toEqual([corrupt ? "failed" : "completed"]);
    expect(visible).toEqual(corrupt ? [] : [["prior"]]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  },
);
