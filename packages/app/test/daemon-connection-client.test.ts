/** Client-side refusal before transport and the subscription's typed handshake verifier. */
import { expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { DaemonClient, DaemonClientError } from "../src/client/daemon-client.js";
import type { DaemonSubscriptionOptions } from "../src/client/subscription.js";
import { ConnectionMachine } from "../src/main/connection-state.js";

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
  const pending = verify(() => true);
  await expect(pending).rejects.toBeInstanceOf(DaemonClientError);
  await expect(pending).rejects.toMatchObject({
    error: { code: "PROTOCOL_VERSION", message: "Daemon protocol mismatch" },
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(onHello).toHaveBeenCalledWith(hello);
});

it.each([
  undefined,
  { workspaceId: "2c7bf988-cf11-4f6d-9b36-77a4a7bf714f", instanceId: "44112345-b16c-44ba-831d-a66f44488f66" },
])("publishes a current subscription verdict exactly once with identity %s", async (identity) => {
  subscriptions.mockClear();
  const hello = {
    protocol: PROTOCOL_VERSION,
    orcaVersion: "compatible-test",
    capabilities: ["runs.read", "runs.subscribe"],
    ...(identity ? { identity } : {}),
  };
  const onHello = vi.fn();
  const client = new DaemonClient(
    "http://localhost:6722",
    async () => new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result: hello })),
    { onHello },
  );
  client.subscribe({ params: {}, onNotification: () => {} });
  const verify = subscriptions.mock.calls[0]![0].verify!;
  await expect(verify(() => true)).resolves.toEqual(identity);
  expect(onHello).toHaveBeenCalledExactlyOnceWith(hello);
});

it.each([
  "reconnecting",
  "auth-failed",
  "closed",
  "reset",
  "daemon-exited",
  "closed-machine",
  "verified-hello",
] as const)("invalidates pending handshake publication on %s", async (boundary) => {
  let answer!: (hello: Awaited<ReturnType<DaemonClient["hello"]>>) => void;
  const onHello = vi.fn();
  const machine = new ConnectionMachine({
    hello: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    onHello,
    onChange: () => {},
  });
  const hello = {
    protocol: PROTOCOL_VERSION,
    orcaVersion: "current",
    capabilities: [],
  };
  try {
    machine.linkChanged("live");
    if (boundary === "reset") machine.reset(false);
    else if (boundary === "daemon-exited") machine.daemonExited();
    else if (boundary === "closed-machine") machine.close();
    else if (boundary === "verified-hello") machine.acceptHello(hello);
    else machine.linkChanged(boundary);
    const before = machine.current;
    answer({ ...hello, orcaVersion: "stale" });
    await Promise.resolve();
    expect(onHello).not.toHaveBeenCalled();
    expect(machine.current).toEqual(before);
  } finally {
    machine.close();
  }
});

it.each(["AUTH_INVALID", "AUTH_REQUIRED", "AUTH_FORBIDDEN"] as const)(
  "publishes current handshake %s only through its owner",
  async (code) => {
    const onAuthFailure = vi.fn();
    const client = new DaemonClient(
      "http://localhost:6722",
      async () =>
        new Response(JSON.stringify({ kind: "response", id: 1, ok: false, error: { code, message: "Refused" } })),
      { onAuthFailure },
    );
    const machine = new ConnectionMachine({ hello: () => client.hello("current-handshake"), onChange: () => {} });
    try {
      machine.linkChanged("live");
      await vi.waitFor(() => expect(machine.current.state).toBe("disconnected"));
      expect(onAuthFailure).not.toHaveBeenCalled();
      await expect(client.hello("uncommitted-probe")).rejects.toMatchObject({ error: { code } });
      expect(onAuthFailure).not.toHaveBeenCalled();
    } finally {
      machine.close();
    }
  },
);
