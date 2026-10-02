/** Explicit authenticated revision commands. No local authority, implicit targets, or automatic retry. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { OrcaError } from "@orca/core";
import {
  HelloResultSchema,
  InputsListResultSchema,
  InputsReplaceRevisionParamsSchema,
  InputsReviseParamsSchema,
  OPERATOR_MAX_RESULT_BYTES,
  PendingRevisionTargetSchema,
  PendingRevisionViewSchema,
  PROTOCOL_VERSION,
  ProtocolFault,
  ReplacePendingRevisionCommandSchema,
  ResponseMessageSchema,
  RevisionCommandSchema,
  RevisionResultSchema,
  isCompatible,
  type ProtocolError,
} from "@orca/protocol";
import type { CommandContext } from "./index.js";
import { RevisionInputClient } from "./revision-input.js";

const MAX_BYTES = 256 * 1024;
// The strict params may use the full 256 KiB; leave room for the fixed RPC envelope.
const MAX_REQUEST_BYTES = MAX_BYTES + 1024;
const TIMEOUT_MS = 15_000;
const METHODS = ["hello", "inputs.list", "inputs.revise", "inputs.revisionPending", "inputs.replaceRevision"] as const;
type RevisionMethod = (typeof METHODS)[number];
const USAGE =
  "revisions expects discover <runId>, inspect --body-file <target.json>, or submit/replace --body-file <command.json> --idempotency-key <retained-key>";

function invalid(message = USAGE): never {
  throw new OrcaError("CONFIG_INVALID", message);
}
function flag(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) invalid("Invalid revision command option");
  return value;
}
function endpointUrl(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return invalid("Invalid daemon endpoint");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    invalid("Daemon URL must use HTTPS or literal loopback HTTP, without credentials, query or fragment");
  if (url.pathname !== "/" && url.pathname !== "/rpc") invalid("Daemon URL must address /rpc");
  url.pathname = "/rpc";
  return url;
}

/** Diagnostics are untrusted. Preserve only known refusal codes and durable recovery correlation. */
function refusal(error: ProtocolError, secrets: readonly string[]): never {
  const details: Record<string, unknown> = {};
  const original = error.details;
  if (
    typeof original?.operationId === "string" &&
    /^retry_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(original.operationId) &&
    !secrets.some((secret) => original.operationId === secret)
  )
    details.operationId = original.operationId;
  if (original?.recovery === "inspect-or-retry") details.recovery = "inspect-or-retry";
  if (original?.reason === "revision-publication-uncertain") details.reason = "revision-publication-uncertain";
  if (typeof original?.uncertain === "boolean") details.uncertain = original.uncertain;
  const safeDetails = Object.keys(details).length ? details : undefined;
  switch (error.code) {
    case "AUTH_REQUIRED":
    case "AUTH_INVALID":
    case "AUTH_FORBIDDEN":
    case "PROTOCOL_VERSION":
    case "PROTOCOL_METHOD":
    case "PROTOCOL_MESSAGE":
      throw new ProtocolFault(error.code, "Daemon refused the revision operation", safeDetails);
    case "RETRY_CONFLICT":
    case "RETRY_LIMIT":
    case "REVISION_STALE":
    case "RUN_STATE":
    case "RUN_NOT_FOUND":
    case "RUN_LEASED":
    case "NOT_SUPPORTED":
    case "STORE_WRITE":
    case "STORE_LOCK_TIMEOUT":
      throw new OrcaError(error.code, "Daemon refused the revision operation", safeDetails);
    default:
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Daemon refused the revision operation", safeDetails);
  }
}
function responseLost(mutation: boolean): OrcaError {
  return new OrcaError(
    "AGENT_TRANSPORT",
    mutation
      ? "Daemon response unavailable; the mutation may have committed. Inspect or explicitly retry the unchanged command with the same retained key"
      : "Daemon response unavailable; no mutation was sent",
    mutation ? { uncertain: true, recovery: "inspect-or-retry" } : undefined,
  );
}

/** Private, closed method set. This client is never an operator-backend raw RPC escape. */
class RevisionDaemonClient {
  capabilities: readonly string[] = [];
  constructor(
    private readonly endpoint: URL,
    private readonly credential: string,
    private readonly retainedKey?: string,
  ) {}
  async connect(): Promise<void> {
    const hello = HelloResultSchema.safeParse(
      await this.call("hello", { client: "orca-cli/revisions", protocol: PROTOCOL_VERSION }),
    );
    if (!hello.success) throw new ProtocolFault("PROTOCOL_MESSAGE", "Invalid daemon handshake");
    if (!isCompatible(PROTOCOL_VERSION, hello.data.protocol))
      throw new ProtocolFault("PROTOCOL_VERSION", "Unsupported daemon protocol version");
    if (!hello.data.identity || !hello.data.methods)
      throw new OrcaError("NOT_SUPPORTED", "Revision commands require an identified authenticated daemon");
    this.capabilities = hello.data.methods;
  }
  async call(method: string, params: unknown): Promise<unknown> {
    if (!METHODS.includes(method as RevisionMethod))
      throw new OrcaError("NOT_SUPPORTED", "Unsupported revision operation");
    if (method !== "hello" && !this.capabilities.includes(method))
      throw new OrcaError(
        "NOT_SUPPORTED",
        "The daemon does not offer this revision operation to the current credential",
      );
    const mutation = method === "inputs.revise" || method === "inputs.replaceRevision";
    const id = randomUUID();
    const body = JSON.stringify({ kind: "request", id, method, params });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Revision request exceeds the byte limit");
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.credential}` },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw responseLost(mutation);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) throw new ProtocolFault("AUTH_INVALID", "Daemon credential is invalid or revoked");
      if (response.status === 403) throw new ProtocolFault("AUTH_FORBIDDEN", "Daemon operation is not authorized");
      throw responseLost(mutation);
    }
    const parsed = ResponseMessageSchema.safeParse(await readResponse(response, mutation));
    if (!parsed.success || parsed.data.id !== id)
      throw new ProtocolFault(
        "PROTOCOL_MESSAGE",
        "Invalid daemon response",
        mutation ? { uncertain: true, recovery: "inspect-or-retry" } : undefined,
      );
    if (!parsed.data.ok) refusal(parsed.data.error, [this.credential, ...(this.retainedKey ? [this.retainedKey] : [])]);
    const result = parsed.data.result;
    const validated =
      method === "hello"
        ? HelloResultSchema.safeParse(result)
        : method === "inputs.list"
          ? InputsListResultSchema.safeParse(result)
          : method === "inputs.revisionPending"
            ? PendingRevisionViewSchema.safeParse(result)
            : RevisionResultSchema.safeParse(result);
    if (!validated.success)
      throw new ProtocolFault(
        "PROTOCOL_MESSAGE",
        "Invalid revision response",
        mutation ? { uncertain: true, recovery: "inspect-or-retry" } : undefined,
      );
    return validated.data;
  }
}

async function readResponse(response: Response, mutation: boolean): Promise<unknown> {
  if (!response.body) throw responseLost(mutation);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OPERATOR_MAX_RESULT_BYTES) throw new Error("bounded response");
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new ProtocolFault(
      "PROTOCOL_MESSAGE",
      "Invalid, interrupted, or oversized daemon response",
      mutation ? { uncertain: true, recovery: "inspect-or-retry" } : undefined,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readCommand(cwd: string, file: string): Promise<unknown> {
  try {
    const handle = await open(resolve(cwd, file), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("bounded regular file required");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size <= MAX_BYTES) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw new Error("bounded command required");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))) as unknown;
    } finally {
      await handle.close();
    }
  } catch {
    return invalid("Revision body must be a readable JSON file no larger than 256 KiB");
  }
}

export async function revisionsCommand(ctx: CommandContext): Promise<number> {
  const [action, runId, ...extra] = ctx.positionals;
  if (!action || !["discover", "inspect", "submit", "replace"].includes(action) || extra.length) invalid();
  if (action === "discover" ? !runId?.trim() || runId.length > 1024 : runId !== undefined) invalid();
  const file = flag(ctx, "body-file");
  const key = flag(ctx, "idempotency-key");
  const mutation = action === "submit" || action === "replace";
  if (action === "discover" ? file !== undefined || key !== undefined : !file) invalid();
  if (mutation ? !key || Buffer.byteLength(key) > 128 : key !== undefined) invalid();
  // Other command flags must never imply an alternate authority, payload, target, or resume.
  const allowed = new Set(["endpoint", "token-env", "body-file", "idempotency-key", "cwd", "json"]);
  if (ctx.configPath || Object.entries(ctx.flags).some(([name, value]) => value !== undefined && !allowed.has(name)))
    invalid("Unsupported revision command option");
  const endpoint = flag(ctx, "endpoint") ?? process.env.ORCA_DAEMON_URL;
  const tokenEnv = flag(ctx, "token-env") ?? "ORCA_DAEMON_TOKEN";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) invalid("Invalid credential environment variable name");
  // Capture once; environment changes between hello and the mutation cannot change identity.
  const credential = process.env[tokenEnv];
  if (!endpoint || !credential)
    invalid(
      "revisions requires --endpoint (or ORCA_DAEMON_URL) and a credential in ORCA_DAEMON_TOKEN (or --token-env)",
    );
  if (/\s/.test(credential)) throw new ProtocolFault("AUTH_INVALID", "Invalid daemon credential");
  const client = new RevisionDaemonClient(endpointUrl(endpoint), credential, key);
  const input = file ? await readCommand(ctx.cwd, file) : undefined;
  const command = action === "submit" ? RevisionCommandSchema.safeParse(input) : undefined;
  const replacement = action === "replace" ? ReplacePendingRevisionCommandSchema.safeParse(input) : undefined;
  const target = action === "inspect" ? PendingRevisionTargetSchema.safeParse(input) : undefined;
  if ((command && !command.success) || (replacement && !replacement.success) || (target && !target.success))
    invalid("Revision JSON does not match the strict command schema");
  // Validate shared envelope limits, including the retained key, before even sending hello.
  if (
    command?.success &&
    !InputsReviseParamsSchema.safeParse({ command: command.data, retry: { idempotencyKey: key } }).success
  )
    invalid("Invalid or oversized revision command");
  if (
    replacement?.success &&
    !InputsReplaceRevisionParamsSchema.safeParse({ command: replacement.data, retry: { idempotencyKey: key } }).success
  )
    invalid("Invalid or oversized replacement command");
  await client.connect();
  const revisions = new RevisionInputClient(client);
  if (action === "discover") {
    const page = InputsListResultSchema.parse(await client.call("inputs.list", { runId, revisionRunIds: [runId] }));
    if (!page.pendingRevisions)
      throw new OrcaError("NOT_SUPPORTED", "The daemon does not offer revision discovery to the current credential");
    ctx.out(
      JSON.stringify(
        {
          runId,
          boundaries: page.inputs.flatMap((input) => (input.runId === runId && input.revision ? [input.revision] : [])),
          pendingRevisions: page.pendingRevisions,
          asOf: page.asOf,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const result = command?.success
    ? await revisions.submit(command.data, key!)
    : replacement?.success
      ? await revisions.replacePending(replacement.data, key!)
      : await revisions.readPending(target!.data);
  ctx.out(JSON.stringify(result, null, 2));
  return result.state === "in-progress" ? 1 : 0;
}
