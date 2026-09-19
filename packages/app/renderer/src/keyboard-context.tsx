/**
 * The React side of the keyboard map. The map itself is framework-free and is created in
 * `main.tsx` before React mounts (appearance registers ⌘⇧L and ⌘⇧D on it there); this
 * hands the same instance to components so a screen can register its own shortcuts for as
 * long as it is mounted, and so the command palette (#149) can list every one of them.
 */
import { createContext, useContext, type JSX, type ReactNode } from "react";
import type { KeyboardMap } from "./keyboard-map.js";

const KeyboardContext = createContext<KeyboardMap | null>(null);

export function KeyboardProvider({ value, children }: { value: KeyboardMap; children: ReactNode }): JSX.Element {
  return <KeyboardContext.Provider value={value}>{children}</KeyboardContext.Provider>;
}

export function useKeyboard(): KeyboardMap {
  const keyboard = useOptionalKeyboard();
  if (!keyboard) throw new Error("useKeyboard needs a <KeyboardProvider> above it");
  return keyboard;
}

/**
 * The map if there is one. For a primitive that must still *render* in a tree with no
 * providers — `renderToStaticMarkup` in a test, the `#preview` gallery — and that registers
 * its shortcuts from an effect, which a static render never runs. A component that needs
 * the map to render at all should use `useKeyboard` and fail.
 */
export function useOptionalKeyboard(): KeyboardMap | null {
  return useContext(KeyboardContext);
}
