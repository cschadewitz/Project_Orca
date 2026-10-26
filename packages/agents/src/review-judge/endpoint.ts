/**
 * Inactive #701 injected-endpoint ReviewJudge adapter. Distinct from the offline local adapter: it delivers the
 * approved synthetic evidence as one bounded string frame to an owner-injected transport bound to one exact
 * destination. It is not a hosted or BYOK implementation, resolves no credential and is registered nowhere.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ApprovedJudgePayloadV1, JudgeRequestV1, JudgeResultV1, ReviewJudgeV1 } from "@orca/core";
import { LOCAL_ADVICE_SCHEMA, LOCAL_EVIDENCE_SCHEMA } from "./adapter.js";

export const ENDPOINT_REQUEST_SCHEMA = "orca-701-endpoint-request/v0";
export const ENDPOINT_RESPONSE_SCHEMA = "orca-701-endpoint-response/v0";

/** Every execution and disclosure field; the registered ref is derived from all of them together with the limits. */
export interface EndpointJudgeManifest {
  readonly methodVersion: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly configVersion: string;
  readonly transportVersion: string;
  readonly inputSchema: typeof LOCAL_EVIDENCE_SCHEMA;
  readonly outputSchema: typeof LOCAL_ADVICE_SCHEMA;
  readonly destination: string;
  readonly destinationPolicyRef: string;
  readonly projectionPolicyRevision: string;
  /** No credential resolution exists for this slice; any other requirement is unavailable, never resolved here. */
  readonly credential: "none";
}

/**
 * Owner-injected delivery to one fixed destination. It receives only the serialized minimal frame, a cancellation
 * signal and the response bound; no request, authority, reader, credential, tool or policy capability.
 */
export interface EndpointJudgeTransport {
  readonly version: string;
  readonly destination: string;
  readonly send: (frame: string, signal: AbortSignal, maxResponseBytes: number) => Promise<string>;
}

export interface EndpointJudgeLimits {
  readonly maxPending: number;
  readonly maxCalls: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxTimeoutMs: number;
}

const limitKeys = ["maxPending", "maxCalls", "maxRequestBytes", "maxResponseBytes", "maxTimeoutMs"] as const;
const identityKeys = [
  "methodVersion",
  "modelVersion",
  "promptVersion",
  "configVersion",
  "transportVersion",
  "inputSchema",
  "outputSchema",
  "destination",
  "destinationPolicyRef",
  "projectionPolicyRevision",
  "credential",
] as const;

/**
 * The judgeConfigRef policy must select for this exact manifest and limits. Changing the destination, disclosure
 * policy, model, prompt, schema, transport or a limit changes the ref, so a prior selection cannot be inherited.
 */
export function endpointJudgeConfigRef(manifest: EndpointJudgeManifest, limits: EndpointJudgeLimits): string {
  const fields = [
    ENDPOINT_REQUEST_SCHEMA,
    ENDPOINT_RESPONSE_SCHEMA,
    ...identityKeys.map((key) => manifest[key]),
    ...limitKeys.map((key) => limits[key]),
  ];
  return `endpoint-judge/v0:sha256:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const mappings = {
  allow: { result: "fit", rationaleCode: "fixture-match", uncertainty: false },
  deny: { result: "not-fit", rationaleCode: "fixture-mismatch", uncertainty: true },
  escalate: { result: "indeterminate", rationaleCode: "fixture-injection", uncertainty: true },
  abstain: { result: "indeterminate", rationaleCode: "fixture-incomplete", uncertainty: true },
} as const;

const responseKeys = [
  "schema",
  "requestId",
  "model",
  "adviceSchema",
  "recommendation",
  "rationaleCode",
  "uncertainty",
] as const;

/** Closed canonical frame; the echoed identity must name this exact call, model and advice schema. */
function decodeResponse(frame: string, requestId: string, model: string, adviceSchema: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(frame);
  } catch {
    return "malformed-result";
  }
  if (!exactKeys(raw, responseKeys) || raw.schema !== ENDPOINT_RESPONSE_SCHEMA) return "malformed-result";
  if (
    !responseKeys.every((key) => (key === "uncertainty" ? typeof raw[key] === "boolean" : typeof raw[key] === "string"))
  )
    return "malformed-result";
  // Reject duplicate keys, alternate encodings and reordered or hidden fields.
  if (frame !== JSON.stringify(Object.fromEntries(responseKeys.map((key) => [key, raw[key]]))))
    return "malformed-result";
  if (raw.requestId !== requestId || raw.model !== model || raw.adviceSchema !== adviceSchema)
    return "response-mismatch";
  const recommendation = raw.recommendation as string;
  if (!Object.hasOwn(mappings, recommendation)) return "malformed-result";
  const mapping = mappings[recommendation as keyof typeof mappings];
  if (mapping.rationaleCode !== raw.rationaleCode || mapping.uncertainty !== raw.uncertainty) return "malformed-result";
  return mapping;
}

/** Copy every request field before awaiting; no caller object or extra property is retained. */
function snapshotRequest(request: JudgeRequestV1): JudgeRequestV1 {
  return Object.freeze({
    version: request.version,
    actionBindingRef: request.actionBindingRef,
    authority: Object.freeze({
      capturedGeneration: request.authority.capturedGeneration,
      currentPolicyRevision: request.authority.currentPolicyRevision,
      authorityRevision: request.authority.authorityRevision,
      revocationEpoch: request.authority.revocationEpoch,
      leaseEpoch: request.authority.leaseEpoch,
    }),
    coverageId: request.coverageId,
    reviewId: request.reviewId,
    delegation: Object.freeze({ ruleId: request.delegation.ruleId, ruleRevision: request.delegation.ruleRevision }),
    requirement: request.requirement,
    projectionPolicyRevision: request.projectionPolicyRevision,
    destinationPolicyRef: request.destinationPolicyRef,
    judgeConfigRef: request.judgeConfigRef,
    deadlineAt: request.deadlineAt,
    approvedProjection: Object.freeze({
      kind: request.approvedProjection.kind,
      codecVersion: request.approvedProjection.codecVersion,
      privateRef: request.approvedProjection.privateRef,
      bindingRef: request.approvedProjection.bindingRef,
    }),
  });
}

/** Explicit owner construction. Constructing an adapter neither registers, activates nor connects anything. */
export function createEndpointReviewJudge(options: {
  manifest: EndpointJudgeManifest;
  transport: EndpointJudgeTransport;
  limits: EndpointJudgeLimits;
}): ReviewJudgeV1 {
  const selected = options.manifest;
  const manifest: EndpointJudgeManifest = Object.freeze({
    methodVersion: selected.methodVersion,
    modelVersion: selected.modelVersion,
    promptVersion: selected.promptVersion,
    configVersion: selected.configVersion,
    transportVersion: selected.transportVersion,
    inputSchema: selected.inputSchema,
    outputSchema: selected.outputSchema,
    destination: selected.destination,
    destinationPolicyRef: selected.destinationPolicyRef,
    projectionPolicyRevision: selected.projectionPolicyRevision,
    credential: selected.credential,
  });
  const limits: EndpointJudgeLimits = Object.freeze({
    maxPending: options.limits.maxPending,
    maxCalls: options.limits.maxCalls,
    maxRequestBytes: options.limits.maxRequestBytes,
    maxResponseBytes: options.limits.maxResponseBytes,
    maxTimeoutMs: options.limits.maxTimeoutMs,
  });
  if (
    !limitKeys.every((key) => Number.isSafeInteger(limits[key]) && limits[key] > 0) ||
    limits.maxTimeoutMs > 2_147_483_647
  )
    throw new TypeError("explicit finite positive endpoint judge limits required");
  // Capture the selected function and metadata once; replacing caller-owned descriptors cannot redirect delivery.
  const transport = Object.freeze({
    version: options.transport.version,
    destination: options.transport.destination,
    send: options.transport.send,
  });
  const send = transport.send;
  const ref = endpointJudgeConfigRef(manifest, limits);
  const compatible =
    identityKeys.every((key) => typeof manifest[key] === "string" && manifest[key].length > 0) &&
    manifest.inputSchema === LOCAL_EVIDENCE_SCHEMA &&
    manifest.outputSchema === LOCAL_ADVICE_SCHEMA &&
    transport.version === manifest.transportVersion &&
    transport.destination === manifest.destination &&
    typeof send === "function";
  let pending = 0;
  let calls = 0;
  return Object.freeze({
    version: 1,
    async assess(
      request: JudgeRequestV1,
      payload: ApprovedJudgePayloadV1,
      signal: AbortSignal,
    ): Promise<JudgeResultV1> {
      const retained = snapshotRequest(request);
      const result = (
        execution: "evaluated" | "unavailable",
        recommendation: "fit" | "not-fit" | "indeterminate",
        reasonCode: string,
      ): JudgeResultV1 =>
        Object.freeze({
          version: 1,
          reviewId: retained.reviewId,
          actionBindingRef: retained.actionBindingRef,
          authority: retained.authority,
          coverageId: retained.coverageId,
          projectionBindingRef: retained.approvedProjection.bindingRef,
          judgeVersion: ref,
          reasonCode,
          ...(execution === "unavailable"
            ? { execution, result: "indeterminate" }
            : { execution, result: recommendation }),
        });
      const unavailable = (reason: string) => result("unavailable", "indeterminate", reason);
      if (signal.aborted) return unavailable("cancelled");
      if (manifest.credential !== "none") return unavailable("credential-unsupported");
      if (!compatible) return unavailable("incompatible-config");
      if (
        retained.version !== 1 ||
        retained.judgeConfigRef !== ref ||
        retained.destinationPolicyRef !== manifest.destinationPolicyRef ||
        retained.projectionPolicyRevision !== manifest.projectionPolicyRevision
      )
        return unavailable("request-config-mismatch");
      if (
        !exactKeys(payload, ["version", "bindingRef", "schemaVersion", "content"]) ||
        payload.version !== 1 ||
        payload.bindingRef !== retained.approvedProjection.bindingRef ||
        payload.schemaVersion !== retained.approvedProjection.codecVersion ||
        payload.schemaVersion !== manifest.inputSchema ||
        typeof payload.content !== "string"
      )
        return unavailable("invalid-payload");
      // Minimum disclosure: a per-call correlation id, the selected model/prompt and the approved content only.
      // Review, action, authority, coverage, delegation, binding and private store references stay local.
      const requestId = randomUUID();
      const frame = JSON.stringify({
        schema: ENDPOINT_REQUEST_SCHEMA,
        requestId,
        model: manifest.modelVersion,
        prompt: manifest.promptVersion,
        evidenceSchema: payload.schemaVersion,
        evidence: payload.content,
      });
      if (Buffer.byteLength(frame, "utf8") > limits.maxRequestBytes) return unavailable("request-limit");
      const deadline = Date.parse(retained.deadlineAt);
      if (!Number.isFinite(deadline)) return unavailable("invalid-deadline");
      const timeoutMs = Math.min(deadline - Date.now(), limits.maxTimeoutMs);
      if (timeoutMs <= 0) return unavailable("timeout");
      if (pending >= limits.maxPending || calls >= limits.maxCalls) return unavailable("budget-limit");
      const localDeadline = performance.now() + timeoutMs;
      const expired = () => Date.now() >= deadline || performance.now() >= localDeadline;
      const controller = new AbortController();
      let stop!: (value: JudgeResultV1) => void;
      const stopped = new Promise<JudgeResultV1>((resolve) => {
        stop = resolve;
      });
      const cancel = (reason: "cancelled" | "timeout") => {
        stop(unavailable(reason));
        controller.abort();
      };
      const abort = () => cancel("cancelled");
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => cancel("timeout"), timeoutMs);
      pending++;
      calls++;
      // The slot is held until the transport really settles, so ignored cancellation cannot spawn hidden work.
      const invocation = Promise.resolve()
        .then(async () => {
          if (signal.aborted) return unavailable("cancelled");
          if (expired()) return unavailable("timeout");
          try {
            const reply: unknown = await send(frame, controller.signal, limits.maxResponseBytes);
            if (signal.aborted) return unavailable("cancelled");
            if (expired()) return unavailable("timeout");
            if (typeof reply !== "string") return unavailable("malformed-result");
            if (Buffer.byteLength(reply, "utf8") > limits.maxResponseBytes) return unavailable("response-limit");
            const advice = decodeResponse(reply, requestId, manifest.modelVersion, manifest.outputSchema);
            return typeof advice === "string"
              ? unavailable(advice)
              : result("evaluated", advice.result, advice.rationaleCode);
          } catch {
            return unavailable(signal.aborted ? "cancelled" : expired() ? "timeout" : "transport-failed");
          }
        })
        .finally(() => {
          pending--;
        });
      try {
        return await Promise.race([stopped, invocation]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  });
}
