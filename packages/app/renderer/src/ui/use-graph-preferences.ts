/**
 * How a person likes one graph canvas drawn — which way its layers run, and whether its
 * minimap is showing — read from and written to the app's own preferences.
 *
 * **Where it lives, and where it does not.** This is per person, so it is in
 * `preferences.json` beside the theme, the densities and the pane sizes
 * (docs/design/60-implementation.md), through `Appearance` like they are. It is never in the
 * workflow YAML and never in `.layout/<id>.json`: those are shared by everybody who opens the
 * workflow, and one person turning the graph on its side is not a change to the workflow.
 *
 * **Keyed by canvas, not by screen.** The workflow viewer and the workflow editor are one
 * canvas with and without hands, so they share `workflow` and a graph turned in one is turned
 * in the other; the plan's dependency graph is `plan-graph`, a different kind of graph a
 * person may well read the other way.
 *
 * **Both toggles are commands as well as buttons.** Each registers a keyless command in the
 * canvas's scope (#205), so the palette lists it and a keyboard reaches it without a letter
 * spent on it, and its label says what it will do — "Lay out top to bottom" — which is also
 * the button's accessible name: a toggle whose name stays put while what it does flips is a
 * toggle a screen reader cannot tell the state of.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAppearance } from "../appearance-context.js";
import { useKeyboard } from "../keyboard-context.js";
import type { ShortcutScope } from "../keyboard-map.js";
import { DEFAULT_DIRECTION, type LayoutDirection } from "../workflow/layout.js";

/** The canvases that remember a view. The editor is `workflow`: it is the viewer's canvas. */
export type GraphCanvasId = "workflow" | "plan-graph";

export interface GraphPreferences {
  direction: LayoutDirection;
  /** Whether the minimap is showing. Shown until somebody hides it. */
  minimap: boolean;
  toggleDirection: () => void;
  toggleMinimap: () => void;
}

/** What the direction toggle says it will do, from where the graph is now. */
export const directionLabel = (direction: LayoutDirection): string =>
  direction === "horizontal" ? "Lay out top to bottom" : "Lay out left to right";

/** The palette's second line for the direction command: whose choice it is, and what it leaves alone. */
const DIRECTION_DETAIL: Record<GraphCanvasId, string> = {
  workflow: "Remembered for you, on every workflow. The workflow file and its saved layout do not change.",
  "plan-graph": "Remembered for you. The plan does not change.",
};

/** What the minimap toggle says it will do. */
export const minimapLabel = (shown: boolean): string => (shown ? "Hide the minimap" : "Show the minimap");

export function useGraphPreferences(canvas: GraphCanvasId, scope: ShortcutScope): GraphPreferences {
  const appearance = useAppearance();
  /* Two primitive snapshots rather than one object, so a write to some other canvas — or to
     the theme — re-renders nothing here. */
  const direction = useSyncExternalStore(
    appearance.subscribe,
    () => appearance.preferences().canvases?.[canvas]?.direction ?? DEFAULT_DIRECTION,
  );
  const minimap = useSyncExternalStore(
    appearance.subscribe,
    () => appearance.preferences().canvases?.[canvas]?.minimap ?? true,
  );

  const toggleDirection = useCallback(
    () =>
      appearance.set({ canvases: { [canvas]: { direction: direction === "horizontal" ? "vertical" : "horizontal" } } }),
    [appearance, canvas, direction],
  );
  const toggleMinimap = useCallback(
    () => appearance.set({ canvases: { [canvas]: { minimap: !minimap } } }),
    [appearance, canvas, minimap],
  );

  const keyboard = useKeyboard();
  const latest = useRef({ toggleDirection, toggleMinimap });
  latest.current = { toggleDirection, toggleMinimap };
  /* Re-registered when the state flips, because the label is what the command will do and
     that is what changed. A toggle is rare; the re-registration is two map entries. */
  useEffect(() => {
    const registrations = [
      {
        label: directionLabel(direction),
        detail: DIRECTION_DETAIL[canvas],
        action: () => latest.current.toggleDirection(),
      },
      { label: minimapLabel(minimap), action: () => latest.current.toggleMinimap() },
    ].map((shortcut) => keyboard.register({ scope, ...shortcut }));
    return () => registrations.forEach((unregister) => unregister());
  }, [keyboard, scope, canvas, direction, minimap]);

  return { direction, minimap, toggleDirection, toggleMinimap };
}
