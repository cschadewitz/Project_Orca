/** Authenticated private-daemon RPC client for the closed operator API. */
import { OrcaError } from "@orca/core";
import { ProtocolFault, PROTOCOL_VERSION, OPERATOR_MAX_RESULT_BYTES, ResponseMessageSchema } from "@orca/protocol";
import {
  MCP_OPERATIONS,
  type AuthenticatedOperatorBackend,
  type McpInput,
  type McpOperation,
  type McpOutput,
} from "./contracts.js";

/** No owner-token discovery, redirect following, unauthenticated compatibility or raw RPC escape hatch. */
export class DaemonOperatorBackend implements AuthenticatedOperatorBackend {
  private readonly endpoint: URL;
  constructor(
    private readonly options: {
      endpoint: string;
      credential(): Promise<string>;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    try {
      this.endpoint = new URL(options.endpoint);
    } catch {
      throw new OrcaError("CONFIG_INVALID", "Invalid daemon endpoint");
    }
    const u = this.endpoint;
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !["http:", "https:"].includes(u.protocol) ||
      (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
      throw new OrcaError(
        "CONFIG_INVALID",
        "Daemon URL must use HTTPS or literal loopback HTTP, without credentials, query or fragment",
      );
    if (u.pathname !== "/" && u.pathname !== "/rpc")
      throw new OrcaError("CONFIG_INVALID", "Daemon URL must address /rpc");
    u.pathname = "/rpc";
  }
  async call<K extends McpOperation>(operation: K, input: McpInput<K>): Promise<McpOutput<K>> {
    const spec = MCP_OPERATIONS[operation];
    if (!spec) throw new OrcaError("NOT_SUPPORTED", "Unknown operator operation");
    let credential: string;
    try {
      credential = await this.options.credential();
    } catch {
      throw new ProtocolFault("AUTH_INVALID", "Daemon credential could not be loaded");
    }
    if (!credential || /\s/.test(credential))
      throw new ProtocolFault("AUTH_REQUIRED", "A daemon credential is required");
    const id = crypto.randomUUID();
    const body = JSON.stringify({ kind: "request", id, method: spec.method, params: input });
    if (Buffer.byteLength(body) > 64 * 1024)
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Operator command exceeds 64 KiB");
    // Do not validate resource parameters here: the daemon checks authority first.
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch {
      throw new OrcaError(
        "AGENT_TRANSPORT",
        "Daemon unavailable or response lost; inspect or retry the same admission key",
      );
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new ProtocolFault("AUTH_INVALID", "Daemon credential is invalid or revoked");
    }
    if (response.status === 403) {
      await response.body?.cancel();
      throw new ProtocolFault("AUTH_FORBIDDEN", "Daemon operation is not authorized");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OrcaError("AGENT_TRANSPORT", "Daemon request failed");
    }
    const parsed = ResponseMessageSchema.safeParse(await readJson(response));
    if (!parsed.success || parsed.data.id !== id)
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Invalid daemon response");
    if (!parsed.data.ok) {
      // Preserve stable code without echoing backend diagnostics, payloads, paths or secrets.
      throw new ProtocolFault("PROTOCOL_MESSAGE", "ORCA refused the operation", {
        backendCode: parsed.data.error.code,
      });
    }
    const result = spec.output.safeParse(parsed.data.result);
    if (!result.success) throw new ProtocolFault("PROTOCOL_MESSAGE", "Invalid operator response");
    if ("protocol" in result.data && result.data.protocol.major !== PROTOCOL_VERSION.major)
      throw new ProtocolFault("PROTOCOL_VERSION", "Unsupported daemon protocol major version");
    return result.data as McpOutput<K>;
  }
}
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ProtocolFault("PROTOCOL_MESSAGE", "Empty daemon response");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OPERATOR_MAX_RESULT_BYTES)
        throw new ProtocolFault("PROTOCOL_MESSAGE", "Daemon response exceeds the operator byte limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ProtocolFault("PROTOCOL_MESSAGE", "Invalid or oversized daemon response");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
