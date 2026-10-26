/** #706 executable subsets: actual inactive policy, bounded local judge and owned private-memory I/O. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_ADVICE_SCHEMA } from "../../agents/src/review-judge/adapter.js";
import { SyntheticReadFence } from "../src/synthetic-read-fence.js";
import { syntheticReadFixture } from "./fixtures/synthetic-read-fence.js";
import { barrier, composedMemoryGuard } from "./fixtures/composed-memory-guard.js";

const fixtures: Awaited<ReturnType<typeof composedMemoryGuard>>[] = [];
async function fixture(
  mode: "disabled" | "required" | "advisory" = "required",
  decision: "allow" | "deny" | "require-human" = "allow",
) {
  const f = await composedMemoryGuard(mode, decision);
  fixtures.push(f);
  return f;
}
const frame = () =>
  JSON.stringify({
    schema: LOCAL_ADVICE_SCHEMA,
    recommendation: "allow",
    rationaleCode: "fixture-match",
    uncertainty: false,
  });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(Date.UTC(2026, 0, 1));
});
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  vi.useRealTimers();
});
async function permitted(f: Awaited<ReturnType<typeof fixture>>) {
  const evaluated = await f.fence.evaluate(f.action, f.caller.signal);
  const verdict = evaluated.phase === "final" ? evaluated.verdict : (await f.reviewed()).verdict;
  if (verdict.outcome !== "allow") throw new Error("Expected actual policy allow");
  return f.fence.authorize(f.action, verdict, f.caller.signal);
}

describe("actual disposable memory composition", () => {
  it.each(["disabled", "required", "advisory"] as const)(
    "E706-disabled/advisory: %s approved match executes without a human prompt",
    async (mode) => {
      const f = await fixture(mode);
      const receipt = await f.run();
      expect(receipt.state).toBe("completed");
      expect(f.counters.judgeCalls).toBe(mode === "disabled" ? 0 : 1);
      expect(f.counters.reviewWrites).toBe(mode === "disabled" ? 0 : 1);
      expect(f.state.authWrites).toBe(1);
      expect(f.memory.executorEntries).toBe(1);
      expect(f.memory.observedReads).toBe(1);
      expect(f.counters.callbackAcks).toBe(0);
      let observations = await f.fence.inspect(receipt, f.reader, f.caller.signal);
      expect(observations.recording.state).toBe("observed");
      expect(observations.dispatch.state).toBe("observed");
      expect(observations.effect.state).toBe("observed");
      expect(observations.delivery.state).toBe("unknown");
      await f.deliver(receipt);
      observations = await f.fence.inspect(receipt, f.reader, f.caller.signal);
      expect(observations.delivery.state).toBe("observed");
      expect(f.counters.callbackAcks).toBe(1);
      expect(f.action.coverage).toMatchObject({
        level: "policy-per-ask",
        evidence: { installedRefs: [], independentlyObservedEffects: false },
      });
      expect(f.action.resources).toMatchObject({ state: "complete", value: [{ targetKind: "disposable-memory" }] });
      expect(f.action.rawDuplicateKeyValidation.state).toBe("absent");
      expect(() => Object.assign(f.memory.snapshot().authority, { capturedGeneration: "forged" })).toThrow();
    },
  );

  it.each(["required", "advisory"] as const)(
    "E706-advisory: %s transport unavailability follows the actual approved composition",
    async (mode) => {
      const f = await fixture(mode);
      f.controls.transport = async () => {
        throw new Error("synthetic unavailable");
      };
      const receipt = await f.run();
      expect(receipt.state).toBe(mode === "advisory" ? "completed" : "not-dispatched");
      expect(f.reviews[0]?.result).toMatchObject({ execution: "unavailable", result: "indeterminate" });
      expect(f.memory.observedReads).toBe(mode === "advisory" ? 1 : 0);
      expect(f.counters.reviewWrites).toBe(1);
    },
  );

  it.each(["malformed", "oversized", "contradictory"])(
    "E706-malformed/contradictory: required %s frame cannot dispatch",
    async (kind) => {
      const f = await fixture();
      f.controls.transport = async () =>
        kind === "malformed"
          ? "{"
          : kind === "oversized"
            ? "x".repeat(513)
            : JSON.stringify({
                schema: LOCAL_ADVICE_SCHEMA,
                recommendation: "allow",
                rationaleCode: "fixture-mismatch",
                uncertainty: true,
              });
      expect((await f.run()).state).toBe("not-dispatched");
      expect(f.memory.executorEntries).toBe(0);
      expect(f.memory.observedReads).toBe(0);
      expect(f.state.authWrites).toBe(0);
      expect(f.reviews[0]?.result.execution).toBe("unavailable");
    },
  );

  it("E706-required-timeout: late fit cannot turn required timeout into a new dispatch", async () => {
    const f = await fixture();
    const gate = barrier();
    f.controls.transport = async () => {
      await gate.wait();
      return frame();
    };
    const running = f.run();
    await gate.entered;
    await vi.advanceTimersByTimeAsync(100);
    expect((await running).state).toBe("not-dispatched");
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.run()).state).toBe("not-dispatched");
    expect(f.counters.judgeCalls).toBe(1);
    expect(f.counters.reviewWrites).toBe(1);
    expect(f.memory.observedReads).toBe(0);
  });

  it.each(["judge", "review-record", "authorization-record"] as const)(
    "E706-model-config-change/policy-epoch/authority-race: mutations while %s awaits stop I/O",
    async (where) => {
      // Each subcase starts with a distinct original lifetime and retained memory capability.
      for (const change of [
        "rule",
        "human",
        "profile",
        "authority",
        "policy",
        "projection",
        "model",
        "config",
        "coverage",
        "resource",
        "cwd",
        "policy-availability",
        "authority-availability",
      ] as const) {
        const f = await fixture();
        const gate = barrier();
        if (where === "judge")
          f.controls.transport = async () => {
            await gate.wait();
            return frame();
          };
        if (where === "review-record") f.controls.reviewRecord = gate.wait;
        if (where === "authorization-record") f.state.afterRecord = gate.wait;
        const operation =
          where === "authorization-record" ? f.fence.dispatch(await permitted(f), f.caller.signal) : f.run();
        const settled = Promise.allSettled([operation]);
        await gate.entered;
        const policy = structuredClone(f.initialPolicy);
        if (policy.rules.state !== "complete" || policy.profile.state !== "complete") throw new Error("fixture");
        const rule = policy.rules.value[0]!;
        if (change === "rule")
          f.memory.replace({
            policy: { ...policy, rules: { state: "complete", value: [{ ...rule, status: "revoked" }] } },
          });
        if (change === "human")
          f.memory.replace({ policy: { ...policy, mandatoryHuman: { state: "complete", value: true } } });
        if (change === "profile")
          f.memory.replace({
            policy: {
              ...policy,
              profile: {
                state: "complete",
                value: {
                  ...policy.profile.value,
                  facts: { ...policy.profile.value.facts, rawDuplicateKeyValidation: "complete" },
                },
              },
            },
          });
        if (change === "policy")
          f.memory.replace({ authority: { ...f.memory.snapshot().authority, currentPolicyRevision: "policy-r2" } });
        if (change === "authority")
          f.memory.replace({ authority: { ...f.memory.snapshot().authority, revocationEpoch: "revoked" } });
        if (["projection", "model", "config"].includes(change))
          f.memory.replace({
            policy: {
              ...policy,
              rules: {
                state: "complete",
                value: [
                  {
                    ...rule,
                    delegation: {
                      ...rule.delegation!,
                      ...(change === "projection"
                        ? { projectionPolicyRevision: "changed" }
                        : { judgeConfigRef: `changed-${change}` }),
                    },
                  },
                ],
              },
            },
          });
        if (change === "coverage")
          f.memory.replace({
            coverage: {
              ...f.memory.snapshot().coverage,
              negotiatedHook: { state: "absent", reason: "synthetic hook removed" },
            },
          });
        if (change === "resource")
          f.memory.replace({
            memory: { resourceRef: "private-cell", content: "replaced cell" },
          });
        if (change === "cwd") f.memory.replace({ cwd: "/changed" });
        if (change === "policy-availability") {
          f.memory.replace({ policyAvailable: false });
          f.memory.replace({ policyAvailable: true });
        }
        if (change === "authority-availability") {
          f.memory.replace({ authorityAvailable: false });
          f.memory.replace({ authorityAvailable: true });
        }
        gate.release();
        await settled;
        expect(f.memory.executorEntries, `${where}/${change}`).toBe(0);
        expect(f.memory.observedReads, `${where}/${change}`).toBe(0);
        expect(f.state.authWrites).toBe(where === "authorization-record" ? 1 : 0);
        expect(f.counters.judgeCalls).toBe(1);
      }
    },
  );

  it("E706-policy-outage: generation distinguishes down/up even when all policy values return", async () => {
    const f = await fixture();
    const permit = await permitted(f);
    const before = f.memory.snapshot().authority.capturedGeneration;
    f.memory.replace({ policyAvailable: false });
    f.memory.replace({ policyAvailable: true });
    expect(f.memory.snapshot().authority.capturedGeneration).not.toBe(before);
    const receipt = await f.fence.dispatch(permit, f.caller.signal);
    expect(receipt.state).toBe("not-dispatched");
    expect(await f.fence.dispatch(permit, f.caller.signal)).toBe(receipt);
    expect(f.memory.observedReads).toBe(0);
  });

  it("E706-identical-concurrent/duplicate-answer: one completion and one permit consume once", async () => {
    const f = await fixture();
    const registered = await f.register();
    const result = await f.judge.assess(registered.request, f.payload, f.caller.signal);
    const completions = await Promise.allSettled([
      f.fence.completeReview(registered.bound, result, f.caller.signal),
      f.fence.completeReview(registered.bound, result, f.caller.signal),
    ]);
    expect(completions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.counters.reviewWrites).toBe(1);
    const permit = await permitted(f);
    const [one, two] = await Promise.all([
      f.fence.dispatch(permit, f.caller.signal),
      f.fence.dispatch(permit, f.caller.signal),
    ]);
    expect(one).toBe(two);
    expect(f.state.authWrites).toBe(1);
    expect(f.memory.executorEntries).toBe(1);
    expect(f.memory.observedReads).toBe(1);
  });

  it.each(["cancel", "expiry"])(
    "E706-cancel-before-dispatch/expiry: original %s invalidates a pending judgment",
    async (why) => {
      const f = await fixture();
      const gate = barrier();
      f.controls.transport = async () => {
        await gate.wait();
        return frame();
      };
      const operation = Promise.allSettled([f.run()]);
      await gate.entered;
      if (why === "cancel") f.caller.abort();
      else {
        f.clock.advance(60_000);
        await vi.advanceTimersByTimeAsync(60_000);
      }
      gate.release();
      await operation;
      expect(f.memory.observedReads).toBe(0);
      expect(f.state.authWrites).toBe(0);
    },
  );

  it.each(["review-record", "authorization-record", "response", "delivery"])(
    "E706-uncertain-record/unknown-effect/lost-delivery-ack: separate %s uncertainty and refuse replay",
    async (where) => {
      const f = await fixture();
      if (where === "review-record") f.controls.failReview = true;
      if (where === "authorization-record") f.state.recordFailure = "after";
      if (where === "response")
        f.controls.response = async () => {
          throw new Error("response lost after read");
        };
      const permit = where === "review-record" ? undefined : await permitted(f);
      const receipt = permit ? await f.fence.dispatch(permit, f.caller.signal) : await f.run();
      expect(receipt.state).toBe(
        where === "response" ? "execution-unknown" : where === "delivery" ? "completed" : "not-dispatched",
      );
      if (where === "delivery") await f.deliver(receipt, false);
      const observations = await f.fence.inspect(receipt, f.reader, f.caller.signal);
      expect(observations.delivery.state).toBe("unknown");
      expect(f.counters.callbackAcks).toBe(0);
      expect(f.memory.observedReads).toBe(where === "response" || where === "delivery" ? 1 : 0);
      if (permit) expect(await f.fence.dispatch(permit, f.caller.signal)).toBe(receipt);
      else expect((await f.run()).state).toBe("not-dispatched");
      expect(f.counters.reviewWrites).toBe(1);
      expect(f.memory.observedReads).toBe(where === "response" || where === "delivery" ? 1 : 0);
    },
  );
});

it("E706-final-resources: same-name replacement and restored content never reuse a resource revision", async () => {
  const f = await fixture("disabled");
  const permit = await permitted(f);
  const original = f.action.resources;
  f.memory.replace({ memory: { resourceRef: "private-cell", content: "changed" } });
  const changed = f.memory.snapshot().relevantStateRefs;
  f.memory.replace({
    memory: { resourceRef: "private-cell", content: "synthetic private content" },
  });
  expect(f.memory.snapshot().relevantStateRefs).not.toEqual(changed);
  expect(f.memory.snapshot().relevantStateRefs).not.toEqual(f.action.relevantStateRefs);
  expect((await f.fence.dispatch(permit, f.caller.signal)).state).toBe("not-dispatched");
  expect(original).toEqual(f.action.resources);
  expect(f.memory.observedReads).toBe(0);
});

it("E706-restart/final-arguments: a replacement owner or forged/copy capture cannot inherit a private capability", async () => {
  const first = await fixture("disabled");
  const second = await fixture("disabled");
  expect(first.action.resources).not.toEqual(second.action.resources);
  const permit = await permitted(first);
  await expect(second.fence.dispatch(permit, second.caller.signal)).rejects.toThrow();
  const evaluation = await first.fence.evaluate(first.action, first.caller.signal);
  if (evaluation.phase !== "final" || evaluation.verdict.outcome !== "allow") throw new Error("fixture");
  const verdict = evaluation.verdict;
  expect(() => first.fence.authorize(structuredClone(first.action), verdict, first.caller.signal)).toThrow();
  await expect(first.fence.authorize(first.action, { ...evaluation.verdict }, first.caller.signal)).rejects.toThrow();
  expect(() => first.memory.executor.encode({})).toThrow();
  expect(() => first.fence.capture({ resourceRef: "replacement-cell" })).toThrow();
  expect(first.memory.observedReads).toBe(0);
  expect(second.memory.observedReads).toBe(0);
});

it("E706-model-config-change: copied actions receive no retained completion and changed original objects remain terminal", async () => {
  const f = await fixture();
  await f.reviewed();
  const copied = structuredClone(f.action);
  expect(await f.policy.evaluate(copied, f.caller.signal)).toMatchObject({ phase: "needs-review" });
  const mutable = structuredClone(f.action);
  const eligibility = await f.policy.evaluate(mutable, f.caller.signal);
  if (eligibility.phase !== "needs-review") throw new Error("fixture");
  Object.assign(mutable, { operation: "changed" });
  expect(await f.policy.evaluate(mutable, f.caller.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
  Object.assign(mutable, f.action);
  expect(await f.policy.evaluate(mutable, f.caller.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
  expect(f.counters.judgeCalls).toBe(1);
  expect(f.counters.reviewWrites).toBe(1);
  const empty = structuredClone(f.action);
  Object.assign(empty, { resources: { state: "complete", value: [] } });
  expect(await f.policy.evaluate(empty, f.caller.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
});

it.each(["generation", "cancel", "saturation"] as const)(
  "stalled completed rechecks: %s racing concurrent reevaluation cannot resurrect the decision",
  async (change) => {
    const f = await fixture();
    await f.reviewed();
    const gate = barrier();
    let entered = 0;
    f.controls.sourceRead = async () => {
      entered++;
      await gate.wait();
    };
    const count = change === "saturation" ? 8 : 2;
    const rechecks = Array.from({ length: count }, () => f.policy.evaluate(f.action, f.caller.signal));
    await vi.waitFor(() => expect(entered).toBe(count));
    if (change === "generation") {
      f.memory.replace({ policyAvailable: false });
      f.memory.replace({ policyAvailable: true });
    }
    if (change === "cancel") f.caller.abort();
    if (change === "saturation")
      expect(await f.policy.evaluate(f.action, f.caller.signal)).toMatchObject({
        verdict: { outcome: "indeterminate", reason: "review-capacity" },
      });
    gate.release();
    await Promise.all(rechecks);
    delete f.controls.sourceRead;
    expect(await f.policy.evaluate(f.action, f.caller.signal)).toMatchObject({ verdict: { outcome: "indeterminate" } });
    expect(f.counters.judgeCalls).toBe(1);
    expect(f.counters.reviewWrites).toBe(1);
    expect(f.memory.observedReads).toBe(0);
  },
);

it("final synchronous owner generation check blocks even a stalled old source snapshot returning the identical allow", async () => {
  const f = await fixture();
  const permit = await permitted(f);
  const gate = barrier();
  f.controls.staleSourceReply = true;
  f.state.afterRecord = async () => {
    f.controls.sourceRead = gate.wait;
  };
  const dispatching = f.fence.dispatch(permit, f.caller.signal);
  await gate.entered;
  f.memory.replace({ policyAvailable: false });
  f.memory.replace({ policyAvailable: true });
  gate.release();
  const receipt = await dispatching;
  expect(receipt.state).toBe("not-dispatched");
  expect(f.state.authWrites).toBe(1);
  expect(f.memory.executorEntries).toBe(0);
  expect(f.memory.observedReads).toBe(0);
  expect(await f.fence.dispatch(permit, f.caller.signal)).toBe(receipt);
});

it.each(["deny", "require-human"] as const)(
  "E706-advisory: deterministic %s does not schedule advisory advice or execution",
  async (decision) => {
    const f = await fixture("advisory", decision);
    expect((await f.run()).state).toBe("not-dispatched");
    expect(f.counters.judgeCalls).toBe(0);
    expect(f.counters.reviewWrites).toBe(0);
    expect(f.state.authWrites).toBe(0);
    expect(f.memory.executorEntries).toBe(0);
    expect(f.memory.observedReads).toBe(0);
  },
);

it("memory capture admits only exact structured data fields; backing snapshots cannot be mutated externally", async () => {
  const f = await fixture("disabled");
  const extra = { ...f.parameters, extra: true };
  expect(() => f.memory.executor.capture(extra)).toThrow();
  const getter = Object.defineProperty({ resourceRef: "private-cell" }, "resourceRef", {
    get: () => "private-cell",
    enumerable: true,
  });
  expect(() => f.memory.executor.capture(getter)).toThrow();
  const current = await f.memory.source.readCurrent(f.action, f.caller.signal);
  expect(() => Object.assign(current, { mandatoryHuman: { state: "complete", value: true } })).toThrow();
  Object.assign(f.initialPolicy, { mandatoryHuman: { state: "complete", value: true } });
  expect((await f.run()).state).toBe("completed"); // The caller's initial object was copied, never retained as backing state.
});

it.each(["required", "advisory"] as const)(
  "E706-advisory: %s evaluated not-fit/abstention cannot use unavailable fallback",
  async (mode) => {
    for (const advice of [
      { recommendation: "deny", rationaleCode: "fixture-mismatch", uncertainty: true },
      { recommendation: "abstain", rationaleCode: "fixture-incomplete", uncertainty: true },
    ]) {
      const f = await fixture(mode);
      f.controls.transport = async () => JSON.stringify({ schema: LOCAL_ADVICE_SCHEMA, ...advice });
      expect((await f.run()).state).toBe("not-dispatched");
      expect(f.reviews[0]?.result.execution).toBe("evaluated");
      expect(f.memory.observedReads).toBe(0);
    }
  },
);

it.each(["caller", "owner"] as const)(
  "E706-cancel-after-dispatch/owner-death: %s loss preserves the independent read and unknown delivery",
  async (lost) => {
    const f = await fixture();
    const gate = barrier();
    const permit = await permitted(f);
    f.controls.response = gate.wait;
    const executing = f.fence.dispatch(permit, f.caller.signal);
    await gate.entered;
    expect(f.memory.observedReads).toBe(1);
    if (lost === "caller") f.caller.abort();
    else f.memory.dispose();
    const receipt = await executing;
    expect(receipt.state).toBe("execution-unknown");
    const observations = await f.fence.inspect(receipt, f.reader, new AbortController().signal);
    expect(observations.effect.state).toBe("observed");
    expect(observations.delivery.state).toBe("unknown");
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.fence.dispatch(permit, new AbortController().signal)).toBe(receipt);
    expect(f.memory.observedReads).toBe(1);
  },
);

it("resource support does not qualify copied executors, other owners or generic string-path capture", async () => {
  const f = await fixture();
  const other = await fixture();
  const copiedExecutor = new SyntheticReadFence(f.memory, { ...f.memory.executor }, f.policy, f.evidence);
  expect(() => copiedExecutor.capture(f.parameters)).toThrow();
  const wrongOwner = new SyntheticReadFence(other.memory, f.memory.executor, f.policy, f.evidence);
  expect(() => wrongOwner.capture(f.parameters)).toThrow();
  const generic = await syntheticReadFixture();
  try {
    const fence = new SyntheticReadFence(generic.owner, generic.executor, f.policy, generic.evidence);
    const action = fence.capture({ path: "/synthetic/file" });
    expect(action.resources.state).toBe("unknown");
    expect(action.coverage.level).toBe("observation");
    expect((await fence.run({ path: "/synthetic/file" }, generic.caller.signal)).state).toBe("not-dispatched");
    expect(generic.reads).toEqual([]);
    expect(f.counters.judgeCalls).toBe(0);
  } finally {
    generic.abort.abort();
    generic.caller.abort();
  }
});

it.each(["actionBindingRef", "projectionBindingRef", "judgeVersion", "coverageId"] as const)(
  "changed normalized %s cannot install a completed decision",
  async (field) => {
    const f = await fixture();
    const registered = await f.register();
    const result = await f.judge.assess(registered.request, f.payload, f.caller.signal);
    const verdict = await f.fence.completeReview(
      registered.bound,
      { ...result, [field]: "substituted" },
      f.caller.signal,
    );
    expect(verdict.outcome).toBe("indeterminate");
    expect((await f.run()).state).toBe("not-dispatched");
    expect(f.counters.reviewWrites).toBe(0);
    expect(f.state.authWrites).toBe(0);
    expect(f.memory.executorEntries).toBe(0);
    expect(f.memory.observedReads).toBe(0);
    expect(() => Object.assign(f.action, { bindingRef: "substituted" })).toThrow();
  },
);
