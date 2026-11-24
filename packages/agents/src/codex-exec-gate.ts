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
 *   starting a process, typing into one, and reading, writing, creating and removing one
 *   file or directory. A metadata probe is checked against ORCA's protected paths only.
 * - **passes it** when it only continues a process this connection was allowed to start:
 *   reading its output, interrupting it (`process/signal`) and ending it. Typing is not one
 *   of these: every write of one byte or more is decided, a Ctrl-C included.
 * - **refuses it** in every other case: a method the gate does not know, parameters it
 *   cannot read the way the executor would, a process it never allowed, and every file
 *   request it cannot tie to the file the executor would use (below).
 *
 * **What a decision covers.** A check of a path in ORCA followed by an open of that path in
 * another process is two looks at a name that can change in between. The gate narrows that as
 * far as the pinned executor lets it, and never passes on the path it was given:
 *
 * - For a file request it works out the path with every link followed, decides that path (and
 *   the path as written, which must be allowed too), and passes on *that* path with
 *   `followSymlinks: false`. The executor then walks it one name at a time from the root and
 *   refuses a link at any step (`exec-server/src/no_follow`), so it uses the link-free path
 *   ORCA decided or nothing. A link swapped in after the decision is the executor's to
 *   refuse, and it does.
 * - For a process it opens the directory the process would start in, decides the directory
 *   that descriptor holds, and tells the executor to start the process in the descriptor
 *   (`/proc/<pid>/fd/<n>`), not in a name. Linux only; elsewhere a start is refused.
 * - The requests the executor has no such mode for are refused: file handles (`fs/open` and
 *   the block reads and writes on it), `fs/copy`, `fs/readDirectory`, `fs/walk`,
 *   `fs/canonicalize` and `fs/watchMissing`. So are the ones that touch more than the one
 *   path decided: a removal of a whole tree, and creating more than one directory at a time
 *   (a recursive create is passed on as a create of that one directory).
 *
 * **How long a directory is held.** The name the executor is given means the directory ORCA
 * decided only while the descriptor is open; once it is closed the same name can come to mean
 * another directory. So the descriptor is closed only on the executor's own word that the
 * command is over: an error answer to the start, or, once it has started, word that the
 * process exited or closed. The answer that it started is too early, because Codex's sandbox
 * helper reads the directory again after it (`linux-sandbox/src/bwrap.rs`). Nothing else
 * closes it: not the connection ending, not `stop` returning, and not the executor exiting,
 * since a child the executor was starting can outlive it and still be on its way in. An ended
 * connection has the executor end the commands it left and waits a bounded time for that
 * word. A directory whose executor exits first stays open for as long as this process lives,
 * unless the backend proves nothing of the executor's is left; it is counted
 * (`codexExecGateHeldDirectories`), and at the ceiling a start is refused. The executor that
 * `spawnCodexExecServer` starts cannot give that proof.
 *
 * With Codex's sandbox the last step into the directory is by name: the sandbox helper asks
 * for the current name of what the descriptor holds and has bubblewrap enter that name. There
 * the directory is path scope, like a file.
 *
 * **The contract for a file request is path scope, not the identity of a file.** The gate
 * decides a link-free path, and the executor uses whatever is at that path when it gets
 * there. A directory renamed onto the path after the decision, a second hard link to a file
 * a rule protects, and a mount over the path are seen by neither side: nothing here ties a
 * decision to an inode. So this module is not a security boundary on its own account, and it
 * is not wired into any session. Before it is used as one, the executor's own isolation has
 * to be shown, separately, to keep ORCA's protected files out of reach under another name
 * and to hold while the tree changes underneath a request.
 *
 * **The executor is sent only what the gate read.** Every request it passes is built again,
 * field by field, from a fixed list for that method; a field the list does not have refuses
 * the request. For a `process/start` that list is everything that shapes the process: the
 * command line, the directory, the environment (name by name, with the only values ORCA
 * passes), the terminal flags and the sandbox Codex names. Codex's sandbox is passed on in
 * a fixed shape with its directories resolved the way the request's own paths are, so that
 * what was decided, what is sent and what the executor's sandbox is built around are one set
 * of paths. Nothing ORCA decides rests on that sandbox.
 *
 * **What the gate holds is bounded in bytes, and counted until it is really gone.** A
 * connection has a budget for everything the gate holds for it at once: the message the
 * websocket is assembling, requests waiting for a decision, and bytes not yet written to
 * either side. Every gate in the process shares one larger budget. A connection that would
 * pass either is closed. An ended connection gives nothing back wholesale: each claim is
 * returned when the thing it stands for has drained (a decision that has settled, a write
 * that has left, a socket that has closed), and until its executor has been seen to exit it
 * still counts as a connection. `close` returns within a bound whatever is still held; what
 * is, stays counted. The records kept for `records()` are capped in number, in bytes and
 * field by field.
 *
 * Limits, said plainly. The gate decides the process being started and the text typed into
 * it, not what that process goes on to do. A file with two names (a hard link) is the file
 * at each of them, so a rule for one name reaches it. Tool calls that never use the executor
 * (MCP servers Codex reaches over HTTP, tools hosted at the model provider) do not pass here.
 * The gate records nothing about a call it never saw, and that absence is not evidence of
 * anything. An acceptance run on the installed pair is evidence for the cases it runs and
 * for nothing else.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readlinkSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { quoteWord } from "@orca/core";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { physicalPathOf } from "./permissions.js";

/**
 * The largest message either side may send through the gate. Codex's protocol allows more;
 * ORCA holds less, so a file over about 6 MB is not read or written through the gate.
 */
export const CODEX_EXEC_GATE_MESSAGE_LIMIT = 8 * 1024 * 1024;

/** Bytes the gate holds for one connection at once, the message being assembled included. */
export const CODEX_EXEC_GATE_CONNECTION_BUDGET = 4 * CODEX_EXEC_GATE_MESSAGE_LIMIT;

/** Bytes every gate in this process holds together, unless a gate is given its own budget. */
export const CODEX_EXEC_GATE_PROCESS_BUDGET = 256 * 1024 * 1024;

/** Requests waiting for a decision on one connection before the gate gives the connection up. */
const QUEUE_LIMIT = 256;

/** Requests one connection may have with the executor, unanswered, before more are refused. */
const PENDING_LIMIT = 1024;

/** Questions the executor may have with the agent, unanswered, before the connection is given up. */
const ASKED_LIMIT = 256;

/** Processes one connection may have started; the oldest closed one makes room for a new one. */
const TRACKED_LIMIT = 1024;

/**
 * Commands one connection may have starting or running, each with its directory held open.
 * Codex 0.171 itself keeps at most 64 processes.
 */
const HELD_LIMIT = 64;

/** Directories every gate in this process holds open together, unless a gate is given its own count. */
export const CODEX_EXEC_GATE_DIRECTORY_LIMIT = 256;

/**
 * How long an ended connection gives its executor to say the commands it left are over,
 * before the executor is asked to stop.
 */
const STOP_WAIT_MS = 2000;

/** Records kept in memory for `records()`, in number and in bytes. `onRecord` hears every one. */
const RECORD_LIMIT = 2048;
const RECORD_BYTES = 4 * 1024 * 1024;

/** The longest path, process id and request id the gate reads. */
const PATH_LIMIT = 4096;
const ID_LIMIT = 128;

/** Codex gives `initialize` ten seconds; the gate answers inside that, admitted or not. */
const ADMISSION_WAIT_MS = 8000;

const DECISION_TIMEOUT_MS = 10_000;

/** How long `close` waits for the executors to be gone before it returns anyway. */
const CLOSE_WAIT_MS = 10_000;

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
  /**
   * The call as the executor will carry it out. A location is the path the executor is told
   * to use, which it reaches without following a link, so it is not to be resolved again.
   */
  toolCall: { title: string; kind: acp.ToolKind; locations: { path: string }[] };
  /** The directory a started process runs in: the one ORCA holds open. Absent for a file request. */
  cwd?: string | undefined;
  /**
   * The same call in the request's own words, present when they differ. Both must be
   * allowed: a rule for a name does not open the file a link at that name leads to, and a
   * rule for a file does not open it under a name another rule guards.
   */
  asWritten?: { title: string; locations: { path: string }[]; cwd?: string | undefined } | undefined;
  /** Codex's id for the model's call. Only `process/start` carries one. */
  toolCallId?: string | undefined;
  /**
   * Bytes typed into a running process: decided only by a rule that names typed input. These
   * are the bytes the decision is for and the only ones the executor is sent: how many, and
   * their sha256. The call's title spells the same bytes as text, `write_stdin: ` and then
   * the text as one JSON string, and that spelling reads back as exactly these bytes. Nothing
   * is dropped or folded on the way: a byte-order mark stays in the text.
   */
  typedInput?: { bytes: number; sha256: string } | undefined;
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
  outcome: "forwarded" | "refused" | "dropped" | "opened" | "closed" | "kept";
  /** What decided: `pass`, `gate`, or the basis `decide` gave. */
  basis: string;
  /** Why, for a refusal, a drop or a close. */
  reason?: string | undefined;
  /** What was decided. Typed input and file contents are recorded by size and digest, never as text. */
  subject?: CodexExecGateSubject | undefined;
}

/** Every text here is cut to a fixed length; a digest beside it covers the whole. */
export interface CodexExecGateSubject {
  kind?: acp.ToolKind | undefined;
  /** The command for a process, or what the gate called a file request. Absent for typed input. */
  title?: string | undefined;
  /** The first words of the command line. `argvSha256` is over all of it, as JSON. */
  argv?: string[] | undefined;
  argvSha256?: string | undefined;
  cwd?: string | undefined;
  /** The paths the executor was told to use. */
  paths?: string[] | undefined;
  /** The paths as the request wrote them, when they differ. */
  written?: string[] | undefined;
  toolCallId?: string | undefined;
  processId?: string | undefined;
  /** For typed input and a file write: how many bytes, and their sha256. */
  bytes?: number | undefined;
  sha256?: string | undefined;
  /** The kind of sandbox Codex named for the request and the executor was sent, or `none`. */
  sandbox?: string | undefined;
}

/** A count of bytes held, with a ceiling. */
export interface CodexExecGateBudget {
  readonly limit: number;
  readonly held: number;
  /** Claim bytes. False, and nothing is claimed, when that would pass the ceiling. */
  take(bytes: number): boolean;
  give(bytes: number): void;
  /** Give everything back and claim nothing from now on. */
  close(): void;
}

/** A budget of `limit` bytes. With a `parent`, every byte it claims is claimed there too. */
export function codexExecGateBudget(limit: number, parent?: CodexExecGateBudget): CodexExecGateBudget {
  let held = 0;
  let closed = false;
  return {
    limit,
    get held() {
      return held;
    },
    take(bytes) {
      if (closed || !Number.isSafeInteger(bytes) || bytes < 0 || held + bytes > limit) return false;
      if (parent && !parent.take(bytes)) return false;
      held += bytes;
      return true;
    },
    give(bytes) {
      const back = Math.min(Math.max(bytes, 0), held);
      held -= back;
      parent?.give(back);
    },
    close() {
      closed = true;
      parent?.give(held);
      held = 0;
    },
  };
}

const PROCESS_BUDGET = codexExecGateBudget(CODEX_EXEC_GATE_PROCESS_BUDGET);

/** Bytes every gate on the shared budget holds right now. Zero once they are all closed. */
export const codexExecGateHeldBytes = (): number => PROCESS_BUDGET.held;

/** A count of directories held open, with a ceiling. */
export interface CodexExecGateDirectories {
  readonly limit: number;
  /** Held open right now, the kept ones included. */
  readonly held: number;
  /** Held open for good: their executor ended before it said the command was over. */
  readonly kept: number;
  /** Count one more. False, and nothing is counted, at the ceiling. */
  take(): boolean;
  /** One was released. */
  give(): void;
  /** One will not be released. It stays counted. */
  keep(): void;
}

export function codexExecGateDirectories(limit: number): CodexExecGateDirectories {
  let held = 0;
  let kept = 0;
  return {
    limit,
    get held() {
      return held;
    },
    get kept() {
      return kept;
    },
    take() {
      if (held >= limit) return false;
      held += 1;
      return true;
    },
    give() {
      if (held > kept) held -= 1;
    },
    keep() {
      if (kept < held) kept += 1;
    },
  };
}

const PROCESS_DIRECTORIES = codexExecGateDirectories(CODEX_EXEC_GATE_DIRECTORY_LIMIT);

/**
 * Directories every gate on the shared count holds open right now. `kept` ones stay open for
 * as long as this process lives.
 */
export const codexExecGateHeldDirectories = (): { held: number; kept: number } => ({
  held: PROCESS_DIRECTORIES.held,
  kept: PROCESS_DIRECTORIES.kept,
});

/** The executor behind the gate, one per connection. */
export interface CodexExecBackend {
  /**
   * Send one message. `flushed` is called once, when the message has left ORCA's memory or
   * was dropped. Throws, without calling it, when the executor is gone.
   */
  send(message: string, flushed: () => void): void;
  /** Hear each message the executor writes. */
  onMessage(listener: (message: string) => void): void;
  /**
   * Hear the executor end, once: only when it has been seen to exit. This, not `stop`
   * returning, is what the gate waits for before it stops counting the connection.
   *
   * The executor's own exit says nothing about the processes it started, or was in the middle
   * of starting: one of those can still be on its way into a directory ORCA holds for it. So
   * `nothingLeft` is true only when the backend can prove that no process the executor
   * started, and no descendant of one, still exists (an executor run as the first process of
   * its own pid namespace, say, where the kernel ends the rest with it). Without that proof
   * the gate keeps every directory the executor had not finished with.
   */
  onExit(listener: (detail: string, nothingLeft?: boolean) => void): void;
  /**
   * Ask it to end and wait, within the backend's own bound. Returning says nothing about
   * whether it is gone: `onExit` does.
   */
  stop(): Promise<void>;
}

/** A directory ORCA holds open, so that what was decided and what is used are one directory. */
export interface CodexExecGateHeldDirectory {
  /** The directory's own path, as the kernel names what the descriptor holds. */
  real: string;
  /** A path that reaches the descriptor itself, for the executor to start in. */
  reach: string;
  release(): void;
}

/** How the gate ties a path to the file the executor will use. */
export interface CodexExecGateBinder {
  /**
   * `path` with every link in it followed, the way an open of it resolves; a part that is
   * not there yet stays as written. Undefined when that cannot be told.
   */
  target(path: string): string | undefined;
  /** The same with the last name kept as it is: the entry a removal takes away. */
  entry(path: string): string | undefined;
  /** Open the directory at `path` and hold it. Undefined when it cannot be held. */
  directory(path: string): CodexExecGateHeldDirectory | undefined;
}

/** The binder for this machine. It holds directories only on Linux, through `/proc`. */
export function codexExecGateBinder(): CodexExecGateBinder {
  return {
    target: (path) => physicalPathOf(path),
    entry(path) {
      const parent = physicalPathOf(dirname(path));
      const name = basename(path);
      return parent === undefined || name === "" ? undefined : join(parent, name);
    },
    directory(path) {
      if (process.platform !== "linux") return undefined;
      let fd: number;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
      } catch {
        return undefined;
      }
      try {
        // The kernel's name for what the descriptor holds, checked to be that same directory.
        const real = readlinkSync(`/proc/self/fd/${fd}`);
        const held = fstatSync(fd, { bigint: true });
        const named = statSync(real, { bigint: true });
        if (!real.startsWith("/") || held.nlink === 0n || held.dev !== named.dev || held.ino !== named.ino)
          throw new Error("the directory has no name");
        let open = true;
        return {
          real,
          reach: `/proc/${process.pid}/fd/${fd}`,
          release() {
            if (!open) return;
            open = false;
            closeSync(fd);
          },
        };
      } catch {
        closeSync(fd);
        return undefined;
      }
    },
  };
}

export interface CodexExecGateOptions {
  /**
   * Decide one call. Only an answer that says `allow: true` in so many words allows it: a
   * rejection, an answer of any other shape, or none within `decisionTimeoutMs` refuses.
   */
  decide: (call: CodexExecGateCall, signal: AbortSignal) => Promise<CodexExecGateDecision>;
  /** Hear each record as it is made. A throw is ignored. */
  onRecord?: ((record: CodexExecGateRecord) => void) | undefined;
  decisionTimeoutMs?: number | undefined;
  /** How long a connection's `initialize` waits for `admit` before it is refused. */
  admissionWaitMs?: number | undefined;
  /** Connections held at once. Codex opens one. */
  maxConnections?: number | undefined;
  /** How paths are tied to files. The default is this machine's. */
  binder?: CodexExecGateBinder | undefined;
  /** The largest message either side may send. */
  messageLimitBytes?: number | undefined;
  /** What one connection may hold at once. At least twice the message limit. */
  connectionBudgetBytes?: number | undefined;
  /** The budget every connection of this gate draws on. The default is shared by the process. */
  budget?: CodexExecGateBudget | undefined;
  /** How long `close` waits for the executors to be gone. */
  closeWaitMs?: number | undefined;
  /** The count of held directories this gate draws on. The default is shared by the process. */
  directories?: CodexExecGateDirectories | undefined;
  /**
   * How long an ended connection waits for its executor to say the commands it left are over
   * before the executor is asked to stop.
   */
  stopWaitMs?: number | undefined;
}

/** What a connection gives the executor it starts. */
export interface CodexExecGateConnection {
  /** The connection's budget: what the executor's side holds for it is claimed here. */
  budget: CodexExecGateBudget;
}

export interface CodexExecGate {
  /** What Codex is given as `CODEX_EXEC_SERVER_URL`. It carries the session's token. */
  readonly url: string;
  /**
   * Open the gate: from now on a connection's `initialize` starts an executor with `start`.
   * Until this is called every connection is refused, so ORCA admits the runtime first.
   */
  admit(start: (connection: CodexExecGateConnection) => CodexExecBackend): void;
  /** Resolves once a connection has been initialized through the gate, or rejects at the deadline. */
  initialized(timeoutMs: number): Promise<void>;
  /** The most recent records, oldest first. */
  records(): readonly CodexExecGateRecord[];
  /**
   * Connections the gate still counts. `stopping` ones have ended but are not gone: their
   * executor has not been seen to exit, a decision made for them has not settled, or bytes
   * held for them have not drained. They count against the connection limit and the budgets.
   */
  connections(): { open: number; stopping: number };
  /**
   * Refuse everything from now on, end every connection and executor, and stop listening.
   * It returns once all of that is gone, or after `closeWaitMs` whatever is left; what is
   * left stays counted (`connections`, the budgets) until it does go. A directory held for a
   * command its executor never said was over is no part of that wait: it stays open, and
   * counted (`codexExecGateHeldDirectories`), after the gate has closed.
   */
  close(): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max)}…`);

/** What the gate knows about one connection: only what it allowed. */
export interface CodexExecGateConnectionState {
  /** Processes this connection was allowed to start, oldest first. */
  processes: Map<string, "open" | "closed">;
  /** The shell the executor reported, read like a system shell. */
  shell?: string | undefined;
}

export const newCodexExecGateConnectionState = (): CodexExecGateConnectionState => ({ processes: new Map() });

/**
 * What to do with one request. `params` is everything the executor is sent as the request's
 * parameters: nothing of the request's own is passed on beside it, and without it the request
 * is sent with none. `effect` is applied only when the request is forwarded. `hold` is a
 * directory held open for it, which whoever asked for the plan releases.
 */
export type CodexExecGatePlan =
  | { action: "refuse"; reason: string; subject?: CodexExecGateSubject }
  | {
      action: "pass" | "decide";
      calls: CodexExecGateCall[];
      subject?: CodexExecGateSubject;
      params?: Record<string, unknown>;
      effect?: (state: CodexExecGateConnectionState) => void;
      hold?: CodexExecGateHeldDirectory;
    };

class Unreadable extends Error {}

/**
 * The absolute path a `file:` URI names, read the way Codex's executor reads it (`PathUri`:
 * a WHATWG URL whose path is percent-decoded). Only the plain form Codex itself writes is
 * accepted: no host, query or fragment, already in canonical spelling, valid UTF-8 once
 * decoded, no encoded separator and no NUL (which also rules out Codex's `file:///%00/bad/path/`
 * form, where the real path hides in base64), and no empty name or trailing slash.
 */
export function codexExecPath(uri: unknown): string {
  if (typeof uri !== "string" || !uri.startsWith("file:///")) throw new Unreadable("a path is not a file: URI");
  if (uri.length > 3 * PATH_LIMIT) throw new Unreadable("a path is too long");
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
  if (path.length > PATH_LIMIT) throw new Unreadable("a path is too long");
  if (path !== "/" && (path.endsWith("/") || path.includes("//"))) throw new Unreadable("a path has an empty name");
  return path;
}

/** The `file:` URI for an absolute path, in the one spelling `codexExecPath` reads back. */
export function codexExecUri(path: string): string {
  let uri: string;
  try {
    uri = pathToFileURL(path).href;
  } catch {
    throw new Unreadable("ORCA could not name a path for the executor");
  }
  if (codexExecPath(uri) !== path) throw new Unreadable("ORCA could not name a path for the executor");
  return uri;
}

const text = (v: unknown, what: string, max: number): string => {
  if (typeof v !== "string" || v === "" || v.length > max) throw new Unreadable(`${what} is missing`);
  return v;
};

const given = (v: unknown): boolean => v !== undefined && v !== null;

/** An optional yes or no: absent and null are the default. */
const flag = (v: unknown, what: string, fallback: boolean): boolean => {
  if (!given(v)) return fallback;
  if (typeof v !== "boolean") throw new Unreadable(`${what} is not a yes or a no`);
  return v;
};

/** An optional count: absent and null are sent as none. */
const count = (v: unknown, what: string): number | null => {
  if (!given(v)) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Unreadable(`${what} is not a count`);
  return v;
};

/**
 * Refuse parameters with a field the gate does not read. The executor is sent the fields the
 * gate read and no other, so one it did not read cannot be dropped quietly either: the
 * request would then mean something else than what was asked.
 */
const only = (p: Record<string, unknown>, what: string, keys: readonly string[]): void => {
  for (const key of Object.keys(p))
    if (!keys.includes(key)) throw new Unreadable(`${what} has a setting ORCA does not pass (${clip(key, 64)})`);
};

/** Bytes written as base64 in the one spelling that decodes to them. */
const base64Bytes = (v: unknown, what: string): Buffer => {
  if (typeof v !== "string") throw new Unreadable(`${what} is missing`);
  const bytes = Buffer.from(v, "base64");
  if (bytes.toString("base64") !== v) throw new Unreadable(`${what} is not base64`);
  return bytes;
};

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Typed bytes as the text a rule is matched against. The policy reads text and the executor
 * is sent bytes, so the two have to be one thing said twice: every byte is kept (a decoder's
 * habit of dropping a leading byte-order mark is turned off), bytes that are not UTF-8 are
 * refused, and so is anything whose text would not write back as the same bytes.
 */
function typedText(bytes: Buffer): string {
  let typed: string;
  try {
    typed = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Unreadable("the typed input is not text");
  }
  if (!Buffer.from(typed, "utf8").equals(bytes))
    throw new Unreadable("the typed input does not read back as the bytes that were sent");
  return typed;
}

const SESSION_ID = /^[0-9A-Za-z-]{1,64}$/;
const CALL_ID = /^[0-9A-Za-z._:|-]{1,256}$/;

/**
 * The environment a request may give a process it starts: each name with the only values
 * ORCA passes. These are what Codex 0.171 itself writes (`UNIFIED_EXEC_ENV` and its own ids).
 * A variable can decide what a command runs (`BASH_ENV`, `PAGER`, `LD_PRELOAD`), and no rule
 * reads the environment, so a name or a value that is not here refuses the start.
 */
const START_ENV: ReadonlyMap<string, RegExp> = new Map([
  ["NO_COLOR", /^1$/],
  ["TERM", /^dumb$/],
  ["LANG", /^C\.UTF-8$/],
  ["LC_CTYPE", /^C\.UTF-8$/],
  ["LC_ALL", /^C\.UTF-8$/],
  ["COLORTERM", /^$/],
  ["PAGER", /^cat$/],
  ["GIT_PAGER", /^cat$/],
  ["GH_PAGER", /^cat$/],
  ["CODEX_CI", /^1$/],
  ["CODEX_SESSION_ID", SESSION_ID],
  ["CODEX_THREAD_ID", SESSION_ID],
  ["CODEX_TOOL_CALL_ID", CALL_ID],
  ["CODEX_VERSION", /^[0-9A-Za-z.+-]{1,64}$/],
  ["CODEX_SANDBOX_NETWORK_DISABLED", /^1$/],
  ["CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS", /^1$/],
]);

const startEnv = (v: unknown, what: string): Record<string, string> => {
  if (!isRecord(v)) throw new Unreadable(`${what} is missing`);
  const env: [string, string][] = [];
  for (const [name, value] of Object.entries(v)) {
    const allowed = START_ENV.get(name);
    if (allowed === undefined || typeof value !== "string" || !allowed.test(value))
      throw new Unreadable(`${what} sets a variable ORCA does not pass (${clip(name, 64)})`);
    env.push([name, value]);
  }
  return Object.fromEntries(env);
};

/** Patterns that choose among the executor's own variables. They add none and set no value. */
const variablePatterns = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.length > 256) throw new Unreadable(`${what} is not a list ORCA can read`);
  return v.map((pattern) => {
    if (typeof pattern !== "string" || !/^[\x21-\x7e]{1,256}$/.test(pattern))
      throw new Unreadable(`${what} is not a list ORCA can read`);
    return pattern;
  });
};

/** Which of the executor's own variables a started process inherits, and what is set over them. */
const envPolicyOf = (v: unknown): Record<string, unknown> | null => {
  if (!given(v)) return null;
  if (!isRecord(v)) throw new Unreadable("the environment policy is not one ORCA can read");
  only(v, "the environment policy", ["inherit", "ignoreDefaultExcludes", "exclude", "set", "includeOnly"]);
  const inherit = v["inherit"];
  if (inherit !== "all" && inherit !== "core" && inherit !== "none")
    throw new Unreadable("the environment policy is not one ORCA can read");
  if (typeof v["ignoreDefaultExcludes"] !== "boolean")
    throw new Unreadable("the environment policy is not one ORCA can read");
  return {
    inherit,
    ignoreDefaultExcludes: v["ignoreDefaultExcludes"],
    exclude: variablePatterns(v["exclude"], "the environment policy's exclusions"),
    set: startEnv(v["set"], "the environment policy"),
    includeOnly: variablePatterns(v["includeOnly"], "the environment policy's inclusions"),
  };
};

/** Codex's own ids for the call. The executor gives them to the process as variables. */
const metadataOf = (v: unknown): { threadId?: string; toolCallId?: string } | undefined => {
  if (!given(v)) return undefined;
  if (!isRecord(v)) throw new Unreadable("the call's ids are not ones ORCA can read");
  only(v, "the call's ids", ["threadId", "toolCallId"]);
  const id = (value: unknown, shape: RegExp): string | undefined => {
    if (!given(value)) return undefined;
    if (typeof value !== "string" || !shape.test(value))
      throw new Unreadable("the call's ids are not ones ORCA can read");
    return value;
  };
  const threadId = id(v["threadId"], SESSION_ID);
  const toolCallId = id(v["toolCallId"], CALL_ID);
  return { ...(threadId !== undefined ? { threadId } : {}), ...(toolCallId !== undefined ? { toolCallId } : {}) };
};

const SANDBOX_KEYS = [
  "permissions",
  "sandboxOverride",
  "cwd",
  "policyContext",
  "workspaceRoots",
  "userHomeDir",
  "temporaryDirectories",
  "windowsSandboxLevel",
  "windowsSandboxProxySettingsMode",
  "useLegacyLandlock",
];
const SANDBOX_PROFILES: Readonly<Record<string, readonly string[]>> = {
  managed: ["type", "file_system", "network"],
  disabled: ["type"],
  external: ["type", "network"],
};
const SANDBOX_OVERRIDES = ["noOverride", "escalatedSandboxWithRestrictions", "bypassSandboxFirstAttempt"];

/**
 * The sandbox Codex names for a request, in the shape the executor is sent.
 *
 * Nothing ORCA decides rests on it: a request is decided as if there were none, and a
 * sandbox only takes away from what the executor would do without one. What the gate does
 * hold it to is agreement. Every directory the sandbox is built around (its working
 * directory, its roots, the home and temporary directories) is resolved by `resolve`, the
 * same way the request's own path was, so the sandbox, the decision and the request the
 * executor is sent name one set of directories. The rules inside `permissions` are Codex's
 * and are passed on as read, under the three kinds of profile the executor knows.
 */
function sandboxOf(
  v: unknown,
  resolve: (path: string) => string | undefined,
): { sandbox: Record<string, unknown> | null; kind: string } {
  if (!given(v)) return { sandbox: null, kind: "none" };
  const unreadable = (): never => {
    throw new Unreadable("the sandbox is not one ORCA can pass on");
  };
  if (!isRecord(v)) return unreadable();
  only(v, "the sandbox", SANDBOX_KEYS);
  const permissions = v["permissions"];
  if (!isRecord(permissions)) return unreadable();
  const kind = permissions["type"];
  if (typeof kind !== "string" || !Object.hasOwn(SANDBOX_PROFILES, kind)) return unreadable();
  only(permissions, "the sandbox's permissions", SANDBOX_PROFILES[kind]!);
  const directory = (uri: unknown): string => {
    const resolved = resolve(codexExecPath(uri));
    if (resolved === undefined) throw new Unreadable("ORCA could not tell which directory the sandbox names");
    return codexExecUri(resolved);
  };
  const directories = (list: unknown): string[] => {
    if (!Array.isArray(list) || list.length > 64) return unreadable();
    return list.map(directory);
  };
  const sandbox: Record<string, unknown> = { permissions };
  const override = v["sandboxOverride"];
  if (override !== undefined) {
    if (typeof override !== "string" || !SANDBOX_OVERRIDES.includes(override)) return unreadable();
    sandbox["sandboxOverride"] = override;
  }
  if (given(v["cwd"])) sandbox["cwd"] = directory(v["cwd"]);
  const context = v["policyContext"];
  if (given(context)) {
    if (!isRecord(context)) return unreadable();
    only(context, "the sandbox's context", ["cwd", "workspaceRoots"]);
    sandbox["policyContext"] = {
      ...(given(context["cwd"]) ? { cwd: directory(context["cwd"]) } : {}),
      workspaceRoots: context["workspaceRoots"] === undefined ? [] : directories(context["workspaceRoots"]),
    };
  }
  if (v["workspaceRoots"] !== undefined) sandbox["workspaceRoots"] = directories(v["workspaceRoots"]);
  if (given(v["userHomeDir"])) sandbox["userHomeDir"] = directory(v["userHomeDir"]);
  if (given(v["temporaryDirectories"])) sandbox["temporaryDirectories"] = directories(v["temporaryDirectories"]);
  // The gate holds a process to a directory only on Linux, so a sandbox for another system is not one to pass.
  if (v["windowsSandboxLevel"] !== "disabled") return unreadable();
  sandbox["windowsSandboxLevel"] = "disabled";
  const proxy = v["windowsSandboxProxySettingsMode"];
  if (given(proxy)) {
    if (proxy !== "reconcile" && proxy !== "preserve") return unreadable();
    sandbox["windowsSandboxProxySettingsMode"] = proxy;
  }
  sandbox["useLegacyLandlock"] = flag(v["useLegacyLandlock"], "useLegacyLandlock", false);
  return { sandbox, kind };
}

/** What `initialize` is sent on with: who is connecting, and a session to pick up again if it names one. */
function initializeParams(params: unknown): Record<string, unknown> {
  const p = isRecord(params) ? params : {};
  only(p, "the request", ["clientName", "resumeSessionId"]);
  const resume = p["resumeSessionId"];
  if (given(resume) && (typeof resume !== "string" || !SESSION_ID.test(resume)))
    throw new Unreadable("the session to resume is not one ORCA can read");
  return {
    clientName: text(p["clientName"], "clientName", ID_LIMIT),
    ...(typeof resume === "string" ? { resumeSessionId: resume } : {}),
  };
}

/** A trace context is telemetry: passed on when it is well formed, left out when it is not. */
function traceOf(trace: unknown): { trace: Record<string, string> } | undefined {
  if (!isRecord(trace)) return undefined;
  const parent = trace["traceparent"];
  const state = trace["tracestate"];
  const out: Record<string, string> = {};
  if (typeof parent === "string" && /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(parent))
    out["traceparent"] = parent;
  if (typeof state === "string" && /^[\x20-\x7e]{1,512}$/.test(state)) out["tracestate"] = state;
  return Object.keys(out).length > 0 ? { trace: out } : undefined;
}

/** File requests the executor cannot be held to one file for, and what they would need. */
const UNBOUND_FILE_REQUESTS = new Set([
  "fs/open",
  "fs/readBlock",
  "fs/writeBlock",
  "fs/close",
  "fs/copy",
  "fs/readDirectory",
  "fs/walk",
  "fs/canonicalize",
  "fs/watchMissing",
]);

/** Every field of a `process/start` in Codex 0.171's protocol. One that is not here refuses the start. */
const START_KEYS = [
  "processId",
  "metadata",
  "argv",
  "cwd",
  "envPolicy",
  "shellSnapshot",
  "env",
  "tty",
  "pipeStdin",
  "arg0",
  "sandbox",
  "enforceManagedNetwork",
  "managedNetwork",
  "networkProxy",
];
/** Fields that ask the executor to run or reach something no rule reads. Present, they refuse the start. */
const START_NOT_PASSED = ["shellSnapshot", "managedNetwork", "networkProxy"];

/**
 * Decide what one request needs. It reads the parameters and the connection's state and
 * changes neither; for a `process/start` it holds the starting directory open and hands the
 * hold back in the plan. Anything it cannot read the way the executor would is refused.
 */
export function planCodexExecRequest(
  method: string,
  params: unknown,
  state: CodexExecGateConnectionState,
  binder: CodexExecGateBinder = codexExecGateBinder(),
): CodexExecGatePlan {
  try {
    return plan(method, isRecord(params) ? params : {}, state, binder);
  } catch (error) {
    if (error instanceof Unreadable)
      return { action: "refuse", reason: `ORCA could not read the request (${error.message})` };
    throw error;
  }
}

function plan(
  method: string,
  p: Record<string, unknown>,
  state: CodexExecGateConnectionState,
  binder: CodexExecGateBinder,
): CodexExecGatePlan {
  const knownProcess = (): string => {
    const processId = text(p["processId"], "processId", ID_LIMIT);
    if (!state.processes.has(processId)) throw new Unreadable("it names a process ORCA did not allow");
    return processId;
  };
  /** One file request: decided on the path the executor is sent, and on the path as written. */
  const file = (
    kind: acp.ToolKind,
    verb: string,
    resolve: "target" | "entry",
    more: Record<string, unknown> = {},
    check: CodexExecGateCall["check"] = "policy",
    subject: CodexExecGateSubject = {},
  ): CodexExecGatePlan => {
    only(p, "the request", ["path", "followSymlinks", "sandbox", ...Object.keys(more)]);
    const written = codexExecPath(p["path"]);
    // A request that already says "follow no link" is held to its own words.
    const bound = flag(p["followSymlinks"], "followSymlinks", true) ? binder[resolve](written) : written;
    if (bound === undefined) throw new Unreadable("ORCA could not tell which file a path names");
    const sandbox = sandboxOf(p["sandbox"], (path) => binder.target(path));
    const title = `${verb} ${bound}`;
    return {
      action: "decide",
      calls: [
        {
          method,
          check,
          toolCall: { title, kind, locations: [{ path: bound }] },
          ...(bound !== written ? { asWritten: { title: `${verb} ${written}`, locations: [{ path: written }] } } : {}),
        },
      ],
      subject: {
        kind,
        title,
        paths: [bound],
        ...(bound !== written ? { written: [written] } : {}),
        ...subject,
        sandbox: sandbox.kind,
      },
      params: { path: codexExecUri(bound), ...more, followSymlinks: false, sandbox: sandbox.sandbox },
    };
  };

  switch (method) {
    case "environment/info":
    case "environment/status":
      // Sent with no parameters, as Codex sends them.
      only(p, "the request", []);
      return { action: "pass", calls: [] };

    case "process/start": {
      only(p, "the start", START_KEYS);
      const processId = text(p["processId"], "processId", ID_LIMIT);
      if (state.processes.has(processId)) throw new Unreadable("the process id is already in use");
      if (state.processes.size >= TRACKED_LIMIT && ![...state.processes.values()].includes("closed"))
        throw new Unreadable("too many processes on this connection");
      const argv = p["argv"];
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((w): w is string => typeof w === "string"))
        throw new Unreadable("argv is missing");
      const written = codexExecPath(p["cwd"]);
      const arg0 = p["arg0"];
      if (given(arg0) && (typeof arg0 !== "string" || arg0.length > PATH_LIMIT))
        throw new Unreadable("arg0 is not text");
      for (const name of START_NOT_PASSED)
        if (given(p[name])) throw new Unreadable(`the start asks for something ORCA does not pass (${name})`);
      const metadata = metadataOf(p["metadata"]);
      const toolCallId = metadata?.toolCallId;
      const envPolicy = envPolicyOf(p["envPolicy"]);
      const env = startEnv(p["env"], "the start's environment");
      if (typeof p["tty"] !== "boolean") throw new Unreadable("tty is not a yes or a no");
      const tty = p["tty"];
      const pipeStdin = flag(p["pipeStdin"], "pipeStdin", false);
      const enforceManagedNetwork = flag(p["enforceManagedNetwork"], "enforceManagedNetwork", false);
      // `[shell, -c, script]` under a shell ORCA knows is the script, which is what a rule's
      // title matches and what the hook sees. Any other shape, a shell at a path the model
      // chose, or a process started under another name is decided as the whole command line.
      const wrapped =
        argv.length === 3 &&
        (SYSTEM_SHELLS.has(argv[0]!) || argv[0] === state.shell) &&
        /^-l?c$/.test(argv[1]!) &&
        (!given(arg0) || arg0 === argv[0]);
      const rendered = argv.map(quoteWord).join(" ");
      const title = wrapped ? argv[2]! : typeof arg0 === "string" ? `${rendered} (as ${quoteWord(arg0)})` : rendered;
      // Last, so that nothing above can fail with the directory held.
      const hold = binder.directory(written);
      if (hold === undefined) throw new Unreadable("ORCA could not hold the directory the command would start in");
      let params: Record<string, unknown>;
      let sandboxed: string;
      try {
        // A sandbox built around the directory the process starts in is built around the one held.
        const sandbox = sandboxOf(p["sandbox"], (path) => (path === written ? hold.real : binder.target(path)));
        sandboxed = sandbox.kind;
        // The whole of what the executor is sent: each field read above, and no other.
        params = {
          processId,
          ...(metadata !== undefined ? { metadata } : {}),
          argv,
          cwd: codexExecUri(hold.reach),
          envPolicy,
          env,
          tty,
          pipeStdin,
          arg0: typeof arg0 === "string" ? arg0 : null,
          sandbox: sandbox.sandbox,
          enforceManagedNetwork,
          managedNetwork: null,
        };
      } catch (error) {
        hold.release();
        throw error;
      }
      return {
        action: "decide",
        calls: [
          {
            method,
            check: "policy",
            toolCall: { title, kind: "execute", locations: [] },
            cwd: hold.real,
            ...(hold.real !== written ? { asWritten: { title, locations: [], cwd: written } } : {}),
            toolCallId,
          },
        ],
        subject: {
          kind: "execute",
          title: clip(title, 2048),
          argv: argv.slice(0, 16).map((word) => clip(word, 1024)),
          argvSha256: sha256(JSON.stringify(argv)),
          cwd: hold.real,
          ...(hold.real !== written ? { written: [written] } : {}),
          processId,
          ...(toolCallId !== undefined ? { toolCallId: clip(toolCallId, 256) } : {}),
          sandbox: sandboxed,
        },
        params,
        effect: (s) => {
          if (s.processes.size >= TRACKED_LIMIT)
            for (const [id, status] of s.processes)
              if (status === "closed") {
                s.processes.delete(id);
                break;
              }
          s.processes.set(processId, "open");
        },
        hold,
      };
    }

    case "process/read": {
      only(p, "the request", ["processId", "afterSeq", "maxBytes", "waitMs"]);
      const processId = knownProcess();
      return {
        action: "pass",
        calls: [],
        subject: { processId },
        params: {
          processId,
          afterSeq: count(p["afterSeq"], "afterSeq"),
          maxBytes: count(p["maxBytes"], "maxBytes"),
          waitMs: count(p["waitMs"], "waitMs"),
        },
      };
    }

    case "process/signal": {
      only(p, "the request", ["processId", "signal"]);
      const processId = knownProcess();
      // The one signal the protocol has. It only ever stops what was already allowed.
      if (p["signal"] !== "interrupt") throw new Unreadable("the signal is not one ORCA passes");
      return { action: "pass", calls: [], subject: { processId }, params: { processId, signal: "interrupt" } };
    }

    case "process/terminate": {
      only(p, "the request", ["processId"]);
      const processId = knownProcess();
      return { action: "pass", calls: [], subject: { processId }, params: { processId } };
    }

    case "process/write": {
      only(p, "the request", ["processId", "chunk", "writeId"]);
      const processId = knownProcess();
      const bytes = base64Bytes(p["chunk"], "the typed input");
      // The executor is sent the bytes that were read, written out again from them.
      const params = { processId, chunk: bytes.toString("base64"), writeId: text(p["writeId"], "writeId", ID_LIMIT) };
      // Only a write of nothing passes undecided. Every byte typed is data, whatever it is
      // meant to do: the gate cannot tell a Ctrl-C a terminal will act on from the same byte
      // read by a program as input. An interrupt has its own request, `process/signal`.
      if (bytes.length === 0) return { action: "pass", calls: [], subject: { processId, bytes: bytes.length }, params };
      const digest = sha256(bytes);
      return {
        action: "decide",
        calls: [
          {
            method,
            check: "policy",
            typedInput: { bytes: bytes.length, sha256: digest },
            toolCall: { title: `write_stdin: ${JSON.stringify(typedText(bytes))}`, kind: "execute", locations: [] },
          },
        ],
        subject: { kind: "execute", processId, bytes: bytes.length, sha256: digest },
        params,
      };
    }

    case "fs/readFile":
      return file("read", "Read", "target");

    case "fs/writeFile": {
      const bytes = base64Bytes(p["dataBase64"], "the file's contents");
      return file("edit", "Edit", "target", { dataBase64: p["dataBase64"] }, "policy", {
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }

    case "fs/createDirectory":
      // One directory, whatever was asked: the ones a recursive create would add above it
      // were never decided.
      flag(p["recursive"], "recursive", false);
      return file("edit", "Create directory", "target", { recursive: false });

    case "fs/remove":
      if (flag(p["recursive"], "recursive", false))
        return { action: "refuse", reason: "ORCA does not pass the removal of a whole directory tree" };
      return file("delete", "Delete", "entry", { recursive: false, force: flag(p["force"], "force", false) });

    case "fs/getMetadata":
      return file("read", "Look up", "target", {}, "protected");

    default:
      if (UNBOUND_FILE_REQUESTS.has(method))
        return {
          action: "refuse",
          reason: `ORCA does not pass \`${method}\`: the executor cannot be held to the files ORCA decided for it`,
        };
      return { action: "refuse", reason: `ORCA does not pass the executor request \`${clip(method, 80)}\`` };
  }
}

const refusal = (reason: string): string =>
  reason.startsWith("Blocked by ORCA") || reason.startsWith("Denied by ORCA") ? reason : `Blocked by ORCA: ${reason}.`;

const NOT_CHECKED: CodexExecGateDecision = { allow: false, basis: "gate", reason: "ORCA could not check this call" };

/** A decision read strictly: only `allow: true` with a basis allows, and only a full refusal explains itself. */
function decisionOf(value: unknown): CodexExecGateDecision {
  if (!isRecord(value)) return NOT_CHECKED;
  const basis = value["basis"];
  if (typeof basis !== "string" || basis === "") return NOT_CHECKED;
  if (value["allow"] === true) return { allow: true, basis };
  const reason = value["reason"];
  if (value["allow"] === false && typeof reason === "string" && reason !== "") return { allow: false, basis, reason };
  return NOT_CHECKED;
}

const OVER_BUDGET = "the connection would hold more than ORCA's gate keeps for one";

/**
 * Open the gate on a loopback port. It refuses every connection until `admit` is called, and
 * every request it does not allow after that.
 */
export async function openCodexExecGate(options: CodexExecGateOptions): Promise<CodexExecGate> {
  const token = randomBytes(32).toString("base64url");
  const wanted = createHash("sha256").update(`/${token}`).digest();
  const decisionTimeoutMs = options.decisionTimeoutMs ?? DECISION_TIMEOUT_MS;
  const admissionWaitMs = options.admissionWaitMs ?? ADMISSION_WAIT_MS;
  const maxConnections = options.maxConnections ?? 2;
  const binder = options.binder ?? codexExecGateBinder();
  const messageLimit = options.messageLimitBytes ?? CODEX_EXEC_GATE_MESSAGE_LIMIT;
  const connectionBudget = Math.max(options.connectionBudgetBytes ?? 4 * messageLimit, 2 * messageLimit);
  const gateBudget = options.budget ?? PROCESS_BUDGET;
  const closeWaitMs = options.closeWaitMs ?? CLOSE_WAIT_MS;
  const directories = options.directories ?? PROCESS_DIRECTORIES;
  const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;

  let seq = 0;
  let connectionSeq = 0;
  let closed = false;
  let startBackend: ((connection: CodexExecGateConnection) => CodexExecBackend) | undefined;
  let admitted: (() => void) | undefined;
  const admission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  let initializedOnce = false;
  const initializedWaiters = new Set<() => void>();
  const kept: { record: CodexExecGateRecord; bytes: number }[] = [];
  let keptBytes = 0;
  /** Every connection still counted: open ones, and ended ones not yet gone. */
  const live = new Set<{ end: (reason: string) => void; gone: () => Promise<void>; ended: () => boolean }>();

  const record = (entry: Omit<CodexExecGateRecord, "seq" | "at">): void => {
    const made: CodexExecGateRecord = {
      seq: ++seq,
      at: new Date().toISOString(),
      ...entry,
      method: clip(entry.method, 80),
      basis: clip(entry.basis, 256),
      ...(entry.reason !== undefined ? { reason: clip(entry.reason, 1024) } : {}),
    };
    // Two bytes a character is the most a string costs in memory.
    const bytes = 2 * JSON.stringify(made).length;
    kept.push({ record: made, bytes });
    keptBytes += bytes;
    while (kept.length > RECORD_LIMIT || (keptBytes > RECORD_BYTES && kept.length > 1))
      keptBytes -= kept.shift()!.bytes;
    try {
      options.onRecord?.(made);
    } catch {
      // A listener's failure changes nothing the gate decides.
    }
  };

  const server = createServer((_request, response) => {
    response.writeHead(404, { connection: "close" }).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: messageLimit, perMessageDeflate: false });

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
    // The message the websocket assembles is held before the gate sees it, so it is claimed up front.
    const budget = codexExecGateBudget(connectionBudget, gateBudget);
    if (!budget.take(messageLimit))
      return turnAway(socket, "503 Service Unavailable", "ORCA's gates hold too much to take another connection");
    // A handshake that fails after this point never becomes a connection, and holds nothing.
    let upgraded = false;
    socket.once("close", () => {
      if (!upgraded) budget.close();
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      upgraded = true;
      connect(ws, budget);
    });
  });

  /**
   * One decision, bounded in time and ended early when the connection is (`ended`). `keep`
   * claims the request's bytes for as long as `decide` itself has not settled: a decision the
   * gate stopped waiting for can still be running, with the call in its hands.
   */
  const decideBounded = async (
    call: CodexExecGateCall,
    ended: AbortSignal,
    keep: () => () => void,
  ): Promise<CodexExecGateDecision> => {
    if (ended.aborted) return NOT_CHECKED;
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    ended.addEventListener("abort", stop, { once: true });
    const settled = keep();
    const decided = Promise.resolve().then(() => options.decide(call, controller.signal));
    decided.then(settled, settled);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return decisionOf(
        await Promise.race([
          decided,
          new Promise<CodexExecGateDecision>((resolve) => {
            timer = setTimeout(
              () => resolve({ allow: false, basis: "gate", reason: "ORCA could not decide this call in time" }),
              decisionTimeoutMs,
            );
            controller.signal.addEventListener("abort", () => resolve(NOT_CHECKED), { once: true });
          }),
        ]),
      );
    } catch {
      return NOT_CHECKED;
    } finally {
      clearTimeout(timer);
      ended.removeEventListener("abort", stop);
      controller.abort();
    }
  };

  function connect(ws: WebSocket, budget: CodexExecGateBudget): void {
    const connection = ++connectionSeq;
    const state = newCodexExecGateConnectionState();
    const idKey = (id: string | number): string => `${typeof id}:${id}`;
    /** Ids of requests the executor sent the client; only these may be answered. */
    const asked = new Set<string>();
    /** Ids of requests passed to the executor and not answered yet. */
    const pending = new Set<string>();
    /** Directories held for a `process/start` the executor has not answered yet, by request id. */
    const starting = new Map<string, { hold: CodexExecGateHeldDirectory; processId: string; over?: boolean }>();
    /** Directories held for a process the executor started and has not said is over, by process id. */
    const running = new Map<string, CodexExecGateHeldDirectory>();
    let stopAsked = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let ownRequests = 0;
    let backend: CodexExecBackend | undefined;
    /** False from the moment an executor is started until it has been seen to exit. */
    let backendGone = true;
    let socketClosed = false;
    let initializeId: string | number | undefined;
    let ready = false;
    let ended = false;
    let gone = false;
    let queued = 0;
    let chain: Promise<void> = Promise.resolve();
    const ending = new AbortController();
    let resolveGone: (() => void) | undefined;
    const whenGone = new Promise<void>((resolve) => {
      resolveGone = resolve;
    });

    /**
     * The connection is gone, and stops being counted, only when nothing is left of it: the
     * socket has closed, the executor has been seen to exit, and every claim on the budget
     * has been returned by what it stood for. Until then it holds its place and its bytes.
     */
    const settle = (): void => {
      if (!ended || gone || !socketClosed || !backendGone || budget.held > 0) return;
      gone = true;
      budget.close();
      live.delete(entry);
      resolveGone?.();
    };

    const end = (reason: string): void => {
      if (ended) return;
      ended = true;
      record({ connection, method: "connection", outcome: "closed", basis: "gate", reason });
      // A decision still being made is told to stop; its bytes stay claimed until it has.
      ending.abort();
      ws.terminate();
      if (backend !== undefined && !backendGone) {
        if (starting.size + running.size === 0) stopExecutor();
        else {
          // A directory is let go only on the executor's own word that its command is over.
          // So the commands this connection left are ended through the executor first, and
          // it is given a bounded time to say so before it is asked to stop.
          for (const processId of running.keys()) terminate(processId);
          stopTimer = setTimeout(stopExecutor, stopWaitMs);
        }
      }
      settle();
    };
    const entry = { end, gone: () => whenGone, ended: () => ended };
    live.add(entry);
    record({ connection, method: "connection", outcome: "opened", basis: "gate" });

    /**
     * Claim bytes for this connection until the returned function is called. Once it has
     * ended only the gate's own last words to the executor (`late`) may claim.
     */
    const claim = (bytes: number, late = false): (() => void) | undefined => {
      if ((ended && !late) || !budget.take(bytes)) return undefined;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        budget.give(bytes);
        settle();
      };
    };
    /** What the executor's side claims for this connection, counted with the rest. */
    const backendBudget: CodexExecGateBudget = {
      limit: budget.limit,
      get held() {
        return budget.held;
      },
      take: (bytes) => budget.take(bytes),
      give(bytes) {
        budget.give(bytes);
        settle();
      },
      close: () => undefined,
    };

    /**
     * Ask the executor to stop, once. Asking frees nothing: bytes not yet in its pipe stay
     * claimed until it is seen to exit, and a directory until it says the command is over.
     */
    const stopExecutor = (): void => {
      if (stopAsked || backend === undefined || backendGone) return;
      stopAsked = true;
      clearTimeout(stopTimer);
      const stopping = backend;
      Promise.resolve()
        .then(() => stopping.stop())
        .catch(() => undefined);
    };
    /** The executor said this command is over, so nothing it started is still entering the directory. */
    const letGo = (hold: CodexExecGateHeldDirectory): void => {
      hold.release();
      directories.give();
      if (ended && starting.size + running.size === 0) stopExecutor();
    };
    /** End a command an ended connection left running. This is the gate's own request, and its answer is not passed on. */
    const terminate = (processId: string): void => {
      if (backend === undefined || backendGone) return;
      let id: string;
      do id = `orca-gate:${++ownRequests}`;
      while (starting.has(idKey(id)));
      const data = JSON.stringify({ id, method: "process/terminate", params: { processId } });
      const release = claim(Buffer.byteLength(data), true);
      if (release === undefined) return;
      try {
        backend.send(data, release);
      } catch {
        release();
      }
    };
    /**
     * What the executor says about a command decides how long its directory is held. An error
     * answer to the start says nothing was started. An answer that it started is too early to
     * let go: Codex's sandbox helper reads the directory again after it. Word that the process
     * exited or closed is the end of it.
     */
    const heard = (message: Record<string, unknown>): void => {
      const id = message["id"];
      const method = message["method"];
      if (typeof method !== "string" && (typeof id === "string" || typeof id === "number")) {
        const started = starting.get(idKey(id));
        if (started === undefined) return;
        starting.delete(idKey(id));
        if (isRecord(message["error"]) && message["result"] === undefined) return letGo(started.hold);
        if (isRecord(message["result"]) && message["error"] === undefined && !running.has(started.processId)) {
          // A quick command can be reported over before its start is answered.
          if (started.over === true) return letGo(started.hold);
          running.set(started.processId, started.hold);
          if (ended) terminate(started.processId);
          return;
        }
        // An answer that says neither: the gate cannot tell what became of the start.
        return keepForGood(started.hold);
      }
      if (
        id === undefined &&
        (method === "process/exited" || method === "process/closed") &&
        isRecord(message["params"])
      ) {
        const processId = message["params"]["processId"];
        if (typeof processId !== "string") return;
        const hold = running.get(processId);
        if (hold === undefined) {
          for (const entry of starting.values()) if (entry.processId === processId) entry.over = true;
          return;
        }
        running.delete(processId);
        letGo(hold);
      }
    };
    /** No word that the command is over will come, so the directory stays open and counted. */
    const keepForGood = (_hold: CodexExecGateHeldDirectory): void => {
      directories.keep();
      if (ended && starting.size + running.size === 0) stopExecutor();
    };

    const reply = (message: unknown): void => {
      if (ended) return;
      const data = typeof message === "string" ? message : JSON.stringify(message);
      const release = claim(Buffer.byteLength(data));
      if (release === undefined) return end(OVER_BUDGET);
      ws.send(data, release);
    };
    const refuse = (
      id: string | number,
      method: string,
      basis: string,
      reason: string,
      subject?: CodexExecGateSubject,
    ): void => {
      record({ connection, method, id, outcome: "refused", basis, reason, ...(subject ? { subject } : {}) });
      reply({ id, error: { code: REFUSED, message: clip(refusal(reason), 2048) } });
    };
    // The executor is sent what the gate built: the id, the method, the parameters the plan
    // gave (or none), and a trace context. Nothing of the message itself is passed on.
    const requestOf = (
      id: string | number,
      method: string,
      message: Record<string, unknown>,
      params?: Record<string, unknown>,
    ) => ({ id, method, ...(params !== undefined ? { params } : {}), ...traceOf(message["trace"]) });
    const forward = (message: Record<string, unknown>): boolean => {
      const data = JSON.stringify(message);
      const release = claim(Buffer.byteLength(data));
      if (release === undefined) {
        end(OVER_BUDGET);
        return false;
      }
      try {
        backend!.send(data, release);
        return true;
      } catch {
        release();
        end("the executor behind the gate is gone");
        return false;
      }
    };

    const fromBackend = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return end("the executor behind the gate sent something that is not JSON");
      }
      // Heard after the connection has ended too: it is what lets go of a directory.
      if (isRecord(message)) heard(message);
      if (ended) return;
      if (isRecord(message)) {
        const id = message["id"];
        const hasId = typeof id === "string" || typeof id === "number";
        const method = message["method"];
        if (typeof method === "string" && hasId) {
          if (asked.size >= ASKED_LIMIT) return end("the executor behind the gate asked more than the agent answered");
          asked.add(idKey(id));
        } else if (typeof method !== "string" && hasId) {
          pending.delete(idKey(id));
        } else if (method === "process/closed" && isRecord(message["params"])) {
          const processId = message["params"]["processId"];
          if (typeof processId === "string" && state.processes.has(processId)) state.processes.set(processId, "closed");
        }
        if (!ready && initializeId !== undefined && id === initializeId && isRecord(message["result"])) {
          ready = true;
          const info = message["result"]["environmentInfo"];
          const shell = isRecord(info) && isRecord(info["shell"]) ? info["shell"]["path"] : undefined;
          if (typeof shell === "string" && shell.startsWith("/") && shell.length <= PATH_LIMIT) state.shell = shell;
          initializedOnce = true;
          for (const wake of initializedWaiters) wake();
        }
      }
      reply(line);
    };

    const initialize = async (id: string | number, message: Record<string, unknown>): Promise<void> => {
      let params: Record<string, unknown>;
      try {
        params = initializeParams(message["params"]);
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        return refuse(id, "initialize", "gate", `ORCA could not read the request (${error.message})`);
      }
      if (startBackend === undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          admission,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, admissionWaitMs);
            ending.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        clearTimeout(timer);
      }
      if (ended) return;
      if (startBackend === undefined || closed)
        return refuse(id, "initialize", "gate", "ORCA has not admitted this session's runtime");
      try {
        backend = startBackend({ budget: backendBudget });
      } catch {
        refuse(id, "initialize", "gate", "ORCA could not start the executor behind its gate");
        return end("the executor behind the gate did not start");
      }
      backendGone = false;
      backend.onMessage(fromBackend);
      backend.onExit((detail, nothingLeft) => {
        backendGone = true;
        clearTimeout(stopTimer);
        // The executor will say nothing more. Its exit alone does not show that a command it
        // was starting, or had started, is done with its directory: a child can still be on
        // its way in, by the name the gate gave. So what is still held is let go only when
        // the backend proves nothing of the executor's is left, and is otherwise kept open
        // for as long as this process lives, where the name can never come to mean another
        // directory.
        const left = [...[...starting.values()].map((entry) => entry.hold), ...running.values()];
        starting.clear();
        running.clear();
        for (const hold of left) {
          if (nothingLeft === true) letGo(hold);
          else keepForGood(hold);
        }
        if (left.length > 0 && nothingLeft !== true)
          record({
            connection,
            method: "connection",
            outcome: "kept",
            basis: "gate",
            reason: `the executor ended before it said ${left.length} command(s) were over; their directories stay held`,
          });
        end(`the executor behind the gate ended (${detail})`);
        settle();
      });
      if (ended) return;
      initializeId = id;
      if (forward(requestOf(id, "initialize", message, params))) {
        pending.add(idKey(id));
        record({ connection, method: "initialize", id, outcome: "forwarded", basis: "pass" });
      }
    };

    const request = async (
      method: string,
      id: string | number,
      message: Record<string, unknown>,
      keep: () => () => void,
    ): Promise<void> => {
      // An id still in use would let one answer stand for two requests.
      if (pending.has(idKey(id))) return end("the agent used a request id twice");
      if (backend === undefined) {
        if (method === "initialize") return initialize(id, message);
        return refuse(id, method, "gate", "the connection has not been initialized through ORCA");
      }
      if (method === "initialize") return refuse(id, method, "gate", "the connection is already initialized");
      if (!ready) return refuse(id, method, "gate", "the executor behind the gate has not answered yet");
      if (pending.size >= PENDING_LIMIT)
        return refuse(id, method, "gate", "too many requests are waiting for the executor behind the gate");
      if (method === "process/start" && starting.size + running.size >= HELD_LIMIT)
        return refuse(id, method, "gate", "too many commands are running or starting behind the gate");
      const planned = planCodexExecRequest(method, message["params"], state, binder);
      if (planned.action === "refuse") return refuse(id, method, "gate", planned.reason, planned.subject);
      // The executor drops a start it is asked to end before it has answered, with the process
      // already on its way. Nothing reaches a process until the executor says it started.
      const about = planned.subject?.processId;
      if (method !== "process/start" && about !== undefined)
        for (const entry of starting.values())
          if (entry.processId === about)
            return refuse(id, method, "gate", "the command has not started yet", planned.subject);
      // Counted from here until it is released, or for good.
      if (planned.hold !== undefined && !directories.take()) {
        planned.hold.release();
        return refuse(id, method, "gate", "ORCA's gates hold too many directories to start another command");
      }
      let passed = false;
      try {
        let basis = "pass";
        for (const call of planned.calls) {
          const decision = await decideBounded(call, ending.signal, keep);
          if (ended) return;
          if (decision.allow !== true) return refuse(id, method, decision.basis, decision.reason, planned.subject);
          basis = decision.basis;
        }
        if (!forward(requestOf(id, method, message, planned.params))) return;
        passed = true;
        pending.add(idKey(id));
        if (planned.hold) starting.set(idKey(id), { hold: planned.hold, processId: about ?? "" });
        planned.effect?.(state);
        record({
          connection,
          method,
          id,
          outcome: "forwarded",
          basis,
          ...(planned.subject ? { subject: planned.subject } : {}),
        });
      } finally {
        // Never sent, so the executor never heard of the directory.
        if (!passed && planned.hold !== undefined) {
          planned.hold.release();
          directories.give();
        }
      }
    };

    const handle = async (data: string, keep: () => () => void): Promise<void> => {
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
      const hasId =
        (typeof id === "string" && id.length <= ID_LIMIT) || (typeof id === "number" && Number.isSafeInteger(id));
      if (typeof method === "string") {
        if (hasId) return request(method, id, message, keep);
        if (id !== undefined && id !== null) return end("the agent sent a request with an id ORCA cannot answer");
        // A notification has no answer to refuse it with, so one ORCA does not know is dropped.
        if (method === "initialized" && backend !== undefined && ready) {
          if (forward({ method })) record({ connection, method, outcome: "forwarded", basis: "pass" });
          return;
        }
        return record({
          connection,
          method,
          outcome: "dropped",
          basis: "gate",
          reason: "a notification ORCA does not pass",
        });
      }
      if (hasId && ("result" in message || "error" in message) && backend !== undefined) {
        // An answer goes through only to a question the executor asked, and only once.
        if (asked.delete(idKey(id))) {
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
      const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      // Held as it arrived until its turn; it is parsed only then, one message at a time.
      const release = claim(frame.length);
      if (release === undefined) return end(OVER_BUDGET);
      // The frame's bytes are returned when its turn is over and every decision made for it
      // has settled, whichever is later.
      let users = 1;
      const done = (): void => {
        if (--users === 0) release();
      };
      const keep = (): (() => void) => {
        users++;
        let open = true;
        return () => {
          if (!open) return;
          open = false;
          done();
        };
      };
      // One at a time, in the order they arrived: a request is decided before the next is read.
      chain = chain
        .then(() => handle(frame.toString("utf8"), keep))
        .catch(() => end("ORCA's gate failed"))
        .finally(() => {
          queued--;
          done();
        });
    });
    ws.on("close", () => {
      // The socket is gone, and with it the message it was assembling.
      if (!socketClosed) {
        socketClosed = true;
        budget.give(messageLimit);
      }
      end("the agent closed the connection");
      settle();
    });
    ws.on("error", (error: Error & { code?: string }) =>
      end(
        error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
          ? "the agent sent a message over the size limit"
          : "the connection failed",
      ),
    );
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
    records: () => kept.map((entry) => entry.record),
    connections() {
      let stopping = 0;
      for (const connection of live) if (connection.ended()) stopping++;
      return { open: live.size - stopping, stopping };
    },
    async close() {
      if (closed) return;
      closed = true;
      const ending = [...live];
      for (const connection of ending) connection.end("the gate closed");
      wss.close();
      const listening = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      server.closeAllConnections();
      // The caller is held for a bounded time. A connection that is not gone by then is not
      // let go of: it stays counted, with what it holds, until it is.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(ending.map((connection) => connection.gone())),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, closeWaitMs);
        }),
      ]);
      clearTimeout(timer);
      await listening;
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
  /** The connection's budget: a message the executor has only partly written is claimed here. */
  budget?: CodexExecGateBudget | undefined;
  /** The longest message the executor may write. */
  messageLimitBytes?: number | undefined;
}

/**
 * Start `codex exec-server --listen stdio` as ORCA's own direct child and speak its
 * line-delimited JSON. `stop` closes its input, then signals that one child, and only while
 * it has not been reaped: nothing is looked up by pid or by group. `stop` gives up after its
 * last wait whether or not the child went; `onExit` is heard only once the child has exited.
 * It never says `nothingLeft`: seeing one child exit proves nothing about what that child
 * started.
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
  const messageLimit = spec.messageLimitBytes ?? CODEX_EXEC_GATE_MESSAGE_LIMIT;
  const budget = spec.budget;
  let gone: string | undefined;
  /** Set when ORCA gave the executor up before it exited; nothing more is sent or heard. */
  let failed: string | undefined;
  let onMessage: ((message: string) => void) | undefined;
  const exitListeners: ((detail: string) => void)[] = [];
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  /** The start of a message whose end has not arrived, and its size, which the budget holds. */
  let parts: Buffer[] = [];
  let size = 0;
  const drop = (): void => {
    budget?.give(size);
    parts = [];
    size = 0;
  };
  const finish = (detail: string): void => {
    if (gone !== undefined) return;
    gone = detail;
    drop();
    resolveExit?.();
    for (const listener of exitListeners) listener(failed ?? detail);
  };
  /** Set once ORCA is ending it: what goes wrong after that is the ending, not a failure. */
  let ending = false;
  const giveUp = (detail: string): void => {
    if (gone !== undefined || failed !== undefined || ending) return;
    failed = detail;
    drop();
    // The exit is still observed below; `kill` reaches this child only while it is unreaped.
    child.kill("SIGKILL");
  };

  child.stdout.on("data", (chunk: Buffer) => {
    let start = 0;
    while (gone === undefined && failed === undefined) {
      const newline = chunk.indexOf(0x0a, start);
      const piece = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      if (size + piece.length > messageLimit) return giveUp("it wrote a message over the size limit");
      if (newline === -1) {
        if (piece.length === 0) return;
        if (budget && !budget.take(piece.length))
          return giveUp("it wrote more than ORCA's gate holds for a connection");
        parts.push(piece);
        size += piece.length;
        return;
      }
      const line = (parts.length > 0 ? Buffer.concat([...parts, piece]) : piece).toString("utf8").trim();
      drop();
      start = newline + 1;
      if (line !== "") onMessage?.(line);
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
    send(message, flushed) {
      if (gone !== undefined || failed !== undefined || ending)
        throw new Error(`the executor is gone (${failed ?? gone ?? "ORCA ended it"})`);
      // The callback runs when the bytes reached the pipe, and also when the pipe is torn down.
      child.stdin.write(`${message}\n`, () => flushed());
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
      ending = true;
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
