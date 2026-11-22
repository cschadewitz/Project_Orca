/** LocalHost - runs ACP agents as child processes of this one, against the local filesystem. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { OrcaError, literalEnv, type AgentSpec, type LocalHost as LocalHostSpec, type SecretSource } from "@orca/core";
import { sourceMissing, trimSecret } from "../secrets.js";
import {
  collectChildProcess,
  wrapAgentProcess,
  type AgentHost,
  type AgentProcessHandle,
  type ExecResult,
  type HostFileSystem,
  type SpawnAgentOptions,
} from "../host.js";

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

export const localFileSystem: HostFileSystem = {
  readFile: (p) => readFile(p, "utf8"),
  writeFile: async (p, c) => {
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, c, "utf8");
  },
  exists,
  // Local stats are cheap; there is nothing to batch beyond issuing them together.
  existsMany: (paths) => Promise.all(paths.map(exists)),
  mkdirp: async (p) => {
    await mkdir(p, { recursive: true });
  },
};

/** Runs agents as child processes on this machine. */
export class LocalHost implements AgentHost {
  readonly fs = { ...localFileSystem };
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
      env: { ...process.env, ...literalEnv(agent.env), ...(options.env ?? {}), ...(options.secretEnv ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return wrapAgentProcess(child, {
      onSpawnError: (e) =>
        new OrcaError(
          "AGENT_TRANSPORT",
          `cannot spawn agent '${agent.id}' (${agent.command}): ${e.message}`,
          { agentId: agent.id },
          { cause: e },
        ),
    });
  }

  /** The daemon's own environment, or a file on this machine (#336). */
  async readSecret(id: string, source: SecretSource): Promise<string> {
    if (source.provider === "env") {
      const value = process.env[source.name];
      if (value === undefined || value === "") throw sourceMissing(id, source, this.id);
      return value;
    }
    try {
      const value = trimSecret(await readFile(source.path, "utf8"));
      if (value === "") throw sourceMissing(id, source, this.id);
      return value;
    } catch (error) {
      if (error instanceof OrcaError) throw error;
      throw sourceMissing(id, source, this.id);
    }
  }

  exec(command: string, options: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const child = spawn(command, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return collectChildProcess(child, options);
  }
}
