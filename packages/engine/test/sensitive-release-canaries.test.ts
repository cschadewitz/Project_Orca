/**
 * Release canary audit (#363). Synthetic sensitive launch values must not reach a public
 * reader through ORCA's own rendering, provenance, errors, logs or terminal formatting.
 * Agents and executors are the authorized execution boundary and still get exact values.
 * Every canary here is synthetic; no real credential, path or account data is involved.
 */
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  consoleLogger,
  OrcaError,
  parseOrcaConfig,
  parseWorkflow,
  sha256,
  TemplateRegistry,
  WorkflowRegistry,
  type OrcaEvent,
} from "@orca/core";
import { builtinExecutors, completed, Orchestrator, PausingHumanInput, type StepContext } from "@orca/engine";
import { executionEvents, memoryStores, type Stores } from "@orca/store";
import { notificationsFor, ReadModel } from "@orca/daemon";
import { formatEvent, formatPaused, formatRunState } from "../../cli/src/format.js";
import { ConfigurationGenerations } from "../src/configuration-generation.js";
import { harness } from "./helpers.js";

// Every third character of a tail is one of i/l/o/u, which neither ULIDs nor hex contain,
// so a six-character window can only match the canary itself, in any letter case.
const TOKEN = "SYNTHETIC-CANARY-TOKEN-q7uX9lM4oT8iW3uK";
const PEM_A = "SYNTHETIC-CANARY-PEMA-h3iN6lC1oZ5uS0iY";
const PEM_B = "SYNTHETIC-CANARY-PEMB-u8oF2iA7lW4uR9oV";
const ROUTE = "SYNTHETIC-CANARY-ROUTE-k5lD1oS8uC3iH6lJ";
const KEY = "SYNTHETIC-CANARY-KEY-b2uG7oT4iP9lE6uR";
const CANARIES = [TOKEN, PEM_A, PEM_B, ROUTE, KEY];

/** Any six-character window of a canary's unique tail, ignoring case, is a disclosure. */
function exposed(value: unknown): string[] {
  const text = (typeof value === "string" ? value : JSON.stringify(value)).toLowerCase();
  return CANARIES.flatMap((canary) => {
    const tail = canary.slice(canary.lastIndexOf("-") + 1).toLowerCase();
    return Array.from({ length: tail.length - 5 }, (_, i) => tail.slice(i, i + 6)).filter((w) => text.includes(w));
  });
}

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("rendered prompt previews", () => {
  // The preview is cut at 400 characters. This pad puts the cut ten characters into TOKEN's tail.
  const PAD = "p".repeat(400 - TOKEN.lastIndexOf("-") - 1 - 10);
  const parent = parseWorkflow(`
id: preview
name: Preview
version: "1"
inputSchema:
  fields:
    token: { type: string, sensitive: true }
    config:
      type: object
      properties:
        pem: { type: string, sensitive: true }
start: s
nodes:
  s: { type: start }
  cut: { type: agent, agent: { role: builder }, prompt: "${PAD}{{vars.token}}" }
  yaml: { type: agent, agent: { role: builder }, prompt: "Use {{vars.config}}" }
  upper: { type: agent, agent: { role: builder }, prompt: "Use {{ upper(vars.token) }}" }
  child: { type: subworkflow, workflow: preview-child }
  e: { type: end, outcome: success }
edges:
  - { from: s, to: cut }
  - { from: cut, to: yaml }
  - { from: yaml, to: upper }
  - { from: upper, to: child }
  - { from: child, to: e }
`);
  // No input schema: sensitivity is inherited from the parent, never re-declared.
  const child = parseWorkflow(`
id: preview-child
name: Preview child
version: "1"
start: s
nodes:
  s: { type: start }
  cut: { type: agent, agent: { role: builder }, prompt: "${PAD}{{vars.token}}" }
  e: { type: end, outcome: success }
edges: [{ from: s, to: cut }, { from: cut, to: e }]
`);
  const ordinary = parseWorkflow(`
id: ordinary
name: Ordinary
version: "1"
start: s
nodes:
  s: { type: start }
  cut: { type: agent, agent: { role: builder }, prompt: "${PAD}{{vars.label}}" }
  e: { type: end, outcome: success }
edges: [{ from: s, to: cut }, { from: cut, to: e }]
`);

  async function setup() {
    const prompts: string[] = [];
    const h = await harness(
      {},
      {
        workflows: new WorkflowRegistry().register(parent).register(child).register(ordinary),
        sessionFactory: async ({ host, agent, cwd }) => ({
          id: "fake",
          acpSessionId: "fake",
          agentId: agent.id,
          hostId: host.id,
          cwd,
          closed: Promise.resolve(),
          configOptions: [],
          setConfigOption: async () => [],
          onUpdate: () => () => {},
          cancel: async () => {},
          close: async () => {},
          async prompt(input) {
            prompts.push(typeof input === "string" ? input : JSON.stringify(input));
            return { stopReason: "end_turn", durationMs: 0 };
          },
        }),
      },
    );
    dirs.push(h.dir);
    return { ...h, prompts };
  }

  const turns = (events: OrcaEvent[]) =>
    events.flatMap((event) => (event.type === "agent.turn.started" ? [event] : []));

  it("withholds them for sensitive runs: truncation cuts, YAML objects, function output and inherited children", async () => {
    const { orchestrator: orc, prompts } = await setup();
    const state = await orc.startAndRun({
      workflowId: "preview",
      vars: { token: TOKEN, config: { pem: `${PEM_A}\n${PEM_B}` } },
    });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    // The authorized execution boundary still receives exact values, in every rendering.
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain(TOKEN);
    expect(prompts[1]).toContain(PEM_A);
    expect(prompts[2]).toContain(TOKEN.toUpperCase());
    expect(prompts[3]).toContain(TOKEN);

    const childId = state.steps[state.stepOrder.find((id) => state.steps[id]!.nodeId === "child")!]!.childRunIds[0]!;
    const parentEvents = await orc.stores.events.read(state.run.id);
    const childEvents = await orc.stores.events.read(childId);
    const publicTurns = [...turns(parentEvents), ...turns(childEvents)];
    expect(publicTurns).toHaveLength(4);
    for (const [index, turn] of publicTurns.entries()) {
      expect(turn.payload.promptPreview).toBe("[REDACTED]");
      // The digest keeps the turn's identity: it is the exact prompt the agent received.
      expect(turn.payload.promptHash).toBe(sha256(prompts[index]!));
    }
    const notifications = [...parentEvents, ...childEvents].flatMap((event) => [
      ...notificationsFor(event, "live"),
      ...notificationsFor(event, "replay"),
    ]);
    expect(
      exposed({
        parentEvents,
        childEvents,
        notifications,
        state: await orc.getState(state.run.id),
        child: await orc.getState(childId),
        view: await new ReadModel({ orchestrator: orc }).runsGet({ runId: state.run.id }),
        cli: [...parentEvents, ...childEvents].map((event) => formatEvent(event)),
      }),
    ).toEqual([]);
    // The encrypted original is unchanged for authoritative replay.
    const original = turns(await executionEvents(parentEvents, orc.stores.execution));
    expect(original[0]!.payload.promptPreview).toBe(prompts[0]!.slice(0, 400));
  });

  it("keeps them for runs without sensitive values", async () => {
    const { orchestrator: orc, prompts } = await setup();
    const state = await orc.startAndRun({ workflowId: "ordinary", vars: { label: "visible-ordinary-label" } });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    const [turn] = turns(await orc.stores.events.read(state.run.id));
    expect(turn!.payload.promptPreview).toBe(prompts[0]!.slice(0, 400));
  });
});

describe("launch provenance", () => {
  const dispatch = (sensitive: boolean) =>
    parseWorkflow(`
id: dispatch
name: Dispatch
version: "1"
inputSchema:
  fields:
    itemWorkflow: { type: string, sensitive: ${sensitive} }
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: Continue?, options: [go] }
  e: { type: end, outcome: success }
edges: [{ from: s, to: gate }, { from: gate, to: e }]
`);
  const flow = parseWorkflow(`
id: flow
name: Flow
version: "1"
start: s
nodes: { s: { type: start }, e: { type: end } }
edges: [{ from: s, to: e }]
`);

  async function launch(sensitive: boolean) {
    const stores = memoryStores();
    const definition = dispatch(sensitive);
    const executors = builtinExecutors();
    const orc = new Orchestrator({
      stores,
      workflows: new WorkflowRegistry().register(definition).register(flow),
      executors,
      agents: new AgentRegistry(),
      templates: new TemplateRegistry(),
      workspaceProvider: { name: "fake", provision: async () => ({ hostId: "local", cwd: "/tmp" }) },
      humanInput: new PausingHumanInput(),
    });
    const generations = new ConfigurationGenerations({
      store: stores.execution,
      workflows: stores.workflows,
      loadAssets: async () => ({ workflows: [definition, flow], templates: [] }),
      admission: {
        validateStartRun: (options, material) => orc.validateStartRun(options, material),
        startRun: (options, material) => orc.startRun(options, material),
      },
      validateCustomNode: (node) => executors.validateNode(node),
    });
    await generations.initialize(parseOrcaConfig({}), "saved");
    orc.generations = generations;
    return { stores, orc, captured: await generations.captureLaunch({ purpose: "workflow", workflowId: "dispatch" }) };
  }

  const provenanceOf = (events: OrcaEvent[]) =>
    events[0]?.type === "run.created" ? events[0].payload.provenance : undefined;

  it("withholds a sensitive itemWorkflow input value and keeps its source and the private original", async () => {
    const { stores, orc, captured } = await launch(true);
    const runId = await captured.startRun({ vars: { itemWorkflow: ROUTE } });
    expect((await orc.run(runId)).run.status).toBe("paused");
    const events = await stores.events.read(runId);
    expect(provenanceOf(events)).toMatchObject({
      configGeneration: captured.generationId,
      inputs: [{ name: "itemWorkflow", source: "caller", value: "[REDACTED]" }],
      itemWorkflow: { value: "[REDACTED]", source: "caller.vars.itemWorkflow" },
    });
    const view = await new ReadModel({ orchestrator: orc }).runsGet({ runId });
    expect(exposed({ events, view, state: await orc.getState(runId) })).toEqual([]);
    expect(provenanceOf(await executionEvents(events, stores.execution))?.itemWorkflow?.value).toBe(ROUTE);
    // Redaction is public-only: restoring the pinned generation and resuming is unaffected.
    const [input] = await orc.pendingInputs(runId);
    await orc.answer(input!.id, "go", runId);
    expect((await orc.resume(runId)).run.status).toBe("completed");
  });

  it("keeps ordinary and explicitly overridden item workflows visible", async () => {
    const plain = await launch(false);
    const plainId = await plain.captured.startRun({ vars: { itemWorkflow: "flow" } });
    expect(provenanceOf(await plain.stores.events.read(plainId))?.itemWorkflow).toEqual({
      value: "flow",
      source: "caller.vars.itemWorkflow",
    });
    // An override is a selection, not an input value, even when the input is sensitive.
    const sensitive = await launch(true);
    const overriddenId = await sensitive.captured.startRun({
      vars: { itemWorkflow: ROUTE },
      overrides: { itemWorkflow: "flow" },
    });
    const events = await sensitive.stores.events.read(overriddenId);
    expect(provenanceOf(events)?.itemWorkflow).toEqual({ value: "flow", source: "run.overrides.itemWorkflow" });
    expect(exposed(events)).toEqual([]);
  });
});

describe("thrown, late and cancelled results", () => {
  const definition = parseWorkflow(`
id: provider
name: Provider
version: "1"
inputSchema:
  fields:
    token: { type: string, sensitive: true }
    secrets:
      type: object
      properties:
        key: { type: string, sensitive: true }
start: s
nodes:
  s: { type: start }
  call: { type: custom:provider, retry: { maxAttempts: 1 } }
  e: { type: end }
edges: [{ from: s, to: call }, { from: call, to: e }]
`);
  const failures: Record<string, (ctx: StepContext, token: string) => Promise<never>> = {
    "a provider error quoting the request as JSON": async (_ctx, token) => {
      throw new Error(`provider refused ${JSON.stringify({ authorization: token, [KEY]: [token] })}`);
    },
    "an OrcaError with secret-bearing details keys and arrays": async (_ctx, token) => {
      throw new OrcaError("INTERNAL", `refused ${token}`, { nested: { [KEY]: { token } }, list: [token, KEY] });
    },
    "an error whose cause holds the value": async (_ctx, token) => {
      throw new Error("provider call failed", { cause: new Error(token) });
    },
    "a non-Error throw": async (_ctx, token) => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- A provider may throw anything.
      throw Object.assign(Object.create(null) as object, { token, toString: () => `refused ${token}` });
    },
  };

  function make(stores: Stores, execute: (ctx: StepContext) => Promise<never | ReturnType<typeof completed>>) {
    const executors = builtinExecutors();
    executors.register({ type: "custom:provider", execute });
    return new Orchestrator({
      stores,
      workflows: new WorkflowRegistry().register(definition),
      executors,
      agents: new AgentRegistry(),
      templates: new TemplateRegistry(),
      workspaceProvider: { name: "fake", provision: async () => ({ hostId: "local", cwd: "/tmp" }) },
      humanInput: new PausingHumanInput(),
      // The default CLI/daemon sink: real stderr, captured below.
      logger: consoleLogger("debug"),
    });
  }

  function captureOutput(): string[] {
    const out: string[] = [];
    const record = (chunk: unknown) => {
      out.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(record);
    vi.spyOn(process.stderr, "write").mockImplementation(record);
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void out.push(args.map(String).join(" ")));
    return out;
  }

  it.each(Object.keys(failures))("scrubs %s from events, state, logs, stdout/stderr and CLI output", async (name) => {
    const out = captureOutput();
    const stores = memoryStores();
    const orc = make(stores, async (ctx) => {
      const token = ctx.run.state.run.vars.token as string;
      expect(token).toBe(TOKEN);
      ctx.logger.error(`calling provider with ${token}`, { request: { [KEY]: token } });
      return failures[name]!(ctx, token);
    });
    const events: OrcaEvent[] = [];
    orc.subscribe((event) => events.push(event));
    const state = await orc.startAndRun({ workflowId: "provider", vars: { token: TOKEN, secrets: { key: KEY } } });
    const step = state.steps[state.stepOrder[1]!]!;
    expect(step.status).toBe("failed");
    // Diagnostics survive: the code and the message's non-secret text are still there.
    expect(step.error?.code).toBe("INTERNAL");
    expect(step.error?.message).toMatch(/refused|provider call failed/);
    expect(
      exposed({ events, state, out, cli: [formatRunState(state), ...events.map((event) => formatEvent(event))] }),
    ).toEqual([]);
    expect(out.join("")).toContain("[REDACTED]");
  });

  it("scrubs a late result and late logging from a step whose run was cancelled", async () => {
    const out = captureOutput();
    const stores = memoryStores();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let late!: Promise<unknown>;
    const orc = make(stores, async (ctx) => {
      const token = ctx.run.state.run.vars.token as string;
      entered();
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      // A provider that answers after cancellation: log it, try to record it, then fail.
      late = (async () => {
        ctx.logger.warn(`late provider answer ${token}`, { [KEY]: token });
        await ctx.emit({ type: "vars.set", payload: { vars: { late: token } } }).catch(() => undefined);
      })();
      throw new Error(`late failure ${token}`);
    });
    const events: OrcaEvent[] = [];
    orc.subscribe((event) => events.push(event));
    const runId = await orc.startRun({ workflowId: "provider", vars: { token: TOKEN, secrets: { key: KEY } } });
    const running = orc.run(runId);
    await started;
    await orc.cancel(runId, `operator cancelled ${TOKEN}`);
    const state = await running;
    await late;
    expect(state.run.status).toBe("cancelled");
    const final = await orc.getState(runId);
    expect(
      exposed({
        events,
        stored: await stores.events.read(runId),
        state,
        final,
        out,
        cli: [formatRunState(final), ...events.map((event) => formatEvent(event))],
      }),
    ).toEqual([]);
  });

  // An unknown key under a non-sensitive object is reported by name to its submitter, by
  // the validation contract (docs/workflow-inputs.md); beneath a sensitive one it is not.
  it("refuses malformed sensitive input without echoing values, keys, patterns or enums", async () => {
    const strict = parseWorkflow(`
id: strict
name: Strict
version: "1"
inputSchema:
  unknown: reject
  fields:
    token: { type: string, sensitive: true, pattern: "^${KEY}$", minLength: 50, enum: ["${ROUTE}"] }
    secrets:
      type: object
      sensitive: true
      additionalProperties: false
      properties:
        key: { type: string }
start: s
nodes: { s: { type: start }, e: { type: end } }
edges: [{ from: s, to: e }]
`);
    const stores = memoryStores();
    const orc = new Orchestrator({
      stores,
      workflows: new WorkflowRegistry().register(strict),
      agents: new AgentRegistry(),
      templates: new TemplateRegistry(),
      workspaceProvider: { name: "fake", provision: async () => ({ hostId: "local", cwd: "/tmp" }) },
    });
    for (const vars of [
      { token: TOKEN },
      { token: 7 },
      { token: [TOKEN] },
      { token: ROUTE, secrets: { key: KEY, [PEM_A]: PEM_B } },
      { token: ROUTE, secrets: { key: { [PEM_A]: TOKEN } } },
    ]) {
      const refused = await orc.startRun({ workflowId: "strict", vars }).catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
      const { code, message, details } = refused as OrcaError;
      expect(exposed({ code, message, details })).toEqual([]);
    }
    expect(await stores.events.listRuns()).toEqual([]);
  });
});

describe("paused human gates", () => {
  it("renders templated questions and the CLI pause summary without the value", async () => {
    const gate = parseWorkflow(`
id: approve
name: Approve
version: "1"
inputSchema:
  fields:
    token: { type: string, sensitive: true }
    count: { type: integer, sensitive: true }
start: s
nodes:
  s: { type: start }
  g: { type: gate, question: "Ship with {{vars.token}} x{{vars.count}}?", options: [ship, stop] }
  e: { type: end }
edges: [{ from: s, to: g }, { from: g, to: e }]
`);
    const stores = memoryStores();
    const orc = new Orchestrator({
      stores,
      workflows: new WorkflowRegistry().register(gate),
      agents: new AgentRegistry(),
      templates: new TemplateRegistry(),
      workspaceProvider: { name: "fake", provision: async () => ({ hostId: "local", cwd: "/tmp" }) },
      humanInput: new PausingHumanInput(),
    });
    const runId = await orc.startRun({ workflowId: "approve", vars: { token: TOKEN, count: 4 } });
    expect((await orc.run(runId)).run.status).toBe("paused");
    const pending = await orc.pendingInputs(runId);
    expect(pending[0]?.question).toBe("Ship with [REDACTED] x[REDACTED]?");
    expect(exposed({ pending, paused: formatPaused(runId, pending) })).toEqual([]);
    await orc.answer(pending[0]!.id, "ship", runId);
    const resumed = await orc.resume(runId);
    expect(resumed.run.status).toBe("completed");
    expect(exposed({ events: await stores.events.read(runId), cli: formatRunState(resumed) })).toEqual([]);
  });
});
