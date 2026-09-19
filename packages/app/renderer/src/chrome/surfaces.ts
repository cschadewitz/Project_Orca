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
