/** #387 disabled owned stop and coherent replacement startup; never installs, restores or reopens admission. */
import type { ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  DaemonCapabilitySchema,
  HelloResultSchema,
  RuntimeMaintenanceResultSchema,
  RuntimeMaintenanceTargetSchema,
  type DaemonCapability,
  type RuntimeMaintenanceParams,
} from "@orca/protocol";
import { macAbortable, macBounded } from "./mac-candidate-download.js";
import {
  freezeMacMetadata,
  macContractText,
  MAC_METADATA_LIMIT,
  matchesSealedMacIdentity,
  readMacManifest,
  sha256,
  type NativeMacManifest,
} from "./mac-candidate-manifest.js";
import type { MacUpdateCandidate } from "./mac-updates.js";

export type MacRestartChild = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once" | "kill">;
type RuntimeMaintenanceTarget = RuntimeMaintenanceParams["target"];
export interface MacStoppedReceipt {
  readonly target: Readonly<RuntimeMaintenanceTarget>;
}
interface StoppedOwner {
  readonly child: MacRestartChild;
  readonly target: Readonly<RuntimeMaintenanceTarget>;
  claimed: boolean;
}
const stoppedOwners = new WeakMap<MacStoppedReceipt, StoppedOwner>();
export type MacOwnedStopResult =
  { readonly outcome: "stopped"; readonly receipt: MacStoppedReceipt } | { readonly outcome: "refused" | "unknown" };
interface StopAttempt {
  readonly target: Readonly<RuntimeMaintenanceTarget>;
  readonly result: Promise<MacOwnedStopResult>;
}
// Kept for this supervisor's lifetime: controller recreation must not erase an unknown
// attempt. Target keys also cover another view of the same child; child keys prohibit
// retargeting a captured process to escape its attempt. No durable restart authority.
const stopAttempts = new Map<string, StopAttempt>();
const childStopAttempts = new WeakMap<MacRestartChild, StopAttempt>();
function stopTargetKey(target: RuntimeMaintenanceTarget): string {
  return JSON.stringify([target.workspaceId, target.instanceId, target.processId]);
}
export interface MacOwnedStopBoundary {
  /** Current all-window/local target reservation; must remain held through positive exit. */
  check(this: void): boolean;
  /** Fresh authenticated runtime-v1 proof for this exact owned process; no legacy-idle inference. */
  proof(this: void, target: Readonly<RuntimeMaintenanceTarget>, signal: AbortSignal): Promise<unknown>;
}
function alive(child: MacRestartChild): boolean {
  return (
    Number.isSafeInteger(child.pid) &&
    !!child.pid &&
    child.pid > 0 &&
    child.exitCode === null &&
    child.signalCode === null
  );
}
function sameTarget(a: RuntimeMaintenanceTarget, b: RuntimeMaintenanceTarget): boolean {
  return a.workspaceId === b.workspaceId && a.instanceId === b.instanceId && a.processId === b.processId;
}
function boundMs(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

/** An update stop never calls BundledDaemon.stop (which escalates), never signals a PID by name,
 * and never retries an unknown stop. Only the captured child gets one SIGTERM after owned idle
 * proof. Positive clean close mints a process-local, single-use receipt; crash/timeout/loss retain
 * unknown and cannot authorize a replacement. Close observes the existing daemon's own drainage.
 */
export class MacUpdateOwnedStop {
  private readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  private result: Promise<MacOwnedStopResult> | undefined;
  private readonly target: Readonly<RuntimeMaintenanceTarget>;
  private readonly boundary: MacOwnedStopBoundary;
  constructor(
    private readonly child: MacRestartChild,
    target: RuntimeMaintenanceTarget,
    boundary: MacOwnedStopBoundary,
    private readonly operationMs: number,
  ) {
    this.target = Object.freeze({ ...RuntimeMaintenanceTargetSchema.parse(target) });
    this.boundary = Object.freeze({ check: boundary.check, proof: boundary.proof });
    this.closed = new Promise((done) => {
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        done({ code, signal });
      });
    });
  }
  stop(signal: AbortSignal): Promise<MacOwnedStopResult> {
    // Initialize the instance promise before run claims it, including when a proof
    // callback synchronously creates another controller for this captured process.
    return (this.result ??= Promise.resolve().then(() => this.run(signal)));
  }
  private async run(signal: AbortSignal): Promise<MacOwnedStopResult> {
    const key = stopTargetKey(this.target);
    try {
      const childAttempt = childStopAttempts.get(this.child);
      if (childAttempt && !sameTarget(childAttempt.target, this.target)) return { outcome: "unknown" };
      const existing = stopAttempts.get(key) ?? childAttempt;
      if (existing) {
        childStopAttempts.set(this.child, existing);
        return existing.result;
      }
      if (
        !boundMs(this.operationMs) ||
        signal.aborted ||
        this.child.pid !== this.target.processId ||
        !this.boundary.check()
      )
        return { outcome: "refused" };
      // The initial synchronous eligibility checks do not acquire another target.
      // Claim before any proof await; every subsequent controller shares this exact
      // attempt/result/receipt, including terminal unknown, with no release or retry.
      this.claim(key);
      if (!alive(this.child)) return { outcome: "unknown" };
      return await macBounded(signal, this.operationMs, async (bounded) => {
        const proof = RuntimeMaintenanceResultSchema.parse(
          await macAbortable(() => this.boundary.proof(this.target, bounded), bounded),
        );
        if (!sameTarget(proof.target, this.target)) return { outcome: "unknown" };
        if (proof.outcome === "blocked") return { outcome: "refused" };
        if (
          proof.outcome !== "held" ||
          this.child.pid !== this.target.processId ||
          !alive(this.child) ||
          !this.boundary.check() ||
          bounded.aborted
        )
          return { outcome: "unknown" };
        // No await between final ownership/idle check and signalling this captured child.
        if (!this.child.kill("SIGTERM")) return { outcome: "unknown" };
        const exit = await macAbortable(() => this.closed, bounded);
        if (
          bounded.aborted ||
          exit.code !== 0 ||
          exit.signal !== null ||
          this.child.pid !== this.target.processId ||
          this.child.exitCode !== 0 ||
          this.child.signalCode !== null ||
          !this.boundary.check()
        )
          return { outcome: "unknown" };
        const receipt = Object.freeze({ target: this.target });
        stoppedOwners.set(receipt, { child: this.child, target: this.target, claimed: false });
        return { outcome: "stopped", receipt };
      });
    } catch {
      // A lost initial ownership/child observation is unknown too; recreating the
      // controller cannot convert that missing evidence into a fresh stop attempt.
      if (!stopAttempts.has(key) && !childStopAttempts.has(this.child)) this.claim(key);
      return { outcome: "unknown" };
    }
  }
  private claim(key: string): void {
    const attempt: StopAttempt = { target: this.target, result: this.result! };
    stopAttempts.set(key, attempt);
    childStopAttempts.set(this.child, attempt);
  }
}
export interface MacRestartBinding {
  readonly candidate: Readonly<MacUpdateCandidate>;
  readonly manifest: Readonly<NativeMacManifest>;
  readonly previous: Readonly<RuntimeMaintenanceTarget>;
  readonly storeDir: string;
  readonly capabilities: readonly DaemonCapability[];
  readonly methods: readonly string[];
}
export interface MacRestartProcess {
  readonly child: MacRestartChild;
  /** Independent metadata from the captured fresh child, not copied from an HTTP hello. */
  readonly instanceId: string;
  readonly fenceId: string;
  /** Must use existing requireAuthentication=true owner-token client, no refresh/retry/fallback. */
  hello(this: void, signal: AbortSignal): Promise<unknown>;
  /** Native owner verifies actual running app image against the exact trusted candidate, raw
   * sealed build identity and actual bundled daemon bytes. No hash/declaration-only fallback. */
  image(this: void, signal: AbortSignal): Promise<unknown>;
  /** Supported owner observation, not a guessed marker or private-store scan. Epoch equality
   * alone is not all-write compatibility, a complete backup or plugin restoration proof. */
  store(this: void, signal: AbortSignal): Promise<unknown>;
  /** Guarantees this fence was installed before listen/producer entry and stays held until
   * an explicit owner action. No read/probe is allowed to briefly reopen it. */
  closed(this: void, signal: AbortSignal): Promise<unknown>;
}
export interface MacRestartPorts {
  /** Creates only a fresh owned process, admission closed from bootstrap. Refused positively
   * proves no process started. Every lost/throwing/partial launch is unknown; never auto-kill. */
  startClosed(
    this: void,
    binding: MacRestartBinding,
    signal: AbortSignal,
  ): Promise<
    { readonly outcome: "started"; readonly process: MacRestartProcess } | { readonly outcome: "refused" | "unknown" }
  >;
  /** Local all-window/candidate/target owner reservation remains authoritative. */
  check(this: void): boolean;
}
export interface MacRestartRequest {
  readonly stopped: MacStoppedReceipt;
  readonly candidate: MacUpdateCandidate;
  readonly manifestBytes: Uint8Array;
  readonly storeDir: string;
  readonly capabilities: readonly DaemonCapability[];
  readonly methods: readonly string[];
}
export interface MacVerifiedStartup {
  readonly manifestSha256: string;
  readonly target: Readonly<RuntimeMaintenanceTarget>;
  /** This receipt is startup evidence only, never recovery/installation/reopening authority. */
  readonly scope: "startup-only";
}
export type MacRestartResult =
  | { readonly outcome: "verified-closed"; readonly startup: MacVerifiedStartup }
  | {
      readonly outcome: "refused";
      readonly reason: "candidate" | "ownership" | "image" | "identity" | "store" | "restoration" | "capability";
    }
  | { readonly outcome: "unknown" };
const status = z.strictObject({ outcome: z.enum(["refused", "unknown"]) });
const imageSchema = z.union([
  status,
  z.strictObject({
    outcome: z.literal("verified"),
    target: RuntimeMaintenanceTargetSchema,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    wholeAppMatched: z.literal(true),
    identityBytes: z.instanceof(Uint8Array),
    daemonSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
const storeSchema = z.union([
  status,
  z.strictObject({
    outcome: z.literal("observed"),
    target: RuntimeMaintenanceTargetSchema,
    directory: z.string(),
    epoch: z.string(),
    work: z.enum(["empty", "parked", "unsupported-generation"]),
  }),
]);
const closedSchema = z.strictObject({
  outcome: z.literal("closed"),
  target: RuntimeMaintenanceTargetSchema,
  fenceId: z.uuid(),
});

/** Disabled main-only restart verification, in a surviving supervisor. No production constructor,
 * persistence, rollback, recovery import, release of admission, provider replay or restore claim.
 * One receipt allows one launch; unknowns seal it. Positive terminal state remains closed.
 */
export class MacRestartVerification {
  private result: MacRestartResult | undefined;
  private operation: Promise<MacRestartResult> | undefined;
  private binding: MacRestartBinding | undefined;
  private process: MacRestartProcess | undefined;
  private target: Readonly<RuntimeMaintenanceTarget> | undefined;
  private readonly ports: MacRestartPorts | undefined;
  constructor(
    ports?: MacRestartPorts,
    private readonly operationMs = 0,
  ) {
    this.ports = ports ? Object.freeze({ startClosed: ports.startClosed, check: ports.check }) : undefined;
  }
  get state(): MacRestartResult | undefined {
    return this.operation ? undefined : this.result;
  }
  verify(request: MacRestartRequest, signal: AbortSignal): Promise<MacRestartResult> {
    if (this.operation) return this.operation;
    if (this.result) return Promise.resolve(this.result);
    this.operation = this.begin(request, signal).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  private async begin(request: MacRestartRequest, signal: AbortSignal): Promise<MacRestartResult> {
    try {
      if (
        !this.ports ||
        typeof this.ports.startClosed !== "function" ||
        typeof this.ports.check !== "function" ||
        !boundMs(this.operationMs)
      )
        return this.finish({ outcome: "refused", reason: "ownership" });
      const owner = stoppedOwners.get(request.stopped);
      if (!owner || owner.claimed || !this.ports.check())
        return this.finish({ outcome: "refused", reason: "ownership" });
      try {
        this.binding = this.captureBinding(request, owner.target);
      } catch {
        return this.finish({ outcome: "refused", reason: "candidate" });
      }
      owner.claimed = true;
      return await macBounded(signal, this.operationMs, async (bounded) => {
        const launched = await macAbortable(() => this.ports!.startClosed(this.binding!, bounded), bounded);
        if (
          !launched ||
          (launched.outcome !== "started" && launched.outcome !== "refused" && launched.outcome !== "unknown")
        )
          return this.finish({ outcome: "unknown" });
        if (launched.outcome !== "started")
          return this.finish(
            launched.outcome === "refused" ? { outcome: "refused", reason: "ownership" } : { outcome: "unknown" },
          );
        const process = launched.process;
        if (!process || process.child === owner.child || !alive(process.child))
          return this.finish({ outcome: "unknown" });
        this.target = Object.freeze(
          RuntimeMaintenanceTargetSchema.parse({
            workspaceId: owner.target.workspaceId,
            instanceId: process.instanceId,
            processId: process.child.pid,
          }),
        );
        if (
          this.target.instanceId === owner.target.instanceId ||
          !z.uuid().safeParse(process.fenceId).success ||
          ![process.hello, process.image, process.store, process.closed].every((port) => typeof port === "function")
        )
          return this.finish({ outcome: "unknown" });
        // Capture function/child/fence references: asynchronous caller mutation cannot retarget.
        this.process = Object.freeze({
          child: process.child,
          instanceId: process.instanceId,
          fenceId: process.fenceId,
          hello: process.hello,
          image: process.image,
          store: process.store,
          closed: process.closed,
        });
        return this.finish(await this.inspect(bounded));
      });
    } catch {
      return this.finish({ outcome: "unknown" });
    }
  }
  private captureBinding(
    request: Omit<MacRestartRequest, "stopped">,
    previous: RuntimeMaintenanceTarget,
  ): MacRestartBinding {
    if (request.manifestBytes.length > MAC_METADATA_LIMIT) throw new Error("Candidate refused");
    const bytes = Buffer.from(request.manifestBytes);
    const manifest = freezeMacMetadata(readMacManifest(bytes));
    const candidate = Object.freeze({
      manifestSha256: request.candidate.manifestSha256,
      channel: request.candidate.channel,
      compatibilityPlanId: request.candidate.compatibilityPlanId,
      recoveryPlanId: request.candidate.recoveryPlanId,
    });
    if (
      manifest.kind !== "candidate" ||
      manifest.signing.teamId !== "Q2FP9UY5T4" ||
      sha256(bytes) !== candidate.manifestSha256 ||
      ![candidate.channel, candidate.compatibilityPlanId, candidate.recoveryPlanId].every(macContractText) ||
      !isAbsolute(request.storeDir) ||
      resolve(request.storeDir) !== request.storeDir ||
      !request.methods.includes("hello") ||
      !request.methods.includes("maintenance") ||
      !request.methods.every(macContractText)
    )
      throw new Error("Candidate refused");
    const capabilities = z.array(DaemonCapabilitySchema).parse(request.capabilities);
    return freezeMacMetadata({
      candidate,
      manifest,
      previous,
      storeDir: request.storeDir,
      capabilities,
      methods: [...request.methods],
    });
  }
  /** Fresh durable supervisor inspects an ALREADY owned closed replacement. The journal owner
   * must independently establish the child and exact durable fence before calling. This path
   * cannot launch, consume/recreate stop receipts, reuse consent or release admission. */
  inspectExistingClosed(
    request: Omit<MacRestartRequest, "stopped"> & {
      readonly previous: RuntimeMaintenanceTarget;
      readonly process: MacRestartProcess;
      readonly fenceId: string;
    },
    signal: AbortSignal,
  ): Promise<MacRestartResult> {
    if (this.operation) return this.operation;
    if (this.result) return Promise.resolve(this.result);
    this.operation = this.inspectExisting(request, signal).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  private async inspectExisting(
    request: Omit<MacRestartRequest, "stopped"> & {
      readonly previous: RuntimeMaintenanceTarget;
      readonly process: MacRestartProcess;
      readonly fenceId: string;
    },
    signal: AbortSignal,
  ): Promise<MacRestartResult> {
    try {
      if (!this.ports || !boundMs(this.operationMs) || !this.ports.check())
        return this.finish({ outcome: "refused", reason: "ownership" });
      const previous = RuntimeMaintenanceTargetSchema.parse(request.previous);
      try {
        this.binding = this.captureBinding(request, previous);
      } catch {
        return this.finish({ outcome: "refused", reason: "candidate" });
      }
      const process = request.process;
      if (
        !alive(process.child) ||
        process.instanceId === previous.instanceId ||
        !z.uuid().safeParse(request.fenceId).success ||
        process.fenceId !== request.fenceId ||
        ![process.hello, process.image, process.store, process.closed].every((port) => typeof port === "function")
      )
        return this.finish({ outcome: "unknown" });
      this.target = Object.freeze(
        RuntimeMaintenanceTargetSchema.parse({
          workspaceId: previous.workspaceId,
          instanceId: process.instanceId,
          processId: process.child.pid,
        }),
      );
      this.process = Object.freeze({
        child: process.child,
        instanceId: process.instanceId,
        fenceId: process.fenceId,
        hello: process.hello,
        image: process.image,
        store: process.store,
        closed: process.closed,
      });
      return this.finish(await macBounded(signal, this.operationMs, (bounded) => this.inspect(bounded)));
    } catch {
      return this.finish({ outcome: "unknown" });
    }
  }
  /** Fresh same-child verification for a synthetic caller immediately before its simulated
   * reopening. This method itself never releases any fence, including on known refusal.
   * Once refused/unknown, neither recheck nor verify retries or launches another process. */
  recheck(signal: AbortSignal): Promise<MacRestartResult> {
    if (this.operation) return this.operation;
    if (this.result?.outcome !== "verified-closed") return Promise.resolve(this.result ?? { outcome: "unknown" });
    this.operation = this.checkAgain(signal).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  private async checkAgain(signal: AbortSignal): Promise<MacRestartResult> {
    try {
      return this.finish(await macBounded(signal, this.operationMs, (bounded) => this.inspect(bounded)));
    } catch {
      return this.finish({ outcome: "unknown" });
    }
  }
  private finish(value: MacRestartResult): MacRestartResult {
    this.result = freezeMacMetadata(value);
    return this.result;
  }
  private current(signal: AbortSignal): boolean {
    return (
      !signal.aborted &&
      !!this.process &&
      !!this.target &&
      this.process.child.pid === this.target.processId &&
      alive(this.process.child) &&
      this.ports?.check() === true
    );
  }
  private async inspect(signal: AbortSignal): Promise<MacRestartResult> {
    const process = this.process!;
    const binding = this.binding!;
    const target = this.target!;
    const read = async <T>(operation: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> => {
      if (!this.current(signal)) throw new Error("Startup owner changed");
      const result = schema.parse(await macAbortable(operation, signal));
      if (!this.current(signal)) throw new Error("Startup owner changed");
      return result;
    };
    const fence = async () => {
      const result = await read(() => process.closed(signal), closedSchema);
      if (!sameTarget(result.target, target) || result.fenceId !== process.fenceId)
        throw new Error("Startup fence changed");
    };
    const image = async (): Promise<boolean | "unknown"> => {
      const result = await read(() => process.image(signal), imageSchema);
      if (result.outcome === "unknown") return "unknown";
      return (
        result.outcome === "verified" &&
        sameTarget(result.target, target) &&
        result.manifestSha256 === binding.candidate.manifestSha256 &&
        result.daemonSha256 === binding.manifest.identity.daemon.sha256 &&
        matchesSealedMacIdentity(binding.manifest, result.identityBytes)
      );
    };
    const hello = async (): Promise<MacRestartResult | undefined> => {
      const result = await read(() => process.hello(signal), HelloResultSchema);
      if (
        !result.identity ||
        result.identity.workspaceId !== target.workspaceId ||
        result.identity.instanceId !== target.instanceId ||
        result.processId !== target.processId ||
        result.orcaVersion !== binding.manifest.identity.daemon.version ||
        result.protocol.major !== binding.manifest.identity.protocol.major ||
        result.protocol.minor !== binding.manifest.identity.protocol.minor ||
        result.storeDir !== binding.storeDir
      )
        return { outcome: "refused", reason: "identity" };
      if (
        !binding.capabilities.every((capability) => result.capabilities.includes(capability)) ||
        !binding.methods.every((method) => result.methods?.includes(method))
      )
        return { outcome: "refused", reason: "capability" };
      return undefined;
    };
    await fence();
    const firstImage = await image();
    if (firstImage === "unknown") return { outcome: "unknown" };
    if (!firstImage) return { outcome: "refused", reason: "image" };
    const firstHello = await hello();
    if (firstHello) return firstHello;
    const store = async (): Promise<MacRestartResult | undefined> => {
      const result = await read(() => process.store(signal), storeSchema);
      if (result.outcome === "unknown") return { outcome: "unknown" };
      if (
        result.outcome !== "observed" ||
        !sameTarget(result.target, target) ||
        result.directory !== binding.storeDir ||
        result.epoch !== binding.manifest.identity.storeEpoch
      )
        return { outcome: "refused", reason: "store" };
      // No opt-in restoration proof is implemented here: parked/unsupported generations refuse.
      if (result.work !== "empty") return { outcome: "refused", reason: "restoration" };
      return undefined;
    };
    const firstStore = await store();
    if (firstStore) return firstStore;
    await fence();
    const finalImage = await image();
    if (finalImage === "unknown") return { outcome: "unknown" };
    if (!finalImage) return { outcome: "refused", reason: "image" };
    const finalHello = await hello();
    if (finalHello) return finalHello;
    const finalStore = await store();
    if (finalStore) return finalStore;
    await fence();
    if (!this.current(signal)) return { outcome: "unknown" };
    return {
      outcome: "verified-closed",
      startup: Object.freeze({ manifestSha256: binding.candidate.manifestSha256, target, scope: "startup-only" }),
    };
  }
}
