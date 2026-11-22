/** Bounded first-attachment fence; admission receipts remain in the existing retry journal. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OrcaError, RunOriginSchema, sha256, type OrcaEvent } from "@orca/core";
import type { Stores } from "@orca/store";
import { canonicalJson } from "./admission-retry.js";
import { GenerationSnapshotSchema } from "./configuration-generation.js";
import { workflowRevision } from "./orchestrator.js";
import type { RunContext } from "./run-context.js";

type AdmissionStores = Pick<Stores, "events" | "execution" | "workflows">;
const IdentitySchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  revision: z.string().min(1),
});
const BindingSchema = z.strictObject({
  kind: z.enum(["direct", "request"]),
  admissionId: z.string().min(1),
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  actor: z.strictObject({ principalId: z.string().min(1), credentialId: z.string().min(1).optional() }),
  generationId: z.string().min(1),
  workflow: IdentitySchema,
  requestId: z.string().min(1).optional(),
  workItemId: z.string().min(1).optional(),
  origin: RunOriginSchema.optional(),
  gitRef: z.string().min(1).optional(),
});
export type AdmissionExecutionBinding = z.infer<typeof BindingSchema>;
const EvidenceSchema = z.strictObject({
  eventId: z.string().min(1),
  eventSeq: z.number().int().nonnegative(),
  executionPayloadRef: z.string().min(1),
  eventDigest: z.string().min(1),
  payloadDigest: z.string().min(1),
});
const PolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal("bounded-first-attachment"),
  binding: BindingSchema,
  generationDigest: z.string().min(1),
  creation: EvidenceSchema,
});
export type AdmissionExecutionPolicy = z.infer<typeof PolicySchema>;
export interface AdmissionExecutionRuntime {
  /** Trusted current authority; invoked inside the interpreter's actual run lease. */
  authorize(policy: Readonly<AdmissionExecutionPolicy>): Promise<void>;
}
const AttemptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("admission-first-attempt"),
  runId: z.string(),
  attemptId: z.string(),
  policyDigest: z.string(),
});
const StartSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("admission-first-start"),
  runId: z.string(),
  attemptDigest: z.string(),
  started: EvidenceSchema,
});
const IntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("admission-execution-intent"),
  binding: BindingSchema,
});
const policyKey = (id: string) => `admission-execution-policy:${id}`;
const intentKey = (id: string) => `admission-execution-intent:${id}`;
const attemptKey = (id: string) => `admission-execution-attempt:${id}`;
const startKey = (id: string) => `admission-execution-start:${id}`;
const unavailable = () => new OrcaError("RUN_STATE", "admitted execution evidence is missing, ambiguous or invalid");
// Runtime objects may carry optional undefined properties; persisted JSON cannot.
const digest = (value: unknown) => sha256(canonicalJson(JSON.parse(JSON.stringify(value)), false));
const equal = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a === b : digest(a) === digest(b));

async function original(stores: AdmissionStores, event: OrcaEvent): Promise<Record<string, unknown>> {
  if (!event.executionPayloadRef) throw unavailable();
  return stores.execution.getPayload(event.runId, event.executionPayloadRef, event.type);
}
function evidence(event: OrcaEvent, payload: unknown): z.infer<typeof EvidenceSchema> {
  if (!event.executionPayloadRef) throw unavailable();
  return {
    eventId: event.id,
    eventSeq: event.seq,
    executionPayloadRef: event.executionPayloadRef,
    eventDigest: digest(event),
    payloadDigest: digest(payload),
  };
}
async function root(stores: AdmissionStores, runId: string) {
  const event = (await stores.events.readRange(runId, { limit: 1 }))[0];
  if (!event || event.type !== "run.created" || event.runId !== runId || event.seq !== 0) throw unavailable();
  // Read raw authenticated payload as correlation is deliberately absent from the public schema.
  const payload = event.executionPayloadRef ? await original(stores, event) : event.payload;
  return { event, payload: payload as Record<string, unknown> };
}
async function validateCreation(stores: AdmissionStores, binding: AdmissionExecutionBinding) {
  const { event, payload } = await root(stores, binding.runId);
  const inputs = await stores.execution.getInputs(binding.runId);
  const provenance = z.object({ configGeneration: z.string(), workflow: IdentitySchema }).safeParse(payload.provenance);
  if (
    !event.executionPayloadRef ||
    !inputs ||
    inputs.runId !== binding.runId ||
    inputs.workflowId !== binding.workflow.id ||
    inputs.workflowVersion !== binding.workflow.version ||
    payload.executionInputsStored !== true ||
    payload.workflowStored !== true ||
    payload.parentRunId !== undefined ||
    payload.parentStepRunId !== undefined ||
    payload.workflowId !== binding.workflow.id ||
    payload.workflowVersion !== binding.workflow.version ||
    !equal(payload.actor, binding.actor) ||
    payload.requestId !== binding.requestId ||
    payload.workItemId !== binding.workItemId ||
    !equal(payload.origin, binding.origin) ||
    (payload.workspace as { rootProvisioning?: { ref?: unknown } } | undefined)?.rootProvisioning?.ref !==
      binding.gitRef ||
    (binding.kind === "request"
      ? payload.requestAdmissionId !== binding.admissionId ||
        payload.directAdmissionId !== undefined ||
        !binding.requestId
      : payload.directAdmissionId !== binding.admissionId || payload.requestAdmissionId !== undefined) ||
    !provenance.success ||
    provenance.data.configGeneration !== binding.generationId ||
    !equal(provenance.data.workflow, binding.workflow)
  )
    throw unavailable();
  const generation = GenerationSnapshotSchema.safeParse(await stores.execution.getGeneration(binding.generationId));
  // A generation pins configuration/defaults, not every explicitly selectable historical
  // version. captureMaterial may legitimately select an older immutable stored definition.
  // The authenticated creation and exact stored definition bind that independent selection.
  const definition = await stores.workflows.get(binding.workflow.id, binding.workflow.version);
  if (
    !generation.success ||
    generation.data.id !== binding.generationId ||
    !definition ||
    definition.id !== binding.workflow.id ||
    definition.version !== binding.workflow.version ||
    workflowRevision(definition) !== binding.workflow.revision
  )
    throw unavailable();
  return { event, payload, generationDigest: digest(generation.data) };
}

/** Fresh creation only. Call before returning accepted; never use to repair recovery evidence. */
export async function publishAdmissionExecutionPolicy(
  stores: AdmissionStores,
  input: AdmissionExecutionBinding,
): Promise<AdmissionExecutionPolicy> {
  return writePolicy(stores, BindingSchema.parse(structuredClone(input)));
}

/**
 * The pre-publication phase of a two-phase policy publish: durably record, before the run
 * exists, that this exact binding will be published for it. Write-once; repeating it with the
 * same binding is a no-op, and it is refused once the run has been created.
 */
export async function reserveAdmissionExecutionPolicy(
  stores: AdmissionStores,
  input: AdmissionExecutionBinding,
): Promise<void> {
  const binding = BindingSchema.parse(structuredClone(input));
  const existing = await stores.execution.getGeneration(intentKey(binding.runId));
  if (existing !== undefined) {
    const parsed = IntentSchema.safeParse(existing);
    if (!parsed.success || !equal(parsed.data.binding, binding)) throw unavailable();
    return;
  }
  if ((await stores.events.lastSeq(binding.runId)) !== undefined) throw unavailable();
  await stores.execution.putGeneration(intentKey(binding.runId), {
    schemaVersion: 1,
    kind: "admission-execution-intent",
    binding,
  } satisfies z.infer<typeof IntentSchema>);
}

/**
 * The commit phase: publish the policy a reservation named, or verify the one already
 * published. Only an exact reservation written before the run was created allows a publish
 * after an interruption, and only while the run has its creation alone (nothing attached).
 */
export async function completeAdmissionExecutionPolicy(
  stores: AdmissionStores,
  input: AdmissionExecutionBinding,
): Promise<AdmissionExecutionPolicy> {
  const binding = BindingSchema.parse(structuredClone(input));
  const intent = IntentSchema.safeParse(await stores.execution.getGeneration(intentKey(binding.runId)));
  if (!intent.success || !equal(intent.data.binding, binding)) throw unavailable();
  if ((await stores.execution.getGeneration(policyKey(binding.runId))) !== undefined)
    return requireAdmissionExecutionPolicy(stores, binding);
  return writePolicy(stores, binding);
}

async function writePolicy(
  stores: AdmissionStores,
  binding: AdmissionExecutionBinding,
): Promise<AdmissionExecutionPolicy> {
  if (
    (await stores.execution.getGeneration(policyKey(binding.runId))) !== undefined ||
    (await stores.execution.getGeneration(attemptKey(binding.runId))) !== undefined ||
    (await stores.execution.getGeneration(startKey(binding.runId))) !== undefined
  )
    throw unavailable();
  if (!stores.events.synchronizeEvent) throw unavailable();
  const created = await validateCreation(stores, binding);
  if ((await stores.events.lastSeq(binding.runId)) !== 0) throw unavailable();
  await stores.events.synchronizeEvent(created.event);
  const checked = await validateCreation(stores, binding);
  if (!equal(created, checked)) throw unavailable();
  const policy: AdmissionExecutionPolicy = {
    schemaVersion: 1,
    mode: "bounded-first-attachment",
    binding,
    generationDigest: created.generationDigest,
    creation: evidence(created.event, created.payload),
  };
  await stores.execution.putGeneration(policyKey(binding.runId), policy);
  return requireAdmissionExecutionPolicy(stores, binding);
}

/** Read/verify only. Missing policy is unknown, never permission to manufacture a new one. */
export async function requireAdmissionExecutionPolicy(
  stores: AdmissionStores,
  input: AdmissionExecutionBinding,
): Promise<AdmissionExecutionPolicy> {
  const binding = BindingSchema.parse(structuredClone(input));
  const parsed = PolicySchema.safeParse(await stores.execution.getGeneration(policyKey(binding.runId)));
  if (!parsed.success || !equal(parsed.data.binding, binding)) throw unavailable();
  const created = await validateCreation(stores, binding);
  if (
    parsed.data.generationDigest !== created.generationDigest ||
    !equal(parsed.data.creation, evidence(created.event, created.payload))
  )
    throw unavailable();
  if (!stores.events.synchronizeEvent) throw unavailable();
  await stores.events.synchronizeEvent(created.event);
  const checked = await validateCreation(stores, binding);
  if (!equal(created, checked)) throw unavailable();
  return parsed.data;
}

export type AdmissionExecutionStatus = {
  state: "ready" | "started" | "unknown" | "blocked" | "ordinary";
  policy?: AdmissionExecutionPolicy;
};
async function inspect(stores: AdmissionStores, runId: string): Promise<AdmissionExecutionStatus> {
  const raw = await stores.execution.getGeneration(policyKey(runId));
  if (raw === undefined) {
    const created = await root(stores, runId);
    const admitted =
      created.payload.requestAdmissionId !== undefined || created.payload.directAdmissionId !== undefined;
    return { state: admitted ? "unknown" : "ordinary" };
  }
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success || parsed.data.binding.runId !== runId) throw unavailable();
  const policy = await requireAdmissionExecutionPolicy(stores, parsed.data.binding);
  const starts = await stores.events.readRange(runId, { types: ["run.started"], limit: 2 });
  const attempted = await stores.execution.getGeneration(attemptKey(runId));
  const witnessed = await stores.execution.getGeneration(startKey(runId));
  if (attempted === undefined && witnessed === undefined && starts.length === 0) {
    if ((await stores.events.lastSeq(runId)) !== 0) throw unavailable();
    return { state: "ready", policy };
  }
  const attempt = AttemptSchema.safeParse(attempted);
  const witness = StartSchema.safeParse(witnessed);
  const started = starts[0];
  if (
    !attempt.success ||
    attempt.data.runId !== runId ||
    attempt.data.policyDigest !== digest(policy) ||
    !witness.success ||
    witness.data.runId !== runId ||
    witness.data.attemptDigest !== digest(attempt.data) ||
    starts.length !== 1 ||
    !started ||
    started.seq !== 1 ||
    !equal(witness.data.started, evidence(started, await original(stores, started)))
  )
    throw unavailable();
  if (!stores.events.synchronizeEvent) throw unavailable();
  await stores.events.synchronizeEvent(started);
  return { state: "started", policy };
}

/** Safe projection only; uncertainty never makes an admitted root executable. */
export async function readAdmissionExecutionStatus(
  stores: AdmissionStores,
  runId: string,
): Promise<AdmissionExecutionStatus> {
  try {
    return await inspect(stores, runId);
  } catch {
    return { state: "blocked" };
  }
}

/** Internal barrier. Caller must hold rc.withOwnership around this entire operation. */
export async function prepareAdmissionExecution(
  stores: AdmissionStores,
  rc: RunContext,
  runtime: AdmissionExecutionRuntime | undefined,
  recovery = false,
): Promise<void> {
  const created = await root(stores, rc.id);
  const hasPolicy = (await stores.execution.getGeneration(policyKey(rc.id))) !== undefined;
  const admitted = created.payload.requestAdmissionId !== undefined || created.payload.directAdmissionId !== undefined;
  if (!admitted && !hasPolicy) return;
  if (!admitted || created.payload.parentRunId !== undefined) throw unavailable();
  const status = await inspect(stores, rc.id);
  if (!status.policy || (status.state !== "ready" && status.state !== "started")) throw unavailable();
  if (status.state === "started") {
    // Prior start evidence is never permission for an admission retry to resume effects.
    // Only explicit resume/continuation keeps its existing, separate authority semantics.
    if (!recovery) throw unavailable();
    return;
  }
  if (!runtime) throw unavailable();
  const policy = status.policy;
  await runtime.authorize(structuredClone(policy));
  if (status.state === "ready") {
    if (rc.state.run.status !== "created") throw unavailable();
    const attempt: z.infer<typeof AttemptSchema> = {
      schemaVersion: 1,
      kind: "admission-first-attempt",
      runId: rc.id,
      attemptId: randomUUID(),
      policyDigest: digest(policy),
    };
    // Consumed before append. Any failure after this point is uncertain, never retried.
    await stores.execution.putGeneration(attemptKey(rc.id), attempt);
    if (!equal(attempt, await stores.execution.getGeneration(attemptKey(rc.id)))) throw unavailable();
    const started = await rc.emitOwned({ type: "run.started", payload: {} });
    if (!stores.events.synchronizeEvent || started.seq !== 1) throw unavailable();
    await stores.events.synchronizeEvent(started);
    const witness: z.infer<typeof StartSchema> = {
      schemaVersion: 1,
      kind: "admission-first-start",
      runId: rc.id,
      attemptDigest: digest(attempt),
      started: evidence(started, await original(stores, started)),
    };
    await stores.execution.putGeneration(startKey(rc.id), witness);
  }
  // Reauthenticate records and current authority after all persistence, before effects.
  const verified = await inspect(stores, rc.id);
  if (verified.state !== "started" || !equal(verified.policy, policy)) throw unavailable();
  await runtime.authorize(structuredClone(policy));
}
