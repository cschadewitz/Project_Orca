/**
 * `KeyValueList` — names and the values ORCA holds under them, as a detail pane lists them.
 * The one display for that wherever it appears: the variables a run was started with (step
 * detail's run summary), a node's configuration (the Workflows inspector) and the variables
 * a launch will send (the guided launch's review card). Editing a value is not this — that
 * is `ConfigField` around a control.
 *
 * A name and its value, as a description list, so a screen reader hears each value as the
 * value *of* that name rather than as the next string down the pane. Both halves are mono,
 * because both are things ORCA produced (rule 8): the value is what it holds, and the name
 * is an identifier — `maxBuildAttempts`, `workItem`, `autoApproveWhen` — that a workflow
 * file, a plugin or the runtime declared, not a label a person wrote for this screen. The
 * name is `mono-id`, the mono style at the size and line height the label had as `caption`,
 * so setting it in mono moved nothing — except that mono is wider, which is why a long name
 * breaks between its words (`breakable`) rather than at the column's edge.
 *
 * What a value looks like is `value-text.ts`'s decision; this file only sets it:
 *
 * - **On the line**, beside its name, for a string, a number, a boolean or `null`, in
 *   `mono-body`. It breaks anywhere rather than holding the pane open, which only a string
 *   with no spaces in it ever needs.
 * - **As a block** under its name, for an object or an array: its indented JSON in a `Well`,
 *   which is the system's ground for machine text, across the list's whole width rather than
 *   in the value column, where at a pane's narrowest one indented key already wraps.
 * - **Withheld**, for a name the caller says may not be shown: the word, in sans because
 *   it is the interface speaking and not a value. The value is never read, so it never
 *   reaches the document — not in a title, not visually hidden, not at all.
 *
 * A block is clamped to a few lines and opens with a button under it. Not a `<details>`
 * (which `ToolCallRow` rightly is): a closed `<details>` shows only its summary, and a value
 * has no summary but its first lines — a closed `workItem` would be a name with nothing
 * beside it. A clamp keeps those lines on screen and the whole value in the document, so a
 * screen reader reads all of it whether the block is open or not: the button changes only
 * what is drawn, and says in `aria-expanded` which of the two it is.
 *
 * It says "Show all" and not how many lines there are. The count to hand is the JSON's, and
 * in a narrow pane a value of three lines can wrap to more than the clamp shows — a button
 * offering "all 3 lines" under eight of them would be true and read as wrong.
 *
 * The button is there when the clamp cuts something off and not otherwise, which is a thing
 * only the layout knows: a value of four lines in a wide pane fits, and the same four lines
 * wrapped in a narrow one may not. So it is measured, again whenever the well is resized —
 * dragging the pane boundary is the usual reason — and never guessed from a count of lines
 * or characters, which would put a button that does nothing under a value that fits.
 *
 * The list is not a list of rows. Rows are one fixed height and never wrap (rule 9); this is
 * the detail pane a row's full strings are revealed in, so an entry is as tall as its value.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import { Button } from "./button.js";
import { textClass } from "./text.js";
import { valueText } from "./value-text.js";
import { Well } from "./well.js";

export interface KeyValueListProps {
  /** Each name and its value, listed in the record's own key order. Values are untyped. */
  values: Readonly<Record<string, unknown>>;
  /** Names whose value may not be shown. Each is listed as "Withheld"; its value is never read. */
  withheld?: readonly string[];
  className?: string;
}

/**
 * Nothing at all for an empty record, rather than an empty list a screen reader would count:
 * why there is nothing is a sentence, and it is the caller's — "This run was started with
 * none", "This node type carries no configuration".
 */
export function KeyValueList({ values, withheld = [], className }: KeyValueListProps): JSX.Element | null {
  const names = Object.keys(values);
  if (names.length === 0) return null;
  return (
    <dl className={["orca-kv", className].filter(Boolean).join(" ")}>
      {names.map((name) =>
        withheld.includes(name) ? (
          <Withheld key={name} name={name} />
        ) : (
          <Entry key={name} name={name} value={values[name]} />
        ),
      )}
    </dl>
  );
}

function Name({ name }: { name: string }): JSX.Element {
  return <dt className={`orca-kv__name ${textClass("mono-id")}`}>{breakable(name)}</dt>;
}

/**
 * A name with a break opportunity between the words inside it: before the capital that
 * starts each hump of a camelCase identifier, and after a `_` or a `.`. Mono is wider than the
 * sans the name used to be set in, so a name of sixteen characters — `maxBuildAttempts` —
 * no longer fits the narrow label column, and with nothing better to break at it broke at
 * whichever letter reached the edge, `maxBuildAttempt` over `s`. It breaks as `maxBuild` over
 * `Attempts` instead, and a name that fits is untouched. A `<wbr>` is not a character, so the
 * name still reads, copies and is found by a search as itself.
 */
function breakable(name: string): ReactNode {
  const words = name.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[_.])(?=.)/);
  if (words.length === 1) return name;
  return words.flatMap((word, index) => (index === 0 ? [word] : [<wbr key={index} />, word]));
}

function Withheld({ name }: { name: string }): JSX.Element {
  return (
    <div className="orca-kv__item">
      <Name name={name} />
      <dd className={`orca-kv__value orca-kv__value--withheld ${textClass("caption")}`}>Withheld</dd>
    </div>
  );
}

function Entry({ name, value }: { name: string; value: unknown }): JSX.Element {
  const shown = useMemo(() => valueText(value), [value]);
  return (
    <div className={`orca-kv__item${shown.block ? " orca-kv__item--block" : ""}`}>
      <Name name={name} />
      {shown.block ? (
        <dd className="orca-kv__value">
          <BlockValue name={name} text={shown.text} />
        </dd>
      ) : (
        <dd className={`orca-kv__value orca-kv__value--line ${textClass("mono-body")}`}>{shown.text}</dd>
      )}
    </div>
  );
}

function BlockValue({ name, text }: { name: string; text: string }): JSX.Element {
  const id = useId();
  const well = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(false);
  const cut = useCutShort(well, !open, text);

  return (
    <>
      <Well
        ref={well}
        id={id}
        className={["orca-kv__well", open ? "" : "orca-kv__well--clamped"].filter(Boolean).join(" ")}
      >
        {text}
      </Well>
      {/* Open, it stays: it is the way back. Its name carries the value's name, which the eye
          gets from the line above and a list of the pane's buttons would otherwise not. */}
      {(cut || open) && (
        <Button
          tone="ghost"
          size="sm"
          className="orca-kv__more"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((was) => !was)}
        >
          {open ? "Show less" : "Show all"}
          <span className="orca-visually-hidden">{` of ${name}`}</span>
        </Button>
      )}
    </>
  );
}

/**
 * Whether the clamped well is hiding anything: its content is taller than its box. Read
 * after layout and before paint, so the button is never drawn a frame late, and again on
 * every resize of the well while it is clamped. Open, there is nothing to measure, and the
 * last answer stands until it closes.
 */
function useCutShort(well: RefObject<HTMLPreElement | null>, clamped: boolean, text: string): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const box = well.current;
    if (box === null || !clamped) return;
    const measure = (): void => setCut(box.scrollHeight > box.clientHeight);
    measure();
    const view = box.ownerDocument.defaultView;
    if (!view || typeof view.ResizeObserver !== "function") return;
    const observer = new view.ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [well, clamped, text]);
  return cut;
}
