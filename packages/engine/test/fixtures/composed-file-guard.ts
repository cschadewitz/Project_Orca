/** Actual inactive policy + bounded judge + owned fence. Real Linux read; synthetic records, authority and offline transport. */
import type {
  ApprovedJudgePayloadV1,
  JudgeRequestV1,
  JudgeResultV1,
  PolicyVerdictV1,
  StrictPermissionState,
} from "@orca/core";
import { createStrictPolicyPort } from "../../../agents/src/strict-permission.js";
import {
  createLocalReviewJudge,
  LOCAL_EVIDENCE_SCHEMA,
  LOCAL_ADVICE_SCHEMA,
  type LocalJudgeManifest,
  type LocalJudgeTransport,
} from "../../../agents/src/review-judge/adapter.js";
import { offlineTransport, referenceMethod } from "../../../agents/src/review-judge/offline.js";
import { createDisposableFileReadForTest } from "../../src/disposable-file-read.js";
import { SyntheticReadFence } from "../../src/synthetic-read-fence.js";
import { syntheticReadFixture } from "./synthetic-read-fence.js";
export { barrier } from "./composed-memory-guard.js";

const complete = <T>(value: T) => ({ state: "complete" as const, value });
export async function composedFileGuard(
  mode: "disabled" | "required" | "advisory" = "required",
  decision: "allow" | "deny" | "require-human" = "allow",
) {
  const base = await syntheticReadFixture();
  // Tests align the adapter wall clock to FakeClock and advance both explicitly.
  const counters = {
    judgeCalls: 0,
    projections: 0,
    reviewWrites: 0,
    reviewAcks: 0,
    delivered: 0,
    callbackAcks: 0,
    responseStarts: 0,
    responseAcks: 0,
  };
  const controls: {
    transport?: () => Promise<string>;
    reviewRecord?: () => Promise<void>;
    response?: () => Promise<void>;
    projection?: () => Promise<void>;
    failReview?: boolean;
    sourceRead?: () => Promise<void>;
    observed?: () => Promise<void>;
    staleSourceReply?: boolean;
    authorize?: () => Promise<void>;
    ownership?: () => Promise<void>;
    captureRecord?: () => Promise<void>;
    policy?: StrictPermissionState;
  } = {};
  const contents: Uint8Array[] = [];
  const reviews: { request: JudgeRequestV1; result: JudgeResultV1; verdict: PolicyVerdictV1 }[] = [];
  const manifest: LocalJudgeManifest = {
    ref: "file-fixture:judge/config-v1",
    methodVersion: referenceMethod.version,
    transportVersion: offlineTransport.version,
    modelVersion: "none",
    promptVersion: "none",
    configVersion: referenceMethod.configVersion,
    inputSchema: LOCAL_EVIDENCE_SCHEMA,
    outputSchema: LOCAL_ADVICE_SCHEMA,
    destination: "offline:fixture",
    destinationPolicyRef: "file-fixture:destination-v1",
    projectionPolicyRevision: "file-fixture:projection-v1",
  };
  let initialPolicy!: StrictPermissionState;
  const file = createDisposableFileReadForTest({
    enabled: true,
    owner: {
      ...base.owner,
      authorize: async (action, signal) => {
        await controls.authorize?.();
        await base.owner.authorize(action, signal);
      },
      withOwnership: async (operation) => {
        await controls.ownership?.();
        return base.owner.withOwnership(operation);
      },
    },
    content: "synthetic private content",
    policy(resource, snapshot) {
      initialPolicy = {
        authority: snapshot.authority,
        currentAuthority: complete(true),
        capturedCeiling: complete(true),
        protectedAccess: complete(true),
        coverageAndState: complete(true),
        mandatoryHuman: complete(false),
        profile: complete({
          profileRef: "orca-disposable-file-read-v1",
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
        rules: complete([
          {
            ruleId: "file-fixture:approved-rule",
            ruleRevision: "1",
            status: "approved",
            notBefore: new Date(base.clock.now() - 1000).toISOString(),
            expiresAt: new Date(base.clock.now() + 60_000).toISOString(),
            decision,
            match: {
              principalRef: snapshot.invocation.principalRef,
              agentId: snapshot.invocation.agentId,
              hostId: snapshot.invocation.hostId,
              runnerId: snapshot.invocation.runnerId,
              operation: "fs.readOwnedBytes",
              profileRef: "orca-disposable-file-read-v1",
              coverageId: snapshot.coverage.coverageId,
              effectiveCwd: snapshot.cwd,
              workspaceRef: snapshot.workspaceRef,
              resources: [resource],
              environmentAndCredentialRefs: [],
            },
            ...(mode === "disabled"
              ? {}
              : {
                  delegation: {
                    requirement: mode,
                    projectionPolicyRevision: manifest.projectionPolicyRevision,
                    destinationPolicyRef: manifest.destinationPolicyRef,
                    judgeConfigRef: manifest.ref,
                    maximumDurationMs: 10_000,
                    onNotFit: "deny",
                    onIndeterminate: "require-human",
                    allowWhenUnavailable: mode === "advisory",
                  },
                }),
          },
        ]),
      };
      return initialPolicy;
    },
    observed: async (action, ref) => {
      await controls.observed?.();
      await base.observe("dispatch", base.observation("owned-file-executor-entry"), action, ref);
      await base.observe("effect", base.observation("real-os-read-returned"), action, ref);
    },
    respond: async (bytes) => {
      counters.responseStarts++;
      contents.push(Uint8Array.from(bytes)); // Independent synthetic response start; acknowledgement may be lost.
      await controls.response?.();
      counters.responseAcks++;
    },
  });
  const policy = createStrictPolicyPort({
    source: {
      readCurrent: async (action, signal) => {
        const current = await file.source.readCurrent(action, signal);
        await controls.sourceRead?.();
        return controls.policy ?? (controls.staleSourceReply ? current : await file.source.readCurrent(action, signal));
      },
    },
    now: () => base.clock.now(),
    maximumPending: 8,
    authorizeProjection: async () => {
      counters.projections++;
      await controls.projection?.();
    },
    recordReview: async (action, request, result, verdict) => {
      counters.reviewWrites++;
      const ref = `file-fixture:review:${counters.reviewWrites}`;
      reviews.push({ request, result, verdict });
      await base.store.putPayload(ref, {
        type: "agent.update",
        runId: action.invocation.runId,
        payload: {
          stepRunId: action.invocation.stepRunId,
          sessionId: action.invocation.sessionId,
          update: { kind: "synthetic-normalized-review", text: JSON.stringify({ request, result, verdict }) },
        },
      });
      await controls.reviewRecord?.();
      if (controls.failReview) throw new Error("synthetic uncertain review record");
      counters.reviewAcks++;
      return ref;
    },
  });
  const transport: LocalJudgeTransport = {
    ...offlineTransport,
    invoke: async (method, payload, signal) => {
      counters.judgeCalls++;
      return controls.transport ? await controls.transport() : await offlineTransport.invoke(method, payload, signal);
    },
  };
  const judge = createLocalReviewJudge({
    manifest,
    method: referenceMethod,
    transport,
    limits: { maxPending: 1, maxCalls: 8, maxPayloadBytes: 2048, maxResponseBytes: 512, maxTimeoutMs: 100 },
  });
  const evidence = {
    ...base.evidence,
    recordCapture: async (action: Parameters<typeof base.evidence.recordCapture>[0], bytes: string) => {
      await controls.captureRecord?.();
      await base.evidence.recordCapture(action, bytes);
    },
  };
  const fence = new SyntheticReadFence(file.owner, file.executor, policy, evidence);
  const parameters = { resourceRef: file.resourceRef, offset: 0, length: 9 };
  const action = fence.capture(parameters);
  const payload: ApprovedJudgePayloadV1 = {
    version: 1,
    bindingRef: "file-fixture:projection-binding",
    schemaVersion: LOCAL_EVIDENCE_SCHEMA,
    content: JSON.stringify({
      schema: LOCAL_EVIDENCE_SCHEMA,
      applicability: "matches",
      context: "complete",
      injection: "absent",
    }),
  };
  async function register() {
    const evaluation = await fence.evaluate(action, base.caller.signal);
    if (evaluation.phase !== "needs-review") throw new Error("Expected actual delegated eligibility");
    const request: JudgeRequestV1 = {
      ...evaluation.review,
      approvedProjection: {
        kind: "parsed-json",
        codecVersion: payload.schemaVersion,
        bindingRef: payload.bindingRef,
        privateRef: "file-fixture:private-projection",
      },
    };
    const bound = await fence.bindReview(evaluation.pending, request, base.caller.signal);
    return { request, bound };
  }
  async function reviewed() {
    const registered = await register();
    const result = await judge.assess(registered.request, payload, base.caller.signal);
    const verdict = await fence.completeReview(registered.bound, result, base.caller.signal);
    return { ...registered, result, verdict };
  }
  async function run() {
    let evaluated = await fence.evaluate(action, base.caller.signal);
    if (evaluated.phase === "needs-review") {
      const { verdict } = await reviewed();
      evaluated = { phase: "final", verdict };
    }
    if (evaluated.verdict.outcome !== "allow") return fence.run(parameters, base.caller.signal);
    return fence.dispatch(await fence.authorize(action, evaluated.verdict, base.caller.signal), base.caller.signal);
  }
  async function deliver(receipt: Awaited<ReturnType<typeof run>>, acknowledged = true) {
    counters.delivered++;
    if (!acknowledged) return;
    counters.callbackAcks++;
    await base.observe(
      "delivery",
      base.observation("independent-fake-response-ack"),
      action,
      receipt.protectedEvidenceRef,
    );
  }
  const recording = {
    get authWrites() {
      return base.state.authWrites;
    },
    set afterRecord(callback: () => Promise<void>) {
      base.state.afterRecord = callback;
    },
    set recordFailure(value: "none" | "before" | "after") {
      base.state.recordFailure = value;
    },
  };
  Object.seal(recording);
  return {
    clock: base.clock,
    caller: base.caller,
    state: recording,
    evidence,
    reader: base.reader,
    store: base.store,
    fence,
    file,
    base: { state: base.state, owner: base.owner, evidence: base.evidence, abort: base.abort },
    policy,
    judge,
    action,
    parameters,
    payload,
    register,
    reviewed,
    run,
    deliver,
    controls,
    counters,
    contents,
    reviews,
    initialPolicy,
    manifest,
    dispose: () => {
      file.dispose();
      base.abort.abort();
      base.caller.abort();
    },
  };
}
