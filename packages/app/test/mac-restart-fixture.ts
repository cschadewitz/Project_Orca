/** Synthetic app resources and fresh compiled source children; no installed image, signature, recovery or provider. */
import { fork, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildSync } from "esbuild";
import {
  HelloResultSchema,
  MaintenanceResultSchema,
  RuntimeMaintenanceResultSchema,
  PROTOCOL_VERSION,
  type RuntimeMaintenanceParams,
} from "@orca/protocol";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import { readMacManifest, sha256 } from "../src/main/mac-candidate-manifest.js";
import {
  MacUpdateOwnedStop,
  type MacOwnedStopBoundary,
  type MacRestartProcess,
  type MacRestartRequest,
  type MacRestartPorts,
} from "../src/main/mac-update-restart.js";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
type RuntimeMaintenanceTarget = RuntimeMaintenanceParams["target"];
const fixture = new URL("../../../tools/deploy/tests/native-mac/fixtures/valid/", import.meta.url);
interface Ready {
  kind: "ready";
  url: string;
  tokenFile: string;
  target: RuntimeMaintenanceTarget;
  fenceId: string;
  admissionClosedFromBootstrap: boolean;
}
export class RestartChild {
  readonly child: ChildProcess;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly ready: Promise<Ready>;
  readonly signals: string[] = [];
  private resolveSignal: (() => void) | undefined;
  constructor(entry: string, config: string, workspace: string) {
    this.child = fork(entry, [config], {
      execArgv: [],
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: workspace,
        TMP: workspace,
        TEMP: workspace,
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.closed = new Promise((done) => {
      this.child.once("close", (code, signal) => {
        done({ code, signal });
      });
    });
    this.ready = new Promise((done, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Synthetic startup deadline"));
      }, 10_000);
      this.child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Synthetic spawn failed"));
      });
      this.child.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Synthetic child exited before startup"));
      });
      this.child.on("message", (message: Ready | { kind: "signal"; signal: string }) => {
        if (message.kind === "ready") {
          clearTimeout(timer);
          done(message);
        }
        if (message.kind === "signal") {
          this.signals.push(message.signal);
          this.resolveSignal?.();
        }
      });
    });
  }
  async signalled(): Promise<void> {
    if (this.signals.length) return;
    await new Promise<void>((done) => {
      this.resolveSignal = done;
    });
  }
  async crash(): Promise<void> {
    this.child.send({ action: "crash" });
    await this.closed;
  }
  async cleanup(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.send({ action: "cleanup" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Synthetic cleanup unknown; preserve files"));
          }, 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
export async function restartFixture(options: { ignoreOldTerm?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orca-mac-restart-test-")));
  const children: RestartChild[] = [];
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(
      join(workspace, "flow.yaml"),
      "id: flow\nname: Flow\nversion: '1'\nstart: s\nnodes: {s: {type: start}, e: {type: end}}\nedges: [{from: s, to: e}]\n",
    );
    const entry = join(root, "daemon-source.mjs");
    const result = buildSync({
      absWorkingDir: repo,
      entryPoints: ["packages/app/test/fixtures/mac-restart-daemon.ts"],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      target: `node${process.versions.node}`,
      tsconfig: join(repo, "tsconfig.json"),
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
      external: ["bufferutil", "utf-8-validate"],
      metafile: true,
      logLevel: "silent",
    });
    const controls = [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "tsconfig.base.json",
      ...Object.keys(result.metafile.inputs),
    ];
    const inputs = new Map(controls.map((path) => [resolve(repo, path), sha256(readFileSync(resolve(repo, path)))]));
    const daemonBytes = await readFile(entry);
    const manifest = readMacManifest(await readFile(new URL("delivery/native-mac-artifact.json", fixture)));
    manifest.kind = "candidate";
    manifest.signing.teamId = "Q2FP9UY5T4";
    manifest.identity.protocol = { ...PROTOCOL_VERSION };
    manifest.identity.storeEpoch = "operator-journals-v4";
    manifest.identity.daemon.sha256 = sha256(daemonBytes);
    const identityBytes = Buffer.from(`${JSON.stringify(manifest.identity, null, 2)}\n`);
    manifest.identitySha256 = sha256(identityBytes);
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const candidate = {
      manifestSha256: sha256(manifestBytes),
      channel: "synthetic-invited-beta",
      compatibilityPlanId: "synthetic-compatible",
      recoveryPlanId: "not-implemented",
    };
    const resources = join(root, "synthetic-app-resources");
    await mkdir(resources, { mode: 0o700 });
    const identityPath = join(resources, "orca-build.json");
    const daemonPath = join(resources, "orca-daemon.mjs");
    const appPath = join(resources, "app-image.fixture");
    const appBytes = Buffer.from(
      `Synthetic app/build image: ${manifest.identity.releaseVersion} ${manifest.identity.buildId}\n`,
    );
    await writeFile(identityPath, identityBytes);
    await writeFile(daemonPath, daemonBytes);
    await writeFile(appPath, appBytes);
    const storeEpochPath = join(workspace, "fixture-store-epoch.txt");
    await writeFile(storeEpochPath, manifest.identity.storeEpoch);
    const workspaceId = randomUUID();
    const launch = async (closed: boolean, ignoreTerm = false) => {
      for (const [path, digest] of inputs)
        if (sha256(await readFile(path)) !== digest) throw new Error("Synthetic source changed before fresh process");
      if (sha256(await readFile(entry)) !== sha256(daemonBytes)) throw new Error("Synthetic child binary changed");
      const selectedEntry = closed ? daemonPath : entry;
      if (sha256(await readFile(selectedEntry)) !== sha256(daemonBytes))
        throw new Error("Synthetic selected daemon bytes changed");
      const fenceId = randomUUID();
      const token = closed ? randomUUID() : undefined;
      const config = join(root, `child-${fenceId}.json`);
      await writeFile(
        config,
        JSON.stringify({
          workspace,
          workspaceId,
          version: manifest.identity.releaseVersion,
          fenceId,
          ignoreTerm,
          ...(token ? { token } : {}),
        }),
        { flag: "wx", mode: 0o600 },
      );
      const child = new RestartChild(selectedEntry, config, workspace);
      children.push(child);
      const ready = await child.ready;
      const client = new DaemonClient(ready.url, fetch, {
        requireAuthentication: true,
        auth: new LocalDaemonToken({ url: ready.url, tokenFile: ready.tokenFile, env: {} }),
      });
      return { child, ready, client, token, reopened: false };
    };
    const old = await launch(false, options.ignoreOldTerm);
    let heldReservation = true;
    const stopBoundary: MacOwnedStopBoundary = {
      check: () => heldReservation,
      proof: async (target, signal) => {
        const hello = await old.client.call(
          "hello",
          { client: "synthetic-owned-stop", protocol: PROTOCOL_VERSION },
          HelloResultSchema,
          false,
          signal,
          false,
        );
        if (
          hello.processId !== target.processId ||
          hello.identity?.instanceId !== target.instanceId ||
          hello.identity.workspaceId !== target.workspaceId
        )
          throw new Error("Synthetic stop target changed");
        return old.client.call(
          "maintenance.runtime",
          { action: "prepare", token: "synthetic-update-owner", target },
          RuntimeMaintenanceResultSchema,
          false,
          signal,
          false,
        );
      },
    };
    let replacement: Awaited<ReturnType<typeof launch>> | undefined;
    let managedProcess: MacRestartProcess | undefined;
    const calls: string[] = [];
    const ports: MacRestartPorts = {
      check: () => heldReservation,
      startClosed: async (binding, signal) => {
        calls.push("start");
        if (signal.aborted || binding.storeDir !== join(workspace, ".orca")) return { outcome: "refused" };
        replacement = await launch(true);
        const next = replacement;
        if (!next.ready.admissionClosedFromBootstrap || !next.token) return { outcome: "unknown" };
        const target = next.ready.target;
        managedProcess = {
          child: next.child.child,
          instanceId: target.instanceId,
          fenceId: next.ready.fenceId,
          hello: async (signal) => {
            calls.push("hello");
            return next.client.call(
              "hello",
              { client: "synthetic-replacement-check", protocol: PROTOCOL_VERSION },
              HelloResultSchema,
              false,
              signal,
              false,
            );
          },
          image: async () => {
            calls.push("image");
            return sha256(await readFile(appPath)) !== sha256(appBytes)
              ? { outcome: "refused" }
              : {
                  outcome: "verified",
                  target,
                  manifestSha256: binding.candidate.manifestSha256,
                  wholeAppMatched: true,
                  identityBytes: await readFile(identityPath),
                  daemonSha256: sha256(await readFile(daemonPath)),
                };
          },
          store: async () => {
            calls.push("store");
            return {
              outcome: "observed",
              target,
              directory: await realpath(join(workspace, ".orca")),
              epoch: await readFile(storeEpochPath, "utf8"),
              work: "empty",
            };
          },
          closed: async (signal) => {
            calls.push("closed");
            if (next.reopened) return { outcome: "unknown" };
            const held = await next.client.call(
              "maintenance",
              { action: "prepare", token: next.token },
              MaintenanceResultSchema,
              false,
              signal,
              false,
            );
            if (!held.ready || held.active.length) return { outcome: "unknown" };
            return { outcome: "closed", target, fenceId: next.ready.fenceId };
          },
        };
        return { outcome: "started", process: managedProcess };
      },
    };
    return {
      root,
      workspace,
      old,
      ports,
      stopBoundary,
      calls,
      candidate,
      manifestBytes,
      manifest,
      identityPath,
      daemonPath,
      appPath,
      storeEpochPath,
      reservation: (value: boolean) => {
        heldReservation = value;
      },
      replacement: () => replacement,
      process: () => managedProcess!,
      stop: (ms = 10_000) => new MacUpdateOwnedStop(old.child.child, old.ready.target, stopBoundary, ms),
      request: (stopped: MacRestartRequest["stopped"]): MacRestartRequest => ({
        stopped,
        candidate,
        manifestBytes,
        storeDir: join(workspace, ".orca"),
        capabilities: ["runs.read", "runs.control"],
        methods: ["hello", "maintenance", "maintenance.runtime", "runs.start"],
      }),
      // Explicit test action after fresh verification; never exported into production main.
      simulateReopen: async () => {
        if (!replacement?.token) throw new Error("No synthetic replacement owner");
        await replacement.client.call(
          "maintenance",
          { action: "resume", token: replacement.token },
          MaintenanceResultSchema,
          false,
          undefined,
          false,
        );
        replacement.reopened = true;
      },
      cleanup: async () => {
        for (const child of children) await child.cleanup();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const child of children) await child.cleanup();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
