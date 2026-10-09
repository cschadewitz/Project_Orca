/** Main-only production bindings to the existing native validator and owned supervisor.
 * Independent catalog policy is still an input; no trust, consent or activation default. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { RuntimeMaintenanceTargetSchema } from "@orca/protocol";
import { DaemonClient } from "../client/daemon-client.js";
import { LocalDaemonToken } from "../client/auth.js";
import { startBundledDaemon, type DaemonChild } from "./daemon-process.js";
import { createSafeStorageKeyAdapter } from "./diagnostics/native-adapter.js";
import { AdmissionIntents, type IntentEncryption } from "./admission-intents.js";
import { matchesSealedMacIdentity, readMacManifest, sha256 } from "./mac-candidate-manifest.js";
import {
  macAbortable,
  macBounded,
  type MacCandidateBinding,
  type MacNativeInspection,
} from "./mac-candidate-download.js";
import type { FixedStartupIdentity } from "./mac-fixed-path-recovery.js";
import type { MacRestartProcess } from "./mac-update-restart.js";

/** The existing #583 policy, independently accepted by the eventual catalog owner. */
export interface MacNativePolicyRecord {
  readonly manifestBytes: Uint8Array;
  readonly policy: unknown;
}
export type MacNativePolicyResolver = (
  manifestSha256: string,
  signal: AbortSignal,
) => Promise<MacNativePolicyRecord | undefined>;
export interface ManagedMacNativeProviders {
  binaryRoot(): string | undefined;
  inspect(
    binding: MacCandidateBinding,
    directory: string,
    policy: MacNativePolicyResolver,
    signal: AbortSignal,
  ): Promise<MacNativeInspection>;
  verifyBinary(
    path: string,
    manifestSha256: string,
    policy: MacNativePolicyResolver,
    signal: AbortSignal,
  ): Promise<boolean>;
  continuity(signal: AbortSignal): Promise<string>;
  startClosed(
    identity: FixedStartupIdentity,
    permit: { attempt: string; token: string },
    policy: MacNativePolicyResolver,
    signal: AbortSignal,
  ): Promise<MacRestartProcess | undefined>;
  stopClosed(signal: AbortSignal): Promise<boolean>;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const encoded = z
  .string()
  .max(32768)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const copy = z.strictObject({ identityBase64: encoded, daemonSha256: digest });
const imageProof = copy.extend({ outcome: z.literal("verified"), manifestSha256: digest });
const candidateProof = z.strictObject({
  outcome: z.literal("verified"),
  manifestSha256: digest,
  copies: z.array(copy.extend({ format: z.enum(["dmg", "zip"]) })).length(2),
});
const startupReceipt = z.strictObject({
  version: z.literal(1),
  target: RuntimeMaintenanceTargetSchema,
  fenceId: z.uuid(),
  directory: z.string().max(4096),
  epoch: z.string().min(1).max(128),
  work: z.enum(["empty", "parked", "unsupported-generation"]),
});
const unavailable = () => new Error("Native continuity unavailable");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const canonical = (path: string) => isAbsolute(path) && resolve(path) === path;
const alive = (child: DaemonChild | undefined) => !!child?.pid && child.exitCode === null && child.signalCode === null;
function identityBytes(text: string): Buffer {
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text || bytes.length > 16384) throw unavailable();
  return bytes;
}
async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !canonical(path) ||
    (await realpath(path)) !== path ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw unavailable();
}
async function privateBytes(path: string, limit: number): Promise<Buffer | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return undefined;
    throw unavailable();
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size < 1 ||
      info.size > limit
    )
      throw unavailable();
    const bytes = await file.readFile();
    const final = await file.stat(),
      named = await lstat(path);
    if (
      bytes.length !== info.size ||
      final.size !== info.size ||
      final.mtimeMs !== info.mtimeMs ||
      named.dev !== info.dev ||
      named.ino !== info.ino ||
      named.isSymbolicLink()
    )
      throw unavailable();
    return bytes;
  } finally {
    await file.close();
  }
}

/** Python only orchestrates the already bounded #583 native tools. Do not kill this
 * process on cancellation: it must detach its owned read-only image before settling.
 * Output is bounded and discarded on cancellation; raw errors/paths never enter IPC. */
async function executeNative(helper: string, request: unknown, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return { outcome: "unknown" };
  // Avoid /usr/bin/python3's developer-tools installer shim. Reuse an already
  // installed native validator executor; absence is unknown and never prompts setup.
  const interpreter = "/Library/Developer/CommandLineTools/usr/bin/python3";
  try {
    const info = await lstat(interpreter);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) return { outcome: "unknown" };
  } catch {
    return { outcome: "unknown" };
  }
  if (signal.aborted) return { outcome: "unknown" };
  return new Promise((done) => {
    const child = spawn(interpreter, ["-B", helper], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      size = 0,
      errorSize = 0,
      invalid = false;
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 131072) invalid = true;
      else output += bytes.toString("utf8");
    });
    child.stderr.on("data", (bytes: Buffer) => {
      errorSize += bytes.length;
      if (errorSize > 16384) invalid = true;
    });
    child.once("error", () => {
      invalid = true;
    });
    child.stdin.on("error", () => {
      invalid = true;
    });
    child.once("close", (code, stopped) => {
      if (signal.aborted || invalid || code !== 0 || stopped !== null) return done({ outcome: "unknown" });
      try {
        done(JSON.parse(output));
      } catch {
        done({ outcome: "unknown" });
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function createManagedMacNativeProviders(options: {
  readonly appRoot: string;
  readonly control: string;
  readonly executable: () => string;
  readonly helper: () => string;
  readonly intents: AdmissionIntents;
  readonly storage: IntentEncryption & Parameters<typeof createSafeStorageKeyAdapter>[0];
  readonly permissions: () => {
    getMediaAccessStatus(media: "camera" | "microphone" | "screen"): string;
    isTrustedAccessibilityClient(prompt: boolean): boolean;
  };
  /** Explicit controlled-port evidence, never shipping native acceptance. */
  readonly fixture?: {
    platform: string;
    arch: string;
    execute?: typeof executeNative;
    start?: typeof startBundledDaemon;
  };
}): ManagedMacNativeProviders {
  const supported = () =>
    (options.fixture?.platform ?? process.platform) === "darwin" && (options.fixture?.arch ?? process.arch) === "arm64";
  const binaryRoot = () => {
    if (!supported()) return undefined;
    const executable = options.executable(),
      root = dirname(dirname(dirname(executable)));
    return canonical(executable) && root.endsWith("/ORCA.app") && executable === join(root, "Contents/MacOS/ORCA")
      ? root
      : undefined;
  };
  const execute = options.fixture?.execute ?? executeNative;
  const start = options.fixture?.start ?? startBundledDaemon;
  async function proof(
    operation: "candidate" | "image",
    path: string,
    manifestSha256: string,
    policy: MacNativePolicyResolver,
    signal: AbortSignal,
  ) {
    if (!supported() || !canonical(path) || signal.aborted || !digest.safeParse(manifestSha256).success)
      throw unavailable();
    const record = await policy(manifestSha256, signal);
    if (
      !record ||
      record.manifestBytes.length > 16384 ||
      sha256(record.manifestBytes) !== manifestSha256 ||
      readMacManifest(record.manifestBytes).kind !== "candidate"
    )
      throw unavailable();
    const bytes = Buffer.from(record.manifestBytes),
      manifest = readMacManifest(bytes);
    // Snapshot independently accepted policy before native subprocess entry.
    const trusted = JSON.parse(JSON.stringify(record.policy)) as unknown;
    const parent = join(options.control, "inspection");
    await privateDirectory(options.control);
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable();
    }
    await privateDirectory(parent);
    if (signal.aborted) throw unavailable();
    const request = {
      operation,
      path,
      manifestBase64: bytes.toString("base64"),
      policy: trusted,
      scratchParent: parent,
    };
    if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) throw unavailable();
    const result = await execute(options.helper(), request, signal);
    if (signal.aborted) throw unavailable();
    return { result, manifest };
  }
  async function image(path: string, manifestSha256: string, policy: MacNativePolicyResolver, signal: AbortSignal) {
    const observed = await proof("image", path, manifestSha256, policy, signal),
      parsed = imageProof.parse(observed.result),
      bytes = identityBytes(parsed.identityBase64);
    if (
      parsed.manifestSha256 !== manifestSha256 ||
      parsed.daemonSha256 !== observed.manifest.identity.daemon.sha256 ||
      !matchesSealedMacIdentity(observed.manifest, bytes)
    )
      throw unavailable();
    return { ...parsed, identityBytes: bytes };
  }
  let child: DaemonChild | undefined;
  let attempted = false;
  let stopResult: Promise<boolean> | undefined;
  let exit: Promise<boolean> | undefined;
  const ports: ManagedMacNativeProviders = {
    binaryRoot,
    async inspect(binding, directory, policy, signal) {
      try {
        const observed = await proof("candidate", directory, binding.candidate.manifestSha256, policy, signal),
          parsed = candidateProof.parse(observed.result);
        const copies = parsed.copies.map((entry) => ({
          format: entry.format,
          identityBytes: identityBytes(entry.identityBase64),
          daemonSha256: entry.daemonSha256,
        }));
        if (
          parsed.manifestSha256 !== binding.candidate.manifestSha256 ||
          new Set(copies.map((entry) => entry.format)).size !== 2 ||
          !copies.every(
            (entry) =>
              entry.daemonSha256 === binding.manifest.identity.daemon.sha256 &&
              matchesSealedMacIdentity(binding.manifest, entry.identityBytes),
          )
        )
          return { outcome: "refused" };
        return { outcome: "verified", manifestSha256: parsed.manifestSha256, copies };
      } catch {
        return { outcome: "unknown" };
      }
    },
    async verifyBinary(path, manifestSha256, policy, signal) {
      try {
        await image(path, manifestSha256, policy, signal);
        return true;
      } catch {
        return false;
      }
    },
    async continuity(signal) {
      if (!supported() || signal.aborted) throw unavailable();
      await privateDirectory(options.appRoot);
      const keys = createSafeStorageKeyAdapter(options.storage, "darwin");
      if (!(await keys.available()) || !options.storage.isEncryptionAvailable()) throw unavailable();
      const intentPath = join(options.appRoot, "admission-intents.enc"),
        before = await privateBytes(intentPath, 1048576);
      const intent = options.intents.continuityHash(),
        after = await privateBytes(intentPath, 1048576);
      if (before?.toString("base64") !== after?.toString("base64")) throw unavailable();
      const wrapped: string[] = [],
        diagnostics = join(options.appRoot, "diagnostics");
      try {
        await privateDirectory(diagnostics);
        const names = await readdir(diagnostics);
        if (names.some((name) => /^(control\.key|session-[0-2]\.key).*\.tmp$/.test(name))) throw unavailable();
        for (const name of ["control.key", "session-0.key", "session-1.key", "session-2.key"]) {
          const bytes = await privateBytes(join(diagnostics, name), 4096);
          if (!bytes) {
            wrapped.push(name + ":absent");
            continue;
          }
          const plain = await keys.unwrap(bytes);
          try {
            const value: unknown = JSON.parse(plain.toString("utf8"));
            const envelope = z
              .strictObject({
                version: z.literal(1),
                purpose: z.enum(["control", "session"]),
                epoch: z.string().min(1),
                keyId: z.string().min(1),
                sessionId: z.string(),
                key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
              })
              .parse(value);
            if (
              envelope.purpose !== (name === "control.key" ? "control" : "session") ||
              Buffer.from(envelope.key, "base64").length !== 32 ||
              !(await privateBytes(join(diagnostics, name), 4096))?.equals(bytes)
            )
              throw unavailable();
            wrapped.push(name + ":" + sha256(bytes) + ":" + sha256(plain));
          } finally {
            plain.fill(0);
          }
        }
      } catch (error) {
        if (!missing(error)) throw error;
        wrapped.push("diagnostics:absent");
      }
      const permission = options.permissions();
      const media = ["camera", "microphone", "screen"].map((name) =>
        permission.getMediaAccessStatus(name as "camera" | "microphone" | "screen"),
      );
      if (!media.every((status) => ["not-determined", "granted", "denied", "restricted"].includes(status)))
        throw unavailable();
      const accessibility = permission.isTrustedAccessibilityClient(false);
      if (typeof accessibility !== "boolean" || signal.aborted) throw unavailable();
      return sha256(Buffer.from(JSON.stringify({ version: 1, intent, wrapped, media, accessibility })));
    },
    async startClosed(identity, permit, policy, signal) {
      if (attempted || signal.aborted || !supported()) return undefined;
      attempted = true; // Unknown launch is permanently retained by this main owner.
      try {
        const root = binaryRoot();
        if (!root) return undefined;
        await image(root, identity.candidate.manifestSha256, policy, signal);
        if (signal.aborted) return undefined;
        const workspace = dirname(identity.storeDir);
        if (identity.storeDir !== join(workspace, ".orca")) return undefined;
        let receipt: z.infer<typeof startupReceipt> | undefined,
          client: DaemonClient | undefined,
          invalidReceipt = false;
        const daemon = await start({
          entry: join(root, "Contents/Resources/daemon/orca-daemon.mjs"),
          execPath: join(root, "Contents/MacOS/ORCA"),
          cwd: workspace,
          configPath: join(workspace, "orca.config.yaml"),
          args: ["--read-only", "--no-resume"],
          closedUpdate: permit,
          startTimeoutMs: 30000,
          onChild(owned) {
            child = owned;
            exit = new Promise((done) => owned.once("close", (code, signal) => done(code === 0 && signal === null)));
          },
          onLog(line) {
            const prefix = "closed update validation: ";
            if (!line.startsWith(prefix)) return;
            if (receipt || line.length > 8192) {
              invalidReceipt = true;
              return;
            }
            try {
              receipt = startupReceipt.parse(JSON.parse(line.slice(prefix.length)));
            } catch {
              invalidReceipt = true;
            }
          },
          async probe(url) {
            if (
              !receipt ||
              invalidReceipt ||
              signal.aborted ||
              !alive(child) ||
              receipt.target.processId !== child!.pid ||
              receipt.target.workspaceId !== identity.previousTarget.workspaceId ||
              receipt.target.instanceId === identity.previousTarget.instanceId ||
              receipt.fenceId !== permit.attempt ||
              receipt.directory !== identity.storeDir
            )
              return false;
            client ??= new DaemonClient(url, fetch, {
              auth: new LocalDaemonToken({ url, workspace, env: {} }),
              requireAuthentication: true,
            });
            try {
              const hello = await macAbortable(() => client!.hello("orca-app/closed-startup", false), signal);
              return (
                hello.processId === child!.pid &&
                hello.identity?.instanceId === receipt.target.instanceId &&
                hello.identity.workspaceId === receipt.target.workspaceId &&
                hello.storeDir === receipt.directory
              );
            } catch {
              return false;
            }
          },
        });
        if (
          !receipt ||
          invalidReceipt ||
          !child ||
          daemon.child !== child ||
          !client ||
          signal.aborted ||
          !alive(child)
        )
          return undefined;
        const captured = receipt,
          owner = child,
          authenticated = client;
        const current = (signal: AbortSignal) =>
          !signal.aborted && alive(owner) && owner.pid === captured.target.processId;
        const process: MacRestartProcess = {
          child: owner,
          instanceId: captured.target.instanceId,
          fenceId: captured.fenceId,
          async hello(signal) {
            if (!current(signal)) throw unavailable();
            return macAbortable(() => authenticated.hello("orca-app/closed-verification", false), signal);
          },
          async image(signal) {
            if (!current(signal)) return { outcome: "unknown" };
            const observed = await image(root, identity.candidate.manifestSha256, policy, signal);
            if (!current(signal)) return { outcome: "unknown" };
            return {
              outcome: "verified",
              target: captured.target,
              manifestSha256: observed.manifestSha256,
              wholeAppMatched: true,
              identityBytes: observed.identityBytes,
              daemonSha256: observed.daemonSha256,
            };
          },
          async store(signal) {
            return current(signal)
              ? {
                  outcome: "observed",
                  target: captured.target,
                  directory: captured.directory,
                  epoch: captured.epoch,
                  work: captured.work,
                }
              : { outcome: "unknown" };
          },
          async closed(signal) {
            if (!current(signal)) throw unavailable();
            return { outcome: "closed", target: captured.target, fenceId: captured.fenceId };
          },
        };
        return Object.freeze(process);
      } catch {
        return undefined;
      }
    },
    async stopClosed(signal) {
      if (stopResult) return stopResult;
      if (signal.aborted || !child || !exit) return false;
      // Claim before signalling; a late exit cannot resurrect an unknown stop result.
      return (stopResult = Promise.resolve().then(async () => {
        if (!alive(child)) return child?.exitCode === 0 && child.signalCode === null;
        if (!child!.kill("SIGTERM")) return false;
        try {
          return await macBounded(signal, 30000, (bounded) => macAbortable(() => exit!, bounded));
        } catch {
          return false;
        }
      }));
    },
  };
  return Object.freeze(ports);
}
