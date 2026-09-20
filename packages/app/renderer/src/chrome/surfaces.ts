/** The five top-level surfaces from docs/design/10-information-architecture.md, in sidebar order. */

export type SurfaceId = "attention" | "runs" | "plan" | "agents" | "config";

export interface SurfaceDef {
  id: SurfaceId;
  label: string;
  /** Digit key for the ⌘<n> shortcut, matching the design doc's 1-indexing. */
  shortcut: number;
  /**
   * Shown only when the sidebar collapses to icon width. No icon set is designed yet
   * (docs/design/ doesn't specify sidebar glyphs), so these are geometric placeholders
   * rather than a real icon — worth revisiting once #147 or a design pass settles on one.
   *
   * The #167 accessibility pass confirmed the gap and filed it against the design rather
   * than closing it here: **#261**. Below the breakpoint these five characters are the
   * whole of the navigation, and `◆`/`◈` — Attention and Agents, the two surfaces a person
   * moves between most — differ by a hairline at `--icon-md`. The buttons are still
   * *named* (the glyph is `aria-hidden`, `title` carries the label), so what is missing is
   * visual. Do not pick five better characters here; #261 is a `semantics.json` entry and
   * a bundled face, or a decision that the collapsed rail keeps its labels.
   */
  glyph: string;
}

export const SURFACES: readonly SurfaceDef[] = [
  { id: "attention", label: "Attention", shortcut: 1, glyph: "◆" },
  { id: "runs", label: "Runs", shortcut: 2, glyph: "▶" },
  { id: "plan", label: "Plan", shortcut: 3, glyph: "▤" },
  { id: "agents", label: "Agents", shortcut: 4, glyph: "◈" },
  { id: "config", label: "Config", shortcut: 5, glyph: "⚙" },
];
