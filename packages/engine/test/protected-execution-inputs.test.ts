/** Public logs/projections and private execution replay must never share sensitive launch values. */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  consoleLogger,
  OrcaEventSchema,
  RunStateSchema,
  parseWorkflow,
  TemplateRegistry,
  WorkflowRegistry,
  type OrcaEvent,
  type WorkflowDefinition,
} from "@orca/core";
import { builtinExecutors, completed, Orchestrator, PausingHumanInput, type StepContext } from "@orca/engine";
import { fileStores, memoryStores, type Stores } from "@orca/store";
import {
  notificationsFor,
  ReadModel,
  CredentialStore,
  OwnershipStore,
  orchestratorResolver,
  startDaemon,
} from "@orca/daemon";

const TOKEN = "sensitive-launch-token-91a";
const NESTED = "sensitive-nested-token-38b";
const DEFAULT = "sensitive-unused-default-81c";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const directory = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-protected-"));
  directories.push(dir);
  return dir;
};

function definition(id = "protected"): WorkflowDefinition {
  return parseWorkflow(`
id: ${id}
name: Protected
version: "1"
inputSchema:
  fields:
    token: { type: string, sensitive: true, default: ${DEFAULT} }
    config:
      type: object
      properties:
        token: { type: string, sensitive: true }
      default: { token: ${NESTED}, visible: visible }
start: s
nodes:
  s: { type: start }
  probe: { type: custom:probe }
  gate: { type: gate, question: continue, options: [yes, no] }
  after: { type: custom:probe }
  e: { type: end }
edges:
  - { from: s, to: probe }
  - { from: probe, to: gate }
  - { from: gate, to: after }
  - { from: after, to: e }
`);
}

function make(
  stores: Stores,
  defs: WorkflowDefinition[],
  probe: (ctx: StepContext) => Promise<void> = async () => {},
  logs: string[] = [],
) {
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
    workspaceProvider: { name: "fake", provision: async () => ({ hostId: "local", cwd: "/tmp" }) },
    humanInput: new PausingHumanInput(),
    logger: consoleLogger("debug", {}, (line) => logs.push(line)),
  });
}

function noSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [TOKEN, NESTED, DEFAULT]) expect(text).not.toContain(secret);
}

describe("protected execution inputs", () => {
  it("keeps admission, live projections, agent payloads, diagnostics and both notification paths public", async () => {
    const stores = memoryStores();
    const events: OrcaEvent[] = [];
    stores.events.subscribe((event) => events.push(event));
    const logs: string[] = [];
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const orc = make(
      stores,
      [definition()],
      async (ctx) => {
        expect(ctx.run.state.run.vars.token).toBe(TOKEN);
        expect((await ctx.evalContext()).vars).toMatchObject({ token: TOKEN });
        ctx.logger.child({ secret: TOKEN }).info(`token=${TOKEN}`, { nested: [NESTED] });
        await ctx.emit({ type: "vars.set", payload: { vars: { copied: TOKEN, ordinary: 3 } } });
        await ctx.emit({
          type: "agent.update",
          payload: {
            stepRunId: ctx.step.id,
            sessionId: "session",
            update: { kind: "agent_message_chunk", text: TOKEN },
          },
        });
        reached();
        await held;
      },
      logs,
    );
    const id = await orc.startRun({ workflowId: "protected", vars: { token: TOKEN } });
    noSecrets(await stores.events.read(id));
    const running = orc.run(id);
    await ready;
    noSecrets(await orc.getState(id));
    noSecrets(await new ReadModel({ orchestrator: orc }).runsGet({ runId: id }));
    release();
    const state = await running;
    expect(state.run.vars).toMatchObject({
      token: "[REDACTED]",
      config: "[REDACTED]",
      copied: "[REDACTED]",
      ordinary: 3,
    });
    noSecrets(state);
    noSecrets(logs);
    noSecrets(events.flatMap((event) => notificationsFor(event, "live")));
    noSecrets((await orc.eventsRange(id)).flatMap((event) => notificationsFor(event, "replay")));
    expect((await stores.execution.getInputs(id))?.vars.token).toBe(TOKEN);
  });

  it("restores exact initial and later vars after a file-backed restart on the pinned definition", async () => {
    const dir = await directory();
    const stores = fileStores(dir);
    const original = definition();
    const first = make(stores, [original], async (ctx) => {
      await ctx.emit({ type: "vars.set", payload: { vars: { copied: TOKEN, ordinary: 42 } } });
    });
    const id = await first.startRun({ workflowId: original.id, vars: { token: TOKEN } });
    await first.run(id);
    const changed = structuredClone(original);
    changed.nodes.e = { type: "custom:probe" };
    const restartedStores = fileStores(dir);
    const resumed: Record<string, unknown>[] = [];
    const restored = make(restartedStores, [changed], async (ctx) => {
      resumed.push(structuredClone(ctx.run.state.run.vars));
    });
    const requests = await restored.pendingInputs(id);
    await restored.answer(requests[0]!.id, "yes", id);
    expect((await restored.resume(id)).run.status).toBe("completed");
    expect((await restored.getState(id)).run.vars.ordinary).toBe(42);
    expect(resumed).toEqual([expect.objectContaining({ token: TOKEN, copied: TOKEN, ordinary: 42 })]);
    noSecrets(await readFile(join(dir, "runs", `${id}.jsonl`), "utf8"));
    const inputs = await restartedStores.execution.getInputs(id);
    expect(inputs?.vars.token).toBe(TOKEN);
    const privateNames = await readdir(join(dir, "private-execution"));
    expect(privateNames.some((name) => name.endsWith(".payload.json"))).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(join(dir, "private-execution"))).mode & 0o777).toBe(0o700);
      for (const name of privateNames)
        expect((await stat(join(dir, "private-execution", name))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "private-workflows", "protected@v1.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a missing protected workflow snapshot instead of falling back to same-version source", async () => {
    const dir = await directory();
    const original = definition();
    const orc = make(fileStores(dir), [original]);
    const parked = await orc.startAndRun({ workflowId: original.id, vars: { token: TOKEN } });
    const changed = structuredClone(original);
    changed.edges = [{ from: "s", to: "e" }];
    await rm(join(dir, "private-workflows", "protected@v1.json"));
    await expect(make(fileStores(dir), [changed]).resume(parked.run.id)).rejects.toMatchObject({
      code: "WORKFLOW_VERSION_NOT_FOUND",
    });
  });

  it("fails closed when protected execution records are missing or corrupt without echoing bytes", async () => {
    const dir = await directory();
    const stores = fileStores(dir);
    const orc = make(stores, [definition()]);
    const id = await orc.startRun({ workflowId: "protected", vars: { token: TOKEN } });
    const path = join(dir, "private-execution", `${id}.inputs.json`);
    await writeFile(path, `invalid ${TOKEN}`);
    await expect(make(fileStores(dir), [definition()]).run(id)).rejects.toMatchObject({ code: "RUN_STATE" });
    await rm(path);
    await expect(make(fileStores(dir), [definition()]).run(id)).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(orc.getState(id)).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(fileStores(dir).events.append({ type: "run.started", runId: id, payload: {} })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
  });

  it.each(["s", 1, true, false])("preserves metadata and opaque projection shapes for sensitive %s", async (secret) => {
    const def = definition();
    def.inputSchema = {
      fields: {
        token: {
          type: typeof secret === "number" ? "number" : typeof secret === "boolean" ? "boolean" : "string",
          sensitive: true,
        },
      },
    };
    if (def.nodes.gate?.type === "gate") def.nodes.gate.options = [{ id: "ship", label: "ship", destructive: true }];
    const stores = memoryStores();
    const orc = make(stores, [def], async (ctx) => {
      await ctx.emit({ type: "vars.set", payload: { vars: { copied: secret, box: { [String(secret)]: secret } } } });
      await ctx.emit({
        type: "agent.update",
        payload: {
          stepRunId: ctx.step.id,
          sessionId: "session",
          update: {
            kind: "tool_call_update",
            status: "in_progress",
            args: { text: String(secret), length: 1 },
            text: String(secret),
          },
        },
      });
    });
    const state = await orc.startAndRun({ workflowId: def.id, vars: { token: secret } });
    expect(state.run.status).toBe("paused");
    expect(state.run.workflowId).toBe("protected");
    expect(state.run.vars.token).toBe("[REDACTED]");
    expect(state.run.vars.copied).toBe("[REDACTED]");
    expect(state.run.vars.box).toEqual({ "[REDACTED]": "[REDACTED]" });
    expect(RunStateSchema.safeParse(state).success).toBe(true);
    for (const event of await orc.events(state.run.id)) expect(OrcaEventSchema.safeParse(event).success).toBe(true);
    expect((await orc.events(state.run.id)).find((event) => event.type === "step.scheduled")?.payload.attempt).toBe(1);
    const gate = Object.values(state.humanInputs)[0]!;
    expect(gate.options[0]).toMatchObject({ id: "ship", destructive: true });
    await orc.answer(gate.id, "ship", state.run.id);
    expect((await orc.resume(state.run.id)).run.status).toBe("completed");
  });

  it("removes copied dynamic keys from private object values and nested event diagnostics", async () => {
    const stores = memoryStores();
    const orc = make(stores, [definition()], async (ctx) => {
      await ctx.emit({ type: "vars.set", payload: { vars: { copied: { [TOKEN]: { [NESTED]: TOKEN } } } } });
      await ctx.emit({
        type: "agent.session.closed",
        payload: {
          stepRunId: ctx.step.id,
          sessionId: "session",
          error: {
            code: "AGENT_ERROR",
            message: TOKEN,
            details: { [TOKEN]: { [NESTED]: TOKEN } },
          },
        },
      });
    });
    const state = await orc.startAndRun({ workflowId: "protected", vars: { token: TOKEN } });
    noSecrets(state);
    noSecrets(await stores.events.read(state.run.id));
  });

  it("promotes child-only defaults before exact childVars reach a parent and survives restart", async () => {
    const dir = await directory();
    const parent = parseWorkflow(`id: parent-only
name: Parent
version: '1'
start: call
nodes:
  call: { type: subworkflow, workflow: secret-child }
  probe: { type: custom:probe }
  gate: { type: gate, question: Continue?, options: [yes] }
  after: { type: custom:probe }
  end: { type: end }
edges: [{ from: call, to: probe }, { from: probe, to: gate }, { from: gate, to: after }, { from: after, to: end }]`);
    const child = parseWorkflow(`id: secret-child
name: Child
version: '1'
inputSchema:
  fields:
    token: { type: string, sensitive: true, default: ${TOKEN} }
start: end
nodes: { end: { type: end } }
edges: []`);
    const logs: string[] = [];
    const probe = async (ctx: StepContext) => {
      const value = await ctx.evaluate("steps.call.result.data.childVars.token");
      expect(value).toBe(TOKEN);
      ctx.logger.info(`child token ${String(value)}`, { child: value });
      await ctx.emit({ type: "vars.set", payload: { vars: { copied: value } } });
    };
    const stores = fileStores(dir);
    const first = make(stores, [parent, child], probe, logs);
    const parked = await first.startAndRun({ workflowId: parent.id });
    expect(parked.run.status).toBe("paused");
    noSecrets(parked);
    noSecrets(logs);
    expect((await stores.execution.getInputs(parked.run.id))?.vars).toEqual({});
    expect((await stores.execution.getInputs(parked.run.id))?.secrets).toContain(TOKEN);
    const reads = new ReadModel({ orchestrator: first });
    const credentials = new CredentialStore();
    const token = (await credentials.issue({ principal: "parent-test", preset: "owner" })).token;
    const daemon = await startDaemon({
      orcaVersion: "integration",
      reads,
      source: first,
      capabilities: ["runs.read"],
      auth: { mode: "token", credentials, ownership: new OwnershipStore(), resolver: orchestratorResolver(first) },
    });
    try {
      for (const method of ["runs.get", "runs.events"]) {
        const response = await fetch(`${daemon.url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ kind: "request", id: 1, method, params: { runId: parked.run.id } }),
        });
        const reply = (await response.json()) as { ok: boolean };
        expect(reply.ok).toBe(true);
        noSecrets(reply);
      }
    } finally {
      await daemon.close();
    }
    const restarted = make(fileStores(dir), [parent, child], probe, logs);
    const [gate] = await restarted.pendingInputs(parked.run.id);
    await restarted.answer(gate!.id, "yes", parked.run.id);
    const completed = await restarted.resume(parked.run.id);
    expect(completed.run.status).toBe("completed");
    noSecrets(completed);
    noSecrets(logs);
    noSecrets(await readFile(join(dir, "runs", `${parked.run.id}.jsonl`), "utf8"));
  });

  it("updates already-created logger bindings before returning a sensitive child", async () => {
    const parent = parseWorkflow(`id: logger-parent
name: Parent
start: p
nodes: { p: { type: custom:probe }, e: { type: end } }
edges: [{ from: p, to: e }]`);
    const child = parseWorkflow(`id: logger-child
name: Child
inputSchema:
  fields:
    token: { type: string, sensitive: true, default: ${TOKEN} }
start: e
nodes: { e: { type: end } }
edges: []`);
    const logs: string[] = [];
    const stores = memoryStores();
    const orc = make(
      stores,
      [parent, child],
      async (ctx) => {
        const early = ctx.logger.child({ existingBinding: TOKEN });
        const result = await ctx.runChild({ workflow: child.id }, {});
        expect(result.run.vars.token).toBe(TOKEN);
        early.info(`after child ${TOKEN}`);
      },
      logs,
    );
    const state = await orc.startAndRun({ workflowId: parent.id });
    expect(state.run.status).toBe("completed");
    noSecrets(logs);
    noSecrets(state);
    noSecrets(await stores.events.read(state.run.id));
  });

  it("fails closed if a child's propagated sensitivity record is removed after a restart", async () => {
    const dir = await directory();
    const parent = parseWorkflow(`id: promoted
name: Parent
start: p
nodes: { p: { type: subworkflow, workflow: promoted-child }, g: { type: gate, question: Continue?, options: [yes] }, e: { type: end } }
edges: [{ from: p, to: g }, { from: g, to: e }]`);
    const child = parseWorkflow(`id: promoted-child
name: Child
inputSchema:
  fields:
    token: { type: string, sensitive: true, default: ${TOKEN} }
start: e
nodes: { e: { type: end } }
edges: []`);
    const stores = fileStores(dir);
    const orc = make(stores, [parent, child]);
    const state = await orc.startAndRun({ workflowId: parent.id });
    const overlay = (await readdir(join(dir, "private-execution"))).find((name) =>
      name.startsWith(`${state.run.id}.sensitivity.`),
    )!;
    expect(overlay).toBeTruthy();
    await rm(join(dir, "private-execution", overlay));
    await expect(make(fileStores(dir), [parent, child]).run(state.run.id)).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(fileStores(dir).events.read(state.run.id)).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(fileStores(dir).events.readRange(state.run.id, { limit: 1 })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    await expect(fileStores(dir).events.readTypes(state.run.id, ["run.created"])).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    await expect(
      fileStores(dir).events.append({ type: "run.resumed", runId: state.run.id, payload: {} }),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("inherits secret values and sensitivity through an undeclared child", async () => {
    const parent = definition("parent");
    parent.nodes.probe = { type: "subworkflow", workflow: "child", vars: {} };
    const child = parseWorkflow(
      `id: child\nname: child\nstart: p\nnodes:\n  p: { type: custom:probe }\n  e: { type: end }\nedges: [{ from: p, to: e }]`,
    );
    const stores = memoryStores();
    const observed: unknown[] = [];
    const orc = make(stores, [parent, child], async (ctx) => {
      observed.push(structuredClone(ctx.run.state.run.vars));
    });
    const id = await orc.startRun({ workflowId: "parent", vars: { token: TOKEN } });
    const state = await orc.run(id);
    const childId = Object.values(state.steps).flatMap((step) => step.childRunIds)[0]!;
    expect(observed).toEqual([expect.objectContaining({ token: TOKEN })]);
    expect((await stores.execution.getInputs(childId))?.sensitiveNames).toEqual(
      expect.arrayContaining(["token", "config"]),
    );
    noSecrets(await orc.getState(childId));
    noSecrets(await stores.events.read(childId));
  });
});
