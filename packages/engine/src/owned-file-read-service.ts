/** Inactive closed Linux service. Trusted daemon intake only; no package export or production mount. */
import fs, { constants, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ActionEvidenceV1,
  CoverageV1,
  EnforcementPortV1,
  ExecutionReceiptV1,
  MutationActor,
  PolicyPortV1,
} from "@orca/core";
import type { HumanInputQuery } from "./human-input.js";
import type { LiveOriginalDelivery } from "./live-input.js";
import { assertOriginalDelivery } from "./live-input.js";
import {
  reserveDeferredHumanDelivery,
  readDeferredHumanDelivery,
  awaitDeferred,
  type DeferredHumanDelivery,
} from "./deferred-human-delivery.js";
import {
  SyntheticReadFence,
  type SyntheticFenceEvidence,
  type SyntheticReadExecutor,
  type SyntheticReadOwner,
  type SyntheticReadOwnerSnapshot,
} from "./synthetic-read-fence.js";
import type { DisposableFileReadParameters } from "./disposable-file-read.js";

type Qualification = Pick<ActionEvidenceV1, "operation" | "profileRef" | "resources" | "rawDuplicateKeyValidation">;
const registrations = new WeakMap<
  object,
  { owner: SyntheticReadOwner; describe(this: void, capture: unknown): Qualification }
>();
/** Internal exact capability lookup. Copying an executor never registers another capability. */
export function ownedFileCaptureQualifier(owner: SyntheticReadOwner, executor: object) {
  const registered = registrations.get(executor);
  return registered?.owner === owner ? registered.describe : undefined;
}
// One resource owner per authenticated lifetime; close never permits replacement/restart on that lifetime.
const lifetimes = new WeakSet<AbortSignal>();
const refuse = () => new Error("Owned read service unavailable, changed or invocation already retained");
function data<T>(object: object, key: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) throw refuse();
  return descriptor.value as T;
}
function method<T extends (...args: never[]) => unknown>(object: object, key: string): T {
  let prototype: object | null = object;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor) {
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") throw refuse();
      return (descriptor.value as T).bind(object) as T;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  throw refuse();
}
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
const stamp = (info: BigIntStats) => {
  const fields = [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size, info.mtimeNs, info.ctimeNs];
  if (!info.isFile() || info.ino <= 0n || info.size < 0n || fields.some((value) => typeof value !== "bigint"))
    throw refuse();
  return fields.join(":");
};
const codecVersion = "orca-owned-file-read-v1" as const;
const anchored = (snapshot: Pick<SyntheticReadOwnerSnapshot, "invocation" | "authority">) => {
  const { invocation: i, authority: a } = snapshot;
  return [
    i.instanceId,
    i.sessionId,
    i.runId,
    i.rootRunId,
    i.stepRunId,
    i.attemptId,
    i.agentId,
    i.hostId,
    i.runnerId,
    i.principalRef,
    a.capturedGeneration,
    a.leaseEpoch,
  ];
};
const invocationKey = (snapshot: Pick<SyntheticReadOwnerSnapshot, "invocation">) => {
  const i = snapshot.invocation;
  return JSON.stringify([
    i.instanceId,
    i.sessionId,
    i.turnId,
    i.invocationId,
    i.runId,
    i.rootRunId,
    i.stepRunId,
    i.attemptId,
    i.agentId,
    i.hostId,
    i.runnerId,
    i.principalRef,
  ]);
};

/** Canonical contracts only. No executor, descriptor, replacement arguments or unchecked read method. */
export interface TrustedOwnedReadInvocation extends EnforcementPortV1 {
  readonly action: ActionEvidenceV1;
  /** Synchronous original owner/physical inode/cancellation/expiry assertion. */
  assertCurrent(): undefined;
  bindHumanInput(
    delivery: LiveOriginalDelivery,
    query: HumanInputQuery,
    actor: MutationActor,
    onceOptionId: string,
  ): undefined;
  bindDeferredHumanInput(binding: DeferredOwnedReadBinding): undefined;
  completeHumanDelivery(signal: AbortSignal): ReturnType<SyntheticReadFence<never, never>["completeHumanDelivery"]>;
  reviewProvenance(): ReturnType<SyntheticReadFence<never, never>["reviewProvenance"]>;
  evaluate(signal: AbortSignal): ReturnType<SyntheticReadFence<never, never>["evaluate"]>;
  bindReview: SyntheticReadFence<never, never>["bindReview"];
  completeReview: SyntheticReadFence<never, never>["completeReview"];
  inspect: SyntheticReadFence<never, never>["inspect"];
}

export interface DeferredOwnedReadBinding {
  readonly deferred: DeferredHumanDelivery;
  readonly delivery: LiveOriginalDelivery;
  readonly query: HumanInputQuery;
  readonly actor: MutationActor;
  readonly onceOptionId: string;
  readonly scope: object;
}
declare const preparedBrand: unique symbol;
export interface PreparedOwnedRead {
  readonly [preparedBrand]: true;
}
/** A new current authority grant, not an old owner with a refreshed expiry. */
export interface PostApprovalReadAuthority extends Omit<SyntheticReadOwner, "snapshot"> {
  snapshot(): Omit<SyntheticReadOwnerSnapshot, "expiresAt">;
  readonly leaseExpiresAt: number;
}
export type OwnedReadCurrentCapture = Pick<TrustedOwnedReadInvocation, "action" | "assertCurrent" | "reviewProvenance">;
/** Historical review only. No execution, authorization, delivery binding or completion capability. */
export type OwnedReadReviewPreview = Pick<
  TrustedOwnedReadInvocation,
  "action" | "assertCurrent" | "reviewProvenance" | "evaluate"
>;
export interface PrepareHumanRead {
  readonly intent: Omit<SyntheticReadOwnerSnapshot, "expiresAt">;
  readonly parameters: DisposableFileReadParameters;
  readonly delivery: LiveOriginalDelivery;
  readonly query: HumanInputQuery;
  readonly actor: MutationActor;
  readonly onceOptionId: string;
  readonly executionWindowMs: number;
  authorizeExecution(signal: AbortSignal): Promise<{
    authority: PostApprovalReadAuthority;
    policy: PolicyPortV1;
    evidence: SyntheticFenceEvidence;
  }>;
  /** Register the actual fresh facade before its policy lookup; never action JSON. */
  registerInvocation(invocation: OwnedReadCurrentCapture): undefined;
}

/**
 * Controlled test/runtime scope ONLY. Creates its own <=4096-byte private disposable regular file,
 * retains a read-only descriptor, then unlinks it. No path/fd intake, shell or agent registration.
 * Owner/policy/evidence are trusted daemon capabilities, never deserialized agent/client metadata.
 * Metadata checks are conservative change detection, not immutable content or same-UID/root protection.
 */
export function createOwnedFileReadServiceForTest(options: {
  enabled: true;
  owner: SyntheticReadOwner;
  content: string;
  maximumInvocations: number;
  /** Internal controlled supervisor capability only, never config/JSON. Default remains unqualified.
   * The private runner creates this only AFTER independent bootstrap replay, for a NEW service. */
  controlledSupervisor?: {
    readonly installedEvidenceRef: string;
    assertCurrent(): undefined;
    assertInterval(offset: number, length: number): undefined;
  };
  observed(action: ActionEvidenceV1, ref: string): Promise<void>;
  respond(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}) {
  if (
    options.enabled !== true ||
    process.platform !== "linux" ||
    typeof process.geteuid !== "function" ||
    !constants.O_NOFOLLOW ||
    typeof options.content !== "string" ||
    Buffer.byteLength(options.content) > 4096 ||
    !Number.isSafeInteger(options.maximumInvocations) ||
    options.maximumInvocations < 1 ||
    options.maximumInvocations > 128
  )
    throw refuse();
  const suppliedSupervisor = options.controlledSupervisor;
  const factoryOwnership = method<SyntheticReadOwner["withOwnership"]>(options.owner, "withOwnership");
  const supervisor = suppliedSupervisor
    ? Object.freeze({
        installedEvidenceRef: suppliedSupervisor.installedEvidenceRef,
        assertCurrent: suppliedSupervisor.assertCurrent.bind(suppliedSupervisor),
        assertInterval: suppliedSupervisor.assertInterval.bind(suppliedSupervisor),
      })
    : undefined;
  if (supervisor && (!supervisor.installedEvidenceRef || supervisor.assertCurrent() !== undefined)) throw refuse();
  const lifetime = options.owner.signal;
  lifetime.throwIfAborted();
  if (lifetimes.has(lifetime)) throw refuse();
  const anchor = immutable(anchored(options.owner.snapshot()));
  const initialOwner = immutable(options.owner.snapshot());
  const maximumInvocations = options.maximumInvocations;
  const observed = options.observed.bind(options);
  const respond = options.respond.bind(options);
  const abort = new AbortController();
  let closed = false;
  const root = fs.mkdtempSync(join(tmpdir(), "orca-owned-service-"));
  const path = join(root, "fixture");
  let descriptor: number | undefined;
  try {
    const directory = fs.lstatSync(root, { bigint: true });
    if (!directory.isDirectory() || directory.uid !== BigInt(process.geteuid()) || (directory.mode & 0o777n) !== 0o700n)
      throw refuse();
    fs.writeFileSync(path, options.content, { flag: "wx", mode: 0o400 });
    const named = fs.lstatSync(path, { bigint: true });
    if (named.uid !== directory.uid || named.nlink !== 1n || (named.mode & 0o777n) !== 0o400n) throw refuse();
    descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (stamp(fs.fstatSync(descriptor, { bigint: true })) !== stamp(named)) throw refuse();
    fs.unlinkSync(path);
    const fd = descriptor;
    const initial = fs.fstatSync(fd, { bigint: true });
    if (initial.nlink !== 0n || initial.size > 4096n) throw refuse();
    const originalStamp = stamp(initial);
    lifetimes.add(lifetime);
    const resourceRef = `owned-file:${randomUUID()}`;
    const resource = immutable({
      operation: "fs.readOwnedBytes",
      physicalTargetRef: `${resourceRef}:${originalStamp}`,
    });
    const coverage: CoverageV1 = immutable({
      version: 1,
      coverageId: `${resourceRef}:source-v1`,
      boundaryId: codecVersion,
      provider: "orca-owned-disposable-file-service",
      providerVersion: "1",
      adapterVersion: "1",
      tool: resource.operation,
      toolSchemaVersion: "1",
      hostId: initialOwner.invocation.hostId,
      platform: `linux-${process.arch}`,
      level: supervisor ? "verified-per-execution" : "policy-per-ask",
      evidence: {
        sourceRefs: ["packages/engine/src/owned-file-read-service.ts", "packages/engine/src/synthetic-read-fence.ts"],
        installedRefs: supervisor ? [supervisor.installedEvidenceRef] : [],
        independentlyObservedEffects: !!supervisor,
      },
      negotiatedHook: { state: "complete", value: `${resourceRef}:retained-descriptor` },
      protectedConfiguration: { state: "complete", value: `${resourceRef}:controlled-test-scope` },
      guaranteedEffects: ["bounded-positional-read-of-retained-detached-inode", "one-effect-per-original-invocation"],
      unsupportedPaths: [
        "arbitrary-path",
        "external-writers",
        "hostile-same-uid",
        "root",
        "remote-host",
        "macos",
        "windows",
        "native-shell",
        "alternate-mcp",
        "production",
        "restart-recovery",
      ],
    });
    const current = () => {
      if (supervisor && supervisor.assertCurrent() !== undefined) throw refuse();
      lifetime.throwIfAborted();
      abort.signal.throwIfAborted();
      if (
        closed ||
        BigInt(process.geteuid!()) !== initial.uid ||
        stamp(fs.fstatSync(fd, { bigint: true })) !== originalStamp
      )
        throw refuse();
    };
    function canonical(parameters: DisposableFileReadParameters) {
      const keys = ["resourceRef", "offset", "length"] as const;
      if (!parameters || typeof parameters !== "object" || Reflect.ownKeys(parameters).length !== keys.length)
        throw refuse();
      const values = keys.map((key) => {
        const property = Object.getOwnPropertyDescriptor(parameters, key);
        if (!property || !Object.hasOwn(property, "value")) throw refuse();
        return property.value as unknown;
      });
      const [target, offset, length] = values;
      if (
        target !== resourceRef ||
        typeof offset !== "number" ||
        typeof length !== "number" ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        Object.is(offset, -0) ||
        offset < 0 ||
        length < 1 ||
        length > 4096 ||
        offset > 4096 ||
        BigInt(offset + length) > initial.size
      )
        throw refuse();
      if (supervisor && supervisor.assertInterval(offset, length) !== undefined) throw refuse();
      return {
        offset,
        length,
        bytes: JSON.stringify([codecVersion, resourceRef, resource.physicalTargetRef, offset, length]),
      };
    }
    const entries = new Map<
      string,
      {
        original: SyntheticReadOwner;
        snapshot: SyntheticReadOwnerSnapshot;
        bytes: string;
        policy: PolicyPortV1;
        evidence: SyntheticFenceEvidence;
        facade: TrustedOwnedReadInvocation | undefined;
        refresh: (() => TrustedOwnedReadInvocation) | undefined;
        humanEligible: boolean;
        retired: boolean;
        human?:
          | (Omit<DeferredOwnedReadBinding, "deferred" | "scope"> & {
              deferred?: DeferredHumanDelivery;
              scope?: object;
            })
          | undefined;
      }
    >();
    const prepared = new Map<
      PreparedOwnedRead,
      {
        intent: Omit<SyntheticReadOwnerSnapshot, "expiresAt">;
        parameters: DisposableFileReadParameters;
        binding: DeferredOwnedReadBinding;
        window: number;
        authorize: PrepareHumanRead["authorizeExecution"];
        register: PrepareHumanRead["registerInvocation"];
        key: string;
        bytes: string;
        redeemed: boolean;
        retired: boolean;
        cancellation: AbortController;
        io: Set<Promise<unknown>>;
        ownership: Set<Promise<unknown>>;
        preview?: { value?: OwnedReadReviewPreview; retired: boolean };
        execution?: Promise<ExecutionReceiptV1>;
      }
    >();
    const preparedKeys = new Set<string>();
    // One logical invocation budget includes reservations, previews, failed
    // construction and executable captures. Closing never removes tombstones.
    const lineageKeys = new Set<string>();
    const ownedWork = new Set<Promise<unknown>>();
    function tracked<T>(io: Set<Promise<unknown>> | undefined, operation: () => Promise<T>): Promise<T> {
      const work = Promise.resolve().then(operation);
      ownedWork.add(work);
      io?.add(work);
      const settled = () => {
        ownedWork.delete(work);
        io?.delete(work);
      };
      void work.then(settled, settled);
      return work;
    }
    let closing: Promise<void> | undefined;
    const finishClose = () => {
      fs.closeSync(fd);
      fs.rmSync(root, { recursive: true, force: true });
    };
    const close = () => {
      if (closed) return;
      let settled!: () => void, failed!: (error: unknown) => void;
      closing = new Promise<void>((resolve, reject) => {
        settled = resolve;
        failed = reject;
      });
      void closing.catch(() => undefined);
      closed = true;
      abort.abort();
      const finish = (synchronous = false) => {
        try {
          finishClose();
          settled();
        } catch (error) {
          failed(error);
          if (synchronous) throw error;
        }
      };
      if (ownedWork.size) {
        void (async () => {
          while (ownedWork.size) await Promise.allSettled([...ownedWork]);
          finish();
        })();
      } else finish(true);
    };
    lifetime.addEventListener("abort", close, { once: true });
    function captureOwned(
      owner: SyntheticReadOwner,
      parameters: DisposableFileReadParameters,
      policy: PolicyPortV1,
      evidence: SyntheticFenceEvidence,
      redemption?: PreparedOwnedRead,
    ): TrustedOwnedReadInvocation {
      const pending = redemption ? prepared.get(redemption) : undefined;
      // Exact private token redemption precedes every owner hook. Public
      // capture never inherits this authority, including on reentrant calls.
      if (redemption) {
        if (!pending || pending.redeemed || pending.retired || !pending.execution) throw refuse();
        pending.redeemed = true;
      }
      current();
      owner.signal.throwIfAborted();
      const original = immutable(owner.snapshot());
      if (!isDeepStrictEqual(anchored(original), anchor)) throw refuse();
      const { offset, length, bytes } = canonical(parameters);
      const key = invocationKey(original);
      if (preparedKeys.has(key) && (!pending || pending.key !== key || pending.bytes !== bytes)) throw refuse();
      if (pending && pending.key !== key) throw refuse();
      const prior = entries.get(key);
      if (prior) {
        if (
          prior.retired ||
          !prior.facade ||
          prior.original !== owner ||
          prior.policy !== policy ||
          prior.evidence !== evidence ||
          prior.bytes !== bytes ||
          !isDeepStrictEqual(prior.snapshot, original)
        )
          throw refuse();
        return prior.facade;
      }
      if (!lineageKeys.has(key)) {
        if (lineageKeys.size >= maximumInvocations) throw refuse();
        lineageKeys.add(key);
      }
      // Retain even failed setup as a tombstone; no replacement owner can reopen this invocation.
      const entry = {
        original: owner,
        snapshot: original,
        bytes,
        policy,
        evidence,
        facade: undefined as TrustedOwnedReadInvocation | undefined,
        refresh: undefined as (() => TrustedOwnedReadInvocation) | undefined,
        humanEligible: false,
        retired: false,
        human: undefined as
          | (Omit<DeferredOwnedReadBinding, "deferred" | "scope"> & {
              deferred?: DeferredHumanDelivery;
              scope?: object;
            })
          | undefined,
      };
      entries.set(key, entry);
      const retainedOwner = Object.freeze({
        signal: AbortSignal.any([lifetime, abort.signal, owner.signal]),
        clock: Object.freeze({
          now: owner.clock.now.bind(owner.clock),
          isoNow: owner.clock.isoNow.bind(owner.clock),
        }),
        snapshot: owner.snapshot.bind(owner),
        authorize: owner.authorize.bind(owner),
        assertCurrent: owner.assertCurrent.bind(owner),
        withOwnership: owner.withOwnership.bind(owner),
      });
      const retainedPolicy = Object.freeze<PolicyPortV1>({
        version: policy.version,
        evaluate: policy.evaluate.bind(policy),
        bindReview: policy.bindReview.bind(policy),
        completeReview: policy.completeReview.bind(policy),
      });
      const retainedEvidence = Object.freeze<SyntheticFenceEvidence>({
        recordCapture: evidence.recordCapture.bind(evidence),
        recordAuthorization: evidence.recordAuthorization.bind(evidence),
        read: evidence.read.bind(evidence),
      });
      let refreshed = false;
      const build = (
        original: SyntheticReadOwnerSnapshot,
        originalSignal?: AbortSignal,
      ): TrustedOwnedReadInvocation => {
        const snapshot = immutable({
          ...original,
          coverage,
          cwd: root,
          workspaceRef: `${resourceRef}:temporary-tree`,
          relevantStateRefs: [resource.physicalTargetRef],
        });
        const check = () => {
          if (entry.retired) throw refuse();
          current();
          retainedOwner.signal.throwIfAborted();
          if (!isDeepStrictEqual(retainedOwner.snapshot(), original)) throw refuse();
        };
        const boundOwner: SyntheticReadOwner = Object.freeze<SyntheticReadOwner>({
          signal: originalSignal ? AbortSignal.any([retainedOwner.signal, originalSignal]) : retainedOwner.signal,
          clock: retainedOwner.clock,
          snapshot: () => snapshot,
          withOwnership: retainedOwner.withOwnership,
          authorize: async (action, signal) => {
            check();
            await retainedOwner.authorize(action, signal);
            check();
          },
          assertCurrent: (action) => {
            check();
            retainedOwner.assertCurrent(action);
            check();
            if (
              !isDeepStrictEqual(action.authority, original.authority) ||
              !isDeepStrictEqual(action.invocation, original.invocation) ||
              !isDeepStrictEqual(action.coverage, coverage) ||
              !isDeepStrictEqual(action.resources, { state: "complete", value: [resource] })
            )
              throw refuse();
          },
        });
        const handle = Object.freeze({});
        let used = false;
        const retained = (capture: unknown) => {
          check();
          if (capture !== handle) throw refuse();
          return bytes;
        };
        const executor: SyntheticReadExecutor<DisposableFileReadParameters, object> = Object.freeze<
          SyntheticReadExecutor<DisposableFileReadParameters, object>
        >({
          codecVersion,
          capture: () => {
            check();
            return handle;
          },
          encode: retained,
          execute: (capture, action, ref, signal) => {
            retained(capture);
            signal.throwIfAborted();
            boundOwner.assertCurrent(action);
            if (used) throw refuse();
            used = true;
            const output = Buffer.alloc(length);
            // Final synchronous checks/consumption -> positional OS read. No caller callback or path lookup.
            const count = fs.readSync(fd, output, 0, length, offset);
            check();
            signal.throwIfAborted();
            boundOwner.assertCurrent(action);
            if (count !== length) throw refuse();
            const completion = async () => {
              await observed(action, ref);
              signal.throwIfAborted();
              boundOwner.assertCurrent(action);
              await respond(output, signal);
              signal.throwIfAborted();
              boundOwner.assertCurrent(action);
            };
            // The physical read above stays synchronous. For a reserved
            // successor only, publish completion tracking before any async
            // observation/response hook can run or reenter cleanup.
            return pending
              ? tracked(pending.io, () => {
                  signal.throwIfAborted();
                  check();
                  boundOwner.assertCurrent(action);
                  return completion();
                })
              : completion();
          },
        });
        registrations.set(executor, {
          owner: boundOwner,
          describe: (capture) => {
            retained(capture);
            return immutable({
              operation: resource.operation,
              profileRef: codecVersion,
              resources: { state: "complete", value: [resource] },
              rawDuplicateKeyValidation: {
                state: "absent",
                reason: "Exact structured own data fields; no raw JSON parser",
              },
            });
          },
        });
        const fence = new SyntheticReadFence(boundOwner, executor, retainedPolicy, retainedEvidence);
        const action = fence.capture(immutable({ resourceRef, offset, length }));
        if (entry.human)
          fence.bindHumanInput(
            action,
            entry.human.delivery,
            entry.human.query,
            entry.human.actor,
            entry.human.onceOptionId,
            entry.human.scope ?? entry,
            entry.human.deferred,
          );
        const facade: TrustedOwnedReadInvocation = Object.freeze<TrustedOwnedReadInvocation>({
          version: 1,
          action,
          assertCurrent: () => fence.assertCaptureCurrent(action),
          bindHumanInput: (delivery, query, actor, onceOptionId) => {
            if (entry.human) throw refuse();
            fence.bindHumanInput(action, delivery, query, actor, onceOptionId, entry);
            entry.human = { delivery, query, actor: immutable(actor), onceOptionId };
            return undefined;
          },
          bindDeferredHumanInput: (binding) => {
            if (entry.human) throw refuse();
            fence.bindHumanInput(
              action,
              binding.delivery,
              binding.query,
              binding.actor,
              binding.onceOptionId,
              binding.scope,
              binding.deferred,
            );
            entry.human = { ...binding, actor: immutable(binding.actor) };
            entry.humanEligible = true; // Explicit prebound intent; fresh policy is still evaluated by the fence.
            entry.refresh = undefined;
            return undefined;
          },
          completeHumanDelivery: (signal) => {
            // A fresh rule-authorized invocation cannot acquire human attribution.
            // Only the original evaluated ask (retained across Save refresh) may do so.
            // The fence awaits settled original delivery before any fresh evaluation.
            if (!entry.humanEligible) return Promise.reject(refuse());
            return fence.completeHumanDelivery(action, signal);
          },
          reviewProvenance: () => fence.reviewProvenance(action),
          evaluate: async (signal) => {
            const result = await fence.evaluate(action, signal);
            if (result.phase === "final" && result.verdict.outcome === "require-human") entry.humanEligible = true;
            return result;
          },
          bindReview: fence.bindReview.bind(fence),
          completeReview: async (bound, result, signal) => {
            const verdict = await fence.completeReview(bound, result, signal);
            if (verdict.outcome === "require-human") entry.humanEligible = true;
            return verdict;
          },
          authorize: fence.authorize.bind(fence),
          dispatch: fence.dispatch.bind(fence),
          inspect: fence.inspect.bind(fence),
        });
        entry.facade = facade;
        entry.refresh = () => {
          current();
          if (refreshed) throw refuse();
          const fresh = immutable(retainedOwner.snapshot());
          if (
            !fresh.authority.currentPolicyRevision ||
            fresh.authority.currentPolicyRevision === original.authority.currentPolicyRevision ||
            !isDeepStrictEqual(
              {
                ...fresh,
                authority: { ...fresh.authority, currentPolicyRevision: original.authority.currentPolicyRevision },
              },
              original,
            )
          )
            throw refuse();
          // Same captured policy/source and original request. Only the current revision changes.
          const signal = fence.retireForPolicyReevaluation(action);
          refreshed = true;
          entry.facade = undefined;
          entry.refresh = undefined;
          entry.snapshot = fresh;
          return build(fresh, signal);
        };
        return facade;
      };
      return build(original);
    }
    const service = Object.freeze({
      resource,
      resourceRef,
      root,
      path,
      coverage,
      lifetimeSignal: AbortSignal.any([lifetime, abort.signal]),
      close: () => {
        lifetime.removeEventListener("abort", close);
        close();
      },
      /** Join already-started authority work before the owning lease/fixture is released. */
      async closeAndDrain(): Promise<void> {
        lifetime.removeEventListener("abort", close);
        close();
        await closing;
      },
      /** Non-executable scope check while a person considers a standing grant.
       * Preserves original resource identity, cancellation and exact bounds;
       * creates no action, review result, permit, resource read or answer. */
      assertPendingResource(parameters: DisposableFileReadParameters): undefined {
        current();
        canonical(parameters);
        return undefined;
      },
      /** Reserve the exact original intent without capturing an executable action. */
      prepareHumanRead(input: PrepareHumanRead): PreparedOwnedRead {
        const authorize = method<PrepareHumanRead["authorizeExecution"]>(input, "authorizeExecution");
        const register = method<PrepareHumanRead["registerInvocation"]>(input, "registerInvocation");
        current();
        if (
          !Number.isSafeInteger(input.executionWindowMs) ||
          input.executionWindowMs <= 0 ||
          input.executionWindowMs > 60000
        )
          throw refuse();
        const intent = immutable(input.intent);
        if (Object.hasOwn(intent, "expiresAt") || !isDeepStrictEqual(anchored(intent), anchor)) throw refuse();
        const key = invocationKey(intent);
        if (lineageKeys.size >= maximumInvocations || lineageKeys.has(key)) throw refuse();
        lineageKeys.add(key);
        preparedKeys.add(key); // Failed setup is also a permanent reservation tombstone.
        const values = canonical(input.parameters);
        const scope = Object.freeze({});
        const deferred = reserveDeferredHumanDelivery({
          delivery: input.delivery,
          query: input.query,
          actor: input.actor,
          onceOptionId: input.onceOptionId,
          scope,
          bytes: values.bytes,
          invocation: intent.invocation,
          authority: intent.authority,
        });
        const token = Object.freeze({}) as PreparedOwnedRead;
        prepared.set(token, {
          key,
          bytes: values.bytes,
          redeemed: false,
          retired: false,
          cancellation: new AbortController(),
          io: new Set(),
          ownership: new Set(),
          intent,
          parameters: immutable({ resourceRef, offset: values.offset, length: values.length }),
          binding: {
            deferred,
            delivery: input.delivery,
            query: input.query,
            actor: immutable(input.actor),
            onceOptionId: input.onceOptionId,
            scope,
          },
          window: input.executionWindowMs,
          authorize,
          register,
        });
        return token;
      },
      /** Exact reserved lineage only. This preview has no execution-capable executor. */
      reviewPreparedHumanRead(
        token: PreparedOwnedRead,
        owner: SyntheticReadOwner,
        policy: PolicyPortV1,
        evidence: SyntheticFenceEvidence,
      ): OwnedReadReviewPreview {
        const pending = prepared.get(token);
        if (!pending || pending.preview || pending.retired || pending.redeemed) throw refuse();
        const state: { retired: boolean; value?: OwnedReadReviewPreview } = { retired: false };
        // Tombstone construction before caller hooks can reenter this method.
        pending.preview = state;
        const snapshot = method<SyntheticReadOwner["snapshot"]>(owner, "snapshot");
        const assertOwner = method<SyntheticReadOwner["assertCurrent"]>(owner, "assertCurrent");
        const ownership = method<SyntheticReadOwner["withOwnership"]>(owner, "withOwnership");
        const ownerSignal = data<AbortSignal>(owner, "signal");
        const ownerClock = data<SyntheticReadOwner["clock"]>(owner, "clock");
        const clock = Object.freeze({
          now: method<SyntheticReadOwner["clock"]["now"]>(ownerClock, "now"),
          isoNow: method<SyntheticReadOwner["clock"]["isoNow"]>(ownerClock, "isoNow"),
        });
        const retainedPolicy = method<PolicyPortV1["evaluate"]>(policy, "evaluate");
        const record = method<SyntheticFenceEvidence["recordCapture"]>(evidence, "recordCapture");
        const original = immutable(snapshot());
        const { expiresAt: _expiry, ...intent } = original;
        if (!isDeepStrictEqual(intent, pending.intent) || invocationKey(original) !== pending.key) throw refuse();
        const values = canonical(pending.parameters);
        if (values.bytes !== pending.bytes) throw refuse();
        const signal = AbortSignal.any([lifetime, abort.signal, ownerSignal, pending.cancellation.signal]);
        const check = () => {
          if (state.retired || pending.retired) throw refuse();
          current();
          signal.throwIfAborted();
          if (!isDeepStrictEqual(snapshot(), original) || clock.now() >= Date.parse(original.expiresAt)) throw refuse();
        };
        const boundSnapshot = immutable({
          ...original,
          coverage,
          cwd: root,
          workspaceRef: `${resourceRef}:temporary-tree`,
          relevantStateRefs: [resource.physicalTargetRef],
        });
        const boundOwner: SyntheticReadOwner = Object.freeze<SyntheticReadOwner>({
          signal,
          clock,
          snapshot: () => boundSnapshot,
          withOwnership: ownership,
          authorize: async () => {
            throw refuse();
          },
          assertCurrent: (action) => {
            check();
            assertOwner(action);
            check();
          },
        });
        const handle = Object.freeze({});
        const executor: SyntheticReadExecutor<DisposableFileReadParameters, object> = Object.freeze<
          SyntheticReadExecutor<DisposableFileReadParameters, object>
        >({
          codecVersion,
          capture: () => {
            check();
            return handle;
          },
          encode: (value) => {
            check();
            if (value !== handle) throw refuse();
            return values.bytes;
          },
          execute: () => {
            throw refuse();
          },
        });
        registrations.set(executor, {
          owner: boundOwner,
          describe: (value) => {
            check();
            if (value !== handle) throw refuse();
            return immutable({
              operation: resource.operation,
              profileRef: codecVersion,
              resources: { state: "complete", value: [resource] },
              rawDuplicateKeyValidation: {
                state: "absent",
                reason: "Exact structured own data fields; no raw JSON parser",
              },
            });
          },
        });
        const fence = new SyntheticReadFence(boundOwner, executor, policy, evidence);
        const action = fence.capture(pending.parameters);
        let evaluation: ReturnType<OwnedReadReviewPreview["evaluate"]> | undefined;
        const preview: OwnedReadReviewPreview = Object.freeze<OwnedReadReviewPreview>({
          action,
          assertCurrent: () => {
            check();
            return fence.assertCaptureCurrent(action);
          },
          reviewProvenance: () => {
            check();
            return { result: "unavailable", sourceRefs: [] };
          },
          evaluate: async (caller) => {
            check();
            caller.throwIfAborted();
            if (!evaluation) {
              const pendingEvaluation = Promise.resolve().then(() =>
                ownership(async () => {
                  check();
                  caller.throwIfAborted();
                  await record(action, values.bytes);
                  check();
                  caller.throwIfAborted();
                  const result = await retainedPolicy(action, caller);
                  check();
                  caller.throwIfAborted();
                  return result;
                }),
              );
              evaluation = pendingEvaluation;
              ownedWork.add(pendingEvaluation);
              void pendingEvaluation.then(
                () => ownedWork.delete(pendingEvaluation),
                () => ownedWork.delete(pendingEvaluation),
              );
            }
            const result = await evaluation;
            check();
            caller.throwIfAborted();
            return result;
          },
        });
        state.value = preview;
        return preview;
      },
      assertPreparedHumanRead(token: PreparedOwnedRead): undefined {
        const pending = prepared.get(token);
        if (!pending || pending.retired || pending.redeemed) throw refuse();
        current();
        canonical(pending.parameters);
        pending.binding.query.live!.signal.throwIfAborted();
        pending.binding.query.signal?.throwIfAborted();
        return undefined;
      },
      retirePreparedHumanRead(token: PreparedOwnedRead): undefined {
        const pending = prepared.get(token);
        if (!pending) throw refuse();
        pending.retired = true;
        pending.cancellation.abort("Prepared invocation retired");
        if (pending.preview) pending.preview.retired = true;
        return undefined;
      },
      executePreparedHumanRead(token: PreparedOwnedRead, signal: AbortSignal): Promise<ExecutionReceiptV1> {
        const pending = prepared.get(token);
        if (!pending) return Promise.reject(refuse());
        if (pending.execution) return pending.execution;
        // Publish the one shared attempt before any caller factory can run.
        pending.execution = Promise.resolve()
          .then(async () => {
            if (pending.retired) throw refuse();
            const active = AbortSignal.any([
              signal,
              lifetime,
              abort.signal,
              pending.cancellation.signal,
              pending.binding.query.live!.signal,
              ...(pending.binding.query.signal ? [pending.binding.query.signal] : []),
            ]);
            const check = () => {
              if (pending.retired) throw refuse();
              active.throwIfAborted();
              current();
              assertOriginalDelivery(pending.binding.delivery, pending.binding.query);
            };
            active.throwIfAborted();
            await awaitDeferred(readDeferredHumanDelivery(pending.binding.deferred), active);
            check();
            const factory = Promise.resolve().then(() =>
              factoryOwnership(async () => {
                active.throwIfAborted();
                return pending.authorize(active);
              }),
            );
            ownedWork.add(factory);
            let fresh: Awaited<ReturnType<PrepareHumanRead["authorizeExecution"]>>;
            try {
              // Cancellation cannot release the lease or close owned fixtures
              // while this already-started factory is still settling its I/O.
              fresh = await factory;
            } finally {
              ownedWork.delete(factory);
            }
            check();
            // Retain all returned capabilities before invoking any callback. A
            // snapshot/clock hook must not replace later authority or evidence.
            const authority = data<PostApprovalReadAuthority>(fresh, "authority");
            const policy = data<PolicyPortV1>(fresh, "policy");
            const evidence = data<SyntheticFenceEvidence>(fresh, "evidence");
            const authoritySignal = data<AbortSignal>(authority, "signal");
            const authorityClock = data<SyntheticReadOwner["clock"]>(authority, "clock");
            const leaseExpiresAt = data<number>(authority, "leaseExpiresAt");
            const snapshot = method<PostApprovalReadAuthority["snapshot"]>(authority, "snapshot");
            const assertAuthority = method<SyntheticReadOwner["assertCurrent"]>(authority, "assertCurrent");
            const authorize = method<SyntheticReadOwner["authorize"]>(authority, "authorize");
            const rawOwnership = method<SyntheticReadOwner["withOwnership"]>(authority, "withOwnership");
            const clock = Object.freeze({
              now: method<SyntheticReadOwner["clock"]["now"]>(authorityClock, "now"),
              isoNow: method<SyntheticReadOwner["clock"]["isoNow"]>(authorityClock, "isoNow"),
            });
            const evaluate = method<PolicyPortV1["evaluate"]>(policy, "evaluate");
            const bindReview = method<PolicyPortV1["bindReview"]>(policy, "bindReview");
            const completeReview = method<PolicyPortV1["completeReview"]>(policy, "completeReview");
            const recordCapture = method<SyntheticFenceEvidence["recordCapture"]>(evidence, "recordCapture");
            const recordAuthorization = method<SyntheticFenceEvidence["recordAuthorization"]>(
              evidence,
              "recordAuthorization",
            );
            const read = method<SyntheticFenceEvidence["read"]>(evidence, "read");
            const policyVersion = data<1>(policy, "version");
            const captured = immutable(snapshot());
            check();
            if (
              Object.hasOwn(captured, "expiresAt") ||
              !isDeepStrictEqual(pending.intent, {
                ...captured,
                authority: {
                  ...captured.authority,
                  currentPolicyRevision: pending.intent.authority.currentPolicyRevision,
                },
              })
            )
              throw refuse();
            const now = clock.now();
            check();
            const ends = Math.min(now + pending.window, leaseExpiresAt);
            if (!Number.isFinite(now) || !Number.isSafeInteger(leaseExpiresAt) || !Number.isFinite(ends) || ends <= now)
              throw refuse();
            const freshCapture: { action: ActionEvidenceV1 | undefined } = { action: undefined };
            const freshCurrent = () => {
              check();
              authoritySignal.throwIfAborted();
              const at = clock.now();
              check();
              authoritySignal.throwIfAborted();
              if (!Number.isFinite(at) || at >= ends || !isDeepStrictEqual(snapshot(), captured)) throw refuse();
              if (freshCapture.action) assertAuthority(freshCapture.action);
              check();
              authoritySignal.throwIfAborted();
              const finalAt = clock.now();
              check();
              authoritySignal.throwIfAborted();
              if (!Number.isFinite(finalAt) || finalAt >= ends) throw refuse();
            };
            const io = <T>(operation: () => Promise<T>) =>
              tracked(pending.io, () => {
                freshCurrent();
                return operation();
              });
            const withOwnership: SyntheticReadOwner["withOwnership"] = (operation) =>
              tracked(pending.ownership, async () => {
                freshCurrent();
                return rawOwnership(async () => {
                  try {
                    freshCurrent();
                    return await operation();
                  } finally {
                    // Only this attempt's non-ownership work belongs to this
                    // lease. Joining global work here could wait on a queued owner.
                    while (pending.io.size) await Promise.allSettled([...pending.io]);
                  }
                });
              });
            const retainedPolicy = Object.freeze<PolicyPortV1>({
              version: policyVersion,
              evaluate: (...args) => io(() => evaluate(...args)),
              bindReview: (...args) => io(() => bindReview(...args)),
              completeReview: (...args) => io(() => completeReview(...args)),
            });
            const retainedEvidence = Object.freeze<SyntheticFenceEvidence>({
              recordCapture: (...args) => io(() => recordCapture(...args)),
              recordAuthorization: (...args) => io(() => recordAuthorization(...args)),
              read: (...args) => io(() => read(...args)),
            });
            const original = immutable({ ...captured, expiresAt: new Date(ends).toISOString() });
            const owner: SyntheticReadOwner = Object.freeze<SyntheticReadOwner>({
              signal: AbortSignal.any([active, authoritySignal]),
              clock,
              withOwnership,
              authorize: (...args) => io(() => authorize(...args)),
              snapshot: () => {
                check();
                if (!isDeepStrictEqual(snapshot(), captured)) throw refuse();
                return original;
              },
              assertCurrent: (action: ActionEvidenceV1) => {
                freshCurrent();
                assertAuthority(action);
                freshCurrent();
              },
            });
            const invocation = captureOwned(owner, pending.parameters, retainedPolicy, retainedEvidence, token);
            freshCapture.action = invocation.action;
            freshCurrent();
            invocation.bindDeferredHumanInput(pending.binding);
            // Qualification registration receives no evaluate/authorize/dispatch
            // capability that could escape or reenter this one shared attempt.
            const registration = Object.freeze<OwnedReadCurrentCapture>({
              action: invocation.action,
              assertCurrent: invocation.assertCurrent.bind(invocation),
              reviewProvenance: invocation.reviewProvenance.bind(invocation),
            });
            if (pending.register(registration) !== undefined) throw refuse();
            check();
            const verdict = await invocation.completeHumanDelivery(active);
            check();
            const permit = await invocation.authorize(invocation.action, verdict, active);
            check();
            return invocation.dispatch(permit, active);
          })
          .finally(async () => {
            // An abortable fence wait may settle before its started callbacks.
            // Join only this attempt, never another queued owner's work.
            while (pending.io.size || pending.ownership.size)
              await Promise.allSettled([...pending.io, ...pending.ownership]);
          });
        return pending.execution;
      },
      /** Trusted Save -> fresh answer transition; not a client-supplied replacement owner/source. */
      refreshPolicyRevision(invocation: TrustedOwnedReadInvocation): TrustedOwnedReadInvocation {
        current();
        for (const entry of entries.values()) if (entry.facade === invocation && entry.refresh) return entry.refresh();
        throw refuse();
      },
      /** Synchronous permanent retirement, including already retained facades.
       * No replacement capture, policy refresh, permit or dispatch is created. */
      retireInvocation(invocation: TrustedOwnedReadInvocation): undefined {
        for (const entry of entries.values())
          if (entry.facade === invocation) {
            entry.retired = true;
            entry.refresh = undefined;
            return undefined;
          }
        throw refuse();
      },
      capture(
        owner: SyntheticReadOwner,
        parameters: DisposableFileReadParameters,
        policy: PolicyPortV1,
        evidence: SyntheticFenceEvidence,
      ): TrustedOwnedReadInvocation {
        return captureOwned(owner, parameters, policy, evidence);
      },
    });
    return service;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
