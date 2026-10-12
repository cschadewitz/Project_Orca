/**
 * The six top-level surfaces from docs/design/10-information-architecture.md, in sidebar
 * order — read from `@orca/design`, never re-declared here.
 *
 * The order, the word and the glyph are `packages/design/semantics.json`'s (#261). What is
 * this module's is the one thing the design system has no opinion about: which digit the
 * `⌘<n>` shortcut uses, which is the position in that same order, 1-indexed.
 */
import { SURFACE_IDS, SURFACE_PRESENTATION, type SurfaceId } from "@orca/design";

export type { SurfaceId };

export interface SurfaceDef {
  id: SurfaceId;
  /** The nav label, and the accessible name that stays on when the rail collapses. */
  label: string;
  /** Digit key for the ⌘<n> shortcut, matching the design doc's 1-indexing. */
  shortcut: number;
  /**
   * Shown beside the label, and the whole of the navigation below the sidebar breakpoint
   * where `.orca-nav__label` is hidden. Designed in `semantics.json` and bundled in the
   * symbol face (`tools/font-build/build-fonts.js`), so it is the same drawing on every
   * platform. It is `aria-hidden`; the label is what a screen reader says either way.
   */
  glyph: string;
}

export const SURFACES: readonly SurfaceDef[] = SURFACE_IDS.map((id, index) => ({
  id,
  label: SURFACE_PRESENTATION[id].word,
  shortcut: index + 1,
  glyph: SURFACE_PRESENTATION[id].glyph,
}));
