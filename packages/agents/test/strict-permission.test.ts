/** #702 inactive strict evaluation and exact retained-review regression; no live rule/provider writes. */
import { describe, expect, it, vi } from "vitest";
import {
  evaluateStrictPermission,
  selectStrictPermissionOption,
  type ActionEvidenceV1,
  type BoundReviewV1,
  type JudgeResultV1,
  type PendingReviewV1,
  type StrictPermissionState,
} from "@orca/core";
import { createStrictPolicyPort, decidePermission, resolvePermission, type StrictPolicyOptions } from "../src/index.js";
import {
  actionFixture,
  complete,
  NOW,
  registerReview,
  reviewState,
  ruleFixture,
  stateFixture,
} from "./strict-permission-fixtures.js";

function harness(initial = stateFixture()) {
  let state = initial;
  let time = NOW;
  const readCurrent = vi.fn(async () => state);
  const authorizeProjection = vi.fn(async () => {});
  const recordReview = vi.fn<StrictPolicyOptions["recordReview"]>(async () => "test:review-result");
  let id = 0;
  const port = createStrictPolicyPort({
    source: { readCurrent },
    authorizeProjection,
    recordReview,
    now: () => time,
    newReviewId: () => `review-${++id}`,
  });
  return {
    port,
    readCurrent,
    authorizeProjection,
    recordReview,
    setState: (next: StrictPermissionState) => {
      state = next;
    },
    setTime: (next: number) => {
      time = next;
    },
  };
}

describe("inactive typed policy", () => {
  it("automatically selects a qualified one-use choice under an existing approved rule", async () => {
    const { port, readCurrent } = harness();
    const action = actionFixture();
    const evaluation = await port.evaluate(action, new AbortController().signal);
    expect(evaluation.phase).toBe("final");
    if (evaluation.phase !== "final") throw new Error("unexpected review");
    expect(evaluation.verdict).toMatchObject({
      outcome: "allow",
      authorizedBy: { kind: "rule", ruleId: "rule-1", ruleRevision: "revision-1" },
      authority: action.authority,
    });
    expect(selectStrictPermissionOption(action, evaluation.verdict, NOW)).toBe("once");
    expect(readCurrent).toHaveBeenCalledTimes(1); // No human or judge callback exists in this path.
  });

  it.each(["currentAuthority", "capturedCeiling", "protectedAccess"] as const)(
    "keeps %s denial above an allow/delegation",
    (key) => {
      const state = { ...reviewState(), [key]: complete(false) };
      expect(evaluateStrictPermission(actionFixture(), state, NOW, "review")).toMatchObject({
        phase: "final",
        verdict: { outcome: "deny" },
      });
    },
  );

  it("keeps human ceilings above delegated fit eligibility", () => {
    const state = { ...reviewState(), mandatoryHuman: complete(true) };
    expect(evaluateStrictPermission(actionFixture(), state, NOW, "review")).toMatchObject({
      phase: "final",
      verdict: { outcome: "require-human" },
    });
  });

  it.each(["unknown", "absent"] as const)("blocks %s required policy despite a potential allow", (status) => {
    expect(
      evaluateStrictPermission(
        actionFixture(),
        { ...stateFixture(), rules: { state: status, reason: "missing/corrupt sidecar" } },
        NOW,
        "r",
      ),
    ).toMatchObject({ phase: "final", verdict: { outcome: "indeterminate", reason: "required-policy-unavailable" } });
  });

  it.each(["resources", "environmentAndCredentialRefs", "effectiveCwd", "relevantStateRefs"] as const)(
    "never asks a judge to fill unknown %s",
    (key) => {
      const action = { ...actionFixture(), [key]: { state: "unknown", reason: "not captured" } } as ActionEvidenceV1;
      expect(evaluateStrictPermission(action, reviewState(), NOW, "r")).toMatchObject({
        phase: "final",
        verdict: { outcome: "indeterminate" },
      });
    },
  );

  it("distinguishes inapplicable facts from unknown and known-empty resources", () => {
    const action = actionFixture();
    expect(evaluateStrictPermission({ ...action, resources: complete([]) }, stateFixture(), NOW, "r")).toMatchObject({
      phase: "final",
      verdict: { outcome: "allow" },
    });
    expect(
      evaluateStrictPermission({ ...action, stdin: { state: "unknown", reason: "lost" } }, stateFixture(), NOW, "r"),
    ).toMatchObject({ phase: "final", verdict: { outcome: "indeterminate" } });
  });

  it("requires raw duplicate-key validation when the selected profile requires it", () => {
    const state = reviewState();
    if (state.profile.state !== "complete") throw new Error("fixture");
    const profile = {
      ...state.profile.value,
      facts: { ...state.profile.value.facts, rawDuplicateKeyValidation: "complete" as const },
    };
    expect(evaluateStrictPermission(actionFixture(), { ...state, profile: complete(profile) }, NOW, "r")).toMatchObject(
      { verdict: { outcome: "indeterminate", reason: "required-fact:rawDuplicateKeyValidation" } },
    );
  });

  it("does not accept empty capture or qualification identities as evidence", () => {
    const action = actionFixture();
    expect(evaluateStrictPermission({ ...action, bindingRef: "" }, stateFixture(), NOW, "r")).toMatchObject({
      verdict: { outcome: "indeterminate", reason: "incomplete-action-identity" },
    });
    expect(
      evaluateStrictPermission(
        { ...action, coverage: { ...action.coverage, negotiatedHook: complete("") } },
        stateFixture(),
        NOW,
        "r",
      ),
    ).toMatchObject({ verdict: { outcome: "indeterminate", reason: "insufficient-coverage" } });
  });

  it.each(["revoked", "expired", "future", "revision"])("rechecks %s rules on a new invocation", async (change) => {
    const h = harness();
    expect(await h.port.evaluate(actionFixture(), new AbortController().signal)).toMatchObject({
      verdict: { outcome: "allow" },
    });
    const rule = {
      ...ruleFixture(),
      ...(change === "revoked" ? { status: "revoked" as const } : {}),
      ...(change === "expired" ? { expiresAt: new Date(NOW).toISOString() } : {}),
      ...(change === "future" ? { notBefore: new Date(NOW + 1).toISOString() } : {}),
    };
    h.setState({
      ...stateFixture(),
      rules: complete([rule]),
      ...(change === "revision"
        ? { authority: { ...actionFixture().authority, currentPolicyRevision: "policy-2" } }
        : {}),
    });
    expect(
      await h.port.evaluate(
        { ...actionFixture(), invocation: { ...actionFixture().invocation, invocationId: "second" } },
        new AbortController().signal,
      ),
    ).toMatchObject({ verdict: { outcome: change === "revoked" ? "deny" : "indeterminate" } });
  });

  it.each(["resource", "principal", "cwd", "environment", "operation"])("does not generalize changed %s", (change) => {
    const base = actionFixture();
    const action: ActionEvidenceV1 = {
      ...base,
      ...(change === "resource"
        ? { resources: complete([{ operation: "read", physicalTargetRef: "test:other" }]) }
        : {}),
      ...(change === "principal" ? { invocation: { ...base.invocation, principalRef: "test:other" } } : {}),
      ...(change === "cwd" ? { effectiveCwd: complete("test:other") } : {}),
      ...(change === "environment" ? { environmentAndCredentialRefs: complete(["test:new-credential"]) } : {}),
      ...(change === "operation" ? { operation: "write" } : {}),
    };
    expect(evaluateStrictPermission(action, stateFixture(), NOW, "r")).toMatchObject({
      phase: "final",
      verdict: { outcome: "require-human", reason: "no-approved-match" },
    });
  });

  it.each(["policy-per-ask", "observation", "unknown"] as const)(
    "cannot substitute %s for required execution coverage",
    (level) => {
      const action = actionFixture();
      expect(
        evaluateStrictPermission({ ...action, coverage: { ...action.coverage, level } }, stateFixture(), NOW, "r"),
      ).toMatchObject({ verdict: { outcome: "indeterminate", reason: "insufficient-coverage" } });
    },
  );

  it("retains legacy first-match/default and remembered-option behavior", async () => {
    const request = {
      sessionId: "session",
      options: [{ optionId: "always", kind: "allow_always" as const, name: "Always" }],
      toolCall: { toolCallId: "call", title: "fixture", kind: "read" as const },
    };
    const policy = {
      rules: [
        { match: {}, decision: "allow" as const },
        { match: {}, decision: "deny" as const },
      ],
      default: "ask" as const,
    };
    expect(decidePermission(policy, request)).toBe("allow");
    expect(decidePermission({ rules: [], default: "deny" }, request)).toBe("deny");
    expect(await resolvePermission(policy, { request })).toMatchObject({
      response: { outcome: { optionId: "always" } },
    });
  });
});

describe("non-widening native selection", () => {
  it.each([
    "remembered",
    "effect-unknown",
    "unqualified",
    "unbounded",
    "wrong-invocation",
    "expired",
    "longer-lived",
    "multiple-uses",
    "duplicate-id",
  ])("refuses %s choice", (change) => {
    const base = actionFixture();
    const choice = base.offeredChoices[0]!;
    if (choice.grantScopeAndLifetime.state !== "complete") throw new Error("fixture");
    const grant = choice.grantScopeAndLifetime.value;
    const modified = {
      ...choice,
      ...(change === "remembered" ? { kind: "allow_always" as const, effect: "remembered" as const } : {}),
      ...(change === "effect-unknown" ? { effect: "unknown" as const } : {}),
      ...(change === "unqualified"
        ? { qualificationRef: { state: "unknown" as const, reason: "spelling is not proof" } }
        : {}),
      grantScopeAndLifetime: complete({
        ...grant,
        ...(change === "unbounded" ? { expiresAt: null } : {}),
        ...(change === "wrong-invocation" ? { scopeRef: "other" } : {}),
        ...(change === "expired" ? { expiresAt: new Date(NOW).toISOString() } : {}),
        ...(change === "longer-lived" ? { expiresAt: new Date(NOW + 20_000).toISOString() } : {}),
        ...(change === "multiple-uses" ? { maximumUses: 2 } : {}),
      }),
    };
    const action = { ...base, offeredChoices: change === "duplicate-id" ? [modified, modified] : [modified] };
    const evaluation = evaluateStrictPermission(action, stateFixture(), NOW, "r");
    if (evaluation.phase !== "final") throw new Error("fixture");
    expect(selectStrictPermissionOption(action, evaluation.verdict, NOW)).toBeUndefined();
  });
});

describe("retained review registration and completion", () => {
  it.each(["refused", "empty-reference"])(
    "keeps %s review recording from returning allow or reopening completion",
    async (failure) => {
      const h = harness(reviewState());
      const registered = await registerReview(h.port);
      if (failure === "refused") h.recordReview.mockRejectedValueOnce(new Error("protected record unavailable"));
      else h.recordReview.mockResolvedValueOnce("");
      expect(await h.port.completeReview(registered.bound, registered.result, registered.signal)).toMatchObject({
        outcome: "indeterminate",
        reason: "review-record-unavailable",
      });
      await expect(h.port.completeReview(registered.bound, registered.result, registered.signal)).rejects.toMatchObject(
        { code: "RUN_STATE" },
      );
    },
  );

  it("rechecks original authority after review recording rather than treating recording as a reservation", async () => {
    const h = harness(reviewState());
    const registered = await registerReview(h.port);
    h.recordReview.mockImplementationOnce(async () => {
      h.setState({ ...reviewState(), currentAuthority: complete(false) });
      return "test:recorded-candidate";
    });
    expect(await h.port.completeReview(registered.bound, registered.result, registered.signal)).toMatchObject({
      outcome: "deny",
      reason: "current-authority",
    });
  });

  it("cannot return a fit allow after original cancellation during recording", async () => {
    const h = harness(reviewState());
    const original = new AbortController();
    const registered = await registerReview(h.port, original.signal);
    h.recordReview.mockImplementationOnce(async () => {
      original.abort();
      return "test:recorded-candidate";
    });
    expect(
      await h.port.completeReview(registered.bound, registered.result, new AbortController().signal),
    ).toMatchObject({ outcome: "indeterminate", reason: "review-expired" });
  });

  it("an unrelated cancelled evaluation cannot invalidate a retained live review", async () => {
    const h = harness(reviewState());
    const registered = await registerReview(h.port);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await h.port.evaluate(actionFixture(), cancelled.signal)).toMatchObject({
      verdict: { outcome: "indeterminate" },
    });
    expect(await h.port.completeReview(registered.bound, registered.result, registered.signal)).toMatchObject({
      outcome: "allow",
    });
  });

  it("requires explicit advisory fallback permission and rejects oversized reason codes", async () => {
    const state = reviewState("advisory");
    if (state.rules.state !== "complete") throw new Error("fixture");
    const rule = state.rules.value[0]!;
    const h = harness({
      ...state,
      rules: complete([{ ...rule, delegation: { ...rule.delegation!, allowWhenUnavailable: false } }]),
    });
    const unavailable = await registerReview(h.port);
    expect(
      await h.port.completeReview(
        unavailable.bound,
        { ...unavailable.result, execution: "unavailable", result: "indeterminate" },
        unavailable.signal,
      ),
    ).toMatchObject({ outcome: "indeterminate", reason: "judge-unavailable" });
    const oversized = await registerReview(h.port);
    expect(
      await h.port.completeReview(
        oversized.bound,
        { ...oversized.result, reasonCode: "x".repeat(129) },
        oversized.signal,
      ),
    ).toMatchObject({ outcome: "indeterminate", reason: "invalid-judge-result" });
  });

  it("requires explicit delegation and never treats an invented fit result as authority", async () => {
    const h = harness();
    const evaluation = await h.port.evaluate(actionFixture(), new AbortController().signal);
    expect(evaluation.phase).toBe("final");
    const other = await registerReview(harness(reviewState()).port);
    await expect(h.port.completeReview(other.bound, other.result, other.signal)).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    expect(h.authorizeProjection).not.toHaveBeenCalled();
  });

  it.each(["required", "advisory"] as const)("allows valid %s fit with exact rule attribution", async (requirement) => {
    const h = harness(reviewState(requirement));
    const { bound, result, signal } = await registerReview(h.port);
    expect(await h.port.completeReview(bound, result, signal)).toMatchObject({
      outcome: "allow",
      authorizedBy: { ruleRevision: "revision-1" },
      judgeResultRef: "test:review-result",
    });
    await expect(h.port.completeReview(bound, result, signal)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(h.authorizeProjection).toHaveBeenCalledTimes(1);
  });

  it.each(["required", "advisory"] as const)(
    "composes %s transport failure separately from evaluated abstention",
    async (requirement) => {
      const h = harness(reviewState(requirement));
      const unavailable = await registerReview(h.port);
      const verdict = await h.port.completeReview(
        unavailable.bound,
        { ...unavailable.result, execution: "unavailable", result: "indeterminate" },
        unavailable.signal,
      );
      expect(verdict.outcome).toBe(requirement === "advisory" ? "allow" : "indeterminate");
      if (requirement === "advisory") expect(verdict).toHaveProperty("judgeResultRef", "test:review-result");
      else expect(verdict).not.toHaveProperty("judgeResultRef");
      expect(h.recordReview.mock.calls[0]?.[2]).toMatchObject({ execution: "unavailable", result: "indeterminate" });
      const abstention = await registerReview(h.port);
      expect(
        await h.port.completeReview(
          abstention.bound,
          { ...abstention.result, result: "indeterminate" },
          abstention.signal,
        ),
      ).toMatchObject({ outcome: "require-human", reason: "judge-indeterminate" });
      const notFit = await registerReview(h.port);
      expect(
        await h.port.completeReview(notFit.bound, { ...notFit.result, result: "not-fit" }, notFit.signal),
      ).toMatchObject({ outcome: "deny", reason: "judge-not-fit" });
    },
  );

  it.each([
    "judgeConfigRef",
    "destinationPolicyRef",
    "projectionPolicyRevision",
    "requirement",
    "reviewId",
    "deadlineAt",
  ])("refuses changed request %s before projection authorization", async (field) => {
    const h = harness(reviewState());
    const evaluation = await h.port.evaluate(actionFixture(), new AbortController().signal);
    if (evaluation.phase !== "needs-review") throw new Error("fixture");
    const request = { ...evaluation.review, [field]: "changed", approvedProjection: actionFixture().original };
    await expect(
      h.port.bindReview(
        evaluation.pending,
        request as Parameters<typeof h.port.bindReview>[1],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(h.authorizeProjection).not.toHaveBeenCalled();
  });

  it.each([
    "reviewId",
    "actionBindingRef",
    "projectionBindingRef",
    "judgeVersion",
    "coverageId",
    "reasonCode",
    "execution",
    "result",
  ])("refuses wrong/malformed result %s even for advisory absence", async (field) => {
    const h = harness(reviewState("advisory"));
    const { bound, result, signal } = await registerReview(h.port);
    const changed = { ...result, [field]: field === "reasonCode" ? "" : "wrong" } as JudgeResultV1;
    expect(await h.port.completeReview(bound, changed, signal)).toMatchObject({
      outcome: "indeterminate",
      reason: "invalid-judge-result",
    });
  });

  it.each(["revoke", "human", "rule-revision", "config", "delegation-removed", "authority"])(
    "revalidates %s after judge wait",
    async (change) => {
      const initial = reviewState();
      const h = harness(initial);
      const { bound, result, signal } = await registerReview(h.port);
      if (initial.rules.state !== "complete") throw new Error("fixture");
      const rule = initial.rules.value[0]!;
      const { delegation, ...plain } = rule;
      h.setState({
        ...initial,
        ...(change === "revoke" ? { currentAuthority: complete(false) } : {}),
        ...(change === "human" ? { mandatoryHuman: complete(true) } : {}),
        ...(change === "authority" ? { authority: { ...initial.authority, revocationEpoch: "epoch-2" } } : {}),
        rules: complete([
          change === "delegation-removed"
            ? plain
            : {
                ...rule,
                ...(change === "rule-revision" ? { ruleRevision: "revision-2" } : {}),
                ...(change === "config" ? { delegation: { ...delegation!, judgeConfigRef: "judge-2" } } : {}),
              },
        ]),
      });
      const verdict = await h.port.completeReview(bound, result, signal);
      expect(verdict.outcome).toBe(
        change === "revoke" ? "deny" : change === "human" ? "require-human" : "indeterminate",
      );
    },
  );

  it("rejects forged/duplicate handles and cross-port completion", async () => {
    const h = harness(reviewState());
    const registered = await registerReview(h.port);
    await expect(h.port.bindReview({} as PendingReviewV1, registered.request, registered.signal)).rejects.toMatchObject(
      { code: "RUN_STATE" },
    );
    await expect(
      h.port.completeReview({} as BoundReviewV1, registered.result, registered.signal),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(
      harness(reviewState()).port.completeReview(registered.bound, registered.result, registered.signal),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("cancellation and finite deadlines invalidate pending and registered handles", async () => {
    const h = harness(reviewState());
    const abort = new AbortController();
    const registered = await registerReview(h.port, abort.signal);
    abort.abort();
    await expect(h.port.completeReview(registered.bound, registered.result, registered.signal)).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    const late = await registerReview(h.port);
    h.setTime(NOW + 4000);
    expect(await h.port.completeReview(late.bound, late.result, late.signal)).toMatchObject({
      outcome: "indeterminate",
      reason: "review-expired",
    });
  });

  it("fails closed on source/projection refusal without transport calls", async () => {
    const h = harness(reviewState());
    h.readCurrent.mockRejectedValueOnce(new Error("store unavailable"));
    expect(await h.port.evaluate(actionFixture(), new AbortController().signal)).toMatchObject({
      verdict: { outcome: "indeterminate" },
    });
    h.authorizeProjection.mockRejectedValueOnce(new Error("disclosure forbidden"));
    await expect(registerReview(h.port)).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("claims registration before awaiting projection authority and refuses changed current state", async () => {
    const h = harness(reviewState());
    let release!: () => void;
    let reachedResolve!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    h.authorizeProjection.mockImplementationOnce(async () => {
      reachedResolve();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const evaluation = await h.port.evaluate(actionFixture(), new AbortController().signal);
    if (evaluation.phase !== "needs-review") throw new Error("fixture");
    const request = { ...evaluation.review, approvedProjection: actionFixture().original };
    const first = h.port.bindReview(evaluation.pending, request, new AbortController().signal);
    const refused = expect(first).rejects.toMatchObject({ code: "RUN_STATE" });
    await reached;
    await expect(h.port.bindReview(evaluation.pending, request, new AbortController().signal)).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    h.setState({ ...reviewState(), currentAuthority: complete(false) });
    release();
    await refused;
    expect(h.authorizeProjection).toHaveBeenCalledTimes(1);
  });

  it("consumes bound completion before a competing completion or slow source read", async () => {
    const h = harness(reviewState());
    const registered = await registerReview(h.port);
    let release!: () => void;
    h.readCurrent.mockImplementationOnce(
      async () =>
        new Promise<StrictPermissionState>((resolve) => {
          release = () => resolve(reviewState());
        }),
    );
    const first = h.port.completeReview(registered.bound, registered.result, registered.signal);
    await expect(h.port.completeReview(registered.bound, registered.result, registered.signal)).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    release();
    expect(await first).toMatchObject({ outcome: "allow" });
  });

  it("retains exact action, request and result snapshots across awaited reads", async () => {
    const h = harness(reviewState());
    const action = actionFixture();
    const original = structuredClone(action);
    let release!: () => void;
    h.readCurrent.mockImplementationOnce(
      async () =>
        new Promise<StrictPermissionState>((resolve) => {
          release = () => resolve(reviewState());
        }),
    );
    const evaluating = h.port.evaluate(action, new AbortController().signal);
    Object.assign(action, { bindingRef: "substituted", operation: "write" });
    release();
    const evaluation = await evaluating;
    if (evaluation.phase !== "needs-review") throw new Error("fixture");
    expect(evaluation.review.actionBindingRef).toBe(original.bindingRef);
    await expect(
      h.port.bindReview(
        evaluation.pending,
        { ...evaluation.review, approvedProjection: original.original },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    const fresh = await h.port.evaluate(actionFixture(), new AbortController().signal);
    if (fresh.phase !== "needs-review") throw new Error("fixture");
    const request = { ...fresh.review, approvedProjection: original.original };
    const binding = h.port.bindReview(fresh.pending, request, new AbortController().signal);
    Object.assign(request, { judgeConfigRef: "substituted" });
    const bound = await binding;
    const result: JudgeResultV1 = {
      ...fresh.review,
      judgeVersion: "judge-1",
      projectionBindingRef: original.original.bindingRef,
      reasonCode: "fixture",
      execution: "evaluated",
      result: "fit",
    };
    const completing = h.port.completeReview(bound, result, new AbortController().signal);
    Object.assign(result, { result: "not-fit" });
    expect(await completing).toMatchObject({ outcome: "allow", actionBindingRef: original.bindingRef });
  });

  it("rejects changed composition even when a source incorrectly reuses its rule revision", async () => {
    const initial = reviewState("advisory");
    const h = harness(initial);
    const registered = await registerReview(h.port);
    if (initial.rules.state !== "complete") throw new Error("fixture");
    const rule = initial.rules.value[0]!;
    h.setState({
      ...initial,
      rules: complete([{ ...rule, delegation: { ...rule.delegation!, onNotFit: "require-human" } }]),
    });
    expect(await h.port.completeReview(registered.bound, registered.result, registered.signal)).toMatchObject({
      outcome: "indeterminate",
      reason: "review-eligibility-changed",
    });
  });

  it.each([null, {}, { authority: null }, { execution: "unavailable", result: "fit" }])(
    "settles malformed result %j conservatively",
    async (malformed) => {
      const h = harness(reviewState("advisory"));
      const registered = await registerReview(h.port);
      const result =
        malformed === null || Object.keys(malformed).length === 0 ? malformed : { ...registered.result, ...malformed };
      expect(await h.port.completeReview(registered.bound, result as JudgeResultV1, registered.signal)).toMatchObject({
        outcome: "indeterminate",
        reason: "invalid-judge-result",
      });
      await expect(h.port.completeReview(registered.bound, registered.result, registered.signal)).rejects.toMatchObject(
        { code: "RUN_STATE" },
      );
    },
  );

  it("bounds pending capacity, retains in-flight registration, and reclaims expiry", async () => {
    let time = NOW;
    let release!: () => void;
    let reachedResolve!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    const port = createStrictPolicyPort({
      source: { readCurrent: async () => reviewState() },
      maximumPending: 1,
      now: () => time,
      recordReview: async () => "test:review-result",
      authorizeProjection: async () => {
        reachedResolve();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const abort = new AbortController();
    const evaluation = await port.evaluate(actionFixture(), abort.signal);
    if (evaluation.phase !== "needs-review") throw new Error("fixture");
    const binding = port.bindReview(
      evaluation.pending,
      { ...evaluation.review, approvedProjection: actionFixture().original },
      abort.signal,
    );
    await reached;
    expect(await port.evaluate(actionFixture(), new AbortController().signal)).toMatchObject({
      verdict: { reason: "review-capacity" },
    });
    release();
    await binding;
    time = NOW + 4001;
    expect(await port.evaluate(actionFixture(), new AbortController().signal)).toMatchObject({ phase: "needs-review" });
  });
});

it("revalidates an exact completed review without new review identities, writes or deadline extension", async () => {
  const h = harness(reviewState());
  const r = await registerReview(h.port);
  const verdict = await h.port.completeReview(r.bound, r.result, r.signal);
  expect(Object.isFrozen(verdict)).toBe(true);
  const recorded = h.recordReview.mock.calls[0];
  for (let i = 0; i < 3; i++) {
    expect(await h.port.evaluate(r.action, r.signal)).toEqual({ phase: "final", verdict });
  }
  expect(h.recordReview).toHaveBeenCalledTimes(1);
  expect(h.authorizeProjection).toHaveBeenCalledTimes(1);
  expect(h.recordReview.mock.calls[0]).toBe(recorded);
  expect(await h.port.evaluate(structuredClone(r.action), r.signal)).toMatchObject({ phase: "needs-review" });
  h.setTime(NOW + 4000);
  expect(await h.port.evaluate(r.action, r.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
  h.setTime(NOW);
  expect(await h.port.evaluate(r.action, r.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
});

it.each(["action", "source-outage", "rule", "cancel"])(
  "terminally invalidates completed %s without reopening",
  async (change) => {
    const h = harness(reviewState());
    const r = await registerReview(h.port);
    await h.port.completeReview(r.bound, r.result, r.signal);
    const original = structuredClone(r.action);
    if (change === "action") Object.assign(r.action, { operation: "changed" });
    if (change === "source-outage") h.readCurrent.mockRejectedValueOnce(new Error("outage"));
    if (change === "rule") h.setState(reviewState("advisory"));
    if (change === "cancel") {
      const cancelled = new AbortController();
      cancelled.abort();
      await h.port.evaluate(r.action, cancelled.signal);
    }
    expect(await h.port.evaluate(r.action, r.signal)).toMatchObject({
      phase: "final",
      verdict: { outcome: "indeterminate" },
    });
    Object.assign(r.action, original);
    h.setState(reviewState());
    expect(await h.port.evaluate(r.action, r.signal)).toMatchObject({
      phase: "final",
      verdict: { outcome: "indeterminate" },
    });
    expect(h.recordReview).toHaveBeenCalledTimes(1);
  },
);

it("counts completing and completed registrations against capacity until original expiry", async () => {
  let time = NOW;
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const port = createStrictPolicyPort({
    source: { readCurrent: async () => reviewState() },
    maximumPending: 1,
    now: () => time,
    authorizeProjection: async () => {},
    recordReview: async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "record";
    },
  });
  const r = await registerReview(port);
  const completing = port.completeReview(r.bound, r.result, r.signal);
  await reached;
  expect(await port.evaluate(actionFixture(), r.signal)).toMatchObject({ verdict: { reason: "review-capacity" } });
  release();
  await completing;
  expect(await port.evaluate(actionFixture(), r.signal)).toMatchObject({ verdict: { reason: "review-capacity" } });
  time += 4001;
  expect(await port.evaluate(actionFixture(), r.signal)).toMatchObject({ phase: "needs-review" });
  expect(await port.evaluate(r.action, r.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
});

it("invalidates a settled review when an immutable profile reference is incorrectly reused", async () => {
  const initial = reviewState();
  const h = harness(initial);
  const r = await registerReview(h.port);
  await h.port.completeReview(r.bound, r.result, r.signal);
  if (initial.profile.state !== "complete") throw new Error("fixture");
  h.setState({
    ...initial,
    profile: complete({
      ...initial.profile.value,
      facts: { ...initial.profile.value.facts, resources: "complete-or-absent" },
    }),
  });
  expect(await h.port.evaluate(r.action, r.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
  h.setState(initial);
  expect(await h.port.evaluate(r.action, r.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
  expect(h.recordReview).toHaveBeenCalledTimes(1);
});

it("preserves ordinary final policy evaluation when settled review capacity is full", async () => {
  let current = reviewState();
  const port = createStrictPolicyPort({
    source: { readCurrent: async () => current },
    maximumPending: 1,
    now: () => NOW,
    authorizeProjection: async () => {},
    recordReview: async () => "record",
  });
  const r = await registerReview(port);
  await port.completeReview(r.bound, r.result, r.signal);
  current = stateFixture();
  expect(await port.evaluate(actionFixture(), r.signal)).toMatchObject({ verdict: { outcome: "allow" } });
  expect(await port.evaluate(r.action, r.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
});

it("cannot bind or record allow when concurrent evaluation terminalizes after final bind eligibility resolves", async () => {
  const h = harness(reviewState());
  const action = actionFixture();
  const signal = new AbortController().signal;
  const evaluation = await h.port.evaluate(action, signal);
  if (evaluation.phase !== "needs-review") throw new Error("fixture");
  const request = { ...evaluation.review, approvedProjection: action.original };
  let projectionEntered!: () => void;
  let releaseProjection!: () => void;
  const projectionReached = new Promise<void>((resolve) => {
    projectionEntered = resolve;
  });
  const projectionGate = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  h.authorizeProjection.mockImplementationOnce(async () => {
    projectionEntered();
    await projectionGate;
  });
  const binding = h.port.bindReview(evaluation.pending, request, signal);
  const bindingResult = Promise.allSettled([binding]);
  await projectionReached;

  let bindReadEntered!: () => void;
  let releaseBindRead!: (state: StrictPermissionState) => void;
  const bindReadReached = new Promise<void>((resolve) => {
    bindReadEntered = resolve;
  });
  const bindReadGate = new Promise<StrictPermissionState>((resolve) => {
    releaseBindRead = resolve;
  });
  h.readCurrent.mockImplementationOnce(async () => {
    bindReadEntered();
    return await bindReadGate;
  });
  releaseProjection();
  await bindReadReached;

  let outageReadEntered!: () => void;
  let releaseOutage!: () => void;
  const outageReached = new Promise<void>((resolve) => {
    outageReadEntered = resolve;
  });
  const outageGate = new Promise<void>((resolve) => {
    releaseOutage = resolve;
  });
  h.readCurrent.mockImplementationOnce(async () => {
    outageReadEntered();
    await outageGate;
    throw new Error("synthetic policy outage");
  });
  const invalidating = h.port.evaluate(action, signal);
  await outageReached;
  // Resolve both source barriers in this turn. The outage recheck queues its
  // terminal transition between bind's final eligible return and bind continuation.
  releaseOutage();
  releaseBindRead(reviewState());
  expect(await invalidating).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate", reason: "current-policy-unavailable" },
  });
  const [registered] = await bindingResult;
  if (!registered) throw new Error("missing binding outcome");
  const result: JudgeResultV1 = {
    ...evaluation.review,
    judgeVersion: "judge-1",
    projectionBindingRef: action.original.bindingRef,
    reasonCode: "synthetic-fit",
    execution: "evaluated",
    result: "fit",
  };
  const completed =
    registered.status === "fulfilled" ? await h.port.completeReview(registered.value, result, signal) : undefined;
  expect(completed?.outcome).not.toBe("allow");
  expect(h.recordReview).not.toHaveBeenCalled();
  expect(registered.status).toBe("rejected");
  expect(await h.port.evaluate(action, signal)).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate" },
  });
});

function stalledPolicyRead(h: ReturnType<typeof harness>) {
  let entered!: () => void;
  let resolve!: (state: StrictPermissionState) => void;
  let reject!: (error: Error) => void;
  const reached = new Promise<void>((ready) => {
    entered = ready;
  });
  const gate = new Promise<StrictPermissionState>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  h.readCurrent.mockImplementationOnce(async () => {
    entered();
    return await gate;
  });
  return { reached, recover: () => resolve(reviewState()), fail: () => reject(new Error("synthetic policy outage")) };
}

it("does not authorize projection after concurrent terminalization in the first bind eligibility gap", async () => {
  const h = harness(reviewState());
  const action = actionFixture();
  const signal = new AbortController().signal;
  const evaluation = await h.port.evaluate(action, signal);
  if (evaluation.phase !== "needs-review") throw new Error("fixture");
  const bindRead = stalledPolicyRead(h);
  const binding = Promise.allSettled([
    h.port.bindReview(evaluation.pending, { ...evaluation.review, approvedProjection: action.original }, signal),
  ]);
  await bindRead.reached;
  const outage = stalledPolicyRead(h);
  const invalidating = h.port.evaluate(action, signal);
  await outage.reached;
  outage.fail();
  bindRead.recover();
  expect(await invalidating).toMatchObject({ verdict: { outcome: "indeterminate" } });
  await binding;
  expect(h.authorizeProjection).not.toHaveBeenCalled();
  expect(h.recordReview).not.toHaveBeenCalled();
  expect(await h.port.evaluate(action, signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
});

it("does not record completion after concurrent terminalization in the completion eligibility gap", async () => {
  const h = harness(reviewState());
  const r = await registerReview(h.port);
  const completionRead = stalledPolicyRead(h);
  const completing = h.port.completeReview(r.bound, r.result, r.signal);
  await completionRead.reached;
  const outage = stalledPolicyRead(h);
  const invalidating = h.port.evaluate(r.action, r.signal);
  await outage.reached;
  outage.fail();
  completionRead.recover();
  expect(await invalidating).toMatchObject({ verdict: { outcome: "indeterminate" } });
  expect(await completing).toMatchObject({ outcome: "indeterminate" });
  expect(h.recordReview).not.toHaveBeenCalled();
  expect(await h.port.evaluate(r.action, r.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
});
