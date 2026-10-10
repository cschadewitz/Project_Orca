/** Candidate Electron/Squirrel lifecycle implementation; no production owner enables this adapter. */
import type { AutoUpdater } from "electron";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { freezeMacMetadata, readMacManifest, sha256 } from "./mac-candidate-manifest.js";
import { macAbortable, macBounded } from "./mac-candidate-download.js";
import type { MacCandidatePrepared } from "./mac-update-candidates.js";
import type { MacAdmissionLease } from "./mac-updates.js";

type NativeUpdater = Pick<AutoUpdater, "on" | "off" | "setFeedURL" | "checkForUpdates" | "quitAndInstall">;
type Outcome = "committed" | "refused" | "unknown";
export interface MacNativeCommitRequest {
  readonly prepared: MacCandidatePrepared;
  readonly lease: MacAdmissionLease;
}
/** This is a required owner port, NOT a recovery implementation or a native acceptance receipt.
 * Ready promises exact process-local candidate approval, fresh trust/identity, held drafts and
 * admissions, positively clean owned stop, all protected writers quiescent, verified complete
 * state plus matching binary, durable restart recovery identity and accepted signed Mac engine.
 * Refused guarantees old app/state untouched AND the admission lease still safely resumable.
 * Everything else retains both leases; no binary-only rollback or guessed cleanup is allowed.
 */
export interface MacNativeCommitOwner {
  prepare(this: void, request: MacNativeCommitRequest): Promise<"ready" | "refused" | "unknown">;
}
interface Attempt {
  readonly key: string;
  readonly lease: MacAdmissionLease;
  readonly result: Promise<Outcome>;
}
// Electron's singleton may already contain staged bytes. Reconstructing a wrapper is no retry.
const attempts = new WeakMap<NativeUpdater, Attempt>();
const ignoreLateError = () => undefined;
function key(request: MacNativeCommitRequest): string {
  const { prepared, lease } = request;
  return JSON.stringify([prepared.binding.candidate, prepared.directory, prepared.target, lease.target]);
}
function sameTarget(request: MacNativeCommitRequest): boolean {
  try {
    const expected = request.prepared.target;
    const actual = request.lease.target;
    return (
      typeof expected.workspaceId === "string" &&
      !!expected.workspaceId &&
      typeof expected.instanceId === "string" &&
      !!expected.instanceId &&
      Number.isSafeInteger(expected.epoch) &&
      expected.epoch >= 0 &&
      expected.workspaceId === actual.workspaceId &&
      expected.instanceId === actual.instanceId &&
      expected.epoch === actual.epoch
    );
  } catch {
    return false;
  }
}

/** Single approved ZIP handoff, followed by automatic quit/relaunch request. Committed means
 * ONLY quitAndInstall was invoked after the matching download; no installation/startup claim.
 * Undefined owner/native is the production default. No native call precedes owner readiness.
 */
export class MacNativeHandoff {
  private readonly options: {
    readonly native?: NativeUpdater;
    readonly owner?: MacNativeCommitOwner;
    readonly zipBytes: number;
    readonly operationMs: number;
  };
  constructor(options: MacNativeHandoff["options"]) {
    this.options = Object.freeze({
      ...options,
      ...(options.owner ? { owner: Object.freeze({ prepare: options.owner.prepare }) } : {}),
    });
  }

  activate(request: MacNativeCommitRequest): Promise<Outcome> {
    const { native, owner, zipBytes, operationMs } = this.options;
    if (
      !native ||
      !owner ||
      !Number.isSafeInteger(zipBytes) ||
      zipBytes <= 0 ||
      !Number.isSafeInteger(operationMs) ||
      operationMs <= 0
    )
      return Promise.resolve("refused");
    let captured: MacNativeCommitRequest;
    let identity: string;
    try {
      captured = Object.freeze({
        prepared: freezeMacMetadata({
          ...request.prepared,
          binding: structuredClone(request.prepared.binding),
          target: { ...request.prepared.target },
        }),
        lease: request.lease,
      });
      identity = key(captured);
    } catch {
      return Promise.resolve("refused");
    }
    const previous = attempts.get(native);
    // A second target must never reuse this native singleton's possibly staged candidate.
    if (previous)
      return previous.key === identity && previous.lease === request.lease
        ? previous.result
        : Promise.resolve("unknown");
    const result = Promise.resolve().then(() => this.run(captured, native, owner));
    attempts.set(native, { key: identity, lease: request.lease, result });
    return result;
  }

  private async bytes(request: MacNativeCommitRequest): Promise<Buffer> {
    const { prepared } = request;
    if (prepared.scope !== "preparation-only") throw new Error("Candidate scope refused");
    const directory = resolve(prepared.directory);
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)) !== directory ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Candidate storage refused");
    const manifestBytes = await this.file(join(directory, "native-mac-artifact.json"), 64 * 1024);
    const manifest = readMacManifest(manifestBytes);
    if (
      manifest.kind !== "candidate" ||
      manifest.signing.teamId !== "Q2FP9UY5T4" ||
      sha256(manifestBytes) !== prepared.binding.candidate.manifestSha256 ||
      JSON.stringify(manifest) !== JSON.stringify(prepared.binding.manifest)
    )
      throw new Error("Candidate binding refused");
    const zip = manifest.artifacts.find((record) => record.format === "zip")!;
    if (zip.bytes > this.options.zipBytes) throw new Error("Candidate size refused");
    // Freeze served bytes before the owner stops writers. Path substitution cannot alter them.
    const bytes = await this.file(join(directory, zip.path), zip.bytes);
    if (bytes.length !== zip.bytes || sha256(bytes) !== zip.sha256) throw new Error("Candidate bytes refused");
    return bytes;
  }

  private async file(path: string, limit: number): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size <= 0 ||
        info.size > limit ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error("Candidate file refused");
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!part.bytesRead) throw new Error("Candidate file changed");
        offset += part.bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
      if (extra.bytesRead) throw new Error("Candidate file changed");
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private async run(
    request: MacNativeCommitRequest,
    native: NativeUpdater,
    owner: MacNativeCommitOwner,
  ): Promise<Outcome> {
    // Mismatched ownership cannot promise that the supplied lease is safely resumable.
    if (!sameTarget(request)) return "unknown";
    let bytes: Buffer;
    try {
      bytes = await macBounded(new AbortController().signal, this.options.operationMs, (signal) =>
        macAbortable(() => this.bytes(request), signal),
      );
    } catch {
      return sameTarget(request) ? "refused" : "unknown";
    }
    if (!sameTarget(request)) return "unknown";
    let ready: unknown;
    try {
      ready = await macBounded(new AbortController().signal, this.options.operationMs, (signal) =>
        macAbortable(() => owner.prepare(request), signal),
      );
    } catch {
      return "unknown";
    }
    if (!sameTarget(request)) return "unknown";
    if (ready === "refused") return "refused";
    if (ready !== "ready") return "unknown";
    // From here a cleanly stopped/recovery-owned app cannot be reopened by this adapter.
    let server: Server | undefined;
    try {
      const capability = randomBytes(32).toString("hex");
      const feedPath = `/${capability}/feed`;
      const zipPath = `/${capability}/candidate.zip`;
      let zipURL = "";
      let requests = 0;
      server = createServer((req, res) => {
        const accepted =
          ++requests <= 16 &&
          (req.method === "GET" || req.method === "HEAD") &&
          (req.url === feedPath || req.url === zipPath);
        if (!accepted) {
          res.writeHead(404);
          res.end();
          return;
        }
        const body =
          req.url === feedPath
            ? Buffer.from(
                JSON.stringify({ url: zipURL, name: request.prepared.binding.manifest.identity.releaseVersion }),
              )
            : bytes;
        res.writeHead(200, {
          "Content-Type": req.url === feedPath ? "application/json" : "application/zip",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
      });
      server.requestTimeout = this.options.operationMs;
      server.headersTimeout = Math.min(this.options.operationMs, 10_000);
      const listening = server;
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        listening.once("error", failed);
        listening.listen(0, "127.0.0.1", () => {
          listening.off("error", failed);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") return "unknown";
      const origin = `http://127.0.0.1:${address.port}`;
      zipURL = `${origin}${zipPath}`;
      const result = await new Promise<Outcome>((resolve) => {
        let done = false;
        let started = false;
        let quitting = false;
        const finish = (outcome: Outcome) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          // Native work has no cancellation API. A late error must not crash or reopen this owner.
          native.on("error", ignoreLateError);
          native.off("error", failed);
          native.off("update-not-available", failed);
          native.off("update-downloaded", downloaded);
          listening.off("error", failed);
          resolve(outcome);
        };
        const failed = () => finish("unknown");
        const downloaded = (_event: unknown, _notes: string, _name: string, _date: Date, url: string) => {
          if (done || quitting) return;
          if (!started || url !== zipURL) {
            finish("unknown");
            return;
          }
          quitting = true;
          try {
            native.quitAndInstall();
            if (!done) finish("committed");
          } catch {
            finish("unknown");
          }
        };
        const timer = setTimeout(failed, this.options.operationMs);
        native.on("error", failed);
        native.on("update-not-available", failed);
        native.on("update-downloaded", downloaded);
        listening.on("error", failed);
        try {
          native.setFeedURL({
            url: `${origin}${feedPath}`,
            serverType: "default",
            headers: { "Cache-Control": "no-store" },
          });
          if (done) return;
          started = true;
          native.checkForUpdates();
        } catch {
          finish("unknown");
        }
      });
      return result;
    } catch {
      return "unknown";
    } finally {
      // Only the private transport is closed; candidate/state/recovery evidence is retained.
      server?.closeAllConnections();
      server?.close();
    }
  }
}
