/** Explicitly synthetic policy/owner/record adapters. No rule evaluator, providers or real filesystem reads. */
import { isDeepStrictEqual } from "node:util";
import {
  FakeClock,
  type ActionEvidenceV1,
  type PolicyEvaluationV1,
  type PolicyPortV1,
  type PolicyVerdictV1,
} from "@orca/core";
import { InMemoryExecutionStore, InMemoryLeaseStore, lapsed } from "@orca/store";
import type { AgentHost } from "../../../agents/src/host.js";
import { SyntheticReadBoundary, type SyntheticTextRead } from "../../../agents/src/synthetic-read-boundary.js";
import {
  SyntheticReadFence,
  type FenceObservation,
  type FenceObservations,
  type FenceReadAuthority,
  type SyntheticFenceEvidence,
  type SyntheticReadOwner,
  type SyntheticReadOwnerSnapshot,
} from "../../src/synthetic-read-fence.js";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Programmable outcomes only; intentionally implements none of #702's policy predicates/rules. */
export class SyntheticPolicy implements PolicyPortV1 {
  readonly version = 1 as const;
  readonly actions: ActionEvidenceV1[] = [];
  outcome: PolicyVerdictV1["outcome"] = "allow";
  unavailable = false;
  ruleRevision = "synthetic-rule-r1";
  beforeEvaluate?: (action: ActionEvidenceV1) => Promise<void>;
  response?: PolicyEvaluationV1;

  async evaluate(action: ActionEvidenceV1, _signal: AbortSignal): Promise<PolicyEvaluationV1> {
    this.actions.push(action);
    await this.beforeEvaluate?.(action);
    if (this.unavailable) throw new Error("synthetic policy outage");
    if (this.response) return this.response;
    const binding = {
      version: 1 as const,
      actionBindingRef: action.bindingRef,
      authority: action.authority,
      coverageId: action.coverage.coverageId,
    };
    return {
      phase: "final",
      verdict:
        this.outcome === "allow"
          ? {
              ...binding,
              outcome: "allow",
              authorizedBy: { kind: "rule", ruleId: "synthetic-only", ruleRevision: this.ruleRevision },
            }
          : { ...binding, outcome: this.outcome, reason: "synthetic programmed outcome" },
    };
  }

  bindReview(): ReturnType<PolicyPortV1["bindReview"]> {
    return Promise.reject(new Error("Synthetic fixture does not schedule judges"));
  }
  completeReview(): ReturnType<PolicyPortV1["completeReview"]> {
    return Promise.reject(new Error("Synthetic fixture does not schedule judges"));
  }
}

export async function syntheticReadFixture() {
  const clock = new FakeClock();
  const abort = new AbortController();
  const caller = new AbortController();
  const leases = new InMemoryLeaseStore(clock);
  const lease = await leases.acquire({ resource: "run:synthetic-run", holder: "synthetic-owner", ttlMs: 60_000 });
  const store = new InMemoryExecutionStore();
  await store.putInputs({
    runId: "synthetic-run",
    workflowId: "synthetic-workflow",
    workflowVersion: "1",
    vars: {},
    sensitiveNames: [],
    secrets: [],
  });
  const state: {
    snapshot: SyntheticReadOwnerSnapshot;
    revoked: boolean;
    authorityUnavailable: boolean;
    readAllowed: boolean;
    evidenceReads: number;
    authWrites: number;
    captureWrites: number;
    recordFailure: "none" | "before" | "after";
    captureFailure: boolean;
    failOwnershipAfterCallback: boolean;
    afterRecord?: () => Promise<void>;
    read?: (path: string) => Promise<string>;
    currentEvidenceRef?: string;
    currentAction?: ActionEvidenceV1;
  } = {
    snapshot: {
      invocation: {
        instanceId: "synthetic-boot",
        sessionId: "synthetic-session",
        turnId: "synthetic-turn",
        invocationId: "synthetic-invocation",
        runId: "synthetic-run",
        rootRunId: "synthetic-run",
        stepRunId: "synthetic-step",
        attemptId: "synthetic-attempt",
        agentId: "synthetic-agent",
        hostId: "synthetic-host",
        runnerId: "synthetic-runner",
        principalRef: "synthetic-principal",
      },
      authority: {
        capturedGeneration: "synthetic-generation",
        currentPolicyRevision: "synthetic-policy-r1",
        authorityRevision: "synthetic-authority-r1",
        revocationEpoch: "0",
        leaseEpoch: lease.guardedId ?? lease.acquiredAt,
      },
      coverage: {
        version: 1,
        coverageId: "synthetic-source-only",
        boundaryId: "synthetic-acp-read",
        provider: "synthetic",
        providerVersion: "1",
        adapterVersion: "1",
        tool: "fs.readTextFile",
        toolSchemaVersion: "1",
        hostId: "synthetic-host",
        platform: "synthetic-memory",
        level: "observation",
        evidence: {
          sourceRefs: ["packages/agents/src/acp-session.ts"],
          installedRefs: [],
          independentlyObservedEffects: false,
        },
        negotiatedHook: { state: "absent", reason: "No hook" },
        protectedConfiguration: { state: "unknown", reason: "Inactive fixture" },
        guaranteedEffects: [],
        unsupportedPaths: ["native-shell", "descendants", "independent-mcp", "physical-filesystem"],
      },
      cwd: "/synthetic",
      workspaceRef: "synthetic-workspace",
      relevantStateRefs: ["synthetic-file-r1"],
      expiresAt: new Date(clock.now() + 60_000).toISOString(),
    },
    revoked: false,
    authorityUnavailable: false,
    readAllowed: true,
    evidenceReads: 0,
    authWrites: 0,
    captureWrites: 0,
    recordFailure: "none",
    captureFailure: false,
    failOwnershipAfterCallback: false,
  };
  const trace: string[] = [];
  const reads: string[] = [];
  const contents: string[] = [];
  // This is an adapter over the existing protected payload store, not a new durable ledger.
  // Each observation is independently written once; missing records remain unknown.
  const observedStages = new Set<string>();
  const observe = async (
    stage: keyof FenceObservations,
    value: FenceObservation,
    action = state.currentAction!,
    ref = state.currentEvidenceRef!,
  ): Promise<void> => {
    const key = `${ref}:${stage}`;
    await store.putPayload(key, {
      type: "agent.update",
      runId: action.invocation.runId,
      payload: {
        stepRunId: action.invocation.stepRunId,
        sessionId: action.invocation.sessionId,
        update: { kind: "synthetic-fence-observation", text: JSON.stringify(value) },
      },
    });
    observedStages.add(key);
  };
  const observation = (sourceRef: string): FenceObservation => ({
    state: "observed",
    sourceRef,
    observedAt: clock.isoNow(),
  });
  const evidence: SyntheticFenceEvidence = {
    async recordCapture(action, bytes) {
      state.captureWrites++;
      if (state.captureFailure) throw new Error("synthetic capture write failure");
      await store.putPayload(action.original.privateRef, {
        type: "agent.update",
        runId: action.invocation.runId,
        payload: {
          stepRunId: action.invocation.stepRunId,
          sessionId: action.invocation.sessionId,
          update: { kind: "synthetic-retained-capture", text: JSON.stringify({ action, bytes }) },
        },
      });
    },
    async recordAuthorization(action, verdict, ref) {
      state.authWrites++;
      trace.push("record-authorization");
      if (state.recordFailure === "before") throw new Error("synthetic required record unavailable");
      await store.putPayload(ref, {
        type: "agent.update",
        runId: action.invocation.runId,
        payload: {
          stepRunId: action.invocation.stepRunId,
          sessionId: action.invocation.sessionId,
          update: { kind: "synthetic-authorization", text: JSON.stringify({ action, verdict }) },
        },
      });
      await observe("recording", observation(ref), action, ref);
      await state.afterRecord?.();
      if (state.recordFailure === "after") throw new Error("synthetic uncertain append");
    },
    async read(action, ref) {
      state.evidenceReads++;
      const result: Partial<Record<keyof FenceObservations, FenceObservation>> = {};
      for (const stage of ["recording", "delivery", "dispatch", "effect"] as const) {
        const key = `${ref}:${stage}`;
        if (!observedStages.has(key)) continue;
        const payload = await store.getPayload(action.invocation.runId, key, "agent.update");
        if (!("update" in payload)) throw new Error("Wrong synthetic payload");
        result[stage] = JSON.parse(payload.update.text ?? "null") as FenceObservation;
      }
      return result;
    },
  };
  const fs: AgentHost["fs"] = {
    async readFile(path) {
      reads.push(path);
      trace.push("effect-read");
      // Effect evidence originates at the independent injected filesystem, not the fence receipt.
      await observe("effect", observation("synthetic-host-read-counter"));
      return state.read ? state.read(path) : "first\nsecond\nthird";
    },
    writeFile: () => Promise.reject(new Error("read-only synthetic filesystem")),
    exists: () => Promise.resolve(false),
    existsMany: (paths) => Promise.resolve(paths.map(() => false)),
    mkdirp: () => Promise.reject(new Error("read-only synthetic filesystem")),
  };
  const boundary = new SyntheticReadBoundary({ fs });
  const owner: SyntheticReadOwner = {
    clock,
    signal: abort.signal,
    snapshot: () => state.snapshot,
    withOwnership: (operation) =>
      leases.withOwnership(lease, async () => {
        const result = await operation();
        if (state.failOwnershipAfterCallback) throw new Error("synthetic uncertain ownership release");
        return result;
      }),
    authorize: async () => {
      if (state.revoked) throw new Error("synthetic revoked principal");
      if (state.authorityUnavailable) throw new Error("synthetic current authority outage");
    },
    assertCurrent(action) {
      if (
        state.revoked ||
        lapsed(lease, clock.now()) ||
        !isDeepStrictEqual(action.invocation, state.snapshot.invocation)
      )
        throw new Error("synthetic original authority/lease unavailable");
    },
  };
  const policy = new SyntheticPolicy();
  const executor = {
    codecVersion: boundary.codecVersion,
    capture: (parameters: SyntheticTextRead) => boundary.capture(parameters),
    encode: (capture: ReturnType<SyntheticReadBoundary["capture"]>) => boundary.encode(capture),
    execute(
      capture: ReturnType<SyntheticReadBoundary["capture"]>,
      action: ActionEvidenceV1,
      ref: string,
    ): Promise<void> {
      state.currentAction = action;
      state.currentEvidenceRef = ref;
      trace.push("dispatch-start");
      // The synthetic I/O starts synchronously. Its observation-store awaits and completion
      // are outside the ownership mutex; this records dispatch independently of receipt state.
      const read = boundary.read(capture);
      const started = observe("dispatch", observation("synthetic-executor-entry"));
      return Promise.all([read, started]).then(([content]) => {
        contents.push(content);
      });
    },
  };
  const fence = new SyntheticReadFence(owner, executor, policy, evidence);
  const reader: FenceReadAuthority = {
    authorizeRead: async (invocation) => {
      if (!state.readAllowed || invocation.runId !== "synthetic-run")
        throw new Error("synthetic exact-run read denied");
    },
  };
  return {
    fence,
    owner,
    executor,
    evidence,
    reader,
    policy,
    clock,
    abort,
    caller,
    state,
    store,
    leases,
    lease,
    boundary,
    trace,
    reads,
    contents,
    observe,
    observation,
  };
}
