/** The 228px surface nav: five entries, ⌘1–⌘5, collapsing to icon-only below the sidebar breakpoint. */
import type { JSX } from "react";
import { textClass } from "../ui/index.js";
import { SURFACES, type SurfaceId } from "./surfaces.js";

export interface SidebarProps {
  active: SurfaceId;
  onSelect: (id: SurfaceId) => void;
  /** Hidden at zero — the count itself is #161. */
  waitingCount?: number;
}

export function Sidebar({ active, onSelect, waitingCount }: SidebarProps): JSX.Element {
  return (
    <div className="orca-sidebar">
      <div className={`orca-eyebrow ${textClass("eyebrow")}`}>Surfaces</div>
      <nav aria-label="Surfaces">
        {SURFACES.map((surface) => (
          <button
            key={surface.id}
            type="button"
            className={
              surface.id === active
                ? `orca-nav ${textClass("label")} orca-nav--active`
                : `orca-nav ${textClass("label")}`
            }
            aria-current={surface.id === active ? "page" : undefined}
            title={surface.label}
            onClick={() => onSelect(surface.id)}
          >
            <span className="orca-nav__glyph" aria-hidden="true">
              {surface.glyph}
            </span>
            <span className="orca-nav__label">{surface.label}</span>
            {surface.id === "attention" && waitingCount ? (
              <span className={`orca-nav__count ${textClass("mono-id")} orca-nav__count--waiting`}>{waitingCount}</span>
            ) : null}
          </button>
        ))}
      </nav>
    </div>
  );
}
