/** Main-owned guided submission/recovery over the existing encrypted intent journal. */
import { AdmissionRetryResultSchema, RequestsSubmitResultSchema, RunsAdmitResultSchema } from "@orca/protocol";
import type { EditorTarget, LaunchResponse, LaunchReview, RetainedLaunch } from "../configuration-launch-contract.js";
import {
  AdmissionIntents,
  isProtectedStorageRefusal,
  type IntentRecord,
  type IntentScope,
} from "./admission-intents.js";
import { parseGuidedReview } from "./guided-intent-contract.js";

export interface GuidedIntentConnection {
  readonly scope: IntentScope;
  readonly target: EditorTarget;
  assertCurrent(): void;
  /** Must independently verify authoritative review/checkout; caller-provided evidence is insufficient. */
  verifyReview(review: LaunchReview): Promise<void>;
  /** Explicit original-target recovery review, using current authority; never recapture new guards. */
  verifyRecovery(record: IntentRecord): Promise<void>;
  send(record: IntentRecord): Promise<LaunchResponse>;
  recover(record: IntentRecord, action: "inspect" | "reconcile"): Promise<LaunchResponse>;
}
function sameTarget(a: EditorTarget, b: EditorTarget): boolean {
  return a.workspaceId === b.workspaceId && a.instanceId === b.instanceId && a.epoch === b.epoch;
}
function response(raw: LaunchResponse, mode: "direct" | "request"): LaunchResponse {
  if (raw.kind === "direct" && mode === "direct") {
    RunsAdmitResultSchema.parse(raw.receipt);
    return raw;
  }
  if (raw.kind === "request" && mode === "request")
    return { kind: "request", receipt: RequestsSubmitResultSchema.parse(raw.receipt) };
  if (raw.kind !== "retry") throw new Error("Admission receipt has the wrong retained operation kind.");
  const receipt = AdmissionRetryResultSchema.parse(raw.receipt);
  if (receipt.state === "resolved") {
    if (mode === "direct") {
      // Nested core direct receipts do not include operationId; the envelope supplies it.
      RunsAdmitResultSchema.parse({ ...Object(receipt.result), operationId: receipt.operationId });
    } else RequestsSubmitResultSchema.parse(receipt.result);
  }
  return { kind: "retry", receipt };
}
/** After a send, a storage refusal must not say "no run was submitted": recovery is the next step. */
function afterSend<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (isProtectedStorageRefusal(error)) throw error.at("after-send");
    throw error;
  }
}
export class GuidedLaunchController {
  private generation = 0;
  private readonly recovering = new Set<string>();
  private readonly pending = new Map<string, Promise<{ intent: RetainedLaunch; response: LaunchResponse }>>();
  constructor(
    private readonly journal: AdmissionIntents,
    private readonly connect: () => Promise<GuidedIntentConnection>,
  ) {}
  async submit(raw: LaunchReview): Promise<{ intent: RetainedLaunch; response: LaunchResponse }> {
    const generation = this.generation;
    const review = parseGuidedReview(raw);
    const connection = await this.connect();
    connection.assertCurrent();
    if (!sameTarget(review.target, connection.target))
      throw new Error("The reviewed target changed. Review the original target before submitting.");
    await connection.verifyReview(review);
    connection.assertCurrent();
    if (generation !== this.generation) throw new Error("The retained intent changed while review was pending.");
    const record = this.journal.retainGuided(connection.scope, review);
    const existing = this.pending.get(record.id);
    if (existing) return existing;
    const work = this.send(connection, record);
    this.pending.set(record.id, work);
    try {
      return await work;
    } finally {
      if (this.pending.get(record.id) === work) this.pending.delete(record.id);
    }
  }
  private async send(
    connection: GuidedIntentConnection,
    record: IntentRecord,
  ): Promise<{ intent: RetainedLaunch; response: LaunchResponse }> {
    connection.assertCurrent();
    const result = response(await connection.send(record), record.guided!.review.command.mode);
    connection.assertCurrent();
    return afterSend(() => {
      this.retainReceipt(connection, record, result);
      return {
        intent: this.journal.guidedList(connection.scope).find((r) => r.intentId === record.id)!,
        response: result,
      };
    });
  }
  async retained(): Promise<readonly RetainedLaunch[]> {
    const connection = await this.connect();
    connection.assertCurrent();
    return this.journal.guidedList(connection.scope);
  }
  async recover(id: string, action: "inspect" | "reconcile"): Promise<LaunchResponse> {
    const connection = await this.connect();
    connection.assertCurrent();
    const record = this.journal.guided(connection.scope, id);
    this.recovering.add(id);
    try {
      await connection.verifyRecovery(record);
      connection.assertCurrent();
      this.journal.guided(connection.scope, id);
      const result = response(await connection.recover(record, action), record.guided!.review.command.mode);
      connection.assertCurrent();
      afterSend(() => this.retainReceipt(connection, record, result));
      return result;
    } finally {
      this.recovering.delete(id);
    }
  }
  async abandon(id: string, confirm: () => Promise<boolean>): Promise<{ abandoned: boolean }> {
    if (this.pending.has(id) || this.recovering.has(id))
      throw new Error("Inspect the pending original intent before abandoning it.");
    const connection = await this.connect();
    connection.assertCurrent();
    this.journal.guided(connection.scope, id);
    if (!(await confirm())) return { abandoned: false };
    connection.assertCurrent();
    const current = await this.connect();
    current.assertCurrent();
    connection.assertCurrent();
    if (
      current.scope.target !== connection.scope.target ||
      current.scope.principalId !== connection.scope.principalId ||
      current.scope.workspaceId !== connection.scope.workspaceId
    )
      throw new Error("Authenticated intent scope changed during confirmation.");
    if (this.pending.has(id) || this.recovering.has(id))
      throw new Error("The original intent is pending; inspect it first.");
    this.journal.abandon(connection.scope, id);
    this.generation += 1;
    return { abandoned: true };
  }
  private retainReceipt(connection: GuidedIntentConnection, record: IntentRecord, result: LaunchResponse): void {
    let operationId: string | undefined, admissionId: string | undefined;
    if (result.kind === "retry") {
      operationId = result.receipt.operationId;
      if (result.receipt.state === "resolved")
        admissionId = (result.receipt.result as { admissionId: string }).admissionId;
    } else {
      admissionId = result.receipt.admissionId;
      if (result.kind === "direct") operationId = result.receipt.operationId;
    }
    this.journal.recordGuidedReceipt(connection.scope, record.id, {
      ...(operationId ? { operationId } : {}),
      ...(admissionId ? { admissionId } : {}),
    });
  }
}
