/** #387 main-only trusted candidate binding and process-local consent; all activation adapters disabled. */
import {
  downloadMacCandidate,
  macAbortable,
  macBounded,
  macSource,
  validMacDownloadLimits,
  type MacCandidateBinding,
  type MacCandidateDownloadPorts,
  type MacOwnedDownload,
} from "./mac-candidate-download.js";
import {
  freezeMacMetadata,
  macContractText,
  MAC_METADATA_LIMIT,
  readMacManifest,
  sha256,
} from "./mac-candidate-manifest.js";
import { MacUpdates, type MacUpdateCandidate, type MacUpdateSnapshot, type MacUpdateTarget } from "./mac-updates.js";

export interface MacCandidateOffer {
  readonly manifestBytes: Uint8Array;
  readonly source: string;
  readonly channel: string;
  readonly compatibilityPlanId: string;
  readonly recoveryPlanId: string;
}
export type MacCandidateOfferResult =
  { readonly outcome: "available"; readonly offerId: string } | { readonly outcome: "refused" | "unknown" | "busy" };
function sameCandidate(a: MacUpdateCandidate, b: MacUpdateCandidate): boolean {
  return (
    a.manifestSha256 === b.manifestSha256 &&
    a.channel === b.channel &&
    a.compatibilityPlanId === b.compatibilityPlanId &&
    a.recoveryPlanId === b.recoveryPlanId
  );
}
/** Construct only in trusted main code, after policy/delivery ownership is approved. No production
 * constructor call, renderer IPC, persisted approval, catalog polling, native updater or installation.
 * Even a verified download stops at the disabled draft guard. Unknown verification/cleanup seals this
 * session; the existing coordinator's failed phase proves only that installed app/state were untouched.
 */
export class MacCandidateSession {
  private readonly updates: MacUpdates;
  private readonly ports: MacCandidateDownloadPorts | undefined;
  private binding: { readonly value: MacCandidateBinding; readonly bytes: Uint8Array } | undefined;
  private owned: MacOwnedDownload | undefined;
  private offering = false;
  private cleaning: Promise<void> | undefined;
  private uncertain = false;
  private downloadOutcome: "verified" | "failed" | "unknown" | undefined;
  private retiredOfferId: string | undefined;

  constructor(ports?: MacCandidateDownloadPorts) {
    if (
      ports &&
      typeof ports.root === "string" &&
      ports.limits &&
      typeof ports.trust?.catalog === "function" &&
      typeof ports.trust.inspect === "function" &&
      typeof ports.fetch === "function"
    )
      this.ports = {
        root: ports.root,
        limits: Object.freeze({ ...ports.limits }),
        trust: Object.freeze({ catalog: ports.trust.catalog, inspect: ports.trust.inspect }),
        fetch: ports.fetch,
      };
    this.updates = new MacUpdates({
      download: async (candidate, signal) => {
        if (this.uncertain || !this.ports || !this.binding || !sameCandidate(candidate, this.binding.value.candidate)) {
          this.downloadOutcome = "failed";
          return "failed";
        }
        const result = await downloadMacCandidate(this.binding.value, this.binding.bytes, this.ports, signal);
        this.downloadOutcome = result.outcome;
        if (result.outcome === "unknown") this.uncertain = true;
        if (result.outcome === "verified") {
          this.owned = result.owned;
          // A defer can arrive between the final verification and this continuation.
          if (signal.aborted) {
            await this.discard();
            if (!this.uncertain) this.downloadOutcome = "failed";
            return "failed";
          }
          return "verified";
        }
        return "failed";
      },
      prepareDrafts: () => Promise.resolve({ outcome: "blocked", blocker: "candidate" }),
      prepareAdmission: () => Promise.resolve({ outcome: "blocked", blocker: "identity" }),
      revalidate: () => Promise.resolve("refused"),
      activate: () => Promise.resolve("refused"),
    });
  }
  get state(): MacUpdateSnapshot {
    return this.updates.state;
  }
  /** Distinct authenticity/cleanup outcome, with no raw native errors or delivery URL exposed. */
  get verification(): "verified" | "failed" | "unknown" | undefined {
    return this.downloadOutcome;
  }
  async offer(
    input: MacCandidateOffer,
    target: MacUpdateTarget,
    signal: AbortSignal,
  ): Promise<MacCandidateOfferResult> {
    if (this.uncertain) return { outcome: "unknown" };
    if (this.offering || this.cleaning || !["idle", "deferred", "failed"].includes(this.state.phase))
      return { outcome: "busy" };
    if (!this.ports || !validMacDownloadLimits(this.ports.limits)) return { outcome: "refused" };
    this.offering = true;
    try {
      if (input.manifestBytes.length > MAC_METADATA_LIMIT) return { outcome: "refused" };
      const bytes = Buffer.from(input.manifestBytes);
      const manifest = freezeMacMetadata(readMacManifest(bytes));
      const source = macSource(input.source);
      if (
        manifest.kind !== "candidate" ||
        manifest.signing.teamId !== "Q2FP9UY5T4" ||
        !source ||
        ![input.channel, input.compatibilityPlanId, input.recoveryPlanId].every(macContractText)
      )
        return { outcome: "refused" };
      const capturedTarget = Object.freeze({
        workspaceId: target.workspaceId,
        instanceId: target.instanceId,
        epoch: target.epoch,
      });
      if (
        !macContractText(capturedTarget.workspaceId) ||
        !macContractText(capturedTarget.instanceId) ||
        !Number.isSafeInteger(capturedTarget.epoch) ||
        capturedTarget.epoch < 0
      )
        return { outcome: "refused" };
      const value = freezeMacMetadata({
        manifest,
        source,
        candidate: {
          manifestSha256: sha256(bytes),
          channel: input.channel,
          compatibilityPlanId: input.compatibilityPlanId,
          recoveryPlanId: input.recoveryPlanId,
        },
      });
      let verdict;
      try {
        verdict = await macBounded(signal, this.ports.limits.operationMs, (bounded) =>
          macAbortable(() => this.ports!.trust.catalog(value, bounded), bounded),
        );
      } catch {
        return { outcome: signal.aborted ? "refused" : "unknown" };
      }
      if (verdict !== "trusted") return { outcome: verdict === "refused" ? "refused" : "unknown" };
      if (signal.aborted) return { outcome: "refused" };
      const offerId = this.updates.present(value.candidate, capturedTarget);
      if (!offerId) return { outcome: "busy" };
      this.binding = { value, bytes };
      this.downloadOutcome = undefined;
      return { outcome: "available", offerId };
    } catch {
      return { outcome: "refused" };
    } finally {
      this.offering = false;
    }
  }
  async approve(offerId: string): Promise<MacUpdateSnapshot> {
    if (this.uncertain || this.cleaning || this.offering || this.retiredOfferId === offerId) return this.state;
    return this.updates.approve(offerId);
  }
  defer(offerId: string): boolean {
    if (!this.updates.defer(offerId)) return false;
    // The coordinator can reuse verified bytes after defer, but this session discards them.
    // Retire this entrypoint: a fresh offer resets its cache and rechecks bounded trust before
    // a new approval downloads/inspects new owned bytes. Do not silently approve another ID.
    this.retiredOfferId = offerId;
    if (!this.uncertain) this.downloadOutcome = undefined;
    if (this.owned && !this.cleaning) {
      this.cleaning = this.discard().finally(() => {
        this.cleaning = undefined;
      });
    }
    return true;
  }
  private async discard(): Promise<void> {
    if (!this.owned) return;
    if ((await this.owned.discard()) === "released") this.owned = undefined;
    else {
      this.uncertain = true;
      this.downloadOutcome = "unknown";
    }
  }
}
