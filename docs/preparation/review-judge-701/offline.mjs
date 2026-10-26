/** #701 synthetic-only judge experiment; no production action or authority contract. */
export const VERSION = "orca-701-preparation/v0";
export const EVIDENCE = "orca-701-synthetic-evidence/v0";
export const RESPONSE = "orca-701-synthetic-advice/v0";

const enums = {
  applicability: ["matches", "mismatch", "unknown"],
  context: ["complete", "insufficient"],
  injection: ["absent", "present"],
};
const recommendations = ["allow", "deny", "escalate", "abstain"];
const rationaleCodes = ["fixture-match", "fixture-mismatch", "fixture-incomplete", "fixture-injection"];
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** Explicit local destination only. Unknown/private source fields never cross this seam. */
export function projectSyntheticEvidence(source, destination) {
  if (destination !== "offline:fixture") return Object.freeze({ status: "unsupported", reason: "destination" });
  if (!source || !Object.entries(enums).every(([key, values]) => values.includes(source[key])))
    return Object.freeze({ status: "unsupported", reason: "insufficient-projection" });
  const evidence = Object.freeze({
    schema: EVIDENCE,
    applicability: source.applicability,
    context: source.context,
    injection: source.injection,
  });
  return Object.freeze({ status: "projected", evidence });
}

/** Pure replaceable methodology. Input strings cannot instruct it to change authority. */
export function referenceMethod(evidence) {
  let recommendation = "allow";
  let rationaleCode = "fixture-match";
  if (evidence.applicability === "mismatch") {
    recommendation = "deny";
    rationaleCode = "fixture-mismatch";
  } else if (evidence.injection === "present") {
    recommendation = "escalate";
    rationaleCode = "fixture-injection";
  } else if (evidence.context !== "complete" || evidence.applicability !== "matches") {
    recommendation = "abstain";
    rationaleCode = "fixture-incomplete";
  }
  return { schema: RESPONSE, recommendation, rationaleCode, uncertainty: recommendation !== "allow" };
}

/** Offline transport is independent of the selected method; no network or secret API. */
export const inProcessTransport = Object.freeze({
  id: "offline-in-process/v0",
  evidenceSchema: EVIDENCE,
  responseSchema: RESPONSE,
  invoke: async (method, evidence, { signal }) => {
    signal.throwIfAborted();
    return method(evidence);
  },
});

/** Deterministic fake method, including deliberately malformed outputs for contract tests. */
export const fakeMethod = (output) => () => structuredClone(output);

function validEvidence(evidence) {
  return (
    exactKeys(evidence, ["schema", ...Object.keys(enums)]) &&
    evidence.schema === EVIDENCE &&
    Object.entries(enums).every(([key, values]) => values.includes(evidence[key]))
  );
}

function validAdvice(value) {
  return (
    exactKeys(value, ["schema", "recommendation", "rationaleCode", "uncertainty"]) &&
    value.schema === RESPONSE &&
    recommendations.includes(value.recommendation) &&
    rationaleCodes.includes(value.rationaleCode) &&
    typeof value.uncertainty === "boolean" &&
    value.rationaleCode ===
      {
        allow: "fixture-match",
        deny: "fixture-mismatch",
        escalate: "fixture-injection",
        abstain: "fixture-incomplete",
      }[value.recommendation] &&
    value.uncertainty === (value.recommendation !== "allow")
  );
}

/** Bounded local port proposal. A settled timeout still occupies capacity until work ends. */
export function createOfflineJudge({ method, methodVersion, transport, maxPending, maxCalls, maxPayloadBytes }) {
  if (
    typeof method !== "function" ||
    !["reference/v0", "fake/v0"].includes(methodVersion) ||
    ![maxPending, maxCalls, maxPayloadBytes].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new TypeError("explicit positive fixture limits and method required");
  let pending = 0;
  let calls = 0;
  const selectedTransport = Object.freeze({
    id: transport?.id,
    evidenceSchema: transport?.evidenceSchema,
    responseSchema: transport?.responseSchema,
    invoke: transport?.invoke,
  });
  const versions = Object.freeze({
    port: VERSION,
    method: methodVersion,
    transport: selectedTransport.id,
    model: "none",
    config: "fixture/v0",
    prompt: "none",
  });
  const unavailable = (reason) => Object.freeze({ status: "unavailable", reason, versions });
  return Object.freeze({
    async review(evidence, { signal, timeoutMs }) {
      if (signal?.aborted) return unavailable("cancelled");
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return unavailable("invalid-deadline");
      if (
        selectedTransport.evidenceSchema !== EVIDENCE ||
        selectedTransport.responseSchema !== RESPONSE ||
        typeof selectedTransport.invoke !== "function"
      )
        return unavailable("incompatible-schema");
      if (!validEvidence(evidence)) return unavailable("invalid-evidence");
      // Reconstruct an immutable snapshot; never pass caller-owned objects across awaits.
      const snapshot = projectSyntheticEvidence(evidence, "offline:fixture").evidence;
      if (Buffer.byteLength(JSON.stringify(snapshot)) > maxPayloadBytes) return unavailable("payload-limit");
      if (pending >= maxPending || calls >= maxCalls) return unavailable("budget-limit");
      const controller = new AbortController();
      let stop;
      const stopped = new Promise((resolve) => {
        stop = resolve;
      });
      const cancel = (reason) => {
        stop(unavailable(reason));
        controller.abort();
      };
      const abort = () => cancel("cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => cancel("timeout"), timeoutMs);
      pending++;
      calls++;
      const invocation = Promise.resolve()
        .then(() => {
          // Cancellation may happen between queueing and invoking the transport.
          controller.signal.throwIfAborted();
          return selectedTransport.invoke(method, snapshot, { signal: controller.signal });
        })
        .then(
          (raw) =>
            validAdvice(raw) ? Object.freeze({ ...raw, status: "reviewed", versions }) : unavailable("malformed"),
          () => unavailable("transport-failed"),
        )
        .catch(() => unavailable("malformed"))
        .finally(() => {
          pending--;
        });
      try {
        return await Promise.race([stopped, invocation]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}

/** Symbolic #700 test-vector placeholders, never accepted from a tool or wire request. */
export function composeFixture({ baseline, mode, review, live = true, nativeChoiceAvailable = true }) {
  const result = (outcome, reason) =>
    Object.freeze({ outcome, reason, reviewStatus: review?.status ?? "not-requested" });
  if (!live) return result("hold", "expired-invocation");
  if (baseline === "deny") return result("deny", "authority-ceiling");
  if (baseline === "mandatory-human") return result("escalate", "mandatory-human");
  if (baseline === "no-rule") return result("escalate", "no-approved-rule");
  if (baseline !== "approved-rule") return result("hold", "unverified-baseline");
  if (!nativeChoiceAvailable) return result("hold", "missing-scoped-native-choice");
  if (!["disabled", "advisory", "required"].includes(mode)) return result("hold", "unknown-mode");
  if (mode === "disabled") return result("respond-scoped-choice", "approved-rule-disabled");
  if (review?.reason === "cancelled") return result("hold", "cancelled");
  if (review?.status !== "reviewed")
    return mode === "advisory"
      ? result("respond-scoped-choice", "approved-rule-advisory-unavailable")
      : result("hold", "required-judge-unavailable");
  if (
    !validAdvice({
      schema: review.schema,
      recommendation: review.recommendation,
      rationaleCode: review.rationaleCode,
      uncertainty: review.uncertainty,
    })
  )
    return result("hold", "invalid-advice");
  if (review.recommendation === "deny") return result("deny", "judge-recommends-deny");
  if (review.recommendation !== "allow") return result("escalate", "judge-escalates-or-abstains");
  return result("respond-scoped-choice", "approved-rule-reviewed");
}

/** Test harness only: disabled and precluded paths do not invoke any judge. */
export async function evaluateFixture({ judge, evidence, controls, ...vector }) {
  if (controls?.signal?.aborted) return composeFixture({ ...vector, live: false });
  const preliminary = composeFixture(vector);
  if (
    vector.mode === "disabled" ||
    vector.baseline !== "approved-rule" ||
    vector.live === false ||
    vector.nativeChoiceAvailable === false ||
    !["advisory", "required"].includes(vector.mode)
  )
    return preliminary;
  const review = await judge.review(evidence, controls);
  return composeFixture({ ...vector, review, live: vector.live !== false && !controls?.signal?.aborted });
}
