/**
 * Candidate-bound Mac update orchestration, deliberately unwired from production IPC.
 * Native trust, owned admission, complete-state recovery and Squirrel lifecycle adapters
 * must satisfy these ports before Mac updating can be enabled. No filesystem/feed access,
 * binary rollback, process kill, persisted approval or arbitrary installation input here.
 */
import { randomUUID } from "node:crypto";
import type { DaemonIdentity } from "../daemon-connection.js";
import type { MacOwnedStopResult } from "./mac-update-restart.js";

/** References the existing #402 manifest bytes; this is not a second artifact manifest.
 * The reviewed compatibility/recovery plans and channel are also part of consent.
 * Only an authenticated, trusted resolver may supply an offer; a digest is not trust.
 */
export interface MacUpdateCandidate {
  readonly manifestSha256: string;
  readonly channel: string;
  readonly compatibilityPlanId: string;
  readonly recoveryPlanId: string;
}
export interface MacUpdateTarget extends DaemonIdentity {
  readonly epoch: number;
}
export type MacUpdateBlocker = "drafts" | "window-unavailable" | "activity" | "identity" | "candidate";
export interface MacUpdateSnapshot {
  readonly phase:
    | "idle"
    | "available"
    | "downloading"
    | "waiting"
    | "preparing"
    | "activating"
    | "awaiting-restart"
    | "deferred"
    | "failed"
    | "recovery-required";
  readonly offerId?: string;
  readonly blocker?: MacUpdateBlocker;
}
/** Unknown includes rejected promises. Only explicit known outcomes permit cleanup/retry. */
export type MacPreparation<T> =
  | { readonly outcome: "ready"; readonly lease: T }
  | { readonly outcome: "blocked"; readonly blocker: MacUpdateBlocker }
  | { readonly outcome: "unknown" };
export interface MacDraftLease {
  /** Releases exactly this all-window freeze. Unknown must retain its safety boundary. */
  release(this: void): Promise<"released" | "unknown">;
}
/** One process-local owner from exact consent through drain and idle preparation. */
export interface MacDrainLease {
  readonly target: MacUpdateTarget;
  readonly token: string;
  observe(this: void): Promise<"draining" | "held" | "unknown">;
  /** Defer while draining, resume after held; never releases an uncertain fence. */
  release(this: void): Promise<"released" | "unknown">;
}
export interface MacAdmissionLease {
  readonly token?: string;
  readonly target: MacUpdateTarget;
  /** Main-only owned stop evidence. Never authorizes replacement, restore or reopening. */
  stopOwned?(this: void, signal: AbortSignal, operationMs: number): Promise<MacOwnedStopResult>;
  /** Resume only the exact owned target/token, with positive acknowledgement. */
  release(this: void): Promise<"released" | "unknown">;
}
export interface MacUpdatePorts {
  /** Downloads/verifies exact bytes into app-owned storage, with no native staging.
   * Failure/cancellation leaves the installed app and admission untouched. Resolve only
   * after all writes settle; honor abort. Do not forward raw errors/progress metadata.
   */
  download(this: void, candidate: MacUpdateCandidate, signal: AbortSignal): Promise<"verified" | "failed">;
  /** Trusted consent freshness/revocation, refreshed while waiting and before freeze. */
  approvalCurrent?(
    this: void,
    candidate: MacUpdateCandidate,
    target: MacUpdateTarget,
  ): Promise<"valid" | "refused" | "unknown">;
  /** Missing/unsupported drain fails closed. Capture without blocking existing work. */
  drainAdmission?(this: void, target: MacUpdateTarget, token: string): Promise<MacPreparation<MacDrainLease>>;
  /** Reuse prepareDrafts acknowledgements; also guard new windows/interaction until release. */
  prepareDrafts(this: void): Promise<MacPreparation<MacDraftLease>>;
  /** Atomically fence via existing maintenance prepare, on a positively owned daemon only.
   * Verify process/workspace/instance/epoch; refuse external, parked or changed targets
   * without touching them. Active work/callbacks/unknown work prevent ready. Blocked
   * guarantees no fence acquired; a lost response is unknown, never blocked.
   */
  prepareAdmission(
    this: void,
    target: MacUpdateTarget,
    token: string,
    drain?: MacDrainLease,
  ): Promise<MacPreparation<MacAdmissionLease>>;
  /** Under both leases, recheck trust/freshness/exact bytes, all windows, UI/managed daemon/
   * protocol/store compatibility and complete-state recovery readiness. No stop/writes.
   */
  revalidate(
    this: void,
    candidate: MacUpdateCandidate,
    target: MacUpdateTarget,
  ): Promise<"valid" | "refused" | "unknown">;
  /** Commit boundary: stop only the idle owned daemon without forced kill, take/verify the
   * complete quiescent protected-state set plus matching binary, persist recovery identity
   * before replacement, then stage/activate these exact bytes. Refused proves installed
   * app/state untouched and this lease still resumable. Every other failure is unknown.
   * Committed does NOT prove startup or allow admission reopening: the recovery owner must
   * validate expected app/daemon/protocol/store/Keychain identity before new admissions.
   */
  activate(
    this: void,
    candidate: MacUpdateCandidate,
    lease: MacAdmissionLease,
  ): Promise<"committed" | "refused" | "unknown">;
}
/** Ports may be implemented in JS/native code: ready must carry usable guard handles. */
function isDraftLease(value: unknown): value is MacDraftLease {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "release" in value &&
    typeof value.release === "function"
  );
}
function isAdmissionLease(value: unknown): value is MacAdmissionLease {
  if (!isDraftLease(value) || !("target" in value)) return false;
  const target = value.target;
  return (
    typeof target === "object" &&
    target !== null &&
    !Array.isArray(target) &&
    "workspaceId" in target &&
    typeof target.workspaceId === "string" &&
    target.workspaceId.length > 0 &&
    "instanceId" in target &&
    typeof target.instanceId === "string" &&
    target.instanceId.length > 0 &&
    "epoch" in target &&
    typeof target.epoch === "number" &&
    Number.isSafeInteger(target.epoch) &&
    target.epoch >= 0
  );
}
function isDrainLease(value: unknown, expected: MacUpdateTarget, token: string): value is MacDrainLease {
  return (
    isAdmissionLease(value) &&
    "token" in value &&
    value.token === token &&
    "observe" in value &&
    typeof value.observe === "function" &&
    value.target.workspaceId === expected.workspaceId &&
    value.target.instanceId === expected.instanceId &&
    value.target.epoch === expected.epoch
  );
}
/** Normalize synchronous adapter exceptions as well as rejected promises. */
async function settled<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}
interface Offer {
  readonly id: string;
  readonly candidate: MacUpdateCandidate;
  readonly target: Readonly<MacUpdateTarget>;
}

/** Safe synthetic first slice for #387. Call reconsider on supported activity changes,
 * not a timer/store poll. Approval lives only in this process and is never restored.
 */
export class MacUpdates {
  private snapshot: MacUpdateSnapshot = Object.freeze({ phase: "idle" });
  private offer: Offer | undefined;
  private approved = false;
  private busy = false;
  private reconsiderPending = false;
  private sealed = false;
  private download: AbortController | undefined;
  private verified = false;
  private token: string | undefined;
  private drain: MacDrainLease | undefined;
  private deferring: Promise<void> | undefined;
  private readonly listeners = new Set<(state: MacUpdateSnapshot) => void>();

  constructor(private readonly ports: MacUpdatePorts) {}

  get state(): MacUpdateSnapshot {
    return this.snapshot;
  }
  subscribe(listener: (state: MacUpdateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private set(phase: MacUpdateSnapshot["phase"], blocker?: MacUpdateBlocker): void {
    this.snapshot = Object.freeze({
      phase,
      ...(this.offer ? { offerId: this.offer.id } : {}),
      ...(blocker ? { blocker } : {}),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot);
      } catch {
        /* Observers cannot alter lease ownership. */
      }
    }
  }
  /** Fresh offer IDs also invalidate same-version rebuilds and replayed approvals.
   * The caller must defer/revoke an old offer before replacing it while work is pending.
   */
  present(candidate: MacUpdateCandidate, target: MacUpdateTarget): string | undefined {
    if (this.busy || this.sealed || this.drain || this.deferring) return undefined;
    if (
      !/^[a-f0-9]{64}$/.test(candidate.manifestSha256) ||
      !candidate.channel ||
      !candidate.compatibilityPlanId ||
      !candidate.recoveryPlanId ||
      !target.workspaceId ||
      !target.instanceId ||
      !Number.isSafeInteger(target.epoch) ||
      target.epoch < 0
    )
      return undefined;
    // Copy only defined fields: caller mutation cannot change what was approved.
    this.offer = Object.freeze({
      id: randomUUID(),
      candidate: Object.freeze({
        manifestSha256: candidate.manifestSha256,
        channel: candidate.channel,
        compatibilityPlanId: candidate.compatibilityPlanId,
        recoveryPlanId: candidate.recoveryPlanId,
      }),
      target: Object.freeze({ workspaceId: target.workspaceId, instanceId: target.instanceId, epoch: target.epoch }),
    });
    this.approved = false;
    this.verified = false;
    this.reconsiderPending = false;
    this.set("available");
    return this.offer.id;
  }
  /** Revoke before the synchronous activation boundary, including while downloading or
   * preparing. Settled owned leases are released by the pending operation, never guessed.
   */
  defer(id: string): boolean {
    if (!this.offer || this.offer.id !== id || this.sealed) return false;
    this.approved = false;
    this.reconsiderPending = false;
    this.download?.abort();
    this.set("deferred");
    if (!this.busy && this.drain) {
      this.busy = true;
      this.deferring = this.releaseDrain()
        .then(() => undefined)
        .finally(() => {
          this.busy = false;
          this.deferring = undefined;
        });
    }
    return true;
  }
  /** Action owners await remote defer settlement before discarding candidate evidence. */
  async settled(): Promise<MacUpdateSnapshot> {
    await this.deferring;
    return this.state;
  }
  async approve(id: string): Promise<MacUpdateSnapshot> {
    if (!this.offer || this.offer.id !== id || this.busy || this.sealed || this.approved) return this.state;
    this.approved = true;
    this.token ??= randomUUID();
    return this.run(this.offer);
  }
  async reconsider(): Promise<MacUpdateSnapshot> {
    if (!this.offer || !this.approved || !this.verified || this.sealed) return this.state;
    if (this.busy) {
      this.reconsiderPending = true;
      return this.state;
    }
    return this.run(this.offer);
  }
  /** One operation owns busy from download through guard cleanup and notification drain.
   * The final pending check and busy release share one synchronous continuation: a later
   * notification starts a new owner, with no older caller left to clear that owner's busy.
   */
  private async run(offer: Offer): Promise<MacUpdateSnapshot> {
    this.busy = true;
    try {
      if (!this.drain) {
        this.set("preparing");
        if ((await this.observeDrain(offer)) === "stop") return this.state;
      }
      if (!this.verified) {
        this.download = new AbortController();
        this.set("downloading");
        const signal = this.download.signal;
        const result = await settled(() => this.ports.download(offer.candidate, signal), "failed");
        this.download = undefined;
        if (!this.approved) return this.state;
        if (result !== "verified") {
          this.approved = false;
          this.set("failed");
          return this.state;
        }
        this.verified = true;
      }
      do {
        this.reconsiderPending = false;
        await this.prepare(offer);
      } while (this.reconsiderPending && this.approved && !this.sealed && this.state.phase === "waiting");
    } catch {
      this.unknown();
    } finally {
      if (!this.approved && !this.sealed && this.drain) await this.releaseDrain();
      this.reconsiderPending = false;
      this.busy = false;
    }
    return this.state;
  }
  private unknown(): void {
    this.reconsiderPending = false;
    this.approved = false;
    this.sealed = true;
    this.set("recovery-required");
  }
  /** Reverse acquisition order; failed admission release keeps drafts frozen as well.
   * Never call release on a preparation whose ownership wasn't positively returned.
   */
  private async releaseDrain(): Promise<boolean> {
    const drain = this.drain;
    if (!drain) return true;
    if ((await settled(() => drain.release(), "unknown")) !== "released") {
      this.unknown();
      return false;
    }
    this.drain = undefined;
    this.token = undefined;
    return true;
  }
  private async release(drafts: MacDraftLease, admission?: MacAdmissionLease): Promise<boolean> {
    if (admission && (await settled(() => admission.release(), "unknown")) !== "released") {
      this.unknown();
      return false;
    }
    // Admission cleanup consumed the same remote owner; never release it twice.
    if (admission) {
      this.drain = undefined;
      this.token = undefined;
    }
    if (!admission && !this.approved && !(await this.releaseDrain())) return false;
    if ((await settled(() => drafts.release(), "unknown")) !== "released") {
      this.unknown();
      return false;
    }
    return true;
  }
  private drainUnknown(): "stop" {
    this.unknown();
    return "stop";
  }
  private async observeDrain(offer: Offer): Promise<"draining" | "held" | "stop"> {
    if (!this.approved) return "stop";
    if (this.ports.approvalCurrent) {
      const current = await settled(() => this.ports.approvalCurrent!(offer.candidate, offer.target), "unknown");
      if (current === "refused") {
        this.approved = false;
        this.verified = false;
        if (await this.releaseDrain()) this.set("failed", "candidate");
        return "stop";
      }
      if (current !== "valid") return this.drainUnknown();
      if (!this.approved) return "stop";
    }
    if (!this.drain) {
      if (!this.ports.drainAdmission) {
        this.approved = false;
        this.set("failed", "activity");
        return "stop";
      }
      const result = await settled(() => this.ports.drainAdmission!(offer.target, this.token!), { outcome: "unknown" });
      if (result?.outcome === "blocked") {
        this.approved = false;
        this.set("failed", result.blocker);
        return "stop";
      }
      if (result?.outcome !== "ready" || !isDrainLease(result.lease, offer.target, this.token!))
        return this.drainUnknown();
      this.drain = result.lease;
    }
    const drain = this.drain;
    if (!this.approved) return "stop";
    const observation = await settled(() => drain.observe(), "unknown");
    if (!isDrainLease(drain, offer.target, this.token!)) return this.drainUnknown();
    if (!this.approved) return "stop";
    if (observation !== "draining" && observation !== "held") return this.drainUnknown();
    return observation;
  }
  private async prepare(offer: Offer): Promise<void> {
    this.set("preparing");
    if (!this.approved) return;
    const observation = await this.observeDrain(offer);
    if (observation === "stop") return;
    if (observation === "draining") {
      this.set("waiting", "activity");
      return;
    }
    const drain = this.drain!;
    // Parked work/live callbacks were inventoried before any all-call/window freeze.
    const drafts = await settled(() => this.ports.prepareDrafts(), { outcome: "unknown" });
    if (drafts?.outcome !== "ready" && drafts?.outcome !== "blocked") return this.unknown();
    if (drafts.outcome === "blocked") {
      if (this.approved) this.set("waiting", drafts.blocker);
      return;
    }
    if (!isDraftLease(drafts.lease)) return this.unknown();
    if (!this.approved) {
      await this.release(drafts.lease);
      return;
    }
    const admission = await settled(() => this.ports.prepareAdmission(offer.target, this.token!, drain), {
      outcome: "unknown",
    });
    if (admission?.outcome !== "ready" && admission?.outcome !== "blocked") return this.unknown();
    if (admission.outcome === "blocked") {
      if ((await this.release(drafts.lease)) && this.approved) this.set("waiting", admission.blocker);
      return;
    }
    if (!isAdmissionLease(admission.lease)) return this.unknown();
    const actual = admission.lease.target;
    if (
      actual.workspaceId !== offer.target.workspaceId ||
      actual.instanceId !== offer.target.instanceId ||
      actual.epoch !== offer.target.epoch
    ) {
      // An adapter violated ownership: do not send resume to the unexpected target.
      return this.unknown();
    }
    if (!this.approved) {
      await this.release(drafts.lease, admission.lease);
      return;
    }
    if ((await settled(() => drain.observe(), "unknown")) !== "held") return this.unknown();
    const validation = await settled(() => this.ports.revalidate(offer.candidate, offer.target), "unknown");
    if (validation !== "valid" && validation !== "refused") return this.unknown();
    if (
      !isDrainLease(drain, offer.target, this.token!) ||
      !isDraftLease(drafts.lease) ||
      !isAdmissionLease(admission.lease) ||
      admission.lease.target.workspaceId !== offer.target.workspaceId ||
      admission.lease.target.instanceId !== offer.target.instanceId ||
      admission.lease.target.epoch !== offer.target.epoch
    )
      return this.unknown();
    if (validation === "refused") {
      this.approved = false;
      this.verified = false;
      if (await this.release(drafts.lease, admission.lease)) this.set("failed", "candidate");
      return;
    }
    if (!this.approved) {
      await this.release(drafts.lease, admission.lease);
      return;
    }
    // No await between final approval check and commitment. Defer cannot race this edge.
    this.sealed = true;
    this.approved = false;
    this.set("activating");
    const activation = await settled(() => this.ports.activate(offer.candidate, admission.lease), "unknown");
    if (activation !== "committed" && activation !== "refused") return this.unknown();
    if (activation === "committed") {
      this.set("awaiting-restart");
      return;
    }
    // A known refusal is the only activation outcome that permits old-state reopening.
    if (await this.release(drafts.lease, admission.lease)) {
      this.sealed = false;
      this.set("failed");
    }
  }
}
