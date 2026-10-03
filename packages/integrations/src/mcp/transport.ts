/** Authenticated stdio and Streamable HTTP entry points for the ORCA operator server. */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createOperatorServer } from "./server.js";
import type { AuthenticatedOperatorBackend } from "./contracts.js";
import { DaemonOperatorBackend } from "./backend.js";

/** The caller supplies a credential-bound backend. Stdio itself conveys no authority. */
export function serveOperatorStdio(backend: AuthenticatedOperatorBackend, transport?: StdioServerTransport) {
  return serveStdio(() => createOperatorServer(backend), {
    ...(transport ? { transport } : {}),
    onerror: () => {
      // stdout belongs entirely to MCP; SDK errors can contain caller input.
      process.stderr.write("ORCA MCP transport error\n");
    },
  });
}

/**
 * Reference remote deployment: pass each caller's ORCA bearer credential to the private
 * daemon, which verifies it on every call. No shared privileged credential or OAuth guess.
 * Mount at a TLS listener or approved private bridge; public ingress is not set up here.
 */
export function createOperatorHttpHandler(options: {
  daemonEndpoint: string;
  /** Exact externally visible HTTPS origin. Never trust a forwarded header from a caller. */
  origin: string;
  allowedOrigins?: readonly string[];
  fetch?: typeof fetch;
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.origin !== options.origin)
    throw new Error("MCP origin must be an HTTPS origin");
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== options.origin || url.pathname !== "/mcp" || url.search || url.hash)
      return new Response(null, { status: 403 });
    const browser = request.headers.get("origin");
    if (browser && !options.allowedOrigins?.includes(browser)) return new Response(null, { status: 403 });
    const auth = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "");
    if (!auth) return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    const backend = new DaemonOperatorBackend({
      endpoint: options.daemonEndpoint,
      credential: async () => auth[1]!,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    try {
      await backend.call("discover", {});
    } catch {
      return new Response(null, { status: 401 });
    }
    // Per-request server: no MCP session can retain another request's caller identity.
    const handler = createMcpHandler(() => createOperatorServer(backend), {
      maxRequestBodySize: 64 * 1024,
      responseMode: "json",
      maxSubscriptions: 0,
    });
    try {
      const response = await handler.fetch(request);
      // The lifecycle surface has no streaming tools/subscriptions; consume before closing.
      const body = await response.arrayBuffer();
      return new Response(body.byteLength ? body : null, { status: response.status, headers: response.headers });
    } finally {
      await handler.close();
    }
  };
}
