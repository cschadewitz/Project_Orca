/** Test-only pre-restart composition; real updater/runtime components, disposable state and OS ports. */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { BrowserWindow, IpcMain } from "electron";
import { vi, type Mock } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { runtimeMaintenanceFixture, barrier } from "../../daemon/test/runtime-maintenance-fixture.js";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import type { OrcaBridge } from "../src/bridge.js";
import { Workspace } from "../src/main/workspace.js";
import { MacUpdateWindows } from "../src/main/mac-update-windows.js";
import { MacUpdateGuards } from "../src/main/mac-update-guards.js";
import { MacUpdates, type MacUpdatePorts, type MacUpdateTarget } from "../src/main/mac-updates.js";
import { MacCandidateSession } from "../src/main/mac-update-candidates.js";
import {
  downloadMacCandidate,
  type MacCandidateBinding,
  type MacCandidateDownloadPorts,
  type MacNativeInspection,
  type MacOwnedDownload,
} from "../src/main/mac-candidate-download.js";
import { freezeMacMetadata, readMacManifest, sha256 } from "../src/main/mac-candidate-manifest.js";

export { barrier };
const preload = stripTypeScriptTypes(
  readFileSync(new URL("../src/preload/index.cts", import.meta.url), "utf8").replace(
    'import electron = require("electron");',
    'const electron = require("electron");',
  ),
);
const artifacts = new URL("../../../tools/deploy/tests/native-mac/fixtures/valid/", import.meta.url);
export type ProofFault = "lost" | "proof" | "pid" | "instance" | "active";
interface RehearsalWindow {
  messages: { nonce: string; generation: number; phase: string }[];
  freezeOrder: boolean[];
  enabled(): boolean;
  frozen(): boolean;
  dirty(value: boolean): void;
  auto(value: boolean): void;
  dropRelease(): void;
  forward(): void;
  ack(value: unknown, senderFrame?: unknown): void;
  replace(): void;
}
export interface MacUpdateRehearsal extends Pick<
  Awaited<ReturnType<typeof runtimeMaintenanceFixture>>,
  "call" | "runtime"
> {
  close(): Promise<void>;
  workspace: Workspace;
  target: MacUpdateTarget;
  stop: Mock<() => Promise<void>>;
  windows: MacUpdateWindows;
  guards: MacUpdateGuards;
  a: RehearsalWindow;
  b: RehearsalWindow;
  ipc: EventEmitter;
  created: Mock<() => void>;
  binding: MacCandidateBinding;
  bytes: Buffer;
  catalog: Mock<() => Promise<"trusted">>;
  inspect: Mock<() => Promise<MacNativeInspection>>;
  downloadFetch: Mock<(url: string) => Promise<Response>>;
  owned: MacOwnedDownload[];
  verification: string[];
  updates: MacUpdates;
  session: MacCandidateSession;
  validated: ReturnType<typeof barrier>;
  finishValidation: ReturnType<typeof barrier>;
  revalidate: Mock<() => Promise<"unknown">>;
  activate: Mock<() => Promise<never>>;
  download: Mock<MacUpdatePorts["download"]>;
  prepareDrafts: Mock<MacUpdateGuards["prepareDrafts"]>;
  ownRelease(release: () => void): void;
  fault(value: ProofFault): void;
  beforePrepare(hook: () => void): void;
  afterPrepare(hook: () => Promise<void>): void;
  failRelease(): void;
  runtimeEvents: { action: string; outcome?: string }[];
  present(): string;
  discard(): Promise<void>;
  statePreserved(): Promise<boolean>;
  downloadEntries(): Promise<string[]>;
}
export async function macUpdateRehearsal(): Promise<MacUpdateRehearsal> {
  const root = await mkdtemp(join(tmpdir(), "orca-mac-update-rehearsal-"));
  const f = await runtimeMaintenanceFixture().catch(async (error: unknown) => {
    await rm(root, { recursive: true, force: true });
    throw error;
  });
  const releases: (() => void)[] = [];
  let workspace: Workspace | undefined;
  let restoreTransport: (() => void) | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const release of releases.splice(0)) release();
    restoreTransport?.();
    // Dispose only this in-process fixture. No resume, real process stop or force-kill.
    try {
      await workspace?.close();
    } finally {
      try {
        await f.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
  try {
    const downloadRoot = join(root, "downloads");
    await mkdir(downloadRoot, { mode: 0o700 });
    const preserved = new Map<string, Buffer>([
      [join(f.dir, "flow.yaml"), await readFile(join(f.dir, "flow.yaml"))],
      [join(root, "preferences.json"), Buffer.from('{"density":"compact"}\n')],
      [join(root, "draft.txt"), Buffer.from("Synthetic unsent user draft\n")],
      [join(f.dir, ".orca", "rehearsal-protected-state"), Buffer.from("Synthetic retained state\n")],
    ]);
    for (const [path, bytes] of preserved) await writeFile(path, bytes, { mode: 0o600 });
    const tokenFile = join(root, "owner.token");
    // Only the existing fixture's ephemeral in-memory authentication. No host credentials.
    await writeFile(tokenFile, f.owner.token, { mode: 0o600 });
    const stop = vi.fn(async () => {});
    const runtimeEvents: { action: string; outcome?: string }[] = [];
    let proofFault: ProofFault | undefined;
    let beforePrepare: (() => void) | undefined;
    let afterPrepare: (() => Promise<void>) | undefined;
    let releaseFailure = false;
    const actualFetch = globalThis.fetch;
    const transport: typeof fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: { action?: string } };
      if (request.method !== "maintenance.runtime") return actualFetch(input, init);
      const action = request.params.action!;
      runtimeEvents.push({ action });
      // Never reopen fixture admission. A release attempt can only fail before dispatch.
      if (action === "resume") {
        if (releaseFailure) throw new Error("Synthetic release transport failure");
        throw new Error("Rehearsal stops before admission reopening");
      }
      beforePrepare?.();
      const response = await actualFetch(input, init);
      const envelope = (await response.json()) as {
        result: { proof: string; outcome: string; active: string[]; target: { processId: number; instanceId: string } };
      };
      runtimeEvents.at(-1)!.outcome = envelope.result.outcome;
      await afterPrepare?.();
      if (proofFault === "lost") throw new Error("Synthetic response loss after actual acquisition");
      if (proofFault === "proof") envelope.result.proof = "legacy";
      if (proofFault === "pid") envelope.result.target.processId++;
      if (proofFault === "instance") envelope.result.target.instanceId = "00000000-0000-4000-8000-000000000001";
      if (proofFault === "active") envelope.result.active = ["dispatch"];
      return new Response(JSON.stringify(envelope), { status: response.status });
    };
    // Workspace deliberately constructs its authenticated guard client with global fetch.
    // Scope this fault boundary to the fixture and restore it during owned cleanup.
    const transportSpy = vi.spyOn(globalThis, "fetch").mockImplementation(transport);
    restoreTransport = () => transportSpy.mockRestore();
    workspace = new Workspace({
      findEntry: () => "disposable-in-process-rehearsal",
      start: async () => ({ url: f.daemon.url, pid: process.pid, tokenFile, stop }),
      client: (url) =>
        new DaemonClient(url, transport, {
          requireAuthentication: true,
          auth: new LocalDaemonToken({ url, tokenFile, env: {} }),
        }),
      subscribe: () => ({ close: () => {} }) as unknown as DaemonSubscription,
      onSwitch: () => {},
      onSnapshot: () => {},
      onDaemonGone: () => {},
      defaultUrl: f.daemon.url,
      defaultPath: () => f.dir,
    });
    await workspace.connect();
    workspace.observeHello(workspace.client, {
      identity: f.identity,
      processId: process.pid,
      protocol: PROTOCOL_VERSION,
      orcaVersion: "fixture",
      capabilities: [],
    });
    const target = Object.freeze({ ...f.identity, epoch: workspace.connectionTarget.epoch });
    const ipc = new EventEmitter();
    const all: BrowserWindow[] = [];
    const created = vi.fn();
    const windows = new MacUpdateWindows({
      windows: () => all,
      ipc: ipc as unknown as IpcMain,
      createDeferred: created,
    });
    const makeWindow = (id: number, initiallyEnabled = true) => {
      const renderer = new EventEmitter();
      let enabled = initiallyEnabled;
      let frozen = false;
      let dirty = false;
      let auto = true;
      let dropRelease = false;
      const messages: { nonce: string; generation: number; phase: string }[] = [];
      const contents = Object.assign(new EventEmitter(), {
        id,
        mainFrame: { processId: id, routingId: 1 },
        isDestroyed: () => false,
        isLoadingMainFrame: () => false,
        setWindowOpenHandler: vi.fn(),
        send: (channel: string, message: (typeof messages)[number]) => {
          messages.push(message);
          if (auto && !(dropRelease && message.phase === "release")) renderer.emit(channel, {}, message);
        },
      });
      const native = Object.assign(new EventEmitter(), {
        webContents: contents,
        isDestroyed: () => false,
        isEnabled: () => enabled,
        setEnabled: (value: boolean) => {
          enabled = value;
        },
      });
      all.push(native as unknown as BrowserWindow);
      windows.track(native as unknown as BrowserWindow);
      let bridge!: OrcaBridge;
      runInNewContext(preload, {
        exports: {},
        process: { platform: "darwin" },
        require: () => ({
          ipcRenderer: Object.assign(renderer, {
            sendSync: () => ({ epoch: target.epoch }),
            send: (channel: string, value: unknown) =>
              ipc.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, value),
            invoke: async () => ({ ok: true, result: {} }),
          }),
          contextBridge: {
            exposeInMainWorld: (_name: string, value: OrcaBridge) => {
              bridge = value;
            },
          },
        }),
      });
      const freezeOrder: boolean[] = [];
      const unsubscribe = bridge.updates.prepare((locked) => {
        if (locked) freezeOrder.push(!enabled);
        frozen = locked;
        return !locked || !dirty;
      });
      return {
        contents,
        native,
        renderer,
        messages,
        freezeOrder,
        unsubscribe,
        enabled: () => enabled,
        frozen: () => frozen,
        dirty: (value: boolean) => {
          dirty = value;
        },
        auto: (value: boolean) => {
          auto = value;
        },
        dropRelease: () => {
          dropRelease = true;
        },
        forward: () => renderer.emit("orca:macUpdate.prepare", {}, messages.at(-1)),
        ack: (value: unknown, senderFrame: unknown = contents.mainFrame) =>
          ipc.emit("orca:macUpdate.prepared", { sender: contents, senderFrame }, value),
        replace: () => {
          contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
          contents.mainFrame = { processId: id, routingId: 2 };
        },
      };
    };
    const a = makeWindow(1);
    const b = makeWindow(2, false);
    const guards = new MacUpdateGuards(workspace, windows);
    const manifest = readMacManifest(await readFile(new URL("delivery/native-mac-artifact.json", artifacts)));
    // Synthetic candidate-shaped data, identical to the reviewed candidate test approach.
    manifest.kind = "candidate";
    manifest.signing.teamId = "Q2FP9UY5T4";
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const binding: MacCandidateBinding = freezeMacMetadata({
      manifest,
      source: "https://delivery.invalid/rehearsal/",
      candidate: {
        manifestSha256: sha256(bytes),
        channel: "synthetic-beta",
        compatibilityPlanId: "synthetic-compatibility",
        recoveryPlanId: "synthetic-recovery-reference",
      },
    });
    const identityBytes = await readFile(new URL("ORCA.app/Contents/Resources/orca-build.json", artifacts));
    const files = new Map<string, Buffer>();
    for (const record of [...manifest.artifacts, ...manifest.evidence])
      files.set(record.path, await readFile(new URL(`delivery/${record.path}`, artifacts)));
    files.set(
      "SHA256SUMS",
      Buffer.from(
        [
          ["native-mac-artifact.json", sha256(bytes)],
          ...[...manifest.artifacts, ...manifest.evidence].map((file) => [file.path, file.sha256]),
        ]
          .sort(([a], [b]) => Buffer.compare(Buffer.from(a!), Buffer.from(b!)))
          .map(([path, hash]) => `${hash}  ${path}\n`)
          .join(""),
      ),
    );
    const catalog = vi.fn(async () => "trusted" as const);
    const inspect = vi.fn(async (): Promise<MacNativeInspection> => ({
      outcome: "verified",
      manifestSha256: binding.candidate.manifestSha256,
      copies: ["dmg", "zip"].map((format) => ({
        format: format as "dmg" | "zip",
        identityBytes,
        daemonSha256: manifest.identity.daemon.sha256,
      })),
    }));
    const downloadFetch = vi.fn(async (url: string) => {
      const path = new URL(url).pathname
        .slice(new URL(binding.source).pathname.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      const response = new Response(new Uint8Array(files.get(path)!).buffer);
      Object.defineProperty(response, "url", { value: url });
      return response;
    });
    const ports: MacCandidateDownloadPorts = {
      root: downloadRoot,
      limits: { fileBytes: 100_000, totalBytes: 1_000_000, operationMs: 10_000 },
      trust: { catalog, inspect },
      fetch: downloadFetch,
    };
    const owned: MacOwnedDownload[] = [];
    const verification: string[] = [];
    const validated = barrier();
    const finishValidation = barrier();
    releases.push(finishValidation.release);
    const revalidate = vi.fn(async () => {
      validated.release();
      await finishValidation.promise;
      // Complete-state recovery/native activation are absent: never assert valid or activate.
      return "unknown" as const;
    });
    const activate = vi.fn(async () => {
      throw new Error("Activation is outside this rehearsal");
    });
    const download = vi.fn<MacUpdatePorts["download"]>(async (candidate, signal) => {
      const result = await downloadMacCandidate({ ...binding, candidate }, bytes, ports, signal);
      verification.push(result.outcome);
      if (result.outcome === "verified") owned.push(result.owned);
      return result.outcome === "verified" ? ("verified" as const) : ("failed" as const);
    });
    const prepareDrafts = vi.fn(() => guards.prepareDrafts());
    const updates = new MacUpdates({
      download,
      prepareDrafts,
      prepareAdmission: (target, token) => guards.prepareAdmission(target, token),
      revalidate,
      activate,
    });
    const session = new MacCandidateSession(ports);
    const result = {
      call: f.call,
      runtime: f.runtime,
      close,
      workspace,
      target,
      stop,
      windows,
      guards,
      a,
      b,
      ipc,
      created,
      binding,
      bytes,
      catalog,
      inspect,
      downloadFetch,
      owned,
      verification,
      updates,
      session,
      validated,
      finishValidation,
      revalidate,
      activate,
      download,
      prepareDrafts,
      ownRelease: (release: () => void) => {
        releases.push(release);
      },
      fault: (value: ProofFault) => {
        proofFault = value;
      },
      beforePrepare: (hook: () => void) => {
        beforePrepare = hook;
      },
      afterPrepare: (hook: () => Promise<void>) => {
        afterPrepare = hook;
      },
      failRelease: () => {
        releaseFailure = true;
      },
      runtimeEvents,
      present: () => {
        const id = updates.present(binding.candidate, target);
        if (!id) throw new Error("Rehearsal offer unavailable");
        return id;
      },
      discard: async () => {
        for (const value of owned.splice(0)) {
          if ((await value.discard()) !== "released") throw new Error("Rehearsal download cleanup unknown");
        }
      },
      statePreserved: async () => {
        for (const [path, expected] of preserved) {
          if (!(await readFile(path)).equals(expected)) return false;
        }
        return true;
      },
      downloadEntries: () => readdir(downloadRoot),
    };
    return result;
  } catch (error) {
    await close();
    throw error;
  }
}
