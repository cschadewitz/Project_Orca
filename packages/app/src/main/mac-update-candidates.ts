/** Main-only trusted candidate binding and process-local consent. */
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
import {
  MacUpdates,
  type MacUpdateCandidate,
  type MacUpdateSnapshot,
  type MacUpdateTarget,
  type MacUpdatePorts,
} from "./mac-updates.js";
import type { MacNativeCommitRequest } from "./mac-native-handoff.js";

/** Read-only preparation checkpoint, never native activation or recovery eligibility. */
export interface MacCandidatePrepared {
  readonly binding: MacCandidateBinding;
  readonly directory: string;
  readonly target: Readonly<MacUpdateTarget>;
  readonly scope: "preparation-only";
}
export interface MacCandidatePreparation extends Pick<
  MacUpdatePorts,
  "drainAdmission" | "prepareDrafts" | "prepareAdmission"
> {
  /** Only explicit untouched refusal allows guard cleanup. No positive readiness/installation result. */
  checkPrepared(this: void, prepared: MacCandidatePrepared): Promise<"refused" | "unknown">;
}
/** Explicit production binding. Legacy preparation-only adapters cannot gain activation
 * by returning a positive string. Main supplies both checked revalidation and commit. */
export interface MacCandidateExecution {
  revalidate(this: void, prepared: MacCandidatePrepared): Promise<"valid" | "refused" | "unknown">;
  activate(this: void, request: MacNativeCommitRequest): Promise<"committed" | "refused" | "unknown">;
}

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
 * renderer capability, persisted approval or catalog polling is created by this class.
 * Without trusted preparation ports a verified download stops at the disabled draft guard.
 * Preparation cannot authorize native installation; an explicit execution owner is required. Unknown verification/cleanup seals this
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
  private operation: Promise<MacUpdateSnapshot> | undefined;

  constructor(
    ports?: MacCandidateDownloadPorts,
    preparation?: MacCandidatePreparation,
    execution?: MacCandidateExecution,
  ) {
    const native =
      execution && typeof execution.revalidate === "function" && typeof execution.activate === "function"
        ? Object.freeze({ revalidate: execution.revalidate, activate: execution.activate })
        : undefined;
    const guards =
      preparation &&
      typeof preparation.prepareDrafts === "function" &&
      typeof preparation.prepareAdmission === "function" &&
      typeof preparation.checkPrepared === "function"
        ? Object.freeze({
            drainAdmission: preparation.drainAdmission,
            prepareDrafts: preparation.prepareDrafts,
            prepareAdmission: preparation.prepareAdmission,
            checkPrepared: preparation.checkPrepared,
          })
        : undefined;
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
      approvalCurrent: async (candidate) => {
        if (!this.ports || !this.binding || !sameCandidate(candidate, this.binding.value.candidate)) return "unknown";
        try {
          const result = await macBounded(new AbortController().signal, this.ports.limits.operationMs, (signal) =>
            macAbortable(() => this.ports!.trust.catalog(this.binding!.value, signal), signal),
          );
          return result === "trusted" ? "valid" : result === "refused" ? "refused" : "unknown";
        } catch {
          return "unknown";
        }
      },
      ...(guards?.drainAdmission ? { drainAdmission: guards.drainAdmission } : {}),
      prepareDrafts: guards?.prepareDrafts ?? (() => Promise.resolve({ outcome: "blocked", blocker: "candidate" })),
      prepareAdmission:
        guards?.prepareAdmission ?? (() => Promise.resolve({ outcome: "blocked", blocker: "identity" })),
      revalidate: async (candidate, target) => {
        if (!guards) return "refused";
        if (this.uncertain || !this.binding || !this.owned || !sameCandidate(candidate, this.binding.value.candidate))
          return "unknown";
        const prepared = Object.freeze({
          binding: this.binding.value,
          directory: this.owned.directory,
          target,
          scope: "preparation-only" as const,
        });
        if (native) return native.revalidate(prepared);
        const result = await guards.checkPrepared(prepared);
        // Malformed/positive adapter output is never complete-state/native readiness.
        return result === "refused" ? "refused" : "unknown";
      },
      activate: async (candidate, lease) => {
        if (
          !native ||
          this.uncertain ||
          !this.binding ||
          !this.owned ||
          !sameCandidate(candidate, this.binding.value.candidate)
        )
          return "refused";
        return native.activate({
          prepared: Object.freeze({
            binding: this.binding.value,
            directory: this.owned.directory,
            target: lease.target,
            scope: "preparation-only",
          }),
          lease,
        });
      },
    });
  }
  get state(): MacUpdateSnapshot {
    return this.updates.state;
  }
  /** Nonsecret metadata for the exact trusted offer, never a delivery/install path. */
  get offeredCandidate(): Readonly<MacUpdateCandidate & { version: string }> | undefined {
    if (!this.binding) return undefined;
    return Object.freeze({
      ...this.binding.value.candidate,
      version: this.binding.value.manifest.identity.releaseVersion,
    });
  }
  private offeredEpoch: number | undefined;
  get targetEpoch(): number | undefined {
    return this.offeredEpoch;
  }
  subscribe(listener: (state: MacUpdateSnapshot) => void): () => void {
    return this.updates.subscribe(listener);
  }
  /** Distinct authenticity/cleanup outcome, with no raw native errors or delivery URL exposed. */
  get verification(): "verified" | "failed" | "unknown" | undefined {
    return this.downloadOutcome;
  }
  /** Observe current preparation and owned cleanup settlement, never grant readiness. */
  async settled(): Promise<MacUpdateSnapshot> {
    await this.operation;
    await this.cleaning;
    await this.updates.settled();
    return this.state;
  }
  async offer(
    input: MacCandidateOffer,
    target: MacUpdateTarget,
    signal: AbortSignal,
  ): Promise<MacCandidateOfferResult> {
    if (this.uncertain) return { outcome: "unknown" };
    if (this.offering || this.cleaning || this.operation || !["idle", "deferred", "failed"].includes(this.state.phase))
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
      const previous = this.binding;
      const previousEpoch = this.offeredEpoch;
      this.binding = { value, bytes };
      this.offeredEpoch = capturedTarget.epoch;
      const offerId = this.updates.present(value.candidate, capturedTarget);
      if (!offerId) {
        this.binding = previous;
        this.offeredEpoch = previousEpoch;
        return { outcome: "busy" };
      }
      this.downloadOutcome = undefined;
      return { outcome: "available", offerId };
    } catch {
      return { outcome: "refused" };
    } finally {
      this.offering = false;
    }
  }
  async approve(offerId: string): Promise<MacUpdateSnapshot> {
    if (this.uncertain || this.cleaning || this.offering || this.operation || this.retiredOfferId === offerId)
      return this.state;
    return this.observe(async () => {
      if (this.uncertain || this.cleaning || this.retiredOfferId === offerId) return this.state;
      return this.updates.approve(offerId);
    });
  }
  /** Supported activity notification only; never polling or implicit approval. */
  async reconsider(): Promise<MacUpdateSnapshot> {
    if (this.uncertain || this.cleaning || this.offering || this.retiredOfferId === this.state.offerId)
      return this.state;
    if (this.operation) return this.updates.reconsider();
    return this.observe(async () => {
      if (this.uncertain || this.cleaning || this.retiredOfferId === this.state.offerId) return this.state;
      return this.updates.reconsider();
    });
  }
  private observe(operation: () => Promise<MacUpdateSnapshot>): Promise<MacUpdateSnapshot> {
    // Reserve before an adapter can synchronously call back into defer/reconsider.
    const result = Promise.resolve().then(operation);
    this.operation = result;
    void result.then((state) => {
      if (state.phase === "recovery-required") this.uncertain = true;
      if (this.operation === result) this.operation = undefined;
    });
    return result;
  }
  defer(offerId: string): boolean {
    if (!this.updates.defer(offerId)) return false;
    // The coordinator can reuse verified bytes after defer, but this session discards them.
    // Retire this entrypoint: a fresh offer resets its cache and rechecks bounded trust before
    // a new approval downloads/inspects new owned bytes. Do not silently approve another ID.
    this.retiredOfferId = offerId;
    if (!this.uncertain) this.downloadOutcome = undefined;
    if ((this.owned || this.operation) && !this.cleaning) {
      const operation = this.operation;
      this.cleaning = (async () => {
        await operation;
        await this.updates.settled();
        // Do not erase candidate evidence while remote/window ownership is uncertain.
        if (this.state.phase === "recovery-required") {
          this.uncertain = true;
          return;
        }
        await this.discard();
      })().finally(() => {
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
