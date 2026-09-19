/**
 * Declares `window.orca` for the renderer. The preload script puts it there at runtime
 * (`src/preload/index.ts`); this is the only place the renderer is told it exists, and it
 * reuses the same `OrcaBridge` type the preload implements so the two cannot drift.
 */
import type { OrcaBridge } from "../../src/bridge.js";

declare global {
  interface Window {
    readonly orca: OrcaBridge;
  }
}
