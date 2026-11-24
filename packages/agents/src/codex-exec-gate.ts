/**
 * ORCA's gate in Codex's executor path (#1026).
 *
 * The Codex `PreToolUse` hook (#705) runs under Codex's own hook runner, which lets a call
 * through when the hook fails, and `write_stdin` never reaches a hook at all. A guard beside
 * the path a call takes can be skipped. This one is on the path.
 *
 * Codex 0.171 does not have to run commands itself. Started with
 * `CODEX_EXEC_SERVER_URL=ws://127.0.0.1:<port>/<token>`, its only execution environment is the
 * executor at that address, and it has no local one. Every shell command, every byte typed
 * into a running command, every patch and every image read then arrives there as a JSON-RPC
 * request (`process/start`, `process/write`, `fs/writeFile`, `fs/readFile` and the rest of
 * `codex-rs/exec-server-protocol`). The gate is that address. It runs in ORCA's own process,
 * decides each request, and passes the ones it allows to a real `codex exec-server --listen
 * stdio` that ORCA started. A request the gate refuses is answered with an error and reaches
 * no executor. When the gate is missing, slow, wrong or dead the request has nowhere else to
 * go, so the failure mode is the reverse of the hook's.
 *
 * What the gate does with each request:
 *
 * - **decides it** by the session's policy (`decide`, which the session layer supplies):
 *   starting a process, typing into one, reading, listing, writing, removing and copying
 *   files. Metadata probes are checked against ORCA's protected paths only.
 * - **passes it** when it only continues something already decided: reading the output of,
 *   interrupting or ending a process this connection was allowed to start, and reading,
 *   writing or closing a file handle it was allowed to open.
 * - **refuses it** when the gate does not know the method, cannot read the parameters the way
 *   the executor would, or the request names a process or handle the gate never allowed.
 *
 * A request is passed on as the gate read it: the fields the protocol has are serialized
 * again from the parsed message, so the executor cannot read a request differently from the
 * way the gate decided it (a duplicate key, for one).
 *
 * Limits, said plainly. The gate decides the process being started and the text typed into
 * it, not what that process goes on to do. A path is checked when the request arrives, and
 * the executor opens it a moment later. Tool calls that never use the executor (MCP servers
 * Codex reaches over HTTP, tools hosted at the model provider) do not pass here. The gate
 * records nothing about a call it never saw, and that absence is not evidence of anything.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type * as acp from "@agentclientprotocol/sdk";
import { quoteWord } from "@orca/core";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

/** The largest message either side may send; Codex's own limit for the protocol. */
export const CODEX_EXEC_GATE_MESSAGE_LIMIT = 64 * 1024 * 1024;

/** Requests waiting for a decision on one connection before the gate gives the connection up. */
const QUEUE_LIMIT = 1024;

/** Bytes waiting to be written to either side before the gate gives the connection up. */
const BUFFER_LIMIT = 4 * CODEX_EXEC_GATE_MESSAGE_LIMIT;

/** Processes and file handles one connection may hold before new ones are refused. */
const TRACKED_LIMIT = 65_536;

/** Records kept in memory for `records()`. `onRecord` hears every one. */
const RECORD_LIMIT = 10_000;

/** Codex gives `initialize` ten seconds; the gate answers inside that, admitted or not. */
const ADMISSION_WAIT_MS = 8000;

const DECISION_TIMEOUT_MS = 10_000;

const REFUSED = -32000;

/** Shells whose `-c` argument the gate reads as the command. A path the model chose is not one. */
const SYSTEM_SHELLS = new Set(["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"]);

/** What one request asks ORCA to decide, in the shape ORCA's permission rules read a call. */
export interface CodexExecGateCall {
  /** The executor method, such as `process/start`. */
  method: string;
  /**
   * `policy`: the session's rules decide. `protected`: only ORCA's own files are refused (a
   * metadata probe, which opens nothing).
   */
  check: "policy" | "protected";
  toolCall: { title: string; kind: acp.ToolKind; locations: { path: string }[] };
  /** Where a started process runs. Absent for a file request, whose paths are absolute. */
  cwd?: string | undefined;
  /** Codex's id for the model's call. Only `process/start` carries one. */
  toolCallId?: string | undefined;
  /** Text typed into a running process: decided only by a rule that names typed input. */
  typedInput?: true | undefined;
}

export type CodexExecGateDecision =
  | { allow: true; basis: string }
  /** `reason` is what the model is told. */
  | { allow: false; basis: string; reason: string };

/** What the gate did with one request or connection, for evidence and diagnostics. */
export interface CodexExecGateRecord {
  seq: number;
  /** ISO time the gate finished with it. */
  at: string;
  connection: number;
  /** The executor method, or `connection` for a connection event. */
  method: string;
  /** The JSON-RPC id of a request. */
  id?: string | number | undefined;
  outcome: "forwarded" | "refused" | "dropped" | "opened" | "closed";
  /** What decided: `pass`, `gate`, or the basis `decide` gave. */
  basis: string;
  /** Why, for a refusal, a drop or a close. */
  reason?: string | undefined;
  /** What was decided. Typed input is recorded by size and digest, never as text. */
  subject?: CodexExecGateSubject | undefined;
}

export interface CodexExecGateSubject {
  kind?: acp.ToolKind | undefined;
  /** The command for a process, or what the gate called a file request. Absent for typed input. */
  title?: string | undefined;
  argv?: string[] | undefined;
  cwd?: string | undefined;
  paths?: string[] | undefined;
  toolCallId?: string | undefined;
  processId?: string | undefined;
  /** For typed input: how many bytes, and their sha256. */
  bytes?: number | undefined;
  sha256?: string | undefined;
}

/** The executor behind the gate, one per connection. */
export interface CodexExecBackend {
  /** Send one message. Throws when the executor is gone. */
  send(message: string): void;
  /** Hear each message the executor writes. */
  onMessage(listener: (message: string) => void): void;
  /** Hear the executor end, once, however it ends. */
  onExit(listener: (detail: string) => void): void;
  /** End it and wait until it is gone, within the backend's own bound. */
  stop(): Promise<void>;
}

export interface CodexExecGateOptions {
  /** Decide one call. A rejection, or no answer within `decisionTimeoutMs`, refuses the request. */
  decide: (call: CodexExecGateCall, signal: AbortSignal) => Promise<CodexExecGateDecision>;
  /** Hear each record as it is made. A throw is ignored. */
  onRecord?: ((record: CodexExecGateRecord) => void) | undefined;
  decisionTimeoutMs?: number | undefined;
  /** How long a connection's `initialize` waits for `admit` before it is refused. */
  admissionWaitMs?: number | undefined;
  /** Connections held at once. Codex opens one. */
  maxConnections?: number | undefined;
}

export interface CodexExecGate {
  /** What Codex is given as `CODEX_EXEC_SERVER_URL`. It carries the session's token. */
  readonly url: string;
  /**
   * Open the gate: from now on a connection's `initialize` starts an executor with `start`.
   * Until this is called every connection is refused, so ORCA admits the runtime first.
   */
  admit(start: () => CodexExecBackend): void;
  /** Resolves once a connection has been initialized through the gate, or rejects at the deadline. */
  initialized(timeoutMs: number): Promise<void>;
  /** The most recent records, oldest first. */
  records(): readonly CodexExecGateRecord[];
  /** Refuse everything from now on, end every connection and executor, and stop listening. */
  close(): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the gate knows about one connection: only what it allowed. */
export interface CodexExecGateConnectionState {
  processes: Set<string>;
  handles: Map<string, "read" | "replace">;
  /** The shell the executor reported, read like a system shell. */
  shell?: string | undefined;
}

export const newCodexExecGateConnectionState = (): CodexExecGateConnectionState => ({
  processes: new Set(),
  handles: new Map(),
});

/** What to do with one request. `effect` is applied only when the request is forwarded. */
export type CodexExecGatePlan =
  | { action: "refuse"; reason: string; subject?: CodexExecGateSubject }
  | {
      action: "pass" | "decide";
      calls: CodexExecGateCall[];
      subject?: CodexExecGateSubject;
      effect?: (state: CodexExecGateConnectionState) => void;
    };

class Unreadable extends Error {}

/**
 * The absolute path a `file:` URI names, read the way Codex's executor reads it (`PathUri`:
 * a WHATWG URL whose path is percent-decoded). Only the plain form Codex itself writes is
 * accepted: no host, query or fragment, already in canonical spelling, valid UTF-8 once
 * decoded, no encoded separator and no NUL (which also rules out Codex's `file:///%00/bad/path/`
 * form, where the real path hides in base64).
 */
export function codexExecPath(uri: unknown): string {
  if (typeof uri !== "string" || !uri.startsWith("file:///")) throw new Unreadable("a path is not a file: URI");
  if (!/^[\x21-\x7e]+$/.test(uri) || /[\\?#]/.test(uri)) throw new Unreadable("a path is not a plain file: URI");
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Unreadable("a path is not a file: URI");
  }
  if (url.protocol !== "file:" || url.host !== "" || url.search !== "" || url.hash !== "" || url.href !== uri)
    throw new Unreadable("a path is not a plain file: URI");
  if (/%(?:00|2f|5c)/i.test(url.pathname)) throw new Unreadable("a path hides a separator");
  const bytes: number[] = [];
  const text = url.pathname;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 0x25) {
      bytes.push(code);
      continue;
    }
    const hex = text.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Unreadable("a path is not a plain file: URI");
    bytes.push(Number.parseInt(hex, 16));
    i += 2;
  }
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new Unreadable("a path is not text");
  }
  if (!path.startsWith("/")) throw new Unreadable("a path is not absolute");
  return path;
}

const text = (v: unknown, what: string, max = 4096): string => {
  if (typeof v !== "string" || v === "" || v.length > max) throw new Unreadable(`${what} is missing`);
  return v;
};

const fileCall = (
  method: string,
  kind: acp.ToolKind,
  verb: string,
  path: string,
  check: CodexExecGateCall["check"] = "policy",
): CodexExecGateCall => ({ method, check, toolCall: { title: `${verb} ${path}`, kind, locations: [{ path }] } });

/**
 * Decide what one request needs. Pure: it reads the parameters and the connection's state and
 * changes neither. Anything it cannot read the way the executor would is refused.
 */
export function planCodexExecRequest(
  method: string,
  params: unknown,
  state: CodexExecGateConnectionState,
): CodexExecGatePlan {
  try {
    return plan(method, isRecord(params) ? params : {}, state);
  } catch (error) {
    if (error instanceof Unreadable)
      return { action: "refuse", reason: `ORCA could not read the request (${error.message})` };
    throw error;
  }
}

function plan(method: string, p: Record<string, unknown>, state: CodexExecGateConnectionState): CodexExecGatePlan {
  const pass = (
    subject?: CodexExecGateSubject,
    effect?: (s: CodexExecGateConnectionState) => void,
  ): CodexExecGatePlan => ({
    action: "pass",
    calls: [],
    ...(subject ? { subject } : {}),
    ...(effect ? { effect } : {}),
  });
  const decide = (
    calls: CodexExecGateCall[],
    effect?: (s: CodexExecGateConnectionState) => void,
    more?: CodexExecGateSubject,
  ): CodexExecGatePlan => {
    const first = calls[0]!;
    return {
      action: "decide",
      calls,
      subject: {
        kind: first.toolCall.kind,
        title: first.toolCall.title,
        paths: calls.flatMap((c) => c.toolCall.locations.map((l) => l.path)),
        ...more,
      },
      ...(effect ? { effect } : {}),
    };
  };
  const knownProcess = (): string => {
    const processId = text(p["processId"], "processId", 512);
    if (!state.processes.has(processId)) throw new Unreadable("it names a process ORCA did not allow");
    return processId;
  };

  switch (method) {
    case "environment/info":
    case "environment/status":
      return pass();

    case "process/start": {
      const processId = text(p["processId"], "processId", 512);
      if (state.processes.has(processId)) throw new Unreadable("the process id is already in use");
      if (state.processes.size >= TRACKED_LIMIT) throw new Unreadable("too many processes on this connection");
      const argv = p["argv"];
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((w): w is string => typeof w === "string"))
        throw new Unreadable("argv is missing");
      const cwd = codexExecPath(p["cwd"]);
      const arg0 = p["arg0"];
      if (arg0 !== undefined && arg0 !== null && typeof arg0 !== "string") throw new Unreadable("arg0 is not text");
      const metadata = isRecord(p["metadata"]) ? p["metadata"] : {};
      const toolCallId = typeof metadata["toolCallId"] === "string" ? metadata["toolCallId"] : undefined;
      // `[shell, -c, script]` under a shell ORCA knows is the script, which is what a rule's
      // title matches and what the hook sees. Any other shape, a shell at a path the model
      // chose, or a process started under another name is decided as the whole command line.
      const wrapped =
        argv.length === 3 &&
        (SYSTEM_SHELLS.has(argv[0]!) || argv[0] === state.shell) &&
        /^-l?c$/.test(argv[1]!) &&
        (arg0 === undefined || arg0 === null || arg0 === argv[0]);
      const rendered = argv.map(quoteWord).join(" ");
      const title = wrapped ? argv[2]! : typeof arg0 === "string" ? `${rendered} (as ${quoteWord(arg0)})` : rendered;
      return decide(
        [{ method, check: "policy", toolCall: { title, kind: "execute", locations: [] }, cwd, toolCallId }],
        (s) => s.processes.add(processId),
        { argv: [...argv], cwd, processId, ...(toolCallId !== undefined ? { toolCallId } : {}) },
      );
    }

    case "process/read":
    case "process/signal":
    case "process/terminate":
      return pass({ processId: knownProcess() });

    case "process/write": {
      const processId = knownProcess();
      const chunk = p["chunk"];
      if (typeof chunk !== "string") throw new Unreadable("the typed input is missing");
      const bytes = Buffer.from(chunk, "base64");
      if (bytes.toString("base64") !== chunk) throw new Unreadable("the typed input is not base64");
      // Nothing typed, or one interrupt (Ctrl-C), only ever stops what was already allowed.
      if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 0x03))
        return pass({ processId, bytes: bytes.length });
      let typed: string;
      try {
        typed = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Unreadable("the typed input is not text");
      }
      const subject = { processId, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      return {
        action: "decide",
        calls: [
          {
            method,
            check: "policy",
            typedInput: true,
            toolCall: { title: `write_stdin: ${JSON.stringify(typed)}`, kind: "execute", locations: [] },
          },
        ],
        subject: { kind: "execute", ...subject },
      };
    }

    case "fs/readFile":
      return decide([fileCall(method, "read", "Read", codexExecPath(p["path"]))]);

    case "fs/open": {
      const handleId = text(p["handleId"], "handleId", 512);
      if (state.handles.has(handleId)) throw new Unreadable("the handle id is already in use");
      if (state.handles.size >= TRACKED_LIMIT) throw new Unreadable("too many open files on this connection");
      const mode = p["mode"] === undefined ? "read" : p["mode"];
      if (mode !== "read" && mode !== "replace") throw new Unreadable("the open mode is not one ORCA knows");
      const path = codexExecPath(p["path"]);
      const call = mode === "read" ? fileCall(method, "read", "Read", path) : fileCall(method, "edit", "Edit", path);
      return decide([call], (s) => s.handles.set(handleId, mode));
    }

    case "fs/readBlock": {
      const handleId = text(p["handleId"], "handleId", 512);
      if (!state.handles.has(handleId)) throw new Unreadable("it names a file ORCA did not open");
      return pass();
    }

    case "fs/writeBlock": {
      const handleId = text(p["handleId"], "handleId", 512);
      if (state.handles.get(handleId) !== "replace")
        throw new Unreadable("it names a file ORCA did not open for writing");
      return pass();
    }

    case "fs/close": {
      const handleId = text(p["handleId"], "handleId", 512);
      if (!state.handles.has(handleId)) throw new Unreadable("it names a file ORCA did not open");
      return pass(undefined, (s) => s.handles.delete(handleId));
    }

    case "fs/writeFile":
      return decide([fileCall(method, "edit", "Edit", codexExecPath(p["path"]))]);

    case "fs/createDirectory":
      return decide([fileCall(method, "edit", "Create directory", codexExecPath(p["path"]))]);

    case "fs/remove":
      return decide([fileCall(method, "delete", "Delete", codexExecPath(p["path"]))]);

    case "fs/copy": {
      const from = codexExecPath(p["sourcePath"]);
      const to = codexExecPath(p["destinationPath"]);
      return decide([fileCall(method, "edit", `Copy ${from} to`, to), fileCall(method, "read", "Read", from)]);
    }

    case "fs/readDirectory":
    case "fs/walk":
      return decide([fileCall(method, "search", "Find", codexExecPath(p["path"]))]);

    case "fs/getMetadata":
    case "fs/canonicalize":
      return decide([fileCall(method, "read", "Look up", codexExecPath(p["path"]), "protected")]);

    case "fs/watchMissing": {
      const missing = p["missing"];
      if (!Array.isArray(missing) || missing.length > 4096) throw new Unreadable("the watched paths are missing");
      const present = p["present"];
      const paths = [...missing, ...(present === undefined || present === null ? [] : [present])].map(codexExecPath);
      if (paths.length === 0) return pass();
      return decide(paths.map((path) => fileCall(method, "read", "Look up", path, "protected")));
    }

    default:
      return { action: "refuse", reason: `ORCA does not pass the executor request \`${method.slice(0, 80)}\`` };
  }
}

const refusal = (reason: string): string =>
  reason.startsWith("Blocked by ORCA") || reason.startsWith("Denied by ORCA") ? reason : `Blocked by ORCA: ${reason}.`;

/**
 * Open the gate on a loopback port. It refuses every connection until `admit` is called, and
 * every request it does not allow after that.
 */
export async function openCodexExecGate(options: CodexExecGateOptions): Promise<CodexExecGate> {
  const token = randomBytes(32).toString("base64url");
  const wanted = createHash("sha256").update(`/${token}`).digest();
  const decisionTimeoutMs = options.decisionTimeoutMs ?? DECISION_TIMEOUT_MS;
  const admissionWaitMs = options.admissionWaitMs ?? ADMISSION_WAIT_MS;
  const maxConnections = options.maxConnections ?? 4;

  let seq = 0;
  let connectionSeq = 0;
  let closed = false;
  let startBackend: (() => CodexExecBackend) | undefined;
  let admitted: (() => void) | undefined;
  const admission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  let initializedOnce = false;
  const initializedWaiters = new Set<() => void>();
  const kept: CodexExecGateRecord[] = [];
  const live = new Set<{ end: (reason: string) => void; stopped: () => Promise<void> }>();

  const record = (entry: Omit<CodexExecGateRecord, "seq" | "at">): void => {
    const made: CodexExecGateRecord = { seq: ++seq, at: new Date().toISOString(), ...entry };
    kept.push(made);
    if (kept.length > RECORD_LIMIT) kept.shift();
    try {
      options.onRecord?.(made);
    } catch {
      // A listener's failure changes nothing the gate decides.
    }
  };

  const server = createServer((_request, response) => {
    response.writeHead(404, { connection: "close" }).end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: CODEX_EXEC_GATE_MESSAGE_LIMIT,
    perMessageDeflate: false,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  const turnAway = (socket: Duplex, status: string, reason: string): void => {
    record({ connection: 0, method: "connection", outcome: "refused", basis: "gate", reason });
    socket.on("error", () => undefined);
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const got = createHash("sha256")
      .update(request.url ?? "")
      .digest();
    if (!timingSafeEqual(got, wanted))
      return turnAway(socket, "404 Not Found", "the connection did not carry the session's token");
    // Codex sends neither; a browser page sends an Origin, and a rebound name another Host.
    if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${port}`)
      return turnAway(socket, "403 Forbidden", "the connection did not come from the agent's own executor client");
    if (closed) return turnAway(socket, "503 Service Unavailable", "the gate is closed");
    if (live.size >= maxConnections) return turnAway(socket, "503 Service Unavailable", "too many connections");
    wss.handleUpgrade(request, socket, head, (ws) => connect(ws));
  });

  const decideBounded = async (call: CodexExecGateCall): Promise<CodexExecGateDecision> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.decide(call, controller.signal),
        new Promise<CodexExecGateDecision>((resolve) => {
          timer = setTimeout(
            () => resolve({ allow: false, basis: "gate", reason: "ORCA could not decide this call in time" }),
            decisionTimeoutMs,
          );
        }),
      ]);
    } catch {
      return { allow: false, basis: "gate", reason: "ORCA could not check this call" };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };

  function connect(ws: WebSocket): void {
    const connection = ++connectionSeq;
    const state = newCodexExecGateConnectionState();
    /** Ids of requests the executor sent the client; only these may be answered. */
    const asked = new Set<string>();
    let backend: CodexExecBackend | undefined;
    let initializeId: string | number | undefined;
    let ready = false;
    let ended = false;
    let queued = 0;
    let chain: Promise<void> = Promise.resolve();
    let stopping: Promise<void> = Promise.resolve();

    const end = (reason: string): void => {
      if (ended) return;
      ended = true;
      live.delete(entry);
      record({ connection, method: "connection", outcome: "closed", basis: "gate", reason });
      ws.terminate();
      if (backend) stopping = backend.stop().catch(() => undefined);
    };
    const entry = { end, stopped: () => stopping };
    live.add(entry);
    record({ connection, method: "connection", outcome: "opened", basis: "gate" });

    const reply = (message: unknown): void => {
      if (ended) return;
      if (ws.bufferedAmount > BUFFER_LIMIT) return end("the agent stopped reading the gate's answers");
      ws.send(typeof message === "string" ? message : JSON.stringify(message));
    };
    const refuse = (
      id: string | number,
      method: string,
      basis: string,
      reason: string,
      subject?: CodexExecGateSubject,
    ): void => {
      record({ connection, method, id, outcome: "refused", basis, reason, ...(subject ? { subject } : {}) });
      reply({ id, error: { code: REFUSED, message: refusal(reason) } });
    };
    // Only the fields the protocol has are passed on, serialized from what the gate parsed.
    const requestOf = (id: string | number, method: string, message: Record<string, unknown>) => ({
      id,
      method,
      ...(message["params"] !== undefined ? { params: message["params"] } : {}),
      ...(isRecord(message["trace"]) ? { trace: message["trace"] } : {}),
    });
    const forward = (message: Record<string, unknown>): boolean => {
      try {
        backend!.send(JSON.stringify(message));
        return true;
      } catch {
        end("the executor behind the gate is gone");
        return false;
      }
    };

    const fromBackend = (line: string): void => {
      if (ended) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return end("the executor behind the gate sent something that is not JSON");
      }
      if (isRecord(message)) {
        const id = message["id"];
        if (typeof message["method"] === "string" && (typeof id === "string" || typeof id === "number"))
          asked.add(`${typeof id}:${id}`);
        if (!ready && initializeId !== undefined && id === initializeId && isRecord(message["result"])) {
          ready = true;
          const info = message["result"]["environmentInfo"];
          const shell = isRecord(info) && isRecord(info["shell"]) ? info["shell"]["path"] : undefined;
          if (typeof shell === "string" && shell.startsWith("/")) state.shell = shell;
          initializedOnce = true;
          for (const wake of initializedWaiters) wake();
        }
      }
      reply(line);
    };

    const initialize = async (id: string | number, message: Record<string, unknown>): Promise<void> => {
      if (startBackend === undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          admission,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, admissionWaitMs);
          }),
        ]);
        clearTimeout(timer);
      }
      if (ended) return;
      if (startBackend === undefined || closed)
        return refuse(id, "initialize", "gate", "ORCA has not admitted this session's runtime");
      try {
        backend = startBackend();
      } catch {
        refuse(id, "initialize", "gate", "ORCA could not start the executor behind its gate");
        return end("the executor behind the gate did not start");
      }
      backend.onMessage(fromBackend);
      backend.onExit((detail) => end(`the executor behind the gate ended (${detail})`));
      initializeId = id;
      if (forward(requestOf(id, "initialize", message)))
        record({ connection, method: "initialize", id, outcome: "forwarded", basis: "pass" });
    };

    const request = async (method: string, id: string | number, message: Record<string, unknown>): Promise<void> => {
      if (backend === undefined) {
        if (method === "initialize") return initialize(id, message);
        return refuse(id, method, "gate", "the connection has not been initialized through ORCA");
      }
      if (method === "initialize") return refuse(id, method, "gate", "the connection is already initialized");
      if (!ready) return refuse(id, method, "gate", "the executor behind the gate has not answered yet");
      const planned = planCodexExecRequest(method, message["params"], state);
      if (planned.action === "refuse") return refuse(id, method, "gate", planned.reason, planned.subject);
      let basis = "pass";
      for (const call of planned.calls) {
        const decision = await decideBounded(call);
        if (ended) return;
        if (!decision.allow) return refuse(id, method, decision.basis, decision.reason, planned.subject);
        if (call.check === "policy") basis = decision.basis;
      }
      if (!forward(requestOf(id, method, message))) return;
      planned.effect?.(state);
      record({
        connection,
        method,
        id,
        outcome: "forwarded",
        basis,
        ...(planned.subject ? { subject: planned.subject } : {}),
      });
    };

    const handle = async (data: string): Promise<void> => {
      if (ended) return;
      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        return end("the agent sent something that is not JSON");
      }
      if (!isRecord(message)) return end("the agent sent something that is not a message");
      const method = message["method"];
      const id = message["id"];
      const hasId = typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id));
      if (typeof method === "string") {
        if (hasId) return request(method, id, message);
        if (id !== undefined && id !== null) return end("the agent sent a request with an id ORCA cannot answer");
        // A notification has no answer to refuse it with, so one ORCA does not know is dropped.
        if (method === "initialized" && backend !== undefined && ready) {
          if (forward({ method })) record({ connection, method, outcome: "forwarded", basis: "pass" });
          return;
        }
        return record({
          connection,
          method: method.slice(0, 80),
          outcome: "dropped",
          basis: "gate",
          reason: "a notification ORCA does not pass",
        });
      }
      if (hasId && ("result" in message || "error" in message) && backend !== undefined) {
        // An answer goes through only to a question the executor asked, and only once.
        if (asked.delete(`${typeof id}:${id}`)) {
          const answer = "result" in message ? { id, result: message["result"] } : { id, error: message["error"] };
          if (forward(answer)) record({ connection, method: "response", id, outcome: "forwarded", basis: "pass" });
          return;
        }
      }
      record({
        connection,
        method: "response",
        outcome: "dropped",
        basis: "gate",
        reason: "an answer to nothing the executor asked",
      });
    };

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (ended) return;
      if (isBinary) return end("the agent sent a binary frame");
      if (++queued > QUEUE_LIMIT) return end("the agent sent requests faster than ORCA decides them");
      const text = (
        Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      ).toString("utf8");
      // One at a time, in the order they arrived: a request is decided before the next is read.
      chain = chain
        .then(() => handle(text))
        .catch(() => end("ORCA's gate failed"))
        .finally(() => {
          queued--;
        });
    });
    ws.on("close", () => end("the agent closed the connection"));
    ws.on("error", () => end("the connection failed"));
  }

  return {
    url: `ws://127.0.0.1:${port}/${token}`,
    admit(start) {
      if (closed) throw new Error("the Codex exec gate is closed");
      if (startBackend !== undefined) throw new Error("the Codex exec gate is already admitted");
      startBackend = start;
      admitted?.();
    },
    initialized(timeoutMs) {
      if (initializedOnce) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          clearTimeout(timer);
          initializedWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(() => {
          initializedWaiters.delete(wake);
          reject(new Error("Codex did not connect to ORCA's exec gate in time"));
        }, timeoutMs);
        initializedWaiters.add(wake);
      });
    },
    records: () => [...kept],
    async close() {
      if (closed) return;
      closed = true;
      const ending = [...live];
      for (const connection of ending) connection.end("the gate closed");
      await Promise.all(ending.map((connection) => connection.stopped()));
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** How to start the real executor behind the gate. */
export interface CodexExecServerSpawn {
  /** The Codex program to run as `exec-server --listen stdio`. */
  program: string;
  /** Its whole environment. `CODEX_EXEC_SERVER_URL` is never passed on. */
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** How long each step of `stop` waits for the exit. */
  stopGraceMs?: number | undefined;
}

/**
 * Start `codex exec-server --listen stdio` as ORCA's own direct child and speak its
 * line-delimited JSON. `stop` closes its input, then signals that one child, and only while
 * it has not been reaped: nothing is looked up by pid or by group.
 */
export function spawnCodexExecServer(
  spec: CodexExecServerSpawn,
): CodexExecBackend & { readonly pid: number | undefined } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env))
    if (value !== undefined && key !== "CODEX_EXEC_SERVER_URL") env[key] = value;
  const child = spawn(spec.program, ["exec-server", "--listen", "stdio"], {
    cwd: spec.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const grace = spec.stopGraceMs ?? 2000;
  let gone: string | undefined;
  /** Set when ORCA gave the executor up before it exited; nothing more is sent or heard. */
  let failed: string | undefined;
  let onMessage: ((message: string) => void) | undefined;
  const exitListeners: ((detail: string) => void)[] = [];
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (detail: string): void => {
    if (gone !== undefined) return;
    gone = detail;
    resolveExit?.();
    for (const listener of exitListeners) listener(failed ?? detail);
  };
  const giveUp = (detail: string): void => {
    if (gone !== undefined || failed !== undefined) return;
    failed = detail;
    // The exit is still observed below; `kill` reaches this child only while it is unreaped.
    child.kill("SIGKILL");
  };

  let parts: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        const rest = chunk.subarray(start);
        if (rest.length > 0) {
          parts.push(rest);
          size += rest.length;
          if (size > CODEX_EXEC_GATE_MESSAGE_LIMIT + 1024) giveUp("it wrote a message over the size limit");
        }
        return;
      }
      const piece = chunk.subarray(start, newline);
      const line = (parts.length > 0 ? Buffer.concat([...parts, piece]) : piece).toString("utf8").trim();
      parts = [];
      size = 0;
      start = newline + 1;
      if (line !== "" && gone === undefined && failed === undefined) onMessage?.(line);
    }
  });
  // Its diagnostics are not ORCA's to keep; draining them keeps the pipe from filling.
  child.stderr.resume();
  child.stdin.on("error", () => giveUp("its input closed"));
  child.on("error", (error) => finish(`it could not be started: ${error.message}`));
  child.on("exit", (code, signal) => finish(signal !== null ? `signal ${signal}` : `exit ${code ?? "unknown"}`));

  const within = async (ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
    clearTimeout(timer);
    return done;
  };

  return {
    pid: child.pid,
    send(message) {
      if (gone !== undefined || failed !== undefined) throw new Error(`the executor is gone (${failed ?? gone})`);
      if (child.stdin.writableLength > BUFFER_LIMIT) {
        giveUp("it stopped reading");
        throw new Error("the executor stopped reading");
      }
      child.stdin.write(`${message}\n`);
    },
    onMessage(listener) {
      onMessage = listener;
    },
    onExit(listener) {
      if (gone !== undefined) listener(gone);
      else exitListeners.push(listener);
    },
    async stop() {
      if (gone !== undefined) return;
      child.stdin.end();
      if (await within(grace)) return;
      // `kill` signals this child only while Node still holds its handle, so never a reused pid.
      child.kill("SIGTERM");
      if (await within(grace)) return;
      child.kill("SIGKILL");
      await within(grace);
    },
  };
}
