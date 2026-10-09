/** Scripted socket reconnects and in-memory renderer notification filtering. */
import { afterEach, describe, expect, it } from "vitest";
import { STEP_CHANGED, RUN_CHANGED, type DaemonNotification, type NotificationMessage } from "@orca/protocol";
import { DaemonSubscription, type SocketFactory, type SocketHandlers } from "../src/client/subscription.js";
import { createNotificationStream } from "../renderer/src/notifications.js";

/** The IPC seam. `send` is the main process's; `subscribe` is what the preload builds over. */
function ipcPair(): {
  send: (notification: NotificationMessage) => void;
  renderer: { subscribe: (listener: (n: NotificationMessage) => void) => () => void };
} {
  const listeners = new Set<(n: NotificationMessage) => void>();
  return {
    // A structured-clone round trip, the way an IPC frame actually arrives: the renderer
    // gets data, never a reference to a main-process object.
    send: (notification) => {
      const copy = JSON.parse(JSON.stringify(notification)) as NotificationMessage;
      for (const listener of [...listeners]) listener(copy);
    },
    renderer: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
  };
}

describe("daemon to renderer", () => {
  it("filters by run and by method, and drops the bridge subscription with the last listener", () => {
    const ipc = ipcPair();
    const stream = createNotificationStream(ipc.renderer);
    const mine: number[] = [];
    const every: string[] = [];
    const offOne = stream.on(STEP_CHANGED, (p) => mine.push(p.seq), { runId: "run-1" });
    const offAll = stream.onAny((n) => every.push(n.method));
    expect(stream.listeners).toBe(2);

    const step = (runId: string, seq: number): NotificationMessage => ({
      kind: "notification",
      method: STEP_CHANGED,
      params: {
        subscriptionId: "sub-1",
        runId,
        seq,
        at: "2026-03-01T09:00:00.000Z",
        stepRunId: "sr-1",
        status: "running",
        event: "step.started",
      },
    });
    ipc.send(step("run-1", 4));
    ipc.send(step("run-2", 9));
    ipc.send({ kind: "notification", method: "nope.unknown", params: {} });
    // Right method, wrong shape: validated at the boundary, so nothing downstream sees it.
    ipc.send({ kind: "notification", method: RUN_CHANGED, params: { runId: "run-1" } });

    expect(mine).toEqual([4]);
    expect(every).toEqual([STEP_CHANGED, STEP_CHANGED]);

    offOne();
    offAll();
    expect(stream.listeners).toBe(0);
    ipc.send(step("run-1", 5));
    expect(mine).toEqual([4]);
  });
});

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

const stepChanged = (runId: string, seq: number): string =>
  JSON.stringify({
    kind: "notification",
    method: STEP_CHANGED,
    params: {
      subscriptionId: "sub-1",
      runId,
      seq,
      at: "2026-03-01T09:00:00.000Z",
      stepRunId: "sr-1",
      status: "running",
      event: "step.started",
    },
  });

/** Let the microtask queue and a zero-delay timer both drain. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("reconnection", () => {
  const open: DaemonSubscription[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });

  function start(params: { runId?: string }, script: ReturnType<typeof scriptedSocket>): DaemonNotification[] {
    const seen: DaemonNotification[] = [];
    const subscription = new DaemonSubscription({
      url: "ws://x/socket",
      params,
      onNotification: (n) => seen.push(n),
      socket: script.factory,
      backoffMs: [0],
    });
    open.push(subscription);
    return seen;
  }

  it("resubscribes from the last sequence number it saw", async () => {
    const script = scriptedSocket();
    const seen = start({ runId: "run-1" }, script);
    await settle();

    const first = script.connections[0]!;
    expect(JSON.parse(first.sent[0]!)).toMatchObject({ method: "subscribe", params: { runId: "run-1" } });
    // No cursor on the first attempt: there is nothing to resume from yet.
    expect(JSON.parse(first.sent[0]!).params).not.toHaveProperty("since");

    first.handlers.onMessage(subscribed(1));
    first.handlers.onMessage(stepChanged("run-1", 7));
    expect(seen).toHaveLength(1);

    // The blip.
    first.handlers.onClose();
    await settle();
    const second = script.connections[1]!;
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ method: "subscribe", params: { runId: "run-1", since: 7 } });
  });

  it("backs off over repeated failures and resets once a subscribe succeeds", async () => {
    const script = scriptedSocket();
    start({ runId: "run-1" }, script);
    await settle();
    // Three connections that never subscribe: a daemon that is down.
    script.connections[0]!.handlers.onClose();
    await settle();
    script.connections[1]!.handlers.onClose();
    await settle();
    expect(script.connections).toHaveLength(3);
    // Still `reconnecting`: a socket that opened but has not had its subscribe answered is
    // not yet a stream, and the indicator must not claim otherwise.
    expect(open[0]!.state).toBe("reconnecting");

    script.connections[2]!.handlers.onMessage(subscribed(3));
    expect(open[0]!.state).toBe("live");
    script.connections[2]!.handlers.onClose();
    expect(open[0]!.state).toBe("reconnecting");
    await settle();
    expect(script.connections).toHaveLength(4);
  });

  it("keeps no cursor for a store-wide subscription: sequence numbers are per-run", async () => {
    const script = scriptedSocket();
    start({}, script);
    await settle();
    const first = script.connections[0]!;
    first.handlers.onMessage(subscribed(1));
    first.handlers.onMessage(stepChanged("run-1", 7));
    first.handlers.onMessage(stepChanged("run-2", 2));

    first.handlers.onClose();
    await settle();
    expect(JSON.parse(script.connections[1]!.sent[0]!).params).not.toHaveProperty("since");
  });

  it("stops for good on close: no more frames, no more connections", async () => {
    const script = scriptedSocket();
    const seen = start({ runId: "run-1" }, script);
    await settle();
    const first = script.connections[0]!;
    first.handlers.onMessage(subscribed(1));

    open[0]!.close();
    expect(open[0]!.state).toBe("closed");
    first.handlers.onMessage(stepChanged("run-1", 1));
    await settle();
    expect(seen).toEqual([]);
    expect(script.connections).toHaveLength(1);
    // Closing twice is not an error, and does not reopen anything.
    open[0]!.close();
    expect(script.connections).toHaveLength(1);
  });

  it("closes cleanly with a reconnect pending, and ignores a socket that opens afterwards", async () => {
    const script = scriptedSocket();
    // An empty backoff is "retry at once", and exercises the fallback when the list runs out.
    const seen: DaemonNotification[] = [];
    const subscription = new DaemonSubscription({
      url: "ws://x/socket",
      params: { runId: "run-1" },
      onNotification: (n) => seen.push(n),
      socket: script.factory,
      backoffMs: [],
    });
    open.push(subscription);
    await settle();
    // Close with the reconnect timer armed, before the second socket has opened.
    script.connections[0]!.handlers.onClose();
    subscription.close();
    await settle();
    expect(script.connections).toHaveLength(1);
    expect(seen).toEqual([]);

    // And the other way round: closed before its socket ever opened, so the subscribe that
    // the open would have sent is never sent at all.
    const early = new DaemonSubscription({
      url: "ws://x/socket",
      params: {},
      onNotification: () => {},
      socket: script.factory,
      backoffMs: [0],
    });
    open.push(early);
    early.close();
    await settle();
    expect(script.connections[1]!.sent).toEqual([]);
  });

  it("does not retry a subscribe the daemon refused: the connection is fine, the ask was not", async () => {
    const script = scriptedSocket();
    start({ runId: "run-1" }, script);
    await settle();
    script.connections[0]!.handlers.onMessage(
      JSON.stringify({ kind: "response", id: 1, ok: false, error: { code: "NOT_SUPPORTED", message: "no" } }),
    );
    await settle();
    expect(open[0]!.state).toBe("connecting");
    expect(script.connections).toHaveLength(1);
  });

  it("ignores anything on the wire that is not a message it asked for", async () => {
    const script = scriptedSocket();
    const seen = start({ runId: "run-1" }, script);
    await settle();
    const first = script.connections[0]!;
    first.handlers.onMessage("{");
    first.handlers.onMessage(JSON.stringify({ kind: "request", id: 1, method: "hello" }));
    // A response to a request this subscription never sent.
    first.handlers.onMessage(subscribed(99));
    first.handlers.onMessage(JSON.stringify({ kind: "notification", method: "nope.unknown", params: {} }));
    expect(seen).toEqual([]);
    expect(open[0]!.state).toBe("connecting");
  });
});
