/**
 * The daemon the smoke test points the app at: a real `orca demo` store, served by a real
 * `orca serve`, over HTTP, on a port nothing else is using.
 *
 * It runs the *built* CLI (`packages/cli/dist/main.js`) rather than the sources through
 * tsx, for the same reason the smoke test runs the built app: what ships is what is being
 * smoke-tested. `pnpm run build` is a prerequisite of both.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Repo root, from this file: packages/app/test/smoke → up four. */
const repoRoot = new URL("../../../../", import.meta.url).pathname;
const cli = join(repoRoot, "packages", "cli", "dist", "main.js");

export interface Daemon {
  /** What to put in `ORCA_DAEMON_URL`. */
  url: string;
  /** The workspace the demo wrote, `.orca` store and all. */
  dir: string;
  stop: () => Promise<void>;
}

/** A port the OS just told us was free. Racy in principle; a single smoke run never loses. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("could not take a port")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/** Poll `hello` until the daemon answers it, or give up — a failed handshake is the test's news, not a hang. */
async function waitForHello(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const body = JSON.stringify({
    kind: "request",
    id: 1,
    method: "hello",
    params: { client: "orca-smoke/0", protocol: { major: 1, minor: 0 } },
  });
  for (;;) {
    try {
      const res = await fetch(`${url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`daemon at ${url} never answered hello`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Build a demo workspace and serve it. Call `stop` however the test ends. */
export async function startDemoDaemon(): Promise<Daemon> {
  const dir = await mkdtemp(join(tmpdir(), "orca-smoke-"));
  // `--keep` because the point is the store it leaves behind; without it demo cleans up.
  await run(process.execPath, [cli, "demo", "--dir", dir, "--keep"], { cwd: dir, maxBuffer: 32 * 1024 * 1024 });

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const serve: ChildProcess = spawn(
    process.execPath,
    [cli, "--config", join(dir, "orca.config.yaml"), "serve", "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log: string[] = [];
  serve.stdout?.on("data", (d: Buffer) => log.push(d.toString()));
  serve.stderr?.on("data", (d: Buffer) => log.push(d.toString()));

  try {
    await waitForHello(url);
  } catch (e) {
    serve.kill("SIGKILL");
    throw new Error(`the smoke test's daemon never came up\ndaemon output:\n${log.join("")}`, { cause: e });
  }

  return {
    url,
    dir,
    stop: async () => {
      serve.kill("SIGTERM");
      await rm(dir, { recursive: true, force: true });
    },
  };
}
