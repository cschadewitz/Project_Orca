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
  const keyboard = useContext(KeyboardContext);
  if (!keyboard) throw new Error("useKeyboard needs a <KeyboardProvider> above it");
  return keyboard;
}
