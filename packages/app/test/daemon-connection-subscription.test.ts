import { expect, it, vi } from "vitest";
import { DaemonSubscription, type SocketHandlers } from "../src/client/subscription.js";
it("drops the old cursor after a new boot/backup rewind and ignores old socket frames", async () => {
  const sockets: { handlers: SocketHandlers; send: ReturnType<typeof vi.fn> }[] = [];
  let boot = "first";
  const notify = vi.fn();
  const stream = new DaemonSubscription({
    url: "ws://localhost",
    params: { runId: "run", since: 50 },
    backoffMs: [0],
    verify: async () => ({ workspaceId: "workspace", instanceId: boot }),
    onNotification: notify,
    socket: (_url, handlers) => {
      const send = vi.fn();
      sockets.push({ handlers, send });
      return { send, close: () => {} };
    },
  });
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.handlers.onOpen();
  expect(sockets[0]!.send.mock.calls[0]![0]).toContain('"since":50');
  boot = "restored";
  sockets[0]!.handlers.onClose();
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  sockets[1]!.handlers.onOpen();
  expect(sockets[1]!.send.mock.calls[0]![0]).not.toContain('"since"');
  sockets[0]!.handlers.onMessage(
    JSON.stringify({ kind: "notification", method: "event.appended", params: { runId: "run", seq: 900 } }),
  );
  expect(stream.lastSeq).toBeUndefined();
  expect(notify).not.toHaveBeenCalled();
  stream.close();
});
