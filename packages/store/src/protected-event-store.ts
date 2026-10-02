/** Public event facade: save secret-bearing originals privately before publishing a scrubbed durable event. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  OrcaError,
  sensitiveInputNames,
  OrcaEventSchema,
  EventJournalCorrelationSchema,
  type EventJournalCorrelation,
  HumanInputLiveIdentitySchema,
  type OrcaEvent,
  type OrcaEventInput,
} from "@orca/core";
import type { WorkflowVersionStore } from "./workflow-store.js";
import type { DurableEventAppend, EventFilter, EventListener, EventRange, EventStore } from "./event-store.js";
import { publicInputVars, redactExecutionValue, unavailable, type ExecutionStore } from "./execution-store.js";

export class ProtectedEventStore implements EventStore {
  private readonly publicOnlyRuns = new Set<string>();
  constructor(
    private readonly publicEvents: EventStore,
    private readonly execution: ExecutionStore,
    private readonly workflows?: WorkflowVersionStore,
  ) {}

  /** Known typed plaintext histories require explicit migration, including inherited legacy children. */
  private async requireSafeLegacy(runId: string, created?: OrcaEventInput): Promise<void> {
    if (!this.workflows) return;
    let first = created?.type === "run.created" ? created : (await this.publicEvents.readRange(runId, { limit: 1 }))[0];
    if (first?.type !== "run.created" || first.payload.executionInputsStored) return;
    // A parent promoted after a sensitive child has a private input record and protected
    // suffix, despite its originally ordinary run.created. The integrity guard checks it.
    if (await this.execution.getInputs(runId)) return;
    const seen = new Set<string>();
    const refuse = () =>
      new OrcaError("RUN_STATE", "legacy sensitive execution requires explicit migration before reading or resuming");
    while (first?.type === "run.created") {
      if (seen.has(first.runId)) throw unavailable();
      seen.add(first.runId);
      const { workflowId, workflowVersion } = first.payload;
      const parentRunId: string | undefined = first.payload.parentRunId;
      // Inline definitions are stored only under their enclosing registered root.
      const definition =
        (await this.workflows.get(workflowId, workflowVersion)) ??
        (workflowId.includes("::") ? await this.workflows.get(workflowId.split("::")[0]!, workflowVersion) : undefined);
      if (definition && sensitiveInputNames(definition.inputSchema).length > 0) throw refuse();
      if (!parentRunId) break;
      first = (await this.publicEvents.readRange(parentRunId, { limit: 1 }))[0];
    }
  }

  /** The latest authenticated payload seals every sensitivity overlay used by this run. */
  private async requireIntegrity(runId: string): Promise<void> {
    const latest = (await this.publicEvents.readRange(runId, { before: Number.MAX_SAFE_INTEGER, limit: 1 }))[0];
    if (latest?.executionPayloadRef) {
      await this.execution.getPayload(runId, latest.executionPayloadRef, latest.type);
      return;
    }
    const first = (await this.publicEvents.readRange(runId, { limit: 1 }))[0];
    if (
      first?.type === "run.created" &&
      first.payload.executionInputsStored &&
      !(await this.execution.getInputs(runId))
    )
      throw unavailable();
  }

  /** Inspection confirms durability without allocating another private payload or public marker. */
  async synchronizeJournal(runId: string, correlation: EventJournalCorrelation): Promise<void> {
    if (!this.publicEvents.synchronizeJournal)
      throw new OrcaError("NOT_SUPPORTED", "this event store has no journal synchronization");
    const expected = EventJournalCorrelationSchema.parse(correlation);
    const authenticate = async () => {
      await this.requireSafeLegacy(runId);
      await this.requireIntegrity(runId);
      const events = await this.publicEvents.readRange(runId, {
        limit: 2,
        match: (event) =>
          event.journal?.kind === expected.kind &&
          event.journal.id === expected.id &&
          event.journal.revision === expected.revision,
      });
      const event = events[0];
      if (
        events.length !== 1 ||
        !event ||
        event.runId !== runId ||
        event.type !== `${expected.kind}.recorded` ||
        !event.executionPayloadRef
      )
        throw unavailable();
      const [restored] = await executionEvents([event], this.execution);
      if (
        !restored ||
        (restored.type !== "continuation.recorded" && restored.type !== "revision.recorded") ||
        !restored.payload.entry
      )
        throw unavailable();
      return restored;
    };
    const before = await authenticate();
    await this.publicEvents.synchronizeJournal(runId, expected);
    // Fail closed if either the immutable marker or current key/material changed while
    // syncing. This is not authority to recover a missing marker from private records.
    if (!isDeepStrictEqual(before, await authenticate())) throw unavailable();
  }

  /** Only journal adapters under the run fence may publish an authoritative acceptance marker. */
  async appendDurableUnique(input: OrcaEventInput, options: DurableEventAppend): Promise<OrcaEvent> {
    if (!this.publicEvents.appendDurableUnique)
      throw new OrcaError("NOT_SUPPORTED", "this event store has no durable journal publication");
    if (input.type !== "revision.recorded" && input.type !== "continuation.recorded")
      throw new OrcaError("NOT_SUPPORTED", "durable journal publication requires a journal event");
    const inputs = await this.execution.getInputs(input.runId);
    if (!inputs || !input.payload.entry) throw unavailable();
    await this.requireSafeLegacy(input.runId);
    await this.requireIntegrity(input.runId);
    const executionPayloadRef = randomUUID();
    await this.execution.putPayload(executionPayloadRef, input);
    const { entry: _entry, ...metadata } = input.payload;
    return this.publicEvents.appendDurableUnique(
      { ...input, payload: metadata, executionPayloadRef } as OrcaEventInput,
      {
        ...options,
        equivalent: async (existing) => {
          if (!existing.executionPayloadRef || existing.type !== input.type) return false;
          const [restored] = await executionEvents([existing], this.execution);
          return restored !== undefined && (await options.equivalent(restored));
        },
      },
    );
  }

  async append(input: OrcaEventInput): Promise<OrcaEvent> {
    const inputs = await this.execution.getInputs(input.runId);
    if (input.type === "revision.recorded" || input.type === "continuation.recorded") {
      // Revision material is always private, including on otherwise non-sensitive runs.
      // Runtime boundary setup must promote inputs through the existing protected store.
      if (!inputs || !input.payload.entry) throw unavailable();
      const executionPayloadRef = randomUUID();
      await this.execution.putPayload(executionPayloadRef, input);
      const { entry: _entry, ...metadata } = input.payload;
      return this.publicEvents.append({ ...input, payload: metadata, executionPayloadRef } as OrcaEventInput);
    }
    if (!inputs) {
      if (!this.publicOnlyRuns.has(input.runId)) {
        await this.requireSafeLegacy(input.runId, input);
        const first =
          input.type === "run.created" ? input : (await this.publicEvents.readRange(input.runId, { limit: 1 }))[0];
        const latest = (
          await this.publicEvents.readRange(input.runId, { before: Number.MAX_SAFE_INTEGER, limit: 1 })
        )[0];
        if ((first?.type === "run.created" && first.payload.executionInputsStored) || latest?.executionPayloadRef)
          throw unavailable();
        if (this.publicOnlyRuns.size >= 256) this.publicOnlyRuns.clear();
        this.publicOnlyRuns.add(input.runId);
      }
      return this.publicEvents.append(input);
    }
    this.publicOnlyRuns.delete(input.runId);
    const previous = (await this.publicEvents.readRange(input.runId, { before: Number.MAX_SAFE_INTEGER, limit: 1 }))[0];
    if (previous?.executionPayloadRef)
      await this.execution.getPayload(input.runId, previous.executionPayloadRef, previous.type);
    const payload = redactExecutionValue(input.payload, inputs.secrets);
    // Structural identifiers, enum tags and counters are runtime metadata, not free-form
    // values. Coincidental matches (a secret of "a", true or 1) must not corrupt replay.
    const original = input.payload as Record<string, unknown>;
    const publicPayload = payload as Record<string, unknown>;
    for (const key of [
      "actor",
      "workflowId",
      "workflowVersion",
      // Provenance is schema-limited metadata with all input values already withheld.
      "provenance",
      "requestId",
      "workItemId",
      "parentRunId",
      "parentStepRunId",
      "stepRunId",
      "nodeId",
      "nodeType",
      "childRunId",
      "agentId",
      "hostId",
      "sessionId",
      "artifactId",
      "artifactIds",
      "inputArtifactIds",
      "attempt",
      "iteration",
      "followUp",
      "durationMs",
      "willRetry",
      "resumed",
      "workflowStored",
      "executionInputsStored",
      "outcome",
      "status",
      "choice",
    ])
      if (Object.hasOwn(original, key)) publicPayload[key] = original[key];
    for (const key of ["context", "raw", "item"])
      if (Object.hasOwn(original, key)) publicPayload[key] = redactExecutionValue(original[key], inputs.secrets, true);
    if (original.error && publicPayload.error) {
      const error = original.error as Record<string, unknown>;
      const publicError = publicPayload.error as Record<string, unknown>;
      publicError.code = error.code;
      if (error.details) publicError.details = redactExecutionValue(error.details, inputs.secrets, true);
    }
    if (input.type === "human.requested") {
      publicPayload.kind = input.payload.kind;
      // Only the typed runtime identity is structural. Never restore arbitrary
      // context (including context.liveDecision) or extra properties from this object.
      if (input.payload.liveDecision)
        publicPayload.liveDecision = HumanInputLiveIdentitySchema.parse(input.payload.liveDecision);
      if (input.payload.agent) publicPayload.agent = input.payload.agent;
      const options = publicPayload.options as Record<string, unknown>[];
      input.payload.options.forEach((option, index) => {
        options[index]!.id = option.id;
        if (option.destructive !== undefined) options[index]!.destructive = option.destructive;
      });
    }
    if (input.type === "human.answered") {
      const requests = await this.publicEvents.readTypes(input.runId, ["human.requested"]);
      const matching = requests.findLast(
        (event) => event.type === "human.requested" && event.payload.requestId === input.payload.requestId,
      );
      if (
        matching?.type === "human.requested" &&
        matching.payload.options.some((option) => option.id === input.payload.answer)
      )
        publicPayload.answer = input.payload.answer;
    }
    if (input.type === "branch.skipped") publicPayload.reason = input.payload.reason;
    if (input.type === "step.completed") {
      const result = publicPayload.result as Record<string, unknown>;
      if (input.payload.result.outcome) result.outcome = input.payload.result.outcome;
      result.artifactIds = input.payload.result.artifactIds;
      if (input.payload.result.choice !== undefined) result.choice = input.payload.result.choice;
      result.data = redactExecutionValue(input.payload.result.data, inputs.secrets, true);
    }
    if (input.type === "artifact.recorded") {
      const artifact = publicPayload.artifact as Record<string, unknown>;
      for (const key of ["id", "kind", "version", "size", "contentHash", "createdAt", "producedBy", "parents"] as const)
        artifact[key] = input.payload.artifact[key];
      artifact.data = redactExecutionValue(input.payload.artifact.data, inputs.secrets, true);
    }
    if (input.type === "agent.update") {
      const update = publicPayload.update as Record<string, unknown>;
      for (const field of ["args", "result"] as const)
        if (input.payload.update[field])
          (update[field] as Record<string, unknown>).length = input.payload.update[field].length;
      for (const key of ["kind", "toolCallId", "status", "toolKind"] as const)
        if (Object.hasOwn(input.payload.update, key)) update[key] = input.payload.update[key];
    }
    if (input.type === "run.created") {
      const workspace = publicPayload.workspace as Record<string, unknown>;
      workspace.hostId = input.payload.workspace.hostId;
      if (input.payload.workspace.provider !== undefined) workspace.provider = input.payload.workspace.provider;
    }
    if (input.type === "step.scheduled" && input.payload.viaEdge) {
      const viaEdge = publicPayload.viaEdge as Record<string, unknown>;
      viaEdge.from = input.payload.viaEdge.from;
    }
    if (input.type === "vars.set") publicPayload.vars = publicInputVars({ ...inputs, vars: input.payload.vars });
    if (input.type === "run.created")
      Object.assign(payload, { vars: publicInputVars(inputs), executionInputsStored: true });
    // A future field must fail closed rather than persist a projection that readers cannot parse.
    if (!OrcaEventSchema.safeParse({ ...input, payload, id: "projection", seq: 0, at: "projection" }).success)
      throw new OrcaError("RUN_STATE", "sensitive event projection could not be represented safely");
    const executionPayloadRef = randomUUID();
    await this.execution.putPayload(executionPayloadRef, input);
    return this.publicEvents.append({ ...input, payload, executionPayloadRef } as OrcaEventInput);
  }
  async read(runId: string): Promise<OrcaEvent[]> {
    await this.requireSafeLegacy(runId);
    await this.requireIntegrity(runId);
    return this.publicEvents.read(runId);
  }
  async readTypes(runId: string, types: readonly OrcaEvent["type"][]): Promise<OrcaEvent[]> {
    await this.requireSafeLegacy(runId);
    await this.requireIntegrity(runId);
    return this.publicEvents.readTypes(runId, types);
  }
  async readRange(runId: string, range?: EventRange): Promise<OrcaEvent[]> {
    await this.requireSafeLegacy(runId);
    await this.requireIntegrity(runId);
    return this.publicEvents.readRange(runId, range);
  }
  lastSeq(runId: string): Promise<number | undefined> {
    return this.publicEvents.lastSeq(runId);
  }
  listRuns(): Promise<string[]> {
    return this.publicEvents.listRuns();
  }
  subscribe(listener: EventListener, filter?: EventFilter): () => void {
    return this.publicEvents.subscribe(listener, filter);
  }
}

/** Only the interpreter calls this. Public readers and subscriptions always use the public log. */
export async function executionEvents(events: OrcaEvent[], execution: ExecutionStore): Promise<OrcaEvent[]> {
  const references = events.flatMap((event) =>
    event.executionPayloadRef ? [{ runId: event.runId, ref: event.executionPayloadRef, type: event.type }] : [],
  );
  const payloads = execution.getPayloads
    ? await execution.getPayloads(references)
    : await Promise.all(references.map(({ runId, ref, type }) => execution.getPayload(runId, ref, type)));
  if (payloads.length !== references.length) throw unavailable();
  let index = 0;
  return events.map((event) => {
    if (!event.executionPayloadRef) return event;
    const restored = OrcaEventSchema.safeParse({ ...event, payload: payloads[index++] });
    if (!restored.success) throw unavailable();
    return restored.data;
  });
}
