/** Agent session slots (#873): optional caps per daemon, agent and host, taken at session open. */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import {
  AgentSpecSchema,
  OrcaError,
  parseOrcaConfig,
  parseWorkflow,
  reduceRun,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
  type OrcaEvent,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, SessionSlots, type SessionSlotCaps } from "@orca/engine";
import { memoryStores } from "@orca/store";

// ------------------------------------------------------------------ the queue on its own

const request = (agentId: string, hostId: string, caps: SessionSlotCaps, extra: object = {}) => ({
  agentId,
  hostId,
  caps: () => caps,
  ...extra,
});
const settled = () => new Promise((r) => setTimeout(r, 0));

describe("SessionSlots", () => {
  it("is unlimited when no cap is set, and still counts what is open", () => {
    const slots = new SessionSlots();
    const held = Array.from({ length: 50 }, () => slots.tryAcquire(request("a", "local", {})));
    expect(held.every(Boolean)).toBe(true);
    expect(slots.view()).toEqual({
      limits: { agents: {}, hosts: {} },
      inUse: { total: 50, agents: { a: 50 }, hosts: { local: 50 } },
      queued: 0,
    });
    for (const slot of held) slot!.release();
    expect(slots.view().inUse).toEqual({ total: 0, agents: {}, hosts: {} });
  });

  it("queues at a full cap, says which, and grants on release", async () => {
    const slots = new SessionSlots();
    const caps = { host: 2 };
    const first = slots.tryAcquire(request("a", "box-b", caps))!;
    slots.tryAcquire(request("a", "box-b", caps))!;
    const reasons: string[] = [];
    let granted = false;
    const third = slots.acquire(request("a", "box-b", caps, { onWait: (r: string) => void reasons.push(r) }));
    void third.then(() => (granted = true));
    await settled();
    expect(granted).toBe(false);
    expect(reasons).toEqual(["waiting for an agent slot: 2 of 2 in use on host box-b"]);
    expect(slots.view().queued).toBe(1);
    first.release();
    first.release(); // idempotent: a second release must not free a second slot
    await third;
    expect(slots.view()).toMatchObject({ inUse: { total: 2 }, queued: 0 });
  });

  it("applies every cap a request is subject to, and names the one that is full", async () => {
    const slots = new SessionSlots();
    const capped = { daemon: 3, agent: 1, host: 2 };
    const free = { daemon: 3, host: 2 };
    expect(slots.tryAcquire(request("a", "h1", capped))).toBeDefined();
    // Agent `a` is at its cap of 1, though the host and the daemon have room.
    expect(slots.tryAcquire(request("a", "h1", capped))).toBeUndefined();
    expect(slots.tryAcquire(request("b", "h1", free))).toBeDefined();
    // Host h1 is now full for `b` as well.
    expect(slots.tryAcquire(request("b", "h1", free))).toBeUndefined();
    expect(slots.tryAcquire(request("b", "h2", free))).toBeDefined();
    const caps = free;
    // Three open: the daemon is full for anyone.
    const reasons: string[] = [];
    void slots.acquire(request("c", "h3", caps, { onWait: (r: string) => void reasons.push(r) }));
    await settled();
    expect(reasons).toEqual(["waiting for an agent slot: 3 of 3 in use on this daemon"]);
  });

  it("does not let a newcomer overtake a queued step for the same cap, but lets unrelated caps go", async () => {
    const slots = new SessionSlots();
    const held = slots.tryAcquire(request("a", "h1", { host: 1 }))!;
    const order: string[] = [];
    void slots.acquire(request("a", "h1", { host: 1 })).then((s) => (order.push("queued"), s.release()));
    await settled();
    // h1 is full and a step is queued for it, so a newcomer for h1 queues too...
    expect(slots.tryAcquire(request("b", "h1", { host: 1 }))).toBeUndefined();
    // ...while a step bound for another host is not held up.
    expect(slots.tryAcquire(request("b", "h2", { host: 1 }))).toBeDefined();
    held.release();
    await settled();
    expect(order).toEqual(["queued"]);
  });

  it("orders plan steps by priority and everything else by age, merged by age", async () => {
    const slots = new SessionSlots();
    const caps = { daemon: 1 };
    const held = slots.tryAcquire(request("x", "local", caps))!;
    const order: string[] = [];
    const wait = (name: string, priority?: number) =>
      void slots.acquire(request("x", "local", caps, priority === undefined ? {} : { priority })).then((s) => {
        order.push(name);
        s.release();
      });
    wait("plan-low", 1); // oldest
    wait("adhoc-1");
    wait("plan-high", 9);
    wait("adhoc-2");
    await settled();
    held.release();
    await settled();
    await settled();
    // The oldest waiter is a plan step, so the plan side goes first and its *best* step goes;
    // the plan side's oldest is still older than adhoc-1, so it goes again; then age.
    expect(order).toEqual(["plan-high", "plan-low", "adhoc-1", "adhoc-2"]);
  });

  it("releases a waiter on abort without ever holding a slot", async () => {
    const slots = new SessionSlots();
    const held = slots.tryAcquire(request("a", "local", { daemon: 1 }))!;
    const abort = new AbortController();
    const waiting = slots.acquire(request("a", "local", { daemon: 1 }, { signal: abort.signal }));
    await settled();
    expect(slots.view().queued).toBe(1);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
    expect(slots.view()).toMatchObject({ inUse: { total: 1 }, queued: 0 });
    held.release();
    expect(slots.view().inUse.total).toBe(0);
  });

  it("re-reads caps, so a cap raised while steps wait lets them go on the next pump", async () => {
    const slots = new SessionSlots();
    let cap = 1;
    const caps = () => ({ daemon: cap });
    slots.tryAcquire({ agentId: "a", hostId: "local", caps })!;
    let granted = false;
    void slots.acquire({ agentId: "a", hostId: "local", caps }).then(() => (granted = true));
    await settled();
    expect(granted).toBe(false);
    cap = 2;
    slots.pump();
    await settled();
    expect(granted).toBe(true);
  });
});

// ------------------------------------------------------------------ through the orchestrator

interface Fake {
  orchestrator: Orchestrator;
  peak: { total: number; byAgent: Record<string, number>; byHost: Record<string, number> };
  opened: string[];
}

/** One single-step workflow per agent, `one-<agent>`, plus any extra workflow a test brings. */
function workflows(extra: string | undefined, agentIds: string[]): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  for (const id of agentIds)
    registry.register(
      parseWorkflow(`
id: one-${id}
name: one-${id}
start: work
nodes:
  work: { type: agent, agent: ${id}, prompt: "go" }
  done: { type: end }
edges: [{ from: work, to: done }]
`),
    );
  if (extra) registry.register(parseWorkflow(extra));
  return registry;
}

function fake(opts: {
  agents: object[];
  hosts?: { id: string; maxSessions?: number }[];
  maxAgentSessions?: number;
  workflow?: string;
  /** Held open until this resolves; defaults to a short timer so sessions overlap. */
  turn?: (agentId: string) => Promise<void>;
  openFails?: (n: number) => boolean;
}): Fake {
  const registry = new AgentRegistry();
  for (const h of opts.hosts ?? [{ id: "local" }]) registry.addHost(new LocalHost({ type: "local", ...h }));
  for (const a of opts.agents) registry.addAgent(AgentSpecSchema.parse({ command: "unused", ...a }));
  const live = { total: 0, byAgent: {} as Record<string, number>, byHost: {} as Record<string, number> };
  const peak = { total: 0, byAgent: {} as Record<string, number>, byHost: {} as Record<string, number> };
  const opened: string[] = [];
  let n = 0;
  const bump = (agentId: string, hostId: string, d: number) => {
    live.total += d;
    live.byAgent[agentId] = (live.byAgent[agentId] ?? 0) + d;
    live.byHost[hostId] = (live.byHost[hostId] ?? 0) + d;
    peak.total = Math.max(peak.total, live.total);
    peak.byAgent[agentId] = Math.max(peak.byAgent[agentId] ?? 0, live.byAgent[agentId]);
    peak.byHost[hostId] = Math.max(peak.byHost[hostId] ?? 0, live.byHost[hostId]);
  };
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    logger: silentLogger,
    agents: registry,
    ...(opts.maxAgentSessions === undefined ? {} : { maxAgentSessions: opts.maxAgentSessions }),
    workflows: workflows(
      opts.workflow,
      registry.listAgents().map((a) => a.id),
    ),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
    sessionFactory: async (o: OpenSessionOptions) => {
      n++;
      if (opts.openFails?.(n)) throw new OrcaError("AGENT_TRANSPORT", "spawn refused");
      bump(o.agent.id, o.host.id, 1);
      opened.push(o.agent.id);
      let close!: () => void;
      const closed = new Promise<void>((r) => (close = r));
      let open = true;
      const session: AgentSession = {
        id: `sess_${n}`,
        agentId: o.agent.id,
        hostId: o.host.id,
        cwd: o.cwd,
        acpSessionId: "acp",
        closed,
        configOptions: [],
        setConfigOption: async () => [],
        prompt: async () => {
          await (opts.turn ? opts.turn(o.agent.id) : new Promise((r) => setTimeout(r, 15)));
          return { stopReason: "end_turn" as const, durationMs: 1 };
        },
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => {
          if (!open) return;
          open = false;
          bump(o.agent.id, o.host.id, -1);
          close();
        },
      };
      return session;
    },
  });
  return { orchestrator, peak, opened };
}

const waits = (events: OrcaEvent[]) =>
  events.flatMap((e) => (e.type === "step.waiting" && e.payload.on === "agent-slot" ? [e.payload.detail] : []));

describe("Orchestrator session slots", () => {
  it("changes nothing with no limits configured", async () => {
    const { orchestrator, peak } = fake({ agents: [{ id: "a" }] });
    const runs = await Promise.all(Array.from({ length: 6 }, () => orchestrator.startAndRun({ workflowId: "one-a" })));
    expect(runs.map((r) => r.run.status)).toEqual(Array(6).fill("completed"));
    expect(peak.total).toBe(6);
    for (const r of runs) expect(waits(await orchestrator.events(r.run.id))).toEqual([]);
    expect(orchestrator.sessionSlots.view()).toEqual({
      limits: { agents: {}, hosts: {} },
      inUse: { total: 0, agents: {}, hosts: {} },
      queued: 0,
    });
  });

  it("never exceeds the daemon cap, and a waiting step says why", async () => {
    const { orchestrator, peak } = fake({ agents: [{ id: "a" }], maxAgentSessions: 2 });
    const runs = await Promise.all(Array.from({ length: 6 }, () => orchestrator.startAndRun({ workflowId: "one-a" })));
    expect(runs.map((r) => r.run.status)).toEqual(Array(6).fill("completed"));
    expect(peak.total).toBe(2);
    const reasons = (await Promise.all(runs.map((r) => orchestrator.events(r.run.id)))).flatMap(waits);
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set(["waiting for an agent slot: 2 of 2 in use on this daemon"]));
    expect(orchestrator.sessionSlots.view()).toMatchObject({ limits: { maxAgentSessions: 2 }, inUse: { total: 0 } });
  });

  it("holds mixed daemon, agent and host caps at once", async () => {
    const { orchestrator, peak } = fake({
      hosts: [{ id: "local" }, { id: "box-b", maxSessions: 2 }],
      agents: [{ id: "a", maxSessions: 1 }, { id: "b", hostId: "box-b" }, { id: "c", hostId: "box-b" }, { id: "d" }],
      maxAgentSessions: 4,
    });
    const agents = ["a", "a", "a", "b", "b", "c", "c", "d", "d", "d"];
    const runs = await Promise.all(agents.map((agent) => orchestrator.startAndRun({ workflowId: `one-${agent}` })));
    expect(runs.every((r) => r.run.status === "completed")).toBe(true);
    expect(peak.byAgent.a).toBe(1);
    expect(peak.byHost["box-b"]).toBeLessThanOrEqual(2);
    expect(peak.total).toBeLessThanOrEqual(4);
    expect(orchestrator.sessionSlots.view().limits).toEqual({
      maxAgentSessions: 4,
      agents: { a: 1 },
      hosts: { "box-b": 2 },
    });
  });

  it("cancelling a waiting step releases it without leaking a slot", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const { orchestrator } = fake({ agents: [{ id: "a" }], maxAgentSessions: 1, turn: () => gate });
    const first = orchestrator.startAndRun({ workflowId: "one-a" });
    const secondId = await orchestrator.startRun({ workflowId: "one-a" });
    const second = orchestrator.run(secondId);
    await expect.poll(() => orchestrator.sessionSlots.view().queued).toBe(1);
    const state = await orchestrator.getState(secondId);
    const step = Object.values(state.steps)[0]!;
    expect(step).toMatchObject({
      status: "waiting",
      waitingOn: "agent-slot",
      waitingDetail: "waiting for an agent slot: 1 of 1 in use on this daemon",
    });
    // What `orca plan explain` and `schedule.explain` append for a dispatched item's run.
    expect(await orchestrator.plan.agentSlotWaits(secondId)).toEqual([
      "work: waiting for an agent slot: 1 of 1 in use on this daemon",
    ]);
    await orchestrator.cancel(secondId, "not now");
    expect((await second).run.status).toBe("cancelled");
    expect(orchestrator.sessionSlots.view()).toMatchObject({ inUse: { total: 1 }, queued: 0 });
    finish();
    expect((await first).run.status).toBe("completed");
    expect(orchestrator.sessionSlots.view().inUse.total).toBe(0);
  });

  it("a failed session open returns its slot", async () => {
    const { orchestrator } = fake({ agents: [{ id: "a" }], maxAgentSessions: 1, openFails: (n) => n === 1 });
    const failed = await orchestrator.startAndRun({ workflowId: "one-a" });
    expect(failed.run.status).toBe("failed");
    expect(orchestrator.sessionSlots.view().inUse.total).toBe(0);
    // With the slot leaked this would wait forever.
    const ok = await orchestrator.startAndRun({ workflowId: "one-a" });
    expect(ok.run.status).toBe("completed");
  });

  it("a per-run session holds one slot for the run and returns it when the run ends", async () => {
    const { orchestrator, opened } = fake({
      agents: [{ id: "a", sessionMode: "per-run" }],
      maxAgentSessions: 1,
      workflow: `
id: two
name: two
start: work
nodes:
  work: { type: agent, agent: a, prompt: "go" }
  next: { type: agent, agent: a, prompt: "again" }
  done: { type: end }
edges: [{ from: work, to: next }, { from: next, to: done }]
`,
    });
    const run = await orchestrator.startAndRun({ workflowId: "two" });
    expect(run.run.status).toBe("completed");
    expect(opened).toEqual(["a"]); // the second step reused the pooled session and its slot
    expect(orchestrator.sessionSlots.view().inUse.total).toBe(0);
  });

  it("a crashed session returns its slot", async () => {
    const slots = new SessionSlots();
    // The orchestrator releases on `session.closed`; model that wiring directly.
    const slot = slots.tryAcquire(request("a", "local", { daemon: 1 }))!;
    let crash!: () => void;
    const closed = new Promise<void>((r) => (crash = r));
    void closed.then(() => slot.release());
    crash();
    await settled();
    expect(slots.view().inUse.total).toBe(0);
  });
});

describe("configuration", () => {
  it("leaves every cap out by default and rejects non-positive caps", () => {
    const config = parseOrcaConfig({ agents: [{ id: "a", command: "x" }] });
    expect(config.limits).toBeUndefined();
    expect(config.agents[0]!.maxSessions).toBeUndefined();
    expect(config.hosts[0]).not.toHaveProperty("maxSessions");
    expect(() => parseOrcaConfig({ limits: { maxAgentSessions: 0 } })).toThrow();
    expect(() => parseOrcaConfig({ agents: [{ id: "a", command: "x", maxSessions: -1 }] })).toThrow();
    expect(() => parseOrcaConfig({ hosts: [{ id: "h", type: "ssh", host: "h", maxSessions: 1.5 }] })).toThrow();
    expect(
      parseOrcaConfig({
        limits: { maxAgentSessions: 4 },
        hosts: [{ id: "h", type: "ssh", host: "h", maxSessions: 2 }],
        agents: [{ id: "a", command: "x", maxSessions: 1 }],
      }),
    ).toMatchObject({ limits: { maxAgentSessions: 4 }, hosts: [{ maxSessions: 2 }], agents: [{ maxSessions: 1 }] });
  });

  it("records the wait detail on the step and clears it when the step moves on", () => {
    const at = "2026-11-22T00:00:00.000Z";
    const base = { runId: "run_1", at };
    const state = reduceRun([
      { ...base, id: "e1", seq: 1, type: "run.created", payload: { workflowId: "w", workflowVersion: "1", vars: {} } },
      {
        ...base,
        id: "e2",
        seq: 2,
        type: "step.scheduled",
        payload: { stepRunId: "s1", nodeId: "n", nodeType: "agent", attempt: 1 },
      },
      {
        ...base,
        id: "e3",
        seq: 3,
        type: "step.waiting",
        payload: { stepRunId: "s1", on: "agent-slot", detail: "full" },
      },
    ] as OrcaEvent[]);
    expect(state.steps.s1).toMatchObject({ waitingOn: "agent-slot", waitingDetail: "full" });
    const moved = reduceRun([
      ...([
        {
          ...base,
          id: "e1",
          seq: 1,
          type: "run.created",
          payload: { workflowId: "w", workflowVersion: "1", vars: {} },
        },
        {
          ...base,
          id: "e2",
          seq: 2,
          type: "step.scheduled",
          payload: { stepRunId: "s1", nodeId: "n", nodeType: "agent", attempt: 1 },
        },
        {
          ...base,
          id: "e3",
          seq: 3,
          type: "step.waiting",
          payload: { stepRunId: "s1", on: "agent-slot", detail: "full" },
        },
        { ...base, id: "e4", seq: 4, type: "step.waiting", payload: { stepRunId: "s1", on: "agent-turn" } },
      ] as OrcaEvent[]),
    ]);
    expect(moved.steps.s1).toMatchObject({ waitingOn: "agent-turn" });
    expect(moved.steps.s1).not.toHaveProperty("waitingDetail");
  });
});
