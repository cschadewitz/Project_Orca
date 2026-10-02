/** Fenced revision service. Bootstrap supplies the shared retry claims and protected run journal; no fallback store. */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  OrcaError,
  redactWorkflowInputSchema,
  RevisionCapabilitySchema,
  validateWorkflowInputs,
  type MutationActor,
} from "@orca/core";
import type { RegisteredRetryClaims } from "./admission-retry.js";
import type {
  RevisionBoundaryView,
  RevisionCapability,
  RevisionCommand,
  RevisionPayload,
  RevisionReceipt,
  RevisionProvenance,
  PendingRevisionTarget,
  PendingRevisionView,
  ReplacePendingRevisionCommand,
} from "../../core/src/model/revision-input.js";

// Structural #331 contracts: consolidated into its exports by the integration patch.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface RetryOptions {
  idempotencyKey?: string;
}
export interface RetryAuthority<C> {
  readonly principalId: string;
  readonly workspaceId: string;
  authorize(command: C): Promise<void>;
}
export interface RetryContext {
  readonly operationId: string;
  readBinding(): Promise<Record<string, JsonValue> | undefined>;
  bind(binding: Record<string, JsonValue>): Promise<void>;
  reauthorize(): Promise<void>;
}
export interface RetryOperation<C, R> {
  readonly kind: "revision.submit" | "revision.replace";
  canonicalize(command: C): JsonValue;
  validateFresh?(command: C): Promise<void>;
  prepare(command: C, context: RetryContext): Promise<R>;
  recover(command: C, context: RetryContext): Promise<R>;
}
export type RetryResult<R> =
  | { state: "resolved"; operationId: string; replayed: boolean; result: R }
  | { state: "in-progress"; operationId: string; recovery: "inspect-or-retry" };
export interface RetryClaims {
  execute<C, R>(
    operation: RetryOperation<C, R>,
    command: C,
    retry: RetryOptions,
    authority: RetryAuthority<C>,
  ): Promise<RetryResult<R>>;
}
export interface RevisionRecord {
  receipt: RevisionReceipt;
  payload: RevisionPayload;
  capability: RevisionCapability;
  provenance: RevisionProvenance;
  delivery: "unclaimed" | "claimed" | "confirmed" | "uncertain";
  supersedesRevisionId?: string;
  handoffId?: string;
  prompt?: string;
}
export interface RevisionBoundary extends RevisionBoundaryView {
  attemptId: string;
  generationId: string;
  workflowRevision: string;
  status: "waiting" | "answered" | "cancelled" | "moved";
  currentRevisionId?: string;
}
export interface RevisionCommit {
  operationId: string;
  record: RevisionRecord;
  supersedesRevisionId?: string;
  /** One journal append must project BOTH the correction and this exact gate answer. */
  decision?: { requestId: string; stepRunId: string; answer: string; actor: MutationActor };
}
export interface RevisionTransaction {
  boundary(destinationId: string): Promise<RevisionBoundary | undefined>;
  record(revisionId: string): Promise<RevisionRecord | undefined>;
  committed(operationId: string): Promise<RevisionReceipt | undefined>;
  /** Atomic durable append: protected payload first, then a single authoritative commit marker. */
  commit(change: RevisionCommit): Promise<void>;
  /** Atomic CAS advance, retaining the immutable payload/provenance and every transition. */
  transition(record: RevisionRecord, expectedRevision: string): Promise<void>;
}
export interface RevisionJournal {
  /** Same run ownership fence as ordinary answers, cancellation, dispatch and delivery; no process-local mutex. */
  withRun<T>(runId: string, work: (tx: RevisionTransaction) => Promise<T>): Promise<T>;
}
export interface RevisionAccess {
  readonly principalId: string;
  readonly workspaceId: string;
  /** Live actor lookup; returning payload requires both revision mutation grants as well as runs.read. */
  actor(): Promise<MutationActor>;
  read(runId: string): Promise<{ content: boolean; mutate: boolean }>;
  mutate(runId: string): Promise<void>;
}
export interface RevisionServiceOptions {
  journal: RevisionJournal;
  retries: RetryClaims;
  /** Trusted composition asserts an already-held runtime fence; it must never acquire one here. */
  assertRetryFence?: ((runId: string) => void) | undefined;
  access: RevisionAccess;
  /** Integrator injects OrcaError(REVISION_STALE); that enum is reserved on the frozen branch. */
  stale: () => OrcaError;
  now?: () => string;
}

/** Validated JSON only; deterministic map order, exact strings/arrays, bounded depth and bytes. */
export function revisionCanonical(value: unknown): JsonValue {
  const visit = (item: unknown, depth: number): JsonValue => {
    if (depth > 32) throw invalid();
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (
      item &&
      typeof item === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null)
    ) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, visit((item as Record<string, unknown>)[key], depth + 1)]),
      );
    }
    throw invalid();
  };
  const canonical = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(canonical)) > 262144) throw invalid();
  return canonical;
}
function invalid(): OrcaError {
  return new OrcaError("WORKFLOW_INPUT_INVALID", "Invalid or oversized revision input");
}
function keys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw invalid();
}
function strings(value: Record<string, unknown>, names: string[]): void {
  for (const name of names) if (typeof value[name] !== "string" || value[name].length === 0) throw invalid();
}
export function validateRevisionCommand(command: unknown, replace: boolean): JsonValue {
  const canonical = revisionCanonical(command);
  keys(
    command,
    replace ? ["target", "payload", "expectedRevision"] : ["target", "payload", "actionId"],
    replace ? [] : ["supersedesRevisionId"],
  );
  const fields = replace
    ? ["runId", "revisionId", "destinationId", "attemptId"]
    : ["runId", "stepRunId", "requestId", "destinationId", "expectedRevision"];
  keys(command.target, fields);
  strings(command.target, fields);
  strings(command, replace ? ["expectedRevision"] : ["actionId"]);
  if (command.supersedesRevisionId !== undefined) strings(command, ["supersedesRevisionId"]);
  validatePayload(command.payload);
  return canonical;
}
function validatePayload(payload: unknown): asserts payload is RevisionPayload {
  if (!payload || typeof payload !== "object") throw invalid();
  const kind = (payload as { kind?: unknown }).kind;
  if (kind === "text") {
    keys(payload, ["kind", "text"]);
    strings(payload, ["text"]);
  } else if (kind === "values") {
    keys(payload, ["kind", "values"]);
    if (!payload.values || typeof payload.values !== "object" || Array.isArray(payload.values)) throw invalid();
  } else throw invalid();
  revisionCanonical(payload);
  if (payloadBytes(payload as RevisionPayload) > 65536) throw invalid();
}
function payloadBytes(payload: RevisionPayload): number {
  return Buffer.byteLength(payload.kind === "text" ? payload.text : JSON.stringify(payload.values));
}
function applySchema(payload: RevisionPayload, capability: RevisionCapability): RevisionPayload {
  if (payload.kind !== capability.payload.kind || payloadBytes(payload) > capability.payload.maxBytes) throw invalid();
  if (payload.kind === "values" && capability.payload.kind === "values") {
    const result = validateWorkflowInputs({ vars: {}, inputSchema: capability.payload.inputSchema }, payload.values);
    if (!result.validation.ok) throw invalid();
    const resolved: RevisionPayload = { kind: "values", values: result.vars };
    validatePayload(resolved);
    if (payloadBytes(resolved) > capability.payload.maxBytes) throw invalid();
    return resolved;
  }
  return structuredClone(payload);
}

export class RevisionInputService {
  /** Register these two stable instances with #331 once at trusted bootstrap. */
  readonly submitOperation: RetryOperation<RevisionCommand, RevisionReceipt>;
  readonly replaceOperation: RetryOperation<ReplacePendingRevisionCommand, RevisionReceipt>;
  constructor(private readonly opts: RevisionServiceOptions) {
    this.submitOperation = this.operation(false);
    this.replaceOperation = this.operation(true);
  }
  private operation(replace: false): RetryOperation<RevisionCommand, RevisionReceipt>;
  private operation(replace: true): RetryOperation<ReplacePendingRevisionCommand, RevisionReceipt>;
  private operation(
    replace: boolean,
  ): RetryOperation<RevisionCommand | ReplacePendingRevisionCommand, RevisionReceipt> {
    const run = (command: RevisionCommand | ReplacePendingRevisionCommand, ctx: RetryContext) =>
      this.commit(command, ctx, replace);
    return {
      kind: replace ? "revision.replace" : "revision.submit",
      canonicalize: (command) => validateRevisionCommand(command, replace),
      ...(this.opts.assertRetryFence
        ? {
            validateFresh: async (command: RevisionCommand | ReplacePendingRevisionCommand) => {
              // The shared claim store calls this only after a key lookup misses, while
              // holding its catalog mutex. Never acquire a run fence in that lock order.
              this.opts.assertRetryFence!(command.target.runId);
              await this.opts.access.mutate(command.target.runId);
              await this.opts.journal.withRun(command.target.runId, async (tx) => {
                await this.validateCurrent(command, replace, tx);
                await this.opts.access.mutate(command.target.runId);
                this.opts.assertRetryFence!(command.target.runId);
              });
            },
          }
        : {}),
      prepare: run,
      recover: run,
    };
  }
  async submit(
    command: RevisionCommand,
    retry: RetryOptions,
    authority: RetryAuthority<RevisionCommand>,
  ): Promise<RetryResult<RevisionReceipt>> {
    await this.authorize(command, authority);
    validateRevisionCommand(command, false);
    return this.opts.retries.execute(this.submitOperation, structuredClone(command), retry, authority);
  }
  async replacePending(
    command: ReplacePendingRevisionCommand,
    retry: RetryOptions,
    authority: RetryAuthority<ReplacePendingRevisionCommand>,
  ): Promise<RetryResult<RevisionReceipt>> {
    await this.authorize(command, authority);
    validateRevisionCommand(command, true);
    return this.opts.retries.execute(this.replaceOperation, structuredClone(command), retry, authority);
  }
  private async authorize<C extends { target: { runId: string } }>(
    command: C,
    authority: RetryAuthority<C>,
  ): Promise<void> {
    if (
      authority.principalId !== this.opts.access.principalId ||
      authority.workspaceId !== this.opts.access.workspaceId
    )
      throw new OrcaError("RUN_STATE", "Revision authority does not match the authenticated service");
    await authority.authorize(command);
    await this.opts.access.mutate(command.target.runId);
  }
  /** Pure authoritative validation shared by fresh-claim preflight and the commit. */
  private async validateCurrent(
    command: RevisionCommand | ReplacePendingRevisionCommand,
    replace: boolean,
    tx: Pick<RevisionTransaction, "boundary" | "record">,
  ) {
    const boundary = await tx.boundary(command.target.destinationId);
    if (!boundary) throw new OrcaError("NOT_SUPPORTED", "This input has no revision destination");
    const old = boundary.currentRevisionId ? await tx.record(boundary.currentRevisionId) : undefined;
    const expected = replace
      ? (command as ReplacePendingRevisionCommand).expectedRevision
      : (command as RevisionCommand).target.expectedRevision;
    if (
      boundary.target.runId !== command.target.runId ||
      boundary.target.expectedRevision !== expected ||
      ["cancelled", "moved"].includes(boundary.status)
    )
      throw this.opts.stale();
    if (replace) {
      const target = (command as ReplacePendingRevisionCommand).target;
      if (!old || old.receipt.revisionId !== target.revisionId || boundary.attemptId !== target.attemptId)
        throw this.opts.stale();
    } else {
      const initial = command as RevisionCommand;
      if (
        initial.target.stepRunId !== boundary.target.stepRunId ||
        initial.target.requestId !== boundary.target.requestId ||
        initial.actionId !== boundary.capability.actionId
      )
        throw this.opts.stale();
      if (initial.supersedesRevisionId !== boundary.currentRevisionId) throw this.opts.stale();
      if (!old && boundary.status !== "waiting") throw this.opts.stale();
    }
    if (old && (old.delivery !== "unclaimed" || old.receipt.state !== "pending")) throw this.opts.stale();
    const payload = applySchema(command.payload, boundary.capability);
    return { boundary, old, payload };
  }
  private async commit(
    command: RevisionCommand | ReplacePendingRevisionCommand,
    context: RetryContext,
    replace: boolean,
  ): Promise<RevisionReceipt> {
    return this.opts.journal.withRun(command.target.runId, async (tx) => {
      await context.reauthorize();
      await this.opts.access.mutate(command.target.runId);
      const previous = await tx.committed(context.operationId);
      if (previous) return previous;
      const { boundary, old, payload } = await this.validateCurrent(command, replace, tx);
      let binding = await context.readBinding();
      if (!binding) {
        binding = {
          revisionId: randomUUID(),
          expectedRevision: randomUUID(),
          attemptId: boundary.attemptId,
          destinationId: command.target.destinationId,
        };
        await context.bind(binding);
      }
      if (
        typeof binding.revisionId !== "string" ||
        typeof binding.expectedRevision !== "string" ||
        binding.attemptId !== boundary.attemptId ||
        binding.destinationId !== command.target.destinationId
      )
        throw this.opts.stale();
      const actor = await this.opts.access.actor();
      if (actor.principalId !== this.opts.access.principalId) throw this.opts.stale();
      const receipt: RevisionReceipt = {
        revisionId: binding.revisionId,
        target: { ...boundary.target },
        state: "pending",
        attemptId: boundary.attemptId,
        currentRevisionId: binding.revisionId,
        expectedRevision: binding.expectedRevision,
      };
      const record: RevisionRecord = {
        receipt,
        payload,
        capability: boundary.capability,
        delivery: "unclaimed",
        provenance: {
          actor,
          workspaceId: this.opts.access.workspaceId,
          operationId: context.operationId,
          source: "human-revision",
          recordedAt: this.opts.now?.() ?? new Date().toISOString(),
        },
        ...(old ? { supersedesRevisionId: old.receipt.revisionId } : {}),
      };
      await context.reauthorize();
      await this.opts.access.mutate(command.target.runId);
      await tx.commit({
        operationId: context.operationId,
        record,
        ...(old
          ? { supersedesRevisionId: old.receipt.revisionId }
          : {
              decision: {
                requestId: boundary.target.requestId,
                stepRunId: boundary.target.stepRunId,
                answer: boundary.capability.actionId,
                actor,
              },
            }),
      });
      return receipt;
    });
  }
  async readPending(target: PendingRevisionTarget): Promise<PendingRevisionView> {
    await this.opts.access.read(target.runId);
    return this.opts.journal.withRun(target.runId, async (tx) => {
      const access = await this.opts.access.read(target.runId);
      const record = await exactRevision(tx, target, this.opts.stale);
      const boundary = await tx.boundary(target.destinationId);
      // A prior content grant does not survive an asynchronous journal/status read.
      // Intersect both checks so a viewer cannot gain protected data mid-request either.
      const currentAccess = await this.opts.access.read(target.runId);
      const content = access.content && currentAccess.content;
      const capability = RevisionCapabilitySchema.safeParse(record.capability);
      const matchingBoundary =
        boundary &&
        boundary.currentRevisionId === target.revisionId &&
        boundary.attemptId === target.attemptId &&
        boundary.target.runId === target.runId &&
        boundary.target.destinationId === target.destinationId &&
        boundary.target.stepRunId === record.receipt.target.stepRunId &&
        boundary.target.requestId === record.receipt.target.requestId &&
        boundary.target.expectedRevision === record.receipt.expectedRevision &&
        isDeepStrictEqual(boundary.capability, record.capability) &&
        capability.success;
      const unavailableReason =
        record.receipt.state === "delivered"
          ? "delivered"
          : record.receipt.state === "rejected"
            ? "cancelled"
            : record.delivery !== "unclaimed"
              ? "delivery-uncertain"
              : !matchingBoundary || boundary.status === "moved" || record.receipt.state === "superseded"
                ? "target-changed"
                : boundary.status === "cancelled"
                  ? "cancelled"
                  : undefined;
      const replacementAllowed = content && access.mutate && currentAccess.mutate && unavailableReason === undefined;
      // Explicit projection only. The pinned declaration supplies every destination and
      // constraint; journal provenance and private generation identifiers stay internal.
      const view: RevisionBoundaryView | undefined =
        replacementAllowed && boundary && capability.success
          ? {
              target: {
                runId: boundary.target.runId,
                stepRunId: boundary.target.stepRunId,
                requestId: boundary.target.requestId,
                destinationId: boundary.target.destinationId,
                expectedRevision: boundary.target.expectedRevision,
              },
              capability: {
                actionId: capability.data.actionId,
                destinationNodeId: capability.data.destinationNodeId,
                composition: capability.data.composition,
                payload:
                  capability.data.payload.kind === "values"
                    ? {
                        kind: "values",
                        maxBytes: capability.data.payload.maxBytes,
                        inputSchema: redactWorkflowInputSchema(capability.data.payload.inputSchema),
                      }
                    : { kind: "text", maxBytes: capability.data.payload.maxBytes },
              },
              destinationDescription: boundary.destinationDescription,
            }
          : undefined;
      return {
        target,
        expectedRevision: record.receipt.expectedRevision,
        state:
          boundary?.status === "cancelled" && record.delivery === "unclaimed" && record.receipt.state === "pending"
            ? "rejected"
            : record.receipt.state,
        ...(content ? { payload: record.payload } : {}),
        ...(view ? { boundary: view } : {}),
        replacementAllowed,
        ...(unavailableReason ? { unavailableReason } : {}),
      };
    });
  }
}
export async function exactRevision(
  tx: RevisionTransaction,
  target: PendingRevisionTarget,
  stale: () => OrcaError,
): Promise<RevisionRecord> {
  const record = await tx.record(target.revisionId);
  if (
    !record ||
    record.receipt.target.runId !== target.runId ||
    record.receipt.target.destinationId !== target.destinationId ||
    record.receipt.attemptId !== target.attemptId
  )
    throw stale();
  return record;
}

/** The payload of one protected revision journal event. Append-only history is the authority, projections are disposable. */
export type RevisionJournalEntry =
  | { kind: "boundary"; boundary: RevisionBoundary }
  | { kind: "commit"; change: RevisionCommit }
  | { kind: "transition"; record: RevisionRecord; expectedRevision: string };
export interface RevisionLog {
  /** Must retain/recheck the runtime's actual lease. The adapter is shared with cancellation and interpreter writes. */
  withRun<T>(runId: string, work: () => Promise<T>): Promise<T>;
  read(runId: string): Promise<RevisionJournalEntry[]>;
  /** Protected payload and public allowlisted marker; a commit marker also projects change.decision as the gate answer. */
  append(runId: string, entry: RevisionJournalEntry): Promise<void>;
  /** Current authoritative cancellation/target movement, including ordinary gate answers. */
  status(runId: string, boundary: RevisionBoundary): Promise<RevisionBoundary["status"]>;
}

/** Production projection over the existing protected event log, with no second payload store or key lifecycle. */
export class RunRevisionJournal implements RevisionJournal {
  constructor(
    private readonly log: RevisionLog,
    private readonly stale: () => OrcaError,
  ) {}
  withRun<T>(runId: string, work: (tx: RevisionTransaction) => Promise<T>): Promise<T> {
    return this.log.withRun(runId, async () => {
      const boundaries = new Map<string, RevisionBoundary>();
      const records = new Map<string, RevisionRecord>();
      const operations = new Map<string, RevisionReceipt>();
      const apply = (entry: RevisionJournalEntry) => {
        if (entry.kind === "boundary") {
          if (boundaries.has(entry.boundary.target.destinationId)) throw this.stale();
          boundaries.set(entry.boundary.target.destinationId, structuredClone(entry.boundary));
          return;
        }
        const record = entry.kind === "commit" ? entry.change.record : entry.record;
        const boundary = boundaries.get(record.receipt.target.destinationId);
        if (!boundary || record.receipt.target.runId !== runId || record.receipt.attemptId !== boundary.attemptId)
          throw this.stale();
        if (entry.kind === "commit") {
          const change = entry.change;
          if (operations.has(change.operationId) || records.has(record.receipt.revisionId)) throw this.stale();
          if (boundary.target.expectedRevision !== record.receipt.target.expectedRevision) throw this.stale();
          if (change.supersedesRevisionId) {
            const previous = records.get(change.supersedesRevisionId);
            if (
              !previous ||
              boundary.currentRevisionId !== change.supersedesRevisionId ||
              previous.delivery !== "unclaimed" ||
              previous.receipt.state !== "pending" ||
              change.decision
            )
              throw this.stale();
            records.set(change.supersedesRevisionId, {
              ...previous,
              receipt: {
                ...previous.receipt,
                state: "superseded",
                currentRevisionId: record.receipt.revisionId,
                expectedRevision: record.receipt.expectedRevision,
              },
            });
          } else {
            if (
              boundary.currentRevisionId ||
              boundary.status !== "waiting" ||
              !change.decision ||
              change.decision.requestId !== boundary.target.requestId ||
              change.decision.stepRunId !== boundary.target.stepRunId ||
              change.decision.answer !== boundary.capability.actionId
            )
              throw this.stale();
            boundary.status = "answered";
          }
          operations.set(change.operationId, structuredClone(record.receipt));
        } else if (records.get(record.receipt.revisionId)?.receipt.expectedRevision !== entry.expectedRevision)
          throw this.stale();
        records.set(record.receipt.revisionId, structuredClone(record));
        boundary.currentRevisionId = record.receipt.revisionId;
        boundary.target.expectedRevision = record.receipt.expectedRevision;
      };
      for (const entry of await this.log.read(runId)) apply(entry);
      const append = async (entry: RevisionJournalEntry) => {
        // Validate the projection first. On a failed append this transaction is abandoned;
        // every next caller replays the actual durable log, including response-loss commits.
        apply(entry);
        await this.log.append(runId, structuredClone(entry));
      };
      return work({
        boundary: async (id) => {
          const boundary = boundaries.get(id);
          if (!boundary) return undefined;
          return { ...structuredClone(boundary), status: await this.log.status(runId, boundary) };
        },
        record: async (id) => structuredClone(records.get(id)),
        committed: async (id) => structuredClone(operations.get(id)),
        commit: (change) => append({ kind: "commit", change }),
        transition: (record, expectedRevision) => append({ kind: "transition", record, expectedRevision }),
      });
    });
  }
}

/** Internal composition seam: cached claims never substitute for the authoritative revision commit. */
export function registerRevisionInputOperation<C extends RevisionCommand | ReplacePendingRevisionCommand>(
  claims: Pick<RegisteredRetryClaims, "register">,
  operation: RetryOperation<C, RevisionReceipt>,
  journal: RevisionJournal,
  authorize?: (command: C, binding: Record<string, JsonValue> | undefined) => Promise<void>,
): RetryOperation<C, RevisionReceipt> {
  claims.register(operation, authorize, (command, binding, result, operationId) =>
    journal.withRun(command.target.runId, async (tx) => {
      // The journal acquires run ownership and synchronizes its public markers before
      // exposing committed receipts. Recheck live grants after waiting for that fence.
      await authorize?.(command, binding);
      const receipt = await tx.committed(operationId);
      if (
        !receipt ||
        !isDeepStrictEqual(receipt, result) ||
        !isDeepStrictEqual(binding, {
          revisionId: receipt.revisionId,
          expectedRevision: receipt.expectedRevision,
          attemptId: receipt.attemptId,
          destinationId: receipt.target.destinationId,
        }) ||
        receipt.state !== "pending" ||
        receipt.currentRevisionId !== receipt.revisionId ||
        receipt.target.runId !== command.target.runId ||
        receipt.target.destinationId !== command.target.destinationId ||
        ("actionId" in command
          ? !isDeepStrictEqual(receipt.target, command.target)
          : receipt.target.expectedRevision !== command.expectedRevision ||
            receipt.attemptId !== command.target.attemptId)
      )
        throw new OrcaError(
          "RUN_STATE",
          "Revision receipt is uncertain; its authoritative marker is unavailable or inconsistent",
          { reason: "revision-publication-uncertain", operationId },
        );
    }),
  );
  return operation;
}

/** One trusted registration per operation kind, with request-scoped live authority. Background recovery must enter forAccess too. */
export function createRevisionInputServices(options: Omit<RevisionServiceOptions, "access">) {
  const scope = new AsyncLocalStorage<RevisionAccess>();
  const current = (): RevisionAccess => {
    const access = scope.getStore();
    if (!access) throw new OrcaError("RUN_STATE", "Revision operation has no authenticated scope");
    return access;
  };
  const service = new RevisionInputService({
    ...options,
    access: {
      get principalId() {
        return current().principalId;
      },
      get workspaceId() {
        return current().workspaceId;
      },
      actor: () => current().actor(),
      read: (runId) => current().read(runId),
      mutate: (runId) => current().mutate(runId),
    },
  });
  return {
    operations: [service.submitOperation, service.replaceOperation] as const,
    register: (claims: Pick<RegisteredRetryClaims, "register">): void => {
      const authorize = (command: { target: { runId: string } }) => current().mutate(command.target.runId);
      registerRevisionInputOperation(claims, service.submitOperation, options.journal, authorize);
      registerRevisionInputOperation(claims, service.replaceOperation, options.journal, authorize);
    },
    forAccess: (access: RevisionAccess): Pick<RevisionInputService, "submit" | "readPending" | "replacePending"> => ({
      submit: (command, retry, authority) => scope.run(access, () => service.submit(command, retry, authority)),
      replacePending: (command, retry, authority) =>
        scope.run(access, () => service.replacePending(command, retry, authority)),
      readPending: (target) => scope.run(access, () => service.readPending(target)),
    }),
  };
}
