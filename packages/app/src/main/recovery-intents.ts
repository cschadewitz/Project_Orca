/**
 * Main-process-only durable checkpoint-attempt intents (#357), encrypted with OS safeStorage like
 * run intents. A record is one person's intent to recover one source run from one checkpoint:
 * its verified scope (target, principal, workspace), the source run, the checkpoint, the retry key,
 * the reserved receipt's operation id once the daemon answers with one, and the accepted attempt.
 *
 * The record lives here rather than in the renderer so that navigation, a reload or a restart
 * never turns an unresolved intent into new work. Its lifecycle:
 *
 * - **retained** from before the first call until the daemon gives a verified outcome. Every
 *   error keeps it, refusals included: an error answers that one request, and cannot prove that
 *   an earlier request whose answer was lost admitted nothing. Asking again sends the same key,
 *   which the daemon answers with that key's outcome.
 * - **resolved** when the daemon accepts an attempt for this source (and receipt, when one was
 *   reserved). The attempt id is written before the answer is returned, so a caller that loses
 *   the answer, or a reload, still finds what started.
 * - **abandoned** (dropped) only by an explicit, confirmed dismissal. Starting a separate new
 *   attempt of the same run is that dismissal followed by a new intent with a new key.
 *
 * Calls for one source run are serialized here, not in a view: a start, finish or dismissal is
 * refused while another is in flight, so a remounted window or a second caller cannot forget an
 * intent whose request is still out, or mint a second key.
 */
import { randomUUID } from "node:crypto";
import type { RunsRecoverResult } from "@orca/protocol";
import type { RecoveryIntentOutcome, RecoveryIntentView } from "../bridge.js";
import { daemonEndpoint, type DaemonTargetSnapshot } from "../daemon-connection.js";
import { type IntentEncryption, type IntentScope, ProtectedJournal } from "./admission-intents.js";

/** A profile connection's verified server (`Workspace.profileEndpoint`). */
export interface RecoveryEndpoint {
  id: string;
  /** The SSH server and jump chain the profile's pins vouch for (`serverKey`). */
  server: string;
  remotePort: number;
  /**
   * The pins the lease's tunnel sealed (`ProfileLease.pinnedKeys`): fixed while the lease
   * lives, changed only by a real pin replacement. Never the last-observed host key, which
   * any stream's ssh output can update.
   */
  pins: string;
}

/**
 * The stable half of an intent's scope: which daemon this is, independent of this connection.
 * An SSH profile's tunnel listens on a new loopback port each time, so a profile is named by
 * its verified server instead: the profile, the SSH server and jump chain its pins vouch for,
 * the daemon's remote port and the sealed pins its tunnel verifies every stream against.
 * Pointing the profile elsewhere, or replacing its pins, is a different target, whose intents stay hidden and
 * block the same run until the original is reached again. Workspace and principal come from
 * verified discovery beside it, and the connection epoch stays a separate in-flight guard
 * (`assertCurrent`).
 */
export function recoveryTarget(
  target: Pick<DaemonTargetSnapshot, "source" | "url" | "profile">,
  bundledPath: string,
  endpoint: RecoveryEndpoint | undefined,
): string {
  if (target.profile) {
    if (!endpoint || endpoint.id !== target.profile.id)
      throw new Error("The SSH connection has not verified its server yet. Refresh before recovering.");
    return `ssh:${JSON.stringify([endpoint.id, endpoint.server, endpoint.remotePort, endpoint.pins])}`;
  }
  return target.source === "bundled" ? `bundled:${bundledPath}` : daemonEndpoint(target.url);
}

export interface RecoveryIntentRecord extends IntentScope {
  id: string;
  sourceRunId: string;
  checkpoint: string;
  idempotencyKey: string;
  /** The receipt to reconcile: present once the daemon reserved an attempt and did not confirm it. */
  operationId?: string;
  /** The attempt the daemon accepted: present exactly when `state` is `resolved`. */
  attemptRunId?: string;
  state: "retained" | "resolved" | "abandoned";
}

const LIMIT = 1000;
const KEYS = "checkpoint,id,idempotencyKey,principalId,sourceRunId,state,target,workspaceId";
const OPTIONAL = new Set(["operationId", "attemptRunId"]);

function rows(data: unknown): RecoveryIntentRecord[] {
  if (!Array.isArray(data) || data.length > LIMIT) throw new Error("invalid");
  const ids = new Set<string>();
  for (const row of data as Record<string, unknown>[]) {
    if (typeof row !== "object" || row === null) throw new Error("invalid");
    const keys = Object.keys(row)
      .filter((k) => !OPTIONAL.has(k))
      .sort()
      .join();
    const optionalValid = [...OPTIONAL].every(
      (k) => !Object.hasOwn(row, k) || (typeof row[k] === "string" && row[k].length > 0),
    );
    if (
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
      !optionalValid ||
      !["retained", "resolved", "abandoned"].includes(row.state as string) ||
      (row.state === "resolved") !== Object.hasOwn(row, "attemptRunId") ||
      ids.has(row.id as string)
    )
      throw new Error("invalid");
    ids.add(row.id as string);
  }
  return data as RecoveryIntentRecord[];
}

const sameScope = (a: IntentScope, b: IntentScope) =>
  a.target === b.target && a.principalId === b.principalId && a.workspaceId === b.workspaceId;

const live = (r: RecoveryIntentRecord) => r.state !== "abandoned";

const view = (r: RecoveryIntentRecord): RecoveryIntentView => ({
  id: r.id,
  sourceRunId: r.sourceRunId,
  checkpoint: r.checkpoint,
  reserved: r.state === "retained" && r.operationId !== undefined,
  ...(r.attemptRunId !== undefined ? { attemptRunId: r.attemptRunId } : {}),
});

export class RecoveryIntents {
  private readonly journal: ProtectedJournal<RecoveryIntentRecord>;
  constructor(path: string, encryption: IntentEncryption) {
    this.journal = new ProtectedJournal(path, encryption, rows);
  }

  /**
   * The intent for this source and checkpoint: the one already held (retained or resolved), or a
   * new one persisted before the first network call.
   */
  retain(scope: IntentScope, sourceRunId: string, checkpoint: string): RecoveryIntentRecord {
    if (![scope.target, scope.principalId, scope.workspaceId, sourceRunId, checkpoint].every((v) => v?.length))
      throw new Error("Verified recovery scope is unavailable. No attempt was started.");
    const records = this.journal.read();
    const held = records.find((r) => r.sourceRunId === sourceRunId && live(r));
    if (held) {
      if (!sameScope(held, scope))
        throw new Error(
          "This run has a recovery on another connection or principal. Return to it to finish or dismiss it.",
        );
      if (held.checkpoint !== checkpoint)
        throw new Error(
          held.state === "resolved"
            ? "This run already started an attempt from another checkpoint. Dismiss it to start a separate attempt."
            : "This run has an unresolved recovery from another checkpoint. Finish or abandon it before starting another.",
        );
      return { ...held };
    }
    if (records.filter(live).length >= LIMIT)
      throw new Error("Too many recoveries on record. No attempt was started; dismiss earlier ones first.");
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
    const record = this.journal.read().find((r) => r.id === id && live(r) && sameScope(r, scope));
    if (!record) throw new Error("This recovery is unavailable on this connection.");
    return { ...record };
  }

  list(scope: IntentScope, sourceRunId: string): RecoveryIntentView[] {
    return this.journal
      .read()
      .filter((r) => live(r) && r.sourceRunId === sourceRunId && sameScope(r, scope))
      .map(view);
  }

  /** Record the reserved receipt. A different receipt for the same intent is a mismatch, never a replacement. */
  recordReceipt(record: RecoveryIntentRecord, operationId: string): RecoveryIntentRecord {
    return this.update(record, (held) => {
      if (held.state !== "retained") throw new Error("This recovery already has an outcome. Refresh to see it.");
      if (held.operationId !== undefined && held.operationId !== operationId)
        throw new Error("The daemon answered with a different receipt for this recovery. Do not start new work.");
      held.operationId = operationId;
    });
  }

  /** Persist the accepted attempt against its intent before anyone is told about it. */
  resolve(record: RecoveryIntentRecord, attemptRunId: string): RecoveryIntentRecord {
    return this.update(record, (held) => {
      if (held.state === "resolved" && held.attemptRunId !== attemptRunId)
        throw new Error("The daemon answered with a different attempt for this recovery. Do not start new work.");
      held.state = "resolved";
      held.attemptRunId = attemptRunId;
    });
  }

  /** Dismiss exactly this record, as it was read: a record that changed since is refused. */
  dismiss(record: RecoveryIntentRecord): void {
    this.update(record, (held) => {
      if (held.state !== record.state || held.operationId !== record.operationId)
        throw new Error("This recovery changed while you were confirming. Refresh before dismissing it.");
      held.state = "abandoned";
    });
  }

  private update(record: RecoveryIntentRecord, change: (held: RecoveryIntentRecord) => void): RecoveryIntentRecord {
    const records = this.journal.read();
    const held = records.find((r) => r.id === record.id && live(r) && sameScope(r, record));
    if (!held) throw new Error("This recovery changed. Refresh before continuing.");
    change(held);
    this.journal.write(records);
    return { ...held };
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
}

export class RecoveryIntentController {
  /** Source runs with a call in flight: one start, finish or dismissal at a time each. */
  private readonly busy = new Set<string>();
  constructor(
    private readonly journal: RecoveryIntents,
    private readonly connect: () => Promise<RecoveryConnection>,
    /** Ask the person; `resolved` forgets a started attempt's record rather than an unresolved intent. */
    private readonly confirmDismiss: (state: "retained" | "resolved") => Promise<boolean>,
  ) {}

  async list(sourceRunId: string): Promise<RecoveryIntentView[]> {
    const connection = await this.connect();
    connection.assertCurrent();
    return this.journal.list(connection.scope, sourceRunId);
  }

  /** Start recovering `sourceRunId` from `checkpoint`, or ask again for the intent already held. */
  start(sourceRunId: string, checkpoint: string): Promise<RecoveryIntentOutcome> {
    return this.exclusive(sourceRunId, async () => {
      const connection = await this.connect();
      connection.assertCurrent();
      const intent = this.journal.retain(connection.scope, sourceRunId, checkpoint);
      if (intent.state === "resolved") return this.present(connection, { state: "accepted", ...accepted(intent) });
      if (intent.operationId !== undefined) return this.reconcile(connection, intent);
      connection.assertCurrent();
      // Any error leaves the intent and its key as they are: only an outcome or a dismissal ends it.
      const result = await connection.recover({
        runId: intent.sourceRunId,
        checkpoint: intent.checkpoint,
        idempotencyKey: intent.idempotencyKey,
        expectedScope: { principalId: intent.principalId, workspaceId: intent.workspaceId },
      });
      return this.settle(connection, intent, result);
    });
  }

  /** Finish a reserved intent by reconciling its receipt. Never starts another attempt. */
  async finish(id: string): Promise<RecoveryIntentOutcome> {
    const connection = await this.connect();
    connection.assertCurrent();
    const held = this.journal.get(connection.scope, id);
    return this.exclusive(held.sourceRunId, async () => {
      const intent = this.journal.get(connection.scope, id);
      if (intent.state === "resolved") return this.present(connection, { state: "accepted", ...accepted(intent) });
      if (intent.operationId === undefined) throw new Error("This recovery has no reserved attempt to finish.");
      return this.reconcile(connection, intent);
    });
  }

  /**
   * Dismiss an intent after confirmation: an unresolved one is abandoned (nothing on the daemon
   * is cancelled), a resolved one is forgotten so a separate attempt can start. Held for the
   * whole dialog and checked again after it, so no call for this run can begin or finish unseen
   * in between.
   */
  async dismiss(id: string): Promise<{ abandoned: boolean }> {
    const connection = await this.connect();
    connection.assertCurrent();
    const held = this.journal.get(connection.scope, id);
    return this.exclusive(held.sourceRunId, async () => {
      const intent = this.journal.get(connection.scope, id);
      if (!(await this.confirmDismiss(intent.state === "resolved" ? "resolved" : "retained")))
        return { abandoned: false };
      connection.assertCurrent();
      this.journal.dismiss(intent);
      return { abandoned: true };
    });
  }

  private async exclusive<T>(sourceRunId: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(sourceRunId))
      throw new Error("A recovery call for this run is still in progress. Wait for it to answer.");
    this.busy.add(sourceRunId);
    try {
      return await work();
    } finally {
      this.busy.delete(sourceRunId);
    }
  }

  private async reconcile(connection: RecoveryConnection, intent: RecoveryIntentRecord) {
    const result = await connection.reconcile({
      operationId: intent.operationId!,
      expectedScope: { principalId: intent.principalId, workspaceId: intent.workspaceId },
    });
    return this.settle(connection, intent, result);
  }

  /** Persist what the daemon answered, then tell the caller only if its connection is still current. */
  private settle(
    connection: RecoveryConnection,
    intent: RecoveryIntentRecord,
    result: RunsRecoverResult,
  ): RecoveryIntentOutcome {
    if (result.state === "accepted") {
      if (
        result.sourceRunId !== intent.sourceRunId ||
        (intent.operationId && result.operationId !== intent.operationId)
      )
        throw new Error("The daemon's receipt does not match this recovery. Do not start new work; refresh first.");
      const resolved = this.journal.resolve(intent, result.runId);
      return this.present(connection, { state: "accepted", ...accepted(resolved) });
    }
    if (result.state === "recoverable-failure") {
      const held = this.journal.recordReceipt(intent, result.operationId);
      return this.present(connection, {
        state: "reserved",
        intent: view(held),
        message: `The daemon reserved the attempt but did not confirm it was created (${result.failure.message}).`,
      });
    }
    return this.present(connection, { state: "pending", intent: view(intent) });
  }

  private present(connection: RecoveryConnection, outcome: RecoveryIntentOutcome): RecoveryIntentOutcome {
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

function accepted(record: RecoveryIntentRecord): { runId: string; intent: RecoveryIntentView } {
  return { runId: record.attemptRunId!, intent: view(record) };
}
