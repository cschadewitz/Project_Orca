/**
 * #1198: a watched machine that loses power sends no close. The push socket asks a silent
 * peer whether it is still there and drops it when nothing answers, so the state leaves
 * `live` within LIVENESS_IDLE_MS + LIVENESS_TIMEOUT_MS rather than whenever TCP or the SSH
 * tunnel's keepalive gives up.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DaemonSubscription,
  LIVENESS_IDLE_MS,
  LIVENESS_PROBE_ID,
  LIVENESS_TIMEOUT_MS,
  SUBSCRIBE_TIMEOUT_MS,
  type SocketHandlers,
  type SubscriptionState,
} from "../src/client/subscription.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

interface Fake {
  handlers: SocketHandlers;
  sent: { id: number; method: string; params: unknown }[];
  closed: boolean;
}

function harness() {
  const sockets: Fake[] = [];
  const states: SubscriptionState[] = [];
  const stream = new DaemonSubscription({
    url: "ws://machine.invalid",
    params: {},
    backoffMs: [60_000],
    onNotification: () => {},
    onState: (state) => states.push(state),
    socket: (_url, handlers) => {
      const fake: Fake = { handlers, sent: [], closed: false };
      sockets.push(fake);
      return {
        send: (text) => fake.sent.push(JSON.parse(text) as Fake["sent"][number]),
        close: () => {
          fake.closed = true;
        },
      };
    },
  });
  /** Open the latest socket and accept its subscribe, as a healthy daemon does. */
  const live = () => {
    const socket = sockets.at(-1)!;
    socket.handlers.onOpen();
    const subscribe = socket.sent.at(-1)!;
    socket.handlers.onMessage(
      JSON.stringify({
        kind: "response",
        id: subscribe.id,
        ok: true,
        result: { subscriptionId: "sub-1", replayed: 0 },
      }),
    );
    return socket;
  };
  const answer = (socket: Fake) => {
    const probe = socket.sent.at(-1)!;
    socket.handlers.onMessage(JSON.stringify({ kind: "response", id: probe.id, ok: true, result: { stopped: false } }));
  };
  return { sockets, states, stream, live, answer };
}

it("a peer that stops answering without a close leaves `live` within the documented bound", () => {
  const { stream, states, live } = harness();
  const socket = live();
  expect(stream.state).toBe("live");

  // Power off: no close, no frames. The bound is idle + timeout, 6 s.
  vi.advanceTimersByTime(LIVENESS_IDLE_MS);
  expect(socket.sent.at(-1)).toMatchObject({ method: "unsubscribe", params: { subscriptionId: LIVENESS_PROBE_ID } });
  expect(stream.state).toBe("live");
  vi.advanceTimersByTime(LIVENESS_TIMEOUT_MS);
  expect(stream.state).toBe("reconnecting");
  expect(states).toEqual(["live", "reconnecting"]);
  expect(socket.closed).toBe(true);
  expect(LIVENESS_IDLE_MS + LIVENESS_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  stream.close();
});

it("a peer that answers stays live, and traffic alone counts as an answer", () => {
  const { stream, sockets, live, answer } = harness();
  const socket = live();
  for (let minute = 0; minute < 10; minute++) {
    vi.advanceTimersByTime(LIVENESS_IDLE_MS);
    answer(socket);
  }
  // A busy stream is never asked at all.
  const asked = socket.sent.length;
  for (let i = 0; i < 20; i++) {
    vi.advanceTimersByTime(LIVENESS_IDLE_MS - 1);
    socket.handlers.onMessage(JSON.stringify({ kind: "notification", method: "plan.changed", params: {} }));
  }
  expect(socket.sent).toHaveLength(asked);
  expect(stream.state).toBe("live");
  expect(sockets).toHaveLength(1);
  stream.close();
});

it("a late close from the dropped socket is not counted twice, and the next socket is watched too", () => {
  const { stream, sockets, live } = harness();
  const first = live();
  vi.advanceTimersByTime(LIVENESS_IDLE_MS + LIVENESS_TIMEOUT_MS);
  expect(stream.retries.consecutive).toBe(1);
  first.handlers.onClose(1006);
  expect(stream.retries.consecutive).toBe(1);
  vi.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(2);
  live();
  expect(stream.state).toBe("live");
  vi.advanceTimersByTime(LIVENESS_IDLE_MS + LIVENESS_TIMEOUT_MS);
  expect(stream.state).toBe("reconnecting");
  stream.close();
});

it("a subscribe that is never answered counts as a failed connection", () => {
  const { stream, sockets } = harness();
  sockets[0]!.handlers.onOpen();
  vi.advanceTimersByTime(SUBSCRIBE_TIMEOUT_MS - 1);
  expect(stream.retries.consecutive).toBe(0);
  vi.advanceTimersByTime(1);
  expect(stream.retries.consecutive).toBe(1);
  expect(sockets[0]!.closed).toBe(true);
  stream.close();
});

it("a refused subscribe keeps its socket open, as before, with no probe and no deadline", () => {
  const { stream, sockets } = harness();
  const socket = sockets[0]!;
  socket.handlers.onOpen();
  socket.handlers.onMessage(
    JSON.stringify({
      kind: "response",
      id: socket.sent[0]!.id,
      ok: false,
      error: { code: "PROTOCOL_MESSAGE", message: "no" },
    }),
  );
  vi.advanceTimersByTime(SUBSCRIBE_TIMEOUT_MS * 3);
  expect(socket.closed).toBe(false);
  expect(socket.sent).toHaveLength(1);
  expect(stream.retries.consecutive).toBe(0);
  stream.close();
});

it("close() stops the watch", () => {
  const { stream, live } = harness();
  const socket = live();
  stream.close();
  vi.advanceTimersByTime(LIVENESS_IDLE_MS * 10);
  expect(socket.sent).toHaveLength(1);
});
