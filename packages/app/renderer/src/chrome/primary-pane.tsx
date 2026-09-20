/**
 * The `.orca-main` column: an optional object-header slot above whatever the active
 * surface renders. Runs is the first surface to fill it (#156) — it hands the chrome the
 * crumbs for its selection and `App` draws an `ObjectHeader` into the slot.
 *
 * The slot renders its child bare. `ObjectHeader` is itself an `.orca-objhead`, so a
 * wrapper carrying that class again would give the bar two heights, two paddings and two
 * bottom borders.
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
  children: ReactNode;
}

export function PrimaryPane({ surface, header, children }: PrimaryPaneProps): JSX.Element {
  // App remounts this per surface, so the remembered density is re-applied on every switch.
  useSurfaceDensity();

  return (
    <main className="orca-main orca-surface" data-surface={surface} tabIndex={-1}>
      {header ?? null}
      {children}
    </main>
  );
}
