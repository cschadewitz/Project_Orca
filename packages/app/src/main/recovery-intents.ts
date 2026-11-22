/**
 * Main-process-only durable checkpoint-attempt intents (#357), encrypted with OS safeStorage like
 * run intents. A record is one person's intent to recover one source run from one checkpoint:
 * its verified scope (target, principal, workspace), the source run, the checkpoint, the retry key
 * and, once the daemon answers with a reserved receipt, its operation id.
 *
 * The record lives here rather than in the renderer so that navigation, a reload or a restart
 * never turns an unresolved intent into new work. It is settled (dropped) only by a definite
 * answer for that record: an accepted attempt whose source matches, or the daemon refusing the
 * start. A lost answer, an in-progress one and a reserved receipt all keep it, and only an
 * explicit, confirmed abandon drops it otherwise. Settling uses the record's own scope, so a
 * late answer that arrives after the connection changed still settles what it answered, and the
 * caller is then told the connection changed instead of being shown the result.
 */
import { randomUUID } from "node:crypto";
import type { RunsRecoverResult } from "@orca/protocol";
import type { RecoveryIntentOutcome, RecoveryIntentView } from "../bridge.js";
import { type IntentEncryption, type IntentScope, ProtectedJournal } from "./admission-intents.js";

export interface RecoveryIntentRecord extends IntentScope {
  id: string;
  sourceRunId: string;
  checkpoint: string;
  idempotencyKey: string;
  /** The receipt to reconcile: present once the daemon reserved an attempt it did not create. */
  operationId?: string;
  state: "retained" | "abandoned";
}

const LIMIT = 1000;
const KEYS = "checkpoint,id,idempotencyKey,principalId,sourceRunId,state,target,workspaceId";

function rows(data: unknown): RecoveryIntentRecord[] {
  if (!Array.isArray(data) || data.length > LIMIT) throw new Error("invalid");
  const ids = new Set<string>();
  for (const row of data as Record<string, unknown>[]) {
    const keys = Object.keys(row ?? {})
      .filter((k) => k !== "operationId")
      .sort()
      .join();
    if (
      typeof row !== "object" ||
      row === null ||
      keys !== KEYS ||
      ![
        row.id,
        row.target,
        row.principalId,
        row.workspaceId,
        row.sourceRunId,
        row.checkpoint,
        row.idempotencyKey,
      ].every((v) => typeof v === "string" && v.length > 0) ||
      (Object.hasOwn(row, "operationId") && (typeof row.operationId !== "string" || !row.operationId.length)) ||
      !["retained", "abandoned"].includes(row.state as string) ||
      ids.has(row.id as string)
    )
      throw new Error("invalid");
    ids.add(row.id as string);
  }
  return data as RecoveryIntentRecord[];
}

const sameScope = (a: IntentScope, b: IntentScope) =>
  a.target === b.target && a.principalId === b.principalId && a.workspaceId === b.workspaceId;

const view = (r: RecoveryIntentRecord): RecoveryIntentView => ({
  id: r.id,
  sourceRunId: r.sourceRunId,
  checkpoint: r.checkpoint,
  reserved: r.operationId !== undefined,
});

export class RecoveryIntents {
  private readonly journal: ProtectedJournal<RecoveryIntentRecord>;
  constructor(path: string, encryption: IntentEncryption) {
    this.journal = new ProtectedJournal(path, encryption, rows);
  }

  /** Persist before the first network call. The same source and checkpoint reuse the exact intent. */
  retain(scope: IntentScope, sourceRunId: string, checkpoint: string): RecoveryIntentRecord {
    if (![scope.target, scope.principalId, scope.workspaceId, sourceRunId, checkpoint].every((v) => v?.length))
      throw new Error("Verified recovery scope is unavailable. No attempt was started.");
    const records = this.journal.read();
    const held = records.find((r) => r.sourceRunId === sourceRunId && r.state === "retained");
    if (held) {
      if (!sameScope(held, scope))
        throw new Error(
          "This run has an unresolved recovery on another connection or principal. Return to it to finish or abandon it.",
        );
      if (held.checkpoint !== checkpoint)
        throw new Error(
          "This run has an unresolved recovery from another checkpoint. Finish or abandon it before starting another.",
        );
      return { ...held };
    }
    if (records.filter((r) => r.state === "retained").length >= LIMIT)
      throw new Error("Too many unresolved recoveries. No attempt was started; finish or abandon earlier ones first.");
    const record: RecoveryIntentRecord = {
      ...scope,
      id: randomUUID(),
      sourceRunId,
      checkpoint,
      idempotencyKey: randomUUID(),
      state: "retained",
    };
    this.journal.writeNewWork([...records, record]);
    return { ...record };
  }

  get(scope: IntentScope, id: string): RecoveryIntentRecord {
    const record = this.journal.read().find((r) => r.id === id && r.state === "retained" && sameScope(r, scope));
    if (!record) throw new Error("The unresolved recovery is unavailable on this connection.");
    return { ...record };
  }

  list(scope: IntentScope, sourceRunId: string): RecoveryIntentView[] {
    return this.journal
      .read()
      .filter((r) => r.state === "retained" && r.sourceRunId === sourceRunId && sameScope(r, scope))
      .map(view);
  }

  /** Record the reserved receipt. A different receipt for the same intent is a mismatch, never a replacement. */
  recordReceipt(record: RecoveryIntentRecord, operationId: string): RecoveryIntentRecord {
    const records = this.journal.read();
    const held = records.find((r) => r.id === record.id && r.state === "retained" && sameScope(r, record));
    if (!held) throw new Error("The unresolved recovery changed. Refresh before finishing it.");
    if (held.operationId !== undefined && held.operationId !== operationId)
      throw new Error("The daemon answered with a different receipt for this recovery. Do not start new work.");
    held.operationId = operationId;
    this.journal.write(records);
    return { ...held };
  }

  /** Drop the record that answered (its own scope, not the current connection's). */
  settle(record: RecoveryIntentRecord): void {
    const records = this.journal.read();
    const held = records.find((r) => r.id === record.id && sameScope(r, record));
    if (!held || held.state !== "retained") return;
    held.state = "abandoned";
    this.journal.write(records);
  }
}

export interface RecoveryConnection {
  scope: IntentScope;
  /** The captured connection, never a lookup of whichever client is current later. */
  assertCurrent(): void;
  recover(params: {
    runId: string;
    checkpoint: string;
    idempotencyKey: string;
    expectedScope: { principalId: string; workspaceId: string };
  }): Promise<RunsRecoverResult>;
  /** `admissions.reconcile` for a checkpoint receipt only: the daemon checks the kind first. */
  reconcile(params: {
    operationId: string;
    expectedScope: { principalId: string; workspaceId: string };
  }): Promise<RunsRecoverResult>;
  /** True when the error is the daemon's own answer to this call, so the intent is over. */
  refused(error: unknown): boolean;
}

export class RecoveryIntentController {
  constructor(
    private readonly journal: RecoveryIntents,
    private readonly connect: () => Promise<RecoveryConnection>,
    private readonly confirmAbandon: () => Promise<boolean>,
  ) {}

  async list(sourceRunId: string): Promise<RecoveryIntentView[]> {
    const connection = await this.connect();
    connection.assertCurrent();
    return this.journal.list(connection.scope, sourceRunId);
  }

  /** Start (or, for a reserved intent, finish) recovering `sourceRunId` from `checkpoint`. */
  async start(sourceRunId: string, checkpoint: string): Promise<RecoveryIntentOutcome> {
    const connection = await this.connect();
    connection.assertCurrent();
    const intent = this.journal.retain(connection.scope, sourceRunId, checkpoint);
    if (intent.operationId !== undefined) return this.reconcile(connection, intent);
    connection.assertCurrent();
    let result: RunsRecoverResult;
    try {
      result = await connection.recover({
        runId: intent.sourceRunId,
        checkpoint: intent.checkpoint,
        idempotencyKey: intent.idempotencyKey,
        expectedScope: { principalId: intent.principalId, workspaceId: intent.workspaceId },
      });
    } catch (error) {
      // The daemon refused this start: nothing was admitted under the key, and the next
      // press is new work. Anything else may have reached it, so the intent stays.
      if (connection.refused(error)) this.journal.settle(intent);
      throw error;
    }
    return this.settle(connection, intent, result);
  }

  /** Finish a reserved intent by reconciling its receipt. Never starts another attempt. */
  async finish(id: string): Promise<RecoveryIntentOutcome> {
    const connection = await this.connect();
    connection.assertCurrent();
    const intent = this.journal.get(connection.scope, id);
    if (intent.operationId === undefined) throw new Error("This recovery has no reserved attempt to finish.");
    return this.reconcile(connection, intent);
  }

  /** Only after explicit confirmation. Does not cancel or delete anything on the daemon. */
  async abandon(id: string): Promise<{ abandoned: boolean }> {
    const connection = await this.connect();
    connection.assertCurrent();
    const intent = this.journal.get(connection.scope, id);
    if (!(await this.confirmAbandon())) return { abandoned: false };
    connection.assertCurrent();
    this.journal.settle(intent);
    return { abandoned: true };
  }

  private async reconcile(connection: RecoveryConnection, intent: RecoveryIntentRecord) {
    // Reconciling keeps the intent on any error: only its receipt's outcome settles it.
    const result = await connection.reconcile({
      operationId: intent.operationId!,
      expectedScope: { principalId: intent.principalId, workspaceId: intent.workspaceId },
    });
    return this.settle(connection, intent, result);
  }

  private settle(
    connection: RecoveryConnection,
    intent: RecoveryIntentRecord,
    result: RunsRecoverResult,
  ): RecoveryIntentOutcome {
    let outcome: RecoveryIntentOutcome;
    if (result.state === "accepted") {
      if (
        result.sourceRunId !== intent.sourceRunId ||
        (intent.operationId && result.operationId !== intent.operationId)
      )
        throw new Error("The daemon's receipt does not match this recovery. Do not start new work; refresh first.");
      this.journal.settle(intent);
      outcome = { state: "accepted", runId: result.runId };
    } else if (result.state === "recoverable-failure") {
      const held = this.journal.recordReceipt(intent, result.operationId);
      outcome = {
        state: "reserved",
        intent: view(held),
        message: `The daemon reserved the attempt but did not confirm it was created (${result.failure.message}).`,
      };
    } else {
      outcome = { state: "pending", intent: view(intent) };
    }
    // A late answer settles its own record above, but is not shown on another connection.
    try {
      connection.assertCurrent();
    } catch {
      throw new Error(
        "The connection changed while recovery was answering. Open the run again to see where it stands.",
      );
    }
    return outcome;
  }
}
