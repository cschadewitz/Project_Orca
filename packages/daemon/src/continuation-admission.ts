/** Authenticated, protected continuation admission. A locator is never an acceptance record. */
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { OrcaError, applyEvent, reduceRun, type OrcaEvent, type RunState } from "@orca/core";
import { executionEvents, ownsLease } from "@orca/store";
import type { ExecutionResumeAuthority, Orchestrator } from "@orca/engine";
import { workflowRevision, canonicalJson, type RegisteredRetryClaims } from "@orca/engine";
import {
  ContinuationAdmissionService,
  ContinuationCommandSchema,
  type ContinuationCommit,
  type ContinuationEntry,
} from "@orca/engine";
import type { ContinuationCommand, ContinuationReceipt } from "../../core/src/model/continuation-admission.js";
import type { RetryAuthority, RetryOptions } from "../../core/src/model/admission-retry.js";
import type { Authorizer } from "./auth/guard.js";
import { holds, type Principal } from "./auth/principal.js";
import { authForbidden } from "./auth/errors.js";

export interface ContinuationAccess {
  current(): Promise<Principal>;
  workspaceId: string;
  authorizer: Authorizer;
  executionAuthority?: ExecutionResumeAuthority | undefined;
}
export interface ContinuationLocator {
  schemaVersion: 1;
  operationId: string;
  continuationId: string;
  runId: string;
  principalId: string;
  workspaceId: string;
}
export interface ContinuationLocators {
  bind(locator: ContinuationLocator): Promise<void>;
  read(continuationId: string): Promise<ContinuationLocator | undefined>;
  batch?(): Promise<ContinuationLocator[]>;
}
interface Scope {
  access: ContinuationAccess;
  principalId: string;
  grant: "runs.read" | "runs.control";
}
type Boundary = ContinuationEntry["boundary"];
const unavailable = () => new OrcaError("RUN_STATE", "Continuation is unavailable");
const stale = () => new OrcaError("CONTINUATION_STALE", "Continuation boundary has changed");
const EntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("continuation"),
  revision: z.number().int().nonnegative(),
  receipt: z.strictObject({
    operationId: z.string().min(1),
    continuationId: z.string().min(1),
    runId: z.string().min(1),
    expectedBoundary: z.string().min(1),
    state: z.enum(["prepared", "accepted", "blocked", "settled"]),
    blockedReason: z.enum(["authority-unavailable", "leased", "unsafe-boundary", "generation-unavailable"]).optional(),
  }),
  command: ContinuationCommandSchema,
  principalId: z.string().min(1),
  workspaceId: z.string().min(1),
  actor: z.strictObject({ principalId: z.string().min(1), credentialId: z.string().min(1).optional() }).optional(),
  boundary: z.strictObject({
    eventId: z.string().min(1),
    eventSeq: z.number().int().nonnegative(),
    workflowId: z.string().min(1),
    workflowVersion: z.string().min(1),
    workflowRevision: z.string().min(1),
    configGeneration: z.string().min(1),
    stepRunId: z.string().min(1),
    attemptId: z.string().min(1),
    requestId: z.string().min(1),
    revisionId: z.string().min(1).optional(),
  }),
  dispatch: z.enum(["needed", "attached", "settled", "ambiguous"]),
});

const PAGE = 256;
const MAX_EVENTS = 100_000;

function authorityUnavailable(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  return code.startsWith("AUTH_") || (error instanceof OrcaError && error.details?.executionResumeRequired === true);
}

export class ContinuationAdmissionModel {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly service: ContinuationAdmissionService;
  private readonly tasks = new Set<Promise<void>>();
  constructor(
    private readonly options: {
      claims: RegisteredRetryClaims;
      orchestrator: Orchestrator;
      locators: ContinuationLocators;
      /** Deterministic scheduler injection for tests; production defaults to setImmediate. */
      schedule?(work: () => void): void;
      executionRuntime: {
        checkResumeAuthority(runId: string, authority: ExecutionResumeAuthority | undefined): Promise<void>;
        withResumeAuthority(
          runId: string,
          authority: ExecutionResumeAuthority | undefined,
          operation: () => Promise<RunState>,
        ): Promise<RunState>;
      };
    },
  ) {
    this.service = new ContinuationAdmissionService({
      retries: options.claims,
      journal: { read: (id) => this.read(id), commit: (input, check) => this.commit(input, check) },
      runtime: {
        authorizeRead: (entry) => this.authorize(entry.receipt.runId, "runs.read"),
        reconcile: (entry, authority) => this.attach(entry, authority),
      },
    });
  }
  private get stores() {
    return this.options.orchestrator.stores;
  }
  private context(): Scope {
    const scope = this.scope.getStore();
    if (!scope) throw authForbidden();
    return scope;
  }
  private async scoped<T>(
    access: ContinuationAccess,
    work: () => Promise<T>,
    grant: "runs.read" | "runs.control" = "runs.read",
  ): Promise<T> {
    const principal = await access.current();
    return this.scope.run({ access, principalId: principal.id, grant }, work);
  }
  private async authorize(runId: string, grant: "runs.read" | "runs.control", decision = false): Promise<void> {
    const { access, principalId } = this.context();
    const current = await access.current();
    if (
      current.id !== principalId ||
      !holds(current, grant) ||
      (decision && !holds(current, "inputs.answer")) ||
      !(await access.authorizer.runs.allows(current, runId))
    )
      throw authForbidden();
  }
  private authority(): RetryAuthority<ContinuationCommand> {
    const { access, principalId } = this.context();
    return {
      principalId,
      workspaceId: access.workspaceId,
      authorize: (command) => this.authorize(command.runId, "runs.control", !!command.decision),
    };
  }
  admit(command: ContinuationCommand, retry: RetryOptions, access: ContinuationAccess) {
    return this.scoped(
      access,
      async () => {
        const result = await this.service.admit(command, retry, this.authority());
        if (result.state === "resolved" && result.result.state === "accepted") {
          const id = result.result.continuationId;
          (this.options.schedule ?? setImmediate)(() => {
            const task = this.reconcile(id, access)
              .then(() => undefined)
              .catch(async (error: unknown) => {
                // A competing writer or uncertain store read is not loss of authority.
                // Preserve its existing receipt so the original owner can settle it.
                if (!authorityUnavailable(error)) return;
                const locator = await this.options.locators.read(id);
                if (locator) await this.blockUnavailable(locator);
              })
              .catch(() => undefined);
            this.tasks.add(task);
            void task.finally(() => this.tasks.delete(task));
          });
        }
        return result;
      },
      "runs.control",
    );
  }
  inspect(id: string, access: ContinuationAccess) {
    return this.scoped(access, () => this.service.inspect(id));
  }
  reconcile(id: string, access: ContinuationAccess) {
    return this.scoped(access, () => this.service.reconcile(id, this.authority()), "runs.control");
  }
  /** Wait during orderly daemon shutdown; admission and reconciliation never await settlement. */
  async drain(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }
  /** Internal bounded startup recovery. The callback resolves only the sealed original credential. */
  async recoverBatch(accessFor: (entry: ContinuationEntry) => Promise<ContinuationAccess | undefined>): Promise<void> {
    const locators = (await this.options.locators.batch?.()) ?? [];
    if (locators.length > 100) throw unavailable();
    for (const locator of locators) {
      const entry = await this.located(locator);
      if (!entry) continue;
      // A retry claim is only a discovery candidate. Rebuild the non-authoritative
      // lookup after the existing encrypted marker has been verified and synced.
      await this.options.locators.bind(locator);
      if (entry.dispatch === "settled" || entry.dispatch === "ambiguous") continue;
      try {
        const access = entry.actor?.credentialId ? await accessFor(structuredClone(entry)) : undefined;
        const principal = await access?.current();
        if (
          !access ||
          access.workspaceId !== entry.workspaceId ||
          principal?.id !== entry.principalId ||
          principal.credentialId !== entry.actor?.credentialId
        ) {
          await this.blockUnavailable(locator);
          continue;
        }
        await this.reconcile(entry.receipt.continuationId, access);
      } catch (error) {
        if (authorityUnavailable(error)) await this.blockUnavailable(locator).catch(() => undefined);
      }
    }
  }
  private async located(locator: ContinuationLocator): Promise<ContinuationEntry | undefined> {
    const entry = await this.latest(locator.runId, locator.continuationId);
    if (
      entry &&
      (entry.principalId !== locator.principalId ||
        entry.workspaceId !== locator.workspaceId ||
        entry.receipt.operationId !== locator.operationId)
    )
      throw unavailable();
    return entry;
  }
  private async blockUnavailable(locator: ContinuationLocator): Promise<void> {
    await this.fenced(locator.runId, async () => {
      const entry = await this.located(locator);
      if (!entry || entry.dispatch === "settled" || entry.dispatch === "ambiguous") return;
      if (entry.receipt.state === "blocked" && entry.receipt.blockedReason === "authority-unavailable") return;
      await this.transition(
        entry,
        "blocked",
        entry.dispatch === "attached" ? "ambiguous" : "needed",
        "authority-unavailable",
      );
    });
  }
  async expectedBoundary(runId: string, access: ContinuationAccess): Promise<string | undefined> {
    return this.scoped(access, async () => {
      await this.authorize(runId, "runs.read");
      try {
        const token = await this.token(runId, (await this.boundary(runId)).boundary);
        await this.authorize(runId, "runs.read");
        return token;
      } catch (error) {
        if (error instanceof OrcaError && ["RUN_STATE", "CONTINUATION_STALE", "NOT_SUPPORTED"].includes(error.code))
          return undefined;
        throw error;
      }
    });
  }
  private async key(): Promise<Buffer> {
    const workspaceId = this.context().access.workspaceId;
    const id = `continuation-boundary-key-${createHash("sha256").update(workspaceId).digest("hex")}`;
    let record = await this.stores.execution.getGeneration(id);
    if (record === undefined) {
      try {
        await this.stores.execution.putGeneration(id, {
          schemaVersion: 1,
          workspaceId,
          key: randomBytes(32).toString("hex"),
        });
      } catch (error) {
        if ((await this.stores.execution.getGeneration(id)) === undefined) throw error;
      }
      record = await this.stores.execution.getGeneration(id);
    }
    const value = record as { schemaVersion?: unknown; workspaceId?: unknown; key?: unknown } | undefined;
    if (
      value?.schemaVersion !== 1 ||
      value.workspaceId !== workspaceId ||
      typeof value.key !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.key)
    )
      throw unavailable();
    return Buffer.from(value.key, "hex");
  }
  private async token(runId: string, boundary: Boundary): Promise<string> {
    return `cb1_${createHmac("sha256", await this.key())
      .update(canonicalJson({ workspaceId: this.context().access.workspaceId, runId, boundary }))
      .digest("base64url")}`;
  }
  private async history(runId: string): Promise<OrcaEvent[]> {
    if (((await this.stores.events.lastSeq(runId)) ?? -1) >= MAX_EVENTS)
      throw new OrcaError("NOT_SUPPORTED", "Continuation history exceeds the bounded recovery limit");
    const events: OrcaEvent[] = [];
    let after = -1;
    for (;;) {
      const page = await this.stores.events.readRange(runId, { after, limit: PAGE });
      if (events.length + page.length > MAX_EVENTS)
        throw new OrcaError("NOT_SUPPORTED", "Continuation history exceeds the bounded recovery limit");
      events.push(...(await executionEvents(page, this.stores.execution)));
      if (page.length < PAGE) return events;
      const next = page.at(-1)!.seq;
      if (next <= after) throw unavailable();
      after = next;
    }
  }
  private async boundary(runId: string) {
    const events = await this.history(runId);
    const first = events[0];
    if (first?.type !== "run.created" || !first.executionPayloadRef || !first.payload.workflowStored)
      throw unavailable();
    const state = reduceRun(events);
    const p = state.run.provenance;
    const last = events.at(-1)!;
    const step = state.steps[state.stepOrder.at(-1) ?? ""];
    if (
      !p ||
      state.run.parentRunId ||
      state.run.status !== "paused" ||
      !step ||
      !["waiting", "running"].includes(step.status)
    )
      throw stale();
    const definition = await this.stores.workflows.get(state.run.workflowId, state.run.workflowVersion);
    if (!definition || workflowRevision(definition) !== p.workflow.revision) throw stale();
    const node = definition.nodes[step.nodeId];
    const inputs = Object.values(state.humanInputs).filter((input) => input.stepRunId === step.id);
    const input = inputs[0];
    if (
      !(node?.type === "gate" || (node?.type === "decision" && node.source.kind === "human")) ||
      inputs.length !== 1 ||
      !input ||
      input.kind !== "decision" ||
      input.liveDecision
    )
      throw stale();
    if (!this.options.orchestrator.generations) throw unavailable();
    await this.options.orchestrator.generations.restore(p.configGeneration);
    const boundary: Boundary = {
      eventId: last.id,
      eventSeq: last.seq,
      workflowId: state.run.workflowId,
      workflowVersion: state.run.workflowVersion,
      workflowRevision: p.workflow.revision,
      configGeneration: p.configGeneration,
      stepRunId: step.id,
      attemptId: `${step.id}:${step.attempt}`,
      requestId: input.id,
    };
    return { boundary, state, input, node, events };
  }
  private async read(id: string): Promise<ContinuationEntry | undefined> {
    const { access, principalId, grant } = this.context();
    const current = await access.current();
    if (current.id !== principalId || !holds(current, grant)) throw authForbidden();
    const locator = await this.options.locators.read(id);
    if (
      !locator ||
      (grant === "runs.control" && locator.principalId !== principalId) ||
      locator.workspaceId !== access.workspaceId
    )
      return undefined;
    await this.authorize(locator.runId, grant);
    const entry = await this.latest(locator.runId, id);
    if (
      entry &&
      (entry.principalId !== locator.principalId ||
        entry.workspaceId !== locator.workspaceId ||
        entry.receipt.operationId !== locator.operationId)
    )
      throw unavailable();
    return entry;
  }
  private async latest(runId: string, id: string): Promise<ContinuationEntry | undefined> {
    const [event] = await this.stores.events.readRange(runId, {
      before: Number.MAX_SAFE_INTEGER,
      limit: 1,
      types: ["continuation.recorded"],
      match: (event) => event.journal?.kind === "continuation" && event.journal.id === id,
    });
    if (!event) return undefined;
    // A failed append sync can leave readable bytes. Never turn those bytes into
    // an accepted receipt without verifying and synchronizing the existing marker.
    if (!event.journal || !this.stores.events.synchronizeJournal)
      throw new OrcaError("NOT_SUPPORTED", "Durable continuation inspection is unavailable");
    try {
      await this.stores.events.synchronizeJournal(runId, event.journal);
    } catch {
      throw new OrcaError("RUN_STATE", "Continuation durability could not be verified", {
        continuationId: id,
        recovery: "reconcile",
        uncertain: true,
      });
    }
    const [restored] = await executionEvents([event], this.stores.execution);
    if (restored?.type !== "continuation.recorded" || !restored.executionPayloadRef) throw unavailable();
    const parsed = EntrySchema.safeParse(restored.payload.entry);
    if (!parsed.success) throw unavailable();
    const entry = parsed.data;
    if (
      !entry ||
      entry.schemaVersion !== 1 ||
      entry.kind !== "continuation" ||
      entry.revision !== event.journal?.revision ||
      entry.receipt.continuationId !== id ||
      entry.receipt.runId !== runId ||
      restored.payload.continuationId !== id ||
      restored.payload.state !== entry.receipt.state ||
      (entry.receipt.state === "blocked") !== (entry.receipt.blockedReason !== undefined) ||
      (entry.dispatch === "settled" && entry.receipt.state !== "settled") ||
      (entry.dispatch === "attached" && entry.receipt.state !== "accepted") ||
      (entry.dispatch === "ambiguous" && entry.receipt.state !== "blocked") ||
      entry.boundary.eventSeq >= event.seq ||
      entry.command.runId !== runId ||
      entry.receipt.expectedBoundary !== entry.command.expectedBoundary ||
      (entry.actor && entry.actor.principalId !== entry.principalId)
    )
      throw unavailable();
    return entry as ContinuationEntry;
  }
  private async fenced<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const holder = `ct_${randomUUID()}`;
    const lease = await this.stores.leases.acquire({ resource: `run:${runId}`, holder });
    if (!ownsLease(lease, holder)) throw new OrcaError("RUN_LEASED", "Run is already attached");
    try {
      return await this.stores.leases.withOwnership(lease, work);
    } finally {
      await this.stores.leases.release(lease);
    }
  }
  private async write(entry: ContinuationEntry, expectedSeq: number, decision = false): Promise<OrcaEvent> {
    const append = this.stores.events.appendDurableUnique?.bind(this.stores.events);
    if (!append) throw new OrcaError("NOT_SUPPORTED", "Durable continuation publication is unavailable");
    const command = entry.command.decision;
    return append(
      {
        runId: entry.receipt.runId,
        type: "continuation.recorded",
        journal: { kind: "continuation", id: entry.receipt.continuationId, revision: entry.revision },
        payload: {
          continuationId: entry.receipt.continuationId,
          state: entry.receipt.state,
          entry: entry as unknown as Record<string, unknown>,
          ...(decision && command
            ? {
                decision: {
                  requestId: command.requestId,
                  stepRunId: entry.boundary.stepRunId!,
                  answer: command.optionId,
                  actor: entry.actor!,
                },
              }
            : {}),
        },
      },
      {
        expectedSeq,
        correlation: { kind: "continuation", id: entry.receipt.continuationId, revision: entry.revision },
        equivalent: (event) =>
          event.type === "continuation.recorded" && canonicalJson(event.payload.entry) === canonicalJson(entry),
      },
    );
  }
  private async commit(input: ContinuationCommit, reauthorize: () => Promise<void>): Promise<ContinuationEntry> {
    await reauthorize();
    return this.fenced(input.command.runId, async () => {
      await reauthorize();
      const prior = await this.latest(input.command.runId, input.continuationId);
      if (prior) {
        if (
          prior.receipt.operationId !== input.operationId ||
          prior.principalId !== input.principalId ||
          prior.workspaceId !== input.workspaceId ||
          canonicalJson(prior.command) !== canonicalJson(input.command)
        )
          throw unavailable();
        await reauthorize();
        await this.options.locators.bind({
          schemaVersion: 1,
          operationId: input.operationId,
          continuationId: input.continuationId,
          runId: input.command.runId,
          principalId: input.principalId,
          workspaceId: input.workspaceId,
        });
        return prior;
      }
      const snapshot = await this.boundary(input.command.runId);
      if ((await this.token(input.command.runId, snapshot.boundary)) !== input.command.expectedBoundary) throw stale();
      const decision = input.command.decision;
      if (decision) {
        if (
          decision.requestId !== snapshot.input.id ||
          snapshot.input.answer !== undefined ||
          !snapshot.input.options.some((option) => option.id === decision.optionId) ||
          snapshot.node.revision?.actionId === decision.optionId
        )
          throw stale();
      } else if (snapshot.input.answer === undefined) throw stale();
      const principal = await this.context().access.current();
      const entry: ContinuationEntry = {
        schemaVersion: 1,
        kind: "continuation",
        revision: 0,
        command: structuredClone(input.command),
        principalId: input.principalId,
        workspaceId: input.workspaceId,
        actor: {
          principalId: principal.id,
          ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
        },
        boundary: snapshot.boundary,
        dispatch: "needed",
        receipt: {
          operationId: input.operationId,
          continuationId: input.continuationId,
          runId: input.command.runId,
          expectedBoundary: input.command.expectedBoundary,
          state: "accepted",
        },
      };
      await this.options.locators.bind({
        schemaVersion: 1,
        operationId: input.operationId,
        continuationId: input.continuationId,
        runId: input.command.runId,
        principalId: input.principalId,
        workspaceId: input.workspaceId,
      });
      if (decision?.note)
        await this.stores.execution.addSensitivity(input.command.runId, {
          sensitiveNames: [],
          secrets: [decision.note],
        });
      await reauthorize();
      await this.write(entry, snapshot.boundary.eventSeq, !!decision);
      return entry;
    });
  }
  private async transition(
    entry: ContinuationEntry,
    state: ContinuationReceipt["state"],
    dispatch: ContinuationEntry["dispatch"],
    blockedReason?: ContinuationReceipt["blockedReason"],
  ): Promise<ContinuationEntry> {
    const receipt = { ...entry.receipt, state };
    delete receipt.blockedReason;
    if (blockedReason) receipt.blockedReason = blockedReason;
    const next = { ...entry, revision: entry.revision + 1, receipt, dispatch };
    await this.write(next, (await this.stores.events.lastSeq(entry.receipt.runId)) ?? -1);
    return next;
  }
  /** Caller holds the run fence and has verified the fresh attached journal entry. */
  private async recoverAttached(entry: ContinuationEntry): Promise<ContinuationEntry> {
    const state = reduceRun(await this.history(entry.receipt.runId));
    return ["completed", "failed", "cancelled"].includes(state.run.status)
      ? this.transition(entry, "settled", "settled")
      : this.transition(entry, "blocked", "ambiguous", "unsafe-boundary");
  }
  private async attach(
    entry: ContinuationEntry,
    authority: RetryAuthority<ContinuationCommand>,
  ): Promise<ContinuationReceipt> {
    const { access } = this.context();
    if (entry.dispatch !== "needed")
      return this.fenced(entry.receipt.runId, async () => {
        await authority.authorize(entry.command);
        const fresh = await this.latest(entry.receipt.runId, entry.receipt.continuationId);
        if (!fresh) throw unavailable();
        if (fresh.dispatch === "settled" || fresh.dispatch === "ambiguous") return structuredClone(fresh.receipt);
        const next = await this.recoverAttached(fresh);
        return structuredClone(next.receipt);
      });
    let acknowledge!: (receipt: ContinuationReceipt) => void;
    let refuse!: (error: unknown) => void;
    const ack = new Promise<ContinuationReceipt>((resolve, reject) => {
      acknowledge = resolve;
      refuse = reject;
    });
    let attachedEntry: ContinuationEntry | undefined;
    const task = (async () => {
      try {
        await authority.authorize(entry.command);
        // Refuse unsupported histories/generations before the interpreter loads a context.
        await this.boundary(entry.receipt.runId);
        await this.options.executionRuntime.checkResumeAuthority(entry.receipt.runId, access.executionAuthority);
        await this.options.executionRuntime.withResumeAuthority(
          entry.receipt.runId,
          access.executionAuthority,
          async () => {
            const attachment = await this.options.orchestrator.attachContinuation(entry.receipt.runId, {
              beforeExecute: async (rc) => {
                await authority.authorize(entry.command);
                const fresh = await this.latest(entry.receipt.runId, entry.receipt.continuationId);
                if (!fresh || fresh.dispatch !== "needed") throw stale();
                const snapshot = await this.boundary(entry.receipt.runId);
                const suffix = snapshot.events.filter((event) => event.seq > entry.boundary.eventSeq);
                if (
                  suffix.length === 0 ||
                  suffix.some(
                    (event) =>
                      event.type !== "continuation.recorded" || event.journal?.id !== entry.receipt.continuationId,
                  ) ||
                  snapshot.boundary.stepRunId !== entry.boundary.stepRunId ||
                  snapshot.boundary.attemptId !== entry.boundary.attemptId ||
                  snapshot.input.id !== entry.boundary.requestId ||
                  snapshot.input.answer === undefined ||
                  (entry.command.decision && snapshot.input.answer !== entry.command.decision.optionId)
                )
                  throw stale();
                await authority.authorize(entry.command);
                attachedEntry = await this.transition(fresh, "accepted", "attached");
                // No decision is repeated on transitions; update the callback's projection cursor.
                const [last] = await this.stores.events.readRange(rc.id, { before: Number.MAX_SAFE_INTEGER, limit: 1 });
                if (last) applyEvent(rc.state, last);
              },
            });
            acknowledge(structuredClone(attachedEntry!.receipt));
            return attachment.completion;
          },
        );
      } catch (error) {
        if (attachedEntry) {
          try {
            await this.fenced(entry.receipt.runId, async () => {
              const fresh = await this.latest(entry.receipt.runId, entry.receipt.continuationId);
              if (fresh?.dispatch === "attached") await this.recoverAttached(fresh);
            });
          } catch {
            /* A competing owner must not be overwritten. Reconcile can recover later. */
          }
          refuse(error);
          return;
        }
        const code =
          error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
        const reason: NonNullable<ContinuationReceipt["blockedReason"]> =
          code === "RUN_LEASED"
            ? "leased"
            : code.startsWith("AUTH_") ||
                (error instanceof OrcaError && error.details?.executionResumeRequired === true)
              ? "authority-unavailable"
              : code === "CONTINUATION_STALE"
                ? "unsafe-boundary"
                : "generation-unavailable";
        try {
          const blocked = await this.fenced(entry.receipt.runId, async () => {
            const fresh = await this.latest(entry.receipt.runId, entry.receipt.continuationId);
            if (!fresh) throw unavailable();
            if (fresh.dispatch !== "needed") {
              if (fresh.dispatch === "attached") {
                await authority.authorize(entry.command);
                return this.recoverAttached(fresh);
              }
              await this.write(fresh, (await this.stores.events.lastSeq(entry.receipt.runId)) ?? -1);
              return fresh;
            }
            return this.transition(fresh, "blocked", "needed", reason);
          });
          acknowledge(structuredClone(blocked.receipt));
        } catch {
          refuse(error);
        }
        return;
      }
      // Execution has finished. A refused fence or uncertain publication here is
      // not an execution failure: retain the journal for later fenced recovery.
      try {
        if (attachedEntry)
          await this.fenced(entry.receipt.runId, async () => {
            const fresh = await this.latest(entry.receipt.runId, entry.receipt.continuationId);
            if (fresh?.dispatch === "attached") await this.transition(fresh, "settled", "settled");
          });
      } catch {
        /* Reconciliation verifies the durable marker before publishing settlement. */
      }
    })();
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return ack;
  }
}
