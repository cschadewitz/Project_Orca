/** Client migration: isolated credentials, bounded reload, and immediate refusal state. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { startDaemon, bootstrapLocalOwner, openAuthDirectory, type DaemonHandle } from "@orca/daemon";
import {
  LocalDaemonToken,
  localDaemonTokenFile,
  assertCredentialDestination,
  authenticationCode,
} from "../src/client/auth.js";
import { DaemonClient, DaemonClientError } from "../src/client/daemon-client.js";
import { DaemonSubscription, type SocketHandlers } from "../src/client/subscription.js";
import { ConnectionMachine } from "../src/main/connection-state.js";

const temporary: string[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-client-auth-"));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  vi.useRealTimers();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const refused = (code: "AUTH_INVALID" | "AUTH_REQUIRED" | "AUTH_FORBIDDEN" = "AUTH_INVALID") =>
  new Response(
    JSON.stringify({ kind: "response", id: 0, ok: false, error: { code, message: "Authentication failed" } }),
    { status: 401 },
  );
const success = () => new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result: "ok" }));

describe("local daemon credentials", () => {
  it("discovers the configuration directory above the chosen workspace", () => {
    const dir = directory();
    writeFileSync(join(dir, "orca.config.yaml"), "version: 1\n");
    mkdirSync(join(dir, "nested"));
    expect(localDaemonTokenFile(join(dir, "nested"))).toBe(join(dir, "auth", "local-client.token"));
  });

  it("does not discover local owner tokens for remote URLs, and explicit env wins", () => {
    const dir = directory();
    mkdirSync(join(dir, "auth"));
    const file = join(dir, "auth", "local-client.token");
    writeFileSync(file, "local-token\n");
    expect(new LocalDaemonToken({ url: "https://orca.example", workspace: dir, env: {} }).read()).toBeUndefined();
    expect(new LocalDaemonToken({ url: "https://orca.example", env: { ORCA_DAEMON_TOKEN_FILE: file } }).read()).toBe(
      "local-token",
    );
    const explicit = new LocalDaemonToken({
      url: "http://127.0.0.1:6722",
      tokenFile: file,
      env: { ORCA_DAEMON_TOKEN: "explicit-token" },
    });
    expect(explicit.read()).toBe("explicit-token");
    expect(explicit.refresh()).toBe(false);
  });

  it("re-reads the token once on AUTH_INVALID and carries it only as a bearer header", async () => {
    const file = join(directory(), "token");
    writeFileSync(file, "first-token");
    const sent: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, options) => {
      sent.push(options!);
      if (sent.length === 1) {
        writeFileSync(file, "next-token");
        return refused();
      }
      return success();
    };
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl, {
      auth: new LocalDaemonToken({ url: "http://127.0.0.1:6722", tokenFile: file, env: {} }),
    });
    expect(await client.call("hello", {}, z.string())).toBe("ok");
    expect(sent.map((request) => new Headers(request.headers).get("authorization"))).toEqual([
      "Bearer first-token",
      "Bearer next-token",
    ]);
    expect(sent.every((request) => request.redirect === "manual")).toBe(true);
    expect(sent[0]!.body).toBe(sent[1]!.body);
  });

  it.each(["AUTH_INVALID", "AUTH_REQUIRED", "AUTH_FORBIDDEN"] as const)("bounds retries for %s", async (code) => {
    const file = join(directory(), "token");
    writeFileSync(file, "refused-token");
    const fetchImpl = vi.fn<typeof fetch>(async () => refused(code));
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl, {
      auth: new LocalDaemonToken({ url: "http://127.0.0.1:6722", tokenFile: file, env: {} }),
    });
    await expect(client.call("hello", {}, z.unknown())).rejects.toMatchObject({ error: { code } });
    expect(fetchImpl).toHaveBeenCalledTimes(code === "AUTH_INVALID" ? 2 : 1);
  });

  it("refuses plaintext remote credentials before fetch and never includes the token in errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new DaemonClient("http://orca.example", fetchImpl, {
      auth: new LocalDaemonToken({ url: "http://orca.example", env: { ORCA_DAEMON_TOKEN: "fixture-secret" } }),
    });
    await expect(client.hello("test")).rejects.toThrow("require HTTPS");
    expect(fetchImpl).not.toHaveBeenCalled();
    const malformed = new LocalDaemonToken({ url: "http://localhost", env: { ORCA_DAEMON_TOKEN: "fixture\nsecret" } });
    await expect(
      new DaemonClient("http://localhost", fetchImpl, { auth: malformed }).hello("test"),
    ).rejects.toMatchObject({ error: { code: "AUTH_INVALID", message: "Daemon authentication failed" } });
  });
});

describe("authentication reconnect", () => {
  it("offers bearer subprotocols, reloads once for 4401 and ignores the old socket", async () => {
    const handlers: SocketHandlers[] = [];
    const protocols: (string[] | undefined)[] = [];
    let token = "old-token";
    const refresh = vi.fn(() => {
      token = "new-token";
      return true;
    });
    const stream = new DaemonSubscription({
      url: "ws://127.0.0.1/socket",
      params: {},
      onNotification: () => {},
      auth: { tokens: { read: () => token, refresh }, verify: async () => {} },
      socket: (_url, events, offered) => {
        handlers.push(events);
        protocols.push(offered);
        return { send: () => {}, close: () => events.onClose() };
      },
    });
    await Promise.resolve();
    expect(protocols[0]).toEqual(["orca.v1", "orca.bearer.old-token"]);
    handlers[0]!.onClose(4401);
    expect(stream.state).toBe("auth-failed");
    await Promise.resolve();
    expect(protocols[1]).toEqual(["orca.v1", "orca.bearer.new-token"]);
    handlers[0]!.onClose();
    handlers[1]!.onClose(4401);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stream.state).toBe("auth-failed");
    expect(handlers).toHaveLength(2);
    stream.close();
  });

  it("does not retry an explicit revoked environment token or hide its HTTP upgrade failure", async () => {
    const socket = vi.fn();
    const verify = vi.fn(async () => {
      throw new DaemonClientError({ code: "AUTH_INVALID", message: "Authentication failed" });
    });
    const stream = new DaemonSubscription({
      url: "ws://127.0.0.1/socket",
      params: {},
      onNotification: () => {},
      socket,
      auth: { tokens: { read: () => "revoked", refresh: () => false }, verify },
    });
    await Promise.resolve();
    expect(stream.state).toBe("auth-failed");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(socket).not.toHaveBeenCalled();
    stream.close();
  });

  it("makes an authentication refusal visible immediately while ordinary blips remain quiet", async () => {
    vi.useFakeTimers();
    const machine = new ConnectionMachine({
      hello: async () => ({ protocol: PROTOCOL_VERSION, orcaVersion: "test", capabilities: [] }),
      onChange: () => {},
    });
    machine.linkChanged("live");
    await Promise.resolve();
    machine.linkChanged("reconnecting");
    expect(machine.current.state).toBe("live");
    machine.authenticationFailed();
    expect(machine.current.state).toBe("disconnected");
    expect(vi.getTimerCount()).toBe(0);
    machine.linkChanged("live");
    expect(machine.current.state).toBe("live");
    machine.close();
  });
});

describe("real token-mode daemon", () => {
  let daemon: DaemonHandle | undefined;
  let stream: DaemonSubscription | undefined;
  afterEach(async () => {
    stream?.close();
    stream = undefined;
    await daemon?.close();
    daemon = undefined;
  });

  it("authenticates HTTP, maintenance and WS, then reconnects after local-owner rotation", async () => {
    const auth = openAuthDirectory(join(directory(), "auth"));
    await bootstrapLocalOwner(auth);
    daemon = await startDaemon({
      orcaVersion: "test",
      capabilities: ["runs.subscribe"],
      source: { subscribe: () => () => {}, eventsRange: async () => [] },
      auth: {
        mode: "token",
        credentials: auth.credentials,
        ownership: auth.ownership,
        revalidateMs: 10,
        resolver: {
          run: async () => undefined,
          inputRun: async () => undefined,
          artifactRun: async () => undefined,
          claimRun: async () => undefined,
          workflowExists: () => false,
        },
      },
    });
    const client = new DaemonClient(daemon.url, fetch, {
      auth: new LocalDaemonToken({ url: daemon.url, tokenFile: auth.tokenFile, env: {} }),
    });
    expect((await client.hello("auth-test")).orcaVersion).toBe("test");
    expect(await client.maintenance({ action: "prepare", token: "fixture-update" })).toEqual({
      ready: true,
      active: [],
    });
    await client.maintenance({ action: "resume", token: "fixture-update" });
    const states: string[] = [];
    stream = client.subscribe({ params: {}, onNotification: () => {}, onState: (state) => states.push(state) });
    await vi.waitFor(() => expect(stream!.state).toBe("live"));
    await bootstrapLocalOwner(auth);
    await vi.waitFor(() => expect(states.filter((state) => state === "live")).toHaveLength(2));
    expect(states).toContain("auth-failed");
    expect((await client.hello("after-rotation")).orcaVersion).toBe("test");
  });
});

/** Proxy refusals must be terminal authentication results even without an ORCA JSON body. */
describe("proxy authentication responses", () => {
  it.each(["Unauthorized", "<html>Sign in</html>"])("refreshes once after a non-JSON 401: %s", async (body) => {
    const file = join(directory(), "token");
    writeFileSync(file, "old-token");
    const sent: (string | null)[] = [];
    const onAuthFailure = vi.fn();
    const fetchImpl: typeof fetch = async (_url, request) => {
      sent.push(new Headers(request?.headers).get("authorization"));
      if (sent.length === 1) {
        writeFileSync(file, "rotated-token");
        return new Response(body, { status: 401 });
      }
      return success();
    };
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl, {
      auth: new LocalDaemonToken({ url: "http://127.0.0.1:6722", tokenFile: file, env: {} }),
      onAuthFailure,
    });
    expect(await client.call("hello", {}, z.string())).toBe("ok");
    expect(sent).toEqual(["Bearer old-token", "Bearer rotated-token"]);
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, body: "Unauthorized", token: "fixture-token", refreshable: true, calls: 2 },
    { status: 401, body: "<html>Sign in</html>", token: "fixture-token", refreshable: false, calls: 1 },
    { status: 401, body: "Unauthorized", token: undefined, refreshable: true, calls: 1 },
    { status: 403, body: "Forbidden", token: "fixture-token", refreshable: true, calls: 1 },
    { status: 302, body: "Sign in", token: "fixture-token", refreshable: true, calls: 1 },
    { status: 307, body: "Sign in", token: "fixture-token", refreshable: false, calls: 1 },
    { status: 403, body: "<html>Access denied</html>", token: "fixture-token", refreshable: false, calls: 1 },
  ])(
    "disconnects immediately and stops verification retries for $status/$refreshable/$token",
    async ({ status, body, token, refreshable, calls }) => {
      vi.useFakeTimers();
      const machine = new ConnectionMachine({
        hello: async () => ({ protocol: PROTOCOL_VERSION, orcaVersion: "test", capabilities: [] }),
        onChange: () => {},
      });
      machine.linkChanged("live");
      await Promise.resolve();
      const onAuthFailure = vi.fn(() => machine.authenticationFailed());
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status }));
      const refresh = vi.fn(() => refreshable);
      const socket = vi.fn();
      const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl, {
        auth: { read: () => token, refresh },
        onAuthFailure,
      });
      const stream = client.subscribe({
        params: {},
        onNotification: () => {},
        socket,
        backoffMs: [1],
        onState: (state, retries) => machine.linkChanged(state, retries),
      });
      try {
        // Flush fetch/body promises without moving through the five-second quiet window.
        await vi.advanceTimersByTimeAsync(0);
        expect(machine.current.state).toBe("disconnected");
        expect(stream.state).toBe("auth-failed");
        // Verification publishes through its epoch-checked subscription state.
        expect(onAuthFailure).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(calls);
        expect(refresh).toHaveBeenCalledTimes(status === 401 && token ? 1 : 0);
        expect(socket).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(fetchImpl).toHaveBeenCalledTimes(calls);
      } finally {
        stream.close();
        machine.close();
      }
    },
  );

  it("never accepts an apparent success envelope carried by a refused HTTP response", async () => {
    const onAuthFailure = vi.fn();
    const client = new DaemonClient(
      "http://127.0.0.1:6722",
      async () => new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result: "ok" }), { status: 403 }),
      { onAuthFailure },
    );
    await expect(client.call("hello", {}, z.string())).rejects.toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
    expect(onAuthFailure).toHaveBeenCalledOnce();
  });

  it("keeps a normal operation-level forbidden response separate from connection authentication", async () => {
    const onAuthFailure = vi.fn();
    const client = new DaemonClient(
      "http://127.0.0.1:6722",
      async () =>
        new Response(
          JSON.stringify({
            kind: "response",
            id: 1,
            ok: false,
            error: { code: "AUTH_FORBIDDEN", message: "Access denied" },
          }),
        ),
      { onAuthFailure },
    );
    await expect(client.call("maintenance", {}, z.unknown())).rejects.toMatchObject({
      error: { code: "AUTH_FORBIDDEN" },
    });
    expect(onAuthFailure).not.toHaveBeenCalled();
  });
});

/** Redirect configuration is a refusal, while an offline daemon remains reconnectable. */
describe("daemon redirects and offline retry", () => {
  it.each([301, 302, 303, 307, 308])(
    "refuses HTTP %s without following the Location or refreshing credentials",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ kind: "response", id: 0, ok: false, error: { code: "AUTH_INVALID", message: "Sign in" } }),
            { status, headers: { location: "https://login.example/" } },
          ),
      );
      const refresh = vi.fn(() => true);
      const onAuthFailure = vi.fn();
      const client = new DaemonClient("https://orca.example", fetchImpl, {
        auth: { read: () => "fixture-token", refresh },
        onAuthFailure,
      });
      await expect(client.hello("redirect-test")).rejects.toMatchObject({
        error: { code: "AUTH_FORBIDDEN", message: "Daemon RPC redirects are refused" },
      });
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        "https://orca.example/rpc",
        expect.objectContaining({ redirect: "manual" }),
      );
      expect(refresh).not.toHaveBeenCalled();
      // A hello caller owns publication after checking its handshake lifetime.
      expect(onAuthFailure).not.toHaveBeenCalled();
    },
  );

  it("never sends a credential to the destination of a real HTTP redirect", async () => {
    let destinationRequests = 0;
    const destination = createServer((_request, response) => {
      destinationRequests += 1;
      response.end("should not be reached");
    });
    const listen = async (server: Server): Promise<string> => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Fixture has no port");
      return `http://127.0.0.1:${address.port}`;
    };
    const destinationUrl = await listen(destination);
    const origin = createServer((_request, response) => {
      response.writeHead(302, { location: `${destinationUrl}/login` });
      response.end("Sign in");
    });
    try {
      const url = await listen(origin);
      const client = new DaemonClient(url, fetch, {
        auth: { read: () => "fixture-token", refresh: () => true },
      });
      await expect(client.hello("redirect-fixture")).rejects.toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
      expect(destinationRequests).toBe(0);
    } finally {
      await Promise.all(
        [origin, destination].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    }
  });

  it("continues ordinary backoff for a truly offline daemon", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const refresh = vi.fn(() => true);
    const onAuthFailure = vi.fn();
    const socket = vi.fn();
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl, {
      auth: { read: () => "fixture-token", refresh },
      onAuthFailure,
    });
    const stream = client.subscribe({ params: {}, onNotification: () => {}, backoffMs: [1], socket });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(stream.state).toBe("reconnecting");
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
      expect(refresh).not.toHaveBeenCalled();
      expect(onAuthFailure).not.toHaveBeenCalled();
      expect(socket).not.toHaveBeenCalled();
    } finally {
      stream.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Failure and teardown paths use only synthetic credentials and controllable transports. */
describe("authentication failure and teardown edges", () => {
  it.each([
    "http://user:fixture-secret@localhost",
    "http://localhost/?token=fixture-secret",
    "http://localhost/#fixture-secret",
  ])("rejects URL-carried credentials before transport: %s", (url) => {
    expect(() => assertCredentialDestination(url, "fixture-token")).toThrow(
      "Daemon URLs must not contain credentials, query parameters or fragments",
    );
  });

  it("reports an unreadable credential file without exposing its contents", () => {
    const auth = new LocalDaemonToken({ url: "http://localhost", tokenFile: directory(), env: {} });
    expect(() => auth.read()).toThrow("Cannot read daemon credential file");
  });

  it.each([
    undefined,
    null,
    "offline",
    {},
    { error: null },
    { error: "no" },
    { error: {} },
    { error: { code: "OFFLINE" } },
  ])("does not mistake an unrelated or malformed error for authentication: %j", (error) => {
    expect(authenticationCode(error)).toBeUndefined();
  });

  it("keeps redirect refusal terminal even if disposing of the proxy body fails", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("fixture disposal failed");
    });
    const body = new ReadableStream({ cancel });
    const client = new DaemonClient("http://127.0.0.1:6722", async () => new Response(body, { status: 302 }));
    await expect(client.hello("redirect-disposal")).rejects.toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps the generic authentication refusal if a local HTTP credential reload fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => refused());
    const onAuthFailure = vi.fn();
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl, {
      auth: {
        read: () => "fixture-token",
        refresh: () => {
          throw new Error("private fixture detail");
        },
      },
      onAuthFailure,
    });
    await expect(client.hello("failed-reload")).rejects.toMatchObject({
      error: { code: "AUTH_INVALID", message: "Authentication failed" },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    // The probe returns the refusal without publishing into the live connection.
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it("refuses a socket whose credential becomes unreadable after HTTP verification", async () => {
    const socket = vi.fn();
    const refresh = vi.fn(() => true);
    const stream = new DaemonSubscription({
      url: "ws://127.0.0.1/socket",
      params: {},
      onNotification: () => {},
      socket,
      auth: {
        verify: async () => {},
        tokens: {
          read: () => {
            throw new Error("private fixture detail");
          },
          refresh,
        },
      },
    });
    await Promise.resolve();
    expect(stream.state).toBe("auth-failed");
    expect(socket).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    stream.close();
  });

  it.each(["AUTH_INVALID", "AUTH_REQUIRED", "AUTH_FORBIDDEN"] as const)(
    "handles an authenticated socket refusing subscribe with %s",
    async (code) => {
      let handlers: SocketHandlers | undefined;
      const close = vi.fn();
      const refresh = vi.fn(() => {
        throw new Error("reload failed");
      });
      const stream = new DaemonSubscription({
        url: "ws://127.0.0.1/socket",
        params: {},
        onNotification: () => {},
        auth: { verify: async () => {}, tokens: { read: () => "fixture-token", refresh } },
        socket: (_url, events) => {
          handlers = events;
          return { close, send: () => {} };
        },
      });
      await Promise.resolve();
      handlers!.onOpen();
      handlers!.onMessage(JSON.stringify({ kind: "response", id: 1, ok: false, error: { code, message: "Refused" } }));
      expect(stream.state).toBe("auth-failed");
      expect(close).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledTimes(code === "AUTH_INVALID" ? 1 : 0);
      stream.close();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores HTTP verification that finishes with %s after close",
    async (outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const verification = new Promise<void>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      });
      const socket = vi.fn();
      const refresh = vi.fn(() => true);
      const stream = new DaemonSubscription({
        url: "ws://127.0.0.1/socket",
        params: {},
        onNotification: () => {},
        socket,
        auth: { verify: () => verification, tokens: { read: () => "fixture-token", refresh } },
      });
      stream.close();
      if (outcome === "resolve") resolve();
      else reject(new DaemonClientError({ code: "AUTH_INVALID", message: "Refused" }));
      await Promise.resolve();
      expect(stream.state).toBe("closed");
      expect(socket).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it("does not reconnect if the caller closes while handling the auth-failed state", async () => {
    const socket = vi.fn();
    const refresh = vi.fn(() => true);
    const verify = vi.fn(async () => {
      throw new DaemonClientError({ code: "AUTH_INVALID", message: "Refused" });
    });
    const stream = new DaemonSubscription({
      url: "ws://127.0.0.1/socket",
      params: {},
      onNotification: () => {},
      socket,
      auth: { verify, tokens: { read: () => "fixture-token", refresh } },
      onState: (state) => {
        if (state === "auth-failed") stream.close();
      },
    });
    await Promise.resolve();
    expect(stream.state).toBe("closed");
    expect(verify).toHaveBeenCalledOnce();
    expect(socket).not.toHaveBeenCalled();
  });
});
