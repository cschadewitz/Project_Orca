/** Real authenticated HTTP/WS/MCP composition, with only injected #495 observations. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { hostResourceFixture, workstreamSummaryFixture, PROTOCOL_VERSION, ResponseMessageSchema } from "@orca/protocol";
import {
  CredentialStore,
  OwnershipStore,
  startDaemon,
  type HostResourceReadSource,
  type ResourceResolver,
  type Permission,
} from "@orca/daemon";
import { DaemonOperatorBackend } from "../src/mcp/backend.js";
import { createOperatorServer } from "../src/mcp/server.js";

const target = {
  workspaceId: "20000000-0000-4000-8000-000000000001",
  instanceId: hostResourceFixture().daemonInstanceId,
};
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function socketCall(url: string, token: string) {
  const ws = new WebSocket(url, ["orca.v1", `orca.bearer.${token}`]);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("fixture socket failed"));
  });
  const response = new Promise<unknown>((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as unknown);
  });
  ws.send(
    JSON.stringify({ kind: "request", id: "resource-test", method: "operator.hostResources", params: { target } }),
  );
  const body = await response;
  ws.close();
  await new Promise<void>((resolve) => {
    ws.onclose = () => resolve();
  });
  return body;
}
async function fixture(mount = true, mode: "token" | "loopback-unauthenticated" = "token") {
  const credentials = new CredentialStore();
  const issue = (permissions: Permission[]) =>
    credentials.issue({ principal: "test-caller", permissions, scope: { runs: "owned", workflows: ["allowed"] } });
  const host = await issue(["host.telemetry.read"]);
  const scoped = await issue(["host.telemetry.read", "runs.read"]);
  const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
  const owner = await credentials.issue({ principal: "owner", preset: "owner" });
  const ownership = new OwnershipStore();
  const resolver = {
    run: vi.fn(async (id) =>
      id === "missing" ? undefined : { workflowId: id === "hidden" ? "private-workflow" : "allowed" },
    ),
    inputRun: async () => undefined,
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: () => true,
  } satisfies ResourceResolver;
  const snapshot = vi.fn(async () => JSON.stringify(hostResourceFixture()));
  const source: HostResourceReadSource = { snapshot };
  const daemon = await startDaemon({
    identity: target,
    orcaVersion: "fixture",
    capabilities: ["operator.hostResources"],
    ...(mount ? { hostResourceSource: source } : {}),
    source: { subscribe: () => () => {}, eventsRange: async () => [] },
    auth: mode === "token" ? { mode, credentials, ownership, resolver } : { mode },
  });
  closers.push(daemon.close);
  const rpc = async (token: string | undefined, method: string, params: unknown) => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const connect = async (token: string) => {
    const backend = new DaemonOperatorBackend({ endpoint: daemon.url, credential: async () => token });
    const server = createOperatorServer(backend);
    const client = new Client({ name: "host-resource-reference", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return { backend, client };
  };
  return { credentials, host, scoped, viewer, owner, ownership, rpc, connect, source, snapshot, resolver, daemon };
}

describe("injected daemon resource transport boundary", () => {
  it("discovers a read-only mount only with its explicit grant, including through hello", async () => {
    const f = await fixture();
    for (const credential of [f.viewer, f.owner, f.host]) {
      const allowed = credential === f.host;
      const hello = ResponseMessageSchema.parse(
        (await f.rpc(credential.token, "hello", { client: "test", protocol: PROTOCOL_VERSION })).body,
      );
      expect(JSON.stringify(hello)).toContain('"ok":true');
      if (hello.ok) {
        const info = hello.result as { methods: string[]; capabilities: string[] };
        expect(info.methods.includes("operator.hostResources")).toBe(allowed);
        expect(info.capabilities.includes("operator.hostResources")).toBe(allowed);
        expect(info.capabilities).not.toContain("runs.control");
      }
      const { backend, client } = await f.connect(credential.token);
      expect((await backend.call("discover", {})).operations.includes("operator.hostResources")).toBe(allowed);
      const tool = (await client.listTools()).tools.find((t) => t.name === "get_daemon_resources");
      expect(Boolean(tool)).toBe(allowed);
      if (tool)
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      else {
        const result = await client.callTool({ name: "get_daemon_resources", arguments: { secret: "/private/path" } });
        expect(JSON.stringify(result)).toContain("NOT_SUPPORTED");
        expect(JSON.stringify(result)).not.toContain("private/path");
      }
    }
    expect(f.snapshot).not.toHaveBeenCalled();
  });

  it("does not mount from a capability declaration alone or in local compatibility", async () => {
    for (const [mounted, mode] of [
      [false, "token"],
      [true, "loopback-unauthenticated"],
    ] as const) {
      const f = await fixture(mounted, mode);
      const response = await f.rpc(mode === "token" ? f.host.token : undefined, "hello", {
        client: "test",
        protocol: PROTOCOL_VERSION,
      });
      expect(JSON.stringify(response.body)).not.toContain("operator.hostResources");
      expect(f.snapshot).not.toHaveBeenCalled();
    }
  });

  it.each([
    "healthy",
    "pressure",
    "partial",
    "stale",
    "tmpfs",
    "cgroup-cpu-unsupported",
    "cgroup-cpu-denied",
    "cgroup-memory-unsupported",
    "cgroup-memory-denied",
  ] as const)("returns the exact shared %s fixture through the real daemon and MCP client", async (kind) => {
    const f = await fixture();
    f.snapshot.mockResolvedValue(JSON.stringify(hostResourceFixture(kind)));
    const { client } = await f.connect(f.host.token);
    const result = await client.callTool({ name: "get_daemon_resources", arguments: { target } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(hostResourceFixture(kind));
    expect(f.snapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects absent, invalid, revoked and insufficient credentials before source work or diagnostics", async () => {
    const f = await fixture();
    await f.credentials.revoke(f.host.credential.id);
    for (const token of [undefined, "bad-token", f.host.token]) {
      expect((await f.rpc(token, "operator.hostResources", { invalid: "SECRET" })).status).toBe(401);
    }
    for (const token of [f.viewer.token, f.owner.token]) {
      const response = await f.rpc(token, "operator.hostResources", { invalid: "SECRET" });
      expect(response.body).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
      expect(JSON.stringify(response)).not.toContain("SECRET");
    }
    expect(f.snapshot).not.toHaveBeenCalled();
  });

  it("discards a fixture if its actual credential is revoked during collection", async () => {
    const f = await fixture();
    const hold = deferred<string>();
    const entered = deferred<void>();
    f.snapshot.mockImplementation(() => {
      entered.resolve();
      return hold.promise;
    });
    const pending = f.rpc(f.host.token, "operator.hostResources", { target });
    await entered.promise;
    await f.credentials.revoke(f.host.credential.id);
    hold.resolve(JSON.stringify(hostResourceFixture("pressure")));
    const response = await pending;
    expect(response.body).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect(JSON.stringify(response)).not.toContain("cpu-pressure");
  });

  it.each(["hidden", "missing"])("does not read a summary for %s work or leak its ID in errors", async (runId) => {
    const f = await fixture();
    const read = vi.fn(async () => JSON.stringify(workstreamSummaryFixture()));
    f.source.workstreams = async () => ({ runIds: [runId], read, current: async () => true, publishable: () => true });
    const response = await f.rpc(f.scoped.token, "operator.hostResources", { target });
    expect(response.body).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "not permitted" } });
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(runId);
  });

  it("rejects stale targets and selectors through authenticated HTTP and MCP before sampling", async () => {
    const f = await fixture();
    const { client } = await f.connect(f.host.token);
    for (const arguments_ of [{ target, host: "SECRET" }, { target: { ...target, instanceId: crypto.randomUUID() } }]) {
      const result = await client.callTool({ name: "get_daemon_resources", arguments: arguments_ });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
    expect((await f.rpc(f.host.token, "operator.hostResources", { target, path: "/SECRET" })).body).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MESSAGE" },
    });
    expect(f.snapshot).not.toHaveBeenCalled();
  });

  it("applies the same registered operation and authorization over WebSocket", async () => {
    const f = await fixture();
    expect(await socketCall(f.daemon.socketUrl!, f.viewer.token)).toMatchObject({
      ok: false,
      error: { code: "AUTH_FORBIDDEN" },
    });
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(await socketCall(f.daemon.socketUrl!, f.host.token)).toMatchObject({
      ok: true,
      result: hostResourceFixture(),
    });
  });

  it.each(
    (["http", "ws", "mcp"] as const).flatMap((transport) =>
      [false, true].flatMap((serialization) =>
        ["async-throw", "rejected", "eventual-true"].map((kind) => [transport, serialization, kind] as const),
      ),
    ),
  )(
    "refuses %s invalid fence (serialization=%s, %s) without provider diagnostics",
    async (transport, serialization, kind) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(hostResourceFixture().collectedAt));
      const f = await fixture();
      const ids = ["root", "child", "parked", "uncertain"];
      for (const id of ids) f.ownership.record(id, "test-caller");
      const marker = "SYNTHETIC_FENCE_PROVIDER_FAILURE";
      const eventual = deferred<boolean>();
      const publishable = vi.fn(() => {
        if (serialization && publishable.mock.calls.length === 1) return true;
        if (kind === "async-throw")
          return (async () => {
            throw new Error(marker);
          })();
        if (kind === "rejected") return Promise.reject(new Error(marker));
        return eventual.promise;
      });
      f.source.workstreams = async () => {
        const projection = {
          runIds: ids,
          read: async () => JSON.stringify(workstreamSummaryFixture()),
          current: async () => true,
          publishable: () => true,
        };
        Object.assign(projection, { publishable });
        return projection;
      };
      let body: unknown;
      try {
        if (transport === "mcp") {
          const { client } = await f.connect(f.scoped.token);
          body = await client.callTool({ name: "get_daemon_resources", arguments: { target } });
          expect(body).toMatchObject({ isError: true });
          expect(JSON.stringify(body)).toContain("RUN_STATE");
        } else {
          body =
            transport === "http"
              ? (await f.rpc(f.scoped.token, "operator.hostResources", { target })).body
              : await socketCall(f.daemon.socketUrl!, f.scoped.token);
          expect(body).toMatchObject({ ok: false, error: { code: "RUN_STATE" } });
        }
        expect(publishable).toHaveBeenCalledTimes(serialization ? 2 : 1);
        expect(JSON.stringify(body)).not.toContain(marker);
        expect(JSON.stringify(body)).not.toContain("activeRoots");
      } finally {
        eventual.resolve(true);
        // Give rejection delivery a turn; Vitest also fails on any unhandled rejection.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
  );

  it.each([
    ["http", "ownership"],
    ["ws", "ownership"],
    ["http", "credential"],
    ["ws", "credential"],
  ])("fences %s serialization when %s changes after the model returns", async (transport, kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(hostResourceFixture().collectedAt));
    const f = await fixture();
    const ids = ["root", "child", "parked", "uncertain"];
    for (const id of ids) f.ownership.record(id, "test-caller");
    const publishable = vi.fn(() => {
      if (publishable.mock.calls.length === 1)
        queueMicrotask(() => {
          if (kind === "ownership") f.ownership.forget("root", "test-caller");
          else void f.credentials.revoke(f.scoped.credential.id);
        });
      return ids.every((id) => f.ownership.owner(id) === "test-caller");
    });
    f.source.workstreams = async () => ({
      runIds: ids,
      read: async () => JSON.stringify(workstreamSummaryFixture()),
      current: async () => true,
      publishable,
    });
    const body =
      transport === "http"
        ? (await f.rpc(f.scoped.token, "operator.hostResources", { target })).body
        : await socketCall(f.daemon.socketUrl!, f.scoped.token);
    expect(body).toMatchObject({ ok: false, error: { code: kind === "ownership" ? "RUN_STATE" : "AUTH_INVALID" } });
    expect(JSON.stringify(body)).not.toContain("activeRoots");
    expect(publishable).toHaveBeenCalledTimes(kind === "ownership" ? 2 : 1);
  });
});

it("publishes a caller summary using real ownership/workflow checks without touching hidden work", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(hostResourceFixture().collectedAt));
  const f = await fixture();
  for (const id of ["root", "child", "parked", "uncertain"]) f.ownership.record(id, "test-caller");
  const read = vi.fn(async () => JSON.stringify(workstreamSummaryFixture("partial")));
  f.source.workstreams = async () => ({
    runIds: ["root", "child", "parked", "uncertain"],
    read,
    current: async () => true,
    publishable: () => true,
  });
  const { client } = await f.connect(f.scoped.token);
  const result = await client.callTool({ name: "get_daemon_resources", arguments: { target } });
  expect(result.isError).not.toBe(true);
  const summary = workstreamSummaryFixture("partial");
  expect(result.structuredContent).toMatchObject({ workstreams: { ...summary, ageMs: expect.any(Number) } });
  expect(f.resolver.run).not.toHaveBeenCalledWith("hidden");
  expect(read).toHaveBeenCalledTimes(1);
});
