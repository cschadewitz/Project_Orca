/** Handshake health per agent: the states, what makes one `degraded`, and what a restart forgets. */
import { describe, expect, it } from "vitest";
import { AgentHealthTracker, AgentRegistry, LocalHost } from "@orca/agents";
import { AgentSpecSchema, FakeClock, OrcaError } from "@orca/core";

const transportFailure = () => new OrcaError("AGENT_TRANSPORT", "initialize timed out after 30000ms");

describe("agent health", () => {
  it("reports an agent it has never contacted as unknown, not as a default", () => {
    const tracker = new AgentHealthTracker(new FakeClock());
    expect(tracker.get("builder")).toEqual({ agentId: "builder", state: "unknown", consecutiveFailures: 0 });
    // Nothing is invented: no last contact, no round trip, and nothing listed.
    expect(tracker.get("builder").lastContact).toBeUndefined();
    expect(tracker.get("builder").roundTripMs).toBeUndefined();
    expect(tracker.list()).toEqual([]);
  });

  it("records a clean handshake as ok, with its last contact and round trip", () => {
    const clock = new FakeClock();
    const tracker = new AgentHealthTracker(clock);
    const handshake = tracker.begin("builder");
    clock.advance(420);
    expect(handshake.ok()).toEqual({
      agentId: "builder",
      state: "ok",
      lastContact: clock.isoNow(),
      roundTripMs: 420,
      consecutiveFailures: 0,
    });
    expect(tracker.get("builder").state).toBe("ok");
    expect(tracker.list().map((h) => h.agentId)).toEqual(["builder"]);
  });

  it("records a failed spawn as down, with why", () => {
    const clock = new FakeClock();
    const tracker = new AgentHealthTracker(clock);
    const health = tracker.begin("builder").failed(transportFailure());
    expect(health.state).toBe("down");
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toEqual({ code: "AGENT_TRANSPORT", message: "initialize timed out after 30000ms" });
    expect(health.lastContact).toBe(clock.isoNow());
    // Nothing has ever answered, so there is no round trip to report.
    expect(health.roundTripMs).toBeUndefined();
  });

  it("counts consecutive failures and anything thrown, not only OrcaErrors", () => {
    const tracker = new AgentHealthTracker(new FakeClock());
    tracker.recordFailure("builder", transportFailure());
    const second = tracker.recordFailure("builder", new Error("spawn ENOENT"));
    expect(second.consecutiveFailures).toBe(2);
    expect(second.lastError).toEqual({ code: "INTERNAL", message: "spawn ENOENT" });
  });

  it("calls a handshake that succeeded only after a retry degraded, and the next clean one ok", () => {
    const clock = new FakeClock();
    const tracker = new AgentHealthTracker(clock);

    tracker.begin("builder").failed(transportFailure());
    const retried = tracker.begin("builder");
    clock.advance(900);
    const afterRetry = retried.ok();
    // Degraded is *only* this: a handshake that needed a second go. There is no latency
    // rule, so a slow-but-first-time handshake stays ok however long it took.
    expect(afterRetry.state).toBe("degraded");
    expect(afterRetry.roundTripMs).toBe(900);
    expect(afterRetry.consecutiveFailures).toBe(0);
    expect(afterRetry.lastError).toBeUndefined();

    const slowButClean = tracker.begin("builder");
    clock.advance(60_000);
    expect(slowButClean.ok()).toMatchObject({ state: "ok", roundTripMs: 60_000 });
  });

  it("keeps the last good round trip through a failure, so a down agent still says what it cost", () => {
    const clock = new FakeClock();
    const tracker = new AgentHealthTracker(clock);
    const first = tracker.begin("builder");
    clock.advance(120);
    first.ok();
    const down = tracker.begin("builder").failed(transportFailure());
    expect(down).toMatchObject({ state: "down", roundTripMs: 120, consecutiveFailures: 1 });
  });

  it("hands out copies, so a caller cannot edit the tracker's state", () => {
    const tracker = new AgentHealthTracker(new FakeClock());
    tracker.recordHandshake("builder", 10);
    tracker.get("builder").state = "down";
    tracker.list()[0]!.state = "down";
    expect(tracker.get("builder").state).toBe("ok");
  });

  it("forgets everything on reset, the way a restarted daemon does", () => {
    const tracker = new AgentHealthTracker(new FakeClock());
    tracker.recordHandshake("builder", 10);
    tracker.recordFailure("reviewer", transportFailure());
    tracker.reset();
    expect(tracker.list()).toEqual([]);
    expect(tracker.get("builder")).toEqual({ agentId: "builder", state: "unknown", consecutiveFailures: 0 });
    expect(tracker.get("reviewer").state).toBe("unknown");
    // And the agent that was degraded-by-retry starts again from nothing: the next
    // handshake is the first one this process has seen, so it is ok, not degraded.
    expect(tracker.recordHandshake("reviewer", 5).state).toBe("ok");
  });
});

describe("the registry's health view", () => {
  const registry = () =>
    new AgentRegistry(new FakeClock())
      .addHost(new LocalHost({ id: "local", type: "local" }))
      .addAgent(AgentSpecSchema.parse({ id: "builder", command: "x", hostId: "local" }))
      .addAgent(AgentSpecSchema.parse({ id: "remote", command: "y", hostId: "local" }));

  it("lists every configured agent, contacted or not, in configuration order", () => {
    const agents = registry();
    agents.health.recordHandshake("builder", 35);
    expect(agents.listHealth()).toEqual([
      {
        agentId: "builder",
        state: "ok",
        lastContact: new FakeClock().isoNow(),
        roundTripMs: 35,
        consecutiveFailures: 0,
      },
      { agentId: "remote", state: "unknown", consecutiveFailures: 0 },
    ]);
  });

  it("does not invent an agent from a recording for one it does not have", () => {
    const agents = registry();
    agents.health.recordFailure("ghost", transportFailure());
    expect(agents.listHealth().map((h) => h.agentId)).toEqual(["builder", "remote"]);
    expect(agents.health.get("ghost").state).toBe("down");
  });
});
