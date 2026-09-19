/**
 * `ObjectHeader` — the only breadcrumb in the app, present on every screen that has an
 * object (docs/design/10-information-architecture.md).
 *
 * Three things it must keep doing:
 *  - every crumb carries its type label, because `7f3a2c` alone does not say run;
 *  - the crumb for the object you are looking at is not a link;
 *  - every crumb that has counterparts can open them, which is how cross-linking works in
 *    this app — one component, and no surface embedding another's navigation.
 *
 * It is a `<nav>` with an `aria-label`, and the trail is an ordered list, so the crumbs
 * read as a path rather than as a row of unrelated links.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { CHROME_GLYPHS } from "@orca/design";
import { counterpartsFor, type Counterpart, type CrumbType } from "./counterparts.js";

export interface Crumb {
  type: CrumbType;
  id: string;
  label: string;
  current?: boolean;
}

export interface ObjectHeaderProps {
  crumbs: readonly Crumb[];
  /** Buttons and controls for the object, pushed to the right of the header. */
  actions?: ReactNode;
  /** Navigate to a crumb. Never called for the current crumb, which is not a link. */
  onOpen?: (crumb: Crumb) => void;
  /** Navigate to one of a crumb's counterparts. Without it, no menus are offered. */
  onOpenCounterpart?: (crumb: Crumb, counterpart: Counterpart) => void;
}

export function ObjectHeader({ crumbs, actions, onOpen, onOpenCounterpart }: ObjectHeaderProps): JSX.Element {
  const [openMenu, setOpenMenu] = useState<string | undefined>(undefined);
  const keyOf = (crumb: Crumb): string => `${crumb.type}:${crumb.id}`;

  return (
    <nav className="orca-objhead" aria-label="Object">
      <ol className="orca-objhead__trail">
        {crumbs.map((crumb, index) => (
          <li key={keyOf(crumb)} className="orca-objhead__crumb">
            {index > 0 && (
              <span className="orca-crumb__sep" aria-hidden="true">
                {CHROME_GLYPHS.crumbSeparator}
              </span>
            )}
            {crumb.current === true ? (
              <span className="orca-crumb orca-crumb--current" aria-current="page">
                <CrumbLabel crumb={crumb} />
              </span>
            ) : (
              <button type="button" className="orca-crumb" onClick={() => onOpen?.(crumb)}>
                <CrumbLabel crumb={crumb} />
              </button>
            )}
            <CounterpartMenu
              crumb={crumb}
              open={openMenu === keyOf(crumb)}
              onToggle={() => setOpenMenu(openMenu === keyOf(crumb) ? undefined : keyOf(crumb))}
              onClose={() => setOpenMenu(undefined)}
              {...(onOpenCounterpart ? { onChoose: onOpenCounterpart } : {})}
            />
          </li>
        ))}
      </ol>
      <span className="orca-spacer" />
      {actions}
    </nav>
  );
}

/** The type label is part of the crumb, not a tooltip: it is what makes the trail readable. */
function CrumbLabel({ crumb }: { crumb: Crumb }): JSX.Element {
  return (
    <>
      <span>{crumb.label}</span>
      <span className="orca-crumb__type">{crumb.type}</span>
    </>
  );
}

interface CounterpartMenuProps {
  crumb: Crumb;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChoose?: (crumb: Crumb, counterpart: Counterpart) => void;
}

function CounterpartMenu({ crumb, open, onToggle, onClose, onChoose }: CounterpartMenuProps): JSX.Element | null {
  const options = counterpartsFor(crumb.type);
  const ref = useRef<HTMLSpanElement>(null);

  /* Esc closes the topmost transient layer and a click elsewhere dismisses it
     (docs/design/50-accessibility-and-keyboard.md). Bound only while open. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open, onClose]);

  if (options.length === 0 || onChoose === undefined) return null;

  return (
    <span ref={ref}>
      <button
        type="button"
        className="orca-crumb__more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Counterparts of ${crumb.label}`}
        onClick={onToggle}
      >
        {/* The bundled symbol face carries no downward triangle, and a glyph that falls
            back to whatever the OS has is the one thing docs/design forbids — so this is
            the crumb separator, turned a quarter (see `.orca-crumb__more`). */}
        <span aria-hidden="true">{CHROME_GLYPHS.crumbSeparator}</span>
      </button>
      {open && (
        <ul className="orca-menu" role="menu">
          {options.map((option) => (
            <li key={option.id} role="none">
              <button
                type="button"
                role="menuitem"
                className="orca-menu__item"
                onClick={() => {
                  onClose();
                  onChoose(crumb, option);
                }}
              >
                <span>{option.label}</span>
                <span className="orca-menu__type">{option.leadsTo}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
