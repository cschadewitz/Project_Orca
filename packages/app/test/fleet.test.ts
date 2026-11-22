/**
 * The watched machines (#882): each one its own connection, stream and fence; a frame or a
 * late read from one never lands on another; a machine that drops out stays on screen as
 * stale rather than as zero work; and the focused machine is never streamed twice.
 *
 * Driven against fake clients with fake timers. The fakes record what was asked of them and
 * hand back promises the test settles, so ordering — a read that answers after its
 * connection was replaced — is something a test states rather than hopes for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type DaemonNotification,
  type HelloResult,
  type InputsListResult,
  type RunsListResult,
} from "@orca/protocol";
import type { AlertsUpdate } from "../src/bridge.js";
import type { RetryCount, SubscriptionState } from "../src/client/subscription.js";
import {
  Fleet,
  labelAlerts,
  machineAlertId,
  type FleetClient,
  type FleetConnection,
  type FleetDeps,
  type FleetSnapshot,
  type FleetTarget,
  type FocusedMachine,
} from "../src/main/fleet.js";

const START = Date.UTC(2026, 10, 22, 12, 0, 0);
const QUIET = 5_000;
const DELAY = 300;

const ID_A = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};
const ID_B = {
  workspaceId: "33333333-3333-4333-8333-333333333333",
  instanceId: "44444444-4444-4444-8444-444444444444",
};

function hello(identity = ID_A, over: Partial<HelloResult> = {}): HelloResult {
  return {
    identity,
    protocol: PROTOCOL_VERSION,
    orcaVersion: "0.8.0",
    capabilities: ["runs.read", "runs.subscribe"],
    ...over,
  };
}

function runs(names: string[], status: "running" | "failed" = "running"): RunsListResult {
  return {
    runs: names.map((name) => ({
      id: `run-${name}`,
      name,
      workflowId: "wf",
      workflowVersion: "1",
      status,
      createdAt: new Date(START).toISOString(),
    })),
    total: names.length,
    asOf: new Date(START).toISOString(),
  };
}

function inputs(questions: string[]): InputsListResult {
  return {
    inputs: questions.map((question, index) => ({
      id: `in-${question}`,
      kind: "decision",
      question,
      options: [],
      context: {},
      runId: `run-${index}`,
      runName: `Run ${index}`,
      stepRunId: `step-${index}`,
      requestedAt: new Date(START).toISOString(),
      waitingMs: 0,
    })),
    waiting: questions.length,
    asOf: new Date(START).toISOString(),
  } as unknown as InputsListResult;
}

/** One fake daemon behind one connection. */
class FakeDaemon {
  runs = runs(["Build"]);
  failed = runs([], "failed");
  inputs = inputs([]);
  /** When set, reads wait on this instead of answering at once. */
  gate: Promise<void> | undefined;
  reads = 0;
  streams: {
    onNotification: (n: DaemonNotification) => void;
    onState: (s: SubscriptionState, r: RetryCount) => void;
    closed: boolean;
  }[] = [];
  released = 0;
  onHello: ((hello: HelloResult) => void) | undefined;

  client(): FleetClient {
    return {
      runsList: async (params) => {
        this.reads += 1;
        const snapshot = params.status?.includes("failed") ? this.failed : this.runs;
        await this.gate;
        return snapshot;
      },
      inputsList: async () => {
        const snapshot = this.inputs;
        await this.gate;
        return snapshot;
      },
      subscribe: (options) => {
        const stream = { onNotification: options.onNotification, onState: options.onState, closed: false };
        this.streams.push(stream);
        return {
          close: () => {
            stream.closed = true;
          },
        };
      },
    };
  }

  get stream() {
    const open = this.streams.filter((s) => !s.closed);
    return open[open.length - 1]!;
  }

  /** The subscription verified and went live. */
  live(identity = ID_A, over: Partial<HelloResult> = {}): void {
    this.onHello?.(hello(identity, over));
    this.stream.onState("live", { consecutive: 0, atCap: 0 });
  }

  drop(atCap = 0): void {
    this.stream.onState("reconnecting", { consecutive: atCap + 1, atCap });
  }

  push(n: DaemonNotification): void {
    this.stream.onNotification(n);
  }
}

const profile = (id: string, name = id): Extract<FleetTarget, { kind: "profile" }> => ({
  kind: "profile",
  id,
  name,
  destination: `${id}.example`,
});

function setup(over: Partial<FleetDeps> = {}) {
  const daemons = new Map<string, FakeDaemon>();
  const snapshots: FleetSnapshot[] = [];
  const alerts: AlertsUpdate[] = [];
  const opened: string[] = [];
  let failOpen: Error | undefined;
  const focusedDaemon = new FakeDaemon();
  let focusedEpoch = 1;
  const deps: FleetDeps = {
    open: async (target, hooks) => {
      const key = target.kind === "profile" ? target.id : "bundled";
      opened.push(key);
      if (failOpen) throw failOpen;
      const daemon = daemons.get(key) ?? new FakeDaemon();
      daemons.set(key, daemon);
      daemon.onHello = hooks.onHello;
      const connection: FleetConnection = {
        client: daemon.client(),
        release: async () => {
          daemon.released += 1;
        },
      };
      return connection;
    },
    focusedReader: () => ({ reader: focusedDaemon.client(), epoch: focusedEpoch }),
    onChange: (snapshot) => snapshots.push(snapshot),
    onAlerts: (update) => alerts.push(update),
    now: () => Date.now(),
    quietMs: QUIET,
    refreshDelayMs: DELAY,
    reopenBackoffMs: [1_000],
    ...over,
  };
  const fleet = new Fleet(deps);
  return {
    fleet,
    daemons,
    snapshots,
    alerts,
    opened,
    focusedDaemon,
    setFocusedEpoch: (epoch: number) => {
      focusedEpoch = epoch;
    },
    failOpens: (error: Error | undefined) => {
      failOpen = error;
    },
    last: () => snapshots[snapshots.length - 1]!,
    lastAlerts: () => alerts[alerts.length - 1]!,
    machine: (key: string) => snapshots[snapshots.length - 1]!.machines.find((m) => m.key === key),
  };
}

const settle = async (ms = DELAY) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("watched machines", () => {
  it("streams every watched machine on its own connection and shows each one's work under its name", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha", "Alpha"), profile("beta", "Beta")]);
    await settle(0);
    const alpha = t.daemons.get("alpha")!;
    const beta = t.daemons.get("beta")!;
    alpha.runs = runs(["Build", "Lint"]);
    beta.runs = runs(["Deploy"]);
    beta.inputs = inputs(["Ship it?"]);
    alpha.live();
    beta.live(ID_B);
    await settle(0);

    expect(t.machine("profile:alpha")).toMatchObject({
      name: "Alpha",
      detail: "ssh alpha.example",
      state: "live",
      focused: false,
      request: { profile: "alpha" },
      work: { activeTotal: 2, waiting: 0 },
    });
    expect(t.machine("profile:alpha")!.work!.runs.map((r) => r.name)).toEqual(["Build", "Lint"]);
    expect(t.machine("profile:beta")!.work!.runs.map((r) => r.name)).toEqual(["Deploy"]);
    expect(t.machine("profile:beta")!.work!.inputs.map((i) => i.question)).toEqual(["Ship it?"]);
    expect(alpha.streams).toHaveLength(1);
    expect(beta.streams).toHaveLength(1);
  });

  it("never shows a machine that has not answered as zero work", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha")]);
    await settle(0);
    expect(t.machine("profile:alpha")!.work).toBeUndefined();
    expect(t.machine("profile:alpha")!.state).toBe("reconnecting");
  });

  it("drops a frame from a closed connection instead of reading into its replacement", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha")]);
    await settle(0);
    const daemon = t.daemons.get("alpha")!;
    daemon.live();
    await settle(0);
    const oldStream = daemon.stream;
    // The profile is edited: the old connection closes and a new one opens.
    t.fleet.setTargets([{ ...profile("alpha"), destination: "moved.example" }]);
    await settle(0);
    expect(oldStream.closed).toBe(true);
    expect(daemon.released).toBe(1);
    const reads = daemon.reads;
    oldStream.onNotification({ method: "run.changed", params: {} } as unknown as DaemonNotification);
    oldStream.onState("live", { consecutive: 0, atCap: 0 });
    await settle();
    expect(daemon.reads).toBe(reads);
    expect(t.machine("profile:alpha")!.state).not.toBe("live");
  });

  it("drops a late read from an earlier connection", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha")]);
    await settle(0);
    const daemon = t.daemons.get("alpha")!;
    let open!: () => void;
    daemon.gate = new Promise((resolve) => (open = resolve));
    daemon.runs = runs(["Old store run"]);
    daemon.live();
    await settle(0);
    // While that read is outstanding, the connection is replaced and the new one answers first.
    t.fleet.setTargets([{ ...profile("alpha"), name: "Renamed" }]);
    await settle(0);
    daemon.gate = undefined;
    daemon.runs = runs(["New run"]);
    daemon.live();
    await settle(0);
    open();
    await settle(0);
    expect(t.machine("profile:alpha")!.work!.runs.map((r) => r.name)).toEqual(["New run"]);
  });

  it("clears and rereads when a reconnect lands on another store", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha")]);
    await settle(0);
    const daemon = t.daemons.get("alpha")!;
    let open!: () => void;
    daemon.runs = runs(["From A"]);
    daemon.live(ID_A);
    await settle(0);
    expect(t.machine("profile:alpha")!.work!.runs[0]!.name).toBe("From A");
    daemon.gate = new Promise((resolve) => (open = resolve));
    daemon.push({ method: "run.changed", params: {} } as unknown as DaemonNotification);
    await settle();
    // The reply to that read is in flight when the daemon turns out to be another store.
    daemon.drop();
    daemon.onHello!(hello(ID_B));
    expect(t.machine("profile:alpha")!.work).toBeUndefined();
    open();
    await settle(0);
    expect(t.machine("profile:alpha")!.work).toBeUndefined();
    daemon.gate = undefined;
    daemon.runs = runs(["From B"]);
    daemon.stream.onState("live", { consecutive: 0, atCap: 0 });
    await settle(0);
    expect(t.machine("profile:alpha")!.work!.runs[0]!.name).toBe("From B");
  });

  it("shows a dropped machine as stale without touching the others, and restores it without duplicates", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha"), profile("beta")]);
    await settle(0);
    const alpha = t.daemons.get("alpha")!;
    const beta = t.daemons.get("beta")!;
    alpha.inputs = inputs(["Approve?"]);
    alpha.live();
    beta.live(ID_B);
    await settle(0);

    alpha.drop();
    // A blip is not news for five seconds, exactly as the status bar holds it back.
    expect(t.machine("profile:alpha")!.state).toBe("live");
    await settle(QUIET + 1);
    const stale = t.machine("profile:alpha")!;
    expect(stale.state).toBe("reconnecting");
    expect(stale.staleSince).toBe(new Date(START).toISOString());
    // Last known work stays, marked by staleSince, rather than going to zero.
    expect(stale.work!.waiting).toBe(1);
    expect(t.machine("profile:beta")!.state).toBe("live");
    alpha.drop(3);
    expect(t.machine("profile:alpha")!.state).toBe("disconnected");

    alpha.stream.onState("live", { consecutive: 0, atCap: 0 });
    await settle(0);
    const back = t.machine("profile:alpha")!;
    expect(back.state).toBe("live");
    expect(back.staleSince).toBeUndefined();
    // A reconnect rereads the whole picture: one ask, not two.
    expect(back.work!.inputs).toHaveLength(1);
    expect(t.lastAlerts().items.filter((i) => i.inputId === "in-Approve?")).toHaveLength(1);
  });

  it("retries a machine whose tunnel would not open, and says why meanwhile", async () => {
    const t = setup();
    t.failOpens(new Error("ssh: connect to host alpha.example: Connection refused"));
    t.fleet.setTargets([profile("alpha")]);
    await settle(0);
    expect(t.machine("profile:alpha")).toMatchObject({ state: "disconnected" });
    expect(t.machine("profile:alpha")!.reason).toBeTruthy();
    t.failOpens(undefined);
    await settle(1_000);
    expect(t.opened).toEqual(["alpha", "alpha"]);
    t.daemons.get("alpha")!.live();
    await settle(0);
    expect(t.machine("profile:alpha")).toMatchObject({ state: "live" });
    expect(t.machine("profile:alpha")!.reason).toBeUndefined();
  });

  it("reads again on a burst of frames once, and ignores agent chatter", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha")]);
    await settle(0);
    const daemon = t.daemons.get("alpha")!;
    daemon.live();
    await settle(0);
    const reads = daemon.reads;
    daemon.push({ method: "agent.update", params: {} } as unknown as DaemonNotification);
    await settle();
    expect(daemon.reads).toBe(reads);
    for (let i = 0; i < 5; i++) daemon.push({ method: "step.changed", params: {} } as unknown as DaemonNotification);
    await settle();
    expect(daemon.reads).toBe(reads + 1);
  });

  it("reports session slots from the handshake", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha")]);
    await settle(0);
    t.daemons.get("alpha")!.live(ID_A, { sessionSlots: { maxAgentSessions: 4, inUse: 3, queued: 2 } });
    await settle(0);
    expect(t.machine("profile:alpha")!.slots).toEqual({ maxAgentSessions: 4, inUse: 3, queued: 2 });
  });

  it("shows a daemon on a protocol this app cannot speak as a mismatch", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha")]);
    await settle(0);
    t.daemons.get("alpha")!.live(ID_A, { protocol: { major: 99, minor: 0 } });
    await settle(0);
    expect(t.machine("profile:alpha")!.state).toBe("mismatch");
  });

  it("closes a machine that is no longer watched", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha"), profile("beta")]);
    await settle(0);
    t.fleet.setTargets([profile("beta")]);
    expect(t.daemons.get("alpha")!.released).toBe(1);
    expect(t.last().machines.map((m) => m.key)).toEqual(["profile:beta"]);
    await t.fleet.close();
    expect(t.daemons.get("beta")!.released).toBe(1);
  });
});

describe("the focused machine", () => {
  const focused = (over: Partial<FocusedMachine> = {}): FocusedMachine => ({
    key: "profile:alpha",
    name: "Alpha",
    detail: "ssh alpha.example",
    epoch: 1,
    state: "live",
    since: new Date(START).toISOString(),
    ...over,
  });

  it("is never streamed twice: a watched machine that becomes focused closes, and reopens when focus leaves", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha"), profile("beta")]);
    await settle(0);
    const alpha = t.daemons.get("alpha")!;
    t.fleet.setFocused(focused());
    expect(alpha.stream).toBeUndefined();
    expect(alpha.released).toBe(1);
    expect(t.last().machines.map((m) => [m.key, m.focused])).toEqual([
      ["profile:alpha", true],
      ["profile:beta", false],
    ]);
    expect(t.fleet.usesProfile("alpha")).toBe(false);

    t.fleet.setFocused(focused({ key: "profile:beta", name: "Beta", epoch: 2 }));
    await settle(0);
    expect(alpha.streams.filter((s) => !s.closed)).toHaveLength(1);
    expect(t.daemons.get("beta")!.released).toBe(1);
    expect(t.last().machines.map((m) => [m.key, m.focused])).toEqual([
      ["profile:beta", true],
      ["profile:alpha", false],
    ]);
  });

  it("reads the focused machine through the workspace and drops a read from a previous epoch", async () => {
    const t = setup();
    let open!: () => void;
    t.focusedDaemon.gate = new Promise((resolve) => (open = resolve));
    t.focusedDaemon.runs = runs(["Old target run"]);
    t.fleet.setFocused(focused({ key: "bundled", name: "This computer", epoch: 1 }));
    await settle();
    // Focus moves before the read answers.
    t.setFocusedEpoch(2);
    t.fleet.setFocused(focused({ key: "profile:beta", name: "Beta", epoch: 2 }));
    open();
    await settle(0);
    expect(t.machine("profile:beta")!.work).toBeUndefined();
    t.focusedDaemon.gate = undefined;
    t.focusedDaemon.runs = runs(["Beta run"]);
    t.fleet.focusedChanged({ method: "run.changed", params: {} } as unknown as DaemonNotification);
    await settle();
    expect(t.machine("profile:beta")!.work!.runs[0]!.name).toBe("Beta run");
  });

  it("leaves the focused machine's alerts to its renderer and labels every other machine's", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha", "Alpha"), profile("beta", "Beta")]);
    await settle(0);
    t.daemons.get("alpha")!.inputs = inputs(["Merge?"]);
    t.daemons.get("beta")!.inputs = inputs(["Deploy?"]);
    t.daemons.get("alpha")!.live();
    t.daemons.get("beta")!.live(ID_B);
    await settle(0);
    expect(t.lastAlerts().waiting).toBe(2);
    expect(t.lastAlerts().items.map((i) => [i.id, i.title, i.machine?.name])).toEqual([
      [machineAlertId("profile:alpha", "in-Merge?"), "Run 0 is waiting on Alpha", "Alpha"],
      [machineAlertId("profile:beta", "in-Deploy?"), "Run 0 is waiting on Beta", "Beta"],
    ]);
    t.fleet.setFocused(focused());
    expect(t.lastAlerts().items.map((i) => i.machine?.name)).toEqual(["Beta"]);
    expect(t.lastAlerts().waiting).toBe(1);
  });

  it("turns only failures it saw happen into alerts", async () => {
    const t = setup();
    t.fleet.setTargets([profile("alpha", "Alpha")]);
    await settle(0);
    const daemon = t.daemons.get("alpha")!;
    daemon.failed = runs(["Earlier", "Now"], "failed");
    daemon.live();
    await settle(0);
    expect(t.lastAlerts().items).toEqual([]);
    daemon.push({
      method: "run.changed",
      params: { runId: "run-Now", event: "run.failed" },
    } as unknown as DaemonNotification);
    await settle();
    expect(t.lastAlerts().items.map((i) => [i.tier, i.title])).toEqual([["failure", "Now failed on Alpha"]]);
  });
});

describe("labelAlerts", () => {
  it("scopes ids by machine so an alert keeps its id when focus moves", () => {
    const item = { id: "in-1", tier: "gate" as const, title: "Build is waiting", body: "?", runId: "r", since: "x" };
    const focused = labelAlerts([item], { key: "profile:a", name: "A", focused: true }, false);
    const watched = labelAlerts([item], { key: "profile:a", name: "A", focused: false }, true);
    expect(focused[0]!.id).toBe(watched[0]!.id);
    expect(focused[0]!.title).toBe("Build is waiting");
    expect(watched[0]!.title).toBe("Build is waiting on A");
  });
});
