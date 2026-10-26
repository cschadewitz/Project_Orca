/** Inactive closed Linux service. Trusted daemon intake only; no package export or production mount. */
import fs, { constants, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ActionEvidenceV1, CoverageV1, EnforcementPortV1, MutationActor, PolicyPortV1 } from "@orca/core";
import type { HumanInputQuery } from "./human-input.js";
import type { LiveOriginalDelivery } from "./live-input.js";
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
const anchored = (snapshot: SyntheticReadOwnerSnapshot) => {
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
const invocationKey = (snapshot: SyntheticReadOwnerSnapshot) => {
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
  completeHumanDelivery(signal: AbortSignal): ReturnType<SyntheticReadFence<never, never>["completeHumanDelivery"]>;
  reviewProvenance(): ReturnType<SyntheticReadFence<never, never>["reviewProvenance"]>;
  evaluate(signal: AbortSignal): ReturnType<SyntheticReadFence<never, never>["evaluate"]>;
  bindReview: SyntheticReadFence<never, never>["bindReview"];
  completeReview: SyntheticReadFence<never, never>["completeReview"];
  inspect: SyntheticReadFence<never, never>["inspect"];
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
      level: "policy-per-ask",
      evidence: {
        sourceRefs: ["packages/engine/src/owned-file-read-service.ts", "packages/engine/src/synthetic-read-fence.ts"],
        installedRefs: [],
        independentlyObservedEffects: false,
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
      lifetime.throwIfAborted();
      abort.signal.throwIfAborted();
      if (
        closed ||
        BigInt(process.geteuid!()) !== initial.uid ||
        stamp(fs.fstatSync(fd, { bigint: true })) !== originalStamp
      )
        throw refuse();
    };
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
        human?:
          | { delivery: LiveOriginalDelivery; query: HumanInputQuery; actor: MutationActor; onceOptionId: string }
          | undefined;
      }
    >();
    const close = () => {
      if (closed) return;
      closed = true;
      abort.abort();
      fs.closeSync(fd);
      fs.rmSync(root, { recursive: true, force: true });
    };
    lifetime.addEventListener("abort", close, { once: true });
    return Object.freeze({
      resource,
      resourceRef,
      root,
      path,
      coverage,
      close: () => {
        lifetime.removeEventListener("abort", close);
        close();
      },
      /** Trusted Save -> fresh answer transition; not a client-supplied replacement owner/source. */
      refreshPolicyRevision(invocation: TrustedOwnedReadInvocation): TrustedOwnedReadInvocation {
        current();
        for (const entry of entries.values()) if (entry.facade === invocation && entry.refresh) return entry.refresh();
        throw refuse();
      },
      capture(
        owner: SyntheticReadOwner,
        parameters: DisposableFileReadParameters,
        policy: PolicyPortV1,
        evidence: SyntheticFenceEvidence,
      ): TrustedOwnedReadInvocation {
        current();
        owner.signal.throwIfAborted();
        const original = immutable(owner.snapshot());
        if (!isDeepStrictEqual(anchored(original), anchor)) throw refuse();
        // Exact own data descriptors: reject accessors and never consult a caller prototype.
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
        const bytes = JSON.stringify([codecVersion, resourceRef, resource.physicalTargetRef, offset, length]);
        const key = invocationKey(original);
        const prior = entries.get(key);
        if (prior) {
          if (
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
        if (entries.size >= maximumInvocations) throw refuse();
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
          human: undefined as
            | { delivery: LiveOriginalDelivery; query: HumanInputQuery; actor: MutationActor; onceOptionId: string }
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
              return (async () => {
                await observed(action, ref);
                signal.throwIfAborted();
                boundOwner.assertCurrent(action);
                await respond(output, signal);
                signal.throwIfAborted();
                boundOwner.assertCurrent(action);
              })();
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
            );
          const facade: TrustedOwnedReadInvocation = Object.freeze<TrustedOwnedReadInvocation>({
            version: 1,
            action,
            assertCurrent: () => fence.assertCaptureCurrent(action),
            bindHumanInput: (delivery, query, actor, onceOptionId) => {
              if (entry.human) throw refuse();
              fence.bindHumanInput(action, delivery, query, actor, onceOptionId);
              entry.human = { delivery, query, actor: immutable(actor), onceOptionId };
              return undefined;
            },
            completeHumanDelivery: async (signal) => {
              await facade.evaluate(signal);
              // A fresh rule-authorized invocation cannot acquire human attribution.
              // Only the original evaluated ask (retained across Save refresh) may do so.
              if (!entry.humanEligible) throw refuse();
              return fence.completeHumanDelivery(action, signal);
            },
            reviewProvenance: () => fence.reviewProvenance(action),
            evaluate: async (signal) => {
              const result = await fence.evaluate(action, signal);
              if (result.phase === "final" && result.verdict.outcome === "require-human") entry.humanEligible = true;
              return result;
            },
            bindReview: fence.bindReview.bind(fence),
            completeReview: fence.completeReview.bind(fence),
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
      },
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
