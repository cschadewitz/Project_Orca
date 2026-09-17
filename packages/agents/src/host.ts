/**
 * Host abstraction: where an agent process runs and how ORCA reaches its files.
 *
 * ACP's stdio transport is newline-delimited JSON-RPC over a child process's
 * stdin/stdout. That is exactly what `ssh -T host command` gives us, so a
 * remote agent is "just" a differently spawned process. The only other thing
 * the orchestrator needs from a host is file access, to pick up artifacts the
 * agent wrote and to serve ACP `fs/*` requests.
 */
import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import type { AgentSpec, HostSpec } from "@orca/core";

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
}

export interface AgentHost {
  readonly id: string;
  readonly spec: HostSpec;
  readonly fs: HostFileSystem;
  spawnAgent(agent: AgentSpec, options: SpawnAgentOptions): Promise<AgentProcessHandle>;
  /** Run a shell command on the host (used by workspace providers, e.g. `git worktree add`). */
  exec(command: string, options?: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<ExecResult>;
  /** Join path segments using the host's conventions. */
  joinPath(...parts: string[]): string;
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
