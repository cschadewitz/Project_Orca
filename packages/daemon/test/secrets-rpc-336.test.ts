/**
 * `secrets.list` and `secrets.check` (#336, part B2) through the authenticated transports:
 * a token daemon, HTTP RPC and an open WebSocket. The grant is read again at every call.
 */
import WebSocket from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { secretHostBinding, type AgentHost } from "@orca/agents";
import { HostSpecSchema, type HostSpec, type SecretsConfig } from "@orca/core";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { MAX_REMOTE_CHECKS, ReadModel, startDaemon, type SecretsSource } from "@orca/daemon";
import { CredentialStore, OwnershipStore, UNRESTRICTED, orchestratorResolver } from "../src/auth/index.js";
import { emptyFixture } from "./fixture.js";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const catalog: SecretsConfig = {
  key: { host: "box", provider: "file", path: "/etc/orca/key" },
  other: { host: "box", provider: "env", name: "ORCA_OTHER" },
};

async function setup() {
  const { orchestrator: orc } = emptyFixture();
  let box: HostSpec = HostSpecSchema.parse({ id: "box", type: "ssh", host: "box.example" });
  const probes: string[] = [];
  let hold: Promise<void> | undefined;
  const exec: AgentHost["exec"] = async (command) => {
    probes.push(command);
    await hold;
    return { code: 0, stdout: "", stderr: "" };
  };
  const secretsSource = (): SecretsSource => ({
    secrets: () => catalog,
    hasHost: (id) => id === "box",
    host: () =>
      ({
        id: "box",
        spec: box,
        execStatus: async (command: string, o: { timeoutMs: number }) => (await exec(command, o)).code,
      }) as unknown as AgentHost,
  });
  const credentials = new CredentialStore();
  const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
  const narrow = await credentials.issue({
    principal: "ci-bot",
    permissions: ["secrets.read"],
    scope: UNRESTRICTED,
    secrets: [{ secret: "key", provider: "file", host: "box", binding: secretHostBinding(box) }],
  });
  const daemon = await startDaemon({
    capabilities: ["runs.read", "runs.subscribe"],
    orcaVersion: "test",
    reads: new ReadModel({ orchestrator: orc }),
    source: orc,
    secretsSource,
    auth: { mode: "token", credentials, ownership: new OwnershipStore(), resolver: orchestratorResolver(orc) },
  });
  closers.push(() => daemon.close());
  const call = async (token: string, method: string, params: unknown = {}) => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as { ok: boolean; result?: unknown; error?: { code: string; details?: unknown } };
  };
  const rebind = (host: string) => {
    box = HostSpecSchema.parse({ id: "box", type: "ssh", host });
  };
  const holdProbes = () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    return release;
  };
  return { daemon, credentials, viewer, narrow, call, probes, rebind, holdProbes };
}

async function socket(url: string, token: string) {
  const ws = new WebSocket(url, ["orca.v1"], { headers: { authorization: `Bearer ${token}` } });
  closers.push(() => ws.close());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let id = 0;
  let closed: number | undefined;
  ws.once("close", (code) => (closed = code));
  type Answer = { ok?: boolean; result?: unknown; error?: { code: string; details?: unknown }; closed?: number };
  return (method: string, params: unknown = {}) =>
    new Promise<Answer>((resolve) => {
      const want = ++id;
      const onMessage = (bytes: WebSocket.RawData) => {
        const frame = JSON.parse(Buffer.from(bytes as Buffer).toString("utf8")) as { id?: number };
        if (frame.id !== want) return;
        done(frame as Answer);
      };
      const onClose = (code: number) => done({ closed: code });
      const done = (answer: Answer) => {
        ws.off("message", onMessage);
        ws.off("close", onClose);
        resolve(answer);
      };
      if (closed !== undefined) return done({ closed });
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.send(JSON.stringify({ kind: "request", id: want, method, params }));
    });
}

it("denies a caller without secrets.read on both transports, before any probe", async () => {
  const { daemon, viewer, narrow, call, probes } = await setup();
  const methods = async (token: string) =>
    ((await call(token, "hello", { client: "test", protocol: PROTOCOL_VERSION })) as { result: { methods: string[] } })
      .result.methods;
  expect(await methods(viewer.token)).not.toContain("secrets.list");
  expect(await methods(narrow.token)).toEqual(expect.arrayContaining(["secrets.list", "secrets.check"]));
  expect(await call(viewer.token, "secrets.list")).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
  expect(await call(viewer.token, "secrets.check", { id: "key" })).toMatchObject({
    ok: false,
    error: { code: "AUTH_FORBIDDEN" },
  });
  const ws = await socket(daemon.socketUrl!, viewer.token);
  expect(await ws("secrets.check", { id: "key" })).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
  expect(probes).toEqual([]);
});

it("shows and checks only the exact reference a narrow grant names", async () => {
  const { narrow, call, probes } = await setup();
  expect(await call(narrow.token, "secrets.list")).toEqual({
    kind: "response",
    id: 1,
    ok: true,
    result: { secrets: [{ id: "key", host: "box", provider: "file" }] },
  });
  expect(await call(narrow.token, "secrets.check", { id: "key" })).toMatchObject({
    ok: true,
    result: { id: "key", host: "box", available: true },
  });
  // The other reference on the same host is not named by the grant: not found, never probed.
  expect(await call(narrow.token, "secrets.check", { id: "other" })).toMatchObject({
    ok: false,
    error: { details: { secret: "other", reason: "not-found" } },
  });
  expect(probes).toHaveLength(1);
});

it("stops an open connection once the host is rebound or the credential revoked", async () => {
  const { daemon, credentials, narrow, call, probes, rebind } = await setup();
  const ws = await socket(daemon.socketUrl!, narrow.token);
  expect(await ws("secrets.check", { id: "key" })).toMatchObject({ ok: true, result: { available: true } });
  // The grant was bound to the old endpoint: after a rebind it covers nothing.
  rebind("elsewhere.example");
  expect(await ws("secrets.list")).toMatchObject({ ok: true, result: { secrets: [] } });
  expect(await ws("secrets.check", { id: "key" })).toMatchObject({
    ok: false,
    error: { details: { reason: "not-found" } },
  });
  rebind("box.example");
  expect(await ws("secrets.list")).toMatchObject({ ok: true, result: { secrets: [{ id: "key" }] } });
  // A revoked credential closes the connection before the request is handled (4401), and
  // HTTP refuses it outright.
  await credentials.revoke(narrow.credential.id);
  expect(await ws("secrets.check", { id: "key" })).toEqual({ closed: 4401 });
  expect(await call(narrow.token, "secrets.check", { id: "key" })).toMatchObject({
    ok: false,
    error: { code: "AUTH_INVALID" },
  });
  expect(probes).toHaveLength(1);
});

it("bounds concurrent remote checks across callers; denied and excess requests start no probe", async () => {
  const { viewer, narrow, call, probes, holdProbes } = await setup();
  const release = holdProbes();
  const denied = Array.from({ length: 6 }, () => call(viewer.token, "secrets.check", { id: "key" }));
  const checks = Array.from({ length: MAX_REMOTE_CHECKS + 2 }, () =>
    call(narrow.token, "secrets.check", { id: "key" }),
  );
  await vi.waitFor(() => expect(probes).toHaveLength(MAX_REMOTE_CHECKS));
  for (const answer of await Promise.all(denied))
    expect(answer).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
  release();
  const results = (await Promise.all(checks)).map((a) => (a.result as { available: boolean; reason?: string }).reason);
  expect(results.filter((r) => r === "busy")).toHaveLength(2);
  expect(results.filter((r) => r === undefined)).toHaveLength(MAX_REMOTE_CHECKS);
  expect(probes).toHaveLength(MAX_REMOTE_CHECKS);
});
