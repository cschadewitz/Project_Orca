/**
 * The bundled daemon: finding it inside a packaged app, starting it on a port nothing else
 * is using, and stopping it when the app goes.
 *
 * A packaged desktop build ships `orca serve` as a single JavaScript file beside the app
 * (`packages/app/scripts/build-daemon.js` writes it, electron-builder copies it into the
 * app's resources) and runs it as a *subprocess*, never as an import: `packages/app` may
 * only import `@orca/protocol` and `@orca/design` from the workspace (ADR 0008), and the
 * daemon's own dependency graph — the engine, the stores, the agents — is exactly what
 * that boundary exists to keep out of the app. A subprocess also means the app can attach
 * to a daemon it did not start, which is what `ORCA_DAEMON_URL` is for.
 *
 * There is no `electron` import here on purpose. Everything Electron knows and this module
 * needs — where the resources are, which workspace to serve — arrives as an argument, so
 * the whole thing is a plain Node module with a plain test (`test/daemon-process.test.ts`).
 * `src/main/index.ts` is the only file that supplies the Electron half.
 *
 * Three things break in the field and each has a seam and a test: **port selection** (the
 * port is free when we ask the OS and can be taken before the daemon binds, so a failed
 * start is retried on a fresh one), **failure to start** (the child dying, or never
 * answering, must surface as an error carrying its output rather than as a hang), and
 * **shutdown** (`SIGTERM`, then `SIGKILL` if it is ignored, and never a stray daemon
 * outliving the window that started it).
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { DaemonClient } from "../client/daemon-client.js";
import { LocalDaemonToken } from "../client/auth.js";
import { MacUpdateOwnedStop, type MacOwnedStopBoundary, type MacOwnedStopResult } from "./mac-update-restart.js";
import type { RuntimeMaintenanceParams } from "@orca/protocol";
import { observeStartup, type StartupDiagnosticObserver } from "./diagnostics/startup-producer.js";

/** Where `scripts/build-daemon.js` writes the bundle and electron-builder copies it to. */
export const BUNDLED_DAEMON_DIR = "daemon";
/** ESM, because the bundle is: the extension is what makes Node read it as a module. */
export const BUNDLED_DAEMON_FILE = "orca-daemon.mjs";

/** Loopback. The bundled daemon is this machine's, and nothing else may reach it. */
const DEFAULT_HOST = "127.0.0.1";

/** The child processes this module drives, as much of one as it uses. */
export type DaemonChild = Pick<
  ChildProcess,
  "pid" | "exitCode" | "signalCode" | "stdout" | "stderr" | "kill" | "on" | "once"
>;

/** `node:child_process`'s `spawn`, narrowed to the one call shape used here. */
export type SpawnDaemon = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
) => DaemonChild;

/** How a daemon process ended. `code` and `signal` are the child's, one of them non-null. */
export interface DaemonExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The tail of what it wrote to stdout and stderr — the only diagnosis there is. */
  output: string;
}

/** A daemon this app started, and owns until `stop()`. */
export interface BundledDaemon {
  /** What to hand `DaemonClient`: `http://host:port`. */
  readonly url: string;
  readonly pid: number | undefined;
  /** Direct-child terminal evidence. Ordinary stop timeout alone is not this evidence. */
  readonly exited?: boolean;
  /** The safe startup metadata, never the credential itself. */
  readonly tokenFile?: string;
  /** Main-only captured child for closed validation; never an IPC capability. */
  readonly child?: DaemonChild;
  /**
   * Ordinary bounded shutdown, with forced escalation. Never reports its own exit
   * through onExit and never establishes clean updater-stop evidence. An existing
   * updater attempt is not escalated; its unknown result remains owned.
   */
  stop(): Promise<void>;
  /** Main-only capability over this exact child. Never escalates or reopens admission. */
  stopForMacUpdate?: (
    this: void,
    target: RuntimeMaintenanceParams["target"],
    boundary: MacOwnedStopBoundary,
    operationMs: number,
    signal: AbortSignal,
  ) => Promise<MacOwnedStopResult>;
}

export interface BundledDaemonOptions {
  /** Absolute path to the daemon bundle, from `findBundledDaemon`. */
  entry: string;
  /**
   * The workspace to serve: the daemon reads `<cwd>/.orca` unless an `orca.config.yaml`
   * above it says otherwise. Which workspace that is belongs to `src/main/workspace.ts`,
   * which can change it while the app runs (#164); the daemon tolerates a directory with
   * no config and no store, serving an empty run list rather than failing.
   */
  cwd: string;
  /** `orca --config <file>`, when the workspace's config is not found by walking up. */
  configPath?: string;
  /** Main-only first-run launch capability; never inherited for unrelated children. */
  firstRunToken?: string;
  /** Closed replacement child keeps its ownership on failed/late startup; never force-killed. */
  closedUpdate?: { attempt: string; token: string };
  onChild?: (child: DaemonChild) => void;
  host?: string;
  /**
   * Extra arguments, appended after `serve`. The seam for flags the app passes —
   * `--read-only`, which is what file mode is (#164) — so that growing the command line
   * never means growing this signature.
   */
  args?: readonly string[];
  /**
   * The Node that runs the bundle. In a packaged app it is `process.execPath`, the Electron
   * binary, which runs as a plain Node when `ELECTRON_RUN_AS_NODE` is set — that way the
   * artifact carries one runtime rather than two.
   */
  execPath?: string;
  /** Base environment for the child; `ELECTRON_RUN_AS_NODE=1` is added to it. */
  env?: NodeJS.ProcessEnv;
  /**
   * Ask this launch's daemon to switch the workspace's store to SQLite in place, under the
   * workspace's writer fence, before it opens the store (#339, cli/src/desktop-sqlite-switch.ts).
   * Never set on a closed update launch; never inherited from `env`.
   */
  storeSwitch?: "sqlite";
  /** How long to wait for the first answered `hello` before giving up on an attempt. */
  startTimeoutMs?: number;
  /** How often to ask. */
  pollIntervalMs?: number;
  /** How many ports to try. A port lost to a race is the only failure worth retrying. */
  attempts?: number;
  /** How long `stop()` waits after `SIGTERM` before it stops asking. */
  stopTimeoutMs?: number;
  /** Called when the daemon exits on its own. `stop()` does not trigger it. */
  onExit?: (exit: DaemonExit) => void;
  /** Called with every line the daemon writes, while it runs. */
  onLog?: (line: string) => void;
  /** Optional closed local facts; never receives output, errors, paths or credentials. */
  onStartupDiagnostic?: StartupDiagnosticObserver;
  /* -- seams, for the test -- */
  spawn?: SpawnDaemon;
  findPort?: (host: string) => Promise<number>;
  /** True when a daemon at `url` answered `hello`; false when it is not listening yet. */
  probe?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A daemon that never came up, carrying what it said on the way down. */
export class DaemonStartError extends Error {
  override readonly name = "DaemonStartError";
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(output ? `${message}\n${output}` : message);
  }
}

/**
 * The daemon bundle under the first of `roots` that has one, or undefined.
 *
 * Two roots matter. In a packaged app it is `process.resourcesPath` — electron-builder's
 * `extraResources` puts the bundle beside `app.asar`, unpacked, because a file inside an
 * asar archive cannot be spawned. In a build run from the repository it is `dist/`, where
 * `pnpm --filter @orca/app run build:daemon` writes it. Neither existing is the ordinary
 * development case, and the answer there is undefined: the app then talks to whatever
 * `orca serve` the developer is already running.
 */
export function findBundledDaemon(
  roots: readonly (string | undefined)[],
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  for (const root of roots) {
    if (!root) continue;
    const candidate = join(root, BUNDLED_DAEMON_DIR, BUNDLED_DAEMON_FILE);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** A port the OS says is free, on this host, right now. */
async function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("the OS gave no port back")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** `hello` over HTTP: the same handshake the app's own client opens with. */
async function helloAnswers(url: string, cwd: string, tokenFile?: string): Promise<boolean> {
  try {
    const auth = new LocalDaemonToken({ url, workspace: cwd, ...(tokenFile ? { tokenFile } : {}), env: {} });
    await new DaemonClient(url, fetch, { auth }).hello("orca-app/startup");
    return true;
  } catch {
    // The server or its startup metadata may not have arrived yet. No token is logged.
    return false;
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The last of what the daemon said, bounded so a chatty daemon cannot grow without end. */
class OutputTail {
  private readonly lines: string[] = [];
  private partial = "";

  constructor(
    private readonly limit: number,
    private readonly onLog?: (line: string) => void,
  ) {}

  push(chunk: string): void {
    this.partial += chunk;
    const parts = this.partial.split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.onLog?.(line);
      this.lines.push(line);
      if (this.lines.length > this.limit) this.lines.shift();
    }
  }

  toString(): string {
    return [...this.lines, this.partial].filter((l) => l !== "").join("\n");
  }
}

/**
 * Start the bundled daemon and wait until it answers, or throw a `DaemonStartError` saying
 * what it did instead.
 *
 * A port is free when the OS hands it over and can be taken by anything else before the
 * daemon binds it, so a failed attempt is retried on a fresh port rather than reported: the
 * race is rare, real, and indistinguishable from the daemon being broken until the second
 * attempt fails the same way.
 */
export async function startBundledDaemon(options: BundledDaemonOptions): Promise<BundledDaemon> {
  if (options.closedUpdate && (!options.args?.includes("--read-only") || !options.args.includes("--no-resume")))
    throw new DaemonStartError("Closed validation requires read-only startup without resume", "");
  const attempts = options.closedUpdate ? 1 : (options.attempts ?? 3);
  let failure: DaemonStartError | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await startOnce(options);
    } catch (e) {
      if (!(e instanceof DaemonStartError)) throw e;
      failure = e;
    }
  }
  throw failure ?? new DaemonStartError(`the bundled daemon was never started (attempts: ${attempts})`, "");
}

async function startOnce(options: BundledDaemonOptions): Promise<BundledDaemon> {
  const {
    entry,
    cwd,
    configPath,
    host = DEFAULT_HOST,
    args = [],
    execPath = process.execPath,
    env = process.env,
    startTimeoutMs = 30_000,
    pollIntervalMs = 150,
    stopTimeoutMs = 5_000,
    onExit,
    onLog,
    spawn = nodeSpawn,
    findPort = freePort,
    probe,
    sleep = wait,
    now = Date.now,
  } = options;

  const port = await findPort(host);
  const url = `http://${host}:${port}`;
  const argv = [
    entry,
    "--cwd",
    cwd,
    ...(configPath ? ["--config", configPath] : []),
    "serve",
    "--host",
    host,
    "--port",
    String(port),
    ...args,
  ];

  let child: DaemonChild;
  try {
    child = spawn(execPath, argv, {
      cwd,
      // `ELECTRON_RUN_AS_NODE` is what makes `process.execPath` — the Electron binary in a
      // packaged app — behave as a bare Node and never open a window of its own.
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        ORCA_FIRST_RUN_LAUNCH: options.firstRunToken,
        ORCA_STORE_SWITCH: options.closedUpdate ? undefined : options.storeSwitch,
        ORCA_UPDATE_ATTEMPT: options.closedUpdate?.attempt,
        ORCA_UPDATE_LAUNCH: options.closedUpdate?.token,
        ORCA_MANAGED_UPDATE_CONTROL: options.closedUpdate ? undefined : env.ORCA_MANAGED_UPDATE_CONTROL,
        ORCA_MANAGED_UPDATE_ADDON: options.closedUpdate ? undefined : env.ORCA_MANAGED_UPDATE_ADDON,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    observeStartup(options.onStartupDiagnostic, "startup_spawn_failed");
    throw error;
  }
  options.onChild?.(child);

  let tokenFile: string | undefined;
  const tail = new OutputTail(200, (line) => {
    const prefix = "authentication: token; local token file: ";
    if (line.startsWith(prefix)) {
      const path = line.slice(prefix.length);
      if (isAbsolute(path)) tokenFile = path;
    }
    onLog?.(line);
  });
  child.stdout?.on("data", (d: Buffer) => tail.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => tail.push(d.toString()));

  let exit: DaemonExit | undefined;
  let stopping = false;
  let updateStop: Promise<MacOwnedStopResult> | undefined;
  let updateTarget: RuntimeMaintenanceParams["target"] | undefined;
  let settled = false;
  let startupObserved = false;
  const observeFailure = (code: Parameters<StartupDiagnosticObserver>[0]) => {
    if (settled || startupObserved) return;
    startupObserved = true;
    observeStartup(options.onStartupDiagnostic, code);
  };
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exit = { code, signal, output: tail.toString() };
      observeFailure("startup_exited_before_handshake");
      if (settled && !stopping) onExit?.(exit);
      resolve();
    });
  });
  // A command that cannot be spawned at all (no such file, not executable) emits `error`
  // and, on some platforms, no `exit` — so it is recorded as one.
  child.on("error", (e: Error) => {
    observeFailure("startup_spawn_failed");
    exit ??= { code: null, signal: null, output: `${tail.toString()}\n${e.message}`.trim() };
  });

  const died = (e: DaemonExit): DaemonStartError =>
    new DaemonStartError(`the bundled daemon ${describeExit(e)} before it answered hello`, e.output);

  const deadline = now() + startTimeoutMs;
  for (;;) {
    if (exit) throw died(exit);
    // A recovered store can still authenticate the previous bootstrap token while startup rotates it.
    // Wait for this owned child to announce finished credential bootstrap before accepting hello.
    if (
      (!options.firstRunToken || tokenFile === join(cwd, "auth", "local-client.token")) &&
      (await (probe ? probe(url) : helloAnswers(url, cwd, tokenFile)))
    )
      break;
    if (now() >= deadline) {
      observeFailure("startup_handshake_timeout");
      const output = tail.toString();
      if (!options.closedUpdate) child.kill("SIGKILL");
      throw new DaemonStartError(
        `the bundled daemon did not answer hello on ${url} within ${startTimeoutMs}ms`,
        output,
      );
    }
    await sleep(pollIntervalMs);
  }
  // It answered, so anything after this point is a daemon that died on its own and is
  // `onExit`'s news. Checking once more closes the gap between the answer and that line.
  settled = true;
  if (exit) throw died(exit);

  return {
    url,
    child,
    pid: child.pid,
    get exited() {
      return child.exitCode !== null || child.signalCode !== null;
    },
    ...(tokenFile ? { tokenFile } : {}),
    stopForMacUpdate: (target, boundary, operationMs, signal) => {
      if (updateStop) {
        if (
          target.workspaceId !== updateTarget?.workspaceId ||
          target.instanceId !== updateTarget.instanceId ||
          target.processId !== updateTarget.processId
        )
          return Promise.resolve({ outcome: "unknown" });
        return updateStop;
      }
      if (stopping) return Promise.resolve({ outcome: "refused" });
      // Reserve before callbacks: ordinary quit must never escalate an updater attempt.
      stopping = true;
      updateTarget = Object.freeze({ ...target });
      return (updateStop = Promise.resolve().then(async () => {
        try {
          return await new MacUpdateOwnedStop(child, updateTarget!, boundary, operationMs).stop(signal);
        } catch {
          return { outcome: "unknown" };
        }
      }));
    },
    stop: async () => {
      if (updateStop) return; // Unknown updater stop stays owned; no quit-time SIGKILL.
      if (exit) return;
      stopping = true;
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(stopTimeoutMs)]);
      if (exit) return;
      if (options.closedUpdate) return; // Retain an uncertain captured child; no escalation.
      // It ignored the signal, or is wedged. The store is the daemon's only durable state
      // and it only ever reads it, so there is nothing here worth waiting longer for.
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(stopTimeoutMs)]);
    },
  };
}

function describeExit(exit: DaemonExit): string {
  if (exit.signal) return `was killed by ${exit.signal}`;
  if (exit.code === null) return "could not be started";
  return `exited with code ${exit.code}`;
}
