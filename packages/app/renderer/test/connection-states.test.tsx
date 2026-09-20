// @vitest-environment happy-dom
/**
 * The three things #163 has to prove, driven end to end with nothing faked but the socket
 * and the clock.
 *
 * The chain under test is the real one, minus Electron and minus a daemon: the real
 * `DaemonSubscription` over a scripted `SocketFactory`, its `onState` and its resume cursor
 * into the real `ConnectionMachine`, the machine's snapshots into the place the preload
 * would put them, and the whole chrome rendered on the far end. Nothing here decides a
 * connection state; every word on the screen is one the machine chose.
 *
 * Fake timers, because all three scenarios are about *when*: a blip that resolves in 400ms,
 * one that lasts six seconds, and a daemon that comes back speaking something else. A real
 * clock would make the first two flaky and the suite six seconds slower for nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PROTOCOL_VERSION, STEP_CHANGED, formatProtocolVersion, type HelloResult } from "@orca/protocol";
import { App } from "../src/App.js";
import { ConnectionMachine } from "../../src/main/connection-state.js";
import { DaemonSubscription, type SocketFactory, type SocketHandlers } from "../../src/client/subscription.js";
import { harness, installBridge, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

const RUN = "run-1";

/** A socket a test drives by hand: open it, push frames at it, close it under the client. */
function scriptedSocket(): { factory: SocketFactory; connections: { sent: string[]; handlers: SocketHandlers }[] } {
  const connections: { sent: string[]; handlers: SocketHandlers }[] = [];
  const factory: SocketFactory = (_url, handlers) => {
    const connection = { sent: [] as string[], handlers };
    connections.push(connection);
    // Asynchronously, the way a real one opens: the constructor returns before `onopen`.
    queueMicrotask(() => handlers.onOpen());
    return { send: (text) => connection.sent.push(text), close: () => handlers.onClose() };
  };
  return { factory, connections };
}

const subscribed = (id: number): string =>
  JSON.stringify({ kind: "response", id, ok: true, result: { subscriptionId: `sub-${id}`, replayed: 0 } });

const stepChanged = (seq: number): string =>
  JSON.stringify({
    kind: "notification",
    method: STEP_CHANGED,
    params: {
      subscriptionId: "sub-1",
      runId: RUN,
      seq,
      at: "2026-03-01T09:00:00.000Z",
      stepRunId: "sr-1",
      status: "running",
      event: "step.started",
    },
  });

const CURRENT: HelloResult = { protocol: PROTOCOL_VERSION, orcaVersion: "0.4.0-test", capabilities: [] };
/** A daemon from before the app: another major, which is the incompatible direction. */
const OLDER: HelloResult = { protocol: { major: 0, minor: 9 }, orcaVersion: "0.1.0-old", capabilities: [] };
const APP_PROTOCOL = formatProtocolVersion(PROTOCOL_VERSION);

/** The status bar's connection cell — the one `.orca-conn` in the chrome. */
const indicator = (): string => document.querySelector(".orca-conn")?.textContent ?? "";
/** The 2px rule under the chrome, which is what a stale screen looks like. */
const staleRule = (): Element | null => document.querySelector(".orca-connrule");

describe("the connection states, end to end", () => {
  let script: ReturnType<typeof scriptedSocket>;
  let subscription: DaemonSubscription;
  let machine: ConnectionMachine;
  let fake: FakeBridge;
  let h: Harness;
  let restore: (() => void)[];
  let daemon: HelloResult;
  /** The subscribe frames the daemon has answered, so each reconnection gets the next id. */
  let answered: number;

  /** Drain microtasks and any zero-delay timer, inside `act` so React commits what lands. */
  const settle = async (ms = 0): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  /** Answer the newest connection's `subscribe`, which is what makes the stream `live`. */
  const acceptSubscribe = async (): Promise<void> => {
    // A socket opens a microtask after it is constructed, and the `subscribe` goes out on
    // the open; answering before that would be answering a request nobody sent.
    await settle();
    const latest = script.connections[script.connections.length - 1]!;
    latest.handlers.onMessage(subscribed(++answered));
    await settle();
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    restore = [];
    answered = 0;
    daemon = CURRENT;
    stubMatchMedia(1440);

    script = scriptedSocket();
    // The main process, in this process: one subscription, one machine, and the machine's
    // snapshots pushed where the preload would push them.
    machine = new ConnectionMachine({
      hello: () => Promise.resolve(daemon),
      onChange: (snapshot) => fake.connect(snapshot),
    });
    subscription = new DaemonSubscription({
      url: "ws://x/socket",
      params: { runId: RUN },
      onNotification: () => machine.sawCursor(subscription.lastSeq),
      onState: (state) => machine.linkChanged(state),
      socket: script.factory,
      backoffMs: [0],
    });

    fake = installBridge({ connection: machine.current });
    restore.push(() => {
      subscription.close();
      machine.close();
    });
    h = harness();
    restore.push(h.dispose);

    const { Providers } = h;
    render(
      <Providers>
        <App />
      </Providers>,
    );
    await acceptSubscribe();
    // The starting position for all three scenarios: connected, with the stream at event 7.
    script.connections[0]!.handlers.onMessage(stepChanged(7));
    await settle();
    expect(indicator()).toContain("connected");
    expect(indicator()).toContain("event 7");
  });

  afterEach(() => {
    cleanup();
    while (restore.length) restore.pop()?.();
    vi.useRealTimers();
  });

  it("changes nothing on screen for a 400ms blip", async () => {
    script.connections[0]!.handlers.onClose();
    await settle(400);
    await acceptSubscribe();

    // Never a bar, never a word: someone reading a log was not interrupted.
    expect(staleRule()).toBeNull();
    expect(indicator()).toContain("connected");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("raises the bar after five seconds and puts it away in place, cursor resumed", async () => {
    script.connections[0]!.handlers.onClose();

    // Four seconds in, still nothing: the window is five.
    await settle(4_000);
    expect(staleRule()).toBeNull();
    expect(indicator()).toContain("connected");

    await settle(1_000);
    expect(staleRule()).not.toBeNull();
    expect(indicator()).toContain("reconnecting");

    // The resubscribe asks the daemon to carry on from where the stream got to.
    const reopened = script.connections[script.connections.length - 1]!;
    expect(JSON.parse(reopened.sent[0]!)).toMatchObject({ params: { runId: RUN, since: 7 } });

    await settle(1_000);
    await acceptSubscribe();
    reopened.handlers.onMessage(stepChanged(8));
    await settle();

    // In place: the same status bar, the bar gone, the cursor moved on rather than restarted.
    expect(staleRule()).toBeNull();
    expect(indicator()).toContain("connected");
    expect(indicator()).toContain("event 8");
  });

  it("blocks once when the daemon comes back on a protocol the app cannot type-check", async () => {
    daemon = OLDER;
    script.connections[0]!.handlers.onClose();
    await settle();
    await acceptSubscribe();

    // Synchronously: `findBy*` polls on a real clock, and this file's clock is not one.
    const dialog = screen.getByRole("dialog", { name: /version mismatch/i });
    expect(dialog.textContent).toContain("protocol 0.9");
    expect(dialog.textContent).toContain(`this app speaks ${APP_PROTOCOL}`);
    // Not a blip and not silent for five seconds: a mismatch stops a person at once.
    expect(indicator()).toContain("version mismatch");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue read-only" }));
    });

    // Once. What is left is the persistent bar, and an app that still reads.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/Everything on screen is readable/)).toBeTruthy();
    expect(indicator()).toContain("version mismatch");
  });
});
