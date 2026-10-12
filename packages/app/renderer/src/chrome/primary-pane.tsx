/**
 * The `.orca-main` column: an optional object-header slot above whatever the active
 * surface renders. Runs is the first surface to fill it (#156) — it hands the chrome the
 * crumbs for its selection and `App` draws an `ObjectHeader` into the slot.
 *
 * The slot renders its child bare. `ObjectHeader` is itself an `.orca-objhead`, so a
 * wrapper carrying that class again would give the bar two heights, two paddings and two
 * bottom borders.
 *
 * Under the header, and over the surface, are the chrome's notices: the connection bars and
 * what a link that could not be honoured says about itself. "A 2px bar appears under the
 * object header on screens whose data is now stale" (docs/design/40-connection-states.md),
 * so the claim sits on the pane it is about and the sidebar stays flush under the title bar,
 * as the window in docs/design/10-information-architecture.md is drawn. A surface with no
 * header has them at the top of the pane. Each is `.orca-banner`'s `flex: none`, so the
 * surface below keeps the rest of the column however many are showing.
 *
 * It is also the app's surface root — `data-surface` is what density is remembered by
 * (docs/design/60-implementation.md), so ⌘⇧D on Runs does not change Config.
 */
import type { JSX, ReactNode } from "react";
import { useSurfaceDensity } from "../appearance-context.js";
import type { SurfaceId } from "./surfaces.js";

export interface PrimaryPaneProps {
  surface: SurfaceId;
  header?: ReactNode;
  /** Drawn under the header: the connection bars and a link's landing notice. */
  notices?: ReactNode;
  children: ReactNode;
}

export function PrimaryPane({ surface, header, notices, children }: PrimaryPaneProps): JSX.Element {
  // App remounts this per surface, so the remembered density is re-applied on every switch.
  useSurfaceDensity();

  return (
    <main className="orca-main orca-surface" data-surface={surface} tabIndex={-1}>
      {header ?? null}
      {notices ?? null}
      {children}
    </main>
  );
}
