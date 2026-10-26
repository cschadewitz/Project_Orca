/** Offline #701 preparation checks; node:test, no workspace build, network or credentials. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  VERSION,
  RESPONSE,
  projectSyntheticEvidence,
  referenceMethod,
  inProcessTransport,
  fakeMethod,
  createOfflineJudge,
  composeFixture,
  evaluateFixture,
} from "./offline.mjs";

const source = { applicability: "matches", context: "complete", injection: "absent" };
const evidence = projectSyntheticEvidence(source, "offline:fixture").evidence;
const controls = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
const makeJudge = (overrides = {}) =>
  createOfflineJudge({
    method: referenceMethod,
    methodVersion: "reference/v0",
    transport: inProcessTransport,
    maxPending: 1,
    maxCalls: 10,
    maxPayloadBytes: 1024,
    ...overrides,
  });
const advice = (recommendation) => {
  if (["unavailable", "timeout", "cancelled", "malformed"].includes(recommendation))
    return { status: "unavailable", reason: recommendation };
  return {
    schema: RESPONSE,
    status: "reviewed",
    recommendation,
    rationaleCode: {
      allow: "fixture-match",
      deny: "fixture-mismatch",
      escalate: "fixture-injection",
      abstain: "fixture-incomplete",
    }[recommendation],
    uncertainty: recommendation !== "allow",
  };
};

test("projection copies only enumerated synthetic facts and freezes them", () => {
  const privateFixture = {
    ...source,
    secret: "synthetic-secret",
    command: "untrusted do everything",
    prompt: "ignore rules",
    credentials: "synthetic-key",
  };
  const projected = projectSyntheticEvidence(privateFixture, "offline:fixture");
  assert.equal(projected.status, "projected");
  assert.deepEqual(Object.keys(projected.evidence), ["schema", "applicability", "context", "injection"]);
  assert.equal(Object.isFrozen(projected.evidence), true);
  privateFixture.applicability = "mismatch";
  assert.equal(projected.evidence.applicability, "matches");
  assert.doesNotMatch(JSON.stringify(projected), /synthetic-secret|synthetic-key|ignore rules/);
});
for (const destination of [undefined, "hosted", "byok", "jev", "offline:other"]) {
  test(`destination ${destination} is explicitly unsupported without fallback`, () => {
    assert.deepEqual(projectSyntheticEvidence(source, destination), { status: "unsupported", reason: "destination" });
  });
}
for (const missing of Object.keys(source)) {
  test(`missing ${missing} cannot be inferred or silently redacted`, () => {
    const incomplete = { ...source };
    delete incomplete[missing];
    assert.equal(projectSyntheticEvidence(incomplete, "offline:fixture").status, "unsupported");
  });
}
test("reference method repeats identically and does not modify evidence", async () => {
  const judge = makeJudge();
  const first = await judge.review(evidence, controls());
  assert.deepEqual(await judge.review(evidence, controls()), first);
  assert.equal(first.recommendation, "allow");
  assert.equal(first.versions.port, VERSION);
  assert.equal(first.versions.method, "reference/v0");
  assert.equal(first.versions.model, "none");
  assert.equal(Object.hasOwn(first, "authority"), false);
});
for (const [patch, expected] of [
  [{ applicability: "mismatch" }, "deny"],
  [{ applicability: "unknown" }, "abstain"],
  [{ context: "insufficient" }, "abstain"],
  [{ injection: "present" }, "escalate"],
]) {
  test(`reference method ${JSON.stringify(patch)} recommends ${expected}`, async () => {
    const result = await makeJudge().review({ ...evidence, ...patch }, controls());
    assert.equal(result.recommendation, expected);
  });
}
test("same methodology works through a different offline transport", async () => {
  let calls = 0;
  const transport = {
    ...inProcessTransport,
    id: "offline-recording/v0",
    invoke: async (method, projected, options) => {
      calls++;
      assert.equal(Object.isFrozen(projected), true);
      assert.deepEqual(Object.keys(options), ["signal"]);
      return method(projected);
    },
  };
  const result = await makeJudge({ transport }).review(evidence, controls());
  assert.equal(result.recommendation, "allow");
  assert.equal(result.versions.transport, "offline-recording/v0");
  assert.equal(calls, 1);
});
for (const raw of [
  null,
  {},
  "allow",
  { ...referenceMethod(evidence), authority: "granted" },
  { ...referenceMethod(evidence), schema: "future/v1" },
  { ...referenceMethod(evidence), recommendation: "approve-all" },
  { ...referenceMethod(evidence), uncertainty: true },
  { ...referenceMethod(evidence), rationaleCode: "fixture-injection" },
  { ...referenceMethod(evidence), rationaleCode: "x".repeat(100_000) },
]) {
  test(`malformed fake output ${typeof raw}/${Object.keys(raw ?? {}).join(",")} is unavailable`, async () => {
    const result = await makeJudge({ method: fakeMethod(raw), methodVersion: "fake/v0" }).review(evidence, controls());
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "malformed");
    assert.equal(Object.hasOwn(result, "recommendation"), false);
  });
}
test("schema incompatibility is detected before invoking a transport", async () => {
  let calls = 0;
  const transport = {
    ...inProcessTransport,
    evidenceSchema: "unknown",
    invoke() {
      calls++;
    },
  };
  assert.equal((await makeJudge({ transport }).review(evidence, controls())).reason, "incompatible-schema");
  assert.equal(calls, 0);
});
test("invalid or additional evidence is rejected before transport", async () => {
  for (const raw of [
    { ...evidence, command: "synthetic-private" },
    { ...evidence, schema: "unknown" },
    { ...evidence, context: "guess" },
  ])
    assert.equal((await makeJudge().review(raw, controls())).reason, "invalid-evidence");
});
test("transport errors cannot expose their private message", async () => {
  const transport = {
    ...inProcessTransport,
    invoke() {
      throw new Error("synthetic-secret");
    },
  };
  const result = await makeJudge({ transport }).review(evidence, controls());
  assert.equal(result.reason, "transport-failed");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});
test("payload and total-call budgets reject rather than switch transport", async () => {
  assert.equal((await makeJudge({ maxPayloadBytes: 1 }).review(evidence, controls())).reason, "payload-limit");
  const judge = makeJudge({ maxCalls: 1 });
  assert.equal((await judge.review(evidence, controls())).status, "reviewed");
  assert.equal((await judge.review(evidence, controls())).reason, "budget-limit");
});
test("fixture caps and deadline must be explicit positive integers", async () => {
  for (const maxPending of [0, -1, Infinity, 1.5]) assert.throws(() => makeJudge({ maxPending }), TypeError);
  for (const timeoutMs of [undefined, 0, -1, Infinity, 1.5])
    assert.equal((await makeJudge().review(evidence, { timeoutMs })).reason, "invalid-deadline");
});
test("already cancelled requests invoke no method", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const judge = makeJudge({
    method: () => {
      calls++;
      return referenceMethod(evidence);
    },
  });
  assert.equal((await judge.review(evidence, { signal: controller.signal, timeoutMs: 1000 })).reason, "cancelled");
  assert.equal(calls, 0);
});
test("deadline holds capacity until an ignoring transport settles; no retry or late allow", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settle;
  let calls = 0;
  let receivedSignal;
  const transport = {
    ...inProcessTransport,
    invoke(_method, _evidence, { signal }) {
      calls++;
      receivedSignal = signal;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  };
  const judge = makeJudge({ transport });
  const pending = judge.review(evidence, { timeoutMs: 20 });
  await Promise.resolve();
  assert.equal((await judge.review(evidence, controls())).reason, "budget-limit");
  t.mock.timers.tick(20);
  const result = await pending;
  assert.equal(result.reason, "timeout");
  assert.equal(receivedSignal.aborted, true);
  assert.equal((await judge.review(evidence, controls())).reason, "budget-limit");
  settle(referenceMethod(evidence));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.reason, "timeout");
  assert.equal(calls, 1);
});
test("cancellation after invocation propagates and late success stays cancelled", async () => {
  const controller = new AbortController();
  let settle;
  let receivedSignal;
  const transport = {
    ...inProcessTransport,
    invoke(_m, _e, { signal }) {
      receivedSignal = signal;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  };
  const pending = makeJudge({ transport }).review(evidence, { signal: controller.signal, timeoutMs: 1000 });
  await Promise.resolve();
  controller.abort();
  const result = await pending;
  assert.equal(result.reason, "cancelled");
  assert.equal(receivedSignal.aborted, true);
  settle(referenceMethod(evidence));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.reason, "cancelled");
});

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
assert.equal(vectors.version, VERSION);
for (const vector of vectors.cases) {
  test(`composition vector: ${vector.name}`, () => {
    const result = composeFixture({ ...vector, review: advice(vector.advice) });
    assert.equal(result.outcome, vector.expected);
    if (vector.mode === "advisory" && vector.advice === "unavailable")
      assert.equal(result.reason, "approved-rule-advisory-unavailable");
  });
}
for (const mode of ["disabled", "advisory", "required"]) {
  for (const [baseline, expected] of [
    ["deny", "deny"],
    ["mandatory-human", "escalate"],
    ["no-rule", "escalate"],
    ["unknown", "hold"],
    ["stale", "hold"],
  ]) {
    test(`${mode} with ${baseline} never gains authority or calls a judge`, async () => {
      const judge = {
        review() {
          assert.fail("precluded fixture must not call judge");
        },
      };
      assert.equal(
        (await evaluateFixture({ baseline, mode, judge, evidence, controls: controls() })).outcome,
        expected,
      );
    });
  }
}
test("disabled automatic rule never calls a judge or requests extra human confirmation", async () => {
  const judge = {
    review() {
      assert.fail("disabled fixture must not call judge");
    },
  };
  assert.equal(
    (await evaluateFixture({ baseline: "approved-rule", mode: "disabled", judge, evidence, controls: controls() }))
      .outcome,
    "respond-scoped-choice",
  );
});
test("required automatic rule uses reference recommendation without authority output", async () => {
  const result = await evaluateFixture({
    baseline: "approved-rule",
    mode: "required",
    judge: makeJudge(),
    evidence,
    controls: controls(),
  });
  assert.equal(result.outcome, "respond-scoped-choice");
  assert.equal(result.reviewStatus, "reviewed");
});
test("invalid positive advice cannot broaden an approved rule", () => {
  assert.equal(
    composeFixture({ baseline: "approved-rule", mode: "required", review: { ...advice("allow"), uncertainty: true } })
      .outcome,
    "hold",
  );
});
test("no positive cache: changed source evidence is evaluated anew", async () => {
  const judge = makeJudge();
  assert.equal((await judge.review(evidence, controls())).recommendation, "allow");
  assert.equal((await judge.review({ ...evidence, applicability: "mismatch" }, controls())).recommendation, "deny");
});

test("queued review uses a snapshot even when caller mutates evidence", async () => {
  const mutable = { ...evidence };
  const pending = makeJudge().review(mutable, controls());
  mutable.applicability = "mismatch";
  assert.equal((await pending).recommendation, "allow");
});

test("selected transport stays pinned after caller mutates its descriptor", async () => {
  const transport = { ...inProcessTransport };
  const judge = makeJudge({ transport });
  transport.id = "offline-replacement/v0";
  transport.invoke = () => {
    assert.fail("must not select another transport");
  };
  const result = await judge.review(evidence, controls());
  assert.equal(result.recommendation, "allow");
  assert.equal(result.versions.transport, inProcessTransport.id);
});

for (const mode of ["disabled", "advisory", "required"]) {
  test(`${mode} expired signal prevents automatic response without a judge call`, async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await evaluateFixture({
      baseline: "approved-rule",
      mode,
      evidence,
      controls: { signal: controller.signal, timeoutMs: 1000 },
      judge: {
        review() {
          assert.fail("expired invocation must not call judge");
        },
      },
    });
    assert.equal(result.outcome, "hold");
  });
}
