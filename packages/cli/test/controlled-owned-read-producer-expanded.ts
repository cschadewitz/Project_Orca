/** Dedicated disposable test producer. No barrel export, RPC, JSON switch or production mount.
 * The caller is the designated test supervisor, retaining real physical assertions and phase pipes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { systemClock, type ActionEvidenceV1, type MutationActor, type StrictPermissionRule } from "@orca/core";
import { fileStores, lapsed, type LeaseStore } from "@orca/store";
import {
  createStrictPermissionSource,
  createStrictPolicyPort,
  strictPermissionRuleRevision,
  type ScopedPermissionCapture,
  type ScopedPermissionCapturePort,
  type ScopedCaptureFacts,
  type ManagedTypedStoreBinding,
  type StandingIntentReviewRequest,
} from "@orca/agents";
import { askHumanInput, LiveHumanInput, type HumanInputQuery, type LiveAnswerAuthority } from "@orca/engine";
import { CredentialStore } from "../../daemon/src/auth/credentials.js";
import { Authorizer, OwnershipStore, authInvalid, bindPrincipal } from "../../daemon/src/auth/index.js";
import { scopedPermissionMethods } from "../../daemon/src/scoped-permission-bridge.js";
import { dispatch } from "../../daemon/src/server.js";
import { protectedScopedPermissionOwner } from "../../daemon/src/protected-scoped-permission-owner.js";
import { ownedReadScopedCapture } from "../../daemon/src/owned-read-scoped-capture.js";
import {
  createOwnedFileReadServiceForTest,
  type TrustedOwnedReadInvocation,
  type OwnedReadCurrentCapture,
  type OwnedReadReviewPreview,
  type PostApprovalReadAuthority,
} from "../../engine/src/owned-file-read-service.js";
import type {
  SyntheticReadOwner,
  SyntheticReadOwnerSnapshot,
  SyntheticFenceEvidence,
} from "../../engine/src/synthetic-read-fence.js";
import { createManagedTypedWorkspace, resolveManagedRootBinding } from "../src/typed-workspace-gate.js";

const complete = <T>(value: T) => ({ state: "complete" as const, value });
const same = (a: unknown, b: unknown) => assert.ok(isDeepStrictEqual(a, b), "controlled original changed");
const runId = "controlled";
const profileRef = "orca-owned-file-read-v1";
const factsOf = (action: Pick<ActionEvidenceV1, "authority">): ScopedCaptureFacts => ({
  policyRevision: action.authority.currentPolicyRevision,
  authorityRevision: action.authority.authorityRevision,
  revocationEpoch: action.authority.revocationEpoch,
  leaseEpoch: action.authority.leaseEpoch,
});
const bindingIdentity = (binding: ManagedTypedStoreBinding) => ({
  workspaceRef: binding.workspaceRef,
  rootBindingRef: binding.rootBindingRef,
  enrollmentRef: binding.enrollmentRef,
});

/** Test producer ordering only. onRequested precedes the final opening append;
 * independent private writes must await its settled publication, not invoke the
 * delivery owner's withOwnership callback (which also records its real ack).
 */
function openControlledInput(options: Parameters<typeof askHumanInput>[0]) {
  const emit = options.emit.bind(options);
  const onRequested = options.onRequested?.bind(options);
  const signal = options.live?.signal;
  assert.ok(signal, "Controlled input requires its original live signal");
  signal.throwIfAborted();
  let query: HumanInputQuery | undefined;
  let resolveOpening!: () => void;
  let rejectOpening!: (error: Error) => void;
  let settled = false;
  const published = new Promise<void>((resolve, reject) => {
    resolveOpening = resolve;
    rejectOpening = reject;
  });
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", cancelled);
    rejectOpening(error instanceof Error ? error : new Error("Controlled input opening failed"));
  };
  const cancelled = () => fail(new Error("Controlled input opening cancelled"));
  signal.addEventListener("abort", cancelled, { once: true });
  const delivery = askHumanInput({
    ...options,
    onRequested(value) {
      query = value;
      return onRequested?.(value);
    },
    async emit(input) {
      const result = await emit(input);
      if (input.type === "step.waiting") {
        const payload = input.payload;
        assert.ok(
          query &&
            "stepRunId" in payload &&
            payload.stepRunId === query.stepRunId &&
            "on" in payload &&
            payload.on === "human-input" &&
            "detail" in payload &&
            payload.detail === query.requestId,
        );
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", cancelled);
          resolveOpening();
        }
      }
      return result;
    },
  });
  // Cancellation may reject the opening wait while a real append is still in
  // flight. The caller retains delivery and drains it in its existing finally.
  void delivery.then(() => {
    if (!settled) fail(new Error("Controlled input opening did not complete"));
  }, fail);
  return { published, delivery };
}

/** Source-owned query only. The child separately asserts the retained lifetime
 * descriptor/path identity. Proc fdinfo size is zero even when its content is not.
 * The observer must independently bind this query to that process/mount/descriptor.
 */
export function assertControlledLifetimeFdinfo(lifetimeFd: number): undefined {
  assert.ok(Number.isSafeInteger(lifetimeFd) && lifetimeFd > 2);
  const query = fs.openSync(`/proc/self/fdinfo/${lifetimeFd}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(query, { bigint: true });
    assert.ok(info.isFile() && info.ino > 0n, "Lifetime fdinfo query is not a physical regular file");
    const maximumBytes = 4096;
    const bytes = Buffer.alloc(maximumBytes + 1); // One sentinel byte detects oversized content.
    let length = 0;
    for (;;) {
      const count = fs.readSync(query, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
      assert.ok(length <= maximumBytes, "Lifetime fdinfo query exceeds 4096 bytes");
    }
    assert.match(bytes.toString("utf8", 0, length), /lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE /);
  } finally {
    fs.closeSync(query);
  }
  return undefined;
}

export interface ControlledReadTestSupervisor {
  /** Actual retained image/root/identity/lifetime checks, never no-op test substitutions. */
  assertCurrent(): undefined;
  /** Private supervisor capability issued only AFTER separate independent bootstrap replay.
   * The reference alone has no authority; the callable checks retained original proof/current image. */
  readonly bootstrap?: { readonly evidenceRef: string; assertCurrent(): undefined };
  /** Optional source-reviewed child composition, never inferred from names or paths.
   * Identity binds the declared roles; independent source/image review proves inclusion. */
  readonly currentnessComposition?: Readonly<{
    kind: "connected-physical-bootstrap-v1";
    physicalAssertion: ControlledReadTestSupervisor["assertCurrent"];
    bootstrap: NonNullable<ControlledReadTestSupervisor["bootstrap"]>;
    bootstrapAssertion: () => undefined;
  }>;
  readonly content: string;
  readonly offset: number;
  readonly length: number;
  /** Supervisor consumes a fresh command token and acknowledges only after work settles. */
  phase(name: "bootstrap" | "save" | "human-read" | "rule-read", work: () => Promise<void>): Promise<void>;
  /** Controlled fault injection only. Never an authorization or qualification input. */
  readonly fault?:
    | "reviewer-revoked"
    | "review-proof"
    | "stale-revision"
    | "lost-ack"
    | "cancel"
    | "revoke-rule"
    | "wrong-interval"
    | "save-cancel"
    | "save-cancel-review"
    | "save-review-mutated"
    | "save-review-reentrant"
    | "save-review-method-replaced"
    | "save-cancel-current"
    | "save-cancel-write";
  readonly standingReviewerFault?: "missing" | "refusing" | "hanging";
  /** Test owner/lease lifetime only. Individual execution actions remain <=60s. */
  readonly ownerDurationMs?: 300000;
  /** Disposable-test fault injection before current authority is read; never a proof input. */
  beforeFreshAuthority?(): Promise<void>;
  /** One positive real-clock persistence test; never extends original action authority. */
  readonly waitAfterSaveExpiry?: true;
  /** Test composition for non-executable pending Save intent; never a runtime JSON option. */
  readonly pendingSaveIntent?: true;
  /** Separate initial-card intent composition; never an observer/profile switch. */
  readonly initialApprovalIntent?: true;
  readonly initialAnswerChoice?: "allow-once" | "deny" | "save";
  beforeSaveChoice?(): Promise<void>;
  beforeStandingIntentReview?(authority: Readonly<{ issuedAt: number; expiresAt: number }>): Promise<void>;
  afterStandingIntentWrite?(): Promise<void>;
  readonly refreshSaveReview?: true;
  readonly waitBeforeSaveExpiry?: true;
  /** Short-lived real credential fixture for Save expiry/settlement controls. */
  readonly operatorCredentialTtlMs?: 5000 | 20000;
  /**
   * Lifetime of the original action the scenario captures, which the real-clock scenarios wait out.
   * Defaults to 55 s, under the 60 s Save authority bound; shorter values shorten that wait only (5 s floor: setup must finish before the action lapses).
   */
  readonly actionTtlMs?: number;
  /** Optional test synchronization: retain final genuine lease ack until released/rejected. */
  settleOriginalDelivery?(): Promise<void>;
}

/** The only exported entrypoint. All accepting qualifiers/indexes remain private to this call. */
export async function runControlledOwnedReadTest(
  base: string,
  lane: "bootstrap" | "connected",
  supervisor: ControlledReadTestSupervisor,
) {
  // Retain exact original callable capabilities and interval before any await.
  const content = supervisor.content,
    offset = supervisor.offset,
    length = supervisor.length;
  // Identity must remain unbound; Reflect.apply below retains the original receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalPhysicalAssertion = supervisor.assertCurrent;
  const originalBootstrap = supervisor.bootstrap;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Retained with originalBootstrap as receiver.
  const originalBootstrapAssertion = originalBootstrap?.assertCurrent;
  const bootstrapEvidenceRef = originalBootstrap?.evidenceRef;
  const composition = supervisor.currentnessComposition;
  if (composition !== undefined) {
    assert.equal(lane, "connected", "currentness composition requires connected lane");
    assert.ok(composition && typeof composition === "object" && Object.isFrozen(composition));
    const descriptors = Object.getOwnPropertyDescriptors(composition);
    assert.deepEqual(
      Reflect.ownKeys(descriptors).sort(),
      ["kind", "physicalAssertion", "bootstrap", "bootstrapAssertion"].sort(),
    );
    for (const descriptor of Object.values(descriptors)) assert.ok("value" in descriptor);
    assert.equal(composition.kind, "connected-physical-bootstrap-v1");
    assert.equal(composition.physicalAssertion, originalPhysicalAssertion);
    assert.equal(composition.bootstrap, originalBootstrap);
    assert.equal(composition.bootstrapAssertion, originalBootstrapAssertion);
    assert.equal(typeof originalPhysicalAssertion, "function");
    assert.ok(originalBootstrap && typeof originalBootstrapAssertion === "function");
  }
  const assertPhysicalCurrent = () => Reflect.apply(originalPhysicalAssertion, supervisor, []);
  const assertBootstrapCurrent = () => Reflect.apply(originalBootstrapAssertion!, originalBootstrap, []);
  const phase = supervisor.phase.bind(supervisor),
    fault = supervisor.fault;
  const standingReviewerFault = supervisor.standingReviewerFault;
  const pendingSaveIntent = supervisor.pendingSaveIntent === true;
  const initialApprovalIntent = supervisor.initialApprovalIntent === true;
  const initialAnswerChoice = supervisor.initialAnswerChoice;
  assert.ok(
    initialApprovalIntent
      ? lane === "connected" &&
          pendingSaveIntent &&
          (initialAnswerChoice === "allow-once" || initialAnswerChoice === "deny" || initialAnswerChoice === "save")
      : initialAnswerChoice === undefined,
  );
  const beforeSaveChoice = supervisor.beforeSaveChoice?.bind(supervisor);
  const beforeStandingIntentReview = supervisor.beforeStandingIntentReview?.bind(supervisor);
  const afterStandingIntentWrite = supervisor.afterStandingIntentWrite?.bind(supervisor);
  const refreshSaveReview = supervisor.refreshSaveReview === true;
  const waitBeforeSaveExpiry = supervisor.waitBeforeSaveExpiry === true;
  const operatorCredentialTtlMs = supervisor.operatorCredentialTtlMs;
  assert.ok(
    operatorCredentialTtlMs === undefined || operatorCredentialTtlMs === 5000 || operatorCredentialTtlMs === 20000,
  );
  const actionTtlMs = supervisor.actionTtlMs ?? 55000;
  assert.ok(Number.isInteger(actionTtlMs) && actionTtlMs >= 5000 && actionTtlMs <= 55000);
  const ownerDurationMs = supervisor.ownerDurationMs;
  assert.ok(ownerDurationMs === undefined || ownerDurationMs === 300000);
  const beforeFreshAuthority = supervisor.beforeFreshAuthority?.bind(supervisor);
  const waitAfterSaveExpiry = supervisor.waitAfterSaveExpiry;
  assert.ok(waitAfterSaveExpiry === undefined || waitAfterSaveExpiry === true);
  const settleOriginalDelivery = supervisor.settleOriginalDelivery?.bind(supervisor);
  assert.equal(process.platform, "linux");
  assert.equal(assertPhysicalCurrent(), undefined);
  assert.ok(Buffer.byteLength(content) <= 4096);
  assert.ok(Number.isSafeInteger(offset) && offset >= 0);
  assert.ok(Number.isSafeInteger(length) && length > 0);
  assert.ok(offset + length <= Buffer.byteLength(content));
  if (lane === "connected") {
    assert.ok(bootstrapEvidenceRef);
    assert.equal(assertBootstrapCurrent(), undefined);
  }
  const config = join(base, "workspace"),
    storeDir = join(config, ".orca");
  const roots = resolveManagedRootBinding(
    [
      { role: "config", path: config },
      { role: "sidecar", path: join(config, "orca.permissions.json") },
      { role: "store", path: storeDir },
    ],
    join(base, "control"),
    join(base, "releases"),
  );
  const stores = fileStores(storeDir);
  // Closed same-lease reentry: the real file mutex remains held by the outer operation.
  // Rechecking a qualified source inside canonical dispatch must not deadlock on that mutex.
  const ownedLease = new AsyncLocalStorage<object>();
  const leases: LeaseStore = {
    clock: systemClock,
    acquire: stores.leases.acquire.bind(stores.leases),
    renew: stores.leases.renew.bind(stores.leases),
    release: stores.leases.release.bind(stores.leases),
    get: stores.leases.get.bind(stores.leases),
    list: stores.leases.list.bind(stores.leases),
    forceRelease: stores.leases.forceRelease.bind(stores.leases),
    withOwnership: (retained, work) =>
      isDeepStrictEqual(ownedLease.getStore(), retained)
        ? work()
        : stores.leases.withOwnership(retained, () => ownedLease.run(retained, work)),
  };
  const abort = new AbortController();
  const saveQuestion = new AbortController();
  const live = new LiveHumanInput("controlled-test-boot");
  let service: ReturnType<typeof createOwnedFileReadServiceForTest> | undefined;
  let delivered: Promise<string | undefined> | undefined;
  const semanticRefs: string[] = [],
    authorizationRefs: string[] = [];
  const receipts: unknown[] = [];
  let operator!: MutationActor, reviewer!: MutationActor;
  let currentSaveHandle = "";
  const credentials = new CredentialStore({ file: join(base, "credentials.json") });
  const currentCredential = (actor: MutationActor) => {
    const value = credentials.current(actor.credentialId!);
    assert.ok(
      value.ok && value.principal.id === actor.principalId && value.principal.permissions.has("permissions.grant"),
    );
    return credentials.list().find((item) => item.id === actor.credentialId)!;
  };
  const check = (): undefined => {
    // Only the exact reviewed child declaration includes the original physical
    // assertion. No fallback after validation/execution failure and no saved success.
    if (composition !== undefined) assert.equal(assertBootstrapCurrent(), undefined);
    else {
      assert.equal(assertPhysicalCurrent(), undefined);
      if (lane === "connected") assert.equal(assertBootstrapCurrent(), undefined);
    }
    abort.signal.throwIfAborted();
    if (operator) currentCredential(operator);
    if (reviewer) currentCredential(reviewer);
    return undefined;
  };
  const interval = (candidateOffset: number, candidateLength: number): undefined => {
    check();
    assert.equal(candidateOffset, offset);
    assert.equal(candidateLength, length);
    return undefined;
  };
  let owner!: ReturnType<typeof protectedScopedPermissionOwner>;
  let producer!: ReturnType<typeof ownedReadScopedCapture>;
  let active!: ManagedTypedStoreBinding;
  let initialRevision = "";
  let initialAction: ActionEvidenceV1 | undefined;
  let baseline: { ref: string; value: unknown } | undefined;
  let baselineSeal: (() => undefined) | undefined;
  let leaseBytes: Buffer | undefined;
  let leaseStamp: string | undefined;
  const leasePath = join(storeDir, "leases", "run%3Acontrolled.json");
  const physicalStamp = (path: string) => {
    const info = fs.lstatSync(path, { bigint: true });
    return [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(
      ":",
    );
  };
  let lease!: Awaited<ReturnType<typeof stores.leases.acquire>>;
  const persistence = new Map<string, { action: ActionEvidenceV1; value: unknown; assertUnchanged(): undefined }>();
  const attestations = new Map<
    ScopedPermissionCapture,
    { result: "passed"; sourceRefs: string[]; action: ActionEvidenceV1 }
  >();
  const standing = new Map<
    string,
    {
      value: {
        version: number;
        grantMode: string;
        reviewedAt: number;
        action: ActionEvidenceV1;
        command: import("@orca/agents").CreateScopedRule;
        binding: ReturnType<typeof bindingIdentity>;
        actor: MutationActor;
        reviewer: { actor: MutationActor; credential: ReturnType<typeof currentCredential> };
        persistenceReview: { ref: string; value: unknown };
        lease: typeof lease;
      };
      assertUnchanged(): undefined;
    }
  >();
  const automatic = new Map<ScopedPermissionCapture, OwnedReadCurrentCapture>();
  const autoTokenFor = (action: ActionEvidenceV1) =>
    [...automatic].find(([, invocation]) => isDeepStrictEqual(invocation.action, action))?.[0];
  const put = async (kind: string, value: unknown, ref: string = randomUUID()) => {
    assert.ok(semanticRefs.length < 128);
    const text = JSON.stringify({ kind, value });
    assert.ok(Buffer.byteLength(text) <= 65536);
    await stores.execution.putPayload(ref, {
      type: "agent.update",
      runId,
      payload: {
        stepRunId: "controlled-step",
        sessionId: "controlled-session",
        update: { kind, text },
      },
    });
    semanticRefs.push(ref);
    return ref;
  };
  const read = async (ref: string, kind: string): Promise<unknown> => {
    const payload = await stores.execution.getPayload(runId, ref, "agent.update");
    const parsed = JSON.parse((payload as { update: { text: string } }).update.text) as {
      kind: string;
      value: unknown;
    };
    assert.equal(parsed.kind, kind);
    return parsed.value;
  };
  const verifyPersistence: NonNullable<ScopedPermissionCapturePort["verifyPersistenceReview"]> = async (
    action,
    refs,
  ) => {
    check();
    assert.equal(refs.length, 1);
    const retained = persistence.get(refs[0]!);
    assert.ok(retained);
    same(retained.action, action);
    // A lookup may already be inside the protected owner's observation. The original
    // private seal was captured when this immutable attestation was authenticated;
    // actual reads here join the caller's observation rather than nesting one.
    same(await read(refs[0]!, "controlled-persistence-review-v1"), retained.value);
    currentCredential(reviewer);
    retained.assertUnchanged();
    return {
      assertCurrent: (): undefined => {
        check();
        currentCredential(reviewer);
        active.assertCurrent();
        retained.assertUnchanged();
        assert.ok(Date.now() < Date.parse(action.expiresAt) && !lapsed(lease, Date.now()));
        return undefined;
      },
    };
  };
  const captures: ScopedPermissionCapturePort = {
    read: (...args) => producer.port.read(...args),
    async forAction(action, binding) {
      const token = autoTokenFor(action);
      if (!token) return producer.port.forAction(action, binding);
      assert.equal(binding, active);
      same(await owner.readCaptureFacts(operator), factsOf(action));
      automatic.get(token)!.assertCurrent();
      check();
      return token;
    },
    snapshot(token) {
      const invocation = automatic.get(token);
      if (invocation) {
        invocation.assertCurrent();
        check();
        assert.equal(invocation.action.workspaceRef.state, "complete");
        return {
          action: invocation.action,
          actor: operator,
          binding: active,
          resourceWorkspaceRef:
            invocation.action.workspaceRef.state === "complete" ? invocation.action.workspaceRef.value : "",
          review: invocation.reviewProvenance(),
        };
      }
      const original = producer.port.snapshot(token),
        proof = attestations.get(token);
      if (!proof) return original;
      same(proof.action, original.action);
      check();
      return { ...original, persistenceReview: { result: proof.result, sourceRefs: [...proof.sourceRefs] } };
    },
    assertCurrent(token, authority) {
      const invocation = automatic.get(token);
      if (!invocation) return producer.port.assertCurrent(token, authority);
      same(invocation.action.authority, authority);
      invocation.assertCurrent();
      return check();
    },
    async policyChanged(token, facts) {
      // Update only current revision before the actual one-time service refresh.
      snapshot.authority = { ...snapshot.authority, currentPolicyRevision: facts.policyRevision };
      await producer.port.policyChanged(token, facts);
      await attest(token, producer.invocation(token).action);
    },
    verifyPersistenceReview: verifyPersistence,
    async verifyPendingExecutionReview(action, refs) {
      // Authenticate this historical proof while the preview is live. Future
      // checks retain its exact seal and current reviewer, not its old expiry.
      const initial = await verifyPersistence(action, refs);
      initial.assertCurrent();
      const retainedAction = structuredClone(action);
      const ref = refs[0]!;
      const retained = persistence.get(ref);
      assert.ok(retained);
      return {
        assertCurrent: (): undefined => {
          check();
          currentCredential(reviewer);
          active.assertCurrent();
          assert.equal(persistence.get(ref), retained);
          same(retained.action, retainedAction);
          retained.assertUnchanged();
          assert.ok(!lapsed(lease, Date.now()));
          return undefined;
        },
      };
    },
    standingGrantReviewScope: "owned-v1",
    async reviewStandingGrant(capture, candidate, scope) {
      assert.ok(scope, "Save review requires its owned scope");
      scope.signal.throwIfAborted();
      if (standingReviewerFault === "hanging") return new Promise<import("@orca/agents").StandingGrantReview>(() => {});
      assert.notEqual(standingReviewerFault, "refusing", "Standing reviewer unavailable");
      return scope.withOwnedWork(async () => {
        const action = producer.port.snapshot(capture).action;
        captures.assertCurrent(capture, action.authority);
        check();
        const reviewedAt = Date.now();
        const priorRef = attestations.get(capture)?.sourceRefs[0];
        assert.ok(priorRef);
        const prior = persistence.get(priorRef);
        assert.ok(prior);
        same(prior.action, action);
        prior.assertUnchanged();
        const credential = currentCredential(reviewer);
        assert.notEqual(reviewer.principalId, operator.principalId);
        assert.ok(reviewedAt < Date.parse(action.expiresAt) && !lapsed(lease, reviewedAt));
        assert.ok(
          action.effectiveCwd.state === "complete" &&
            action.workspaceRef.state === "complete" &&
            action.resources.state === "complete" &&
            action.environmentAndCredentialRefs.state === "complete",
        );
        // The designated test reviewer approves the exact generated scope and the
        // explicit standing lifetime, never the earlier action-only v1 attestation.
        assert.equal(candidate.rule.version, 2);
        assert.equal(candidate.rule.expiresAt, null);
        assert.equal(candidate.rule.status, "approved");
        assert.equal(candidate.rule.decision, "allow");
        assert.equal(candidate.rule.delegation, undefined);
        assert.equal(candidate.rule.ruleRevision, strictPermissionRuleRevision(candidate.rule));
        assert.equal(candidate.expectedRevision, action.authority.currentPolicyRevision);
        same(candidate.rule.match, {
          principalRef: action.invocation.principalRef,
          agentId: action.invocation.agentId,
          hostId: action.invocation.hostId,
          runnerId: action.invocation.runnerId,
          operation: action.operation,
          profileRef: action.profileRef,
          coverageId: action.coverage.coverageId,
          effectiveCwd: action.effectiveCwd.value,
          workspaceRef: action.workspaceRef.value,
          resources: action.resources.value,
          environmentAndCredentialRefs: action.environmentAndCredentialRefs.value,
        });
        const value = structuredClone({
          version: 2,
          grantMode: "until-revoked",
          reviewedAt,
          action,
          command: candidate,
          binding: bindingIdentity(active),
          actor: operator,
          reviewer: { actor: reviewer, credential },
          lease,
          persistenceReview: { ref: priorRef, value: prior.value },
        });
        const ref = await put("controlled-standing-review-v2", value);
        scope.signal.throwIfAborted();
        const observation = await stores.execution.observe!(
          async () => same(await read(ref, "controlled-standing-review-v2"), value),
          { maxRecords: 32 },
        );
        scope.signal.throwIfAborted();
        await observation.verifyUnchanged();
        scope.signal.throwIfAborted();
        captures.assertCurrent(capture, action.authority);
        check();
        standing.set(ref, { value, assertUnchanged: observation.assertUnchanged!.bind(observation) });
        return { version: 2, result: "passed", sourceRefs: [ref] };
      });
    },
    async verifyStandingGrantReview(action, candidate, review, scope) {
      const verify = async () => {
        scope?.signal.throwIfAborted();
        check();
        assert.equal(review.version, 2);
        assert.equal(review.result, "passed");
        assert.equal(review.sourceRefs.length, 1);
        const retained = standing.get(review.sourceRefs[0]!);
        assert.ok(retained, "No retained protected standing approval");
        const value = retained.value;
        const prior = persistence.get(value.persistenceReview.ref);
        assert.ok(prior);
        same(prior.action, action);
        same(prior.value, value.persistenceReview.value);
        same(await read(value.persistenceReview.ref, "controlled-persistence-review-v1"), prior.value);
        scope?.signal.throwIfAborted();
        same(value.action, action);
        same(value.command, candidate);
        same(value.binding, bindingIdentity(active));
        same(value.actor, operator);
        same(value.reviewer.actor, reviewer);
        assert.equal(value.grantMode, "until-revoked");
        assert.ok(value.reviewedAt < Date.parse(action.expiresAt) && !lapsed(value.lease, value.reviewedAt));
        assert.ok(
          !value.reviewer.credential.expiresAt || value.reviewedAt < Date.parse(value.reviewer.credential.expiresAt),
        );
        same(await read(review.sourceRefs[0]!, "controlled-standing-review-v2"), value);
        scope?.signal.throwIfAborted();
        const assertCurrent = (): undefined => {
          check();
          active.assertCurrent();
          currentCredential(reviewer);
          retained.assertUnchanged();
          prior.assertUnchanged();
          // Historical approval expiry was checked at review time above. Present
          // execution still needs its own live action, credential, lease and permit.
          assert.ok(!lapsed(lease, Date.now()));
          return undefined;
        };
        assertCurrent();
        return { assertCurrent };
      };
      return scope ? scope.withOwnedWork(verify) : verify();
    },
  };
  if (pendingSaveIntent) {
    let cancelCurrent = false;
    const pending = new Map<
      ScopedPermissionCapture,
      {
        action: ActionEvidenceV1;
        command: import("@orca/agents").CreateScopedRule;
        target: import("@orca/agents").ScopedCaptureTarget;
        capturedAt: number;
        retired: boolean;
        assertCurrent(): undefined;
      }
    >();
    const reviewedIntents = new Map<
      string,
      {
        value: {
          version: 3;
          request: StandingIntentReviewRequest;
          reviewedAt: number;
          reviewer: { actor: MutationActor; credential: ReturnType<typeof currentCredential> };
          lease: typeof lease;
          persistenceReview: { ref: string; value: unknown };
        };
        assertUnchanged(): undefined;
      }
    >();
    captures.retainGrantIntent = async (capture, command) => {
      assert.ok(!pending.has(capture));
      const source = producer.port.snapshot(capture);
      producer.port.assertCurrent(capture, source.action.authority);
      check();
      assert.ok(source.target);
      const retained = await producer.port.retainGrantIntent!(capture, structuredClone(command));
      const assertPending = retained.assertCurrent.bind(retained),
        retirePending = retained.retire.bind(retained);
      const capturedAt = retained.capturedAt;
      assert.ok(capturedAt < Date.parse(source.action.expiresAt));
      const value = {
        action: structuredClone(source.action),
        command: structuredClone(command),
        target: structuredClone(source.target),
        capturedAt,
        retired: false,
        assertCurrent: (): undefined => {
          if (assertPending() !== undefined) throw Error("Pending scope is unavailable");
          check();
          active.assertCurrent();
          assert.ok(!value.retired && !lapsed(lease, Date.now()));
          assert.ok(service);
          service.assertPendingResource({ resourceRef: service.resourceRef, offset, length });
          assert.equal(live.inspect(value.target), "pending");
          currentCredential(operator);
          assert.equal(
            createHash("sha256")
              .update(fs.readFileSync(join(config, "orca.permissions.json")))
              .digest("hex"),
            value.action.authority.currentPolicyRevision,
          );
          assert.equal(physicalStamp(leasePath), leaseStamp);
          assert.ok(leaseBytes && fs.readFileSync(leasePath).equals(leaseBytes));
          if (cancelCurrent) {
            cancelCurrent = false;
            abort.abort("Run cancelled by currentness hook");
          }
          return undefined;
        },
      };
      value.assertCurrent();
      pending.set(capture, value);
      return Object.freeze({
        capturedAt,
        signal: retained.signal,
        assertCurrent: value.assertCurrent,
        retire: (): undefined => {
          value.retired = true;
          return retirePending();
        },
      });
    };
    captures.reviewStandingIntent = async (capture, request, scope) => {
      const signal = scope.signal;
      signal.throwIfAborted();
      if (standingReviewerFault === "hanging") {
        await beforeStandingIntentReview?.(
          Object.freeze({ issuedAt: request.saveAuthority.issuedAt, expiresAt: request.saveAuthority.expiresAt }),
        );
        if (fault === "save-cancel-review") queueMicrotask(() => abort.abort("Run cancelled during Save review"));
        return new Promise<import("@orca/agents").StandingIntentReview>(() => {});
      }
      assert.notEqual(standingReviewerFault, "refusing", "Standing intent reviewer unavailable");
      const source = pending.get(capture);
      assert.ok(source);
      source.assertCurrent();
      same(request.intent.action, source.action);
      same(request.intent.command, source.command);
      same(request.intent.target, source.target);
      same(request.intent.actor, operator);
      same(request.intent.binding, bindingIdentity(active));
      assert.equal(request.intent.version, 1);
      assert.equal(request.intent.capturedAt, source.capturedAt);
      assert.equal(request.saveAuthority.version, 1);
      if (fault === "save-cancel-current") cancelCurrent = true;
      same(request.saveAuthority.facts, await scope.withOwnedWork(() => owner.readCaptureFacts(operator)));
      signal.throwIfAborted();
      const reviewedAt = Date.now();
      const authority = request.saveAuthority;
      const leaseEnd = Date.parse(lease.renewedAt) + (lease.guardedTtlMs ?? lease.ttlMs);
      assert.ok(
        authority.issuedAt <= reviewedAt &&
          reviewedAt < authority.expiresAt &&
          authority.expiresAt <= authority.issuedAt + 60000 &&
          authority.expiresAt <= leaseEnd,
      );
      const pendingReview = beforeStandingIntentReview?.(
        Object.freeze({ issuedAt: authority.issuedAt, expiresAt: authority.expiresAt }),
      );
      if (fault === "save-cancel-review") setTimeout(() => abort.abort("Run cancelled during Save review"), 5);
      await pendingReview;
      signal.throwIfAborted();
      source.assertCurrent();
      assert.ok(Date.now() >= authority.issuedAt && Date.now() < authority.expiresAt);
      assert.equal(request.intent.command.rule.version, 2);
      assert.equal(request.intent.command.rule.expiresAt, null);
      assert.equal(request.intent.command.rule.delegation, undefined);
      assert.equal(request.intent.command.rule.ruleRevision, strictPermissionRuleRevision(request.intent.command.rule));
      const priorRef = attestations.get(capture)?.sourceRefs[0];
      assert.ok(priorRef);
      const prior = persistence.get(priorRef);
      assert.ok(prior);
      same(prior.action, source.action);
      prior.assertUnchanged();
      if (fault === "save-review-mutated") Object.assign(request.intent.command.rule, { status: "revoked" });
      if (fault === "save-review-reentrant") {
        const repeated = await call("scopedPermissions.choose", {
          target: identity,
          handle: currentSaveHandle,
          choice: "save",
        });
        assert.equal(repeated.ok, false, "Reentrant Save must not acquire a second attempt");
      }
      if (fault === "save-review-method-replaced") {
        captures.verifyStandingIntentReview = async () => {
          throw Error("Replaced reviewer must not be selected");
        };
        captures.reviewStandingIntent = async () => {
          throw Error("Replaced reviewer must not be selected");
        };
        captures.retainGrantIntent = async () => {
          throw Error("Replaced intent owner must not be selected");
        };
      }
      const value = structuredClone({
        version: 3 as const,
        request,
        reviewedAt,
        reviewer: { actor: reviewer, credential: currentCredential(reviewer) },
        lease,
        persistenceReview: { ref: priorRef, value: prior.value },
      });
      const ref = await scope.withOwnedWork(async () => {
        signal.throwIfAborted();
        const ref = await put("controlled-standing-review-v3", value);
        const settling = afterStandingIntentWrite?.();
        if (fault === "save-cancel-write")
          setTimeout(() => abort.abort("Run cancelled during owned review publication"), 5);
        await settling;
        signal.throwIfAborted();
        const observation = await stores.execution.observe!(
          async () => same(await read(ref, "controlled-standing-review-v3"), value),
          { maxRecords: 32 },
        );
        await observation.verifyUnchanged();
        signal.throwIfAborted();
        source.assertCurrent();
        reviewedIntents.set(ref, { value, assertUnchanged: observation.assertUnchanged!.bind(observation) });
        return ref;
      });
      return { version: 3, result: "passed", sourceRefs: [ref] };
    };
    captures.verifyStandingIntentReview = async (request, review, scope) => {
      const verify = async () => {
        const signal = scope?.signal;
        signal?.throwIfAborted();
        check();
        assert.equal(review.version, 3);
        assert.equal(review.result, "passed");
        assert.equal(review.sourceRefs.length, 1);
        const retained = reviewedIntents.get(review.sourceRefs[0]!);
        assert.ok(retained);
        same(retained.value.request, request);
        same(request.intent.actor, operator);
        same(request.intent.binding, bindingIdentity(active));
        const value = retained.value,
          authority = request.saveAuthority;
        assert.ok(request.intent.capturedAt < Date.parse(request.intent.action.expiresAt));
        assert.ok(
          authority.issuedAt <= value.reviewedAt &&
            value.reviewedAt < authority.expiresAt &&
            authority.expiresAt <= authority.issuedAt + 60000 &&
            !lapsed(value.lease, value.reviewedAt),
        );
        assert.ok(
          !value.reviewer.credential.expiresAt || value.reviewedAt < Date.parse(value.reviewer.credential.expiresAt),
        );
        same(value.reviewer.actor, reviewer);
        const prior = persistence.get(value.persistenceReview.ref);
        assert.ok(prior);
        same(prior.action, request.intent.action);
        same(prior.value, value.persistenceReview.value);
        same(await read(value.persistenceReview.ref, "controlled-persistence-review-v1"), prior.value);
        signal?.throwIfAborted();
        same(await read(review.sourceRefs[0]!, "controlled-standing-review-v3"), value);
        signal?.throwIfAborted();
        const assertCurrent = (): undefined => {
          check();
          active.assertCurrent();
          currentCredential(reviewer);
          currentCredential(operator);
          retained.assertUnchanged();
          prior.assertUnchanged();
          assert.ok(!lapsed(lease, Date.now()));
          return undefined;
        };
        assertCurrent();
        return { assertCurrent };
      };
      return scope ? scope.withOwnedWork(verify) : verify();
    };
  }
  if (standingReviewerFault === "missing") {
    delete captures.reviewStandingGrant;
    delete captures.verifyStandingGrantReview;
    delete captures.reviewStandingIntent;
    delete captures.verifyStandingIntentReview;
  }
  const managed = createManagedTypedWorkspace({
    binding: roots,
    lifetime: { mode: "enrollment", assertCurrent: check },
    assertBuildCurrent: check,
    qualify: async (state, action, signal) => {
      check();
      if (state.document.scopedRules.records.length) return owner.qualify(state, action, signal);
      assert.ok(baseline && state.revision === initialRevision);
      same(action.authority.currentPolicyRevision, initialRevision);
      if (initialApprovalIntent) {
        // Only a genuine post-ACK registered facade can qualify a new action.
        // The old preview is deliberately absent from executable lookups.
        assert.ok(autoTokenFor(action) && initialAction);
        const scope = (value: ActionEvidenceV1) => {
          const {
            actionId: _id,
            bindingRef: _binding,
            original: _original,
            dispatch: _dispatch,
            expiresAt: _expiry,
            ...rest
          } = value;
          return rest;
        };
        same(scope(action), scope(initialAction));
      } else same(action, initialAction);
      const token = await captures.forAction(action, active);
      captures.assertCurrent(token, action.authority);
      const observed = await stores.execution.observe!(
        async () => same(await read(baseline!.ref, "controlled-baseline-v1"), baseline!.value),
        { maxRecords: 32 },
      );
      await observed.verifyUnchanged();
      return {
        sourceRefs: [baseline.ref],
        scopeEvidenceRef: baseline.ref,
        approvalRecordRef: JSON.stringify([runId, baseline.ref]),
        authorityRevision: action.authority.authorityRevision,
        assertCurrent: (): undefined => {
          check();
          observed.assertUnchanged!();
          active.assertCurrent();
          signal.throwIfAborted();
          same(action.authority.currentPolicyRevision, initialRevision);
          captures.assertCurrent(token, action.authority);
          return undefined;
        },
      };
    },
  });
  let snapshot!: { -readonly [K in keyof SyntheticReadOwnerSnapshot]: SyntheticReadOwnerSnapshot[K] };
  let invocation: TrustedOwnedReadInvocation | undefined;
  let initialPreview: OwnedReadReviewPreview | undefined;
  let token: ScopedPermissionCapture | undefined;
  let query!: HumanInputQuery;
  let target!: NonNullable<ReturnType<ScopedPermissionCapturePort["snapshot"]>["target"]>;
  async function attest(capture: ScopedPermissionCapture, action: ActionEvidenceV1) {
    check();
    currentCredential(reviewer);
    assert.notEqual(reviewer.principalId, operator.principalId);
    // A policy refresh replaces the action before its attestation is renewed.
    // Read the authoritative service review, not the outer lookup that correctly
    // rejects an old attestation attached to that refreshed action.
    const executionReview = producer.port.snapshot(capture).review;
    const value = {
      version: 1,
      action,
      binding: bindingIdentity(active),
      actor: operator,
      reviewer: { actor: reviewer, credential: currentCredential(reviewer) },
      lease,
      revision: action.authority.currentPolicyRevision,
      expiresAt: action.expiresAt,
      plannedInterval: { offset: offset, length: length },
      executionReview,
    };
    const ref = await put("controlled-persistence-review-v1", value);
    const observation = await stores.execution.observe!(
      async () => same(await read(ref, "controlled-persistence-review-v1"), value),
      { maxRecords: 32 },
    );
    await observation.verifyUnchanged();
    persistence.set(ref, {
      action,
      value: structuredClone(value),
      assertUnchanged: observation.assertUnchanged!.bind(observation),
    });
    attestations.set(capture, { result: "passed", sourceRefs: [ref], action });
  }
  const evidence: SyntheticFenceEvidence = {
    recordCapture: async (action, bytes) => {
      await put("controlled-capture-v1", { action, bytes }, `capture:${action.bindingRef}`);
    },
    recordAuthorization: async (action, verdict, ref) => {
      await put("controlled-authorization-v1", { action, verdict, protectedEvidenceRef: ref }, ref);
      authorizationRefs.push(ref);
    },
    read: async () => ({}), // Recording/dispatch is not an independent effect observation.
  };
  let call!: (method: string, params: unknown) => ReturnType<typeof dispatch>;
  let grantAuthority!: Authorizer["scopedRuleGrantAuthority"];
  let authenticatedPrincipal!: Parameters<Authorizer["scopedRuleGrantAuthority"]>[0];
  let answerAuthority!: LiveAnswerAuthority;
  const identity = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
  };
  const createAuthority = (
    captured: Pick<typeof snapshot, "authority" | "invocation">,
  ): Omit<SyntheticReadOwner, "snapshot"> => ({
    signal: abort.signal,
    clock: systemClock,
    withOwnership: (work) => leases.withOwnership(lease, work),
    authorize: async (action, signal) => {
      signal.throwIfAborted();
      check();
      same(await owner.readCaptureFacts(operator), factsOf(action));
    },
    assertCurrent: (action) => {
      check();
      active.assertCurrent();
      assert.ok(!lapsed(lease, Date.now()));
      same(action.authority, captured.authority);
      same(action.invocation, captured.invocation);
      // Final synchronous protected-fact checks follow all asynchronous policy work.
      assert.equal(
        createHash("sha256")
          .update(fs.readFileSync(join(config, "orca.permissions.json")))
          .digest("hex"),
        action.authority.currentPolicyRevision,
      );
      assert.equal(physicalStamp(leasePath), leaseStamp);
      assert.ok(leaseBytes && fs.readFileSync(leasePath).equals(leaseBytes));
      baselineSeal?.();
      for (const proof of persistence.values()) proof.assertUnchanged();
    },
  });
  const createOriginal = (captured: typeof snapshot): SyntheticReadOwner => ({
    ...createAuthority(captured),
    snapshot: () => captured,
  });
  const policyFor = (original: typeof snapshot) =>
    createStrictPolicyPort({
      source: createStrictPermissionSource({
        capturedCeiling: complete(true),
        readBoundary: async () => {
          check();
          const facts = await owner.readCaptureFacts(operator);
          return {
            authority: { ...original.authority, currentPolicyRevision: facts.policyRevision },
            currentAuthority: complete(true),
            protectedAccess: complete(true),
            coverageAndState: complete(true),
            mandatoryHuman: complete(false),
            profile: complete({
              profileRef,
              minimumCoverage: lane === "bootstrap" ? "policy-per-ask" : "verified-per-execution",
              facts: {
                rawDuplicateKeyValidation: "complete-or-absent",
                effectiveCwd: "complete",
                workspaceRef: "complete",
                resources: "complete",
                executableAndInterpreter: "complete-or-absent",
                stdin: "complete-or-absent",
                environmentAndCredentialRefs: "complete",
                relevantStateRefs: "complete",
              },
            }),
          };
        },
        readRules: async (action, signal) => {
          if (lane !== "bootstrap") return policy.readRules(action, signal);
          // Separate authenticated operator baseline, never a connected standing rule.
          assert.ok(bootstrapRule && baseline);
          const observed = await stores.execution.observe!(
            async () => same(await read(baseline!.ref, "controlled-baseline-v1"), baseline!.value),
            { maxRecords: 32 },
          );
          await observed.verifyUnchanged();
          check();
          observed.assertUnchanged!();
          const { strictRuleProjectionDigest } = await import("@orca/agents");
          return {
            state: "qualified",
            rules: [bootstrapRule],
            provenance: {
              sourceRefs: [baseline.ref],
              policyRevision: initialRevision,
              authorityRevision: action.authority.authorityRevision,
              projectionDigest: strictRuleProjectionDigest([bootstrapRule]),
              scopeEvidenceRef: baseline.ref,
              approvalRecordRef: JSON.stringify([runId, baseline.ref]),
            },
          };
        },
      }),
      authorizeProjection: async () => {
        throw Error("No execution judge configured in controlled lane");
      },
      recordReview: async () => {
        throw Error("No execution judge configured in controlled lane");
      },
    });
  let policy!: Awaited<ReturnType<typeof managed.enrollFresh>>;
  let bootstrapRule: StrictPermissionRule | undefined;
  try {
    await phase(lane === "bootstrap" ? "bootstrap" : initialApprovalIntent ? "human-read" : "save", async () => {
      policy = await managed.enrollFresh();
      const available = await managed.currentStore();
      assert.ok(available.available);
      active = available.binding;
      initialRevision = (await policy.read()).revision;
      await stores.execution.putInputs({
        runId,
        workflowId: "controlled-test",
        workflowVersion: "1",
        vars: {},
        sensitiveNames: [],
        secrets: [],
      });
      lease = await stores.leases.acquire({
        resource: `run:${runId}`,
        holder: randomUUID(),
        ttlMs: ownerDurationMs ?? 60000,
      });
      leaseBytes = fs.readFileSync(leasePath);
      leaseStamp = physicalStamp(leasePath);
      const issued = await credentials.issue({
        principal: "controlled-test-operator",
        permissions: ["permissions.grant", "inputs.answer"],
        scope: { workflows: "*", runs: "all" },
        ...(operatorCredentialTtlMs ? { ttlMs: operatorCredentialTtlMs } : {}),
      });
      operator = { principalId: issued.credential.principal, credentialId: issued.credential.id };
      const reviewed = await credentials.issue({
        principal: "controlled-test-reviewer",
        permissions: ["permissions.grant"],
        scope: { workflows: "*", runs: "all" },
      });
      reviewer = { principalId: reviewed.credential.principal, credentialId: reviewed.credential.id };
      assert.ok(credentials.authenticate(reviewed.token).ok);
      owner = protectedScopedPermissionOwner({
        currentStore: () => managed.currentStore(),
        live,
        captures,
        credentials,
        leases,
        lease,
        execution: stores.execution,
        events: stores.events,
        disclosure: {
          approve: async () => ({
            scope: {
              principal: "Designated test operator",
              operation: "Read",
              resources: "Disposable detached inode",
              environment: "None",
              lifetime: "Until revoked",
              limits: "Supervisor enforces original interval",
              authorizer: "Designated test persistence reviewer",
              coverage: "Controlled test only",
            },
            references: [],
          }),
        },
      });
      const facts = await owner.readCaptureFacts(operator);
      snapshot = {
        invocation: {
          instanceId: "controlled-test-boot",
          sessionId: "controlled-session",
          turnId: "controlled-human-turn",
          invocationId: "controlled-human-invocation",
          runId,
          rootRunId: runId,
          stepRunId: "controlled-step",
          attemptId: "controlled-attempt",
          agentId: "controlled-agent",
          hostId: "controlled-local-linux",
          runnerId: "controlled-runner",
          principalRef: operator.principalId,
        },
        authority: {
          capturedGeneration: "controlled-original-ceiling",
          currentPolicyRevision: facts.policyRevision,
          authorityRevision: facts.authorityRevision,
          revocationEpoch: facts.revocationEpoch,
          leaseEpoch: facts.leaseEpoch,
        },
        coverage: {} as SyntheticReadOwnerSnapshot["coverage"],
        cwd: config,
        workspaceRef: active.workspaceRef,
        relevantStateRefs: [],
        expiresAt: new Date(Date.now() + actionTtlMs).toISOString(),
      };
      const original = createOriginal(snapshot);
      service = createOwnedFileReadServiceForTest({
        enabled: true,
        owner: original,
        content: content,
        maximumInvocations: ownerDurationMs === 300000 && lane === "connected" ? 3 : 2,
        ...(lane === "connected"
          ? {
              controlledSupervisor: {
                installedEvidenceRef: bootstrapEvidenceRef!,
                assertCurrent: check,
                assertInterval: interval,
              },
            }
          : {}),
        observed: async (action, ref) => {
          await put("controlled-producer-observation-v1", { actionId: action.actionId, authorizationRef: ref });
        },
        respond: async (bytes, signal) => {
          signal.throwIfAborted();
          same(Buffer.from(bytes), Buffer.from(content).subarray(offset, offset + length));
        },
      });
      const parameters = { resourceRef: service.resourceRef, offset: offset, length: length };
      interval(parameters.offset, parameters.length);
      const strict = policyFor(snapshot);
      if (lane === "bootstrap") {
        invocation = service.capture(original, parameters, strict, evidence);
        const action = invocation.action;
        assert.ok(
          action.effectiveCwd.state === "complete" &&
            action.workspaceRef.state === "complete" &&
            action.resources.state === "complete",
        );
        bootstrapRule = {
          ruleId: "controlled-bootstrap-only",
          ruleRevision: "",
          status: "approved",
          notBefore: new Date(Date.now() - 1000).toISOString(),
          expiresAt: action.expiresAt,
          decision: "allow",
          match: {
            principalRef: operator.principalId,
            agentId: action.invocation.agentId,
            hostId: action.invocation.hostId,
            runnerId: action.invocation.runnerId,
            operation: action.operation,
            profileRef,
            coverageId: action.coverage.coverageId,
            effectiveCwd: action.effectiveCwd.value,
            workspaceRef: action.workspaceRef.value,
            resources: action.resources.value,
            environmentAndCredentialRefs: [],
          },
        };
        bootstrapRule = { ...bootstrapRule, ruleRevision: strictPermissionRuleRevision(bootstrapRule) };
      } else {
        const opening = openControlledInput({
          port: live,
          clock: systemClock,
          runId,
          stepRunId: "controlled-step",
          kind: "permission",
          question: "Allow this bounded disposable test read?",
          options: ["once", "deny"],
          emit: (input) => stores.events.append({ ...input, runId } as Parameters<typeof stores.events.append>[0]),
          live: {
            identity: {
              instanceId: snapshot.invocation.instanceId,
              sessionId: snapshot.invocation.sessionId,
              turnId: snapshot.invocation.turnId,
              invocationId: snapshot.invocation.invocationId,
            },
            signal: AbortSignal.any([abort.signal, saveQuestion.signal]),
            withOwnership: async (work) => {
              const result = await leases.withOwnership(lease, work);
              await settleOriginalDelivery?.();
              if (fault === "lost-ack") throw Error("Controlled final acknowledgement lost");
              await put("controlled-final-delivery-ack-v1", { requestId: query.requestId, actor: operator });
              return result;
            },
            emitOwned: (input) =>
              stores.events.append({ ...input, runId } as Parameters<typeof stores.events.append>[0]),
          },
          onRequested: (value) => {
            query = value;
          },
        });
        delivered = opening.delivery;
        await opening.published;
        check();
        target = { ...query.live!.identity, runId, stepRunId: query.stepRunId, requestId: query.requestId };
        producer = ownedReadScopedCapture({
          service,
          currentStore: () => managed.currentStore(),
          live,
          readCaptureFacts: (actor) => owner.readCaptureFacts(actor),
        });
        const captureInput = {
          actor: operator,
          target,
          query,
          onceOptionId: "once",
          denyOptionId: "deny",
          owner: original,
          parameters,
          policy: strict,
          evidence,
        };
        if (initialApprovalIntent) {
          const { expiresAt: _historicalExpiry, ...intent } = structuredClone(snapshot);
          const captured = await producer.captureIntent({
            ...captureInput,
            executionWindowMs: 55000,
            assertIntentCurrent: (): undefined => {
              check();
              active.assertCurrent();
              assert.ok(!lapsed(lease, Date.now()));
              assert.equal(
                createHash("sha256")
                  .update(fs.readFileSync(join(config, "orca.permissions.json")))
                  .digest("hex"),
                intent.authority.currentPolicyRevision,
              );
              assert.equal(physicalStamp(leasePath), leaseStamp);
              assert.ok(leaseBytes && fs.readFileSync(leasePath).equals(leaseBytes));
              baselineSeal?.();
              for (const proof of persistence.values()) proof.assertUnchanged();
              return undefined;
            },
            authorizeExecution: async (signal) => {
              signal.throwIfAborted();
              await beforeFreshAuthority?.();
              signal.throwIfAborted();
              check();
              const current = await owner.readCaptureFacts(operator);
              signal.throwIfAborted();
              check();
              const metadata = {
                ...intent,
                authority: { ...intent.authority, currentPolicyRevision: current.policyRevision },
              };
              same(factsOf(metadata), current);
              const leaseExpiresAt = Math.min(
                Date.parse(lease.renewedAt) + lease.guardedTtlMs!,
                Date.parse(currentCredential(operator).expiresAt ?? new Date(8640000000000000).toISOString()),
              );
              await put("controlled-fresh-authority-v1", {
                version: 1,
                observedAt: Date.now(),
                intent: metadata,
                actor: operator,
                credential: currentCredential(operator),
                lease,
                executionWindowMs: 55000,
                leaseExpiresAt,
              });
              signal.throwIfAborted();
              check();
              const authority: PostApprovalReadAuthority = {
                ...createAuthority(metadata),
                snapshot: () => metadata,
                leaseExpiresAt,
              };
              return {
                authority,
                policy: policyFor({ ...metadata, expiresAt: new Date(leaseExpiresAt).toISOString() }),
                evidence,
              };
            },
            registerInvocation: (capture) => {
              automatic.set(Object.freeze({}) as ScopedPermissionCapture, capture);
              return undefined;
            },
            evidence: {
              ...evidence,
              recordCapture: async (action, bytes) => {
                await put("controlled-initial-preview-v1", { action, bytes }, `initial-preview:${action.bindingRef}`);
              },
            },
          });
          token = captured.token;
          initialPreview = captured.preview;
          await put("controlled-initial-deferred-intent-v1", {
            version: 1,
            intent,
            parameters,
            target,
            executionWindowMs: 55000,
          });
        } else {
          const captured = await producer.capture(captureInput);
          token = captured.token;
          invocation = captured.invocation;
        }
      }
      const reviewInvocation = initialPreview ?? invocation!;
      initialAction = reviewInvocation.action;
      const baselineValue = {
        version: 1,
        originalAction: initialAction,
        capturedCeiling: {
          operation: "fs.readOwnedBytes",
          profileRef,
          resourceRef: service.resourceRef,
          maximumInvocations: ownerDurationMs === 300000 && lane === "connected" ? 3 : 2,
        },
        binding: bindingIdentity(active),
        operator: { actor: operator, credential: currentCredential(operator) },
        lease,
        initialRevision,
        profileRef,
        installedEvidenceRef: bootstrapEvidenceRef ?? null,
        interval: { offset: offset, length: length },
        expiresAt: snapshot.expiresAt,
        rules: bootstrapRule ? [bootstrapRule] : [],
      };
      baseline = { ref: await put("controlled-baseline-v1", baselineValue), value: baselineValue };
      const baselineObservation = await stores.execution.observe!(
        async () => same(await read(baseline!.ref, "controlled-baseline-v1"), baselineValue),
        { maxRecords: 32 },
      );
      await baselineObservation.verifyUnchanged();
      baselineSeal = baselineObservation.assertUnchanged!.bind(baselineObservation);
      const evaluation = await reviewInvocation.evaluate(abort.signal);
      assert.equal(evaluation.phase, "final");
      if (evaluation.phase !== "final") throw Error("unexpected required execution review");
      if (lane === "bootstrap") {
        assert.ok(invocation);
        assert.equal(evaluation.verdict.outcome, "allow");
        if (evaluation.verdict.outcome !== "allow") throw Error("bootstrap not authorized");
        const permit = await invocation.authorize(invocation.action, evaluation.verdict, abort.signal);
        const receipt = await invocation.dispatch(permit, abort.signal);
        receipts.push(receipt);
        assert.equal(receipt.state, "completed");
        service.close();
        return;
      }
      if (initialApprovalIntent) {
        // Non-executable preview lookup cannot qualify an execution policy
        // projection. Retain this exact refusal rather than relabel it passed.
        assert.equal(evaluation.verdict.outcome, "indeterminate");
        if (evaluation.verdict.outcome !== "indeterminate") throw Error("Unexpected preview policy result");
        assert.equal(evaluation.verdict.reason, "required-policy-unavailable");
        await put("controlled-initial-preview-evaluation-v1", {
          actionId: reviewInvocation.action.actionId,
          outcome: evaluation.verdict.outcome,
          reason: evaluation.verdict.reason,
        });
      } else assert.equal(evaluation.verdict.outcome, "require-human");
      same(reviewInvocation.reviewProvenance(), { result: "unavailable", sourceRefs: [] });
      await attest(token!, reviewInvocation.action);
      if (fault === "review-proof") persistence.clear();
      if (fault === "reviewer-revoked") await credentials.revoke(reviewer.credentialId!);
      const auth = new Authorizer({
        ownership: new OwnershipStore(),
        resolver: {
          run: async (id) => (id === runId ? { workflowId: "controlled-test" } : undefined),
          inputRun: async (id) => (id === target.requestId ? runId : undefined),
          artifactRun: async () => undefined,
          claimRun: async () => undefined,
          workflowExists: () => true,
        },
        currentPrincipal: (value) => {
          const current = credentials.current(value.credentialId!);
          if (!current.ok) throw authInvalid();
          return current.principal;
        },
      });
      const authenticated = credentials.authenticate(issued.token);
      assert.ok(authenticated.ok);
      grantAuthority = auth.scopedRuleGrantAuthority.bind(auth);
      authenticatedPrincipal = authenticated.principal;
      const scopedMethods = scopedPermissionMethods(owner, identity, auth);
      const originalReview = scopedMethods["scopedPermissions.review"]!;
      const methods = auth.guard({
        ...scopedMethods,
        "scopedPermissions.review": {
          ...originalReview,
          handle: async (params, context) => {
            assert.ok(context.liveAnswerAuthority);
            const authority = context.liveAnswerAuthority;
            answerAuthority = Object.freeze({
              actor: structuredClone(authority.actor),
              authorize: authority.authorize.bind(undefined),
            });
            return originalReview.handle(params, context);
          },
        },
      });
      call = (method, params) =>
        dispatch(
          JSON.stringify({ kind: "request", id: 1, method, params }),
          methods,
          bindPrincipal({ orcaVersion: "controlled-test", capabilities: [] }, authenticated.principal, {
            transport: "http",
          }),
        );
      let review = await call("scopedPermissions.review", { target: identity, input: target });
      assert.ok(review.ok, JSON.stringify(review));
      await beforeSaveChoice?.();
      if (waitBeforeSaveExpiry)
        await delay(Math.max(0, Date.parse(snapshot.expiresAt) - Date.now() + 1), undefined, { signal: abort.signal });
      if (fault === "save-cancel") abort.abort("Run cancelled before Save choice");
      if (refreshSaveReview) {
        review = await call("scopedPermissions.review", { target: identity, input: target });
        assert.ok(review.ok, JSON.stringify(review));
      }
      const handle = (review.result as { handle: string }).handle;
      currentSaveHandle = handle;
      if (initialApprovalIntent && initialAnswerChoice !== "save") {
        const answering = call("scopedPermissions.choose", { target: identity, handle, choice: initialAnswerChoice });
        const execution = delivered!.then((option) => {
          if (option === "deny") return undefined;
          assert.equal(option, "once");
          return producer.executeHumanDelivery(token!, abort.signal);
        });
        void execution.catch(() => undefined);
        const accepted = await answering;
        assert.ok(
          accepted.ok && (accepted.result as { outcome: string }).outcome === "answered",
          JSON.stringify(accepted),
        );
        const receipt = await execution;
        if (initialAnswerChoice === "allow-once") {
          assert.ok(receipt && receipt.state === "completed");
          receipts.push(receipt);
          assert.equal(authorizationRefs.length, 1);
          assert.equal(await producer.executeHumanDelivery(token!, abort.signal), receipt);
        } else {
          assert.equal(receipt, undefined);
          assert.equal(authorizationRefs.length, 0);
        }
        assert.equal((await policy.read()).document.scopedRules.records.length, 0);
        return;
      }
      const saved = await call("scopedPermissions.choose", { target: identity, handle, choice: "save" });
      assert.ok(saved.ok && (saved.result as { outcome: string }).outcome === "saved", JSON.stringify(saved));
      assert.equal(live.inspect(target), "pending");
      assert.equal((await stores.events.readTypes(runId, ["human.answered"])).length, 0);
      assert.equal(authorizationRefs.length, 0);
      const after = await policy.read();
      assert.equal(after.document.scopedRules.records.length, 1);
      if (initialApprovalIntent) {
        assert.equal(initialAnswerChoice, "save");
        const preview = initialPreview;
        assert.ok(preview);
        assert.throws(() => preview.assertCurrent());
        await assert.rejects(producer.executeHumanDelivery(token!, abort.signal));
        assert.equal(authorizationRefs.length, 0);
        assert.equal(receipts.length, 0);
        return;
      }
      if (fault === "stale-revision")
        snapshot.authority = { ...snapshot.authority, currentPolicyRevision: initialRevision };
    });
    if (lane === "connected" && !initialApprovalIntent) {
      await phase("human-read", async () => {
        if (fault === "cancel") abort.abort();
        if (ownerDurationMs === 300000) {
          // Save did not approve an effect. Retire that original question and
          // create a deliberately distinct live approval, never rebind its handle.
          saveQuestion.abort("Save preview retired; a distinct approval follows");
          assert.equal(await delivered, undefined);
          const facts = await owner.readCaptureFacts(operator);
          const { expiresAt: _oldExpiry, ...intent } = {
            ...structuredClone(snapshot),
            invocation: {
              ...snapshot.invocation,
              turnId: "controlled-fresh-human-turn",
              invocationId: "controlled-fresh-human-invocation",
            },
            authority: { ...snapshot.authority, currentPolicyRevision: facts.policyRevision },
          };
          let freshQuery!: HumanInputQuery;
          const opening = openControlledInput({
            port: live,
            clock: systemClock,
            runId,
            stepRunId: "controlled-step",
            kind: "permission",
            question: "Approve this fresh bounded disposable read?",
            options: ["once", "deny"],
            emit: (input) => stores.events.append({ ...input, runId } as Parameters<typeof stores.events.append>[0]),
            live: {
              identity: {
                instanceId: intent.invocation.instanceId,
                sessionId: intent.invocation.sessionId,
                turnId: intent.invocation.turnId,
                invocationId: intent.invocation.invocationId,
              },
              signal: abort.signal,
              withOwnership: async (work) => {
                const result = await leases.withOwnership(lease, work);
                await settleOriginalDelivery?.();
                if (fault === "lost-ack") throw Error("Controlled final acknowledgement lost");
                await put("controlled-final-delivery-ack-v1", { requestId: freshQuery.requestId, actor: operator });
                return result;
              },
              emitOwned: (input) =>
                stores.events.append({ ...input, runId } as Parameters<typeof stores.events.append>[0]),
            },
            onRequested: (value) => {
              freshQuery = value;
            },
          });
          delivered = opening.delivery;
          await opening.published;
          check();
          const freshTarget = {
            ...freshQuery.live!.identity,
            runId,
            stepRunId: freshQuery.stepRunId,
            requestId: freshQuery.requestId,
          };
          const parameters = { resourceRef: service!.resourceRef, offset, length };
          const pending = service!.prepareHumanRead({
            intent,
            parameters,
            query: freshQuery,
            delivery: live.retainOriginalDelivery(freshQuery),
            actor: operator,
            onceOptionId: "once",
            executionWindowMs: 55000,
            authorizeExecution: async (signal) => {
              signal.throwIfAborted();
              await beforeFreshAuthority?.();
              signal.throwIfAborted();
              check();
              const current = await owner.readCaptureFacts(operator);
              signal.throwIfAborted();
              check();
              const metadata = {
                ...intent,
                authority: { ...intent.authority, currentPolicyRevision: current.policyRevision },
              };
              same(factsOf(metadata), current);
              const leaseExpiresAt = Date.parse(lease.renewedAt) + lease.guardedTtlMs!;
              await put("controlled-fresh-authority-v1", {
                version: 1,
                observedAt: Date.now(),
                intent: metadata,
                actor: operator,
                credential: currentCredential(operator),
                lease,
                executionWindowMs: 55000,
                leaseExpiresAt,
              });
              signal.throwIfAborted();
              check();
              const authority: PostApprovalReadAuthority = {
                ...createAuthority(metadata),
                snapshot: () => metadata,
                leaseExpiresAt,
              };
              return {
                authority,
                policy: policyFor({ ...metadata, expiresAt: new Date(leaseExpiresAt).toISOString() }),
                evidence,
              };
            },
            registerInvocation: (capture) => {
              automatic.set(Object.freeze({}) as ScopedPermissionCapture, capture);
              return undefined;
            },
          });
          await put("controlled-deferred-intent-v1", {
            version: 1,
            intent,
            parameters,
            target: freshTarget,
            grant: (await policy.read()).document.scopedRules.records[0]!.approvalRecordRef,
          });
          if (waitAfterSaveExpiry) {
            const originalExpiry = Date.parse(snapshot.expiresAt);
            assert.ok(Number.isFinite(originalExpiry));
            while (Date.now() <= originalExpiry)
              await delay(originalExpiry - Date.now() + 1, undefined, { signal: abort.signal });
            check();
          }
          const answering = live.answer({ target: freshTarget, optionId: "once" }, answerAuthority);
          const execution = delivered.then((option) => {
            assert.equal(option, "once");
            return service!.executePreparedHumanRead(pending, abort.signal);
          });
          void execution.catch(() => undefined);
          const accepted = await answering;
          assert.ok(accepted.answerRecorded && accepted.delivered);
          assert.equal(await delivered, "once");
          const receipt = await execution;
          receipts.push(receipt);
          assert.equal(receipt.state, "completed");
          assert.equal(await service!.executePreparedHumanRead(pending, abort.signal), receipt);
          assert.equal(authorizationRefs.length, 1);
          return;
        }
        const reviewed = await call("scopedPermissions.review", { target: identity, input: target });
        assert.ok(reviewed.ok, JSON.stringify(reviewed));
        const answer = call("scopedPermissions.choose", {
          target: identity,
          handle: (reviewed.result as { handle: string }).handle,
          choice: "allow-once",
        });
        // Only the original callback continuation starts completion. It can resolve
        // before the outer final lease ack; completion must still await that ack.
        const execution = delivered!.then((option) => {
          assert.equal(option, "once");
          return producer.executeHumanDelivery(token!, abort.signal);
        });
        void execution.catch(() => undefined);
        const settled = await answer;
        assert.ok(
          settled.ok && (settled.result as { outcome: string }).outcome === "answered",
          JSON.stringify(settled),
        );
        assert.equal(await delivered, "once");
        const receipt = await execution;
        receipts.push(receipt);
        assert.equal(receipt.state, "completed");
        assert.equal(await producer.executeHumanDelivery(token!, abort.signal), receipt);
        assert.equal(authorizationRefs.length, 1);
      });
      await phase("rule-read", async () => {
        check();
        if (fault === "revoke-rule") {
          const state = await policy.read(),
            record = state.document.scopedRules.records[0]!;
          // Capture the authority revision before taking the policy write lock. Its
          // callbacks below revalidate only actual credential/lease/binding authority;
          // a sidecar read from inside that lock would refuse our own transition.
          const authorityCredential = currentCredential(operator);
          const authority = await owner.readCaptureFacts(operator);
          same(currentCredential(operator), authorityCredential);
          same(authority.policyRevision, state.revision);
          const proofRef = randomUUID();
          const revoke = {
            ruleId: record.rule.ruleId,
            ruleRevision: record.rule.ruleRevision,
            expectedRevision: state.revision,
            approvalRecordRef: JSON.stringify([runId, proofRef]),
          };
          const expectedRule = { ...record.rule, status: "revoked" as const };
          const rule = { ...expectedRule, ruleRevision: strictPermissionRuleRevision(expectedRule) };
          const command = { rule, expectedRevision: state.revision, approvalRecordRef: revoke.approvalRecordRef };
          const proof = {
            command,
            actor: operator,
            credential: authorityCredential,
            lease,
            binding: bindingIdentity(active),
          };
          await put("controlled-rule-revocation-v1", proof, proofRef);
          const observed = await stores.execution.observe!(
            async () => same(await read(proofRef, "controlled-rule-revocation-v1"), proof),
            { maxRecords: 32 },
          );
          await observed.verifyUnchanged();
          const assertAuthorityCurrent = (): undefined => {
            check();
            active.assertCurrent();
            same(currentCredential(operator), proof.credential);
            assert.ok(!lapsed(lease, Date.now()));
            assert.equal(physicalStamp(leasePath), leaseStamp);
            assert.ok(leaseBytes && fs.readFileSync(leasePath).equals(leaseBytes));
            observed.assertUnchanged!();
            return undefined;
          };
          await leases.withOwnership(lease, () =>
            policy.revokeScopedRule(
              revoke,
              grantAuthority(authenticatedPrincipal, {
                readAuthorityRevision: async () => {
                  same(await stores.leases.get(lease.resource), lease);
                  assertAuthorityCurrent();
                  return authority.authorityRevision;
                },
                verifyApproval: async (supplied, actor) => {
                  same(supplied, command);
                  same(actor, operator);
                  same(await read(proofRef, "controlled-rule-revocation-v1"), proof);
                  assertAuthorityCurrent();
                  return { scopeEvidenceRef: proofRef };
                },
                assertCommitCurrent: (supplied, actor, accepted) => {
                  same(supplied, command);
                  same(actor, operator);
                  same(accepted, { scopeEvidenceRef: proofRef, authorityRevision: authority.authorityRevision });
                  return assertAuthorityCurrent();
                },
              }),
            ),
          );
          assert.equal((await policy.read()).document.scopedRules.records[0]!.rule.status, "revoked");
        }
        const facts = await owner.readCaptureFacts(operator); // Before immutable fresh action.
        const fresh = {
          ...structuredClone(snapshot),
          // A different invocation has fresh genuine authority. The historical
          // Save action and accepted human delivery keep their original expiry.
          expiresAt: new Date(
            Math.min(Date.now() + 55000, Date.parse(lease.renewedAt) + lease.guardedTtlMs!),
          ).toISOString(),
          invocation: {
            ...snapshot.invocation,
            invocationId: "controlled-rule-invocation",
            turnId: "controlled-rule-turn",
          },
          authority: { ...snapshot.authority, currentPolicyRevision: facts.policyRevision },
        };
        const original = createOriginal(fresh);
        const captureOffset = offset + (fault === "wrong-interval" ? 1 : 0);
        interval(captureOffset, length);
        const invocation = service!.capture(
          original,
          { resourceRef: service!.resourceRef, offset: captureOffset, length },
          policyFor(fresh),
          evidence,
        );
        const auto = Object.freeze({}) as ScopedPermissionCapture;
        automatic.set(auto, invocation);

        const result = await invocation.evaluate(abort.signal);
        assert.equal(result.phase, "final");
        assert.ok(result.phase === "final" && result.verdict.outcome === "allow");
        assert.equal(result.verdict.authorizedBy.kind, "rule");
        const permit = await invocation.authorize(invocation.action, result.verdict, abort.signal);
        const receipt = await invocation.dispatch(permit, abort.signal);
        receipts.push(receipt);
        assert.equal(receipt.state, "completed");
        assert.equal(await invocation.dispatch(permit, abort.signal), receipt);
        await assert.rejects(invocation.completeHumanDelivery(abort.signal));
        assert.equal(authorizationRefs.length, 2);
        assert.equal(live.pendingCount, 0);
        assert.equal((await stores.events.readTypes(runId, ["human.answered"])).length, 1);
        service!.close();
      });
    }
    const finalRevision = (await policy.read()).revision;
    if (lane === "connected") {
      // TEST observation only: the store creates this directory without a stat.
      // Supply genuine traced inode metadata; the observer's strict final named
      // identity check remains unchanged. No content read or new action authority.
      check();
      assert.ok(fs.lstatSync(join(storeDir, "runs")).isDirectory());
      check();
    }
    return {
      semanticRefs,
      authorizationRefs,
      receipts,
      initialRevision,
      finalRevision,
    };
  } finally {
    await service?.closeAndDrain();
    live.close();
    abort.abort();
    await delivered?.catch(() => undefined);
  }
}
