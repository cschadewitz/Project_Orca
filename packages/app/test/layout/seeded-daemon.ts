/**
 * The daemon the layout spec points the built app at: `orca demo`'s workspace filled by
 * `tools/demo-seed` (#1115), served by this commit's built CLI on a free port.
 *
 * The seed is what makes the layout bugs visible at all: fifty runs with long, unbroken,
 * accented and Japanese titles, plans with risks and decisions, two permission asks of the
 * same shape from two runs, an agent whose command does not exist, and a dozen workflows,
 * one with a very long name. The desktop app's own first-run path is not used: the app is
 * pointed at this daemon with `ORCA_DAEMON_URL`, as `../smoke/daemon.ts` does, so the run
 * needs no folder picker. Seeding takes about a minute and a half.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROTOCOL_VERSION } from "@orca/protocol";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cli = join(repoRoot, "packages", "cli", "dist", "main.js");
const seedBuild = join(repoRoot, "tools", "demo-seed", "build.mjs");
const seedScript = join(repoRoot, "tools", "demo-seed", "dist", "orca-demo-seed", "seed.mjs");

export interface SeededDaemon {
  url: string;
  dir: string;
  tokenFile: string;
  rpc: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) return reject(new Error("could not take a port"));
      probe.close(() => resolve(address.port));
    });
  });
}

let nextId = 1;
async function rpc(url: string, tokenFile: string, method: string, params: unknown = {}) {
  const token = (await readFile(tokenFile, "utf8")).trim();
  const res = await fetch(`${url}/rpc`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: "request", id: nextId++, method, params }),
  });
  if (!res.ok) throw new Error(`${method} answered HTTP ${res.status}`);
  const body = (await res.json()) as { ok?: boolean; result?: Record<string, unknown>; error?: unknown };
  if (body.ok !== true) throw new Error(`${method} refused: ${JSON.stringify(body.error)}`);
  return body.result ?? {};
}

async function serve(dir: string, port: number, log: string[]): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [cli, "--config", join(dir, "orca.config.yaml"), "serve", "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (d: Buffer) => log.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => log.push(d.toString()));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await rpc(url, join(dir, "auth", "local-client.token"), "hello", {
        client: "orca-layout/0",
        protocol: PROTOCOL_VERSION,
      });
      return child;
    } catch {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(`orca serve never answered hello\n${log.join("")}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await done;
  clearTimeout(timer);
}

/** Runs the packed seed; `prepare` ends with exit 2 when the daemon must restart, which is expected. */
async function seed(dir: string, url: string, phase: "prepare" | "populate", allowed: number[]): Promise<string> {
  const args = [seedScript, "--workspace", dir, "--url", url, "--phase", phase, "--settle", "45"];
  try {
    const { stdout, stderr } = await run(process.execPath, args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout + stderr;
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof e.code === "number" && allowed.includes(e.code)) return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    throw new Error(`demo seed ${phase} failed\n${e.stdout ?? ""}${e.stderr ?? ""}`, { cause: error });
  }
}

export async function startSeededDaemon(): Promise<SeededDaemon> {
  if (!existsSync(seedScript)) await run(process.execPath, [seedBuild], { cwd: repoRoot });
  const dir = await mkdtemp(join(tmpdir(), "orca-layout-ws-"));
  await run(process.execPath, [cli, "demo", "--dir", dir, "--keep"], { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
  const tokenFile = join(dir, "auth", "local-client.token");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log: string[] = [];
  let daemon = await serve(dir, port, log);
  try {
    // New agents need a restart, so prepare, restart, then populate (tools/demo-seed/README.md).
    await seed(dir, url, "prepare", [0, 2]);
    await stop(daemon);
    daemon = await serve(dir, port, log);
    await seed(dir, url, "populate", [0]);
  } catch (error) {
    await stop(daemon);
    throw new Error(`${(error as Error).message}\ndaemon output:\n${log.join("")}`, { cause: error });
  }
  return {
    url,
    dir,
    tokenFile,
    rpc: (method, params) => rpc(url, tokenFile, method, params),
    stop: async () => {
      await stop(daemon);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
