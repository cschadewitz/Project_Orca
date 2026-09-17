import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { OrcaError, type AgentSpec, type LocalHost as LocalHostSpec } from "@orca/core";
import { collectChildProcess, wrapAgentProcess, type AgentHost, type AgentProcessHandle, type ExecResult, type HostFileSystem, type SpawnAgentOptions } from "../host.js";

export const localFileSystem: HostFileSystem = {
  readFile: (p) => readFile(p, "utf8"),
  writeFile: async (p, c) => {
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, c, "utf8");
  },
  exists: (p) =>
    access(p).then(
      () => true,
      () => false,
    ),
  mkdirp: async (p) => {
    await mkdir(p, { recursive: true });
  },
};

/** Runs agents as child processes on this machine. */
export class LocalHost implements AgentHost {
  readonly fs = localFileSystem;
  constructor(readonly spec: LocalHostSpec) {}
  get id(): string {
    return this.spec.id;
  }
  joinPath(...parts: string[]): string {
    return join(...parts);
  }

  spawnAgent(agent: AgentSpec, options: SpawnAgentOptions): Promise<AgentProcessHandle> {
    const child = spawn(agent.command, agent.args, {
      cwd: options.cwd,
      env: { ...process.env, ...agent.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return wrapAgentProcess(child, {
      onSpawnError: (e) => new OrcaError("AGENT_TRANSPORT", `cannot spawn agent '${agent.id}' (${agent.command}): ${e.message}`, { agentId: agent.id }, { cause: e }),
    });
  }

  exec(command: string, options: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const child = spawn(command, { ...(options.cwd ? { cwd: options.cwd } : {}), shell: true, stdio: ["pipe", "pipe", "pipe"] });
    return collectChildProcess(child, options);
  }
}
