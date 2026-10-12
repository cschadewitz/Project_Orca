/**
 * `ObjectHeader` — the only breadcrumb in the app, present on every screen that has an
 * object (docs/design/10-information-architecture.md).
 *
 * Three things it must keep doing:
 *  - every crumb carries its type label, because `7f3a2c` alone does not say run;
 *  - the crumb for the object you are looking at is not a link;
 *  - every crumb that has counterparts can open them, which is how cross-linking works in
 *    this app — one component, and no surface embedding another's navigation;
 *  - every crumb that has a canonical `orca://` URL can hand it over — **Copy link** is in
 *    the same menu, because the header is the one place that always knows which object is
 *    on screen (#165);
 *  - every crumb for an object with an ORCA id — a request, a work item, a run, a step —
 *    shows the id's token after its name and type, `Database schema ITEM ⬡ 5M579G`, and
 *    offers **Copy id** beside Copy link. The token is how two runs of one name are told
 *    apart in the trail; Copy id is how the whole id leaves the app. An object with no name
 *    (a request: no read model carries its title) is its token in the label's place.
 *
 * It is a `<nav>` with an `aria-label`, and the trail is an ordered list, so the crumbs
 * read as a path rather than as a row of unrelated links.
 */
import { type JSX, type ReactNode } from "react";
import { CHROME_GLYPHS, type ObjectKind } from "@orca/design";
import { urlForCrumb } from "../route-table.js";
import { counterpartsFor, type Counterpart, type CrumbType } from "./counterparts.js";
import { Menu, type MenuItem } from "./menu.js";
import { ObjectId } from "./object-id.js";
import { idText, idWords } from "./object-id-model.js";
import { textClass } from "./text.js";

export interface Crumb {
  type: CrumbType;
  id: string;
  /**
   * What a person calls the object — a work item's title, a run's name, a step's node. An
   * object with no name passes its id here (a request: `runs.list` carries `requestId` and
   * no title), and the crumb draws the id's token in the label's place rather than the raw id.
   */
  label: string;
  current?: boolean;
  /**
   * The ids this crumb's counterparts name, when the surface that built the crumb knows
   * them: `{ workflow: "ai-sdlc" }` on a run crumb (#177).
   *
   * A counterpart is a link to a *different* object, and most of them are queries over data
   * the breadcrumb does not hold — which is why `counterpartUrl` answered undefined for all
   * but one of them and the menu item said so. Where the surface does hold the id, this is
   * how it says so without the route table learning to read runs. Keyed by
   * `Counterpart.id`, so the map in `counterparts.ts` stays the list of what exists.
   */
  counterpartIds?: Readonly<Record<string, string>>;
  /**
   * The workflow this object runs, with the version it is pinned to: `ai-sdlc v11` (#177).
   *
   * A prop rather than something the header derives, because the version is a fact on the
   * *run* and the header knows objects, not read models. It exists because
   * docs/design/70-workflow-editing.md asks for the version "wherever a run's workflow is
   * named — the run header, the workflow viewer's overlay control, the step detail's node
   * line", and the run header is a crumb. The `◷ pinned` chip that goes with it is not here:
   * a chip is a comparison against the definition on disk, which the runs surface would need
   * a second read to know (see that file), so the viewer is where it is drawn.
   */
  version?: string;
}

/**
 * One position of the header's segmented mode control.
 *
 * A mode that this version of the app does not have is **absent**, not disabled: the graph,
 * the risk matrix and the decision matrix are v0.6.0 (#171–#173), and a control offering
 * three positions that never do anything would be three dead ends rather than one honest
 * pair (docs/design/80-dependency-graph-options.md).
 */
export interface HeaderMode {
  id: string;
  label: string;
}

export interface ObjectHeaderProps {
  crumbs: readonly Crumb[];
  /**
   * The segmented control that switches what the primary pane draws about *this* object —
   * Plan's Schedule and Journal (#170). It is a variant of the header rather than a
   * control in a surface because option B's whole claim is that a mode switch keeps the
   * object, the selection and the filters, and the header is what says which object.
   */
  mode?: { options: readonly HeaderMode[]; active: string; onChange: (id: string) => void; label?: string };
  /** Buttons and controls for the object, pushed to the right of the header. */
  actions?: ReactNode;
  /** Navigate to a crumb. Never called for the current crumb, which is not a link. */
  onOpen?: (crumb: Crumb) => void;
  /** Navigate to one of a crumb's counterparts. Without it, no menus are offered. */
  onOpenCounterpart?: (crumb: Crumb, counterpart: Counterpart) => void;
}

export function ObjectHeader({ crumbs, mode, actions, onOpen, onOpenCounterpart }: ObjectHeaderProps): JSX.Element {
  const keyOf = (crumb: Crumb): string => `${crumb.type}:${crumb.id}`;

  return (
    <nav className="orca-objhead" aria-label="Object">
      <ol className="orca-objhead__trail">
        {crumbs.map((crumb, index) => (
          <li key={keyOf(crumb)} className="orca-objhead__crumb">
            {index > 0 && (
              <span className={`orca-crumb__sep ${textClass("caption")}`} aria-hidden="true">
                {CHROME_GLYPHS.crumbSeparator}
              </span>
            )}
            {crumb.current === true ? (
              <span className={`orca-crumb ${textClass("label")} orca-crumb--current`} aria-current="page">
                <CrumbLabel crumb={crumb} />
              </span>
            ) : (
              <button type="button" className={`orca-crumb ${textClass("label")}`} onClick={() => onOpen?.(crumb)}>
                <CrumbLabel crumb={crumb} />
              </button>
            )}
            <CrumbMenu crumbs={crumbs} crumb={crumb} onChoose={onOpenCounterpart} />
          </li>
        ))}
      </ol>
      <span className="orca-spacer" />
      {mode && <ModeControl {...mode} />}
      {actions}
    </nav>
  );
}

/**
 * The segmented control, on the component layer's `.orca-seg`.
 *
 * `aria-pressed` rather than a tab list: the modes are two views of one object in one
 * pane, and `role="tablist"` would promise arrow-key navigation between panels that the
 * keyboard spec does not give it. The group carries the accessible name so a reader hears
 * what is being switched rather than two bare words.
 */
function ModeControl({
  options,
  active,
  onChange,
  label = "View",
}: NonNullable<ObjectHeaderProps["mode"]>): JSX.Element {
  return (
    <div className="orca-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`orca-seg__btn ${textClass("label")}`}
          aria-pressed={option.id === active}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The crumb types whose objects carry an ORCA id, and the kind that id is drawn as. */
const CRUMB_KIND: Partial<Record<CrumbType, ObjectKind>> = {
  request: "request",
  item: "workItem",
  run: "run",
  step: "step",
};

/** A crumb with an id kind whose label is its id: it has no name, and its token stands in. */
const isNameless = (crumb: Crumb): boolean => CRUMB_KIND[crumb.type] !== undefined && crumb.label === crumb.id;

/** What a crumb is called in a sentence or a name: its label, or its token said as words. */
const crumbName = (crumb: Crumb): string => {
  const kind = CRUMB_KIND[crumb.type];
  return kind !== undefined && isNameless(crumb) ? idWords(crumb.id, { kind }) : crumb.label;
};

/**
 * The type label is part of the crumb, not a tooltip: it is what makes the trail readable.
 *
 * Name, type, token: `Database schema ITEM ⬡ 5M579G`. The token is faint, because the name
 * leads, and says nothing to a screen reader about its kind, because the type label beside
 * it already has (`variant="header"`). A crumb with no name is its token in the label's
 * place, said as "request 5BNH42" — so its type label is hidden from the accessible name,
 * which would otherwise say "request" twice.
 */
function CrumbLabel({ crumb }: { crumb: Crumb }): JSX.Element {
  const kind = CRUMB_KIND[crumb.type];
  const nameless = isNameless(crumb);
  return (
    <>
      {kind !== undefined && nameless ? <ObjectId id={crumb.id} kind={kind} /> : <span>{crumb.label}</span>}
      <span className={`orca-crumb__type ${textClass("eyebrow")}`} {...(nameless ? { "aria-hidden": true } : {})}>
        {crumb.type}
      </span>
      {kind !== undefined && !nameless && <ObjectId id={crumb.id} kind={kind} variant="header" />}
      {/* Mono, because it is an id and a number the daemon recorded, not prose. */}
      {crumb.version !== undefined && (
        <span className={`orca-crumb__version ${textClass("mono-id")}`}>{crumb.version}</span>
      )}
    </>
  );
}

interface CrumbMenuProps {
  crumbs: readonly Crumb[];
  crumb: Crumb;
  onChoose?: ((crumb: Crumb, counterpart: Counterpart) => void) | undefined;
}

/** The menu item ids for **Copy link** and **Copy id**; neither is a counterpart, neither leads anywhere. */
const COPY_LINK = "copy-link";
const COPY_ID = "copy-id";

/**
 * What a crumb offers: **Copy link**, then the counterpart objects
 * (docs/design/10-information-architecture.md). All of it over the `Menu` primitive —
 * opening, closing, roving focus, focus return and viewport-aware placement live there,
 * and the only thing this knows is what a crumb leads to.
 *
 * Two things decide what is in the list:
 *
 * - **Copy link is here because every crumb is an address.** `orca://` URLs exist so
 *   another tool can hand a person a place (#165), and the object header is the one place
 *   in the app that always knows which object is on screen. A crumb type with no canonical
 *   URL — config, request — simply has no such row.
 * - **Copy id is beside it because the crumb shows only the id's token.** The whole id is
 *   what the CLI, a log and a bug report take, and a row's token is six characters of it, so
 *   the header — where the object is always known — is where the whole of it is one action
 *   away. Its hint is the token, so a person can see which id they are about to copy.
 * - **A counterpart is listed whether or not the app can follow it yet.** Only one of the
 *   four the spec names is addressable from the trail today (`route-table.ts` says which
 *   and why); the rest arrive with the surfaces that answer them, and choosing one in the
 *   meantime says so on screen rather than doing nothing — that is `onChoose`'s caller's,
 *   because this component knows objects and not surfaces.
 */
function CrumbMenu({ crumbs, crumb, onChoose }: CrumbMenuProps): JSX.Element | null {
  const link = urlForCrumb(crumbs, crumb);
  const options = onChoose ? counterpartsFor(crumb.type) : [];
  const byId = new Map(options.map((option) => [option.id, option]));

  const kind = CRUMB_KIND[crumb.type];
  const items: MenuItem[] = [
    ...(link ? [{ id: COPY_LINK, label: "Copy link", hintMachine: "orca://" }] : []),
    ...(kind === undefined ? [] : [{ id: COPY_ID, label: "Copy id", hintMachine: idText(crumb.id, { kind }) }]),
    ...options.map((option) => ({ id: option.id, label: option.label, hint: option.leadsTo })),
  ];

  return (
    <Menu
      label={`Links for ${crumbName(crumb)}`}
      triggerClassName="orca-crumb__more"
      items={items}
      onChoose={(item) => {
        if (item.id === COPY_LINK) {
          // Fire and forget: the clipboard is the OS's, and a rejected write (no
          // permission, no clipboard) is not something a breadcrumb can do anything about.
          if (link) void navigator.clipboard?.writeText(link);
          return;
        }
        if (item.id === COPY_ID) {
          // The whole id, verbatim: the token is what the crumb shows, not what is copied.
          void navigator.clipboard?.writeText(crumb.id);
          return;
        }
        const option = byId.get(item.id);
        if (option && onChoose) onChoose(crumb, option);
      }}
    >
      {/* The bundled symbol face carries no downward triangle, and a glyph that falls
          back to whatever the OS has is the one thing docs/design forbids — so this is
          the crumb separator, turned a quarter (see `.orca-crumb__more`). */}
      <span aria-hidden="true">{CHROME_GLYPHS.crumbSeparator}</span>
    </Menu>
  );
}
