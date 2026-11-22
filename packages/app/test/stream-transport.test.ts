/**
 * The daemon transport over handed-out streams (#874): HTTP and the WebSocket travel only on
 * connections from `connect()`, a refusal fails the one request before anything is written,
 * and an abort ends its request. Here a "stream" is a plain socket to a local server; the
 * protocol package's tests give the real ssh-backed one.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CredentialTransportUnavailable } from "../src/client/auth.js";
import { streamTransport } from "../src/client/stream-transport.js";
import { DaemonSubscription } from "../src/client/subscription.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function backend(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, request) => {
    socket.send(`hello ${request.headers["sec-websocket-protocol"] ?? ""}`);
    socket.on("message", (data: Buffer) => socket.send(`echo ${data.toString()}`));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  cleanup.push(async () => {
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const streams: Socket[] = [];
  const connect = vi.fn(() => {
    const stream = netConnect(port, "127.0.0.1");
    streams.push(stream);
    return stream;
  });
  // A URL nothing listens on: if the transport ever dialled it, the request would fail.
  return { connect, streams, url: "http://127.0.0.1:9" };
}

describe("streamTransport.fetch", () => {
  it("sends method, path, headers and body over a connect() stream and returns the response", async () => {
    const seen: { method: string | undefined; url: string | undefined; auth: string | undefined; body: string }[] = [];
    const { connect, url } = await backend((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        seen.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
        response.setHeader("set-cookie", ["a=1", "b=2"]);
        response.writeHead(201, "Made");
        response.end("done");
      });
    });
    const transport = streamTransport(connect);
    cleanup.push(async () => transport.close());
    const res = await transport.fetch(`${url}/rpc?x=1`, {
      method: "POST",
      headers: { authorization: "Bearer t0ken-0123456789abcdef" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Made");
    expect(res.headers.get("set-cookie")).toBe("a=1, b=2");
    expect(await res.text()).toBe("done");
    expect(seen).toEqual([{ method: "POST", url: "/rpc?x=1", auth: "Bearer t0ken-0123456789abcdef", body: "{}" }]);

    // A bodiless status, and a default GET with no options.
    const empty = await transport.fetch(`${url}/empty`);
    expect(empty.status).toBe(201);
    expect(connect).toHaveBeenCalled();
  });

  it("returns no body for 204", async () => {
    const { connect, url } = await backend((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const transport = streamTransport(connect);
    cleanup.push(async () => transport.close());
    const res = await transport.fetch(url);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("fails a request whose stream cannot be had, without writing anything", async () => {
    const transport = streamTransport(() => {
      throw new CredentialTransportUnavailable();
    });
    await expect(transport.fetch("http://127.0.0.1:9/rpc", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      CredentialTransportUnavailable,
    );
    transport.close();
  });

  it("refuses inputs it does not carry, and honours abort before and during a request", async () => {
    const { connect, streams, url } = await backend(() => {
      // Never answers: only an abort ends the request.
    });
    const transport = streamTransport(connect);
    cleanup.push(async () => transport.close());
    await expect(transport.fetch(new Request(url))).rejects.toBeInstanceOf(TypeError);
    await expect(transport.fetch(url, { method: "POST", body: new Uint8Array([1]) })).rejects.toBeInstanceOf(TypeError);

    const before = new AbortController();
    before.abort();
    await expect(transport.fetch(url, { signal: before.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(connect).not.toHaveBeenCalled();

    const during = new AbortController();
    const pending = transport.fetch(url, { signal: during.signal });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    during.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("streamTransport.socket", () => {
  it("opens the WebSocket over a connect() stream, carries messages both ways, and closes", async () => {
    const { connect, url } = await backend(() => {});
    const transport = streamTransport(connect);
    const messages: string[] = [];
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const socket = transport.socket(
      url.replace(/^http/, "ws") + "/socket",
      {
        onOpen,
        onMessage: (text) => messages.push(text),
        onClose,
      },
      ["orca.v1"],
    );
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
    socket.send("ping");
    await vi.waitFor(() => expect(messages).toEqual(["hello orca.v1", "echo ping"]));
    socket.close();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(connect).toHaveBeenCalledTimes(1);
    transport.close();
  });

  it("reports a socket that cannot get a stream as closed, once, and never opened", async () => {
    const transport = streamTransport(() => {
      throw new CredentialTransportUnavailable();
    });
    const onOpen = vi.fn();
    const onClose = vi.fn();
    transport.socket("ws://127.0.0.1:9/socket", { onOpen, onMessage: () => {}, onClose }, ["orca.v1"]);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("a subscription whose transport is down", () => {
  it("waits and reconnects without offering a credential or reporting an auth failure", () => {
    const offered: (string[] | undefined)[] = [];
    const states: string[] = [];
    const stream = new DaemonSubscription({
      url: "ws://127.0.0.1:9/socket",
      params: {},
      onNotification: () => {},
      onState: (state) => states.push(state),
      backoffMs: [60_000],
      auth: {
        tokens: {
          read: () => {
            throw new CredentialTransportUnavailable();
          },
          refresh: () => false,
        },
      },
      socket: (_url, _handlers, protocols) => {
        offered.push(protocols);
        return { send: () => {}, close: () => {} };
      },
    });
    expect(offered).toEqual([]);
    expect(states).toContain("reconnecting");
    expect(states).not.toContain("auth-failed");
    stream.close();
  });
});
