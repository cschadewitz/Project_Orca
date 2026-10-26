/** Deterministic #701 offline doubles, retaining the reviewed preparation's synthetic method vocabulary. */
import type { ApprovedJudgePayloadV1 } from "@orca/core";
import {
  LOCAL_ADVICE_SCHEMA,
  LOCAL_EVIDENCE_SCHEMA,
  type LocalJudgeMethod,
  type LocalJudgeTransport,
} from "./adapter.js";

export const offlineTransport: LocalJudgeTransport = Object.freeze({
  version: "offline-in-process/v1",
  inputSchema: LOCAL_EVIDENCE_SCHEMA,
  outputSchema: LOCAL_ADVICE_SCHEMA,
  invoke: async (method: LocalJudgeMethod, payload: ApprovedJudgePayloadV1, signal: AbortSignal) => {
    signal.throwIfAborted();
    return JSON.stringify(await method.evaluate(payload, signal));
  },
});

/** Trusted pure enum fixture; prompt-like text or unrecognized fields cannot change the method. */
export const referenceMethod: LocalJudgeMethod = Object.freeze({
  version: "reference/v1",
  configVersion: "fixture/v1",
  modelVersion: "none",
  promptVersion: "none",
  inputSchema: LOCAL_EVIDENCE_SCHEMA,
  outputSchema: LOCAL_ADVICE_SCHEMA,
  evaluate: (payload: ApprovedJudgePayloadV1, signal: AbortSignal) => {
    signal.throwIfAborted();
    const raw: unknown = JSON.parse(payload.content);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const evidence = raw as Record<string, unknown>;
    if (
      Object.keys(evidence).length !== 4 ||
      evidence.schema !== LOCAL_EVIDENCE_SCHEMA ||
      typeof evidence.applicability !== "string" ||
      !["matches", "mismatch", "unknown"].includes(evidence.applicability) ||
      typeof evidence.context !== "string" ||
      !["complete", "insufficient"].includes(evidence.context) ||
      typeof evidence.injection !== "string" ||
      !["absent", "present"].includes(evidence.injection)
    )
      return null;
    if (
      payload.content !==
      JSON.stringify({
        schema: evidence.schema,
        applicability: evidence.applicability,
        context: evidence.context,
        injection: evidence.injection,
      })
    )
      return null;
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
    return { schema: LOCAL_ADVICE_SCHEMA, recommendation, rationaleCode, uncertainty: recommendation !== "allow" };
  },
});

/** Caller supplies deterministic output, including malformed responses for contract tests. */
export function fakeMethod(output: unknown): LocalJudgeMethod {
  const retained = structuredClone(output);
  return Object.freeze({
    ...referenceMethod,
    version: "fake/v1",
    evaluate: () => structuredClone(retained),
  });
}
