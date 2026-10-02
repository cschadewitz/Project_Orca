/** Protected revision journal and exact-attempt interpreter bindings. No independent recovery ledger. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  applyEvent,
  newId,
  OrcaError,
  reduceRun,
  systemClock,
  validateWorkflowInputs,
  RevisionCapabilitySchema,
  validateRevisionCapability,
  type Clock,
  type EventJournalCorrelation,
  type OrcaEvent,
  type RunState,
} from "@orca/core";
import { executionEvents, unavailable, type Stores } from "@orca/store";
import { RevisionDelivery, type RevisionDeliveryTarget, type RevisionHandoff } from "./revision-delivery.js";
import {
  RunRevisionJournal,
  revisionCanonical,
  validateRevisionCommand,
  type RevisionBoundary,
  type RevisionJournalEntry,
  type RevisionLog,
  type RevisionRecord,
  type RetryClaims,
} from "./revision-input.js";
import type { RegisteredRetryClaims } from "./admission-retry.js";
import type { RunContext } from "./run-context.js";
import type { OrchestratorOptions } from "./orchestrator.js";

const id = z.string().min(1);
const actor = z.strictObject({ principalId: id, credentialId: id.optional() });
const target = z.strictObject({ runId: id, stepRunId: id, requestId: id, destinationId: id, expectedRevision: id });
const receipt = z.strictObject({
  revisionId: id,
  target,
  state: z.enum(["pending", "delivered", "rejected", "superseded"]),
  attemptId: id,
  currentRevisionId: id,
  expectedRevision: id,
});
const recordSchema = z.strictObject({
  receipt,
  payload: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text"), text: id }),
    z.strictObject({ kind: z.literal("values"), values: z.record(z.string(), z.unknown()) }),
  ]),
  capability: RevisionCapabilitySchema,
  provenance: z.strictObject({
    actor,
    workspaceId: id,
    operationId: id,
    source: z.literal("human-revision"),
    recordedAt: id,
  }),
  delivery: z.enum(["unclaimed", "claimed", "confirmed", "uncertain"]),
  supersedesRevisionId: id.optional(),
  handoffId: id.optional(),
  prompt: z.string().optional(),
});
const boundarySchema = z.strictObject({
  target,
  capability: RevisionCapabilitySchema,
  destinationDescription: id,
  attemptId: id,
  generationId: id,
  workflowRevision: id,
  status: z.enum(["waiting", "answered", "cancelled", "moved"]),
  currentRevisionId: id.optional(),
});
const entrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("boundary"), boundary: boundarySchema }),
  z.strictObject({
    kind: z.literal("commit"),
    change: z.strictObject({
      operationId: id,
      record: recordSchema,
      supersedesRevisionId: id.optional(),
      decision: z.strictObject({ requestId: id, stepRunId: id, answer: id, actor }).optional(),
    }),
  }),
  z.strictObject({ kind: z.literal("transition"), record: recordSchema, expectedRevision: id }),
]);
const envelopeSchema = z.strictObject({ version: z.literal(1), entry: entrySchema });
const legacyPublicationGuardSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("revision-publication-guard"),
  runId: id,
  operationId: id.optional(),
  correlation: z.strictObject({ kind: z.literal("revision"), id, revision: z.number().int().nonnegative() }),
});
const publicationGuardSchema = legacyPublicationGuardSchema.extend({
  version: z.literal(2),
  destinationId: id,
  expectedRevision: id,
  attemptId: id,
  generationId: id,
  workflowRevision: id,
});
type PublicationGuard = z.infer<typeof publicationGuardSchema> | z.infer<typeof legacyPublicationGuardSchema>;

function guardAddress(identity: string[]): string {
  return `revision-publication:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
function versionGuardAddress(runId: string, destinationId: string, expectedRevision: string): string {
  return guardAddress([runId, "boundary-version", destinationId, expectedRevision]);
}
function consumedVersion(entry: RevisionJournalEntry): string {
  return entry.kind === "boundary"
    ? entry.boundary.target.expectedRevision
    : entry.kind === "commit"
      ? entry.change.record.receipt.target.expectedRevision
      : entry.expectedRevision;
}
function guardBinding(boundary: RevisionBoundary, expectedRevision: string) {
  return {
    runId: boundary.target.runId,
    destinationId: boundary.target.destinationId,
    expectedRevision,
    attemptId: boundary.attemptId,
    generationId: boundary.generationId,
    workflowRevision: boundary.workflowRevision,
  };
}
function guardFor(entry: RevisionJournalEntry, boundary: RevisionBoundary): z.infer<typeof publicationGuardSchema> {
  const record = entry.kind === "boundary" ? undefined : entry.kind === "commit" ? entry.change.record : entry.record;
  return {
    version: 2,
    kind: "revision-publication-guard",
    ...guardBinding(boundary, consumedVersion(entry)),
    ...(record ? { operationId: record.provenance.operationId } : {}),
    correlation: correlation(entry),
  };
}

/**
 * An attempted publication is not acceptance. This records only the ambiguity barrier.
 * Coordinated rollback of the log, guards and retry evidence cannot always be detected;
 * this mechanism never claims protection against rollback of all durable evidence.
 */
function publicationGuardId(runId: string, entry: RevisionJournalEntry): string {
  if (entry.kind === "boundary")
    return guardAddress([runId, entry.kind, entry.boundary.target.stepRunId, entry.boundary.target.requestId]);
  const record = entry.kind === "commit" ? entry.change.record : entry.record;
  return versionGuardAddress(runId, record.receipt.target.destinationId, consumedVersion(entry));
}
function publicationUncertain(entry: RevisionJournalEntry, operationId?: string): OrcaError {
  const operation =
    operationId ??
    (entry.kind === "boundary"
      ? undefined
      : (entry.kind === "commit" ? entry.change.record : entry.record).provenance.operationId);
  return new OrcaError("RUN_STATE", "Revision publication is uncertain; its authoritative marker is unavailable", {
    reason: "revision-publication-uncertain",
    ...(operation ? { operationId: operation } : {}),
  });
}

function correlation(entry: RevisionJournalEntry): EventJournalCorrelation & { kind: "revision" } {
  const parts =
    entry.kind === "boundary"
      ? [entry.kind, entry.boundary.target.destinationId]
      : entry.kind === "commit"
        ? [entry.kind, entry.change.operationId]
        : [entry.kind, entry.record.receipt.revisionId, entry.expectedRevision];
  return { kind: "revision", id: createHash("sha256").update(JSON.stringify(parts)).digest("hex"), revision: 0 };
}
function metadata(entry: RevisionJournalEntry) {
  if (entry.kind === "boundary") return { destinationId: entry.boundary.target.destinationId };
  const record = entry.kind === "commit" ? entry.change.record : entry.record;
  return {
    destinationId: record.receipt.target.destinationId,
    revisionId: record.receipt.revisionId,
    state: record.receipt.state,
    ...(entry.kind === "commit" && entry.change.decision ? { decision: entry.change.decision } : {}),
  };
}
function decode(event: OrcaEvent): RevisionJournalEntry {
  try {
    if (event.type !== "revision.recorded" || !event.executionPayloadRef) throw unavailable();
    const entry = envelopeSchema.parse(event.payload.entry).entry as RevisionJournalEntry;
    const runId =
      entry.kind === "boundary"
        ? entry.boundary.target.runId
        : (entry.kind === "commit" ? entry.change.record : entry.record).receipt.target.runId;
    const { entry: _entry, ...publicFields } = event.payload;
    if (
      runId !== event.runId ||
      !isDeepStrictEqual(event.journal, correlation(entry)) ||
      !isDeepStrictEqual(publicFields, metadata(entry))
    )
      throw unavailable();
    // Reject non-JSON and pathological nested value payloads rather than letting a private
    // authenticated record silently become a more permissive runtime command.
    if (entry.kind !== "boundary")
      revisionCanonical((entry.kind === "commit" ? entry.change.record : entry.record).payload);
    return entry;
  } catch {
    throw unavailable();
  }
}

/** Validate semantic immutability as well as the envelope before the journal projects it. */
function validateHistory(entries: RevisionJournalEntry[], runId: string): void {
  const boundaries = new Map<string, RevisionBoundary>();
  const records = new Map<string, RevisionRecord>();
  const operations = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "boundary") {
      const b = entry.boundary;
      if (
        b.target.runId !== runId ||
        b.status !== "waiting" ||
        b.currentRevisionId ||
        boundaries.has(b.target.destinationId)
      )
        throw unavailable();
      boundaries.set(b.target.destinationId, structuredClone(b));
      continue;
    }
    const r = entry.kind === "commit" ? entry.change.record : entry.record;
    const b = boundaries.get(r.receipt.target.destinationId);
    const payloadBytes = Buffer.byteLength(
      r.payload.kind === "text" ? r.payload.text : JSON.stringify(r.payload.values),
    );
    if (r.payload.kind !== r.capability.payload.kind || payloadBytes > r.capability.payload.maxBytes)
      throw unavailable();
    if (r.payload.kind === "values" && r.capability.payload.kind === "values") {
      const checked = validateWorkflowInputs(
        { vars: {}, inputSchema: r.capability.payload.inputSchema },
        r.payload.values,
      );
      if (
        !checked.validation.ok ||
        !isDeepStrictEqual(revisionCanonical(checked.vars), revisionCanonical(r.payload.values))
      )
        throw unavailable();
    }
    if (
      !b ||
      r.receipt.target.runId !== runId ||
      r.receipt.attemptId !== b.attemptId ||
      r.receipt.target.stepRunId !== b.target.stepRunId ||
      r.receipt.target.requestId !== b.target.requestId ||
      !isDeepStrictEqual(r.capability, b.capability) ||
      r.receipt.currentRevisionId !== r.receipt.revisionId
    )
      throw unavailable();
    if (entry.kind === "commit") {
      const change = entry.change;
      if (
        operations.has(change.operationId) ||
        records.has(r.receipt.revisionId) ||
        r.provenance.operationId !== change.operationId ||
        r.receipt.target.expectedRevision !== b.target.expectedRevision ||
        r.delivery !== "unclaimed" ||
        r.receipt.state !== "pending" ||
        r.handoffId !== undefined ||
        r.prompt !== undefined ||
        r.supersedesRevisionId !== change.supersedesRevisionId
      )
        throw unavailable();
      if (change.supersedesRevisionId) {
        const old = records.get(change.supersedesRevisionId);
        if (
          !old ||
          b.currentRevisionId !== old.receipt.revisionId ||
          old.delivery !== "unclaimed" ||
          old.receipt.state !== "pending" ||
          change.decision
        )
          throw unavailable();
        old.receipt.state = "superseded";
      } else if (
        b.currentRevisionId ||
        !change.decision ||
        change.decision.requestId !== b.target.requestId ||
        change.decision.stepRunId !== b.target.stepRunId ||
        change.decision.answer !== b.capability.actionId ||
        !isDeepStrictEqual(change.decision.actor, r.provenance.actor)
      )
        throw unavailable();
      operations.add(change.operationId);
    } else {
      const old = records.get(r.receipt.revisionId);
      if (
        !old ||
        b.currentRevisionId !== r.receipt.revisionId ||
        old.receipt.expectedRevision !== entry.expectedRevision ||
        r.receipt.expectedRevision === entry.expectedRevision ||
        !isDeepStrictEqual(old.payload, r.payload) ||
        !isDeepStrictEqual(old.provenance, r.provenance) ||
        !isDeepStrictEqual(old.receipt.target, r.receipt.target) ||
        old.supersedesRevisionId !== r.supersedesRevisionId
      )
        throw unavailable();
      const claim =
        old.delivery === "unclaimed" &&
        old.receipt.state === "pending" &&
        r.delivery === "claimed" &&
        r.receipt.state === "pending" &&
        r.handoffId &&
        r.prompt !== undefined;
      const settle =
        old.delivery === "claimed" &&
        ["confirmed", "uncertain"].includes(r.delivery) &&
        r.receipt.state === (r.delivery === "confirmed" ? "delivered" : "pending") &&
        old.handoffId === r.handoffId &&
        old.prompt === r.prompt;
      const reject =
        old.delivery === "unclaimed" &&
        old.receipt.state === "pending" &&
        r.delivery === "unclaimed" &&
        r.receipt.state === "rejected" &&
        r.handoffId === undefined &&
        r.prompt === undefined;
      if (!claim && !settle && !reject) throw unavailable();
    }
    records.set(r.receipt.revisionId, structuredClone(r));
    b.currentRevisionId = r.receipt.revisionId;
    b.target.expectedRevision = r.receipt.expectedRevision;
  }
}

export interface RevisionRuntimeOptions {
  stores: Stores;
  /** Live execution + run/resource + revision-content authorization; never a cached grant. */
  authorizeExecution(runId: string): Promise<void>;
  clock?: Clock;
  stale?: () => OrcaError;
}

export function createRevisionRuntime(options: RevisionRuntimeOptions) {
  const { stores } = options;
  const clock = options.clock ?? systemClock;
  const stale = options.stale ?? (() => new OrcaError("REVISION_STALE", "Revision destination is no longer available"));
  if (!stores.events.appendDurableUnique || !stores.events.synchronizeJournal)
    throw new OrcaError("NOT_SUPPORTED", "Revision runtime requires durable protected journal publication");
  const contexts = new AsyncLocalStorage<RunContext>();
  const owned = new AsyncLocalStorage<{ runId: string; active: boolean }>();
  // Only live contexts retain the selected attempt. Garbage collection bounds this by
  // attached interpreters, never all historical runs or a startup scan.
  const selected = new WeakMap<RunContext, Map<string, RevisionDeliveryTarget>>();

  const state = async (runId: string): Promise<RunState> =>
    reduceRun(await executionEvents(await stores.events.read(runId), stores.execution));
  const ensureOwned = (runId: string) => {
    if (owned.getStore()?.runId !== runId || !owned.getStore()?.active)
      throw new OrcaError("RUN_STATE", "Revision journal requires run ownership");
  };
  const withRun = async <T>(runId: string, work: () => Promise<T>): Promise<T> => {
    if (owned.getStore()?.active) {
      ensureOwned(runId);
      return work();
    }
    const fenced = async () => {
      const token = { runId, active: true };
      try {
        return await owned.run(token, work);
      } finally {
        token.active = false;
      }
    };
    const rc = contexts.getStore();
    if (rc) {
      if (rc.id !== runId || !rc.lease || rc.lease.resource !== `run:${runId}`) throw stale();
      return rc.withOwnership(fenced);
    }
    const holder = `revision:${randomUUID()}`;
    const lease = await stores.leases.acquire({ resource: `run:${runId}`, holder });
    if (lease.holder !== holder) throw new OrcaError("RUN_LEASED", "Run already has an execution owner");
    try {
      return await stores.leases.withOwnership(lease, fenced);
    } finally {
      await stores.leases.release(lease);
    }
  };
  const loadGuard = async (
    address: string,
    boundary: RevisionBoundary,
    expectedRevision: string,
    format: "shared" | "legacy" | "declaration",
  ): Promise<PublicationGuard | undefined> => {
    const value = await stores.execution.getGeneration(address);
    if (value === undefined) return undefined;
    const modern = publicationGuardSchema.safeParse(value);
    if (modern.success && format !== "legacy") {
      const {
        version: _version,
        kind: _kind,
        operationId: _operationId,
        correlation: _correlation,
        ...binding
      } = modern.data;
      if (!isDeepStrictEqual(binding, guardBinding(boundary, expectedRevision))) throw unavailable();
      return modern.data;
    }
    const legacy = legacyPublicationGuardSchema.safeParse(value);
    if (!legacy.success || format === "shared" || legacy.data.runId !== boundary.target.runId) throw unavailable();
    return legacy.data;
  };
  const versionGuards = async (boundary: RevisionBoundary, expectedRevision: string, revisionId?: string) => {
    const runId = boundary.target.runId;
    const destinationId = boundary.target.destinationId;
    // Legacy addresses cover evidence produced by the unpublished v1 implementation;
    // they are not a second index or a claim about deployed migration history.
    const guards = [
      await loadGuard(
        versionGuardAddress(runId, destinationId, expectedRevision),
        boundary,
        expectedRevision,
        "shared",
      ),
      await loadGuard(
        guardAddress([runId, "commit", destinationId, expectedRevision]),
        boundary,
        expectedRevision,
        "legacy",
      ),
      ...(revisionId
        ? [
            await loadGuard(
              guardAddress([runId, "transition", revisionId, expectedRevision]),
              boundary,
              expectedRevision,
              "legacy",
            ),
          ]
        : []),
    ];
    return guards.filter((guard): guard is PublicationGuard => guard !== undefined);
  };
  const validatePublicationHistory = async (runId: string, entries: RevisionJournalEntry[]) => {
    const frontiers = new Map<
      string,
      { boundary: RevisionBoundary; version: string; revisionId?: string; latest: RevisionJournalEntry }
    >();
    for (const entry of entries) {
      if (entry.kind === "boundary") {
        const b = entry.boundary;
        const guard = await loadGuard(publicationGuardId(runId, entry), b, b.target.expectedRevision, "declaration");
        if (guard && (!isDeepStrictEqual(guard.correlation, correlation(entry)) || guard.operationId !== undefined))
          throw publicationUncertain(entry, guard.operationId);
        frontiers.set(b.target.destinationId, { boundary: b, version: b.target.expectedRevision, latest: entry });
        continue;
      }
      const record = entry.kind === "commit" ? entry.change.record : entry.record;
      const frontier = frontiers.get(record.receipt.target.destinationId);
      if (
        !frontier ||
        frontier.version !== consumedVersion(entry) ||
        record.receipt.expectedRevision === frontier.version
      )
        throw unavailable();
      for (const guard of await versionGuards(frontier.boundary, frontier.version, frontier.revisionId)) {
        if (
          !isDeepStrictEqual(guard.correlation, correlation(entry)) ||
          guard.operationId !== record.provenance.operationId
        )
          throw publicationUncertain(entry, guard.operationId);
      }
      frontier.version = record.receipt.expectedRevision;
      frontier.revisionId = record.receipt.revisionId;
      frontier.latest = entry;
    }
    // A guard at the currently projected version has no matching advance marker.
    // Refuse the whole transaction before reads can advertise replacement, or a new
    // revision ID can launder a possibly-sent attempt into another claim.
    for (const frontier of frontiers.values()) {
      const guards = await versionGuards(frontier.boundary, frontier.version, frontier.revisionId);
      if (guards.length) throw publicationUncertain(frontier.latest, guards[0]!.operationId);
    }
  };
  const read = async (runId: string): Promise<RevisionJournalEntry[]> => {
    ensureOwned(runId);
    const events = await executionEvents(await stores.events.readTypes(runId, ["revision.recorded"]), stores.execution);
    const entries: RevisionJournalEntry[] = [];
    for (const event of events) {
      const entry = decode(event);
      await stores.events.synchronizeJournal!(runId, correlation(entry));
      entries.push(entry);
    }
    validateHistory(entries, runId);
    await validatePublicationHistory(runId, entries);
    return entries;
  };
  const promote = async (runId: string, secrets: unknown[]) => {
    ensureOwned(runId);
    const current = await state(runId);
    const material = {
      runId,
      workflowId: current.run.workflowId,
      workflowVersion: current.run.workflowVersion,
      vars: current.run.vars,
      sensitiveNames: [],
      secrets,
    };
    const rc = contexts.getStore();
    if (rc) {
      await rc.inheritSensitivityOwned(material);
      return;
    }
    let inputs = await stores.execution.getInputs(runId);
    if (!inputs) {
      await stores.execution.putInputs({ ...material, secrets: [] });
      inputs = await stores.execution.getInputs(runId);
    }
    if (!inputs) throw unavailable();
    const additions = secrets.filter((secret) => !inputs.secrets.some((prior) => isDeepStrictEqual(prior, secret)));
    if (additions.length) await stores.execution.addSensitivity(runId, { sensitiveNames: [], secrets: additions });
  };
  const status = async (runId: string, boundary: RevisionBoundary): Promise<RevisionBoundary["status"]> => {
    ensureOwned(runId);
    const current = await state(runId);
    if (current.run.status === "cancelled" || contexts.getStore()?.abort.signal.aborted) return "cancelled";
    const provenance = current.run.provenance;
    if (
      !provenance ||
      provenance.configGeneration !== boundary.generationId ||
      provenance.workflow.revision !== boundary.workflowRevision ||
      ["completed", "failed"].includes(current.run.status)
    )
      return "moved";
    const input = current.humanInputs[boundary.target.requestId];
    const source = current.steps[boundary.target.stepRunId];
    if (!input || !source || input.stepRunId !== source.id) return "moved";
    if (input.answer !== undefined && (!boundary.currentRevisionId || input.answer !== boundary.capability.actionId))
      return "moved";
    const sourceIndex = current.stepOrder.indexOf(source.id);
    for (const stepId of current.stepOrder.slice(sourceIndex + 1)) {
      const step = current.steps[stepId]!;
      if (stepId === boundary.attemptId) {
        if (
          step.nodeId !== boundary.capability.destinationNodeId ||
          ["failed", "cancelled", "completed", "skipped"].includes(step.status)
        )
          return "moved";
      } else if (step.nodeId !== source.nodeId) return "moved";
    }
    if (
      Object.values(current.humanInputs).some(
        (other) =>
          other.id !== input.id &&
          current.steps[other.stepRunId]?.nodeId === source.nodeId &&
          current.stepOrder.indexOf(other.stepRunId) > sourceIndex,
      )
    )
      return "moved";
    return boundary.currentRevisionId ? "answered" : "waiting";
  };
  const append = async (runId: string, entry: RevisionJournalEntry) => {
    ensureOwned(runId);
    envelopeSchema.parse({ version: 1, entry });
    const history = await read(runId);
    validateHistory([...history, entry], runId);
    const declared =
      entry.kind === "boundary"
        ? entry
        : history.find(
            (prior) =>
              prior.kind === "boundary" &&
              prior.boundary.target.destinationId ===
                (entry.kind === "commit" ? entry.change.record : entry.record).receipt.target.destinationId,
          );
    if (!declared || declared.kind !== "boundary") throw unavailable();
    const guard = guardFor(entry, declared.boundary);
    const record = entry.kind === "boundary" ? undefined : entry.kind === "commit" ? entry.change.record : entry.record;
    // Reuse the execution store's authenticated write-once material and key lifecycle.
    // This namespaced record is deliberately not a receipt or a second journal. The
    // public marker remains the sole acceptance evidence. If a prior attempted write
    // has no marker, even a restored backup must not recreate the gate answer/send.
    const guardId = publicationGuardId(runId, entry);
    if (entry.kind === "boundary") {
      // A missing declaration marker means its original random destination/attempt
      // cannot be reconstructed. Validate the surviving evidence, then refuse rather
      // than comparing it against the new IDs this attempted declaration allocated.
      const value = await stores.execution.getGeneration(guardId);
      if (value !== undefined) {
        const parsed = z.union([publicationGuardSchema, legacyPublicationGuardSchema]).safeParse(value);
        if (!parsed.success || parsed.data.runId !== runId) throw unavailable();
        throw publicationUncertain(entry, parsed.data.operationId);
      }
    } else {
      const previousGuard = await loadGuard(guardId, declared.boundary, consumedVersion(entry), "shared");
      if (previousGuard) throw publicationUncertain(entry, previousGuard.operationId);
    }
    await promote(
      runId,
      record
        ? [
            record.payload.kind === "text" ? record.payload.text : record.payload.values,
            ...(record.prompt !== undefined ? [record.prompt] : []),
          ]
        : [],
    );
    const input = {
      runId,
      type: "revision.recorded" as const,
      journal: correlation(entry),
      payload: { ...metadata(entry), entry: { version: 1, entry } },
    };
    await stores.execution.putGeneration(guardId, guard);
    // Verify material after durable publication; a response lost during this read still
    // leaves the guard blocking automatic recovery, rather than granting acceptance.
    if (!isDeepStrictEqual(await stores.execution.getGeneration(guardId), guard)) throw unavailable();
    const published = await stores.events.appendDurableUnique!(input, {
      expectedSeq: (await stores.events.lastSeq(runId)) ?? -1,
      correlation: input.journal,
      equivalent: (existing) => isDeepStrictEqual(decode(existing), entry),
    });
    // Durable publication bypasses rc.emit, so mirror its projection update exactly once.
    const rc = contexts.getStore();
    if (rc && published.seq > rc.state.lastSeq) {
      if (published.type !== "revision.recorded") throw unavailable();
      applyEvent(rc.state, { ...published, payload: input.payload });
      applyEvent(rc.publicState(), published);
    }
  };
  const log: RevisionLog = { withRun, read, append, status };
  const journal = new RunRevisionJournal(log, stale);
  const delivery = new RevisionDelivery({ journal, authorize: (runId) => options.authorizeExecution(runId), stale });
  const inContext = <T>(rc: RunContext, work: () => Promise<T>): Promise<T> => contexts.run(rc, work);
  const boundaries = async (runId: string) =>
    (await read(runId))
      .filter((entry): entry is Extract<RevisionJournalEntry, { kind: "boundary" }> => entry.kind === "boundary")
      .map((entry) => entry.boundary);

  const runtime: NonNullable<OrchestratorOptions["revisionRuntime"]> = {
    reserveStep: (rc, nodeId) =>
      inContext(rc, () =>
        withRun(rc.id, async () => {
          const candidates: RevisionDeliveryTarget[] = [];
          for (const initial of await boundaries(rc.id)) {
            if (initial.capability.destinationNodeId !== nodeId) continue;
            await journal.withRun(rc.id, async (tx) => {
              const boundary = await tx.boundary(initial.target.destinationId);
              if (!boundary?.currentRevisionId) return;
              const record = await tx.record(boundary.currentRevisionId);
              if (!record || record.receipt.state !== "pending") return;
              if (
                boundary.status !== "answered" ||
                record.delivery !== "unclaimed" ||
                rc.state.steps[boundary.attemptId]
              )
                throw stale();
              candidates.push({
                runId: rc.id,
                destinationId: boundary.target.destinationId,
                revisionId: record.receipt.revisionId,
                attemptId: boundary.attemptId,
                nodeId,
              });
            });
          }
          if (candidates.length > 1) throw stale();
          const candidate = candidates[0];
          if (!candidate) return undefined;
          const map = selected.get(rc) ?? new Map<string, RevisionDeliveryTarget>();
          map.set(candidate.attemptId, candidate);
          selected.set(rc, map);
          return candidate.attemptId;
        }),
      ),
    forStep: (rc, step) => {
      const node = rc.definition.nodes[step.nodeId];
      const capability = node && (node.type === "gate" || node.type === "decision") ? node.revision : undefined;
      const reserved = selected.get(rc)?.get(step.id);
      const bound = <T>(work: () => Promise<T>) => inContext(rc, work);
      const exact = (handoff: RevisionHandoff) => {
        if (!reserved || !isDeepStrictEqual(handoff.target, reserved)) throw stale();
      };
      return {
        ...(capability
          ? {
              declareRevision: (query) =>
                bound(() =>
                  withRun(rc.id, async () => {
                    if (
                      query.runId !== rc.id ||
                      query.stepRunId !== step.id ||
                      query.kind !== "decision" ||
                      !validateRevisionCapability(rc.definition, step.nodeId, capability).ok
                    )
                      throw stale();
                    const current = await state(rc.id);
                    const input = current.humanInputs[query.requestId];
                    const provenance = current.run.provenance;
                    if (
                      !input ||
                      input.stepRunId !== step.id ||
                      input.answer !== undefined ||
                      !provenance ||
                      !rc.lease ||
                      rc.abort.signal.aborted
                    )
                      throw stale();
                    const existing = (await boundaries(rc.id)).filter(
                      (boundary) => boundary.target.requestId === query.requestId,
                    );
                    if (existing.length) {
                      if (existing.length !== 1 || !isDeepStrictEqual(existing[0]!.capability, capability))
                        throw stale();
                      return;
                    }
                    await append(rc.id, {
                      kind: "boundary",
                      boundary: {
                        target: {
                          runId: rc.id,
                          stepRunId: step.id,
                          requestId: query.requestId,
                          destinationId: randomUUID(),
                          expectedRevision: randomUUID(),
                        },
                        capability,
                        destinationDescription: capability.destinationNodeId,
                        attemptId: newId("step", clock.now()),
                        generationId: provenance.configGeneration,
                        workflowRevision: provenance.workflow.revision,
                        status: "waiting",
                      },
                    });
                  }),
                ),
            }
          : {}),
        ...(reserved
          ? {
              revisionInput: {
                claim: (render) => bound(() => delivery.claim(reserved, render)),
                beforeSend: (handoff) => {
                  exact(handoff);
                  return bound(() => delivery.beforeSend(handoff));
                },
                confirm: (handoff) => {
                  exact(handoff);
                  return bound(() => delivery.confirm(handoff));
                },
                uncertain: (handoff) => {
                  exact(handoff);
                  return bound(() => delivery.uncertain(handoff));
                },
              },
            }
          : {}),
      };
    },
  };
  return {
    journal,
    runtime,
    /** Fresh-claim validation may only reuse an already-held fence, never acquire one. */
    assertRetryFence: ensureOwned,
    /** Trusted composition only: a refused run fence must not allocate a retry claim. */
    fenceRetries: (claims: Pick<RegisteredRetryClaims, "execute">): RetryClaims => ({
      execute: async (operation, command, retry, authority) => {
        if (operation.kind !== "revision.submit" && operation.kind !== "revision.replace")
          throw new OrcaError("RUN_STATE", "Retry operation is unavailable");
        // Snapshot intent before asynchronous authorization or lease acquisition. The
        // original registered operation instance is retained for the shared registry.
        const snapshot = validateRevisionCommand(command, operation.kind === "revision.replace") as typeof command;
        const { target } = snapshot as { target: { runId: string } };
        await authority.authorize(snapshot);
        return withRun(target.runId, async () => {
          await authority.authorize(snapshot);
          // prepare/recover/accepted-receipt verification re-enter this same internal
          // ownership context. No caller-supplied lease or alternate receipt is used.
          return claims.execute(operation, snapshot, retry, authority);
        });
      },
    }),
    /** Caller supplies authenticated read scope; this is not a public endpoint. */ readBoundaries: (runId: string) =>
      withRun(runId, async () => {
        const out: RevisionBoundary[] = [];
        for (const initial of await boundaries(runId))
          await journal.withRun(runId, async (tx) => {
            const boundary = await tx.boundary(initial.target.destinationId);
            if (boundary) out.push(boundary);
          });
        return out;
      }),
  };
}
