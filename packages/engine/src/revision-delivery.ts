/** Single-slot corrective input and conservative handoff accounting. A claimed prompt is never replayed automatically. */
import { randomUUID } from "node:crypto";
import type { OrcaError } from "@orca/core";
import type {
  PendingRevisionTarget,
  RevisionPayload,
  RevisionProvenance,
} from "../../core/src/model/revision-input.js";
import { exactRevision, type RevisionJournal, type RevisionRecord } from "./revision-input.js";

export interface RevisionSlot {
  revisionId: string;
  payload: RevisionPayload;
  provenance: RevisionProvenance;
}
export interface RevisionDeliveryTarget extends PendingRevisionTarget {
  nodeId: string;
}
export interface RevisionHandoff {
  target: RevisionDeliveryTarget;
  handoffId: string;
  prompt: string;
}

/** Values remain only in `revision`; text is a separate instruction block, never a template expression. */
export function assembleRevisionPrompt(base: string, slot: RevisionSlot): string {
  if (slot.payload.kind === "values") return base;
  return `${base}\n\nHuman revision (${slot.revisionId})\nThe following correction applies to this attempt only. Tool permissions and workflow gates still apply.\n\n${slot.payload.text}`;
}
export class RevisionDelivery {
  constructor(
    private readonly opts: {
      journal: RevisionJournal;
      /** Current execution, run/resource and revision-content authority, rechecked on every operation. */
      authorize: (runId: string) => Promise<void>;
      stale: () => OrcaError;
    },
  ) {}

  async claim(
    target: RevisionDeliveryTarget,
    render: (slot: RevisionSlot) => Promise<string>,
  ): Promise<RevisionHandoff> {
    await this.opts.authorize(target.runId);
    return this.opts.journal.withRun(target.runId, async (tx) => {
      await this.opts.authorize(target.runId);
      const record = await exactRevision(tx, target, this.opts.stale);
      const boundary = await tx.boundary(target.destinationId);
      if (
        !boundary ||
        boundary.status !== "answered" ||
        boundary.currentRevisionId !== target.revisionId ||
        boundary.attemptId !== target.attemptId ||
        record.capability.destinationNodeId !== target.nodeId ||
        record.delivery !== "unclaimed" ||
        record.receipt.state !== "pending"
      )
        throw this.opts.stale();
      const slot: RevisionSlot = {
        revisionId: target.revisionId,
        payload: structuredClone(record.payload),
        provenance: structuredClone(record.provenance),
      };
      const prompt = assembleRevisionPrompt(await render(slot), slot);
      const handoffId = randomUUID();
      await this.opts.authorize(target.runId);
      await tx.transition(
        {
          ...record,
          delivery: "claimed",
          prompt,
          handoffId,
          receipt: { ...record.receipt, expectedRevision: randomUUID() },
        },
        record.receipt.expectedRevision,
      );
      return { target, handoffId, prompt };
    });
  }

  /** Recheck immediately before the original send while the interpreter still owns the execution lease. */
  async beforeSend(handoff: RevisionHandoff): Promise<void> {
    await this.opts.authorize(handoff.target.runId);
    await this.opts.journal.withRun(handoff.target.runId, async (tx) => {
      await this.opts.authorize(handoff.target.runId);
      const record = await exactRevision(tx, handoff.target, this.opts.stale);
      const boundary = await tx.boundary(handoff.target.destinationId);
      if (
        record.handoffId !== handoff.handoffId ||
        record.delivery !== "claimed" ||
        !boundary ||
        boundary.status !== "answered" ||
        boundary.currentRevisionId !== handoff.target.revisionId
      )
        throw this.opts.stale();
    });
  }

  /** Call only after evidence from the original external turn; process death leaves a pending, non-replayable claim. */
  async confirm(handoff: RevisionHandoff): Promise<void> {
    await this.settle(handoff, "confirmed");
  }
  async uncertain(handoff: RevisionHandoff): Promise<void> {
    await this.settle(handoff, "uncertain");
  }
  private async settle(handoff: RevisionHandoff, delivery: "confirmed" | "uncertain"): Promise<void> {
    await this.opts.authorize(handoff.target.runId);
    await this.opts.journal.withRun(handoff.target.runId, async (tx) => {
      await this.opts.authorize(handoff.target.runId);
      const record = await exactRevision(tx, handoff.target, this.opts.stale);
      if (record.handoffId !== handoff.handoffId) throw this.opts.stale();
      if (record.delivery === delivery) return;
      if (record.delivery !== "claimed") throw this.opts.stale();
      await tx.transition(
        {
          ...record,
          delivery,
          receipt: {
            ...record.receipt,
            state: delivery === "confirmed" ? "delivered" : "pending",
            expectedRevision: randomUUID(),
          },
        },
        record.receipt.expectedRevision,
      );
    });
  }
}

/** Used by the runtime's cancellation journal under its existing fence, before any subsequent dispatch. */
export function rejectUndeliveredRevision(record: RevisionRecord): RevisionRecord {
  if (record.delivery !== "unclaimed" || record.receipt.state !== "pending") return record;
  return { ...record, receipt: { ...record.receipt, state: "rejected", expectedRevision: randomUUID() } };
}
