/** Pending subscription authorization cannot outlive its authenticated connection. */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import type { OrcaEvent } from "@orca/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Authorizer, CredentialStore, OwnershipStore, TransportGate } from "../src/auth/index.js";
import { attachSocket, CLOSE_AUTH_INVALID } from "../src/socket.js";
import type { SubscriptionSource } from "../src/subscriptions.js";

const cleanups: (() => Promise<void>)[] = [];
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

async function pendingSubscribe() {
  const credentials = new CredentialStore();
  const issued = await credentials.issue({ principal: "reader", preset: "viewer" });
  const resolver = {
    run: async () => undefined,
    inputRun: async () => undefined,
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: () => false,
  };
  const ownership = new OwnershipStore();
  const authorizer = new Authorizer({ resolver, ownership });
  const entered = barrier();
  const release = barrier();
  const subscribeScope = authorizer.subscribeScope.bind(authorizer);
  vi.spyOn(authorizer, "subscribeScope").mockImplementationOnce(async (...args) => {
    // Hold the real authorization result, including its replay/silent decision.
    const scope = await subscribeScope(...args);
    entered.resolve();
    await release.promise;
    return scope;
  });
  const listeners = new Set<(event: OrcaEvent) => void>();
  const source = {
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }),
    eventsRange: vi.fn(async () => []),
  } satisfies SubscriptionSource;
  const server = createServer();
  const detach = attachSocket(server, {
    methods: {},
    ctx: { orcaVersion: "0.0.0-test", capabilities: ["runs.read", "runs.subscribe"] },
    source,
    gate: new TransportGate(
      { mode: "token", credentials, ownership, resolver, revalidateMs: 60_000 },
      "127.0.0.1",
      authorizer,
    ),
    authorizer,
  });
  const serverClosed = barrier();
  // Registered after ws's transport handlers: this resolves after server-side close cleanup.
  server.on("upgrade", (_req, socket) => socket.once("close", () => serverClosed.resolve()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, ["orca.v1"], {
    headers: { authorization: `Bearer ${issued.token}` },
  });
  cleanups.push(async () => {
    release.resolve();
    await detach();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });
  await once(ws, "open");
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ kind: "request", id: 1, method: "subscribe", params: { runId: "run-1", since: 0 } }));
  await entered.promise;
  expect(listeners.size).toBe(0);
  return { credentials, issued, source, listeners, ws, closed, serverClosed, release };
}

describe("subscription authorization lifecycle", () => {
  it("does not attach a source listener after the socket closes during authorization", async () => {
    const h = await pendingSubscribe();
    h.ws.close();
    await h.closed;
    await h.serverClosed.promise;
    h.release.resolve();
    // Drain the released authorization continuation before checking for retained listeners.
    await setImmediate();
    expect(h.listeners.size).toBe(0);
    expect(h.source.subscribe).not.toHaveBeenCalled();
    expect(h.source.eventsRange).not.toHaveBeenCalled();
  });

  it("rechecks revocation after authorization, before attaching or replaying", async () => {
    const h = await pendingSubscribe();
    await h.credentials.revoke(h.issued.credential.id);
    // The idle timer has not fired: registration itself must recheck the credential.
    expect(h.ws.readyState).toBe(WebSocket.OPEN);
    h.release.resolve();
    await setImmediate();
    expect(h.listeners.size).toBe(0);
    expect(h.source.subscribe).not.toHaveBeenCalled();
    expect(h.source.eventsRange).not.toHaveBeenCalled();
    expect((await h.closed)[0]).toBe(CLOSE_AUTH_INVALID);
    await h.serverClosed.promise;
  });

  it("registers an authorized subscription and detaches its listener on close", async () => {
    const h = await pendingSubscribe();
    const response = once(h.ws, "message");
    h.release.resolve();
    const [data] = (await response) as [Buffer];
    expect(JSON.parse(data.toString()) as unknown).toMatchObject({
      kind: "response",
      id: 1,
      ok: true,
      result: { subscriptionId: expect.any(String), replayed: 0 },
    });
    expect(h.source.subscribe).toHaveBeenCalledOnce();
    expect(h.source.eventsRange).toHaveBeenCalledWith("run-1", { after: 0 });
    expect(h.listeners.size).toBe(1);
    h.ws.close();
    await h.closed;
    await h.serverClosed.promise;
    expect(h.listeners.size).toBe(0);
  });
});
