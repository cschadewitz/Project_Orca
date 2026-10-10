/** Registered continuation admission. Durability and execution fences are injected, never emulated. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OrcaError } from "@orca/core";
import type {
  JsonValue,
  RetryAuthority,
  RetryContext,
  RetryOperation,
  RetryOptions,
  RetryResult,
} from "../../core/src/model/admission-retry.js";
import type {
  ContinuationCommand,
  ContinuationReceipt,
  ContinuationService,
} from "../../core/src/model/continuation-admission.js";
import { canonicalJson, type RegisteredRetryClaims } from "./admission-retry.js";

export const ContinuationCommandSchema = z.strictObject({
  runId: z.string().min(1),
  expectedBoundary: z.string().min(1),
  decision: z
    .strictObject({
      requestId: z.string().min(1),
      optionId: z.string().min(1),
      note: z.string().optional(),
    })
    .optional(),
});

/** Protected material. Never project the command/actor/boundary as an unfiltered receipt. */
export interface ContinuationEntry {
  schemaVersion: 1;
  kind: "continuation";
  revision: number;
  receipt: ContinuationReceipt;
  command: ContinuationCommand;
  principalId: string;
  workspaceId: string;
  actor?: { principalId: string; credentialId?: string };
  boundary: {
    eventId: string;
    eventSeq: number;
    workflowId: string;
    workflowVersion: string;
    workflowRevision: string;
    configGeneration: string;
    stepRunId?: string;
    attemptId?: string;
    requestId?: string;
    revisionId?: string;
  };
  dispatch: "needed" | "attached" | "settled" | "ambiguous";
}
export interface ContinuationCommit {
  operationId: string;
  continuationId: string;
  command: ContinuationCommand;
  /** Verified authority identity, never values deserialized from the wire command. */
  principalId: string;
  workspaceId: string;
}
export interface ContinuationJournal {
  read(continuationId: string): Promise<ContinuationEntry | undefined>;
  /**
   * Resolve existing retry claims without acquiring run ownership. On a lookup miss,
   * rerun under the run writer fence, acquired outside the retry catalog/operation
   * locks. Keep that ownership through validation, binding and acceptance publication.
   * The callback may run twice and must seal the same canonical command both times.
   */
  withAdmission<T>(runId: string, work: () => Promise<T>): Promise<T>;
  /** Effect-free fresh-intent validation; assert an already-held run fence before reading the boundary. */
  validateFresh(command: ContinuationCommand): Promise<void>;
  /**
   * Under the run writer fence: first recover an identical committed correlation;
   * otherwise validate the exact issued boundary (workflow/generation/step/attempt,
   * request and revision), validate any durable decision and reauthorize immediately
   * before append. Commit ONE protected continuation.recorded event containing both
   * answer and accepted dispatch-needed intent. A stale boundary has no effects.
   * Fresh claims were validated under the same fence before publication and binding.
   * The retry claim is already bound; this adapter must not allocate another identity.
   * A crash after append is recovered by correlation, never by answering again.
   */
  commit(input: ContinuationCommit, reauthorize: () => Promise<void>): Promise<ContinuationEntry>;
}
export interface ContinuationRuntime {
  /** Live runs.read check for this server-created service's authenticated context. */
  authorizeRead(entry: ContinuationEntry): Promise<void>;
  /**
   * Bounded attachment only, never wait for execution settlement. Reauthorize original
   * command under the run fence, restore the recorded generation and acquire the run
   * lease before attaching. Persist every transition. An already attached, ambiguous
   * or terminal intent must not blindly replay execution. Missing authority/generation,
   * a competing lease or an unsafe boundary produces the corresponding blocked receipt.
   * No process-owner fallback is permitted. Startup discovery uses the same path with
   * a currently verified authority, or leaves the durable dispatch blocked.
   */
  reconcile(entry: ContinuationEntry, authority: RetryAuthority<ContinuationCommand>): Promise<ContinuationReceipt>;
}

const BindingSchema = z.strictObject({
  continuationId: z.string().min(1),
  principalId: z.string().min(1),
  workspaceId: z.string().min(1),
});
const unavailable = () => new OrcaError("RUN_STATE", "Continuation is unavailable");

/**
 * Construct once per registered retry facility; authenticate reads in the injected runtime.
 * Transport composition must require an authenticated context before entry lookup.
 * Missing IDs and owner mismatches intentionally share a generic unavailable refusal.
 */
export class ContinuationAdmissionService implements ContinuationService {
  private readonly authorities = new AsyncLocalStorage<RetryAuthority<ContinuationCommand>>();
  private readonly operation: RetryOperation<ContinuationCommand, ContinuationReceipt>;

  constructor(
    private readonly options: {
      retries: RegisteredRetryClaims;
      journal: ContinuationJournal;
      runtime: ContinuationRuntime;
    },
  ) {
    this.operation = options.retries.register({
      kind: "run.continue",
      canonicalize: (command: ContinuationCommand): JsonValue => {
        const parsed = ContinuationCommandSchema.safeParse(command);
        if (!parsed.success) throw new OrcaError("WORKFLOW_INPUT_INVALID", "Invalid continuation command");
        const { runId, expectedBoundary, decision } = parsed.data;
        return JSON.parse(
          canonicalJson({
            runId,
            expectedBoundary,
            ...(decision
              ? {
                  decision: {
                    requestId: decision.requestId,
                    optionId: decision.optionId,
                    ...(decision.note !== undefined ? { note: decision.note } : {}),
                  },
                }
              : {}),
          }),
        ) as JsonValue;
      },
      validateFresh: (command) => this.options.journal.validateFresh(command),
      prepare: (command, context) => this.commit(command, context, true),
      recover: (command, context) => this.commit(command, context, false),
    });
  }

  admit(
    command: ContinuationCommand,
    retry: RetryOptions,
    authority: RetryAuthority<ContinuationCommand>,
  ): Promise<RetryResult<ContinuationReceipt>> {
    return this.authorities.run(authority, async () => {
      // Snapshot the canonical intent before asynchronous authorization or lookup. The
      // retry ledger is an intent/result index, never evidence that its run journal
      // still contains the authoritative acceptance after a restore or rewind.
      const canonical = canonicalJson(this.operation.canonicalize(command));
      const snapshot = JSON.parse(canonical) as ContinuationCommand;
      const response = await this.options.journal.withAdmission(snapshot.runId, () =>
        this.options.retries.execute(this.operation, snapshot, retry, authority),
      );
      if (response.state !== "resolved") return response;
      const entry = await this.read(response.result.continuationId);
      this.assertOwner(entry, authority);
      this.assertReceipt(entry.receipt, response.result);
      if (
        response.operationId !== entry.receipt.operationId ||
        entry.receipt.runId !== snapshot.runId ||
        entry.receipt.expectedBoundary !== snapshot.expectedBoundary ||
        canonicalJson(entry.command) !== canonical
      )
        throw unavailable();
      await authority.authorize(snapshot);
      // Preserve original receipt/replayed semantics. A missing or mismatched marker
      // fails closed; replay must never recreate it or record a second decision.
      return response;
    });
  }

  async inspect(continuationId: string): Promise<ContinuationReceipt> {
    const entry = await this.read(continuationId);
    await this.options.runtime.authorizeRead(entry);
    return structuredClone(entry.receipt);
  }

  async reconcile(
    continuationId: string,
    authority: RetryAuthority<ContinuationCommand>,
  ): Promise<ContinuationReceipt> {
    const entry = await this.read(continuationId);
    this.assertOwner(entry, authority);
    await authority.authorize(entry.command);
    // Even terminal inspection here requires original decision/control authority.
    if (entry.receipt.state === "settled") return structuredClone(entry.receipt);
    const receipt = await this.options.runtime.reconcile(entry, authority);
    this.assertReceipt(receipt, entry.receipt);
    return structuredClone(receipt);
  }

  private async read(continuationId: string): Promise<ContinuationEntry> {
    const entry = await this.options.journal.read(continuationId);
    if (!entry || entry.receipt.continuationId !== continuationId) throw unavailable();
    return entry;
  }

  private assertOwner(
    entry: Pick<ContinuationEntry, "principalId" | "workspaceId">,
    authority: RetryAuthority<ContinuationCommand>,
  ): void {
    if (entry.principalId !== authority.principalId || entry.workspaceId !== authority.workspaceId) throw unavailable();
  }

  private assertReceipt(receipt: ContinuationReceipt, expected: ContinuationReceipt): void {
    if (
      receipt.operationId !== expected.operationId ||
      receipt.continuationId !== expected.continuationId ||
      receipt.runId !== expected.runId ||
      receipt.expectedBoundary !== expected.expectedBoundary
    )
      throw unavailable();
  }

  private async commit(
    command: ContinuationCommand,
    context: RetryContext,
    fresh: boolean,
  ): Promise<ContinuationReceipt> {
    const authority = this.authorities.getStore();
    // Generic admission reconciliation must not borrow ambient process credentials.
    if (!authority) throw unavailable();
    if (fresh)
      await context.bind({
        continuationId: `ct_${randomUUID()}`,
        principalId: authority.principalId,
        workspaceId: authority.workspaceId,
      });
    const parsed = BindingSchema.safeParse(await context.readBinding());
    if (!parsed.success) throw unavailable();
    this.assertOwner(parsed.data, authority);
    await context.reauthorize();
    const input: ContinuationCommit = { ...parsed.data, operationId: context.operationId, command };
    const entry = await this.options.journal.commit(input, () => context.reauthorize());
    this.assertOwner(entry, authority);
    this.assertReceipt(entry.receipt, {
      ...entry.receipt,
      operationId: input.operationId,
      continuationId: input.continuationId,
      runId: command.runId,
      expectedBoundary: command.expectedBoundary,
    });
    if (canonicalJson(entry.command) !== canonicalJson(command)) throw unavailable();
    // The durable dispatch is discoverable before acknowledgement. No detached Promise.
    return structuredClone(entry.receipt);
  }
}
