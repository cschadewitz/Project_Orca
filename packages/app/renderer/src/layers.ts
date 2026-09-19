/// <reference lib="dom" />
/**
 * The transient layer stack behind `Esc`.
 *
 * "`Esc` closes the topmost transient layer and never loses an unsent draft"
 * (docs/design/50-accessibility-and-keyboard.md) is one rule with two halves, and both
 * need a stack rather than per-component `Escape` handlers: with a palette open over an
 * overlaid panel, only one of them may close, and the one that closes is the one that
 * opened last.
 *
 * The second half is `hasUnsentDraft`. A layer that is holding text a person typed and has
 * not sent — a gate answer with a note, a workflow edit — reports it, and `Esc` consumes
 * the key without closing. Nothing in the app takes a draft yet (gate cards are #159), so
 * today every layer omits it; the stack is where the rule lives when they arrive.
 */

export interface TransientLayer {
  /** What the layer is — read by tests and by nothing else; it is never rendered. */
  name: string;
  close: () => void;
  /** When true, `Esc` is swallowed and the layer stays open rather than discarding the draft. */
  hasUnsentDraft?: () => boolean;
}

/** What `Esc` did, so a caller can decide whether the key was theirs to consume. */
export type EscapeOutcome = "closed" | "kept" | "none";

export class LayerStack {
  private readonly layers: TransientLayer[] = [];

  /** Push a layer; returns its pop. Popping a layer that is no longer on the stack is a no-op. */
  push(layer: TransientLayer): () => void {
    this.layers.push(layer);
    return () => {
      const at = this.layers.indexOf(layer);
      if (at !== -1) this.layers.splice(at, 1);
    };
  }

  /** The layer `Esc` would act on, or undefined when nothing transient is open. */
  top(): TransientLayer | undefined {
    return this.layers[this.layers.length - 1];
  }

  get depth(): number {
    return this.layers.length;
  }

  /**
   * Close the topmost layer. `kept` means it is holding an unsent draft: the key was
   * consumed and nothing was lost. `none` means `Esc` belongs to whatever is beneath.
   */
  closeTop(): EscapeOutcome {
    const top = this.top();
    if (!top) return "none";
    if (top.hasUnsentDraft?.()) return "kept";
    // Pop before closing: `close` usually sets React state, and a layer that unmounts
    // during its own close would otherwise pop a stack it is no longer on top of.
    this.layers.pop();
    top.close();
    return "closed";
  }
}
