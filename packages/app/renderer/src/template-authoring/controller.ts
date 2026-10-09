/** Revision- and target-fenced source drafts over explicitly injected authoring ports. */
import {
  exportSource,
  sameTarget,
  type AuthoringCandidate,
  type AuthoringError,
  type AuthoringPorts,
  type AuthoringReview,
  type AuthoringSnapshot,
  type FixtureInputs,
  type PromptPreview,
  type SourceEdit,
  resolveTemplate,
} from "./model.js";

export interface AuthoringState {
  readonly base: AuthoringSnapshot;
  readonly edits: readonly SourceEdit[];
  readonly sequence: number;
  readonly busy: boolean;
  readonly saving?: boolean;
  readonly blocked?: string;
  readonly message?: string;
  readonly review?: AuthoringReview;
  readonly preview?: PromptPreview;
  readonly errors?: readonly AuthoringError[];
  readonly variants?: readonly { readonly key: string; readonly id: string }[];
}

/** In-memory draft. Refusals and refreshes never rebase or discard a person's source. */
export class TemplateAuthoringController {
  private state: AuthoringState;
  private listeners = new Set<() => void>();
  private operation = 0;
  private created = new Map<string, string>();
  private readable: Set<string>;
  private pendingPreview: number | undefined;

  constructor(
    base: AuthoringSnapshot,
    readonly ports: AuthoringPorts,
  ) {
    this.state = { base, edits: [], sequence: 0, busy: false };
    this.readable = new Set(
      base.assets.filter((asset) => asset.source.state === "available").map((asset) => asset.key),
    );
  }

  getSnapshot = (): AuthoringState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(state: AuthoringState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  candidate(): AuthoringCandidate {
    return Object.freeze({
      target: Object.freeze({ ...this.state.base.target }),
      expectedRevision: this.state.base.revision,
      expectedGeneration: this.state.base.generation,
      sequence: this.state.sequence,
      edits: Object.freeze(this.state.edits.map((edit) => Object.freeze({ ...edit }))),
    });
  }

  edit(key: string, text: string): boolean {
    const asset = this.state.base.assets.find((entry) => entry.key === key);
    if (
      this.state.blocked ||
      this.state.base.writeReason ||
      !this.canRead(key) ||
      (asset?.source.state !== "available" && !this.created.has(key))
    )
      return false;
    this.replaceEdit(key, asset?.source.state === "available" && text === asset.source.text ? undefined : text);
    return true;
  }

  private replaceEdit(key: string, text: string | undefined): void {
    const { review: _review, preview: _preview, message: _message, errors: _errors, ...rest } = this.state;
    const edits = this.state.edits.filter((entry) => entry.key !== key);
    if (text !== undefined) edits.push({ key, text });
    this.update({ ...rest, edits, sequence: rest.sequence + 1 });
  }

  /** Imported source is retained byte for byte and must pass the same validation as edits. */
  importSource(key: string, text: string): boolean {
    return this.edit(key, text);
  }

  exportSource(key: string): string | undefined {
    if (!this.canRead(key)) return undefined;
    const asset = this.state.base.assets.find((entry) => entry.key === key);
    return asset === undefined
      ? this.created.has(key)
        ? this.state.edits.find((edit) => edit.key === key)?.text
        : undefined
      : exportSource(asset, this.state.edits);
  }

  private canRead(key: string): boolean {
    return this.readable.has(this.created.get(key) ?? key);
  }

  /** Preview controls have their own lifetime; invalidating them never cancels a source save. */
  invalidatePreview(): void {
    const { preview: _preview, ...rest } = this.state;
    if (this.pendingPreview === this.operation) {
      this.operation += 1;
      this.pendingPreview = undefined;
      this.update({ ...rest, busy: false });
    } else {
      this.update(rest);
    }
  }

  discard(): void {
    if (this.state.busy) return;
    this.created.clear();
    const {
      review: _review,
      preview: _preview,
      message: _message,
      errors: _errors,
      variants: _variants,
      ...rest
    } = this.state;
    this.update({ ...rest, edits: [], sequence: rest.sequence + 1 });
  }

  /** Invoked by the parent target/generation feed. Old acknowledgements become inert. */
  observe(snapshot: AuthoringSnapshot): void {
    const base = this.state.base;
    // Read visibility is current authority and can change without any content/write fence.
    const sameIdentity = sameTarget(base.target, snapshot.target);
    if (!sameIdentity) this.readable = new Set();
    const nextReadable = new Set(
      snapshot.assets.filter((asset) => asset.source.state === "available").map((asset) => asset.key),
    );
    const visibilityChanged =
      sameIdentity &&
      (this.readable.size !== nextReadable.size || [...this.readable].some((key) => !nextReadable.has(key)));
    if (sameIdentity) this.readable = nextReadable;
    if (!sameIdentity || base.revision !== snapshot.revision || base.generation !== snapshot.generation) {
      this.operation += 1;
      this.pendingPreview = undefined;
      const { review: _review, preview: _preview, ...rest } = this.state;
      this.update({
        ...rest,
        busy: false,
        blocked: "The target, source revision, or active generation changed. Reconcile this draft before publishing.",
      });
    } else if (visibilityChanged || snapshot.writeReason !== base.writeReason) {
      this.operation += 1;
      this.pendingPreview = undefined;
      const { review: _review, preview: _preview, ...rest } = this.state;
      this.update({
        ...rest,
        base: snapshot,
        busy: false,
        ...(visibilityChanged
          ? {
              blocked:
                "Source access changed. Retained edits stay private; restore access and reconcile before continuing.",
            }
          : {}),
      });
    }
  }

  async refresh(): Promise<void> {
    try {
      this.observe(await this.ports.read());
    } catch {
      this.update({
        ...this.state,
        blocked: "Source refresh failed. Keep this draft and reconcile before publishing.",
      });
    }
  }

  /** Explicit source reconciliation retains edits and always requires a fresh review. */
  reconcile(snapshot: AuthoringSnapshot, retain: boolean): boolean {
    if (this.state.busy || !sameTarget(this.state.base.target, snapshot.target) || snapshot.writeReason) return false;
    if (
      retain &&
      this.state.edits.some(
        (edit) => !snapshot.assets.some((asset) => asset.key === edit.key && asset.source.state === "available"),
      )
    )
      return false;
    this.operation++;
    this.pendingPreview = undefined;
    this.created.clear();
    this.readable = new Set(
      snapshot.assets.filter((asset) => asset.source.state === "available").map((asset) => asset.key),
    );
    this.update({
      base: snapshot,
      edits: retain ? this.state.edits : [],
      sequence: this.state.sequence + 1,
      busy: false,
      message: retain
        ? "Retained source rebased explicitly. Validate and review before saving."
        : "Current saved sources loaded. Unsaved changes discarded.",
    });
    return true;
  }

  private begin(): { ticket: number; candidate: AuthoringCandidate } | undefined {
    if (this.state.busy || this.state.blocked || this.state.base.writeReason) return undefined;
    const ticket = ++this.operation;
    const candidate = this.candidate();
    this.update({ ...this.state, busy: true });
    return { ticket, candidate };
  }

  private current(ticket: number, candidate: AuthoringCandidate): boolean {
    return (
      ticket === this.operation &&
      candidate.sequence === this.state.sequence &&
      sameTarget(candidate.target, this.state.base.target)
    );
  }

  private finish(ticket: number): void {
    if (ticket === this.operation) {
      const { saving: _saving, ...rest } = this.state;
      this.update({ ...rest, busy: false });
    }
  }

  async validate(): Promise<void> {
    const request = this.begin();
    if (!request) return;
    const { review: _review, errors: _errors, ...rest } = this.state;
    this.update(rest);
    try {
      const review = await this.ports.validate(request.candidate);
      if (this.current(request.ticket, request.candidate)) this.update({ ...this.state, review });
    } catch {
      if (this.current(request.ticket, request.candidate))
        this.update({ ...this.state, message: "Validation failed. The draft is retained." });
    } finally {
      this.finish(request.ticket);
    }
  }

  async preview(id: string, pack: string | undefined, fixtures: FixtureInputs): Promise<void> {
    const asset = resolveTemplate(this.state.base.assets, id, pack);
    const variant = this.state.variants?.find((entry) => entry.id === id);
    if (!(asset && this.canRead(asset.key)) && !(variant && this.canRead(variant.key))) return;
    const request = this.begin();
    if (!request) return;
    this.pendingPreview = request.ticket;
    const { preview: _preview, ...rest } = this.state;
    this.update(rest);
    try {
      const preview = await this.ports.preview(request.candidate, id, pack, fixtures);
      if (this.current(request.ticket, request.candidate)) this.update({ ...this.state, preview });
    } catch {
      if (this.current(request.ticket, request.candidate))
        this.update({ ...this.state, message: "Preview failed. Check the template and exact-ID partial references." });
    } finally {
      if (this.pendingPreview === request.ticket) this.pendingPreview = undefined;
      this.finish(request.ticket);
    }
  }

  async createVariant(key: string, pack: string): Promise<void> {
    const asset = this.state.base.assets.find((entry) => entry.key === key);
    if (!this.ports.variant || !asset || asset.source.state !== "available" || !/^[A-Za-z0-9_-]+$/.test(pack)) return;
    // Require the saved source so no adapter can silently omit unsubmitted edits.
    if (this.state.edits.length > 0) return;
    const request = this.begin();
    if (!request) return;
    try {
      const variant = await this.ports.variant(asset, pack);
      if (!this.current(request.ticket, request.candidate)) return;
      if (this.state.base.assets.some((entry) => entry.key === variant.key || entry.id === `${pack}/${asset.id}`)) {
        this.update({ ...this.state, message: "That pack variant already exists." });
        return;
      }
      this.created.set(variant.key, asset.key);
      this.update({
        ...this.state,
        variants: [...(this.state.variants ?? []), { key: variant.key, id: `${pack}/${asset.id}` }],
      });
      this.replaceEdit(variant.key, variant.text);
    } catch {
      if (this.current(request.ticket, request.candidate))
        this.update({ ...this.state, message: "Variant creation failed. The source is retained." });
    } finally {
      this.finish(request.ticket);
    }
  }

  publicationReason(): string | undefined {
    if (!this.ports.publish)
      return "Template publication is unavailable until the local revision-checked adapter is connected.";
    if (this.state.blocked) return this.state.blocked;
    if (this.state.base.writeReason) return this.state.base.writeReason;
    if (this.state.busy) return "An authoring operation is pending.";
    if (this.state.edits.length === 0) return "There are no source changes to publish.";
    const review = this.state.review;
    if (!review || review.candidateRevision === "") return "Validate and review this exact draft first.";
    if (review.errors.length > 0) return "Resolve the validation errors before publishing.";
    if (review.compatibility !== "compatible") return "Pack compatibility must be verified before publishing.";
    return undefined;
  }

  async publish(): Promise<void> {
    if (this.publicationReason() !== undefined) return;
    const review = this.state.review;
    const publish = this.ports.publish;
    if (!review || !publish) return;
    const request = this.begin();
    if (!request) return;
    this.update({ ...this.state, saving: true });
    try {
      const result = await publish(request.candidate, review.candidateRevision);
      if (request.ticket !== this.operation) return;
      if (result.status !== "saved") {
        const { review: _review, ...rest } = this.state;
        this.update({
          ...rest,
          errors: result.errors,
          blocked:
            result.status === "conflict"
              ? "Publication conflicted. Reconcile the retained draft and review again."
              : "Publication was refused. Keep the draft and resolve the refusal.",
        });
        return;
      }
      if (
        !sameTarget(result.snapshot.target, request.candidate.target) ||
        result.candidateRevision !== review.candidateRevision ||
        result.snapshot.generation !== request.candidate.expectedGeneration
      ) {
        this.update({
          ...this.state,
          blocked: "Publication acknowledgement changed identity. Reconcile before continuing.",
        });
        return;
      }
      if (this.current(request.ticket, request.candidate)) {
        this.created.clear();
        this.readable = new Set(
          result.snapshot.assets.filter((asset) => asset.source.state === "available").map((asset) => asset.key),
        );
        this.update({
          base: result.snapshot,
          edits: [],
          sequence: this.state.sequence + 1,
          busy: true,
          message:
            "Revision saved. Apply is a separate configuration action; admitted runs keep their captured instructions.",
        });
      } else {
        // A newer edit cannot be blindly rebased onto the acknowledgement.
        this.update({
          ...this.state,
          blocked: "The reviewed revision was saved, but newer edits remain. Reconcile before publishing again.",
        });
      }
    } catch {
      if (request.ticket === this.operation)
        this.update({
          ...this.state,
          blocked:
            "Publication acknowledgement was lost. Reconcile saved state before retrying; the draft is retained.",
        });
    } finally {
      this.finish(request.ticket);
    }
  }
}
