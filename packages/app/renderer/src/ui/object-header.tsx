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
 *
 * **A trail that does not fit folds its middle into `…`** — `request ▸ … ▸ run ▸ step`, then
 * `request ▸ … ▸ step` — and only then cuts the current crumb's name at its end. The root and
 * the current crumb are never folded; the order things give way in, and why folding comes
 * before cutting, is `crumb-elision.ts`'s. Whether it fits is *measured*, never counted: a
 * wide window shows the whole chain however long it is. `…` is a `Menu` listing the folded
 * crumbs — type, name and token — and choosing one is `onOpen`, exactly as pressing the crumb
 * would have been. Its accessible name says what it holds ("1 hidden level: work item
 * Database schema"), so the list a screen reader walks still names every level, in order.
 */
import { useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { CHROME_GLYPHS, OBJECT_KIND_PRESENTATION, type ObjectKind } from "@orca/design";
import { urlForCrumb } from "../route-table.js";
import { counterpartsFor, type Counterpart, type CrumbType } from "./counterparts.js";
import { elideTrail, sameElision, type Elision, type TrailMeasurement } from "./crumb-elision.js";
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
  /**
   * Navigate to a crumb — pressed in the trail, or chosen from `…` when it is folded, which
   * is the same act. Never called for the current crumb, which is not a link.
   */
  onOpen?: (crumb: Crumb) => void;
  /** Navigate to one of a crumb's counterparts. Without it, no menus are offered. */
  onOpenCounterpart?: (crumb: Crumb, counterpart: Counterpart) => void;
  /**
   * How the trail learns what fits. The default measures the document; a test injects
   * widths, because happy-dom has no layout engine and measures everything as zero — which
   * folds nothing, so a header nobody can measure shows its whole chain.
   */
  measure?: TrailMeasurer;
}

/**
 * Measure the trail: `trail` is the list the crumbs are drawn in, `crumbs` every crumb's
 * item in chain order — the folded ones where they are laid out unseen — and `elision` an
 * unseen `…` item, there whether or not the trail is folded.
 */
export type TrailMeasurer = (trail: Element, crumbs: readonly Element[], elision: Element) => TrailMeasurement;

const widthOf = (element: Element): number => element.getBoundingClientRect().width;

/** The class of a crumb's name, the one part of a crumb that is ever cut. */
const NAME_CLASS = "orca-crumb__name";

/**
 * A crumb's width with its name whole. The name is cut only once nothing is left to fold,
 * and what it is cut by is how much wider its text is than its box — so the decision is
 * always made over the widths the crumbs would have, never the ones the cut left them.
 */
function naturalWidth(crumb: Element): number {
  const name = crumb.querySelector(`.${NAME_CLASS}`);
  const cut = name === null ? 0 : Math.max(0, name.scrollWidth - name.clientWidth);
  return widthOf(crumb) + cut;
}

const measureInDocument: TrailMeasurer = (trail, crumbs, elision) => {
  const gap = Number.parseFloat(trail.ownerDocument.defaultView?.getComputedStyle(trail).columnGap ?? "");
  return {
    available: widthOf(trail),
    crumbs: crumbs.map(naturalWidth),
    elision: widthOf(elision),
    gap: Number.isFinite(gap) ? gap : 0,
  };
};

/** Marks each crumb's item with its place in the chain, so the measurer finds it wherever it is. */
const CRUMB_ATTRIBUTE = "data-orca-crumb";

const keyOf = (crumb: Crumb): string => `${crumb.type}:${crumb.id}`;

/** What changes a crumb's width, as one string, so a re-render with the same trail measures nothing new. */
const shapeOf = (crumbs: readonly Crumb[]): string =>
  crumbs
    .map((crumb) => [keyOf(crumb), crumb.label, crumb.version ?? "", crumb.current === true].join("\u0000"))
    .join("\n");

/**
 * Which crumbs are folded, measured after layout and before paint — so a trail never draws
 * one frame overflowing — and again whenever the trail, a crumb or the `…` changes size: a
 * window drag, a docked panel, a dragged splitter, a font arriving, the actions growing.
 */
function useElision(crumbs: readonly Crumb[], measure: TrailMeasurer) {
  const [elision, setElision] = useState<Elision | undefined>(undefined);
  const nav = useRef<HTMLElement>(null);
  const trail = useRef<HTMLOListElement>(null);
  const marker = useRef<HTMLLIElement>(null);
  const shape = shapeOf(crumbs);
  const count = crumbs.length;

  useLayoutEffect(() => {
    const [root, list, unseen] = [nav.current, trail.current, marker.current];
    if (!root || !list || !unseen) return;
    const items = (): Element[] | undefined => {
      const found = Array.from({ length: count }, (_, at) => root.querySelector(`[${CRUMB_ATTRIBUTE}="${at}"]`));
      return found.every((item) => item !== null) ? found : undefined;
    };
    const update = (): void => {
      const all = items();
      if (!all) return;
      const next = elideTrail(measure(list, all, unseen));
      setElision((previous) => (sameElision(previous, next) ? previous : next));
    };
    update();

    const view = root.ownerDocument.defaultView;
    if (!view || typeof view.ResizeObserver !== "function") return;
    const observer = new view.ResizeObserver(update);
    for (const element of [list, unseen, ...(items() ?? [])]) observer.observe(element);
    return () => observer.disconnect();
    // `elision` is a dependency because folding moves crumbs between the trail and the
    // unseen row, and the moved items are new elements to observe.
  }, [shape, count, measure, elision]);

  /* An answer about a longer trail than this one — the frame between a selection changing and
     the measurement after it — folds nothing rather than folding the current crumb. */
  const fits = elision !== undefined && elision.from >= 1 && elision.to < count && elision.from < elision.to;
  return { elision: fits ? elision : undefined, nav, trail, marker };
}

export function ObjectHeader({
  crumbs,
  mode,
  actions,
  onOpen,
  onOpenCounterpart,
  measure = measureInDocument,
}: ObjectHeaderProps): JSX.Element {
  const { elision, nav, trail, marker } = useElision(crumbs, measure);
  const folded = elision === undefined ? [] : crumbs.slice(elision.from, elision.to);

  const item = (crumb: Crumb, index: number): JSX.Element => (
    <CrumbItem
      key={keyOf(crumb)}
      crumbs={crumbs}
      crumb={crumb}
      index={index}
      onOpen={onOpen}
      onOpenCounterpart={onOpenCounterpart}
    />
  );

  return (
    <nav className="orca-objhead" aria-label="Object" ref={nav}>
      <ol className="orca-objhead__trail" ref={trail}>
        {crumbs.map((crumb, index) => {
          if (elision === undefined || index < elision.from || index >= elision.to) return item(crumb, index);
          return index === elision.from ? <FoldedCrumbs key="folded" crumbs={folded} onOpen={onOpen} /> : null;
        })}
      </ol>
      {mode && <ModeControl {...mode} />}
      {actions}
      {/* Unseen, and never reached: the folded crumbs at their natural width, and a `…` that is
          there whether or not anything is folded, so the header always knows what unfolding
          would take. Each crumb is in the document once — here or in the trail. */}
      <div className="orca-objhead__measure" aria-hidden="true" inert>
        <ol className="orca-objhead__measure-row">
          {folded.map((crumb, at) => item(crumb, (elision?.from ?? 0) + at))}
          <li className="orca-objhead__crumb" ref={marker}>
            <Separator />
            <span className="orca-menu-anchor">
              <span className={`orca-objhead__elision ${textClass("label")}`}>
                <span aria-hidden="true">{ELISION_GLYPH}</span>
              </span>
            </span>
          </li>
        </ol>
      </div>
    </nav>
  );
}

function Separator(): JSX.Element {
  return (
    <span className={`orca-crumb__sep ${textClass("caption")}`} aria-hidden="true">
      {CHROME_GLYPHS.crumbSeparator}
    </span>
  );
}

interface CrumbItemProps {
  /** The whole chain, folded crumbs included: a crumb's link is built from the ones above it. */
  crumbs: readonly Crumb[];
  crumb: Crumb;
  /** Its place in the chain. The root has no separator in front of it. */
  index: number;
  onOpen?: ((crumb: Crumb) => void) | undefined;
  onOpenCounterpart?: ((crumb: Crumb, counterpart: Counterpart) => void) | undefined;
}

function CrumbItem({ crumbs, crumb, index, onOpen, onOpenCounterpart }: CrumbItemProps): JSX.Element {
  return (
    <li
      className={`orca-objhead__crumb${crumb.current === true ? " orca-objhead__crumb--current" : ""}`}
      {...{ [CRUMB_ATTRIBUTE]: index }}
    >
      {index > 0 && <Separator />}
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
  );
}

/**
 * The trail's `…`. Typographic punctuation in the label face rather than a chrome glyph:
 * Plex carries it (it is how the app says "cut here" everywhere), and the symbol face does not.
 */
const ELISION_GLYPH = "…";

/**
 * The folded crumbs, as `…` and the `Menu` it opens. Each is listed the way the crumb drew
 * it — name, token, and its type as the item's hint — and choosing one is `onOpen`, the
 * same route-table navigation the crumb would have taken.
 *
 * What the menu does not carry is each folded crumb's own menu (Copy link, Copy id, its
 * counterparts): a `Menu` is a list of choices, not a tree of them, and a folded crumb is
 * one choice away from being the object on screen, where all of that is.
 *
 * The trigger's accessible name lists what it holds, in order, so the trail a screen reader
 * walks is still the whole chain; the menu is where to go, not the only place they are said.
 */
function FoldedCrumbs({
  crumbs,
  onOpen,
}: {
  crumbs: readonly Crumb[];
  onOpen?: ((crumb: Crumb) => void) | undefined;
}): JSX.Element {
  const byKey = new Map(crumbs.map((crumb) => [keyOf(crumb), crumb]));
  const items: MenuItem[] = crumbs.map((crumb) => {
    const kind = CRUMB_KIND[crumb.type];
    return {
      id: keyOf(crumb),
      label: crumbName(crumb),
      hint: crumb.type,
      ...(kind === undefined ? {} : { labelId: crumb.id, labelKind: kind }),
      ...(isNameless(crumb) ? { nameless: true } : {}),
    };
  });

  return (
    <li className="orca-objhead__crumb">
      <Separator />
      <Menu
        label={foldedName(crumbs)}
        triggerClassName={`orca-objhead__elision ${textClass("label")}`}
        items={items}
        onChoose={(chosen) => {
          const crumb = byKey.get(chosen.id);
          if (crumb) onOpen?.(crumb);
        }}
      >
        <span aria-hidden="true">{ELISION_GLYPH}</span>
      </Menu>
    </li>
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

/** A crumb said whole: its kind's word, then its name — "work item Database schema". */
const spokenCrumb = (crumb: Crumb): string => {
  const kind = CRUMB_KIND[crumb.type];
  if (kind === undefined) return `${crumb.type} ${crumb.label}`;
  // A nameless crumb's name is its token said as words, which already says the kind.
  return isNameless(crumb) ? crumbName(crumb) : `${OBJECT_KIND_PRESENTATION[kind].word} ${crumb.label}`;
};

/** The `…` control's accessible name: how many levels it holds, and each of them, in order. */
const foldedName = (crumbs: readonly Crumb[]): string =>
  `${crumbs.length} hidden ${crumbs.length === 1 ? "level" : "levels"}: ${crumbs.map(spokenCrumb).join(", ")}`;

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
      {/* The name is the part of a crumb that is cut, and only once nothing is left to fold;
          the type, the token and the version keep their width. */}
      {kind !== undefined && nameless ? (
        <ObjectId id={crumb.id} kind={kind} />
      ) : (
        <span className={NAME_CLASS}>{crumb.label}</span>
      )}
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
