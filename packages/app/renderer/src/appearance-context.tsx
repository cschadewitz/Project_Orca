/**
 * The React side of theme and density. The provider hands components the installed
 * `Appearance` — its actions, never its state: a component may ask to cycle the theme or
 * toggle density (the palette, a Config preferences section), and a surface may ask for
 * its remembered density after it mounts, but nothing reads which theme is on. The CSS
 * layer does (docs/design/60-implementation.md).
 *
 * The installer runs in `main.tsx` before React mounts, so `data-theme` is on `<html>`
 * before the first paint; this only distributes the handle.
 */
import { createContext, useContext, useEffect, type JSX, type ReactNode } from "react";
import type { Appearance } from "./appearance.js";

const AppearanceContext = createContext<Appearance | null>(null);

export function AppearanceProvider({ value, children }: { value: Appearance; children: ReactNode }): JSX.Element {
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): Appearance {
  const appearance = useContext(AppearanceContext);
  if (!appearance) throw new Error("useAppearance needs an <AppearanceProvider> above it");
  return appearance;
}

/**
 * For a component that renders a surface root (`data-surface`): give it the density the
 * person last chose for it, once it is in the document.
 */
export function useSurfaceDensity(): void {
  const { refresh } = useAppearance();
  useEffect(() => refresh(), [refresh]);
}
