/**
 * SshHost - runs ACP agents on another machine over SSH.
 *
 * No daemon is needed on the remote side: `ssh -T user@host -- bash -lc 'cd
 * <cwd> && exec <agent>'` gives us the agent's stdin/stdout, which *is* the ACP
 * stdio transport. File access for artifact pickup uses short-lived `ssh`
 * commands (`cat`, `test -e`, `mkdir -p`), batched where a caller needs several
 * paths at once (`existsMany`). Each call is still a connection, so on a chatty
 * workflow it is worth enabling multiplexing via `sshArgs`, e.g. ["-o",
 * "ControlMaster=auto", "-o", "ControlPath=~/.ssh/orca-%r@%h:%p", "-o",
 * "ControlPersist=60s"]; swap in an SFTP-based HostFileSystem if you need more.
 *
 * Requirements: key-based auth (BatchMode=yes, no password prompts), the agent
 * binary on the remote PATH for a login shell, and the workspace already
 * present on the remote (see docs/INTEGRATIONS.md for syncing strategies).
 */
import { spawn } from "node:child_process";
import { posix } from "node:path";
import { OrcaError, type AgentSpec, type SshHost as SshHostSpec } from "@orca/core";
import { collectChildProcess, shellQuote, wrapAgentProcess, type AgentHost, type AgentProcessHandle, type ExecResult, type HostFileSystem, type SpawnAgentOptions } from "../host.js";

export class SshHost implements AgentHost {
  readonly fs: HostFileSystem;
  constructor(readonly spec: SshHostSpec) {
    this.fs = new SshFileSystem(this);
  }
  get id(): string {
    return this.spec.id;
  }
  joinPath(...parts: string[]): string {
    return posix.join(...parts);
  }

  /** ssh CLI arguments up to (not including) the remote command. */
  baseArgs(): string[] {
    const s = this.spec;
    const args = ["-T", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.ceil(s.connectTimeoutMs / 1000)}`, ...s.sshArgs];
    if (s.port) args.push("-p", String(s.port));
    if (s.identityFile) args.push("-i", s.identityFile);
    args.push(s.user ? `${s.user}@${s.host}` : s.host);
    return args;
  }

  /** Wrap a shell snippet for the remote login shell. */
  remoteCommand(script: string): string[] {
    const [shell, ...shellArgs] = this.spec.remoteShell.split(/\s+/);
    return [shell!, ...shellArgs, shellQuote(script)];
  }

  spawnAgent(agent: AgentSpec, options: SpawnAgentOptions): Promise<AgentProcessHandle> {
    const env = { ...agent.env, ...(options.env ?? {}) };
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ");
    const script = `cd ${shellQuote(options.cwd)} && exec ${envPrefix ? `env ${envPrefix} ` : ""}${shellQuote(agent.command)} ${agent.args.map(shellQuote).join(" ")}`.trim();
    return wrapAgentProcess(this.spawnSsh(script), {
      onSpawnError: (e) => new OrcaError("AGENT_TRANSPORT", `cannot start ssh for host '${this.id}': ${e.message}`, { hostId: this.id }, { cause: e }),
    });
  }

  exec(command: string, options: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const script = options.cwd ? `cd ${shellQuote(options.cwd)} && ${command}` : command;
    return collectChildProcess(this.spawnSsh(script), options);
  }

  /** Run `script` through the remote login shell; stdin/stdout carry the payload. */
  private spawnSsh(script: string) {
    const args = [...this.baseArgs(), "--", ...this.remoteCommand(script)];
    return spawn(this.spec.sshBinary, args, { stdio: ["pipe", "pipe", "pipe"] });
  }
}

class SshFileSystem implements HostFileSystem {
  constructor(private readonly host: SshHost) {}
  async readFile(path: string): Promise<string> {
    const r = await this.host.exec(`cat ${shellQuote(path)}`);
    if (r.code !== 0) throw new OrcaError("AGENT_TRANSPORT", `ssh read failed for ${path}: ${r.stderr.trim()}`, { hostId: this.host.id, path });
    return r.stdout;
  }
  async writeFile(path: string, content: string): Promise<void> {
    const dir = posix.dirname(path);
    const r = await this.host.exec(`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`, { stdin: content });
    if (r.code !== 0) throw new OrcaError("AGENT_TRANSPORT", `ssh write failed for ${path}: ${r.stderr.trim()}`, { hostId: this.host.id, path });
  }
  async exists(path: string): Promise<boolean> {
    const r = await this.host.exec(`test -e ${shellQuote(path)}`);
    return r.code === 0;
  }
  /**
   * One ssh process for the whole set: the remote shell prints `1`/`0` per path,
   * in order. A malformed reply (truncated output, a shell that failed to start)
   * is reported as "nothing exists yet" rather than as a spurious hit, so a
   * poller keeps waiting instead of concluding an artifact has landed.
   */
  async existsMany(paths: string[]): Promise<boolean[]> {
    if (paths.length === 0) return [];
    const script = `for p in ${paths.map(shellQuote).join(" ")}; do if test -e "$p"; then echo 1; else echo 0; fi; done`;
    const r = await this.host.exec(script);
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    if (lines.length !== paths.length) return paths.map(() => false);
    return lines.map((l) => l.trim() === "1");
  }
  async mkdirp(path: string): Promise<void> {
    const r = await this.host.exec(`mkdir -p ${shellQuote(path)}`);
    if (r.code !== 0) throw new OrcaError("AGENT_TRANSPORT", `ssh mkdir failed for ${path}: ${r.stderr.trim()}`, { hostId: this.host.id, path });
  }
}
