/** Target/revision/sequence guarded validate-review-save-apply, retaining refused and ambiguous drafts. */
import {
  ConfigValidationErrorSchema,
  type ConfigDocumentView,
  type ConfigApplyResult,
  type ProtocolError,
} from "@orca/protocol";
import type {
  ConfigCandidate,
  ChangeSummary,
  EditorTarget,
  EditIntent,
  FieldError,
  StructuredEditorPorts,
} from "./contracts.js";

export type EditorPhase =
  "editing" | "validating" | "reviewed" | "saving" | "saved" | "applying" | "active" | "blocked";
export interface EditorSnapshot {
  readonly phase: EditorPhase;
  readonly sequence: number;
  readonly edits: readonly EditIntent[];
  readonly errors: readonly FieldError[];
  readonly changes: readonly ChangeSummary[];
  readonly message?: string;
  readonly applyOutcome?: ConfigApplyResult["outcome"];
}
const sameTarget = (a: EditorTarget, b: EditorTarget): boolean =>
  a.workspaceId === b.workspaceId && a.instanceId === b.instanceId && a.epoch === b.epoch;

/** Kept above surfaces by integration. No disk/localStorage persistence and no automatic rebasing/retry. */
export class StructuredEditorSession {
  private target: EditorTarget;
  private currentTarget: EditorTarget;
  private revision: string;
  private sequence = 0;
  private operation = 0;
  private edits: readonly EditIntent[] = [];
  private phase: EditorPhase = "editing";
  private errors: readonly FieldError[] = [];
  private message: string | undefined;
  private review: { sequence: number; text: string; revision: string; policyConfirmed: boolean } | undefined;
  private saved: { revision: string; generation: string } | undefined;
  private applyOutcome: ConfigApplyResult["outcome"] | undefined;
  private frozen = false;
  private busy = false;

  constructor(
    target: EditorTarget,
    revision: string,
    private readonly ports: StructuredEditorPorts,
  ) {
    this.target = { ...target };
    this.currentTarget = { ...target };
    this.revision = revision;
  }
  snapshot(): EditorSnapshot {
    return {
      phase: this.phase,
      sequence: this.sequence,
      edits: structuredClone(this.edits),
      errors: this.errors.map((error) => ({ ...error, path: [...error.path] })),
      changes: this.edits.map((edit) => ({ path: [...edit.path], kind: edit.kind })),
      ...(this.message === undefined ? {} : { message: this.message }),
      ...(this.applyOutcome === undefined ? {} : { applyOutcome: this.applyOutcome }),
    };
  }
  /** Change summaries contain paths/kinds only, never default, enum, source text or value bodies. */
  candidate(): ConfigCandidate {
    return {
      target: { ...this.target },
      document: "config",
      expectedRevision: this.revision,
      draftSequence: this.sequence,
      edits: structuredClone(this.edits),
    };
  }
  edit(edits: readonly EditIntent[]): boolean {
    if (this.frozen || !sameTarget(this.target, this.currentTarget)) return false;
    const next = [...this.edits];
    for (const edit of structuredClone(edits)) {
      const previous = next.at(-1);
      // Only adjacent sets to the same typed path can replace one another.
      // Structural operations and other paths remain ordered barriers.
      if (
        edit.kind === "set" &&
        previous?.kind === "set" &&
        edit.path.length === previous.path.length &&
        edit.path.every((segment, index) => segment === previous.path[index])
      ) {
        next[next.length - 1] = edit;
      } else next.push(edit);
    }
    this.edits = next;
    this.sequence++;
    this.review = undefined;
    this.applyOutcome = undefined;
    this.errors = [];
    if (!this.busy) this.phase = "editing";
    this.message = undefined;
    return true;
  }
  setTarget(target: EditorTarget): void {
    this.currentTarget = { ...target };
    if (!sameTarget(this.target, target)) {
      this.operation++;
      this.frozen = true;
      this.busy = false;
      this.review = undefined;
      this.block("Target changed. This draft remains with its original workspace.");
    }
  }
  /** Explicit reconciliation replaces a draft only after the owner obtains user review/discard. */
  reconcile(target: EditorTarget, revision: string, edits: readonly EditIntent[]): boolean {
    if (!sameTarget(target, this.target) || !sameTarget(target, this.currentTarget) || this.busy) return false;
    this.operation++;
    this.revision = revision;
    this.edits = structuredClone(edits);
    this.sequence++;
    this.frozen = false;
    this.review = undefined;
    this.saved = undefined;
    this.errors = [];
    this.message = undefined;
    this.phase = "editing";
    return true;
  }
  private block(message: string): void {
    this.phase = "blocked";
    this.message = message;
  }
  private live(operation: number): boolean {
    return operation === this.operation && sameTarget(this.target, this.currentTarget);
  }
  private allowed(action: "validate" | "save" | "apply", candidate: ConfigCandidate): boolean {
    if (this.frozen || !sameTarget(this.target, this.currentTarget)) return false;
    const access = this.ports.access(action, candidate);
    if (!access.allowed) {
      this.block(access.reason);
      return false;
    }
    return true;
  }
  private failure(code: string, saving: boolean, candidateSequence: number, error?: ProtocolError): void {
    this.review = undefined;
    if (code === "CONFIG_STALE") {
      this.frozen = true;
      this.block("Configuration changed. Retain this draft and reconcile before a new review.");
    } else if (code === "CONFIG_INVALID") {
      if (candidateSequence !== this.sequence) {
        this.errors = [];
        this.block("Earlier candidate refused. Newer edits retained; validate and review them again.");
        return;
      }
      const errors = ConfigValidationErrorSchema.array().safeParse(error?.details?.["errors"]);
      this.errors = errors.success ? this.ports.safeErrors(errors.data) : [];
      this.block("Validation refused. Draft retained; resolve the reported fields and review again.");
    } else if (
      code === "AUTH_FORBIDDEN" ||
      code === "AUTH_REQUIRED" ||
      code === "AUTH_INVALID" ||
      code === "PROTOCOL_METHOD"
    ) {
      this.block("Current authority or method availability refused this action. Draft retained.");
    } else if (saving) {
      this.frozen = true;
      this.block("Write was not acknowledged. Read current state before another write.");
    } else this.block("Validation or authorization refused. Draft retained.");
  }
  async validate(): Promise<void> {
    const candidate = this.candidate();
    if (this.busy || candidate.edits.length === 0 || !this.allowed("validate", candidate)) return;
    const operation = ++this.operation;
    this.busy = true;
    this.phase = "validating";
    this.review = undefined;
    try {
      const lowered = await this.ports.lowering.lower(candidate);
      if (!this.live(operation) || candidate.draftSequence !== this.sequence) return;
      if (lowered.status !== "ready") {
        this.block("Comment-preserving editing is unavailable. Draft retained.");
        return;
      }
      if (!this.allowed("validate", candidate)) return;
      const result = await this.ports.set({
        document: "config",
        expectedRevision: candidate.expectedRevision,
        text: lowered.text,
        validateOnly: true,
      });
      if (!this.live(operation) || candidate.draftSequence !== this.sequence) return;
      if (!this.allowed("validate", candidate)) return;
      if (!result.ok) {
        this.failure(result.error.code, false, candidate.draftSequence, result.error);
        return;
      }
      if (
        result.result.written ||
        result.result.document.document !== "config" ||
        result.result.validation === undefined
      ) {
        this.block("Validation acknowledgement was unexpected. Draft retained.");
        return;
      }
      this.errors = this.ports.safeErrors(result.result.validation.errors);
      if (result.result.validation.errors.length > 0) {
        this.block("Validation failed. Resolve the reported fields before review.");
        return;
      }
      // The validated bytes/revision, rather than a reconstructed form value, are the review.
      this.review = {
        sequence: this.sequence,
        text: result.result.document.text,
        revision: result.result.document.revision,
        policyConfirmed: false,
      };
      this.phase = "reviewed";
      this.message = "Validated. Review changes before saving.";
    } catch {
      if (this.live(operation)) this.block("Validation unavailable. Draft retained.");
    } finally {
      if (this.live(operation)) {
        this.busy = false;
        if (candidate.draftSequence !== this.sequence) this.phase = "editing";
      }
    }
  }
  /** Separate exact policy confirmation; validation itself never authorizes a policy change. */
  confirmPolicy(sequence: number): boolean {
    if (this.review?.sequence !== sequence || this.sequence !== sequence) return false;
    this.review.policyConfirmed = true;
    return true;
  }
  async save(): Promise<void> {
    const review = this.review;
    const candidate = this.candidate();
    if (this.busy || !review || review.sequence !== this.sequence || !this.allowed("save", candidate)) return;
    if (this.ports.policyChange(candidate) && !review.policyConfirmed) {
      this.message = "Confirm the exact policy change before saving.";
      return;
    }
    const operation = ++this.operation;
    this.busy = true;
    this.phase = "saving";
    try {
      const result = await this.ports.set({
        document: "config",
        expectedRevision: candidate.expectedRevision,
        text: review.text,
      });
      if (!this.live(operation)) return;
      if (!result.ok) {
        this.failure(result.error.code, true, candidate.draftSequence, result.error);
        return;
      }
      const document: ConfigDocumentView = result.result.document;
      if (
        !result.result.written ||
        document.document !== "config" ||
        document.revision !== review.revision ||
        document.text !== review.text
      ) {
        this.failure("UNEXPECTED_ACK", true, candidate.draftSequence);
        return;
      }
      this.review = undefined;
      if (candidate.draftSequence !== this.sequence) {
        this.frozen = true;
        this.block("Reviewed changes saved. Newer edits are retained; reconcile them with the saved revision.");
        return;
      }
      this.edits = [];
      this.revision = document.revision;
      this.saved = result.result.generation?.activeGeneration
        ? { revision: document.revision, generation: result.result.generation.activeGeneration }
        : undefined;
      this.phase = "saved";
      this.message = "Saved. Activation requires an explicit guarded apply.";
    } catch {
      if (this.live(operation)) this.failure("RESPONSE_LOST", true, candidate.draftSequence);
    } finally {
      if (this.live(operation)) this.busy = false;
    }
  }
  async apply(): Promise<void> {
    const saved = this.saved;
    const candidate = this.candidate();
    if (this.busy || !saved || this.edits.length > 0 || !this.allowed("apply", candidate)) return;
    const operation = ++this.operation;
    this.busy = true;
    this.phase = "applying";
    try {
      const result = await this.ports.apply({ expectedRevision: saved.revision, expectedGeneration: saved.generation });
      if (!this.live(operation)) return;
      if (!result.ok) {
        this.failure(result.error.code, true, candidate.draftSequence, result.error);
        return;
      }
      const active = result.result.outcome === "applied" || result.result.outcome === "unchanged";
      if (
        active &&
        (result.result.status.savedRevision !== saved.revision ||
          result.result.status.activeRevision !== saved.revision ||
          result.result.status.state !== "active" ||
          result.result.validation.errors.length > 0)
      ) {
        this.failure("UNEXPECTED_ACK", true, candidate.draftSequence);
        return;
      }
      this.applyOutcome = result.result.outcome;
      this.errors =
        candidate.draftSequence === this.sequence ? this.ports.safeErrors(result.result.validation.errors) : [];
      this.phase = this.edits.length > 0 ? "editing" : active ? "active" : "saved";
      this.message = `Apply outcome: ${result.result.outcome}.`;
      this.saved = undefined; // Any next attempt needs fresh authoritative generations.
    } catch {
      if (this.live(operation)) this.failure("RESPONSE_LOST", true, candidate.draftSequence);
    } finally {
      if (this.live(operation)) this.busy = false;
    }
  }
}
