/**
 * Two real daemons on one machine, for multi-machine tests (#885 phase 1).
 *
 * Each daemon is the compiled CLI's `orca serve` in its own process, with its own store
 * directory, its own `HOME`, its own port and its own local bearer token, so nothing one
 * daemon writes can be read by the other and each can be stopped on its own. The tests that
 * build on this - the app watching several daemons (#879), remote host profiles (#882), a
 * parent daemon delegating to another (#883) and capacity-aware delegation (#884) - need two
 * peers that are as separate as two machines, short of two machines.
 *
 * `loopbackSshd` adds the transport between them where it can: a throwaway `sshd` for the
 * current user on `127.0.0.1`, with a fresh host key and client key, through which a test
 * forwards a port to the other daemon. It needs `/usr/sbin/sshd`; without it the helper
 * answers `undefined` so a suite can skip, unless `ORCA_REQUIRE_SSHD=1` says the run must
 * have it (the CI job that installs it sets that, so a missing sshd fails rather than skips).
 *
 * Needs `pnpm run build` first: it launches `packages/cli/dist/main.js`, the same entry the
 * desktop bundles, not the TypeScript sources. The environment is deliberately small - no
 * ambient ORCA endpoints, tokens, `NODE_OPTIONS` or agent credentials reach a daemon.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repoRoot } from "./child-bundle.js";

/** The compiled CLI entry each daemon runs. */
export const CLI_ENTRY = join(repoRoot, "packages", "cli", "dist", "main.js");
/** Set to `1` where a run must have sshd: `loopbackSshd` then throws instead of answering `undefined`. */
export const REQUIRE_SSHD_ENV = "ORCA_REQUIRE_SSHD";

const READY_MS = 20_000;

export interface TestDaemonOptions {
  /** A label for errors and the temp directory; also the daemon's name in a pair. */
  name: string;
  /** Extra `orca serve` flags, such as `--read-only`. `--port 0` is always given. */
  args?: readonly string[];
  /** `orca.config.yaml` for the store. Defaults to no workflows and no templates. */
  config?: string;
  /** Extra environment for the daemon process, on top of the minimal one. */
  env?: Readonly<Record<string, string>>;
}

/** One JSON-RPC answer, as the daemon sent it. */
export type RpcAnswer =
  { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface TestDaemon {
  readonly name: string;
  /** `http://127.0.0.1:<port>`, as the daemon printed it. */
  readonly url: string;
  readonly port: number;
  /** The store's working directory (`orca.config.yaml` and `.orca/` live here). */
  readonly dir: string;
  /** The daemon's own local-owner bearer token, read from its token file. */
  readonly token: string;
  /** Call a method with this daemon's token, or with `token` (`null` sends none). */
  call(method: string, params: unknown, token?: string | null): Promise<RpcAnswer>;
  /** Stop the process and remove its directories. Safe to call twice. */
  close(): Promise<void>;
}

export interface TwoDaemons {
  a: TestDaemon;
  b: TestDaemon;
  close(): Promise<void>;
}

/** Start one daemon and wait until it listens and has written its token. */
export async function startTestDaemon(options: TestDaemonOptions): Promise<TestDaemon> {
  if (!existsSync(CLI_ENTRY)) throw new Error(`${CLI_ENTRY} is missing; run \`pnpm run build\` first`);
  const root = await mkdtemp(join(tmpdir(), `orca-daemon-${options.name}-`));
  const dir = join(root, "store");
  const home = join(root, "home");
  await mkdir(dir);
  await mkdir(home);
  await writeFile(join(dir, "orca.config.yaml"), options.config ?? "workflows: []\ntemplates: []\n");

  const child = spawn(process.execPath, [CLI_ENTRY, "serve", "--port", "0", "--cwd", dir, ...(options.args ?? [])], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", HOME: home, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: string[] = [];
  let closed = false;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const close = async () => {
    if (!closed) {
      closed = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const stopped = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
        if (!stopped) {
          child.kill("SIGKILL");
          await exited;
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  };

  try {
    const { url, tokenFile } = await ready(child, output, options.name);
    const token = (await readFile(tokenFile, "utf8")).trim();
    const daemon: TestDaemon = {
      name: options.name,
      url,
      port: Number(new URL(url).port),
      dir,
      token,
      call: (method, params, as) => rpc(url, method, params, as === undefined ? token : as),
      close,
    };
    return daemon;
  } catch (error) {
    await close();
    throw new Error(`daemon ${options.name} did not start: ${(error as Error).message}\n${output.join("")}`, {
      cause: error,
    });
  }
}

/** Two independent daemons, `a` and `b`, started side by side. */
export async function startTwoDaemons(
  options: { a?: Partial<TestDaemonOptions>; b?: Partial<TestDaemonOptions> } = {},
): Promise<TwoDaemons> {
  const [a, b] = await Promise.allSettled([
    startTestDaemon({ name: "a", ...options.a }),
    startTestDaemon({ name: "b", ...options.b }),
  ]);
  if (a.status === "rejected" || b.status === "rejected") {
    for (const started of [a, b]) if (started.status === "fulfilled") await started.value.close();
    throw (a.status === "rejected" ? a.reason : (b as PromiseRejectedResult).reason) as Error;
  }
  return {
    a: a.value,
    b: b.value,
    close: async () => {
      await Promise.all([a.value.close(), b.value.close()]);
    },
  };
}

/** A JSON-RPC call over HTTP, the way the CLI and the app make one. */
export async function rpc(url: string, method: string, params: unknown, token: string | null): Promise<RpcAnswer> {
  const response = await fetch(new URL("/rpc", url), {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ kind: "request", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => undefined)) as RpcAnswer | undefined;
  if (!body || typeof body.ok !== "boolean") throw new Error(`${method}: HTTP ${response.status} with no ORCA answer`);
  return body;
}

async function ready(
  child: ChildProcessWithoutNullStreams,
  output: string[],
  name: string,
): Promise<{ url: string; tokenFile: string }> {
  return new Promise((resolve, reject) => {
    let url: string | undefined;
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`not ready within ${READY_MS} ms`)), READY_MS);
    const done = (error?: Error, value?: { url: string; tokenFile: string }) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output.push(text);
      buffered += text;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        url ??= /listening on (\S+)/.exec(line)?.[1];
        const tokenFile = /^authentication: token; local token file: (.+)$/.exec(line)?.[1];
        if (tokenFile && url) done(undefined, { url, tokenFile });
        else if (line.startsWith("authentication:") && !tokenFile)
          done(new Error(`daemon ${name} is not in token mode: ${line}`));
      }
    });
    child.once("exit", (code, signal) => done(new Error(`exited before readiness (code ${code}, signal ${signal})`)));
  });
}

export interface LoopbackSshd {
  /** The port sshd listens on, on 127.0.0.1. */
  readonly port: number;
  /** The private key a client logs in with, as the current user. */
  readonly identity: string;
  readonly user: string;
  /** `ssh` options that trust this throwaway host key and log in with `identity`. */
  readonly sshArgs: readonly string[];
  /**
   * Forward a free local port through sshd to `127.0.0.1:remotePort` - another daemon, as a
   * remote machine's port would be reached - and answer the local port.
   */
  forward(remotePort: number): Promise<number>;
  /** Stop every forward and sshd, and remove the keys. */
  close(): Promise<void>;
}

const SSHD = "/usr/sbin/sshd";

/**
 * A throwaway sshd for the current user on loopback, or `undefined` where there is no sshd
 * and `ORCA_REQUIRE_SSHD` is not `1`. Linux and macOS only: Windows has no `/usr/sbin/sshd`.
 */
export async function loopbackSshd(): Promise<LoopbackSshd | undefined> {
  if (!existsSync(SSHD) || process.platform === "win32") {
    if (process.env[REQUIRE_SSHD_ENV] === "1") throw new Error(`${REQUIRE_SSHD_ENV}=1 but ${SSHD} is not installed`);
    return undefined;
  }
  const root = await mkdtemp(join(tmpdir(), "orca-sshd-"));
  const processes: ChildProcessWithoutNullStreams[] = [];
  const close = async () => {
    await Promise.all(processes.map(stop));
    await rm(root, { recursive: true, force: true });
  };
  try {
    const user = userInfo().username;
    const hostKey = join(root, "hostkey");
    const identity = join(root, "client");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
    const authorized = join(root, "authorized_keys");
    await writeFile(authorized, await readFile(`${identity}.pub`), { mode: 0o600 });
    const port = await freePort();
    const config = join(root, "sshd_config");
    await writeFile(
      config,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `PidFile ${join(root, "sshd.pid")}`,
        `AuthorizedKeysFile ${authorized}`,
        `AllowUsers ${user}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        // The keys live in a temp directory whose parents this user does not own.
        "StrictModes no",
        "AllowTcpForwarding local",
        "",
      ].join("\n"),
    );
    // -D: stay in the foreground, so this process owns sshd and `close` stops it.
    const sshd = spawn(SSHD, ["-D", "-f", config, "-E", join(root, "sshd.log")], { stdio: ["pipe", "pipe", "pipe"] });
    processes.push(sshd);
    const sshArgs = [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-i",
      identity,
      "-p",
      String(port),
    ];
    const log = () => readFile(join(root, "sshd.log"), "utf8").catch(() => "");
    await until(
      async () => {
        // An sshd that refused to start (a bad config, root without /run/sshd) says why in its log.
        if (sshd.exitCode !== null) throw new Error(`sshd exited ${sshd.exitCode}: ${(await log()).trim()}`);
        await run("ssh", [...sshArgs, `${user}@127.0.0.1`, "true"]);
      },
      "sshd to accept a login",
      log,
    );
    return {
      port,
      identity,
      user,
      sshArgs,
      async forward(remotePort) {
        const local = await freePort();
        const tunnel = spawn(
          "ssh",
          [
            ...sshArgs,
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-L",
            `127.0.0.1:${local}:127.0.0.1:${remotePort}`,
            `${user}@127.0.0.1`,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        processes.push(tunnel);
        await until(() => connects(local), `the forward to ${remotePort}`);
        return local;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

async function until(attempt: () => Promise<unknown>, what: string, diagnostics?: () => Promise<string>) {
  const deadline = Date.now() + 15_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await attempt();
      return;
    } catch (error) {
      last = error;
      if (/^sshd exited/.test((error as Error).message)) break;
      await delay(100);
    }
  }
  const more = diagnostics ? `\n${await diagnostics()}` : "";
  throw new Error(`timed out waiting for ${what}: ${(last as Error | undefined)?.message ?? "no attempt"}${more}`);
}

function connects(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}
