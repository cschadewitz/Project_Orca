/** Candidate-bound complete-pair recovery policy; activation and reopening remain gated. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RuntimeMaintenanceTargetSchema } from "@orca/protocol";
import { freezeMacMetadata } from "./mac-candidate-manifest.js";
import { macAbortable, macBounded } from "./mac-candidate-download.js";
import {
  MacReplacementRecordSchema,
  MacProtectedPairSchema,
  type MacProtectedPair,
  type MacReplacementRecord,
} from "./mac-replacement-journal.js";
import type { MacUpdateCandidate } from "./mac-updates.js";
import type { MacVerifiedStartup } from "./mac-update-restart.js";

type RuntimeMaintenanceTarget = z.infer<typeof RuntimeMaintenanceTargetSchema>;

export interface MacRecoveryJournal {
  read(this: void): Promise<MacReplacementRecord | undefined>;
  commit(this: void, record: MacReplacementRecord): Promise<void>;
}
/** A trusted native owner holds EVERY configured protected writer/root plus bootstrap producers.
 * check must fail after any writer lease loss. Stopped means observed clean close, never PID absence.
 * Capture durably preserves and verifies a whole pair with its matching signed binary and independent
 * complete writer ledger. It is not store inventory, an epoch, diagnostics or a caller boolean.
 */
export interface MacProtectedOwner {
  readonly rootIds: readonly string[];
  check(this: void): boolean;
  stopped(this: void): boolean;
  capture(this: void, manifestSha256: string, signal: AbortSignal): Promise<unknown>;
  verify(this: void, pair: MacProtectedPair, signal: AbortSignal): Promise<boolean>;
  /** Rechecks the current complete generation under the SAME exclusive writer lease. */
  current(this: void, signal: AbortSignal): Promise<unknown>;
  /** Atomic supported complete-pair selection while closed. Must keep both generations intact.
   * Unknown selection never permits another restore/relaunch. No destructive in-place overlay. */
  restorePair(
    this: void,
    previous: MacProtectedPair,
    preserved: MacProtectedPair,
    signal: AbortSignal,
  ): Promise<"restored" | "unknown">;
}
export interface MacReplacementPorts {
  /** Bootstrap must consult the journal before normal startup/migration/listen/producer paths.
   * Persist/adopt this exact fence before touching protected state. No normal-start fallback. */
  closeBootstrap(this: void, record: MacReplacementRecord, signal: AbortSignal): Promise<"closed" | "unknown">;
  /** Uses the existing MacRestartVerification whole-image/health/version/identity/store guards.
   * No launch retry or consent reuse. A fresh supervisor may inspect an existing owned child. */
  verifyClosed(
    this: void,
    record: MacReplacementRecord,
    signal: AbortSignal,
  ): Promise<
    | { readonly outcome: "verified-closed"; readonly startup: MacVerifiedStartup }
    | { readonly outcome: "refused" | "unknown" }
  >;
}
export type MacRecoveryResult =
  | { readonly outcome: "prepared-closed" | "verified-closed" | "restored-closed"; readonly id: string }
  | { readonly outcome: "preserved"; readonly id: string; readonly reason: "newer-writes" | "incompatible" }
  | { readonly outcome: "unknown" | "refused" };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function complete(pair: MacProtectedPair, roots: readonly string[]): boolean {
  return (
    pair.roots.length === roots.length &&
    new Set(roots).size === roots.length &&
    new Set(pair.roots.map((root) => root.id)).size === roots.length &&
    roots.every((id) => pair.roots.some((root) => root.id === id))
  );
}
function noNewerWrites(previous: MacProtectedPair, current: MacProtectedPair): boolean {
  return (
    previous.writerEpoch === current.writerEpoch &&
    previous.writeRevision === current.writeRevision &&
    previous.stateSha256 === current.stateSha256 &&
    previous.continuitySha256 === current.continuitySha256 &&
    previous.roots.length === current.roots.length &&
    previous.roots.every((root) => current.roots.some((other) => other.id === root.id && other.sha256 === root.sha256))
  );
}

/** One owner/attempt, bounded read/capture operations, durable intentions before irreversible edges.
 * No production constructor/default owner. Restarts consume only recovery identity, never approval.
 * Every positive outcome remains closed. Interrupted launching/restoring never auto-retries.
 */
export class MacReplacementRecovery {
  private operation: Promise<MacRecoveryResult> | undefined;
  private result: MacRecoveryResult | undefined;
  private readonly owner: MacProtectedOwner;
  private readonly ports: MacReplacementPorts;
  constructor(
    private readonly journal: MacRecoveryJournal,
    owner: MacProtectedOwner,
    ports: MacReplacementPorts,
    private readonly operationMs: number,
  ) {
    this.owner = Object.freeze({
      ...owner,
      rootIds: Object.freeze([...owner.rootIds]),
      check: owner.check,
      stopped: owner.stopped,
      capture: owner.capture,
      verify: owner.verify,
      current: owner.current,
      restorePair: owner.restorePair,
    });
    this.ports = Object.freeze({ closeBootstrap: ports.closeBootstrap, verifyClosed: ports.verifyClosed });
  }
  private run(
    work: (signal: AbortSignal) => Promise<MacRecoveryResult>,
    signal: AbortSignal,
  ): Promise<MacRecoveryResult> {
    if (this.operation) return this.operation;
    if (this.result) return Promise.resolve(this.result);
    this.operation = Promise.resolve()
      .then(async () => {
        try {
          if (!Number.isSafeInteger(this.operationMs) || this.operationMs <= 0 || this.operationMs > 2_147_483_647)
            return { outcome: "refused" as const };
          return await macBounded(signal, this.operationMs, work);
        } catch {
          return { outcome: "unknown" as const };
        }
      })
      .then((result) => {
        this.result = freezeMacMetadata(result);
        return this.result;
      });
    return this.operation;
  }
  private check(signal: AbortSignal): void {
    if (signal.aborted || !this.owner.check()) throw new Error("Protected writer owner changed");
  }
  private async read<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    this.check(signal);
    const result = await macAbortable(operation, signal);
    this.check(signal);
    return result;
  }
  private async commit(record: MacReplacementRecord, signal: AbortSignal): Promise<void> {
    this.check(signal);
    // Do not cancel a dispatched durable write. Timeout seals the caller; late completion
    // cannot authorize activation. Native storage itself must settle before releasing handles.
    await this.read(() => this.journal.commit(freezeMacMetadata(MacReplacementRecordSchema.parse(record))), signal);
  }
  /** Called only after the exact process-local commit owner has accepted the signed engine,
   * held drafts/admission and observed clean owned stop. Missing producer cannot be synthesized.
   * closed journal + verified previous pair precede native staging/ordinary quit. */
  prepare(
    input: {
      candidate: MacUpdateCandidate;
      previousManifestSha256: string;
      previousTarget: RuntimeMaintenanceTarget;
      token: string;
    },
    signal: AbortSignal,
  ): Promise<MacRecoveryResult> {
    const captured = structuredClone(input);
    return this.run(async (bounded) => {
      if (!this.owner.stopped()) return { outcome: "refused" };
      if (await this.read(() => this.journal.read(), bounded)) return { outcome: "unknown" };
      const previous = MacProtectedPairSchema.parse(
        await this.read(() => this.owner.capture(captured.previousManifestSha256, bounded), bounded),
      );
      if (
        !complete(previous, this.owner.rootIds) ||
        previous.manifestSha256 !== captured.previousManifestSha256 ||
        !(await this.read(() => this.owner.verify(previous, bounded), bounded))
      )
        return { outcome: "unknown" };
      const record = MacReplacementRecordSchema.parse({
        version: 1,
        id: randomUUID(),
        fenceId: randomUUID(),
        token: z.uuid().parse(captured.token),
        previousTarget: RuntimeMaintenanceTargetSchema.parse(captured.previousTarget),
        candidate: captured.candidate,
        rootIds: this.owner.rootIds,
        phase: "closed",
        previous,
      });
      await this.commit(record, bounded);
      if ((await this.read(() => this.ports.closeBootstrap(record, bounded), bounded)) !== "closed")
        return { outcome: "unknown" };
      return { outcome: "prepared-closed", id: record.id };
    }, signal);
  }
  /** Fresh app must do this before ordinary Workspace.connect, migration or normal producers.
   * Does not launch or activate a candidate; the caller supplies an already closed owned process. */
  recover(signal: AbortSignal): Promise<MacRecoveryResult> {
    return this.run(async (bounded) => {
      const raw = await this.read(() => this.journal.read(), bounded);
      if (!raw) return { outcome: "refused" };
      let record = freezeMacMetadata(MacReplacementRecordSchema.parse(raw));
      if (!same(record.rootIds, this.owner.rootIds)) return { outcome: "unknown" };
      if ((await this.read(() => this.ports.closeBootstrap(record, bounded), bounded)) !== "closed")
        return { outcome: "unknown" };
      if (record.phase === "restoring" || record.phase === "launching" || record.phase === "restored-closed")
        return { outcome: "unknown" };
      if (!(await this.read(() => this.owner.verify(record.previous, bounded), bounded))) return { outcome: "unknown" };
      if (record.phase === "preserved") {
        if (
          !record.current ||
          !complete(record.current, record.rootIds) ||
          !(await this.read(() => this.owner.verify(record.current!, bounded), bounded))
        )
          return { outcome: "unknown" };
        return { outcome: "preserved", id: record.id, reason: "newer-writes" };
      }
      record = { ...record, phase: "launching" };
      await this.commit(record, bounded);
      const startup = await this.read(() => this.ports.verifyClosed(record, bounded), bounded);
      if (startup.outcome === "verified-closed") {
        const target = RuntimeMaintenanceTargetSchema.parse(startup.startup.target);
        if (
          startup.startup.scope !== "startup-only" ||
          startup.startup.manifestSha256 !== record.candidate.manifestSha256 ||
          target.workspaceId !== record.previousTarget.workspaceId ||
          target.instanceId === record.previousTarget.instanceId
        )
          return { outcome: "unknown" };
        await this.commit({ ...record, phase: "verified-closed" }, bounded);
        return { outcome: "verified-closed", id: record.id };
      }
      // Unknown startup may leave a writer alive: preserve existing files/fences and never stop it.
      if (startup.outcome !== "refused" || !this.owner.stopped()) return { outcome: "unknown" };
      const current = MacProtectedPairSchema.parse(
        await this.read(() => this.owner.capture(record.candidate.manifestSha256, bounded), bounded),
      );
      if (
        !complete(current, record.rootIds) ||
        current.id === record.previous.id ||
        current.manifestSha256 !== record.candidate.manifestSha256 ||
        !(await this.read(() => this.owner.verify(current, bounded), bounded))
      )
        return { outcome: "unknown" };
      record = { ...record, phase: "preserved", current };
      await this.commit(record, bounded);
      if (!noNewerWrites(record.previous, current))
        return { outcome: "preserved", id: record.id, reason: "newer-writes" };
      // The independent all-write ledger and full state/continuity equality are both required.
      const observed = MacProtectedPairSchema.parse(await this.read(() => this.owner.current(bounded), bounded));
      if (!same(observed, current) || !this.owner.stopped())
        return { outcome: "preserved", id: record.id, reason: "incompatible" };
      if (!(await this.read(() => this.owner.verify(record.previous, bounded), bounded))) return { outcome: "unknown" };
      await this.commit({ ...record, phase: "restoring" }, bounded);
      if (!this.owner.stopped()) return { outcome: "unknown" };
      const restored = await this.read(() => this.owner.restorePair(record.previous, current, bounded), bounded);
      if (restored !== "restored") return { outcome: "unknown" };
      // A selected old pair still requires fresh old-image startup checks; no admission is reopened.
      await this.commit({ ...record, phase: "restored-closed" }, bounded);
      return { outcome: "restored-closed", id: record.id };
    }, signal);
  }
}

export type MacBootstrapDecision =
  | { readonly outcome: "ordinary" }
  | { readonly outcome: "replacement-closed"; readonly record: MacReplacementRecord }
  | { readonly outcome: "unknown" };
/** Main/producer bootstrap starts closed synchronously, before any journal/key/store await.
 * The integration owner must consult ordinaryAllowed before normal connect/migration/producer
 * entry. Reading a saved record never restores installation consent or opens replacement work.
 */
export class MacReplacementBootstrap {
  private decision: MacBootstrapDecision | undefined;
  private operation: Promise<MacBootstrapDecision> | undefined;
  constructor(private readonly journal: Pick<MacRecoveryJournal, "read">) {}
  get ordinaryAllowed(): boolean {
    return this.decision?.outcome === "ordinary";
  }
  inspect(): Promise<MacBootstrapDecision> {
    if (this.operation) return this.operation;
    this.operation = Promise.resolve()
      .then(async (): Promise<MacBootstrapDecision> => {
        try {
          const record = await macBounded(new AbortController().signal, 5000, (signal) =>
            macAbortable(() => this.journal.read(), signal),
          );
          return record
            ? { outcome: "replacement-closed", record: freezeMacMetadata(MacReplacementRecordSchema.parse(record)) }
            : { outcome: "ordinary" };
        } catch {
          return { outcome: "unknown" };
        }
      })
      .then((value) => {
        this.decision = freezeMacMetadata(value);
        return this.decision;
      });
    return this.operation;
  }
}
