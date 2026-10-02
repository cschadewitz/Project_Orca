import { expect, it, vi } from "vitest";
import { DaemonSubscription, type SocketHandlers } from "../src/client/subscription.js";
it("delivers expiry without advancing the cursor and ignores frames from a replaced connection", async () => {
  const sockets: { handlers: SocketHandlers; send: ReturnType<typeof vi.fn> }[] = [];
  const notify = vi.fn();
  const stream = new DaemonSubscription({
    url: "ws://localhost",
    params: { runId: "run", since: 12 },
    backoffMs: [0],
    verify: async () => ({ workspaceId: "workspace", instanceId: "boot" }),
    onNotification: notify,
    socket: (_url, handlers) => {
      const send = vi.fn();
      sockets.push({ handlers, send });
      return { send, close: () => {} };
    },
  });
  const message = JSON.stringify({
    kind: "notification",
    method: "input.invalidated",
    params: {
      subscriptionId: "sub",
      runId: "run",
      at: "2026-10-02T00:00:00Z",
      target: {
        runId: "run",
        stepRunId: "step",
        requestId: "ask",
        instanceId: "boot",
        sessionId: "session",
        turnId: "turn",
        invocationId: "invocation",
      },
    },
  });
  try {
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.handlers.onOpen();
    sockets[0]!.handlers.onMessage(
      JSON.stringify({
        kind: "notification",
        method: "run.changed",
        params: { subscriptionId: "sub", runId: "run", seq: 12, at: "now", status: "running", event: "run.started" },
      }),
    );
    notify.mockClear();
    sockets[0]!.handlers.onMessage(message);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(stream.lastSeq).toBe(12);
    sockets[0]!.handlers.onClose();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.handlers.onOpen();
    expect(sockets[1]!.send.mock.calls[0]![0]).toContain('"since":12');
    sockets[0]!.handlers.onMessage(message);
    expect(notify).toHaveBeenCalledTimes(1);
    sockets[1]!.handlers.onMessage(message);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(stream.lastSeq).toBe(12);
  } finally {
    stream.close();
  }
});
