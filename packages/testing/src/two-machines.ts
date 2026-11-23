/**
 * Two (or more) ORCA machines in separate containers, for the cross-machine acceptance test
 * (#885 phase 2).
 *
 * Where the two-daemon fixture (`./two-daemons.ts`) runs two daemons as the current user on
 * one host, this one gives each daemon a machine of its own: a container from
 * `packages/testing/machine/Dockerfile` (Ubuntu 24.04, sshd, and the headless server bundle
 * this checkout builds (#876), unpacked as a release ships it, with nothing else of the
 * repository), its own host keys, its own `orca` account and its own name on a private Docker
 * network. Each daemon listens only on its machine's loopback, as a server's does. A parent
 * daemon reaches a worker the way it reaches any host: over the network, through the worker's
 * sshd, logged in as `orca`, with the host key it was told to trust.
 *
 * The test drives each daemon from inside its machine (`docker exec`, as `orca`, with the
 * small `machine/rpc.mjs`), never through a published port, so no daemon is bound beyond
 * loopback for the test's sake.
 *
 * It runs only where `ORCA_TWO_MACHINES=1` (the dedicated CI job sets it): building the bundle
 * and the image takes minutes, and Docker is not on every runner. With it set, a missing
 * Docker fails rather than skips. `ORCA_SERVER_BUNDLE` names an already built
 * `orca-server-*.tar.xz` to use instead of building one; `ORCA_MACHINE_BASE` names a base image
 * that already has the packages, for a build host with no route to the Ubuntu archive.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repoRoot } from "./child-bundle.js";
import type { RpcAnswer } from "./two-daemons.js";

/** Set to `1` to run the machines; without it `startMachines` answers `undefined`. */
export const TWO_MACHINES_ENV = "ORCA_TWO_MACHINES";
/** The account the daemon runs as and a parent logs in as, on every machine. */
export const MACHINE_USER = "orca";
/** Each machine's workspace: `orca.config.yaml`, `.orca/` and `auth/` live here. */
export const MACHINE_WORKSPACE = "/home/orca/ws";
/** The port each daemon listens on, on its own loopback (the default an enrollment assumes). */
export const MACHINE_DAEMON_PORT = 6722;
/** The bundle's Node and scripted agent, for an agent spec on a machine. */
export const MACHINE_NODE = "/opt/orca-server/runtime/bin/node";
export const MACHINE_SCRIPTED_AGENT = "/opt/orca-server/scripted-agent/main.js";

const MACHINE_DIR = join(repoRoot, "packages", "testing", "machine");
const RPC = "/opt/orca-test/rpc.mjs";
const READY_MS = 30_000;

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Machine {
  /** The machine's name on the network, which is also its hostname (`ssh orca@<name>`). */
  readonly name: string;
  /** Run a command in the machine, as `orca` unless `user` says otherwise. */
  exec(argv: readonly string[], options?: { user?: string; input?: string; timeoutMs?: number }): Promise<ExecResult>;
  /** Write a file as `orca`, creating its directory. */
  writeFile(path: string, text: string, mode?: number): Promise<void>;
  /**
   * Write the workspace's `orca.config.yaml` (and `files`, relative to the workspace) and start
   * `orca serve` there, waiting until it answers. Starting again stops the running one first.
   */
  serve(config: string, files?: Readonly<Record<string, string>>): Promise<void>;
  /** One JSON-RPC call to this machine's daemon, with its local token. */
  call(method: string, params: unknown): Promise<RpcAnswer>;
  /** The machine's ed25519 host key fingerprint (`SHA256:…`), for `orca remote enroll --host-key`. */
  readonly hostKeyFingerprint: string;
  /** `orca`'s public key on this machine, for another machine's `authorized_keys`. */
  readonly publicKey: string;
  /** The daemon's output so far, for a failure message. */
  log(): Promise<string>;
}

export interface Machines {
  readonly machines: Readonly<Record<string, Machine>>;
  /** Let `from`'s `orca` log in to `to` as `orca` with its key, as an operator would set up. */
  authorize(from: string, to: string): Promise<void>;
  /** Take a machine off the network (its connections stall), and put it back. */
  disconnect(name: string): Promise<void>;
  reconnect(name: string): Promise<void>;
  /** Remove every container and the network. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Start one container per name on a private network, each with sshd running and its own keys.
 * Answers `undefined` unless `ORCA_TWO_MACHINES=1`.
 */
export async function startMachines(names: readonly string[]): Promise<Machines | undefined> {
  if (process.env[TWO_MACHINES_ENV] !== "1") return undefined;
  const docker = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (docker.status !== 0) throw new Error(`${TWO_MACHINES_ENV}=1 but Docker is not usable: ${docker.stderr}`);
  const image = await machineImage();
  const id = randomBytes(4).toString("hex");
  const network = `orca-machines-${id}`;
  const containers: string[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (containers.length) await run("docker", ["rm", "-f", ...containers]);
      await run("docker", ["network", "rm", network]);
    })());
  try {
    await must("docker", ["network", "create", "--internal", network]);
    const machines: Record<string, Machine> = {};
    for (const name of names) {
      const container = `orca-${name}-${id}`;
      await must("docker", [
        "run",
        "-d",
        "--init",
        "--name",
        container,
        "--hostname",
        name,
        "--network",
        network,
        "--network-alias",
        name,
        image,
      ]);
      containers.push(container);
      machines[name] = await machine(name, container);
    }
    return {
      machines,
      authorize: async (from, to) => {
        const key = machines[from]!.publicKey;
        await machines[to]!.exec(
          ["sh", "-c", "mkdir -p -m 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"],
          { input: `${key}\n` },
        );
      },
      disconnect: async (name) => {
        await must("docker", ["network", "disconnect", network, `orca-${name}-${id}`]);
      },
      reconnect: async (name) => {
        await must("docker", ["network", "connect", "--alias", name, network, `orca-${name}-${id}`]);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function machine(name: string, container: string): Promise<Machine> {
  const exec = async (
    argv: readonly string[],
    options: { user?: string; input?: string; timeoutMs?: number } = {},
  ): Promise<ExecResult> =>
    run(
      "docker",
      ["exec", ...(options.input !== undefined ? ["-i"] : []), "-u", options.user ?? MACHINE_USER, container, ...argv],
      options,
    );
  const check = async (argv: readonly string[], options?: { user?: string; input?: string }) => {
    const out = await exec(argv, options);
    if (out.status !== 0) throw new Error(`${name}: ${argv.join(" ")} failed (${out.status}): ${out.stderr}`);
    return out.stdout;
  };
  // Host keys made here, so no two machines share one; then sshd, as root, like a server's.
  await check(["sh", "-c", "ssh-keygen -A >/dev/null && /usr/sbin/sshd"], { user: "root" });
  const hostKeyFingerprint = (await check(["ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub"])).split(/\s+/)[1]!;
  await check([
    "sh",
    "-c",
    `mkdir -p -m 700 ~/.ssh && ssh-keygen -q -t ed25519 -N '' -C orca@${name} -f ~/.ssh/id_ed25519 && mkdir -p ${MACHINE_WORKSPACE}`,
  ]);
  const publicKey = (await check(["cat", "/home/orca/.ssh/id_ed25519.pub"])).trim();

  const writeFile = async (path: string, text: string, mode = 0o644) => {
    await check(
      ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod "$2" "$1"', "sh", path, mode.toString(8)],
      { input: text },
    );
  };
  const call = async (method: string, params: unknown): Promise<RpcAnswer> => {
    const out = await exec([MACHINE_NODE, RPC, method, JSON.stringify(params ?? {})]);
    if (out.status !== 0) throw new Error(`${name}: ${method}: ${out.stderr.trim() || `exit ${out.status}`}`);
    let body: RpcAnswer | undefined;
    try {
      body = JSON.parse(out.stdout) as RpcAnswer;
    } catch {
      body = undefined;
    }
    if (!body || typeof body.ok !== "boolean") throw new Error(`${name}: ${method}: no ORCA answer: ${out.stdout}`);
    return body;
  };
  const log = async () => (await exec(["sh", "-c", "cat ~/serve.log 2>/dev/null"])).stdout;
  const serve = async (config: string, files: Readonly<Record<string, string>> = {}) => {
    await exec(["sh", "-c", "pkill -u orca -f 'orca-daemon.mjs serve' && sleep 1; true"]);
    await writeFile(`${MACHINE_WORKSPACE}/orca.config.yaml`, config);
    for (const [path, text] of Object.entries(files)) await writeFile(`${MACHINE_WORKSPACE}/${path}`, text);
    // Detached from this exec, as a service would be; its output goes to ~/serve.log.
    await check([
      "sh",
      "-c",
      `cd ${MACHINE_WORKSPACE} && rm -f ~/serve.log && (nohup orca serve --port ${MACHINE_DAEMON_PORT} > ~/serve.log 2>&1 &)`,
    ]);
    const end = Date.now() + READY_MS;
    for (;;) {
      const answer = await call("agents.list", {}).catch(() => undefined);
      if (answer?.ok) return;
      if (Date.now() > end) throw new Error(`${name}: daemon did not start within ${READY_MS} ms:\n${await log()}`);
      await delay(250);
    }
  };
  return { name, exec, writeFile, serve, call, hostKeyFingerprint, publicKey, log };
}

let image: Promise<string> | undefined;

/** The machine image for this checkout's server bundle, built once per test process. */
function machineImage(): Promise<string> {
  return (image ??= (async () => {
    const work = await mkdtemp(join(tmpdir(), "orca-machine-"));
    try {
      const bundle = process.env.ORCA_SERVER_BUNDLE ?? (await buildBundle(join(work, "build")));
      const context = join(work, "context");
      await mkdir(context);
      for (const file of ["Dockerfile", "rpc.mjs"]) await copyFile(join(MACHINE_DIR, file), join(context, file));
      await copyFile(bundle, join(context, "bundle.tar.xz"));
      const digest = createHash("sha256")
        .update(await readFile(bundle))
        .update(await readFile(join(MACHINE_DIR, "Dockerfile")))
        .update(await readFile(join(MACHINE_DIR, "rpc.mjs")))
        .digest("hex")
        .slice(0, 16);
      const tag = `orca-machine-test:${digest}`;
      const base = process.env.ORCA_MACHINE_BASE;
      await must(
        "docker",
        [
          "build",
          "-q",
          "--build-arg",
          "BUNDLE=bundle.tar.xz",
          ...(base ? ["--build-arg", `BASE=${base}`] : []),
          "-t",
          tag,
          context,
        ],
        { timeoutMs: 600_000 },
      );
      return tag;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  })());
}

/** Build this checkout's server bundle as the release workflow does (unsigned). Needs `pnpm run build`. */
async function buildBundle(dir: string): Promise<string> {
  const daemon = join(dir, "daemon");
  const out = join(dir, "bundle");
  await mkdir(daemon, { recursive: true });
  await must(
    process.execPath,
    [
      join(repoRoot, "packages", "app", "scripts", "build-daemon.js"),
      "--outfile",
      join(daemon, "orca-daemon.mjs"),
      "--server",
    ],
    { cwd: repoRoot, timeoutMs: 300_000 },
  );
  const version = (JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
  const sha = (await must("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).trim();
  await must(
    "python3",
    [
      join(repoRoot, "tools", "deploy", "server-bundle.py"),
      "assemble",
      "--version",
      version,
      "--sha",
      sha,
      "--node",
      process.execPath,
      "--node-version",
      process.version,
      "--daemon-dir",
      daemon,
      "--out",
      out,
    ],
    { cwd: repoRoot, timeoutMs: 300_000 },
  );
  const archive = (await readdir(out)).find((file) => file.endsWith(".tar.xz"));
  if (!archive) throw new Error("server-bundle.py wrote no archive");
  return join(out, archive);
}

function run(
  command: string,
  args: readonly string[],
  options: { input?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr: signal ? `${stderr}killed by ${signal}` : stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

async function must(
  command: string,
  args: readonly string[],
  options: { input?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const out = await run(command, args, options);
  if (out.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${out.status}): ${out.stderr}`);
  return out.stdout;
}
