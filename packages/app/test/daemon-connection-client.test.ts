/** Client-side refusal before transport and the subscription's typed handshake verifier. */
import { expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { DaemonClient, DaemonClientError } from "../src/client/daemon-client.js";
import type { DaemonSubscriptionOptions } from "../src/client/subscription.js";

// Capture the transport boundary so its verifier can be checked independently of retry timers.
const { subscriptions } = vi.hoisted(() => ({ subscriptions: vi.fn<(options: DaemonSubscriptionOptions) => void>() }));
vi.mock("../src/client/subscription.js", () => ({
  DaemonSubscription: class {
    constructor(options: DaemonSubscriptionOptions) {
      subscriptions(options);
    }
  },
}));

it.each([undefined, ""])("requires an explicit remote credential before any fetch (%s)", async (token) => {
  const fetchImpl = vi.fn<typeof fetch>();
  const refresh = vi.fn(() => false);
  const client = new DaemonClient("https://daemon.example", fetchImpl, {
    requireAuthentication: true,
    auth: { read: () => token, refresh },
  });
  const pending = client.hello("connection-test");
  await expect(pending).rejects.toBeInstanceOf(DaemonClientError);
  await expect(pending).rejects.toMatchObject({
    error: { code: "AUTH_REQUIRED", message: "Remote daemon requires an explicit credential" },
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it("rejects an incompatible subscription hello with a typed protocol mismatch", async () => {
  subscriptions.mockClear();
  const hello = {
    protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 },
    orcaVersion: "incompatible-test",
    capabilities: ["runs.read", "runs.subscribe"],
  };
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result: hello })),
  );
  const onHello = vi.fn();
  const client = new DaemonClient("http://localhost:6722", fetchImpl, { onHello });
  client.subscribe({ params: {}, onNotification: () => {} });
  expect(subscriptions).toHaveBeenCalledTimes(1);
  const verify = subscriptions.mock.calls[0]?.[0].verify;
  expect(verify).toBeTypeOf("function");
  if (!verify) throw new Error("Expected an authenticated subscription verifier");
  const pending = verify();
  await expect(pending).rejects.toBeInstanceOf(DaemonClientError);
  await expect(pending).rejects.toMatchObject({
    error: { code: "PROTOCOL_VERSION", message: "Daemon protocol mismatch" },
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(onHello).toHaveBeenCalledWith(hello);
});
