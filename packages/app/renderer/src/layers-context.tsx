/**
 * The React side of the transient layer stack: a provider for the one stack, a hook a
 * layer uses to put itself on it while it is open, and the `Esc` registration that drives
 * it. `Esc` is a shortcut like any other — it goes through the keyboard map, so the
 * palette lists it with its key beside it.
 */
import { createContext, useContext, useEffect, useRef, type JSX, type ReactNode } from "react";
import { useKeyboard } from "./keyboard-context.js";
import { LayerStack, type TransientLayer } from "./layers.js";

const LayerContext = createContext<LayerStack | null>(null);

export function LayerStackProvider({ value, children }: { value: LayerStack; children: ReactNode }): JSX.Element {
  return <LayerContext.Provider value={value}>{children}</LayerContext.Provider>;
}

export function useLayerStack(): LayerStack {
  const stack = useOptionalLayerStack();
  if (!stack) throw new Error("useLayerStack needs a <LayerStackProvider> above it");
  return stack;
}

/**
 * The stack if there is one. For a primitive that must still *render* in a tree with no
 * providers — `renderToStaticMarkup` in a test, the `#preview` gallery — while still
 * needing the stack the moment it opens. Effects do not run in a static render, which is
 * why `useTransientLayer` can defer the requirement to the one below.
 */
export function useOptionalLayerStack(): LayerStack | null {
  return useContext(LayerContext);
}

/**
 * Keep `layer` on the stack for as long as `active`. The layer is read through a ref, so a
 * component may re-render with a new `close` or a changed draft without popping and
 * re-pushing itself — which would otherwise move it above a layer that opened after it.
 */
export function useTransientLayer(active: boolean, layer: TransientLayer): void {
  const stack = useOptionalLayerStack();
  const current = useRef(layer);
  current.current = layer;

  useEffect(() => {
    if (!active) return;
    // Loud, but at the moment the layer actually opens rather than at every render: a
    // closed menu in a provider-less tree is fine, an open one is a missing provider.
    if (!stack) throw new Error(`the ${current.current.name} layer needs a <LayerStackProvider> above it`);
    return stack.push({
      name: current.current.name,
      close: () => current.current.close(),
      hasUnsentDraft: () => current.current.hasUnsentDraft?.() ?? false,
    });
  }, [stack, active]);
}

/** Register the one `Esc`. Called once, by the chrome. */
export function useEscapeClosesTopLayer(): void {
  const keyboard = useKeyboard();
  const stack = useLayerStack();

  useEffect(
    () =>
      keyboard.register({
        scope: "global",
        key: "Escape",
        label: "Close the topmost layer",
        detail: "Never discards an unsent draft",
        action: () => stack.closeTop(),
      }),
    [keyboard, stack],
  );
}
