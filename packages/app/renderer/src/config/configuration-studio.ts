/** Provider-owned in-memory orchestration for the merged structured session and private raw editor. */
import type { ConfigGetResult, ConfigSetResult, ConfigApplyResult } from "@orca/protocol";
import type { OrcaBridge, BridgeResult } from "../../../src/bridge.js";
import type { ConfigReview, DocumentPath, EditorTarget } from "../../../src/configuration-launch-contract.js";
import { StructuredEditorSession, type EditorSnapshot } from "./structured-form/editor-session.js";
import { atPath, projectEdits } from "./structured-form/collection-model.js";
import type { EditIntent } from "./structured-form/contracts.js";
import { reconcileConfigurationEdits } from "./reconciliation.js";
import {
  ConfigurationAdapter,
  ConfigurationRefusal,
  currentEditorTarget,
  richShape,
  safeConfigurationErrors,
  sameEditorTarget,
} from "./configuration-adapter.js";

const busyPhase = (phase: EditorSnapshot["phase"]) => ["validating", "saving", "applying"].includes(phase);
const failure = (error: unknown): BridgeResult<never> => ({
  ok: false,
  error: {
    code: error instanceof ConfigurationRefusal ? error.code : "AGENT_TRANSPORT",
    message: "Configuration command refused or was not acknowledged. Draft retained.",
  },
});
/** Stable transient row keys move with rows, including nested collections; never domain IDs or indices. */
class RowIdentities {
  private next = 0;
  private rows = new Map<string, { path: DocumentPath; keys: string[] }>();
  key(path: DocumentPath, index: number): string {
    const name = JSON.stringify(path);
    let row = this.rows.get(name);
    if (!row) {
      row = { path: [...path], keys: [] };
      this.rows.set(name, row);
    }
    while (row.keys.length <= index) row.keys.push(`configuration-row-${++this.next}`);
    return row.keys[index]!;
  }
  edit(edit: EditIntent, value: unknown): void {
    const collectionPath = edit.kind === "remove" ? edit.path.slice(0, -1) : edit.path;
    const removed = edit.kind === "remove" ? edit.path.at(-1) : undefined;
    const collection = atPath(value, collectionPath);
    if ((edit.kind !== "insert" && edit.kind !== "move" && typeof removed !== "number") || !Array.isArray(collection)) {
      for (const [name, row] of this.rows) if (edit.path.every((p, i) => row.path[i] === p)) this.rows.delete(name);
      return;
    }
    collection.forEach((_, i) => this.key(collectionPath, i));
    const collectionName = JSON.stringify(collectionPath);
    const row = this.rows.get(collectionName) ?? { path: [...collectionPath], keys: [] };
    this.rows.set(collectionName, row);
    function remap(index: number): number | undefined {
      if (edit.kind === "insert") return index >= edit.index ? index + 1 : index;
      if (edit.kind === "move") {
        if (index === edit.from) return edit.to;
        if (edit.from < edit.to && index > edit.from && index <= edit.to) return index - 1;
        if (edit.to < edit.from && index >= edit.to && index < edit.from) return index + 1;
        return index;
      }
      return index === removed ? undefined : typeof removed === "number" && index > removed ? index - 1 : index;
    }
    const migrated = new Map<string, { path: DocumentPath; keys: string[] }>();
    for (const [name, child] of this.rows) {
      const offset = collectionPath.length;
      if (
        child.path.length > offset &&
        collectionPath.every((p, i) => child.path[i] === p) &&
        typeof child.path[offset] === "number"
      ) {
        const index = remap(child.path[offset]);
        if (index === undefined) continue;
        const path = [...child.path];
        path[offset] = index;
        migrated.set(JSON.stringify(path), { ...child, path });
      } else migrated.set(name, child);
    }
    this.rows = migrated;
    if (edit.kind === "insert") row.keys.splice(edit.index, 0, `configuration-row-${++this.next}`);
    else if (edit.kind === "move") row.keys.splice(edit.to, 0, row.keys.splice(edit.from, 1)[0]!);
    else row.keys.splice(removed as number, 1);
  }
}

export class ConfigurationStudio {
  private adapter: ConfigurationAdapter;
  private session: StructuredEditorSession;
  private listeners = new Set<() => void>();
  private rows = new RowIdentities();
  private stale = false;
  private targetOnly = false;
  private reading = false;
  private rawText: string | undefined;
  private rawSequence = 0;
  private rawState: EditorSnapshot = { phase: "editing", sequence: 0, edits: [], errors: [], changes: [] };
  private saved: { revision: string; generation: string } | undefined;
  private disposed = false;
  mode: "form" | "raw" = "form";
  constructor(
    private data: ConfigGetResult,
    readonly target: EditorTarget,
    private bridge: OrcaBridge,
    private changedSource: () => void,
  ) {
    this.adapter = new ConfigurationAdapter(
      target,
      bridge,
      () => this.data,
      (action) => this.reason(action),
    );
    this.session = this.createSession();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(): void {
    if (!this.disposed) for (const listener of this.listeners) listener();
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
  get source(): ConfigGetResult {
    return this.data;
  }
  get readable(): boolean {
    const connection = this.bridge.connection.read();
    return (
      sameEditorTarget(this.target, currentEditorTarget(this.bridge)) &&
      (connection.state !== "live" || Boolean(connection.methods?.includes("config.get")))
    );
  }
  get shape() {
    return richShape(this.data);
  }
  get state(): EditorSnapshot {
    return this.mode === "form" ? this.session.snapshot() : this.rawState;
  }
  get dirty(): boolean {
    return this.session.snapshot().edits.length > 0 || this.rawText !== undefined;
  }
  get busy(): boolean {
    return this.reading || busyPhase(this.state.phase);
  }
  get retained(): boolean {
    return this.dirty || this.busy || (this.stale && !this.targetOnly);
  }
  get frozen(): boolean {
    return this.stale;
  }
  get review(): ConfigReview | undefined {
    const held = this.adapter.reviewed;
    return this.state.phase === "reviewed" && held?.candidate.draftSequence === this.state.sequence ? held : undefined;
  }
  get privateCandidate(): string | undefined {
    return this.review ? this.adapter.privateText : undefined;
  }
  get raw(): string {
    return this.rawText ?? this.data.config.text;
  }
  get value(): unknown {
    return projectEdits(this.data.config.parsed ?? {}, this.session.snapshot().edits);
  }
  rowKey = (path: DocumentPath, index: number): string => this.rows.key(path, index);
  reason(action: "validate" | "save" | "apply"): string | undefined {
    if (this.disposed || !sameEditorTarget(this.target, currentEditorTarget(this.bridge)))
      return "This draft belongs to a previous daemon target.";
    if (this.stale)
      return "Read current configuration, then explicitly discard this retained draft before a new review.";
    const connection = this.bridge.connection.read();
    if (connection.state !== "live") return "Wait for the daemon connection before sending this action.";
    if (!connection.methods?.includes("config.get"))
      return "Current source authority is unavailable. Restore access before reviewing retained edits.";
    const method = action === "apply" ? "config.apply" : "config.set";
    if (!connection.methods?.includes(method) || (action === "apply" && !this.bridge.config.apply))
      return `This daemon does not offer ${method}.`;
    if (this.mode === "form" && !this.shape)
      return "Structured metadata is missing or unsupported. The authorized raw editor is available.";
    if (action === "apply") {
      if (!this.saved || this.dirty)
        return this.data.generation
          ? "Save the reviewed draft before applying it."
          : "Saved generation status is unavailable.";
      if (
        this.data.config.revision !== this.saved.revision ||
        this.data.generation?.activeGeneration !== this.saved.generation
      )
        return "Saved source or active generation changed. Read and review current state.";
    }
    return undefined;
  }
  private createSession(): StructuredEditorSession {
    return new StructuredEditorSession(this.target, this.data.config.revision, {
      lowering: {
        preservesComments: true,
        lower: async (candidate) => {
          try {
            await this.adapter.review(candidate);
            return { status: "ready", text: this.adapter.privateText! };
          } catch (error) {
            this.refused(error, false);
            throw error;
          }
        },
      },
      access: (action) => {
        const reason = this.reason(action);
        return reason ? { allowed: false, reason } : { allowed: true };
      },
      policyChange: () => this.adapter.policyChange(),
      safeErrors: (errors) =>
        safeConfigurationErrors(this.shape, [this.data.config.parsed, this.adapter.candidateParsed], errors),
      set: async (params) => {
        if (params.validateOnly) {
          try {
            const response = await this.adapter.validateText(params);
            if (!response.ok) this.refused(new ConfigurationRefusal(response.error.code), false);
            return response;
          } catch (error) {
            this.refused(error, false);
            throw error;
          }
        }
        try {
          const review = this.adapter.reviewed;
          if (
            !review ||
            params.text !== this.adapter.privateText ||
            params.expectedRevision !== review.candidate.expectedRevision
          )
            throw new Error("Private reviewed candidate changed.");
          const sequence = this.session.snapshot().sequence;
          const response = await this.adapter.save(review);
          if (sequence !== this.session.snapshot().sequence) this.stale = true;
          else this.acceptSaved(response);
          this.changedSource();
          return { ok: true, result: response };
        } catch (error) {
          this.refused(error, true);
          return failure(error);
        }
      },
      apply: async (params) => {
        try {
          const result = await this.adapter.apply(params, this.target);
          this.acceptApply(result);
          this.changedSource();
          return { ok: true, result };
        } catch (error) {
          this.refused(error, true);
          return failure(error);
        }
      },
    });
  }
  private refused(error: unknown, writing: boolean): void {
    if (
      (error instanceof ConfigurationRefusal && error.code === "CONFIG_STALE") ||
      (writing && !(error instanceof ConfigurationRefusal))
    )
      this.stale = true;
  }
  private acceptSaved(result: ConfigSetResult): void {
    this.data = {
      ...this.data,
      config: result.document,
      ...(result.generation ? { generation: result.generation } : {}),
    };
    this.saved = result.generation
      ? { revision: result.document.revision, generation: result.generation.activeGeneration }
      : undefined;
  }
  private acceptApply(result: ConfigApplyResult): void {
    this.data = { ...this.data, generation: result.status };
    this.saved = undefined;
  }
  observe(data: ConfigGetResult, target: EditorTarget | undefined): void {
    if (!sameEditorTarget(target, this.target)) {
      this.freezeTarget();
      return;
    }
    if (data.config.revision !== this.data.config.revision && this.retained) {
      // A push may precede our acknowledgement. Only the exact retained candidate can
      // be our pending write; every other changed source freezes the old operation list.
      if (
        data.config.revision !== this.adapter.reviewed?.candidateRevision ||
        data.config.text !== this.adapter.privateText
      )
        this.stale = true;
    } else if (!this.retained) {
      const moved = data.config.revision !== this.data.config.revision;
      this.data = data;
      if (moved) {
        this.adapter.invalidate();
        this.session = this.createSession();
        this.rows = new RowIdentities();
      }
    }
    this.emit();
  }
  freezeTarget(): void {
    // A clean target change is replaced by ConnectionBoundary without a draft prompt.
    this.targetOnly = !this.retained;
    this.stale = true;
    this.session.setTarget({ workspaceId: "", instanceId: "", epoch: -1 });
    this.rawState = {
      ...this.rawState,
      phase: "blocked",
      message: "Target changed. Draft retained with its original workspace.",
    };
    this.emit();
  }
  editAccess(edits: readonly EditIntent[]): import("./structured-form/contracts.js").EditAccess {
    const reason = this.reason("validate");
    if (reason) return { allowed: false, reason };
    try {
      projectEdits(this.value, edits);
    } catch {
      return {
        allowed: false,
        reason: "This edit is unavailable in Form. Use the authorized raw editor for whole-document replacement.",
      };
    }
    return { allowed: true };
  }
  edit(edits: readonly EditIntent[]): void {
    if (!this.editAccess(edits).allowed || this.mode !== "form") return;
    let value = this.value;
    // Validate the entire display projection before recording any partial edit batch.
    projectEdits(value, edits);
    if (!this.session.edit(edits)) return;
    for (const edit of edits) {
      this.rows.edit(edit, value);
      value = projectEdits(value, [edit]);
    }
    this.adapter.invalidate();
    this.saved = undefined;
    this.emit();
  }
  editRaw(text: string): void {
    if (this.reason("validate") || this.mode !== "raw") return;
    this.rawText = text === this.data.config.text ? undefined : text;
    this.rawSequence++;
    this.adapter.invalidate();
    this.saved = undefined;
    this.rawState = { phase: "editing", sequence: this.rawSequence, edits: [], errors: [], changes: [] };
    this.emit();
  }
  switchMode(mode: "form" | "raw", discard = false): boolean {
    if (mode === this.mode) return true;
    if (this.busy || (this.retained && !discard)) return false;
    if (discard) this.discard();
    this.mode = mode;
    this.emit();
    return true;
  }
  discard(): void {
    if (this.busy) return;
    this.rawText = undefined;
    this.rawSequence++;
    this.adapter.invalidate();
    this.saved = undefined;
    this.rawState = { phase: "editing", sequence: this.rawSequence, edits: [], errors: [], changes: [] };
    this.session = this.createSession();
    this.rows = new RowIdentities();
    this.emit();
  }
  policyChange(): boolean {
    return this.adapter.policyChange();
  }
  async validate(): Promise<void> {
    if (this.busy || !this.dirty || this.reason("validate")) return;
    if (this.mode === "form") {
      const pending = this.session.validate();
      this.emit();
      await pending;
      this.emit();
      return;
    }
    const sequence = this.rawSequence;
    const text = this.rawText!;
    this.rawState = { phase: "validating", sequence, edits: [], errors: [], changes: [] };
    this.emit();
    try {
      const review = await this.adapter.review(
        {
          target: this.target,
          document: "config",
          expectedRevision: this.data.config.revision,
          draftSequence: sequence,
          edits: [],
        },
        text,
      );
      if (sequence !== this.rawSequence || !sameEditorTarget(this.target, currentEditorTarget(this.bridge))) return;
      this.rawState = {
        ...this.rawState,
        phase: review.validation.length ? "blocked" : "reviewed",
        errors: safeConfigurationErrors(
          this.shape,
          [this.data.config.parsed, this.adapter.candidateParsed],
          review.validation,
        ),
        message: review.validation.length
          ? "Validation refused. Draft retained."
          : "Validated. Review the exact candidate before saving.",
      };
    } catch (error) {
      this.refused(error, false);
      if (sequence === this.rawSequence)
        this.rawState = { ...this.rawState, phase: "blocked", message: "Validation unavailable. Draft retained." };
    } finally {
      if (sequence === this.rawSequence && this.rawState.phase === "validating")
        this.rawState = { ...this.rawState, phase: "editing" };
      this.emit();
    }
  }
  async save(policyConfirmed = false): Promise<void> {
    const review = this.review;
    if (!review || this.busy || this.reason("save") || (this.adapter.policyChange() && !policyConfirmed)) return;
    if (this.mode === "form") {
      if (policyConfirmed) this.session.confirmPolicy(this.state.sequence);
      const pending = this.session.save();
      this.emit();
      await pending;
      this.emit();
      return;
    }
    const sequence = this.rawSequence;
    this.rawState = { ...this.rawState, phase: "saving" };
    this.emit();
    try {
      const response = await this.adapter.save(review);
      if (sequence !== this.rawSequence) {
        this.stale = true;
        return;
      }
      this.acceptSaved(response);
      this.rawText = undefined;
      this.rawState = {
        ...this.rawState,
        phase: "saved",
        message: "Saved. Apply separately to activate future launches.",
      };
      this.changedSource();
    } catch (error) {
      this.refused(error, true);
      this.rawState = {
        ...this.rawState,
        phase: "blocked",
        message: "Write refused or not acknowledged. Read current state; draft retained.",
      };
    } finally {
      if (sequence !== this.rawSequence)
        this.rawState = {
          ...this.rawState,
          phase: "blocked",
          message: "Earlier candidate saved. Newer raw edits retained; read and reconcile.",
        };
      this.emit();
    }
  }
  async apply(): Promise<void> {
    if (this.busy || this.reason("apply")) return;
    if (this.mode === "form") {
      const pending = this.session.apply();
      this.emit();
      await pending;
      this.emit();
      return;
    }
    const saved = this.saved!;
    const sequence = this.rawSequence;
    this.rawState = { ...this.rawState, phase: "applying" };
    this.emit();
    try {
      const result = await this.adapter.apply(
        { expectedRevision: saved.revision, expectedGeneration: saved.generation },
        this.target,
      );
      const active = result.outcome === "applied" || result.outcome === "unchanged";
      this.acceptApply(result);
      if (sequence === this.rawSequence)
        this.rawState = {
          ...this.rawState,
          phase: active ? "active" : "saved",
          applyOutcome: result.outcome,
          errors: safeConfigurationErrors(this.shape, [this.data.config.parsed], result.validation.errors),
          message: `Apply outcome: ${result.outcome}.`,
        };
      this.changedSource();
    } catch (error) {
      this.refused(error, true);
      this.rawState = {
        ...this.rawState,
        phase: "blocked",
        message: "Apply not acknowledged. Read current state before another action.",
      };
    } finally {
      this.emit();
    }
  }
  /** Reread is inspection. Replacing an unresolved operation list requires explicit discard. */
  async readCurrent(discard = false): Promise<void> {
    if (this.busy || !sameEditorTarget(this.target, currentEditorTarget(this.bridge))) return;
    const sequence = this.state.sequence;
    const mode = this.mode;
    const retained = this.retained;
    this.reading = true;
    this.emit();
    try {
      const response = await this.adapter.read();
      // A discard decision applies only to the draft that existed when the read began.
      if (sequence !== this.state.sequence || mode !== this.mode) {
        this.stale = true;
        return;
      }
      if (retained && !discard) {
        if (mode === "form") {
          const reconciliation = reconcileConfigurationEdits(
            this.data.config.parsed ?? {},
            response.config.parsed ?? {},
            this.session.snapshot().edits,
          );
          if (
            reconciliation.conflicts.length === 0 &&
            this.session.reconcile(this.target, response.config.revision, reconciliation.edits)
          ) {
            this.data = response;
            this.stale = false;
            this.adapter.invalidate();
            this.saved = undefined;
            this.rows = new RowIdentities();
            return;
          }
        }
        this.stale = true;
        return;
      }
      this.reading = false;
      this.stale = false;
      this.data = response;
      this.discard();
      this.changedSource();
    } catch {
      this.stale = true;
    } finally {
      this.reading = false;
      this.emit();
    }
  }
}
