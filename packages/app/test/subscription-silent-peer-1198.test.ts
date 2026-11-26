/**
 * #1198 end to end: a real daemon behind a relay that, like a server losing power, stops
 * carrying bytes in either direction without closing anything. The app's push socket must
 * leave `live` within the liveness bound, and come back once traffic flows again.
 */
import { createServer, connect, type Server, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { socketUrlFor } from "@orca/protocol";
import { AgentRegistry } from "@orca/agents";
import { TemplateRegistry, WorkflowRegistry, silentLogger } from "@orca/core";
import { Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { ReadModel, startDaemon, type DaemonHandle } from "@orca/daemon";
import { DaemonSubscription, type SubscriptionState } from "../src/client/subscription.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A TCP relay to `port` that can go silent: bytes stop, sockets stay open. */
async function relay(port: number) {
  let silent = false;
  const pairs: Socket[] = [];
  const server: Server = createServer((client) => {
    const upstream = connect(port, "127.0.0.1");
    pairs.push(client, upstream);
    client.on("data", (chunk) => void (silent || upstream.write(chunk)));
    upstream.on("data", (chunk) => void (silent || client.write(chunk)));
    for (const [a, b] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      a.on("error", () => b.destroy());
      a.on("close", () => b.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of pairs) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    set silent(value: boolean) {
      silent = value;
    },
  };
}

async function until(predicate: () => boolean, ms: number): Promise<number> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Date.now() - started;
}

it("a watched daemon whose traffic stops without a close goes to reconnecting within the bound", async () => {
  const stores = memoryStores();
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry(),
    templates: new TemplateRegistry(),
    logger: silentLogger,
  });
  const daemon: DaemonHandle = await startDaemon({
    orcaVersion: "0.1.0-test",
    capabilities: ["runs.read", "runs.subscribe"],
    auth: { mode: "loopback-unauthenticated" },
    reads: new ReadModel({ orchestrator }),
    source: orchestrator,
  });
  cleanups.push(() => daemon.close());
  const link = await relay(daemon.port);

  const states: SubscriptionState[] = [];
  const idleMs = 150;
  const timeoutMs = 250;
  const stream = new DaemonSubscription({
    url: socketUrlFor(link.url),
    params: {},
    backoffMs: [100],
    liveness: { idleMs, timeoutMs, subscribeTimeoutMs: 500 },
    onNotification: () => {},
    onState: (state) => states.push(state),
  });
  cleanups.push(() => stream.close());
  await until(() => stream.state === "live", 5_000);

  // A healthy daemon answers every probe: several idle windows later it is still live.
  await new Promise((resolve) => setTimeout(resolve, (idleMs + timeoutMs) * 3));
  expect(stream.state).toBe("live");
  expect(states).toEqual(["live"]);

  // Power off: nothing more arrives and nothing closes.
  link.silent = true;
  const noticed = await until(() => stream.state === "reconnecting", 5_000);
  expect(noticed).toBeLessThanOrEqual(idleMs + timeoutMs + 200);

  // Power back on: the next attempt subscribes again and is live.
  link.silent = false;
  await until(() => stream.state === "live", 5_000);
});
