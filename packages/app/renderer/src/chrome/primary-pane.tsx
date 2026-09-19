/**
 * The `.orca-main` column: an optional object-header slot above whatever the active
 * surface renders. No surface has an object to put in that slot yet (that arrives with
 * the surfaces themselves), so `header` is unused today but the slot is structural.
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
      {header ? <div className="orca-objhead">{header}</div> : null}
      {children}
    </main>
  );
}
