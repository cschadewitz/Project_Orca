/** Independent synthetic effects and owner-lifetime tests. No production policy/provider/confinement claim. */
import { describe, expect, it, vi } from "vitest";
import type {
  ActionEvidenceV1,
  OneUsePermitV1,
  PendingReviewV1,
  PolicyEvaluationV1,
  PolicyVerdictV1,
} from "@orca/core";
import { SyntheticReadFence } from "../src/synthetic-read-fence.js";
import { deferred, syntheticReadFixture } from "./fixtures/synthetic-read-fence.js";

async function permitted(f: Awaited<ReturnType<typeof syntheticReadFixture>>) {
  const action = f.fence.capture({ path: "/synthetic/exact.txt", line: 2, limit: 1 });
  const evaluated = await f.fence.evaluate(action, f.caller.signal);
  if (evaluated.phase !== "final" || evaluated.verdict.outcome !== "allow") throw new Error("Expected synthetic allow");
  const permit = await f.fence.authorize(action, evaluated.verdict, f.caller.signal);
  return { action, verdict: evaluated.verdict, permit };
}

describe("inactive one-use synthetic AgentHost read fence", () => {
  it("retains final parameters/owner before awaits and records authorization before dispatch/effect", async () => {
    const f = await syntheticReadFixture();
    const gate = deferred();
    f.policy.beforeEvaluate = () => gate.promise;
    const parameters = { path: "/synthetic/../exact.txt ", line: 2, limit: 1 };
    const result = f.fence.run(parameters, f.caller.signal);
    parameters.path = "/changed";
    parameters.line = 1;
    parameters.limit = 99;
    gate.resolve();
    const receipt = await result;
    expect(receipt.state).toBe("completed");
    expect(f.reads).toEqual(["/synthetic/../exact.txt "]);
    expect(f.contents).toEqual(["second"]);
    expect(f.trace).toEqual(["record-authorization", "dispatch-start", "effect-read"]);
    expect(f.policy.actions).toHaveLength(3);
    expect(f.policy.actions.every((a) => a === f.policy.actions[0])).toBe(true);
    const action = f.policy.actions[0]!;
    expect(Object.isFrozen(action.invocation)).toBe(true);
    expect(Object.isFrozen(action.coverage.unsupportedPaths)).toBe(true);
    expect(action.resources.state).toBe("unknown");
    expect(action.rawDuplicateKeyValidation.state).toBe("unknown");
    expect(action.coverage.level).toBe("observation");
    const payload = await f.store.getPayload("synthetic-run", action.dispatch.privateRef, "agent.update");
    if (!("update" in payload)) throw new Error("Wrong payload");
    const capture = JSON.parse(payload.update.text!) as { action: ActionEvidenceV1; bytes: string };
    expect(capture.action).toEqual(action);
    expect(JSON.parse(capture.bytes)).toEqual([
      "orca-synthetic-acp-read-v1",
      "/synthetic/../exact.txt ",
      ["number", "2"],
      ["number", "1"],
    ]);
    const observations = await f.fence.inspect(receipt, f.reader, f.caller.signal);
    expect(observations.recording.state).toBe("observed");
    expect(observations.dispatch.state).toBe("observed");
    expect(observations.effect).toEqual(f.observation("synthetic-host-read-counter"));
    expect(observations.delivery.state).toBe("unknown");
  });

  it.each(["deny", "require-human", "indeterminate"] as const)(
    "%s has no authorization record, dispatch or effect",
    async (outcome) => {
      const f = await syntheticReadFixture();
      f.policy.outcome = outcome;
      const receipt = await f.fence.run({ path: "/synthetic/file" }, f.caller.signal);
      expect(receipt.state).toBe("not-dispatched");
      expect(f.reads).toEqual([]);
      expect(f.state.authWrites).toBe(0);
      const observations = await f.fence.inspect(receipt, f.reader, f.caller.signal);
      expect(Object.values(observations).every((v) => v.state === "unknown")).toBe(true);
    },
  );

  it("retains review handles without cloning them and never schedules a judge or dispatch", async () => {
    const f = await syntheticReadFixture();
    const action = f.fence.capture({ path: "/synthetic/file" });
    const pending = Object.freeze({}) as PendingReviewV1;
    f.policy.response = {
      phase: "needs-review",
      pending,
      review: {
        version: 1,
        actionBindingRef: action.bindingRef,
        authority: action.authority,
        coverageId: action.coverage.coverageId,
        reviewId: "synthetic-review",
        delegation: { ruleId: "synthetic", ruleRevision: "1" },
        requirement: "required",
        projectionPolicyRevision: "1",
        destinationPolicyRef: "synthetic-none",
        judgeConfigRef: "synthetic-none",
        deadlineAt: action.expiresAt,
      },
    };
    const evaluated = await f.fence.evaluate(action, f.caller.signal);
    expect(evaluated.phase === "needs-review" && evaluated.pending === pending).toBe(true);
    expect((await f.fence.run({ path: "/synthetic/file" }, f.caller.signal)).state).toBe("not-dispatched");
    expect(f.reads).toEqual([]);
  });

  it("does not turn an unknown policy phase into review eligibility or an allow", async () => {
    const f = await syntheticReadFixture();
    f.policy.response = { phase: "unknown" } as unknown as PolicyEvaluationV1;
    const action = f.fence.capture({ path: "/synthetic/file" });
    await expect(f.fence.evaluate(action, f.caller.signal)).rejects.toThrow();
    expect(f.state.authWrites).toBe(0);
    expect(f.reads).toEqual([]);
  });

  it("coalesces identical concurrent calls and consumed-permit replays into one effect", async () => {
    const f = await syntheticReadFixture();
    const gate = deferred<string>();
    f.state.read = () => gate.promise;
    const results = Array.from({ length: 12 }, () =>
      f.fence.run({ path: "/synthetic/exact.txt", line: 2, limit: 1 }, f.caller.signal),
    );
    await vi.waitFor(() => expect(f.reads).toHaveLength(1));
    const p = await permitted(f);
    const duplicateDispatch = f.fence.dispatch(p.permit, f.caller.signal);
    gate.resolve("first\nsecond\nthird");
    const receipts = await Promise.all([...results, duplicateDispatch]);
    expect(receipts.every((r) => r === receipts[0])).toBe(true);
    expect(f.state.authWrites).toBe(1);
    expect(f.state.captureWrites).toBe(1);
    expect(f.reads).toHaveLength(1);
    expect(await f.fence.dispatch(p.permit, f.caller.signal)).toBe(receipts[0]);
    expect(f.reads).toHaveLength(1);
  });

  it("refuses caller-shaped/replaced actions, verdicts and permits without extra effects", async () => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    expect(() => f.fence.evaluate(structuredClone(p.action), f.caller.signal)).toThrow();
    await expect(f.fence.authorize(p.action, structuredClone(p.verdict), f.caller.signal)).rejects.toThrow();
    await expect(f.fence.dispatch(structuredClone(p.permit), f.caller.signal)).rejects.toThrow();
    await expect(f.fence.dispatch({} as OneUsePermitV1, f.caller.signal)).rejects.toThrow();
    expect(f.reads).toEqual([]);
    expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("completed");
  });

  it("retains the registered executor when an injection object is subsequently mutated", async () => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    const replacement = vi.fn(async () => {});
    f.executor.execute = replacement;
    expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("completed");
    expect(replacement).not.toHaveBeenCalled();
    expect(f.reads).toEqual(["/synthetic/exact.txt"]);
  });

  it("refuses a second coordinator registration for the same original lifetime/invocation", async () => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    const duplicate = new SyntheticReadFence({ ...f.owner }, f.executor, f.policy, f.evidence);
    expect(() => duplicate.capture({ path: "/synthetic/exact.txt", line: 2, limit: 1 })).toThrow();
    expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("completed");
    expect(f.reads).toHaveLength(1);
  });

  it.each([
    "currentPolicyRevision",
    "authorityRevision",
    "revocationEpoch",
    "leaseEpoch",
    "capturedGeneration",
  ] as const)("changed %s invalidates an unused permit", async (field) => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    f.state.snapshot = { ...f.state.snapshot, authority: { ...f.state.snapshot.authority, [field]: "changed" } };
    expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("not-dispatched");
    expect(f.reads).toEqual([]);
    expect(f.state.authWrites).toBe(0);
    expect(() => f.fence.capture({ path: "/synthetic/exact.txt", line: 2, limit: 1 })).toThrow();
  });

  it.each(["before-evaluation", "before-authorize", "before-dispatch", "during-record"] as const)(
    "revocation at %s prevents the synthetic read",
    async (when) => {
      const f = await syntheticReadFixture();
      if (when === "before-evaluation") {
        f.state.revoked = true;
        expect((await f.fence.run({ path: "/synthetic/file" }, f.caller.signal)).state).toBe("not-dispatched");
      } else if (when === "before-authorize") {
        const action = f.fence.capture({ path: "/synthetic/file" });
        const evaluated = await f.fence.evaluate(action, f.caller.signal);
        if (evaluated.phase !== "final" || evaluated.verdict.outcome !== "allow") throw new Error("Expected allow");
        f.state.revoked = true;
        await expect(f.fence.authorize(action, evaluated.verdict, f.caller.signal)).rejects.toThrow();
      } else {
        const p = await permitted(f);
        if (when === "before-dispatch") f.state.revoked = true;
        else
          f.state.afterRecord = async () => {
            f.state.revoked = true;
          };
        expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("not-dispatched");
      }
      expect(f.reads).toEqual([]);
    },
  );

  it.each(["initial", "dispatch"] as const)("policy outage at %s fails closed without I/O", async (when) => {
    const f = await syntheticReadFixture();
    if (when === "initial") {
      f.policy.unavailable = true;
      expect((await f.fence.run({ path: "/synthetic/file" }, f.caller.signal)).state).toBe("not-dispatched");
    } else {
      const p = await permitted(f);
      f.policy.unavailable = true;
      expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("not-dispatched");
    }
    expect(f.reads).toEqual([]);
    expect(f.state.authWrites).toBe(0);
  });

  it.each(["initial", "dispatch"] as const)(
    "current-authority outage at %s fails closed before writes/I/O",
    async (when) => {
      const f = await syntheticReadFixture();
      if (when === "initial") {
        f.state.authorityUnavailable = true;
        expect((await f.fence.run({ path: "/synthetic/file" }, f.caller.signal)).state).toBe("not-dispatched");
        expect(f.state.captureWrites).toBe(0);
        expect(f.policy.actions).toHaveLength(0);
      } else {
        const p = await permitted(f);
        f.state.authorityUnavailable = true;
        expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("not-dispatched");
      }
      expect(f.state.authWrites).toBe(0);
      expect(f.reads).toEqual([]);
    },
  );

  it.each(["deny", "rule-revision"] as const)("dispatch rereads policy and blocks changed %s", async (kind) => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    if (kind === "deny") f.policy.outcome = "deny";
    else f.policy.ruleRevision = "changed";
    expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("not-dispatched");
    expect(f.policy.actions).toHaveLength(3);
    expect(f.reads).toEqual([]);
  });

  it.each(["capture", "before", "after"] as const)(
    "required record failure at %s cannot authorize/retry an effect",
    async (when) => {
      const f = await syntheticReadFixture();
      if (when === "capture") f.state.captureFailure = true;
      else f.state.recordFailure = when;
      const first = await f.fence.run({ path: "/synthetic/file" }, f.caller.signal);
      f.state.captureFailure = false;
      f.state.recordFailure = "none";
      const retry = await f.fence.run({ path: "/synthetic/file" }, f.caller.signal);
      expect(first.state).toBe("not-dispatched");
      expect(retry.state).toBe("not-dispatched");
      expect(f.reads).toEqual([]);
      expect(f.state.captureWrites).toBe(1);
      expect(f.state.authWrites).toBe(when === "capture" ? 0 : 1);
      const observations = await f.fence.inspect(first, f.reader, f.caller.signal);
      expect(observations.recording.state).toBe(when === "after" ? "observed" : "unknown");
      expect(observations.dispatch.state).toBe("unknown");
      expect(observations.effect.state).toBe("unknown");
    },
  );

  it("changed parameters cannot reuse the original invocation or dispatch bytes", async () => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    for (const args of [
      { path: "/different", line: 2, limit: 1 },
      { path: "/synthetic/exact.txt", line: 1, limit: 1 },
      { path: "/synthetic/exact.txt", line: 2, limit: 2 },
    ])
      expect(() => f.fence.capture(args)).toThrow();
    expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("completed");
    expect(f.reads).toEqual(["/synthetic/exact.txt"]);
    expect(f.contents).toEqual(["second"]);
  });

  it.each(["invocation", "coverage", "cwd", "workspace"] as const)(
    "changed owner %s cannot reuse a permit",
    async (field) => {
      const f = await syntheticReadFixture();
      const p = await permitted(f);
      const original = f.state.snapshot;
      if (field === "invocation")
        f.state.snapshot = { ...original, invocation: { ...original.invocation, principalRef: "another-principal" } };
      if (field === "coverage")
        f.state.snapshot = { ...original, coverage: { ...original.coverage, adapterVersion: "changed" } };
      if (field === "cwd") f.state.snapshot = { ...original, cwd: "/different" };
      if (field === "workspace") f.state.snapshot = { ...original, workspaceRef: "different" };
      expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("not-dispatched");
      expect(f.reads).toEqual([]);
    },
  );

  it("lease expiry during authorization recording blocks the final consume/start step", async () => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    f.lease.ttlMs = 5;
    f.lease.guardedTtlMs = 5;
    f.state.afterRecord = async () => {
      f.clock.advance(6);
    };
    const receipt = await f.fence.dispatch(p.permit, f.caller.signal);
    expect(receipt.state).toBe("not-dispatched");
    expect(f.reads).toEqual([]);
    expect((await f.fence.inspect(receipt, f.reader, f.caller.signal)).recording.state).toBe("observed");
  });

  it("a synchronous executor failure has uncertain execution and no inferred effect", async () => {
    const f = await syntheticReadFixture();
    const failed = new SyntheticReadFence(
      f.owner,
      {
        ...f.executor,
        execute: () => {
          throw new Error("unknown executor entry outcome");
        },
      },
      f.policy,
      f.evidence,
    );
    const receipt = await failed.run({ path: "/synthetic/file" }, f.caller.signal);
    expect(receipt.state).toBe("execution-unknown");
    expect(f.reads).toEqual([]);
    expect((await failed.inspect(receipt, f.reader, f.caller.signal)).effect.state).toBe("unknown");
    expect(await failed.run({ path: "/synthetic/file" }, f.caller.signal)).toBe(receipt);
  });

  it.each(["before-dispatch", "during-record"] as const)(
    "changed relevant state at %s requires reevaluation",
    async (when) => {
      const f = await syntheticReadFixture();
      const p = await permitted(f);
      const change = () => {
        f.state.snapshot = { ...f.state.snapshot, relevantStateRefs: ["synthetic-file-r2"] };
      };
      if (when === "before-dispatch") change();
      else f.state.afterRecord = async () => change();
      const receipt = await f.fence.dispatch(p.permit, f.caller.signal);
      expect(receipt.state).toBe("not-dispatched");
      expect(f.reads).toEqual([]);
      expect((await f.fence.inspect(receipt, f.reader, f.caller.signal)).recording.state).toBe(
        when === "during-record" ? "observed" : "unknown",
      );
    },
  );

  it("an executor completion does not manufacture independent effect or delivery evidence", async () => {
    const f = await syntheticReadFixture();
    // This separate synthetic invocation deliberately has no I/O observer.
    f.state.snapshot = {
      ...f.state.snapshot,
      invocation: { ...f.state.snapshot.invocation, invocationId: "no-effect-fixture" },
    };
    const noRead = new SyntheticReadFence(f.owner, { ...f.executor, execute: async () => {} }, f.policy, f.evidence);
    const receipt = await noRead.run({ path: "/synthetic/file" }, f.caller.signal);
    expect(receipt.state).toBe("completed");
    expect(f.reads).toEqual([]);
    const observations = await noRead.inspect(receipt, f.reader, f.caller.signal);
    expect(observations.recording.state).toBe("observed");
    expect(observations.dispatch.state).toBe("unknown");
    expect(observations.effect.state).toBe("unknown");
    expect(observations.delivery.state).toBe("unknown");
  });

  it("a failed ownership acknowledgement after starting I/O is unknown and never replayed", async () => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    f.state.failOwnershipAfterCallback = true;
    const receipt = await f.fence.dispatch(p.permit, f.caller.signal);
    expect(receipt.state).toBe("execution-unknown");
    expect(f.reads).toHaveLength(1);
    expect(await f.fence.dispatch(p.permit, f.caller.signal)).toBe(receipt);
    expect(f.reads).toHaveLength(1);
  });

  it.each(["expired", "owner-ended", "lease-lost", "lease-expired", "caller-cancelled"] as const)(
    "%s invalidates unused dispatch",
    async (why) => {
      const f = await syntheticReadFixture();
      const p = await permitted(f);
      if (why === "expired") f.clock.advance(60_000);
      if (why === "owner-ended") f.abort.abort();
      if (why === "lease-lost") await f.leases.forceRelease(f.lease.resource);
      if (why === "lease-expired") {
        f.lease.ttlMs = 1;
        f.lease.guardedTtlMs = 1;
        f.clock.advance(2);
      }
      if (why === "caller-cancelled") f.caller.abort();
      expect((await f.fence.dispatch(p.permit, f.caller.signal)).state).toBe("not-dispatched");
      expect(f.reads).toEqual([]);
    },
  );

  it("cancellation stops waiting on an uncooperative policy and late replies cannot dispatch", async () => {
    const f = await syntheticReadFixture();
    const blocked = deferred();
    f.policy.beforeEvaluate = () => blocked.promise;
    const result = f.fence.run({ path: "/synthetic/file" }, f.caller.signal);
    await vi.waitFor(() => expect(f.policy.actions).toHaveLength(1));
    f.caller.abort();
    expect((await result).state).toBe("not-dispatched");
    blocked.resolve();
    await Promise.resolve();
    expect(f.reads).toEqual([]);
  });

  it.each(["policy", "executor"] as const)("the original deadline bounds an uncooperative %s", async (where) => {
    vi.useFakeTimers();
    try {
      const f = await syntheticReadFixture();
      const gate = deferred<string>();
      f.state.snapshot = { ...f.state.snapshot, expiresAt: new Date(f.clock.now() + 10).toISOString() };
      if (where === "policy")
        f.policy.beforeEvaluate = async () => {
          await gate.promise;
        };
      else f.state.read = () => gate.promise;
      const result = f.fence.run({ path: "/synthetic/file" }, f.caller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.policy.actions).toHaveLength(where === "policy" ? 1 : 3);
      f.clock.advance(10);
      await vi.advanceTimersByTimeAsync(10);
      const receipt = await result;
      expect(receipt.state).toBe(where === "policy" ? "not-dispatched" : "execution-unknown");
      expect(f.reads).toHaveLength(where === "policy" ? 0 : 1);
      gate.resolve("late response");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.reads).toHaveLength(where === "policy" ? 0 : 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancellation while queued under ownership cannot release a late callback", async () => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    const gate = deferred();
    const acquired = deferred();
    const held = f.leases.withOwnership(f.lease, async () => {
      acquired.resolve();
      await gate.promise;
    });
    await acquired.promise;
    const result = f.fence.dispatch(p.permit, f.caller.signal);
    f.caller.abort();
    expect((await result).state).toBe("not-dispatched");
    gate.resolve();
    await held;
    await f.leases.withOwnership(f.lease, async () => {});
    expect(f.reads).toEqual([]);
  });

  it.each(["reject-after-read", "cancel-after-read", "owner-lost-after-read"] as const)(
    "%s is execution-unknown and cannot replay",
    async (why) => {
      const f = await syntheticReadFixture();
      const gate = deferred<string>();
      f.state.read = () => gate.promise;
      const p = await permitted(f);
      const result = f.fence.dispatch(p.permit, f.caller.signal);
      await vi.waitFor(() => expect(f.reads).toHaveLength(1));
      // Prove the ownership mutex is free while the external read remains unresolved.
      await f.leases.withOwnership(f.lease, async () => {});
      if (why === "cancel-after-read") f.caller.abort();
      else if (why === "owner-lost-after-read") f.abort.abort();
      else gate.reject(new Error("synthetic read happened but response was lost"));
      const receipt = await result;
      expect(receipt.state).toBe("execution-unknown");
      expect(await f.fence.dispatch(p.permit, new AbortController().signal)).toBe(receipt);
      const observations = await f.fence.inspect(receipt, f.reader, new AbortController().signal);
      expect(observations.recording.state).toBe("observed");
      expect(observations.dispatch.state).toBe("observed");
      expect(observations.effect.state).toBe("observed");
      expect(observations.delivery.state).toBe("unknown");
      gate.resolve("late response");
      await Promise.resolve();
      expect(f.reads).toHaveLength(1);
    },
  );

  it("restart/reconnect cannot resurrect a permit; a fresh invocation receives a new capture/evaluation", async () => {
    const f = await syntheticReadFixture();
    const p = await permitted(f);
    const restarted = new SyntheticReadFence(f.owner, f.executor, f.policy, f.evidence);
    await expect(restarted.dispatch(p.permit, f.caller.signal)).rejects.toThrow();
    const next = await syntheticReadFixture();
    next.state.snapshot = {
      ...next.state.snapshot,
      invocation: { ...next.state.snapshot.invocation, invocationId: "fresh-invocation", attemptId: "fresh-attempt" },
    };
    const receipt = await next.fence.run({ path: "/synthetic/exact.txt", line: 2, limit: 1 }, next.caller.signal);
    expect(receipt.state).toBe("completed");
    expect(receipt.actionId).not.toBe(p.action.actionId);
    expect(next.policy.actions).toHaveLength(3);
  });

  it("receipt inspection rechecks current exact-run read authority and does not infer effects from delivery", async () => {
    const f = await syntheticReadFixture();
    f.policy.outcome = "deny";
    const receipt = await f.fence.run({ path: "/synthetic/file" }, f.caller.signal);
    const action = f.policy.actions[0]!;
    await f.observe("delivery", f.observation("synthetic-delivery-only"), action, receipt.protectedEvidenceRef);
    f.state.readAllowed = false;
    await expect(f.fence.inspect(receipt, f.reader, f.caller.signal)).rejects.toThrow();
    expect(f.state.evidenceReads).toBe(0);
    f.state.readAllowed = true;
    const observations = await f.fence.inspect(receipt, f.reader, f.caller.signal);
    expect(observations.delivery.state).toBe("observed");
    expect(observations.effect.state).toBe("unknown");
    expect(f.reads).toEqual([]);
    expect(Object.isFrozen(observations.delivery)).toBe(true);
    await expect(
      f.fence.inspect({ ...receipt, protectedEvidenceRef: "another-run" }, f.reader, f.caller.signal),
    ).rejects.toThrow();
    const reader = {
      authorizeRead: vi.fn(async () => {
        if (f.state.evidenceReads > 1) throw new Error("revoked during read");
      }),
    };
    await expect(f.fence.inspect(receipt, reader, f.caller.signal)).rejects.toThrow();
    expect(reader.authorizeRead).toHaveBeenCalledTimes(2);
  });

  it("accepts no unknown codec or unbounded/invalid original lifetime", async () => {
    const f = await syntheticReadFixture();
    for (const expiresAt of ["invalid", f.clock.isoNow(), new Date(f.clock.now() + 60_001).toISOString()]) {
      f.state.snapshot = { ...f.state.snapshot, expiresAt };
      expect(() => f.fence.capture({ path: "/synthetic/file" })).toThrow();
    }
    const invalid = new SyntheticReadFence(
      f.owner,
      { ...f.executor, codecVersion: "unknown" as "orca-synthetic-acp-read-v1" },
      f.policy,
      f.evidence,
    );
    expect(() => invalid.capture({ path: "/synthetic/file" })).toThrow();
    expect(f.reads).toEqual([]);
  });

  it("rejects policy allow with mismatched protected binding", async () => {
    const f = await syntheticReadFixture();
    const action = f.fence.capture({ path: "/synthetic/file" });
    const verdict: Extract<PolicyVerdictV1, { outcome: "allow" }> = {
      version: 1,
      outcome: "allow",
      actionBindingRef: "forged-binding",
      authority: action.authority,
      coverageId: action.coverage.coverageId,
      authorizedBy: { kind: "rule", ruleId: "synthetic", ruleRevision: "1" },
    };
    f.policy.response = { phase: "final", verdict };
    const evaluation = await f.fence.evaluate(action, f.caller.signal);
    if (evaluation.phase !== "final" || evaluation.verdict.outcome !== "allow")
      throw new Error("Expected synthetic allow");
    await expect(f.fence.authorize(action, evaluation.verdict, f.caller.signal)).rejects.toThrow();
    expect(f.reads).toEqual([]);
  });

  it.each(["version", "rule-attribution", "human-attribution"] as const)(
    "malformed policy %s cannot mint a permit",
    async (field) => {
      const f = await syntheticReadFixture();
      const action = f.fence.capture({ path: "/synthetic/file" });
      const base = {
        version: 1,
        outcome: "allow",
        actionBindingRef: action.bindingRef,
        authority: action.authority,
        coverageId: action.coverage.coverageId,
        authorizedBy: { kind: "rule", ruleId: "synthetic", ruleRevision: "1" },
      };
      const verdict = (
        field === "version"
          ? { ...base, version: 99 }
          : {
              ...base,
              authorizedBy:
                field === "rule-attribution"
                  ? { kind: "rule", ruleId: "synthetic", ruleRevision: "" }
                  : { kind: "human", acceptedAnswerRef: "" },
            }
      ) as Extract<PolicyVerdictV1, { outcome: "allow" }>;
      f.policy.response = { phase: "final", verdict };
      const evaluated = await f.fence.evaluate(action, f.caller.signal);
      if (evaluated.phase !== "final" || evaluated.verdict.outcome !== "allow")
        throw new Error("Expected malformed fixture");
      await expect(f.fence.authorize(action, evaluated.verdict, f.caller.signal)).rejects.toThrow();
      expect(f.reads).toEqual([]);
    },
  );
});
