/**
 * Host abstraction: where an agent process runs and how ORCA reaches its files.
 *
 * ACP's stdio transport is newline-delimited JSON-RPC over a child process's
 * stdin/stdout. That is exactly what `ssh -T host command` gives us, so a
 * remote agent is "just" a differently spawned process. The only other thing
 * the orchestrator needs from a host is file access, to pick up artifacts the
 * agent wrote and to serve ACP `fs/*` requests.
 */
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentSpec, HostSpec, SecretSource } from "@orca/core";

/** A child spawned with `stdio: ["pipe", "pipe", "pipe"]`: all three streams present. */
export type PipedChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AgentProcessHandle {
  /** ndjson ACP stream bound to the process's stdio. */
  stream: acp.Stream;
  pid: number | undefined;
  exited: Promise<ProcessExit>;
  /** Last lines of stderr, for diagnostics when a handshake fails. */
  stderrTail(): string;
  kill(signal?: NodeJS.Signals): void;
  /** Each delivered secret's value by id, as the host read it to start this process (#336). */
  secretValues?: ReadonlyMap<string, string>;
}

/** One secret a host reads and delivers when it starts an agent (#336). */
export interface SecretDelivery {
  id: string;
  source: SecretSource;
  /** Agent environment variables it fills; may be empty when only MCP servers use it. */
  env: string[];
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HostFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /**
   * Existence of several paths at once, index-aligned with `paths`.
   *
   * Remote hosts pay a process (and a TCP handshake) per file-system call, so
   * anything that checks a set of paths repeatedly - the `artifact-present`
   * watcher above all - should ask once instead of once per path.
   */
  existsMany(paths: string[]): Promise<boolean[]>;
  mkdirp(path: string): Promise<void>;
}

export interface SpawnAgentOptions {
  cwd: string;
  env?: Record<string, string>;
  /**
   * Secrets to read and deliver as part of starting the agent (#336). The host reads each
   * one where the agent will run, immediately before starting it, and returns the values on
   * the handle. A value is never put in a process argument list on either machine.
   */
  secrets?: SecretDelivery[];
  /** Variables the agent must not inherit from the host's environment (#336). */
  withheldEnv?: string[];
}

export interface AgentHost {
  readonly id: string;
  readonly spec: HostSpec;
  readonly fs: HostFileSystem;
  spawnAgent(agent: AgentSpec, options: SpawnAgentOptions): Promise<AgentProcessHandle>;
  /** Run a shell command on the host (used by workspace providers, e.g. `git worktree add`). */
  exec(command: string, options?: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<ExecResult>;
  /**
   * Run a shell command on the host for its exit status alone: its output is discarded
   * rather than collected, and it is killed at `timeoutMs`. `null` when it was killed or
   * did not exit normally. For probes that need only an answer (#336).
   */
  execStatus?(command: string, options: { timeoutMs: number }): Promise<number | null>;
  /** Join path segments using the host's conventions. */
  joinPath(...parts: string[]): string;
  /**
   * True when `spawnAgent` honours `secrets` and `withheldEnv` (#336). A host without it
   * cannot run a session that uses a secret reference.
   */
  readonly deliversSecrets?: boolean;
}

/**
 * Send `signal` to `child` unless it has already exited.
 *
 * Deliberately does not consult `child.killed`: Node sets that flag as soon as
 * the first `kill()` call succeeds, so guarding on it would turn a later
 * SIGTERM -> SIGKILL escalation into a no-op while the process is still alive.
 * `exitCode`/`signalCode` only become non-null once the process has actually
 * exited, which is the condition we care about.
 */
export function killIfRunning(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    /* process may have exited between the check and the signal */
  }
}

/** POSIX single-quote escaping for commands sent through a remote shell. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./=:@%+]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class StderrTail {
  private lines: string[] = [];
  constructor(private readonly max = 50) {}
  push(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      this.lines.push(line);
      if (this.lines.length > this.max) this.lines.shift();
    }
  }
  text(): string {
    return this.lines.join("\n");
  }
}

/**
 * Frame an ACP ndjson stream over a pair of Node streams.
 *
 * `acp.ndJsonStream` speaks web streams, and `Readable.toWeb`/`Writable.toWeb`
 * are typed with `any`-ish chunk types, hence the casts. They live here once so
 * that every transport (child stdio, a process's own stdio) gets the same
 * framing and any future fix - EPIPE handling, backpressure - lands in one spot.
 */
export function stdioAcpStream(input: Readable, output: Writable): acp.Stream {
  return acp.ndJsonStream(
    Writable.toWeb(output) as WritableStream<Uint8Array>,
    Readable.toWeb(input) as ReadableStream<Uint8Array>,
  );
}

export interface WrapAgentProcessOptions {
  /** Turns a spawn failure into the host-specific error to throw. */
  onSpawnError(error: Error): Error;
  /**
   * Runs once the child has spawned and before its stdout becomes the ACP stream: a host
   * that has the process say something first (an SSH host reporting the secrets it read)
   * consumes it here. If it throws, the child is killed and the error is the spawn's.
   */
  beforeStream?(child: PipedChildProcess): Promise<void>;
}

/**
 * Turn a freshly spawned child into an `AgentProcessHandle`.
 *
 * Resolves only once the child has actually spawned, so a bad command fails
 * here rather than as an unexplained handshake timeout later. The `exit`
 * listener is attached before that await: an exit can race the spawn callback
 * for a process that dies immediately.
 */
export async function wrapAgentProcess(
  child: PipedChildProcess,
  options: WrapAgentProcessOptions,
): Promise<AgentProcessHandle> {
  const tail = new StderrTail();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => tail.push(d));
  const exited = new Promise<ProcessExit>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  }).catch((e: unknown) => {
    throw options.onSpawnError(e instanceof Error ? e : new Error(String(e)));
  });
  if (options.beforeStream)
    try {
      await options.beforeStream(child);
    } catch (error) {
      killIfRunning(child, "SIGKILL");
      throw error;
    }
  return {
    stream: stdioAcpStream(child.stdout, child.stdin),
    pid: child.pid,
    exited,
    stderrTail: () => tail.text(),
    kill: (signal = "SIGTERM") => killIfRunning(child, signal),
  };
}

export interface CollectChildProcessOptions {
  stdin?: string;
  timeoutMs?: number;
}

/**
 * Run a child to completion, collecting stdout/stderr.
 *
 * Shared by every host's `exec`; hosts differ only in how they build the argv.
 * `stdin` is always closed, otherwise a command that reads from it (`cat >
 * file`) would hang forever.
 *
 * Writes to stdin are best-effort: a command that never reads it (or has
 * already exited) makes the pipe fail with EPIPE, which is not an error for
 * us - the exit code and output are what matter - so it must not reject the
 * promise or bubble up as an unhandled stream error.
 *
 * Normally we resolve on `close` (all output flushed) rather than `exit`. On
 * timeout we SIGKILL - a SIGTERM the command may ignore would leave us waiting
 * - and then resolve on `exit`, because a grandchild that survived the kill
 * (`sh -c` forks one) still holds the stdout pipe open and `close` would not
 * fire until it finished, which is exactly what the timeout exists to prevent.
 */
/** Wait for `child`'s exit status, killing it at `timeoutMs`; its output is not read. */
export function childExitStatus(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killIfRunning(child, "SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? null : code);
    });
  });
}

export function collectChildProcess(
  child: PipedChildProcess,
  options: CollectChildProcessOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killIfRunning(child, "SIGKILL");
        }, options.timeoutMs)
      : undefined;
    const done = (code: number | null): void => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (timedOut) done(code);
    });
    child.on("close", done);
    child.stdin.on("error", () => {});
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}
