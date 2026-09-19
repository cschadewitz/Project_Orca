/**
 * The chrome's own shortcuts from docs/design/50-accessibility-and-keyboard.md — ⌘1–⌘5
 * for the surfaces, ⌘\ for the panel — registered in the keyboard map like every other
 * shortcut, so the palette (#149) lists them with their keys and nothing here dispatches
 * its own `keydown`.
 */
import { useEffect } from "react";
import { useKeyboard } from "../keyboard-context.js";
import { SURFACES, type SurfaceId } from "./surfaces.js";

export const TOGGLE_PANEL_KEY = "Mod+\\";

export interface ChromeShortcuts {
  onSurface: (id: SurfaceId) => void;
  onTogglePanel: () => void;
}

export function useChromeShortcuts({ onSurface, onTogglePanel }: ChromeShortcuts): void {
  const keyboard = useKeyboard();

  useEffect(() => {
    const unregister = [
      ...SURFACES.map((surface) =>
        keyboard.register({
          scope: "global",
          key: `Mod+${surface.shortcut}`,
          label: `Go to ${surface.label}`,
          action: () => onSurface(surface.id),
        }),
      ),
      keyboard.register({
        scope: "global",
        key: TOGGLE_PANEL_KEY,
        label: "Show or hide the artifact panel",
        action: onTogglePanel,
      }),
    ];
    return () => unregister.forEach((u) => u());
  }, [keyboard, onSurface, onTogglePanel]);
}
