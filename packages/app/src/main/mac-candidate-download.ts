/** #387 owned, bounded delivery-v1 download; no default transport, native staging or trust policy. */
import { createHash } from "node:crypto";
import { lstat, realpath, mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  MAC_METADATA_LIMIT,
  matchesSealedMacIdentity,
  macContractText,
  readMacManifest,
  freezeMacMetadata,
  sha256,
  type NativeMacManifest,
} from "./mac-candidate-manifest.js";
import type { MacUpdateCandidate } from "./mac-updates.js";

export interface MacCandidateBinding {
  readonly candidate: Readonly<MacUpdateCandidate>;
  readonly manifest: Readonly<NativeMacManifest>;
  readonly source: string;
}
export type MacCatalogVerdict = "trusted" | "refused" | "unknown";
/** Trusted main-process ports. Neither catalog acceptance nor a manifest's declarations prove native trust.
 * Catalog must resolve publisher/support, authenticated invitation, exact candidate, freshness/replay and
 * revocation according to approved policy. Rechecked before and after download; no policy supplied here.
 * Native inspection is read-only and must verify actual Apple signatures/Team/certificate/tickets,
 * extracted sealed identities AND actual bundled daemon hashes in both containers. No execution/mount
 * side effects, writes, installation, credential mutation or unresolved work after its promise settles.
 */
export interface MacCandidateTrust {
  catalog(this: void, binding: MacCandidateBinding, signal: AbortSignal): Promise<MacCatalogVerdict>;
  inspect(
    this: void,
    binding: MacCandidateBinding,
    directory: string,
    signal: AbortSignal,
  ): Promise<MacNativeInspection>;
}
export type MacNativeInspection =
  | { readonly outcome: "refused" | "unknown" }
  | {
      readonly outcome: "verified";
      readonly manifestSha256: string;
      readonly copies: readonly {
        readonly format: "dmg" | "zip";
        readonly identityBytes: Uint8Array;
        readonly daemonSha256: string;
      }[];
    };
export interface MacDownloadLimits {
  readonly fileBytes: number;
  readonly totalBytes: number;
  /** Bounds catalog/transport/read-only inspection waits, not a check cadence or approval expiry. */
  readonly operationMs: number;
}
/** Caller must supply an app-owned private root and transport; there is no production URL or fetch default. */
export interface MacCandidateDownloadPorts {
  readonly root: string;
  readonly limits: Readonly<MacDownloadLimits>;
  readonly trust: MacCandidateTrust;
  fetch(
    this: void,
    url: string,
    init: {
      readonly signal: AbortSignal;
      readonly redirect: "manual";
      readonly credentials: "omit";
      readonly cache: "no-store";
    },
  ): Promise<Response>;
}
export interface MacOwnedDownload {
  readonly directory: string;
  /** Only this newly owned directory. Unknown retains the owner's local safety boundary. */
  discard(this: void): Promise<"released" | "unknown">;
}
export type MacDownloadResult =
  { readonly outcome: "verified"; readonly owned: MacOwnedDownload } | { readonly outcome: "failed" | "unknown" };
class UnknownTrust extends Error {}

export function validMacDownloadLimits(limits: MacDownloadLimits): boolean {
  return (
    [limits.fileBytes, limits.totalBytes, limits.operationMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) && limits.operationMs <= 2_147_483_647
  );
}
export function macSource(value: string): string | undefined {
  try {
    if (!macContractText(value)) return undefined;
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/")
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
function requireLive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Candidate operation cancelled");
}
/** Abandoned read-only port results cannot publish a candidate or schedule any owned file writes. */
export async function macAbortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  requireLive(signal);
  return new Promise<T>((resolveValue, reject) => {
    let settled = false;
    const abort = () => {
      if (!settled) {
        settled = true;
        reject(new Error("Candidate operation cancelled"));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    const finish = () => {
      signal.removeEventListener("abort", abort);
    };
    if (signal.aborted) {
      abort();
      finish();
      return;
    }
    Promise.resolve()
      .then(() => {
        requireLive(signal);
        return operation();
      })
      .then(
        (value) => {
          finish();
          if (settled) {
            late?.(value);
            return;
          }
          settled = true;
          resolveValue(value);
        },
        (error: unknown) => {
          finish();
          if (!settled) {
            settled = true;
            reject(error instanceof Error ? error : new Error("Candidate operation failed"));
          }
        },
      );
  });
}
export async function macBounded<T>(
  signal: AbortSignal,
  operationMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, operationMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
function cancel(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** Every owned filesystem write is awaited even after abort. Failed means the installed app/state
 * were never touched and this partial download was removed; uncertain cleanup is distinctly unknown.
 * SHA256SUMS authenticates nothing: it is checked only for consistency with catalog-bound exact bytes.
 */
export async function downloadMacCandidate(
  binding: MacCandidateBinding,
  manifestBytes: Uint8Array,
  ports: MacCandidateDownloadPorts,
  signal: AbortSignal,
): Promise<MacDownloadResult> {
  let directory: string | undefined;
  const discard = async (): Promise<"released" | "unknown"> => {
    if (!directory) return "released";
    try {
      await rm(directory, { recursive: true, force: true });
      return "released";
    } catch {
      return "unknown";
    }
  };
  try {
    // Snapshot again at this independent boundary; no caller can substitute mutable bytes/records.
    if (manifestBytes.length > MAC_METADATA_LIMIT) return { outcome: "failed" };
    manifestBytes = Buffer.from(manifestBytes);
    const manifest = freezeMacMetadata(readMacManifest(manifestBytes));
    if (
      manifest.kind !== "candidate" ||
      manifest.signing.teamId !== "Q2FP9UY5T4" ||
      sha256(manifestBytes) !== binding.candidate.manifestSha256
    )
      return { outcome: "failed" };
    binding = freezeMacMetadata({
      candidate: {
        manifestSha256: binding.candidate.manifestSha256,
        channel: binding.candidate.channel,
        compatibilityPlanId: binding.candidate.compatibilityPlanId,
        recoveryPlanId: binding.candidate.recoveryPlanId,
      },
      manifest,
      source: binding.source,
    });
    if (
      ![binding.candidate.channel, binding.candidate.compatibilityPlanId, binding.candidate.recoveryPlanId].every(
        macContractText,
      )
    )
      return { outcome: "failed" };
    ports = {
      root: ports.root,
      limits: Object.freeze({ ...ports.limits }),
      trust: Object.freeze({ catalog: ports.trust.catalog, inspect: ports.trust.inspect }),
      fetch: ports.fetch,
    };
    if (!validMacDownloadLimits(ports.limits) || macSource(binding.source) !== binding.source)
      return { outcome: "failed" };
    return await macBounded(signal, ports.limits.operationMs, async (bounded) => {
      const records = [...binding.manifest.artifacts, ...binding.manifest.evidence];
      let budget = manifestBytes.length + MAC_METADATA_LIMIT;
      for (const record of records) {
        budget += record.bytes;
        if (record.bytes > ports.limits.fileBytes || !Number.isSafeInteger(budget))
          throw new Error("Candidate download limit");
      }
      if (manifestBytes.length > ports.limits.fileBytes || budget > ports.limits.totalBytes)
        throw new Error("Candidate download limit");
      const catalog = async () => {
        let verdict: MacCatalogVerdict;
        try {
          verdict = await macAbortable(() => ports.trust.catalog(binding, bounded), bounded);
        } catch {
          if (bounded.aborted) throw new Error("Candidate operation cancelled");
          throw new UnknownTrust();
        }
        if (verdict === "refused") throw new Error("Candidate catalog refused");
        if (verdict !== "trusted") throw new UnknownTrust();
      };
      await catalog();
      requireLive(bounded);
      const root = resolve(ports.root);
      const info = await lstat(root);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(root)) !== root ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error("Candidate storage refused");
      requireLive(bounded);
      directory = await mkdtemp(join(root, "mac-candidate-"));
      requireLive(bounded);
      await writeFile(join(directory, "native-mac-artifact.json"), manifestBytes, { flag: "wx", mode: 0o600 });
      const expected = new Map<string, string>([["native-mac-artifact.json", binding.candidate.manifestSha256]]);
      const receive = async (
        path: string,
        maxBytes: number,
        record?: { readonly bytes: number; readonly sha256: string },
      ): Promise<Uint8Array | undefined> => {
        requireLive(bounded);
        const url = new URL(path.split("/").map(encodeURIComponent).join("/"), binding.source).href;
        const response = await macAbortable(
          () => ports.fetch(url, { signal: bounded, redirect: "manual", credentials: "omit", cache: "no-store" }),
          bounded,
          cancel,
        );
        if (response.status !== 200 || response.redirected || response.url !== url || !response.body) {
          cancel(response);
          throw new Error("Candidate response refused");
        }
        const reader = response.body.getReader();
        let size = 0;
        const digest = createHash("sha256");
        const chunks: Uint8Array[] = [];
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          requireLive(bounded);
          if (record) {
            const target = join(directory!, path);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            requireLive(bounded);
            handle = await open(target, "wx", 0o600);
          }
          for (;;) {
            const part = await macAbortable(() => reader.read(), bounded);
            requireLive(bounded);
            if (part.done) break;
            // Empty/nonbyte chunks must not evade byte bounds or starve the deadline timer.
            if (!(part.value instanceof Uint8Array) || !part.value.byteLength)
              throw new Error("Candidate response refused");
            size += part.value.byteLength;
            if (!Number.isSafeInteger(size) || size > maxBytes) throw new Error("Candidate response too large");
            const bytes = Buffer.from(part.value);
            digest.update(bytes);
            if (handle) await handle.writeFile(bytes);
            else chunks.push(bytes);
          }
          if (record && (size !== record.bytes || digest.digest("hex") !== record.sha256))
            throw new Error("Candidate bytes mismatch");
          return record ? undefined : Buffer.concat(chunks);
        } finally {
          void reader.cancel().catch(() => undefined);
          if (handle) await handle.close();
        }
      };
      for (const record of records) {
        await receive(record.path, record.bytes, record);
        expected.set(record.path, record.sha256);
      }
      const sums = await receive("SHA256SUMS", Math.min(MAC_METADATA_LIMIT, ports.limits.fileBytes));
      const expectedSums = [...expected]
        // UTF-8 order matches the Python validator's Unicode scalar ordering.
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(([path, hash]) => `${hash}  ${path}\n`)
        .join("");
      if (!sums || !Buffer.from(sums).equals(Buffer.from(expectedSums)))
        throw new Error("Candidate checksum inventory mismatch");
      requireLive(bounded);
      await writeFile(join(directory, "SHA256SUMS"), sums, { flag: "wx", mode: 0o600 });
      let inspection: MacNativeInspection;
      try {
        inspection = await macAbortable(() => ports.trust.inspect(binding, directory!, bounded), bounded);
      } catch {
        if (bounded.aborted) throw new Error("Candidate operation cancelled");
        throw new UnknownTrust();
      }
      if (inspection.outcome === "unknown") throw new UnknownTrust();
      if (
        inspection.outcome !== "verified" ||
        inspection.manifestSha256 !== binding.candidate.manifestSha256 ||
        inspection.copies.length !== 2 ||
        new Set(inspection.copies.map((copy) => copy.format)).size !== 2 ||
        !inspection.copies.every(
          (copy) =>
            ["dmg", "zip"].includes(copy.format) &&
            copy.daemonSha256 === binding.manifest.identity.daemon.sha256 &&
            matchesSealedMacIdentity(binding.manifest, copy.identityBytes),
        )
      )
        throw new Error("Candidate native proof refused");
      await catalog();
      requireLive(bounded);
      return { outcome: "verified", owned: Object.freeze({ directory, discard }) };
    });
  } catch (error) {
    const released = await discard();
    return { outcome: released === "released" && !(error instanceof UnknownTrust) ? "failed" : "unknown" };
  }
}
