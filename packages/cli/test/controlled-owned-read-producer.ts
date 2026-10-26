/** Dedicated disposable test producer. No barrel export, RPC, JSON switch or production mount.
 * The caller is the designated test supervisor, retaining real physical assertions and phase pipes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
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
} from "@orca/agents";
import { askHumanInput, LiveHumanInput, type HumanInputQuery } from "@orca/engine";
import { CredentialStore } from "../../daemon/src/auth/credentials.js";
import { Authorizer, OwnershipStore, authInvalid, bindPrincipal } from "../../daemon/src/auth/index.js";
import { scopedPermissionMethods } from "../../daemon/src/scoped-permission-bridge.js";
import { dispatch } from "../../daemon/src/server.js";
import { protectedScopedPermissionOwner } from "../../daemon/src/protected-scoped-permission-owner.js";
import { ownedReadScopedCapture } from "../../daemon/src/owned-read-scoped-capture.js";
import {
  createOwnedFileReadServiceForTest,
  type TrustedOwnedReadInvocation,
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

export interface ControlledReadTestSupervisor {
  /** Actual retained image/root/identity/lifetime checks, never no-op test substitutions. */
  assertCurrent(): undefined;
  /** Private supervisor capability issued only AFTER separate independent bootstrap replay.
   * The reference alone has no authority; the callable checks retained original proof/current image. */
  readonly bootstrap?: { readonly evidenceRef: string; assertCurrent(): undefined };
  readonly content: string;
  readonly offset: number;
  readonly length: number;
  /** Supervisor consumes a fresh command token and acknowledges only after work settles. */
  phase(name: "bootstrap" | "save" | "human-read" | "rule-read", work: () => Promise<void>): Promise<void>;
  /** Controlled fault injection only. Never an authorization or qualification input. */
  readonly fault?:
    "reviewer-revoked" | "review-proof" | "stale-revision" | "lost-ack" | "cancel" | "revoke-rule" | "wrong-interval";
  /** Optional test synchronization: retain final genuine lease ack until released/rejected. */
  settleOriginalDelivery?(): Promise<void>;
}

/** The only exported entrypoint. All accepting qualifiers/indexes remain private to this call. */
export async function runControlledOwnedReadTest(
  base: string,
  lane: "bootstrap" | "connected",
  supervisor: ControlledReadTestSupervisor,
) {
  assert.equal(process.platform, "linux");
  assert.equal(supervisor.assertCurrent(), undefined);
  assert.ok(Buffer.byteLength(supervisor.content) <= 4096);
  assert.ok(Number.isSafeInteger(supervisor.offset) && supervisor.offset >= 0);
  assert.ok(Number.isSafeInteger(supervisor.length) && supervisor.length > 0);
  assert.ok(supervisor.offset + supervisor.length <= Buffer.byteLength(supervisor.content));
  if (lane === "connected") {
    assert.ok(supervisor.bootstrap?.evidenceRef);
    assert.equal(supervisor.bootstrap.assertCurrent(), undefined);
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
  const live = new LiveHumanInput("controlled-test-boot");
  let service: ReturnType<typeof createOwnedFileReadServiceForTest> | undefined;
  let delivered: Promise<string | undefined> | undefined;
  const semanticRefs: string[] = [],
    authorizationRefs: string[] = [];
  const receipts: unknown[] = [];
  let operator!: MutationActor, reviewer!: MutationActor;
  const credentials = new CredentialStore({ file: join(base, "credentials.json") });
  const currentCredential = (actor: MutationActor) => {
    const value = credentials.current(actor.credentialId!);
    assert.ok(
      value.ok && value.principal.id === actor.principalId && value.principal.permissions.has("permissions.grant"),
    );
    return credentials.list().find((item) => item.id === actor.credentialId)!;
  };
  const check = (): undefined => {
    supervisor.assertCurrent();
    if (lane === "connected") supervisor.bootstrap!.assertCurrent();
    abort.signal.throwIfAborted();
    if (operator) currentCredential(operator);
    if (reviewer) currentCredential(reviewer);
    return undefined;
  };
  const interval = (offset: number, length: number): undefined => {
    check();
    assert.equal(offset, supervisor.offset);
    assert.equal(length, supervisor.length);
    return undefined;
  };
  let owner!: ReturnType<typeof protectedScopedPermissionOwner>;
  let producer!: ReturnType<typeof ownedReadScopedCapture>;
  let active!: ManagedTypedStoreBinding;
  let initialRevision = "";
  let initialAction: ActionEvidenceV1 | undefined;
  let baseline: { ref: string; value: unknown } | undefined;
  let lease!: Awaited<ReturnType<typeof stores.leases.acquire>>;
  const persistence = new Map<string, { action: ActionEvidenceV1; value: unknown; assertUnchanged(): undefined }>();
  const attestations = new Map<
    ScopedPermissionCapture,
    { result: "passed"; sourceRefs: string[]; action: ActionEvidenceV1 }
  >();
  const automatic = new Map<ScopedPermissionCapture, TrustedOwnedReadInvocation>();
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
  };
  const managed = createManagedTypedWorkspace({
    binding: roots,
    lifetime: { mode: "enrollment", assertCurrent: check },
    assertBuildCurrent: check,
    qualify: async (state, action, signal) => {
      check();
      if (state.document.scopedRules.records.length) return owner.qualify(state, action, signal);
      assert.ok(baseline && state.revision === initialRevision);
      same(action.authority.currentPolicyRevision, initialRevision);
      same(action, initialAction);
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
  let token: ScopedPermissionCapture | undefined;
  let query!: HumanInputQuery;
  let target!: NonNullable<ReturnType<ScopedPermissionCapturePort["snapshot"]>["target"]>;
  async function attest(capture: ScopedPermissionCapture, action: ActionEvidenceV1) {
    check();
    currentCredential(reviewer);
    assert.notEqual(reviewer.principalId, operator.principalId);
    const value = {
      version: 1,
      action,
      binding: bindingIdentity(active),
      actor: operator,
      reviewer: { actor: reviewer, credential: currentCredential(reviewer) },
      lease,
      revision: action.authority.currentPolicyRevision,
      expiresAt: action.expiresAt,
      plannedInterval: { offset: supervisor.offset, length: supervisor.length },
      executionReview: producer.invocation(capture).reviewProvenance(),
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
  const identity = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
  };
  const createOriginal = (captured: typeof snapshot): SyntheticReadOwner => ({
    signal: abort.signal,
    clock: systemClock,
    snapshot: () => captured,
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
    },
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
    await supervisor.phase(lane === "bootstrap" ? "bootstrap" : "save", async () => {
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
      lease = await stores.leases.acquire({ resource: `run:${runId}`, holder: randomUUID(), ttlMs: 60000 });
      const issued = await credentials.issue({
        principal: "controlled-test-operator",
        permissions: ["permissions.grant", "inputs.answer"],
        scope: { workflows: "*", runs: "all" },
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
              lifetime: "Original test lifetime, at most one minute",
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
        expiresAt: new Date(Date.now() + 55000).toISOString(),
      };
      const original = createOriginal(snapshot);
      service = createOwnedFileReadServiceForTest({
        enabled: true,
        owner: original,
        content: supervisor.content,
        maximumInvocations: 2,
        ...(lane === "connected"
          ? {
              controlledSupervisor: {
                installedEvidenceRef: supervisor.bootstrap!.evidenceRef,
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
          same(
            Buffer.from(bytes),
            Buffer.from(supervisor.content).subarray(supervisor.offset, supervisor.offset + supervisor.length),
          );
        },
      });
      const parameters = { resourceRef: service.resourceRef, offset: supervisor.offset, length: supervisor.length };
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
        delivered = askHumanInput({
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
            signal: abort.signal,
            withOwnership: async (work) => {
              const result = await leases.withOwnership(lease, work);
              await supervisor.settleOriginalDelivery?.();
              if (supervisor.fault === "lost-ack") throw Error("Controlled final acknowledgement lost");
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
        void delivered.catch(() => undefined);
        // The actual asked query is published asynchronously by the real input adapter.
        while (!query) await new Promise<void>((resolve) => setImmediate(resolve));
        target = { ...query.live!.identity, runId, stepRunId: query.stepRunId, requestId: query.requestId };
        producer = ownedReadScopedCapture({
          service,
          currentStore: () => managed.currentStore(),
          live,
          readCaptureFacts: (actor) => owner.readCaptureFacts(actor),
        });
        const captured = await producer.capture({
          actor: operator,
          target,
          query,
          onceOptionId: "once",
          denyOptionId: "deny",
          owner: original,
          parameters,
          policy: strict,
          evidence,
        });
        token = captured.token;
        invocation = captured.invocation;
      }
      initialAction = invocation.action;
      const baselineValue = {
        version: 1,
        originalAction: initialAction,
        capturedCeiling: {
          operation: "fs.readOwnedBytes",
          profileRef,
          resourceRef: service.resourceRef,
          maximumInvocations: 2,
        },
        binding: bindingIdentity(active),
        operator: { actor: operator, credential: currentCredential(operator) },
        lease,
        initialRevision,
        profileRef,
        installedEvidenceRef: supervisor.bootstrap?.evidenceRef ?? null,
        interval: { offset: supervisor.offset, length: supervisor.length },
        expiresAt: snapshot.expiresAt,
        rules: bootstrapRule ? [bootstrapRule] : [],
      };
      baseline = { ref: await put("controlled-baseline-v1", baselineValue), value: baselineValue };
      const evaluation = await invocation.evaluate(abort.signal);
      assert.equal(evaluation.phase, "final");
      if (evaluation.phase !== "final") throw Error("unexpected required execution review");
      if (lane === "bootstrap") {
        assert.equal(evaluation.verdict.outcome, "allow");
        if (evaluation.verdict.outcome !== "allow") throw Error("bootstrap not authorized");
        const permit = await invocation.authorize(invocation.action, evaluation.verdict, abort.signal);
        const receipt = await invocation.dispatch(permit, abort.signal);
        receipts.push(receipt);
        assert.equal(receipt.state, "completed");
        service.close();
        return;
      }
      assert.equal(evaluation.verdict.outcome, "require-human");
      same(invocation.reviewProvenance(), { result: "unavailable", sourceRefs: [] });
      await attest(token!, invocation.action);
      if (supervisor.fault === "review-proof") persistence.clear();
      if (supervisor.fault === "reviewer-revoked") await credentials.revoke(reviewer.credentialId!);
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
      const methods = auth.guard(scopedPermissionMethods(owner, identity, auth));
      call = (method, params) =>
        dispatch(
          JSON.stringify({ kind: "request", id: 1, method, params }),
          methods,
          bindPrincipal({ orcaVersion: "controlled-test", capabilities: [] }, authenticated.principal, {
            transport: "http",
          }),
        );
      const review = await call("scopedPermissions.review", { target: identity, input: target });
      assert.ok(review.ok, JSON.stringify(review));
      const handle = (review.result as { handle: string }).handle;
      const saved = await call("scopedPermissions.choose", { target: identity, handle, choice: "save" });
      assert.ok(saved.ok && (saved.result as { outcome: string }).outcome === "saved", JSON.stringify(saved));
      assert.equal(live.inspect(target), "pending");
      assert.equal((await stores.events.readTypes(runId, ["human.answered"])).length, 0);
      assert.equal(authorizationRefs.length, 0);
      const after = await policy.read();
      assert.equal(after.document.scopedRules.records.length, 1);
      if (supervisor.fault === "stale-revision")
        snapshot.authority = { ...snapshot.authority, currentPolicyRevision: initialRevision };
    });
    if (lane === "connected") {
      await supervisor.phase("human-read", async () => {
        if (supervisor.fault === "cancel") abort.abort();
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
      await supervisor.phase("rule-read", async () => {
        check();
        if (supervisor.fault === "revoke-rule") {
          const state = await policy.read(),
            record = state.document.scopedRules.records[0]!;
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
            credential: currentCredential(operator),
            lease,
            binding: bindingIdentity(active),
          };
          await put("controlled-rule-revocation-v1", proof, proofRef);
          const observed = await stores.execution.observe!(
            async () => same(await read(proofRef, "controlled-rule-revocation-v1"), proof),
            { maxRecords: 32 },
          );
          await observed.verifyUnchanged();
          await policy.revokeScopedRule(
            revoke,
            grantAuthority(authenticatedPrincipal, {
              readAuthorityRevision: async () => (await owner.readCaptureFacts(operator)).authorityRevision,
              verifyApproval: async (supplied, actor) => {
                same(supplied, command);
                same(actor, operator);
                same(await read(proofRef, "controlled-rule-revocation-v1"), proof);
                check();
                return { scopeEvidenceRef: proofRef };
              },
              assertCommitCurrent: (supplied, actor) => {
                same(supplied, command);
                same(actor, operator);
                observed.assertUnchanged!();
                return check();
              },
            }),
          );
          assert.equal((await policy.read()).document.scopedRules.records[0]!.rule.status, "revoked");
        }
        const facts = await owner.readCaptureFacts(operator); // Before immutable fresh action.
        const fresh = {
          ...structuredClone(snapshot),
          invocation: {
            ...snapshot.invocation,
            invocationId: "controlled-rule-invocation",
            turnId: "controlled-rule-turn",
          },
          authority: { ...snapshot.authority, currentPolicyRevision: facts.policyRevision },
        };
        const original = createOriginal(fresh);
        const offset = supervisor.offset + (supervisor.fault === "wrong-interval" ? 1 : 0);
        interval(offset, supervisor.length);
        const invocation = service!.capture(
          original,
          { resourceRef: service!.resourceRef, offset, length: supervisor.length },
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
    return {
      semanticRefs,
      authorizationRefs,
      receipts,
      initialRevision,
      finalRevision: (await policy.read()).revision,
    };
  } finally {
    service?.close();
    live.close();
    abort.abort();
    await delivered?.catch(() => undefined);
  }
}
