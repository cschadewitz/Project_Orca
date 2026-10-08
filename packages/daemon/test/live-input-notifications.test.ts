import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LiveHumanInput } from "@orca/engine";
import {
  parseNotification,
  type DaemonNotification,
  type LiveDecisionTarget,
  type NotificationMessage,
} from "@orca/protocol";
import { CredentialStore, OwnershipStore, type ResourceResolver } from "../src/auth/index.js";
import { LiveExecutionAuthorities } from "../src/live-input-authority.js";
import { Subscription, type SubscriptionSource } from "../src/subscriptions.js";
import { startDaemon } from "../src/server.js";
const target: LiveDecisionTarget = {
  instanceId: "boot",
  sessionId: "session",
  turnId: "turn",
  invocationId: "invocation",
  runId: "run",
  stepRunId: "step",
  requestId: "ask",
};
const source: SubscriptionSource = { subscribe: () => () => {}, eventsRange: async () => [] };
const teardown: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of teardown.splice(0).reverse()) await close();
});
function ask(port: LiveHumanInput, lifetime: AbortSignal, identity = target) {
  const emitOwned = vi.fn(async () => {});
  const result = port.ask({
    ...identity,
    kind: "permission",
    question: "Execute?",
    options: [{ id: "allow", label: "Allow" }],
    context: {},
    live: { identity, signal: lifetime, withOwnership: (operation) => operation(), emitOwned },
  });
  return { result, emitOwned };
}
it("honors run/method filters, sends no fake cursor, and detaches without consuming work", async () => {
  const port = new LiveHumanInput("boot");
  const abort = new AbortController();
  const pending = ask(port, abort.signal);
  const start = async (params: { runId?: string; methods?: ["input.invalidated"] | ["input.answered"] }) => {
    const frames: NotificationMessage[] = [];
    const subscription = new Subscription({
      id: "sub",
      params,
      source,
      liveInputs: port,
      send: (frame) => frames.push(frame),
    });
    await subscription.start();
    teardown.push(() => subscription.stop());
    return { frames, subscription };
  };
  const global = await start({});
  const exact = await start({ runId: "run", methods: ["input.invalidated"] });
  const other = await start({ runId: "other" });
  const answersOnly = await start({ methods: ["input.answered"] });
  const detached = await start({});
  detached.subscription.stop();
  expect(port.inspect(target)).toBe("pending");
  abort.abort("lease lost");
  expect(await pending.result).toBeUndefined();
  for (const frames of [global.frames, exact.frames]) {
    expect(frames).toHaveLength(1);
    expect(parseNotification(frames[0]!)).toMatchObject({
      method: "input.invalidated",
      params: { runId: "run", target },
    });
    expect(frames[0]!.params).not.toHaveProperty("seq");
  }
  expect(other.frames).toEqual([]);
  expect(answersOnly.frames).toEqual([]);
  expect(detached.frames).toEqual([]);
  expect(pending.emitOwned).not.toHaveBeenCalled();
});
it("attaches invalidations before replay completes and never replays an expired identity", async () => {
  const port = new LiveHumanInput("boot");
  const abort = new AbortController();
  const pending = ask(port, abort.signal);
  let complete!: (events: []) => void;
  const frames: NotificationMessage[] = [];
  const subscription = new Subscription({
    id: "sub",
    params: { runId: "run", since: 0 },
    liveInputs: port,
    source: {
      ...source,
      eventsRange: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
    send: (frame) => frames.push(frame),
  });
  const started = subscription.start();
  abort.abort("timeout");
  expect(frames).toHaveLength(1);
  complete([]);
  expect(await started).toBe(0);
  subscription.stop();
  expect(await pending.result).toBeUndefined();
  const reconnect: NotificationMessage[] = [];
  const next = new Subscription({
    id: "next",
    params: { runId: "run", since: 0 },
    source,
    liveInputs: port,
    send: (frame) => reconnect.push(frame),
  });
  await next.start();
  next.stop();
  expect(reconnect).toEqual([]);
  expect(port.inspect(target)).toBe("expired");
});
async function client(url: string, token: string) {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const notifications: DaemonNotification[] = [];
  const responses = new Map<number, (response: { ok: boolean; result?: unknown }) => void>();
  let id = 0;
  const closed = new Promise<number>((resolve) => ws.on("close", resolve));
  ws.on("message", (data) => {
    const message = JSON.parse(
      (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("utf8"),
    ) as {
      kind: string;
      method: string;
      params?: unknown;
      id: number;
      ok: boolean;
      result?: unknown;
    };
    if (message.kind === "response") responses.get(message.id)?.(message);
    else {
      const parsed = parseNotification(message);
      if (parsed) notifications.push(parsed);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  teardown.push(() => {
    ws.terminate();
  });
  const call = (method: string, params: unknown = {}) =>
    new Promise<{ ok: boolean; result?: unknown }>((resolve) => {
      responses.set(++id, resolve);
      ws.send(JSON.stringify({ kind: "request", id, method, params }));
    });
  return { ws, notifications, closed, call };
}
it("pushes execution revocation to an authorized observer while filtering hidden runs and revoked readers", async () => {
  const port = new LiveHumanInput("boot");
  teardown.push(() => port.close());
  const credentials = new CredentialStore();
  const allowed = await credentials.issue({
    principal: "observer",
    permissions: ["runs.read"],
    scope: { workflows: ["visible"], runs: "all" },
  });
  const hidden = await credentials.issue({
    principal: "hidden",
    permissions: ["runs.read"],
    scope: { workflows: ["other"], runs: "all" },
  });
  const denied = await credentials.issue({
    principal: "denied",
    permissions: ["agents.read"],
    scope: { workflows: "*", runs: "all" },
  });
  const revoked = await credentials.issue({ principal: "revoked", preset: "viewer" });
  const initiator = await credentials.issue({ principal: "initiator", preset: "client" });
  const resolver: ResourceResolver = {
    run: async (id) => (id === "run" ? { workflowId: "visible" } : undefined),
    inputRun: async () => "run",
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: (id) => id === "visible",
  };
  const daemon = await startDaemon({
    orcaVersion: "test",
    capabilities: ["runs.subscribe"],
    source,
    liveInputs: port,
    auth: { mode: "token", credentials, ownership: new OwnershipStore(), resolver, revalidateMs: 60_000 },
  });
  teardown.push(() => daemon.close());
  const [observer, other, noRead, revokedReader] = await Promise.all([
    client(daemon.socketUrl!, allowed.token),
    client(daemon.socketUrl!, hidden.token),
    client(daemon.socketUrl!, denied.token),
    client(daemon.socketUrl!, revoked.token),
  ]);
  for (const c of [observer, other, noRead, revokedReader]) expect((await c.call("subscribe")).ok).toBe(true);
  const executions = new LiveExecutionAuthorities((actor) => credentials.current(actor.credentialId!).ok, 60_000);
  teardown.push(() => executions.close());
  executions.bind("run", { principalId: "initiator", credentialId: initiator.credential.id });
  const pending = ask(port, executions.signalFor("run"));
  await credentials.revoke(revoked.credential.id);
  await credentials.revoke(initiator.credential.id);
  executions.revalidate();
  expect(await pending.result).toBeUndefined();
  await vi.waitFor(() => expect(observer.notifications).toHaveLength(1));
  expect(observer.notifications[0]).toMatchObject({ method: "input.invalidated", params: { target } });
  expect(await revokedReader.closed).toBe(4401);
  expect(other.notifications).toEqual([]);
  expect(noRead.notifications).toEqual([]);
  expect(revokedReader.notifications).toEqual([]);
  expect(pending.emitOwned).not.toHaveBeenCalled();
});
