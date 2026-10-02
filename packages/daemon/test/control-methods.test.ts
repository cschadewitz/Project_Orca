/**
 * The control methods and the agent methods over `dispatch`, against a store a real
 * interpreter wrote - a run actually parked at a gate rather than a log shaped like one.
 *
 * That matters here in a way it did not for the read methods. A read is a projection and a
 * hand-written log exercises it exactly; answering a gate has to re-drive the run, take its
 * lease and reach the same terminal state a CLI would, so the fixture is an orchestrator
 * with `PausingHumanInput` and a workflow, driven until it parks.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry, LocalHost, SshHost, type AgentSession } from "@orca/agents";
import {
  AgentSpecSchema,
  OrcaError,
  RequestSchema,
  WorkItemSchema,
  SshHostSchema,
  FakeClock,
  TemplateRegistry,
  WorkflowRegistry,
  parseWorkflow,
  silentLogger,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput, runLeaseResource } from "@orca/engine";
import {
  PROTOCOL_VERSION,
  AgentsListResultSchema,
  AgentsPingResultSchema,
  CLAIMS_RELEASE_METHOD,
  CONTROL_METHODS,
  DEPENDENCIES_WAIVE_METHOD,
  HelloResultSchema,
  INPUTS_ANSWER_METHOD,
  InputsAnswerResultSchema,
  PLAN_READ_METHODS,
  RISKS_UPDATE_METHOD,
  RUNS_CANCEL_METHOD,
  RUNS_RESUME_METHOD,
  RUNS_START_METHOD,
  RunsStartResultSchema,
  SubscribeParamsSchema,
  parseNotification,
} from "@orca/protocol";
import { memoryStores } from "@orca/store";
import {
  AgentModel,
  ConfigModel,
  ControlModel,
  ReadModel,
  Subscription,
  dispatch,
  methodsFor,
  type MethodContext,
} from "@orca/daemon";

const GATED = `
id: gated
name: gated
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

const TALKY = `
id: talky
name: talky
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: builder, prompt: "say something" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

const HANDSHAKE_MS = 250;

/**
 * A session that costs `HANDSHAKE_MS` on the clock and speaks one line when prompted. The
 * line is the point: it is what moves `lastSeenAt` without a second handshake.
 */
function fakeSessions(clock: FakeClock) {
  const factory = async (o: { agent: { id: string }; host: { id: string }; cwd: string }): Promise<AgentSession> => {
    clock.advance(HANDSHAKE_MS);
    const listeners = new Set<(e: { summary: { kind: string; text?: string } }) => void>();
    return {
      id: `sess_${o.agent.id}`,
      agentId: o.agent.id,
      hostId: o.host.id,
      cwd: o.cwd,
      acpSessionId: "acp",
      configOptions: [],
      setConfigOption: async () => [],
      closed: new Promise(() => {}),
      prompt: async () => {
        clock.advance(60_000);
        for (const l of listeners) l({ summary: { kind: "agent_message_chunk", text: "working on it" } });
        return { stopReason: "end_turn" as const, durationMs: 1 };
      },
      onUpdate: (listener) => {
        listeners.add(listener as never);
        return () => void listeners.delete(listener as never);
      },
      cancel: async () => {},
      close: async () => {},
    };
  };
  return factory as Orchestrator["sessionFactory"];
}

function harness() {
  const clock = new FakeClock();
  const stores = memoryStores(clock);
  const agents = new AgentRegistry(clock)
    .addHost(new LocalHost({ id: "local", type: "local" }))
    // A second host, over ssh: `hostType` is derived from the host an agent's spec names
    // (protocol 1.5), so a registry with one host could not tell a right answer from a
    // hardcoded one.
    .addHost(new SshHost(SshHostSchema.parse({ id: "build-box", type: "ssh", host: "build-box.internal" })))
    .addAgent(AgentSpecSchema.parse({ id: "builder", command: "x", hostId: "local", roles: ["build"] }))
    .addAgent(AgentSpecSchema.parse({ id: "reviewer", command: "y", hostId: "local" }))
    .addAgent(AgentSpecSchema.parse({ id: "remote", command: "z", hostId: "build-box", roles: ["build"] }));
  const orchestrator = new Orchestrator({
    stores,
    agents,
    workflows: new WorkflowRegistry().register(parseWorkflow(GATED)).register(parseWorkflow(TALKY)),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    // The daemon's port: every gate parks to the log rather than being held open in memory.
    humanInput: new PausingHumanInput(),
    sessionFactory: fakeSessions(clock),
    logger: silentLogger,
    clock,
    // The fake session jumps the logical clock by a minute to test health timestamps.
    // This fixture does not advance the real heartbeat scheduler, so keep its lease valid.
    lease: { ttlMs: 120_000 },
  });
  const reads = new ReadModel({ orchestrator });
  const agentModel = new AgentModel({ orchestrator, reads });
  const control = new ControlModel({ orchestrator, reads });
  // `orca serve` always builds one of these - a daemon serving a store is serving it out of
  // a config directory - so a harness without one would advertise a `hello.methods` no real
  // daemon has. It reads lazily, so an empty directory is a workspace with no config yet.
  const config = new ConfigModel({ configDir: tmpdir() });
  const ctx: MethodContext = {
    orcaVersion: "0.4.0-test",
    capabilities: ["runs.read", "runs.subscribe", "runs.control"],
    reads,
    control,
    agents: agentModel,
    config,
  };
  return { clock, stores, orchestrator, agents, agentModel, ctx };
}

async function call(ctx: MethodContext, method: string, params?: unknown) {
  const res = await dispatch(JSON.stringify({ kind: "request", id: 3, method, params }), methodsFor(ctx), ctx);
  return res as { ok: boolean; result?: unknown; error?: { code: string; message: string; details?: unknown } };
}

/** A run of `gated`, driven until it parks at the gate, with the id of the open question. */
async function parked(h: ReturnType<typeof harness>) {
  const state = await h.orchestrator.startAndRun({ workflowId: "gated" });
  expect(state.run.status).toBe("paused");
  const pending = await h.orchestrator.pendingInputs(state.run.id);
  expect(pending).toHaveLength(1);
  return { runId: state.run.id, requestId: pending[0]!.id };
}

describe("inputs.answer", () => {
  it("accepts one conflicting concurrent RPC answer and resumes only that choice", async () => {
    const h = harness();
    const { runId, requestId } = await parked(h);
    // Both RPCs must reach the atomic acceptance boundary after observing the same open
    // request. No timers: release them only after both have passed daemon validation.
    const accept = h.orchestrator.answer.bind(h.orchestrator);
    let arrivals = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(h.orchestrator, "answer").mockImplementation(async (...args) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await together;
      return accept(...args);
    });
    try {
      const replies = await Promise.all([
        call(h.ctx, "inputs.answer", { requestId, optionId: "hold" }),
        call(h.ctx, "inputs.answer", { requestId, optionId: "ship" }),
      ]);
      expect(arrivals).toBe(2);
      expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
      expect(replies.filter((reply) => !reply.ok)).toHaveLength(1);
      const accepted = InputsAnswerResultSchema.parse(replies.find((reply) => reply.ok)!.result);
      const events = await h.orchestrator.events(runId);
      const answers = events.filter((event) => event.type === "human.answered");
      expect(answers).toHaveLength(1);
      expect(answers[0]!.payload.answer).toBe(accepted.answer);
      const completed = events.filter((event) => event.type === "run.completed");
      expect(completed).toHaveLength(1);
      const state = await h.orchestrator.getState(runId);
      expect(state.run.outcome).toBe(accepted.answer === "ship" ? "success" : "failure");
      const terminalNodes = Object.values(state.steps).filter(
        (step) => step.nodeId === "held" || step.nodeId === "shipped",
      );
      expect(terminalNodes.map((step) => step.nodeId)).toEqual([accepted.answer === "ship" ? "shipped" : "held"]);
      expect(await h.orchestrator.pendingInputs(runId)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers a parked gate and the run runs on to its end", async () => {
    const h = harness();
    const { runId, requestId } = await parked(h);

    const res = await call(h.ctx, "inputs.answer", { requestId, optionId: "ship" });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const answered = InputsAnswerResultSchema.parse(res.result);
    expect(answered).toMatchObject({ requestId, runId, answer: "ship" });
    // The call returns once the run has stopped again, so this is a settled status.
    expect(answered.run?.status).toBe("succeeded");
    expect((await h.orchestrator.getState(runId)).run.status).toBe("completed");
    expect(await h.orchestrator.pendingInputs(runId)).toEqual([]);
  });

  it("records the note on `human.answered`, where the run keeps it (#238)", async () => {
    const h = harness();
    const { runId, requestId } = await parked(h);
    const res = await call(h.ctx, "inputs.answer", {
      requestId,
      optionId: "hold",
      note: "the staging soak is still red",
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);

    // In the run's log, not the daemon's: until #238 this note reached whichever terminal
    // the daemon was logging to and nothing that outlived the run.
    const answered = (await h.orchestrator.events(runId)).find((e) => e.type === "human.answered")!;
    expect(answered.payload).toMatchObject({ answer: "hold", note: "the staging soak is still red" });
  });

  it("refuses an option the question does not offer, and names the ones it does", async () => {
    const h = harness();
    const { requestId } = await parked(h);
    const res = await call(h.ctx, "inputs.answer", { requestId, optionId: "maybe" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INPUT_OPTION_UNKNOWN");
    expect(res.error?.details).toMatchObject({ options: ["ship", "hold"] });
  });

  it("tells a second answer that the question is already settled", async () => {
    const h = harness();
    const { requestId } = await parked(h);
    expect((await call(h.ctx, "inputs.answer", { requestId, optionId: "ship" })).ok).toBe(true);

    // Two people looking at the same attention list is the ordinary case, not the odd one:
    // the second one has to be told what happened, not handed a generic RUN_STATE.
    const again = await call(h.ctx, "inputs.answer", { requestId, optionId: "hold" });
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe("INPUT_ANSWERED");
    expect(again.error?.message).toContain("ship");
  });

  it("refuses a run another live process is interpreting, and says where it is", async () => {
    const h = harness();
    const { runId, requestId } = await parked(h);
    // A lease held by somebody else, freshly renewed: a live interpreter, not a lapsed one.
    await h.stores.leases.acquire({
      resource: runLeaseResource(runId),
      holder: "some-other-process",
      ttlMs: 60_000,
    });

    const res = await call(h.ctx, "inputs.answer", { requestId, optionId: "ship" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("RUN_LEASED_ELSEWHERE");
    // The holder's pid and host, because "do it over there" is only useful with a there.
    expect(res.error?.details).toMatchObject({ runId, holder: "some-other-process" });
    expect((res.error?.details as { pid?: unknown }).pid).toEqual(expect.any(Number));
    expect((res.error?.details as { host?: unknown }).host).toEqual(expect.any(String));
    // Refused without writing: the answer is still open for the process that holds the lease.
    expect(await h.orchestrator.pendingInputs(runId)).toHaveLength(1);
  });
});

describe("config.set beside a run (#174, #266)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("writes the config while a run is parked mid-flight and disturbs neither", async () => {
    const h = harness();
    const { runId, requestId } = await parked(h);
    const dir = await mkdtemp(join(tmpdir(), "orca-serve-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nstoreDir: .orca\n", "utf8");
    const config = new ConfigModel({ configDir: dir, configFile: join(dir, "orca.config.yaml") });
    const ctx: MethodContext = { ...h.ctx, config };

    const before = await h.orchestrator.events(runId);
    const read = (await call(ctx, "config.get")).result as { config: { revision: string } };
    const written = await call(ctx, "config.set", {
      document: "config",
      expectedRevision: read.config.revision,
      patch: [{ path: "storeDir", value: ".elsewhere" }],
    });
    expect(written.ok, JSON.stringify(written.error)).toBe(true);

    // `config.set` takes no lease, appends no event and touches no run: editing the config
    // while a run is in flight is a safe thing to do rather than a race (#160's lease story
    // is about who may *interpret* a run).
    expect(await h.orchestrator.events(runId)).toHaveLength(before.length);
    expect((await h.orchestrator.getState(runId)).run.status).toBe("paused");
    expect(await h.orchestrator.pendingInputs(runId)).toHaveLength(1);

    // And the run still answers and finishes afterwards, under the config it booted with -
    // nothing here reloads the orchestrator, by design.
    const answered = await call(ctx, "inputs.answer", { requestId, optionId: "ship" });
    expect(answered.ok, JSON.stringify(answered.error)).toBe(true);
    expect((await h.orchestrator.getState(runId)).run.status).toBe("completed");
  });
});

/**
 * The engine raises `RUN_LEASED` from inside `run`/`resume`, not only from the check the
 * daemon makes first: another process can take the lease in the window after that check, and
 * an operator can take it *away* mid-run (#267). `runs.cancel` has mapped it to the wire's
 * `RUN_LEASED_ELSEWHERE` from the start; `runs.start` and `runs.resume` did not, so the one
 * refusal a client most needs to tell apart arrived as an unclassified INTERNAL fault.
 *
 * An orchestrator that refuses to drive is the honest stand-in for that window: the race
 * cannot be scheduled from a test, and what is under test is the translation, not the race.
 */
function refusesToDrive(orc: Orchestrator): Orchestrator {
  const boom = (runId: string): never => {
    throw new OrcaError("RUN_LEASED", `the lease on run ${runId} was taken away while it was being interpreted here`, {
      runId,
      holder: "some-other-process",
    });
  };
  return new Proxy(orc, {
    get(target, prop) {
      if (prop === "run" || prop === "resume") return (runId: string) => boom(runId);
      const value: unknown = Reflect.get(target, prop);
      // Bound to the target: these are class instances with private state, and an unbound
      // method called on the proxy would read it through the trap and lose `this`.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("a lease lost while the daemon drives", () => {
  it("maps the engine's RUN_LEASED onto runs.start and runs.resume, as runs.cancel already did", async () => {
    const h = harness();
    const { runId } = await parked(h);
    const orchestrator = refusesToDrive(h.orchestrator);
    const ctx: MethodContext = {
      ...h.ctx,
      control: new ControlModel({ orchestrator, reads: h.ctx.reads! }),
    };

    for (const [method, params] of [
      ["runs.resume", { runId }],
      ["runs.start", { workflowId: "talky" }],
    ] as const) {
      const res = await call(ctx, method, params);
      expect(res.ok, `${method} should have been refused`).toBe(false);
      // Not INTERNAL: a screen branches on this code to say "another process is driving it".
      expect(res.error?.code, method).toBe("RUN_LEASED_ELSEWHERE");
      expect(res.error?.details).toMatchObject({ holder: "some-other-process" });
      // And the run id is on it either way, including for the run `runs.start` had just made.
      expect((res.error?.details as { runId?: unknown }).runId).toEqual(expect.any(String));
    }
  });
});

describe("runs.start", () => {
  it("starts a workflow with vars and writes no request or work-item document (#196)", async () => {
    const h = harness();
    const at = new Date(h.clock.now()).toISOString();
    const request = RequestSchema.parse({
      id: "req-existing",
      title: "An existing request",
      body: "",
      createdAt: at,
      updatedAt: at,
    });
    const item = WorkItemSchema.parse({
      id: "wi-existing",
      requestId: request.id,
      slug: "say-something",
      title: "Say something",
      createdAt: at,
      updatedAt: at,
    });
    await h.stores.requests.put(request);
    await h.stores.workItems.put(item);
    const res = await call(h.ctx, "runs.start", {
      workflowId: "talky",
      vars: { who: "nobody" },
      requestId: request.id,
      workItemId: item.id,
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const started = RunsStartResultSchema.parse(res.result);
    expect(started.run.status).toBe("succeeded");
    expect(started.run.requestId).toBe(request.id);
    // A raw workflow may reference existing context, but creates no Request/WorkItem.
    // Missing work-item context is refused rather than silently becoming an unspecified task.
    expect(await h.stores.requests.list()).toEqual([request]);
    expect(await h.stores.workItems.list()).toEqual([item]);
    expect(started.run.name).toBe(item.title);
  });
});

describe("hello", () => {
  it("advertises runs.control and the control methods when the daemon drives runs", async () => {
    const h = harness();
    const res = await call(h.ctx, "hello", { client: "test/1", protocol: PROTOCOL_VERSION });
    const hello = HelloResultSchema.parse(res.result);
    expect(hello.capabilities).toContain("runs.control");
    // The four that drive runs. `CONTROL_METHODS` also holds the plan writes as of #169, and
    // this harness has no plan service - a method this daemon will not answer is a method it
    // does not advertise, which is the whole rule.
    for (const m of [RUNS_RESUME_METHOD, RUNS_CANCEL_METHOD, RUNS_START_METHOD, INPUTS_ANSWER_METHOD])
      expect(hello.methods).toContain(m);
    expect(hello.methods).toContain("agents.ping");
  });

  /**
   * `claims.release` is in `CONTROL_METHODS` on the wire, so a daemon advertising
   * `runs.control` promises it. It used to be gated on `planControl`, which this harness -
   * a store with runs and no plan in it, exactly what `orca serve` builds over one - does not
   * have, so `hello` promised a method the table would answer "unknown method" to (#169).
   */
  it("serves claims.release without a plan, because runs.control is what it is behind", async () => {
    const h = harness();
    const hello = HelloResultSchema.parse(
      (await call(h.ctx, "hello", { client: "t", protocol: PROTOCOL_VERSION })).result,
    );
    expect(h.ctx.planControl).toBeUndefined();
    expect(hello.methods).toContain(CLAIMS_RELEASE_METHOD);
    // The plan writes stay behind the plan, and are absent here.
    for (const m of [DEPENDENCIES_WAIVE_METHOD, RISKS_UPDATE_METHOD]) expect(hello.methods).not.toContain(m);

    // Reached, not refused as unknown: no such claim in this store is the right complaint.
    const res = await call(h.ctx, CLAIMS_RELEASE_METHOD, { workItemId: "wi_nope", force: false });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("CLAIM_NOT_FOUND");
  });

  /**
   * `hello.capabilities` and `hello.methods` are two answers to one question, and the CLI used
   * to derive one and hardcode the other: `orca serve` advertised `plan.read`/`plan.write`
   * whatever the store held. Whatever builds a context, the two have to agree.
   */
  it("advertises no plan capability when the daemon has no plan behind it", async () => {
    const h = harness();
    const hello = HelloResultSchema.parse(
      (await call(h.ctx, "hello", { client: "t", protocol: PROTOCOL_VERSION })).result,
    );
    const table = Object.keys(methodsFor(h.ctx));
    expect((hello.methods ?? []).slice().sort()).toEqual(table.slice().sort());
    for (const m of PLAN_READ_METHODS) expect(hello.methods).not.toContain(m);
    expect(hello.capabilities).not.toContain("plan.read");
    expect(hello.capabilities).not.toContain("plan.write");
  });

  it("read-only: no control methods in the table, and no runs.control", async () => {
    const h = harness();
    // What `orca serve --read-only` builds: no control model, and the capability dropped.
    const ctx: MethodContext = { ...h.ctx, control: undefined, capabilities: ["runs.read", "runs.subscribe"] };

    const hello = HelloResultSchema.parse(
      (await call(ctx, "hello", { client: "t", protocol: PROTOCOL_VERSION })).result,
    );
    expect(hello.capabilities).not.toContain("runs.control");
    for (const m of CONTROL_METHODS) expect(hello.methods).not.toContain(m);

    // Absent, not present-and-refusing: a client can hide a button rather than discover at
    // the moment of pressing it that there is nothing behind it.
    const answer = await call(ctx, "inputs.answer", { requestId: "hi-1", optionId: "ship" });
    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe("PROTOCOL_METHOD");

    // The agent methods survive `--read-only`: neither touches a run, a lease or a log.
    expect(hello.methods).toContain("agents.list");
    expect(hello.methods).toContain("agents.ping");
  });
});

describe("agents.list and agents.ping", () => {
  it("reports a configured agent nothing has contacted as unknown, not as a default", async () => {
    const h = harness();
    const list = AgentsListResultSchema.parse((await call(h.ctx, "agents.list")).result);
    expect(list.agents.map((a) => [a.id, a.state])).toEqual([
      ["builder", "unknown"],
      ["reviewer", "unknown"],
      ["remote", "unknown"],
    ]);
    expect(list.agents[0]).toMatchObject({ hostId: "local", roles: ["build"], consecutiveFailures: 0 });
    // Health does not survive a restart and must not pretend to: nothing is invented here.
    expect(list.agents[0]!.lastHandshakeAt).toBeUndefined();
    expect(list.agents[0]!.lastSeenAt).toBeUndefined();
  });

  it("says which transport each agent's host uses, and says nothing when the host has gone", async () => {
    const h = harness();
    const list = AgentsListResultSchema.parse((await call(h.ctx, "agents.list")).result);
    // `hostType` is the host spec's, not the agent's (protocol 1.5): two agents on `local`
    // and one over ssh, which is what lets the surface group by host and say how it is
    // reached without reading the config itself (ADR 0008).
    expect(list.agents.map((a) => [a.id, a.hostId, a.hostType])).toEqual([
      ["builder", "local", "local"],
      ["reviewer", "local", "local"],
      ["remote", "build-box", "ssh"],
    ]);

    // A config edit that takes the host out from under an agent: the agent keeps its health
    // and loses its transport, rather than being told it is local (RULES.md rule 12).
    h.agents.addAgent(AgentSpecSchema.parse({ id: "orphan", command: "q", hostId: "gone" }));
    const after = AgentsListResultSchema.parse((await call(h.ctx, "agents.list")).result);
    const orphan = after.agents.find((a) => a.id === "orphan")!;
    expect(orphan.hostId).toBe("gone");
    expect(orphan.hostType).toBeUndefined();
  });

  it("pings an agent, records the handshake, and pushes agent.changed", async () => {
    const h = harness();
    const frames: { method: string; params?: unknown }[] = [];
    const sub = new Subscription({
      id: "sub-1",
      // Store-wide: an agent belongs to the process, so a run-scoped subscription is not
      // woken by one changing.
      params: SubscribeParamsSchema.parse({}),
      source: h.orchestrator,
      send: (m) => void frames.push(m),
      agents: h.agentModel,
    });
    await sub.start();

    const res = await call(h.ctx, "agents.ping", { agentId: "builder" });
    const ping = AgentsPingResultSchema.parse(res.result);
    expect(ping.ok).toBe(true);
    expect(ping.agent).toMatchObject({ id: "builder", state: "ok", roundTripMs: HANDSHAKE_MS });

    /* Parsed by `parseNotification` like any other method: `agent.changed` is one of the
       seven since protocol 1.5 (#241), so a client routes it off the same stream rather
       than through a parser of its own — which is what the reversal was for. */
    const changed = frames
      .map((f) => parseNotification(f))
      .filter((n) => n !== undefined)
      .filter((n) => n.method === "agent.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.params.agent).toMatchObject({ id: "builder", state: "ok", hostType: "local" });
    // Still no cursor, which is the half of the old rationale that survived: a client that
    // folds `seq` must test for one rather than assume it.
    expect((changed[0]!.params as { seq?: number }).seq).toBeUndefined();
    sub.stop();
  });

  it("does not wake a subscription that asked for other methods", async () => {
    const h = harness();
    const frames: { method: string }[] = [];
    const sub = new Subscription({
      id: "sub-2",
      // `agent.changed` joined `NOTIFICATION_METHODS` in 1.5, so it is something a client
      // can now ask for — and therefore something it can decline.
      params: SubscribeParamsSchema.parse({ methods: ["run.changed"] }),
      source: h.orchestrator,
      send: (m) => void frames.push(m),
      agents: h.agentModel,
    });
    await sub.start();

    await call(h.ctx, "agents.ping", { agentId: "builder" });
    expect(frames.map((f) => f.method)).not.toContain("agent.changed");
    sub.stop();
  });

  it("lastSeenAt advances on agent output while lastHandshakeAt stays at the handshake", async () => {
    const h = harness();
    await h.orchestrator.startAndRun({ workflowId: "talky" });

    const list = AgentsListResultSchema.parse((await call(h.ctx, "agents.list")).result);
    const builder = list.agents.find((a) => a.id === "builder")!;
    // The fake session hands over a line a minute after the handshake. One timestamp would
    // have to choose between "the connection is a minute old" and "it spoke just now" (#227).
    expect(builder.state).toBe("ok");
    expect(builder.lastHandshakeAt).toBeDefined();
    expect(builder.lastSeenAt).toBeDefined();
    expect(Date.parse(builder.lastSeenAt!)).toBeGreaterThan(Date.parse(builder.lastHandshakeAt!));
  });
});
