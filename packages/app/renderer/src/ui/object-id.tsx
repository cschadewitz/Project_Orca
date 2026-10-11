/**
 * `ObjectId` — the one way an ORCA id reaches the screen in a row or a header.
 *
 * An id is ORCA's name for an object, not a person's, and printed whole it is 26 characters
 * of which the first ten are the same for every id minted that millisecond
 * (`object-id-model.ts` says why). So a row leads with what a person calls the object — a
 * work item's title, a run's name — and follows it with a faint **token**: the kind's glyph
 * and the id's last six characters, `Database schema ⬡ 5M579G`. Where there is no name —
 * a request today, a gate with no question in scope — the token stands alone and is not
 * faint, because it is the whole label.
 *
 * Three things it keeps true, which is why it is a component and not a `slice`:
 *
 * - **The whole id is one action away.** The token carries it in `title`, so hovering shows
 *   it (ids are the one exception to "a truncated row reveals itself in the detail pane, not
 *   a tooltip" — docs/design/30-long-running-content.md); the object header's crumb menu
 *   copies it; the palette matches any part of it; and `variant="full"` prints it verbatim
 *   for a detail pane and for the places that must keep it whole.
 * - **The token never truncates and never wraps.** A row is one line (rule 9): the name is
 *   the elastic part and is cut at its end, and the token after it is `flex: none`.
 * - **It says the kind in words to a screen reader.** The glyph is decoration
 *   (`aria-hidden`) and the kind's word is in the text, visually hidden, so the accessible
 *   name is "run 7X8PXX" — never "trigram for heaven 7X8PXX".
 *
 * The glyph is `OBJECT_KIND_PRESENTATION`'s, from the bundled symbol face, and it is never a
 * status: ☰ and ⬡ are the Runs and Plan rail glyphs, on purpose. The tail is mono, because
 * an id is a thing ORCA produced (rule 8), at `mono-id`, which is tracked out so two tails
 * can be compared by eye.
 */
import { useMemo, type JSX } from "react";
import { OBJECT_KIND_PRESENTATION, type ObjectKind } from "@orca/design";
import { kindOf, parseId, parseIdText, uniqueTails } from "./object-id-model.js";
import { textClass } from "./text.js";

export interface ObjectIdProps {
  /** The id, verbatim. */
  id: string;
  /**
   * The kind of object. Read off the id's own prefix when it has one (`run_`, `wi_` …);
   * required for an id that carries none — an unprefixed UUID — or it draws no glyph.
   */
  kind?: ObjectKind;
  /**
   * `row` (the default): the token, after `name` when there is one.
   * `header`: the token on a crumb, after the crumb's own name and type word — always faint,
   * because the crumb's label leads, and silent about its kind, which the type word says.
   * `full`: the id verbatim, with the tail lifted out of it so the short form can be found
   * inside the long one — a detail pane, a notice that has to quote the id it could not open.
   */
  variant?: "row" | "header" | "full";
  /**
   * What a person calls the object. It leads, takes the room there is and is cut at its end;
   * the token follows it, faint, and is never cut. Sans: a name is not ORCA's string.
   */
  name?: string;
  /** The tail to draw, from `useIdTails` over the whole list; six characters otherwise. */
  tail?: string;
  className?: string;
}

export function ObjectId({ id, kind, variant = "row", name, tail, className }: ObjectIdProps): JSX.Element {
  const parsed = parseId(id);
  const shown = tail ?? parsed.tail();

  if (variant === "full") {
    /* A tail longer than the id it came from is not this id's: draw the id whole. */
    const head = id.endsWith(shown) ? id.slice(0, id.length - shown.length) : id;
    return (
      <span className={["orca-objid", "orca-objid--full", textClass("mono-id"), className].filter(Boolean).join(" ")}>
        <span className="orca-objid__head">{head}</span>
        {head === id ? null : <span className="orca-objid__tail">{shown}</span>}
      </span>
    );
  }

  const faint = variant === "header" || name !== undefined;
  /* On a crumb the type label beside the token already says the kind, so the token does not
     say it a second time to a screen reader. */
  const token = <IdToken id={id} kind={kindOf(id, kind)} tail={shown} faint={faint} sayKind={variant !== "header"} />;
  if (name === undefined) {
    return className === undefined ? token : <span className={className}>{token}</span>;
  }
  return (
    <span className={["orca-objid-named", className].filter(Boolean).join(" ")}>
      <span className="orca-objid-named__name">{name}</span>
      {token}
    </span>
  );
}

/**
 * The token itself: the kind's glyph, the kind's word for a screen reader, the tail. Shared
 * with the palette and the menu, which hold a token as one string (`idText`) and hand it
 * back here through `MachineText` so it is drawn — and named — the same way everywhere.
 */
export function IdToken({
  id,
  kind,
  tail,
  faint = false,
  sayKind = true,
}: {
  /** The whole id, for `title`. Absent where only the string form survived (`MachineText`). */
  id?: string;
  kind: ObjectKind | undefined;
  tail: string;
  faint?: boolean;
  /** Put the kind's word in the accessible name. Off where a label beside it already says it. */
  sayKind?: boolean;
}): JSX.Element {
  const presentation = kind === undefined ? undefined : OBJECT_KIND_PRESENTATION[kind];
  return (
    <span
      className={["orca-objid", faint ? "orca-objid--faint" : "", textClass("mono-id")].filter(Boolean).join(" ")}
      {...(id === undefined ? {} : { title: id })}
    >
      {presentation === undefined ? null : (
        <>
          <span className="orca-objid__kind" aria-hidden="true">
            {presentation.glyph}
          </span>
          {sayKind && <span className="orca-visually-hidden">{`${presentation.word} `}</span>}
        </>
      )}
      <span className="orca-objid__tail">{tail}</span>
    </span>
  );
}

/**
 * A machine string inside a sentence — a palette label's `labelMachine`, a menu item's
 * `hintMachine` — in mono. When the string is an id token (`idText`), it is drawn as one:
 * the glyph as decoration and the kind as a word, so the row's accessible name says
 * "work item 5M579G" rather than spelling out a symbol.
 */
export function MachineText({ text, className }: { text: string; className?: string }): JSX.Element {
  const token = parseIdText(text);
  if (token !== undefined) {
    return (
      <span className={className}>
        <IdToken kind={token.kind} tail={token.tail} faint />
      </span>
    );
  }
  return <span className={["orca-mono", textClass("mono-id"), className].filter(Boolean).join(" ")}>{text}</span>;
}

/**
 * The tails for every id a list holds, so that two rows never show the same token
 * (`uniqueTails`). Hand it the ids of the whole list — every item held, not the rows in the
 * virtualised window — and read each row's tail back with the function it returns.
 *
 * Keyed on the ids themselves rather than on the array, so a re-read that rebuilds the list
 * with the same ids does not redo the work.
 */
export function useIdTails(ids: readonly (string | undefined)[]): (id: string) => string {
  const key = ids.filter((id): id is string => id !== undefined).join("\n");
  return useMemo(() => {
    const tails = uniqueTails(key === "" ? [] : key.split("\n"));
    return (id: string) => tails.get(id) ?? parseId(id).tail();
  }, [key]);
}
