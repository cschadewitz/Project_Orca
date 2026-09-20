/**
 * The connection state machine as a module: the mapping, the quiet window, the handshake on
 * every reconnection, and what a screen is allowed to conclude from the word it gets.
 *
 * The end-to-end drive — the real `DaemonSubscription` over a scripted socket, into this
 * machine, into the rendered chrome — is `renderer/test/connection-states.test.tsx`, because
 * the things #163 has to prove (no banner for a 400ms blip, a bar for a 6s one, a blocking
 * dialog for a daemon that came back older) are facts about a screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, formatProtocolVersion, type HelloResult } from "@orca/protocol";
import type { ConnectionSnapshot } from "../src/bridge.js";
import { ConnectionMachine, QUIET_MS, connectionStateFor } from "../src/main/connection-state.js";
import { writability, toConnection, clocksRun, isStale, timeDisplay } from "../renderer/src/connection.js";

const hello = (overrides: Partial<HelloResult> = {}): HelloResult => ({
  protocol: PROTOCOL_VERSION,
  orcaVersion: "0.2.0-test",
  capabilities: [],
  ...overrides,
});

describe("connectionStateFor", () => {
  const base = { link: "live", compatible: true, daemonGone: false } as const;

  it("is live only for a subscribed socket to a compatible daemon", () => {
    expect(connectionStateFor(base)).toBe("live");
  });

  it("is reconnecting for anything short of a stream", () => {
    expect(connectionStateFor({ ...base, link: "connecting" })).toBe("reconnecting");
    expect(connectionStateFor({ ...base, link: "reconnecting" })).toBe("reconnecting");
  });

  it("is disconnected when the transport has stopped trying, or the daemon we started has gone", () => {
    expect(connectionStateFor({ ...base, link: "closed" })).toBe("disconnected");
    expect(connectionStateFor({ ...base, daemonGone: true })).toBe("disconnected");
  });

  it("is mismatch whatever the transport is doing: reachable and unusable is its own state", () => {
    expect(connectionStateFor({ ...base, compatible: false })).toBe("mismatch");
    expect(connectionStateFor({ link: "reconnecting", compatible: false, daemonGone: true })).toBe("mismatch");
  });
});

describe("ConnectionMachine", () => {
  let pushed: ConnectionSnapshot[];
  let machine: ConnectionMachine;
  let answer: HelloResult | Error;

  const build = (): ConnectionMachine =>
    new ConnectionMachine({
      hello: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
      onChange: (snapshot) => pushed.push(snapshot),
    });

  /** Let the `hello` promise settle without moving the clock. */
  const settle = (): Promise<void> => Promise.resolve().then(() => undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    pushed = [];
    answer = hello();
    machine = build();
  });

  afterEach(() => {
    machine.close();
    vi.useRealTimers();
  });

  it("starts reconnecting and never pushes its own first state: a new window reads it", () => {
    expect(machine.current.state).toBe("reconnecting");
    expect(pushed).toEqual([]);
  });

  it("reaches live on a subscribed socket, and carries what the handshake said", async () => {
    machine.linkChanged("live");
    await settle();

    expect(machine.current.state).toBe("live");
    expect(machine.current.orcaVersion).toBe("0.2.0-test");
    expect(machine.current.capabilities).toEqual([]);
    /* Two frames, not one: the socket becomes a stream before the handshake answers, and
       the status bar should say `connected` at the first of those rather than wait out an
       HTTP round trip it does not need. The second frame is the version arriving. */
    expect(pushed.map((s) => s.state)).toEqual(["live", "live"]);
    expect(pushed.map((s) => s.orcaVersion)).toEqual([undefined, "0.2.0-test"]);
  });

  it("says nothing for a blip shorter than the quiet window", async () => {
    machine.linkChanged("live");
    await settle();
    pushed.length = 0;

    machine.linkChanged("reconnecting");
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(machine.current.state).toBe("live");

    machine.linkChanged("live");
    await settle();
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    // The state on screen never left `live`; only the handshake's own re-answer moved.
    expect(pushed.every((s) => s.state === "live")).toBe(true);
  });

  it("shows the reconnection after the quiet window, dated from when the connection went", async () => {
    machine.linkChanged("live");
    await settle();
    const wentAt = Date.now();
    pushed.length = 0;

    machine.linkChanged("reconnecting");
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(pushed.map((s) => s.state)).toEqual(["reconnecting"]);
    // Not "reconnecting… 0s": the bar appears already reading the true elapsed time.
    expect(new Date(pushed[0]!.since).getTime()).toBe(wentAt);
  });

  it("does not grant a second quiet window to a reconnection that gives up inside the first", async () => {
    machine.linkChanged("live");
    await settle();
    pushed.length = 0;

    machine.linkChanged("reconnecting");
    await vi.advanceTimersByTimeAsync(QUIET_MS - 100);
    machine.daemonExited();
    await vi.advanceTimersByTimeAsync(100);

    expect(pushed.map((s) => s.state)).toEqual(["disconnected"]);
  });

  it("re-handshakes on every reconnection, because the daemon may not be the same one", async () => {
    machine.linkChanged("live");
    await settle();
    pushed.length = 0;

    answer = hello({ protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 }, orcaVersion: "9.9.9" });
    machine.linkChanged("reconnecting");
    machine.linkChanged("live");
    await settle();

    // Immediate: a mismatch is not a blip, and it is the one state that blocks a person.
    expect(pushed.map((s) => s.state)).toEqual(["mismatch"]);
    expect(machine.current.versions).toEqual({
      app: formatProtocolVersion(PROTOCOL_VERSION),
      daemon: formatProtocolVersion({ major: PROTOCOL_VERSION.major + 1, minor: 0 }),
    });
  });

  it("keeps the last verdict when a live socket's daemon will not answer hello", async () => {
    machine.linkChanged("live");
    await settle();
    pushed.length = 0;

    answer = new Error("connect ECONNREFUSED");
    machine.linkChanged("reconnecting");
    machine.linkChanged("live");
    await settle();

    expect(machine.current.state).toBe("live");
    expect(pushed).toEqual([]);
  });

  it("pushes a moved cursor and nothing else", async () => {
    machine.linkChanged("live");
    await settle();
    pushed.length = 0;

    machine.sawCursor(7);
    machine.sawCursor(7);
    machine.sawCursor(undefined);
    machine.sawCursor(9);

    expect(pushed.map((s) => s.eventCursor)).toEqual([7, 9]);
  });

  it("stops pushing once closed", async () => {
    machine.linkChanged("live");
    await settle();
    machine.close();
    pushed.length = 0;

    machine.linkChanged("reconnecting");
    machine.daemonExited();
    machine.sawCursor(3);
    await vi.advanceTimersByTimeAsync(QUIET_MS * 2);

    expect(pushed).toEqual([]);
  });
});

describe("what a screen concludes from the state", () => {
  it("treats everything but live as last-known, with the clocks stopped", () => {
    expect(isStale("live")).toBe(false);
    expect(clocksRun("live")).toBe(true);
    expect(timeDisplay("live")).toBe("both");
    for (const state of ["reconnecting", "disconnected", "file", "mismatch"] as const) {
      expect(isStale(state)).toBe(true);
      expect(clocksRun(state)).toBe(false);
      // A relative time computed against a stale clock is a lie.
      expect(timeDisplay(state)).toBe("absolute");
    }
  });

  it("parses a snapshot into the shape the chrome renders, with capabilities never undefined", () => {
    const connection = toConnection({ state: "live", since: "2026-03-01T09:00:00.000Z" });
    expect(connection.since.toISOString()).toBe("2026-03-01T09:00:00.000Z");
    expect(connection.capabilities).toEqual([]);
    expect(connection.eventCursor).toBeUndefined();
  });
});

describe("can write, or why not", () => {
  const at = (state: Parameters<typeof writability>[0]["state"], capabilities: string[] = []) =>
    writability({ state, capabilities: capabilities as never });

  it("can write only when a live daemon advertises runs.control", () => {
    expect(at("live", ["runs.read", "runs.control"])).toEqual({ can: true });
  });

  it("explains an absent capability rather than reporting an error", () => {
    // The normal case today: no daemon advertises `runs.control` yet, and that is a calm
    // unavailability, not a failure.
    const writes = at("live", ["runs.read"]);
    expect(writes.can).toBe(false);
    expect(writes).toMatchObject({ reason: "this daemon offers no run control" });
  });

  it("gives the connection's reason first, because that is the one a person can act on", () => {
    expect(at("reconnecting", ["runs.control"])).toMatchObject({ can: false });
    expect(at("disconnected", ["runs.control"])).toEqual({ can: false, reason: "no daemon is answering" });
    expect(at("file", ["runs.control"])).toMatchObject({ can: false });
  });

  it("names both versions on a mismatch, and stays sayable without them", () => {
    expect(writability({ state: "mismatch", capabilities: [], versions: { app: "1.3", daemon: "1.2" } })).toEqual({
      can: false,
      reason: "the daemon speaks protocol 1.2, this app 1.3",
    });
    expect(at("mismatch")).toMatchObject({ can: false });
  });

  it("never says no without saying why", () => {
    for (const state of ["live", "reconnecting", "disconnected", "file", "mismatch"] as const) {
      const writes = at(state);
      if (!writes.can) expect(writes.reason.length).toBeGreaterThan(0);
    }
  });
});
