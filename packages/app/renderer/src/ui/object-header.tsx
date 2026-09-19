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
import { type JSX, type ReactNode } from "react";
import { CHROME_GLYPHS } from "@orca/design";
import { counterpartsFor, type Counterpart, type CrumbType } from "./counterparts.js";
import { Menu } from "./menu.js";

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
            {onOpenCounterpart ? <CounterpartMenu crumb={crumb} onChoose={onOpenCounterpart} /> : null}
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
  onChoose: (crumb: Crumb, counterpart: Counterpart) => void;
}

/**
 * The crumb's counterparts, over the `Menu` primitive: opening, closing, roving focus,
 * focus return and viewport-aware placement all live there, and the only thing this knows
 * is which counterparts a crumb type has. A crumb type with none renders no disclosure —
 * `Menu` returns nothing for an empty list.
 */
function CounterpartMenu({ crumb, onChoose }: CounterpartMenuProps): JSX.Element | null {
  const options = counterpartsFor(crumb.type);
  const byId = new Map(options.map((option) => [option.id, option]));

  return (
    <Menu
      label={`Counterparts of ${crumb.label}`}
      triggerClassName="orca-crumb__more"
      items={options.map((option) => ({ id: option.id, label: option.label, hint: option.leadsTo }))}
      onChoose={(item) => {
        const option = byId.get(item.id);
        if (option) onChoose(crumb, option);
      }}
    >
      {/* The bundled symbol face carries no downward triangle, and a glyph that falls
          back to whatever the OS has is the one thing docs/design forbids — so this is
          the crumb separator, turned a quarter (see `.orca-crumb__more`). */}
      <span aria-hidden="true">{CHROME_GLYPHS.crumbSeparator}</span>
    </Menu>
  );
}
