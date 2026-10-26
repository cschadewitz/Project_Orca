/** Inactive #703 owner-local fence. Qualified memory/file fixtures only; no barrel export or production wiring. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  OrcaError,
  type ActionEvidenceV1,
  type AuthorityStampV1,
  type Clock,
  type BoundReviewV1,
  type PendingReviewV1,
  type JudgeRequestV1,
  type JudgeResultV1,
  type CoverageV1,
  type EnforcementPortV1,
  type ExecutionReceiptV1,
  type InvocationV1,
  type OneUsePermitV1,
  type PolicyEvaluationV1,
  type PolicyPortV1,
  type PolicyVerdictV1,
} from "@orca/core";
import { memoryCaptureQualifier } from "./disposable-memory-read.js";
import { fileCaptureQualifier } from "./disposable-file-read.js";
import { ownedFileCaptureQualifier } from "./owned-file-read-service.js";
import type { LiveInputBinding } from "./live-input.js";

type Allow = Extract<PolicyVerdictV1, { outcome: "allow" }>;

export interface SyntheticReadOwnerSnapshot {
  readonly invocation: InvocationV1;
  readonly authority: AuthorityStampV1;
  readonly coverage: CoverageV1;
  readonly cwd: string;
  readonly workspaceRef: string;
  readonly relevantStateRefs: readonly string[];
  readonly expiresAt: string;
}

/** Trusted injection only: daemon binding/current lease checks are not implemented by this fixture. */
export interface SyntheticReadOwner {
  readonly signal: AbortSignal;
  readonly clock: Clock;
  readonly withOwnership: LiveInputBinding["withOwnership"];
  snapshot(): SyntheticReadOwnerSnapshot;
  /** Current original principal/authority under ownership, never caller metadata. */
  authorize(action: ActionEvidenceV1, signal: AbortSignal): Promise<void>;
  /** Synchronous last check, including lease expiry, cancellation, revisions and state. */
  assertCurrent(action: ActionEvidenceV1): void;
}

/** Only the reviewed fixture codec is admitted. No arbitrary tool registration surface. */
export interface SyntheticReadExecutor<Parameters, Capture> {
  readonly codecVersion:
    | "orca-synthetic-acp-read-v1"
    | "orca-disposable-memory-read-v1"
    | "orca-disposable-file-read-v1"
    | "orca-owned-file-read-v1";
  capture(parameters: Parameters): Capture;
  encode(capture: Capture): string;
  /** Must start the injected read synchronously; the returned promise settles outside ownership. */
  execute(capture: Capture, action: ActionEvidenceV1, protectedEvidenceRef: string, signal: AbortSignal): Promise<void>;
}

export type FenceObservation =
  | { readonly state: "unknown" }
  | {
      readonly state: "observed" | "not-observed";
      readonly sourceRef: string;
      readonly observedAt: string;
    };
export type FenceObservations = Readonly<Record<"recording" | "delivery" | "dispatch" | "effect", FenceObservation>>;

/** Adapter to existing protected records; no new durable ledger or production record schema here. */
export interface SyntheticFenceEvidence {
  recordCapture(action: ActionEvidenceV1, retainedBytes: string): Promise<void>;
  recordAuthorization(action: ActionEvidenceV1, verdict: Allow, protectedEvidenceRef: string): Promise<void>;
  read(action: ActionEvidenceV1, protectedEvidenceRef: string): Promise<Partial<FenceObservations>>;
}
export interface FenceReadAuthority {
  authorizeRead(invocation: InvocationV1, signal: AbortSignal): Promise<void>;
}

interface Entry<Capture> {
  action: ActionEvidenceV1;
  owner: SyntheticReadOwnerSnapshot;
  capture: Capture;
  bytes: string;
  evidenceRef: string;
  originalSignal?: AbortSignal;
  evaluation?: Promise<PolicyEvaluationV1>;
  verdict?: PolicyVerdictV1;
  pending?: PendingReviewV1;
  bound?: BoundReviewV1;
  reviewClaimed?: boolean;
  authorization?: Promise<OneUsePermitV1>;
  permit?: OneUsePermitV1;
  dispatch?: Promise<ExecutionReceiptV1>;
  consumed: boolean;
  terminal: boolean;
  state: ExecutionReceiptV1["state"];
}

// Ephemeral original-lifetime registration only. A second coordinator cannot mint a
// second action for the same verified invocation on that lifetime. This is not recovery storage.
const registrations = new WeakMap<AbortSignal, Set<string>>();

function refused(): OrcaError {
  return new OrcaError("RUN_STATE", "synthetic read fence requires a new evaluation/invocation");
}

/** This data vocabulary contains only plain snapshots. Never retain caller-owned nested objects. */
function immutable<T>(input: T): T {
  const value = structuredClone(input);
  const freeze = (part: unknown): void => {
    if (part && typeof part === "object") {
      for (const child of Object.values(part)) freeze(child);
      Object.freeze(part);
    }
  };
  freeze(value);
  return value;
}

/** Stop waiting on an uncooperative policy/executor without treating abort as proof of no effect. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(refused());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : refused());
      },
    );
    if (signal.aborted) abort();
  });
}

/** One instance retains one original invocation; reconnect/new attempt requires a fresh owner binding. */
export class SyntheticReadFence<Parameters, Capture> implements EnforcementPortV1 {
  readonly version = 1 as const;
  private entry?: Entry<Capture>;
  private readonly memoryQualification: ReturnType<typeof memoryCaptureQualifier>;
  private readonly fileQualification: ReturnType<typeof fileCaptureQualifier>;
  private readonly ownedFileQualification: ReturnType<typeof ownedFileCaptureQualifier>;

  constructor(
    private readonly owner: SyntheticReadOwner,
    private readonly executor: SyntheticReadExecutor<Parameters, Capture>,
    private readonly policy: PolicyPortV1,
    private readonly evidence: SyntheticFenceEvidence,
  ) {
    this.memoryQualification = memoryCaptureQualifier(owner, executor);
    this.fileQualification = fileCaptureQualifier(owner, executor);
    this.ownedFileQualification = ownedFileCaptureQualifier(owner, executor);
    // Retain the original lifetime and registered capabilities. Mutating an injection
    // object after capture must not substitute another executor, policy or record writer.
    this.owner = Object.freeze({
      signal: owner.signal,
      clock: Object.freeze({ now: owner.clock.now.bind(owner.clock), isoNow: owner.clock.isoNow.bind(owner.clock) }),
      withOwnership: owner.withOwnership.bind(owner),
      snapshot: owner.snapshot.bind(owner),
      authorize: owner.authorize.bind(owner),
      assertCurrent: owner.assertCurrent.bind(owner),
    });
    this.executor = Object.freeze({
      codecVersion: executor.codecVersion,
      capture: executor.capture.bind(executor),
      encode: executor.encode.bind(executor),
      execute: executor.execute.bind(executor),
    });
    this.policy = Object.freeze({
      version: policy.version,
      evaluate: policy.evaluate.bind(policy),
      bindReview: policy.bindReview.bind(policy),
      completeReview: policy.completeReview.bind(policy),
    });
    this.evidence = Object.freeze({
      recordCapture: evidence.recordCapture.bind(evidence),
      recordAuthorization: evidence.recordAuthorization.bind(evidence),
      read: evidence.read.bind(evidence),
    });
  }

  capture(parameters: Parameters): ActionEvidenceV1 {
    if (
      (this.executor.codecVersion !== "orca-synthetic-acp-read-v1" &&
        !(this.executor.codecVersion === "orca-disposable-memory-read-v1" && this.memoryQualification) &&
        !(this.executor.codecVersion === "orca-disposable-file-read-v1" && this.fileQualification) &&
        !(this.executor.codecVersion === "orca-owned-file-read-v1" && this.ownedFileQualification)) ||
      this.policy.version !== 1
    )
      throw refused();
    this.owner.signal.throwIfAborted();
    const snapshot = immutable(this.owner.snapshot());
    const remaining = Date.parse(snapshot.expiresAt) - this.owner.clock.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 60_000) throw refused();
    const capture = this.executor.capture(parameters);
    const bytes = this.executor.encode(capture);
    const qualification =
      this.memoryQualification?.(capture) ??
      this.fileQualification?.(capture) ??
      this.ownedFileQualification?.(capture);
    if (Buffer.byteLength(bytes, "utf8") > 32_768) throw refused();
    if (this.entry) {
      if (this.entry.bytes !== bytes || !isDeepStrictEqual(this.entry.owner, snapshot)) throw refused();
      return this.entry.action;
    }
    const invocation = snapshot.invocation;
    const key = JSON.stringify([
      invocation.instanceId,
      invocation.runId,
      invocation.rootRunId,
      invocation.stepRunId,
      invocation.attemptId,
      invocation.sessionId,
      invocation.turnId,
      invocation.invocationId,
      invocation.agentId,
      invocation.hostId,
      invocation.runnerId,
      invocation.principalRef,
    ]);
    let registered = registrations.get(this.owner.signal);
    if (!registered) {
      registered = new Set();
      registrations.set(this.owner.signal, registered);
      this.owner.signal.addEventListener("abort", () => registrations.delete(this.owner.signal), { once: true });
    }
    if (registered.has(key)) throw refused();
    const id = randomUUID();
    const representation = {
      kind: "parsed-json" as const,
      codecVersion: this.executor.codecVersion,
      privateRef: `synthetic-read:${id}:parameters`,
      bindingRef: `synthetic-read:${id}:parameters`,
    };
    const action: ActionEvidenceV1 = immutable({
      version: 1,
      actionId: id,
      bindingRef: `synthetic-read:${id}:action`,
      capturedByBoundaryId: snapshot.coverage.boundaryId,
      invocation: snapshot.invocation,
      authority: snapshot.authority,
      coverage: snapshot.coverage,
      operation: qualification?.operation ?? "fs.readTextFile",
      profileRef: qualification?.profileRef ?? "orca-synthetic-read-fixture-v1",
      original: representation,
      dispatch: representation,
      transformations: [],
      rawDuplicateKeyValidation: qualification?.rawDuplicateKeyValidation ?? {
        state: "unknown",
        reason: "Parsed SDK parameters do not retain raw duplicate keys",
      },
      effectiveCwd: { state: "complete", value: snapshot.cwd },
      workspaceRef: { state: "complete", value: snapshot.workspaceRef },
      resources: qualification?.resources ?? {
        state: "unknown",
        reason: "String-path host API has no stable physical target guarantee",
      },
      executableAndInterpreter: { state: "absent", reason: "Injected read has no child executable" },
      stdin: { state: "absent", reason: "Injected read has no stdin" },
      environmentAndCredentialRefs: { state: "complete", value: [] },
      relevantStateRefs: { state: "complete", value: snapshot.relevantStateRefs },
      offeredChoices: [],
      expiresAt: snapshot.expiresAt,
    });
    this.entry = {
      action,
      owner: snapshot,
      capture,
      bytes,
      evidenceRef: `synthetic-read:${id}:evidence`,
      consumed: false,
      terminal: false,
      state: "not-dispatched",
    };
    registered.add(key);
    return action;
  }

  /** Internal closed-service transition only: retire an evaluated ask before any permit/dispatch.
   * The service retains original bytes/ceilings/lifetime and admits only a policy-revision change.
   * No failed/uncertain authorization or execution can use this path. */
  retireForPolicyReevaluation(action: ActionEvidenceV1): AbortSignal {
    const entry = this.retained(action);
    if (
      !this.ownedFileQualification ||
      entry.verdict?.outcome !== "require-human" ||
      entry.pending ||
      entry.bound ||
      entry.authorization ||
      entry.dispatch ||
      entry.consumed ||
      entry.terminal ||
      !entry.originalSignal ||
      this.owner.clock.now() >= Date.parse(entry.action.expiresAt)
    )
      throw refused();
    this.owner.signal.throwIfAborted();
    entry.originalSignal.throwIfAborted();
    entry.terminal = true; // Synchronous retirement before a replacement fence can exist.
    return entry.originalSignal;
  }

  private retained(action: ActionEvidenceV1): Entry<Capture> {
    if (!this.entry || this.entry.action !== action) throw refused();
    return this.entry;
  }

  private check(entry: Entry<Capture>, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.owner.signal.throwIfAborted();
    if (this.owner.clock.now() >= Date.parse(entry.action.expiresAt)) throw refused();
    if (!isDeepStrictEqual(this.owner.snapshot(), entry.owner)) throw refused();
    if (this.executor.encode(entry.capture) !== entry.bytes) throw refused();
    this.owner.assertCurrent(entry.action);
  }

  private async lifetime<T>(
    entry: Entry<Capture>,
    caller: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const remaining = Date.parse(entry.action.expiresAt) - this.owner.clock.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw refused();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), remaining);
    timer.unref();
    const signal = AbortSignal.any([this.owner.signal, entry.originalSignal ?? caller, caller, timeout.signal]);
    try {
      return await work(signal);
    } finally {
      clearTimeout(timer);
    }
  }

  evaluate(action: ActionEvidenceV1, signal: AbortSignal): Promise<PolicyEvaluationV1> {
    const entry = this.retained(action);
    entry.originalSignal ??= signal;
    entry.evaluation ??= this.lifetime(entry, signal, async (active) => {
      this.check(entry, active);
      await abortable(
        this.owner.withOwnership(async () => {
          this.check(entry, active);
          await abortable(this.owner.authorize(entry.action, active), active);
          this.check(entry, active);
          await abortable(this.evidence.recordCapture(entry.action, entry.bytes), active);
          this.check(entry, active);
        }),
        active,
      );
      this.check(entry, active);
      const result = await abortable(this.policy.evaluate(entry.action, active), active);
      if (result.phase !== "final" && result.phase !== "needs-review") throw refused();
      const evaluated: PolicyEvaluationV1 =
        result.phase === "final"
          ? { phase: "final", verdict: immutable(result.verdict) }
          : { phase: "needs-review", review: immutable(result.review), pending: result.pending };
      this.check(entry, active);
      if (evaluated.phase === "final") entry.verdict = evaluated.verdict;
      else entry.pending = evaluated.pending;
      return evaluated;
    });
    return entry.evaluation;
  }

  /** Register only this fence's policy-issued pending handle before scheduling a judge. */
  async bindReview(pending: PendingReviewV1, request: JudgeRequestV1, signal: AbortSignal): Promise<BoundReviewV1> {
    const entry = this.entry;
    if (!entry || entry.pending !== pending || entry.reviewClaimed || entry.terminal || entry.consumed) throw refused();
    entry.reviewClaimed = true;
    try {
      const exact = immutable(request);
      return await this.lifetime(entry, signal, async (active) => {
        this.check(entry, active);
        const bound = await abortable(this.policy.bindReview(pending, exact, active), active);
        this.check(entry, active);
        entry.bound = bound;
        return bound;
      });
    } catch {
      entry.terminal = true;
      throw refused();
    }
  }

  /** Only the registered policy can install the completed decision; handles cannot replay. */
  async completeReview(bound: BoundReviewV1, result: JudgeResultV1, signal: AbortSignal): Promise<PolicyVerdictV1> {
    const entry = this.entry;
    if (!entry || entry.bound !== bound || entry.terminal || entry.consumed) throw refused();
    delete entry.bound; // Claim before the first await, including concurrent completion.
    try {
      const exact = immutable(result);
      return await this.lifetime(entry, signal, async (active) => {
        this.check(entry, active);
        const verdict = immutable(await abortable(this.policy.completeReview(bound, exact, active), active));
        this.check(entry, active);
        entry.verdict = verdict;
        entry.evaluation = Promise.resolve({ phase: "final", verdict });
        return verdict;
      });
    } catch {
      entry.terminal = true;
      throw refused();
    }
  }

  private async revalidate(entry: Entry<Capture>, verdict: Allow, signal: AbortSignal): Promise<void> {
    this.check(entry, signal);
    await abortable(this.owner.authorize(entry.action, signal), signal);
    const current = await abortable(this.policy.evaluate(entry.action, signal), signal);
    this.check(entry, signal);
    if (
      current.phase !== "final" ||
      current.verdict.outcome !== "allow" ||
      !isDeepStrictEqual(current.verdict, verdict)
    )
      throw refused();
    if (
      verdict.version !== 1 ||
      verdict.actionBindingRef !== entry.action.bindingRef ||
      verdict.coverageId !== entry.action.coverage.coverageId ||
      !isDeepStrictEqual(verdict.authority, entry.action.authority)
    )
      throw refused();
    const attribution = verdict.authorizedBy;
    const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
    if (
      !attribution ||
      !(attribution.kind === "rule"
        ? nonempty(attribution.ruleId) && nonempty(attribution.ruleRevision)
        : attribution.kind === "human" && nonempty(attribution.acceptedAnswerRef))
    )
      throw refused();
  }

  authorize(action: ActionEvidenceV1, verdict: Allow, signal: AbortSignal): Promise<OneUsePermitV1> {
    const entry = this.retained(action);
    if (entry.terminal || entry.verdict !== verdict || verdict.outcome !== "allow") return Promise.reject(refused());
    entry.authorization ??= this.lifetime(entry, signal, (active) =>
      abortable(
        this.owner.withOwnership(async () => {
          if (entry.terminal || entry.consumed) throw refused();
          await this.revalidate(entry, verdict, active);
          const permit = Object.freeze({}) as OneUsePermitV1;
          entry.permit = permit;
          return permit;
        }),
        active,
      ),
    );
    return entry.authorization;
  }

  private receipt(entry: Entry<Capture>): ExecutionReceiptV1 {
    return Object.freeze({
      version: 1,
      actionId: entry.action.actionId,
      state: entry.state,
      protectedEvidenceRef: entry.evidenceRef,
    });
  }

  dispatch(permit: OneUsePermitV1, signal: AbortSignal): Promise<ExecutionReceiptV1> {
    const entry = this.entry;
    if (!entry || entry.permit !== permit) return Promise.reject(refused());
    entry.dispatch ??= this.performDispatch(entry, signal);
    return entry.dispatch;
  }

  private async performDispatch(entry: Entry<Capture>, signal: AbortSignal): Promise<ExecutionReceiptV1> {
    try {
      await this.lifetime(entry, signal, async (active) => {
        let execution: Promise<void> | undefined;
        await abortable(
          this.owner.withOwnership(async () => {
            if (entry.terminal || entry.consumed || entry.verdict?.outcome !== "allow") throw refused();
            await this.revalidate(entry, entry.verdict, active);
            // Failure (including uncertain append) terminates this identity; never reopen it for a write/replay.
            await abortable(this.evidence.recordAuthorization(entry.action, entry.verdict, entry.evidenceRef), active);
            // Recording can await arbitrary stores. Rerun full current policy afterward;
            // the final synchronous owner check covers mutations after that last await.
            await this.revalidate(entry, entry.verdict, active);
            this.check(entry, active);
            entry.consumed = true;
            // No await between final validation/consumption and starting the registered synthetic I/O.
            // Rejection is handled immediately even if the ownership wrapper itself subsequently fails.
            execution = this.executor.execute(entry.capture, entry.action, entry.evidenceRef, active);
            void execution.catch(() => undefined);
          }),
          active,
        );
        if (!execution) throw refused();
        await abortable(execution, active);
        this.check(entry, active);
        entry.state = "completed";
      });
    } catch {
      // After consumption an error cannot prove that the external read did not happen.
      entry.state = entry.consumed ? "execution-unknown" : "not-dispatched";
    }
    entry.terminal = true;
    return this.receipt(entry);
  }

  async run(parameters: Parameters, signal: AbortSignal): Promise<ExecutionReceiptV1> {
    // Capture is synchronous before this method's first await.
    const action = this.capture(parameters);
    const entry = this.retained(action);
    if (entry.dispatch) return entry.dispatch;
    try {
      const evaluated = await this.evaluate(action, signal);
      if (evaluated.phase !== "final" || evaluated.verdict.outcome !== "allow") return this.receipt(entry);
      return await this.dispatch(await this.authorize(action, evaluated.verdict, signal), signal);
    } catch {
      return this.receipt(entry);
    }
  }

  async inspect(
    receipt: ExecutionReceiptV1,
    authority: FenceReadAuthority,
    signal: AbortSignal,
  ): Promise<FenceObservations> {
    const query = structuredClone(receipt);
    const entry = this.entry;
    if (!entry || query.actionId !== entry.action.actionId || query.protectedEvidenceRef !== entry.evidenceRef)
      throw refused();
    const authorizeRead = authority.authorizeRead.bind(authority);
    signal.throwIfAborted();
    await abortable(authorizeRead(entry.action.invocation, signal), signal);
    const observations = immutable(await abortable(this.evidence.read(entry.action, entry.evidenceRef), signal));
    await abortable(authorizeRead(entry.action.invocation, signal), signal);
    signal.throwIfAborted();
    return immutable({
      recording: observations.recording ?? { state: "unknown" },
      delivery: observations.delivery ?? { state: "unknown" },
      dispatch: observations.dispatch ?? { state: "unknown" },
      effect: observations.effect ?? { state: "unknown" },
    });
  }
}
