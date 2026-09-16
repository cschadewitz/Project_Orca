import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { OrcaError, type AgentSpec, type LocalHost as LocalHostSpec } from "@orca/core";
import { killIfRunning, StderrTail, type AgentHost, type AgentProcessHandle, type ExecResult, type HostFileSystem, type SpawnAgentOptions } from "../host.js";

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

  async spawnAgent(agent: AgentSpec, options: SpawnAgentOptions): Promise<AgentProcessHandle> {
    const child = spawn(agent.command, agent.args, {
      cwd: options.cwd,
      env: { ...process.env, ...agent.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const tail = new StderrTail();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => tail.push(d));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const spawned = await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).then(
      () => true,
      (e: Error) => {
        throw new OrcaError("AGENT_TRANSPORT", `cannot spawn agent '${agent.id}' (${agent.command}): ${e.message}`, { agentId: agent.id }, { cause: e });
      },
    );
    void spawned;
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    return {
      stream,
      pid: child.pid,
      exited,
      stderrTail: () => tail.text(),
      kill: (signal = "SIGTERM") => killIfRunning(child, signal),
    };
  }

  exec(command: string, options: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, { cwd: options.cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
      child.on("error", reject);
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      if (options.stdin !== undefined) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
  }
}
