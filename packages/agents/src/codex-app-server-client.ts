/**
 * ORCA's client for `codex app-server` (#1156): JSON-RPC 2.0 over stdio, one JSON message per
 * line, without the `jsonrpc` field (Codex omits it), pinned to the Codex versions whose
 * generated protocol is checked in under `codex-protocol/<version>/`.
 *
 * - **Messages** are told apart by the keys they carry: `method` and `id` is a request from
 *   Codex (an ask), `method` alone a notification, `id` with `result` or `error` the answer to
 *   one of ORCA's requests. Anything else, a line that is not JSON, an answer to no pending
 *   request, or a line longer than the limit, is a protocol error: the client closes and every
 *   pending request fails. It never guesses.
 * - **Requests** time out (the outcome is then unknown and the request is not sent again).
 *   Codex's overload error (`-32001`) means the request was not taken, so it is retried a
 *   bounded number of times with exponential backoff and jitter.
 * - **Asks** from Codex go to the handler the caller gives; a method the pinned protocol does
 *   not list, or one with no handler, is answered with an error, never left unanswered.
 * - **The handshake** (`initializeCodexAppServer`): `initialize` with ORCA's `clientInfo`,
 *   `experimentalApi` only when the caller asks for it, and the notifications ORCA opts out
 *   of; then the Codex version from the answer's `userAgent` must be a pinned one and every
 *   method the caller needs must be in that version's protocol, or the session is refused
 *   before `initialized` is sent.
 *
 * Mapping onto ORCA sessions is the session driver's (#1157).
 */
import type { Readable, Writable } from "node:stream";
import { OrcaError } from "@orca/core";
import type { InitializeParams } from "./codex-protocol/0.171.0/InitializeParams.js";
import type { InitializeResponse } from "./codex-protocol/0.171.0/InitializeResponse.js";
import * as v0_171_0 from "./codex-protocol/0.171.0/manifest.js";

/** The protocol of each Codex version ORCA is pinned to, by version. */
export const CODEX_APP_SERVER_PINNED: Readonly<
  Record<
    string,
    {
      clientRequests: readonly string[];
      clientNotifications: readonly string[];
      serverRequests: readonly string[];
      serverNotifications: readonly string[];
    }
  >
> = Object.freeze({
  [v0_171_0.CODEX_PROTOCOL_VERSION]: {
    clientRequests: v0_171_0.CLIENT_REQUEST_METHODS,
    clientNotifications: v0_171_0.CLIENT_NOTIFICATION_METHODS,
    serverRequests: v0_171_0.SERVER_REQUEST_METHODS,
    serverNotifications: v0_171_0.SERVER_NOTIFICATION_METHODS,
  },
});

/** Codex's "server overloaded" error: the request was not taken and may be sent again. */
export const CODEX_OVERLOADED = -32001;
/** JSON-RPC "method not found", ORCA's answer to an ask it does not handle. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;

/** An error answer from the other side, or one ORCA gives to an ask. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

/** One line in, one line out. */
export interface CodexLineTransport {
  /** Send one message; the transport adds the newline. */
  send(line: string): void;
  /** Called with each complete line received, without its newline. */
  onLine(listener: (line: string) => void): void;
  /** Called once when the other side is gone, with the reason when there is one. */
  onClose(listener: (error?: Error) => void): void;
  close(): void;
}

/** The longest line accepted by default: well above any file Codex sends, and bounded. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * A line transport over a child's stdio. A line longer than `maxLineBytes` closes it with an
 * error rather than grow without bound.
 */
export function stdioLineTransport(
  io: { stdin: Writable; stdout: Readable },
  options: { maxLineBytes?: number } = {},
): CodexLineTransport {
  const max = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const lineListeners: ((line: string) => void)[] = [];
  const closeListeners: ((error?: Error) => void)[] = [];
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let closed = false;
  const finish = (error?: Error) => {
    if (closed) return;
    closed = true;
    io.stdout.off("data", onData);
    for (const l of closeListeners) l(error);
  };
  const tooLong = () => finish(new Error(`codex app-server sent a line longer than ${max} bytes`));
  // A line's length is every byte before its newline (a CR included), counted across chunks
  // and checked before anything is joined, decoded or delivered: the same bytes are accepted
  // or refused however stdout happens to split them.
  const onData = (chunk: Buffer | string) => {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let nl = data.indexOf(10); nl !== -1 && !closed; nl = data.indexOf(10)) {
      if (pendingBytes + nl > max) return tooLong();
      pending.push(data.subarray(0, nl));
      const line = Buffer.concat(pending).toString("utf8");
      pending = [];
      pendingBytes = 0;
      data = data.subarray(nl + 1);
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length > 0) for (const l of lineListeners) l(trimmed);
    }
    if (closed || data.length === 0) return;
    if (pendingBytes + data.length > max) return tooLong();
    pendingBytes += data.length;
    pending.push(data);
  };
  io.stdout.on("data", onData);
  io.stdout.once("end", () => finish());
  io.stdout.once("error", (e: Error) => finish(e));
  io.stdin.once("error", (e: Error) => finish(e));
  return {
    send(line) {
      if (closed) throw new Error("codex app-server connection is closed");
      io.stdin.write(line + "\n");
    },
    onLine: (l) => void lineListeners.push(l),
    onClose: (l) => void closeListeners.push(l),
    close() {
      io.stdin.end();
      finish();
    },
  };
}

export interface CodexAppServerClientOptions {
  /** Per-request limit, unless the call gives its own. Default 30 s. */
  requestTimeoutMs?: number;
  /** How many times an overloaded request is sent again. Default 3. */
  overloadRetries?: number;
  /** First backoff; it doubles each retry, up to `maxBackoffMs`, scaled by jitter. Default 250 ms. */
  baseBackoffMs?: number;
  /** Default 4 s. */
  maxBackoffMs?: number;
  /** For tests: a number in [0, 1). */
  random?: () => number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Asks from Codex. Return the result, or throw `CodexRpcError` for an error answer (any other
   * throw is answered as an internal error). Absent: every ask is answered "not handled".
   */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Notifications from Codex. */
  onNotification?: (method: string, params: unknown) => void;
  /** Called once when the connection ends, with the reason. */
  onClose?: (error: OrcaError) => void;
  /**
   * The asks the protocol in use lists. Before the handshake there is no version yet, so it is
   * set by `initializeCodexAppServer`; until then every ask is answered "not handled".
   */
  serverRequests?: readonly string[];
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string | number =>
  typeof v === "string" || (typeof v === "number" && Number.isInteger(v));

/** The JSON-RPC connection to one `codex app-server`. */
export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedWith: OrcaError | undefined;
  private serverRequests: readonly string[];
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly transport: CodexLineTransport,
    private readonly options: CodexAppServerClientOptions = {},
  ) {
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.retries = options.overloadRetries ?? 3;
    this.baseMs = options.baseBackoffMs ?? 250;
    this.maxMs = options.maxBackoffMs ?? 4_000;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.serverRequests = options.serverRequests ?? [];
    transport.onLine((line) => this.receive(line));
    transport.onClose((error) =>
      this.shutdown(
        new OrcaError(
          "AGENT_TRANSPORT",
          `codex app-server connection closed${error ? `: ${error.message}` : ""}`,
          error ? { cause: error.message } : undefined,
        ),
      ),
    );
  }

  /** Whether the connection has ended, and why. */
  get closed(): OrcaError | undefined {
    return this.closedWith;
  }

  /** Use the asks a pinned protocol lists (`initializeCodexAppServer` does). */
  useServerRequests(methods: readonly string[]): void {
    this.serverRequests = methods;
  }

  /**
   * Send a request and wait for its answer: the result, `CodexRpcError` for an error answer,
   * `AGENT_TRANSPORT` when the connection ends or the time runs out (the outcome then unknown).
   * Overloaded requests are sent again, `overloadRetries` times at most.
   */
  async request(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, params, options.timeoutMs ?? this.timeoutMs);
      } catch (error) {
        if (!(error instanceof CodexRpcError) || error.code !== CODEX_OVERLOADED || attempt >= this.retries)
          throw error;
        const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** attempt);
        await this.sleep(Math.round(ceiling * (0.5 + this.random() / 2)));
        if (this.closedWith) throw this.closedWith;
      }
    }
  }

  /** Send a notification. */
  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** End the connection; pending requests fail. */
  close(reason = "closed by ORCA"): void {
    this.shutdown(new OrcaError("AGENT_TRANSPORT", `codex app-server connection ${reason}`));
    this.transport.close();
  }

  private once(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new OrcaError(
            "AGENT_TRANSPORT",
            `codex app-server did not answer ${method} within ${timeoutMs} ms; whether it acted on it is unknown`,
            { method, timeoutMs },
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    if (this.closedWith) throw this.closedWith;
    this.transport.send(JSON.stringify(message));
  }

  private receive(line: string): void {
    if (this.closedWith) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.protocolError("a line that is not JSON");
    }
    if (!isObject(message)) return this.protocolError("a message that is not an object");
    const hasMethod = "method" in message;
    const hasId = "id" in message;
    if (hasMethod) {
      if (typeof message.method !== "string") return this.protocolError("a method that is not a string");
      if (hasId) {
        if (!isId(message.id)) return this.protocolError("a request id that is neither a string nor an integer");
        void this.answer(message.id, message.method, message.params);
        return;
      }
      try {
        this.options.onNotification?.(message.method, message.params);
      } catch (error) {
        // A handler that cannot read what Codex sent ends the connection, never the stdio callback.
        this.closeOnProtocolError(`a ${message.method} notification ORCA could not read (${(error as Error).message})`);
      }
      return;
    }
    if (!hasId || typeof message.id !== "number")
      return this.protocolError("a message that is neither a request, a notification nor an answer");
    const waiting = this.pending.get(message.id);
    if (!waiting) return this.protocolError(`an answer to request ${message.id}, which is not pending`);
    const hasResult = "result" in message;
    const hasError = "error" in message;
    if (hasResult === hasError)
      return this.protocolError(
        `an answer to ${waiting.method} with ${hasResult ? "both" : "neither"} result and error`,
      );
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (hasResult) return waiting.resolve(message.result);
    const error = message.error;
    // A malformed error is not Codex refusing the request: it is a protocol error of ORCA's own
    // finding, so callers never read it as a definite refusal (`CodexRpcError` is only that).
    if (!isObject(error) || typeof error.code !== "number" || typeof error.message !== "string")
      return waiting.reject(
        new OrcaError("AGENT_PROTOCOL", `codex app-server answered ${waiting.method} with a malformed error`, {
          method: waiting.method,
        }),
      );
    waiting.reject(new CodexRpcError(error.code, error.message, error.data));
  }

  private async answer(id: string | number, method: string, params: unknown): Promise<void> {
    let reply: Record<string, unknown>;
    const handler = this.options.onServerRequest;
    if (!this.serverRequests.includes(method) || !handler) {
      reply = { id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `ORCA does not handle ${method}` } };
    } else {
      try {
        reply = { id, result: await handler(method, params) };
      } catch (error) {
        reply =
          error instanceof CodexRpcError
            ? {
                id,
                error: {
                  code: error.code,
                  message: error.message,
                  ...(error.data === undefined ? {} : { data: error.data }),
                },
              }
            : { id, error: { code: -32603, message: `ORCA could not answer ${method}` } };
      }
    }
    if (this.closedWith) return;
    try {
      this.write(reply);
    } catch (error) {
      this.shutdown(new OrcaError("AGENT_TRANSPORT", `could not answer ${method}: ${(error as Error).message}`));
    }
  }

  /**
   * End the connection because Codex sent `what`, which the protocol does not allow: pending
   * requests fail, and `onClose` gets `AGENT_PROTOCOL`.
   */
  closeOnProtocolError(what: string): void {
    this.shutdown(new OrcaError("AGENT_PROTOCOL", `codex app-server sent ${what}; ORCA closed the connection`));
    this.transport.close();
  }

  private protocolError(what: string): void {
    this.closeOnProtocolError(what);
  }

  private shutdown(error: OrcaError): void {
    if (this.closedWith) return;
    this.closedWith = error;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(error);
    }
    this.options.onClose?.(error);
  }
}

/** What the handshake learned. */
export interface CodexAppServerHandshake {
  /** The pinned Codex version the server reported. */
  version: string;
  /** The CODEX_HOME the server runs with, as it reports it. */
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

/** The name ORCA gives Codex as its client; the server's `userAgent` begins with it. */
export const CODEX_CLIENT_NAME = "orca";

/** The Codex version in an `initialize` answer's `userAgent` (`orca/0.171.0 (…)`), or undefined. */
export function codexVersionFromUserAgent(userAgent: string, clientName = CODEX_CLIENT_NAME): string | undefined {
  const prefix = `${clientName}/`;
  if (!userAgent.startsWith(prefix)) return undefined;
  return /^(\d+\.\d+\.\d+)(?: |$)/.exec(userAgent.slice(prefix.length))?.[1];
}

/**
 * `initialize`, the checks, then `initialized`. Refused (`NOT_SUPPORTED`), with the connection
 * closed and `initialized` never sent, when the server's Codex is not a pinned version or its
 * protocol lacks a method in `requiredMethods`; `AGENT_PROTOCOL` when the answer is not the
 * generated shape.
 */
export async function initializeCodexAppServer(
  client: CodexAppServerClient,
  options: {
    agentId: string;
    /** ORCA's own version, for `clientInfo`. */
    orcaVersion: string;
    /** Only when a feature that needs Codex's experimental API is on. */
    experimentalApi?: boolean;
    /** Notifications ORCA does not use. */
    optOutNotificationMethods?: readonly string[];
    /** Methods the session will call; each must be in the pinned protocol. */
    requiredMethods?: readonly string[];
    timeoutMs?: number;
  },
): Promise<CodexAppServerHandshake> {
  const params: InitializeParams = {
    clientInfo: { name: CODEX_CLIENT_NAME, title: "ORCA", version: options.orcaVersion },
    capabilities: {
      experimentalApi: options.experimentalApi === true,
      requestAttestation: false,
      ...(options.optOutNotificationMethods?.length
        ? { optOutNotificationMethods: [...options.optOutNotificationMethods] }
        : {}),
    },
  };
  const answer = await client.request("initialize", params, options.timeoutMs ? { timeoutMs: options.timeoutMs } : {});
  const refuse = (code: "NOT_SUPPORTED" | "AGENT_PROTOCOL", message: string, details: Record<string, unknown> = {}) => {
    client.close("closed after a refused handshake");
    return new OrcaError(code, `agent ${options.agentId}: ${message}`, { agentId: options.agentId, ...details });
  };
  const r = answer as Partial<InitializeResponse> | null;
  if (
    !isObject(r) ||
    typeof r.userAgent !== "string" ||
    typeof r.codexHome !== "string" ||
    typeof r.platformFamily !== "string" ||
    typeof r.platformOs !== "string"
  )
    throw refuse("AGENT_PROTOCOL", "codex app-server answered initialize with a shape ORCA does not know");
  const version = codexVersionFromUserAgent(r.userAgent);
  const pinned = version === undefined ? undefined : CODEX_APP_SERVER_PINNED[version];
  if (version === undefined || pinned === undefined)
    throw refuse(
      "NOT_SUPPORTED",
      `codex app-server reports ${version === undefined ? `no version ORCA can read (${JSON.stringify(r.userAgent)})` : `Codex ${version}`}, ` +
        `and ORCA runs this driver only with Codex ${Object.keys(CODEX_APP_SERVER_PINNED).join(", ")}. Install a supported Codex.`,
      { version: version ?? null, supported: Object.keys(CODEX_APP_SERVER_PINNED) },
    );
  const missing = (options.requiredMethods ?? []).filter((m) => !pinned.clientRequests.includes(m));
  if (missing.length > 0)
    throw refuse(
      "NOT_SUPPORTED",
      `Codex ${version}'s app-server protocol has no ${missing.join(", ")}, which this session needs.`,
      { version, missing },
    );
  client.useServerRequests(pinned.serverRequests);
  client.notify("initialized");
  return { version, codexHome: r.codexHome, platformFamily: r.platformFamily, platformOs: r.platformOs };
}
