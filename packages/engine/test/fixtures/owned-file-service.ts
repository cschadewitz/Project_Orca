/** Real policy/source/typed store/lease/fence + OS file. Synthetic boot, grant proofs and offline judge only. */
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ActionEvidenceV1, OneUsePermitV1, StrictPermissionRule, StrictPermissionState } from "@orca/core";
import { lapsed } from "@orca/store";
import {
  bindInactiveTypedSidecarOwner,
  createInactiveTypedSidecarStore,
  createStrictPermissionSource,
  createStrictPolicyPort,
  strictPermissionRuleRevision,
  type TypedCompatibilityMarker,
  type TypedSidecarSnapshot,
} from "@orca/agents";
import {
  createLocalReviewJudge,
  LOCAL_EVIDENCE_SCHEMA,
  LOCAL_ADVICE_SCHEMA,
} from "../../../agents/src/review-judge/adapter.js";
import { referenceMethod, offlineTransport } from "../../../agents/src/review-judge/offline.js";
import {
  createOwnedFileReadServiceForTest,
  type TrustedOwnedReadInvocation,
} from "../../src/owned-file-read-service.js";
import type { SyntheticReadOwner } from "../../src/synthetic-read-fence.js";
import { syntheticReadFixture } from "./synthetic-read-fence.js";
const complete = <T>(value: T) => ({ state: "complete" as const, value });
export async function ownedServiceFixture(maximumInvocations = 8) {
  const base = await syntheticReadFixture();
  const root = mkdtempSync(join(tmpdir(), "orca-service-policy-"));
  let marker: TypedCompatibilityMarker = {
    version: 1,
    workspaceRef: "test:workspace",
    sidecarRef: "test:sidecar",
    format: "orca-permissions-v2",
    minimumWriterContract: "orca-typed-sidecar-v1",
    rootBindingRef: "test:root",
    enrollmentRef: "test:enrollment",
    state: "enrollment-pending",
  };
  const ports = {
    file: join(root, "orca.permissions.json"),
    marker,
    checkCompatibility: async () => marker,
    assertCompatibilityCurrent: (expected: TypedCompatibilityMarker) => {
      if (!isDeepStrictEqual(marker, expected)) throw new Error("test managed owner changed");
      return undefined;
    },
    // Synthetic boot/protected proof assumption. This is NOT service/build qualification.
    qualify: async (_snapshot: TypedSidecarSnapshot, _action: ActionEvidenceV1, signal: AbortSignal) => {
      const originalMarker = structuredClone(marker);
      const originalAuthority = structuredClone(base.state.snapshot.authority);
      const assertCurrent = (): undefined => {
        signal.throwIfAborted();
        base.abort.signal.throwIfAborted();
        if (
          base.state.revoked ||
          base.state.authorityUnavailable ||
          lapsed(base.lease, base.clock.now()) ||
          !isDeepStrictEqual(marker, originalMarker) ||
          !isDeepStrictEqual(base.state.snapshot.authority, originalAuthority)
        )
          throw new Error("test qualification owner/authority/lease changed");
        return undefined;
      };
      assertCurrent();
      return {
        sourceRefs: ["test:protected-record"],
        scopeEvidenceRef: "test:scope",
        approvalRecordRef: "test:approval",
        authorityRevision: originalAuthority.authorityRevision,
        assertCurrent,
      };
    },
  };
  await createInactiveTypedSidecarStore(bindInactiveTypedSidecarOwner(ports)).initializeFresh();
  marker = { ...marker, state: "enrolled" };
  const store = createInactiveTypedSidecarStore(bindInactiveTypedSidecarOwner({ ...ports, marker }));
  const controls: {
    ceiling: boolean;
    response?: () => Promise<void>;
    observed?: () => Promise<void>;
    outage: boolean;
  } = {
    ceiling: true,
    outage: false,
  };
  const outputs: Uint8Array[] = [];
  const service = createOwnedFileReadServiceForTest({
    enabled: true,
    owner: base.owner,
    content: "synthetic private content",
    maximumInvocations,
    observed: async (action, ref) => {
      await controls.observed?.();
      await base.observe("effect", base.observation("real-os-read-returned"), action, ref);
    },
    respond: async (bytes) => {
      outputs.push(Uint8Array.from(bytes));
      await controls.response?.();
    },
  });
  const parameters = { resourceRef: service.resourceRef, offset: 0, length: 9 };
  const manifest = {
    ref: "test:judge",
    methodVersion: referenceMethod.version,
    transportVersion: offlineTransport.version,
    modelVersion: "none",
    promptVersion: "none",
    configVersion: referenceMethod.configVersion,
    inputSchema: LOCAL_EVIDENCE_SCHEMA,
    outputSchema: LOCAL_ADVICE_SCHEMA,
    destination: "offline:fixture",
    destinationPolicyRef: "test:destination",
    projectionPolicyRevision: "test:projection",
  } as const;
  const judge = createLocalReviewJudge({
    manifest,
    method: referenceMethod,
    transport: offlineTransport,
    limits: { maxPending: 1, maxCalls: 16, maxPayloadBytes: 2048, maxResponseBytes: 512, maxTimeoutMs: 100 },
  });
  let sequence = 0;
  async function binding(capturedCeiling = controls.ceiling) {
    const snapshot = {
      ...structuredClone(base.state.snapshot),
      invocation: { ...base.state.snapshot.invocation, invocationId: `owned-invocation-${++sequence}` },
      authority: { ...base.state.snapshot.authority, currentPolicyRevision: (await store.read()).revision },
    };
    const owner: SyntheticReadOwner = {
      ...base.owner,
      snapshot: () => snapshot,
      assertCurrent(action) {
        if (
          base.state.revoked ||
          base.state.authorityUnavailable ||
          lapsed(base.lease, base.clock.now()) ||
          !isDeepStrictEqual(action.invocation, snapshot.invocation) ||
          !isDeepStrictEqual(action.authority, snapshot.authority)
        )
          throw new Error("test original owner/lease/authority unavailable");
      },
    };
    const source = createStrictPermissionSource({
      capturedCeiling: complete(capturedCeiling),
      readBoundary: async (action) => {
        if (controls.outage) throw new Error("test source outage");
        const state: Omit<StrictPermissionState, "rules" | "capturedCeiling"> = {
          authority: { ...snapshot.authority, currentPolicyRevision: (await store.read()).revision },
          currentAuthority: complete(!base.state.revoked),
          protectedAccess: complete(true),
          coverageAndState: complete(isDeepStrictEqual(action.coverage, service.coverage)),
          mandatoryHuman: complete(false),
          profile: complete({
            profileRef: "orca-owned-file-read-v1",
            minimumCoverage: "policy-per-ask",
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
        return state;
      },
      readRules: store.readRules,
    });
    const policy = createStrictPolicyPort({
      source,
      now: () => base.clock.now(),
      authorizeProjection: async () => {},
      recordReview: async (action, request, result, verdict) => {
        const ref = `${action.bindingRef}:review`;
        await base.store.putPayload(ref, {
          type: "agent.update",
          runId: action.invocation.runId,
          payload: {
            stepRunId: action.invocation.stepRunId,
            sessionId: action.invocation.sessionId,
            update: { kind: "test-normalized-review", text: JSON.stringify({ request, result, verdict }) },
          },
        });
        return ref;
      },
    });
    return { owner, snapshot, policy, capture: () => service.capture(owner, parameters, policy, base.evidence) };
  }
  async function save(action: TrustedOwnedReadInvocation["action"], delegated = false) {
    if (
      action.resources.state !== "complete" ||
      action.effectiveCwd.state !== "complete" ||
      action.workspaceRef.state !== "complete"
    )
      throw new Error("test complete facts required");
    const draft: StrictPermissionRule = {
      ruleId: "test:exact-rule",
      ruleRevision: "pending",
      status: "approved",
      notBefore: new Date(base.clock.now() - 1000).toISOString(),
      expiresAt: action.expiresAt,
      decision: "allow",
      match: {
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
        environmentAndCredentialRefs: [],
      },
      ...(delegated
        ? {
            delegation: {
              requirement: "required",
              projectionPolicyRevision: manifest.projectionPolicyRevision,
              destinationPolicyRef: manifest.destinationPolicyRef,
              judgeConfigRef: manifest.ref,
              maximumDurationMs: 10_000,
              onNotFit: "deny",
              onIndeterminate: "require-human",
              allowWhenUnavailable: false,
            } as const,
          }
        : {}),
    };
    const rule = { ...draft, ruleRevision: strictPermissionRuleRevision(draft) };
    await store.createScopedRule(
      { rule, expectedRevision: (await store.read()).revision, approvalRecordRef: "test:approval" },
      {
        actor: { principalId: "test:operator", credentialId: "test:credential" },
        authorizeGrant: async () => base.state.snapshot.authority.authorityRevision,
        verifyApproval: async () => ({ scopeEvidenceRef: "test:scope" }),
        assertCommitCurrent: () => undefined,
      },
    );
    return rule;
  }
  async function allow(invocation: TrustedOwnedReadInvocation) {
    const signal = base.caller.signal;
    const evaluated = await invocation.evaluate(signal);
    if (evaluated.phase === "final") return evaluated.verdict;
    const payload = {
      version: 1 as const,
      bindingRef: "test:projection",
      schemaVersion: LOCAL_EVIDENCE_SCHEMA,
      content: JSON.stringify({
        schema: LOCAL_EVIDENCE_SCHEMA,
        applicability: "matches",
        context: "complete",
        injection: "absent",
      }),
    };
    const request = {
      ...evaluated.review,
      approvedProjection: {
        kind: "parsed-json" as const,
        codecVersion: payload.schemaVersion,
        bindingRef: payload.bindingRef,
        privateRef: "test:private-projection",
      },
    };
    const bound = await invocation.bindReview(evaluated.pending, request, signal);
    return invocation.completeReview(bound, await judge.assess(request, payload, signal), signal);
  }
  const permits = new WeakMap<TrustedOwnedReadInvocation, OneUsePermitV1>();
  async function run(invocation: TrustedOwnedReadInvocation) {
    const previous = permits.get(invocation);
    if (previous) return invocation.dispatch(previous, base.caller.signal);
    const verdict = await allow(invocation);
    if (verdict.outcome !== "allow") throw new Error(`test policy refused: ${verdict.outcome}`);
    const permit = await invocation.authorize(invocation.action, verdict, base.caller.signal);
    permits.set(invocation, permit);
    return invocation.dispatch(permit, base.caller.signal);
  }
  return {
    base: {
      state: base.state,
      owner: base.owner,
      clock: base.clock,
      caller: base.caller,
      evidence: base.evidence,
      policy: base.policy,
      reader: base.reader,
      abort: base.abort,
      store: base.store,
    },
    service,
    store,
    binding,
    parameters,
    controls,
    outputs,
    save,
    allow,
    run,
    dispose: () => {
      service.close();
      base.abort.abort();
      base.caller.abort();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
