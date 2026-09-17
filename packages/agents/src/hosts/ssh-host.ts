/**
 * SshHost - runs ACP agents on another machine over SSH.
 *
 * No daemon is needed on the remote side: `ssh -T user@host -- bash -lc 'cd
 * <cwd> && exec <agent>'` gives us the agent's stdin/stdout, which *is* the ACP
 * stdio transport. File access for artifact pickup uses short-lived `ssh`
 * commands (`cat`, `test -e`, `mkdir -p`); swap in an SFTP-based
 * HostFileSystem if you need higher throughput.
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
  async mkdirp(path: string): Promise<void> {
    const r = await this.host.exec(`mkdir -p ${shellQuote(path)}`);
    if (r.code !== 0) throw new OrcaError("AGENT_TRANSPORT", `ssh mkdir failed for ${path}: ${r.stderr.trim()}`, { hostId: this.host.id, path });
  }
}
