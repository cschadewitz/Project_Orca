/** Inactive #701 ReviewJudge adapter. Scheduling advice never evaluates policy or grants authority. */
import type { ApprovedJudgePayloadV1, JudgeRequestV1, JudgeResultV1, ReviewJudgeV1 } from "@orca/core";

export const LOCAL_EVIDENCE_SCHEMA = "orca-701-synthetic-evidence/v0";
export const LOCAL_ADVICE_SCHEMA = "orca-701-synthetic-advice/v0";

/** Owner-registered immutable identity; ref must change with any execution/disclosure configuration. */
export interface LocalJudgeManifest {
  readonly ref: string;
  readonly methodVersion: string;
  readonly transportVersion: string;
  readonly modelVersion: "none";
  readonly promptVersion: "none";
  readonly configVersion: string;
  readonly inputSchema: typeof LOCAL_EVIDENCE_SCHEMA;
  readonly outputSchema: typeof LOCAL_ADVICE_SCHEMA;
  readonly destination: "offline:fixture";
  readonly destinationPolicyRef: string;
  readonly projectionPolicyRevision: string;
}

/** Trusted in-process test method, without request metadata, readers, tools or policy capabilities. */
export interface LocalJudgeMethod {
  readonly version: string;
  readonly configVersion: string;
  readonly modelVersion: "none";
  readonly promptVersion: "none";
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly evaluate: (payload: ApprovedJudgePayloadV1, signal: AbortSignal) => unknown | Promise<unknown>;
}

/** A bounded canonical JSON response frame; not a provider or network implementation. */
export interface LocalJudgeTransport {
  readonly version: string;
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly invoke: (method: LocalJudgeMethod, payload: ApprovedJudgePayloadV1, signal: AbortSignal) => Promise<string>;
}

export interface LocalJudgeLimits {
  readonly maxPending: number;
  readonly maxCalls: number;
  readonly maxPayloadBytes: number;
  readonly maxResponseBytes: number;
  readonly maxTimeoutMs: number;
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

function decodeAdvice(frame: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(frame);
  } catch {
    return;
  }
  if (!exactKeys(raw, ["schema", "recommendation", "rationaleCode", "uncertainty"])) return;
  const { schema, recommendation, rationaleCode, uncertainty } = raw;
  if (schema !== LOCAL_ADVICE_SCHEMA || typeof recommendation !== "string" || !Object.hasOwn(mappings, recommendation))
    return;
  const mapping = mappings[recommendation as keyof typeof mappings];
  if (mapping.rationaleCode !== rationaleCode || mapping.uncertainty !== uncertainty) return;
  // The offline transport emits this exact frame. Reject duplicate keys, alternate encodings and hidden fields.
  if (frame !== JSON.stringify({ schema, recommendation, rationaleCode, uncertainty })) return;
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

/** Explicit local-only configuration. Constructing an adapter neither registers nor activates it. */
export function createLocalReviewJudge(options: {
  manifest: LocalJudgeManifest;
  method: LocalJudgeMethod;
  transport: LocalJudgeTransport;
  limits: LocalJudgeLimits;
}): ReviewJudgeV1 {
  const manifest = Object.freeze({ ...options.manifest });
  const method: LocalJudgeMethod = Object.freeze({
    version: options.method.version,
    configVersion: options.method.configVersion,
    modelVersion: options.method.modelVersion,
    promptVersion: options.method.promptVersion,
    inputSchema: options.method.inputSchema,
    outputSchema: options.method.outputSchema,
    evaluate: options.method.evaluate,
  });
  const transport = Object.freeze({ ...options.transport });
  const limits = Object.freeze({ ...options.limits });
  if (
    !Object.values({
      maxPending: limits.maxPending,
      maxCalls: limits.maxCalls,
      maxPayloadBytes: limits.maxPayloadBytes,
      maxResponseBytes: limits.maxResponseBytes,
      maxTimeoutMs: limits.maxTimeoutMs,
    }).every((value) => Number.isSafeInteger(value) && value > 0) ||
    limits.maxTimeoutMs > 2_147_483_647
  )
    throw new TypeError("explicit finite positive local judge limits required");
  // Capture selected functions and metadata. Replacing caller-owned descriptors cannot replace execution.
  const invoke = transport.invoke;
  const compatible =
    manifest.destination === "offline:fixture" &&
    manifest.modelVersion === "none" &&
    manifest.promptVersion === "none" &&
    [
      manifest.ref,
      manifest.configVersion,
      manifest.methodVersion,
      manifest.transportVersion,
      manifest.destinationPolicyRef,
      manifest.projectionPolicyRevision,
    ].every((value) => typeof value === "string" && value.length > 0) &&
    manifest.inputSchema === LOCAL_EVIDENCE_SCHEMA &&
    manifest.outputSchema === LOCAL_ADVICE_SCHEMA &&
    method.version === manifest.methodVersion &&
    method.configVersion === manifest.configVersion &&
    method.modelVersion === manifest.modelVersion &&
    method.promptVersion === manifest.promptVersion &&
    method.inputSchema === manifest.inputSchema &&
    method.outputSchema === manifest.outputSchema &&
    transport.version === manifest.transportVersion &&
    transport.inputSchema === manifest.inputSchema &&
    transport.outputSchema === manifest.outputSchema &&
    typeof method.evaluate === "function" &&
    typeof invoke === "function";
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
          judgeVersion: manifest.ref,
          reasonCode,
          ...(execution === "unavailable"
            ? { execution, result: "indeterminate" }
            : { execution, result: recommendation }),
        });
      const unavailable = (reason: string) => result("unavailable", "indeterminate", reason);
      if (signal.aborted) return unavailable("cancelled");
      if (!compatible) return unavailable("incompatible-config");
      if (
        retained.version !== 1 ||
        retained.judgeConfigRef !== manifest.ref ||
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
      if (Buffer.byteLength(payload.content, "utf8") > limits.maxPayloadBytes) return unavailable("payload-limit");
      const approved = Object.freeze({
        version: 1 as const,
        bindingRef: payload.bindingRef,
        schemaVersion: payload.schemaVersion,
        content: payload.content,
      });
      if (Buffer.byteLength(JSON.stringify(approved), "utf8") > limits.maxPayloadBytes)
        return unavailable("payload-limit");
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
      const invocation = Promise.resolve()
        .then(async () => {
          if (signal.aborted) return unavailable("cancelled");
          if (expired()) return unavailable("timeout");
          try {
            const frame = await invoke(method, approved, controller.signal);
            if (signal.aborted) return unavailable("cancelled");
            if (expired()) return unavailable("timeout");
            if (typeof frame !== "string") return unavailable("malformed-result");
            if (Buffer.byteLength(frame, "utf8") > limits.maxResponseBytes) return unavailable("response-limit");
            const advice = decodeAdvice(frame);
            return advice ? result("evaluated", advice.result, advice.rationaleCode) : unavailable("malformed-result");
          } catch {
            return unavailable(signal.aborted ? "cancelled" : expired() ? "timeout" : "method-or-transport-failed");
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
