/**
 * `RunVariables` — the variables a run was started with, as the run summary lists them.
 *
 * A name and its value, as a description list, so a screen reader hears each value as the
 * value *of* that name rather than as the next string down the pane. What a value looks like
 * is `variable-value.ts`'s decision; this file only sets it:
 *
 * - **On the line**, beside its name, for a string, a number, a boolean or `null`. Mono,
 *   because a variable is a value ORCA holds and not a sentence (rule 8). It breaks anywhere
 *   rather than holding the pane open, which only a string with no spaces in it ever needs.
 * - **As a block** under its name, for an object or an array: its indented JSON in a `Well`,
 *   which is the system's ground for machine text, across the pane's whole width rather than
 *   in the value column, where at the pane's narrowest one indented key already wraps.
 *
 * A block is clamped to a few lines and opens with a button under it. Not a `<details>`
 * (which `ToolCallRow` rightly is): a closed `<details>` shows only its summary, and a
 * variable has no summary but its first lines — a closed `workItem` would be a name with
 * nothing beside it. A clamp keeps those lines on screen and the whole value in the document,
 * so a screen reader reads all of it whether the block is open or not: the button changes
 * only what is drawn, and says in `aria-expanded` which of the two it is.
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
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject } from "react";
import { Button, Well, textClass } from "../ui/index.js";
import { variableText } from "./variable-value.js";

export function RunVariables({ vars }: { vars: Readonly<Record<string, unknown>> }): JSX.Element {
  return (
    <dl className="orca-step__vars">
      {Object.entries(vars).map(([name, value]) => (
        <RunVariable key={name} name={name} value={value} />
      ))}
    </dl>
  );
}

function RunVariable({ name, value }: { name: string; value: unknown }): JSX.Element {
  const shown = useMemo(() => variableText(value), [value]);
  return (
    <div className={`orca-field orca-step__var${shown.block ? " orca-step__var--block" : ""}`}>
      <dt className={`orca-field__label ${textClass("caption")}`}>{name}</dt>
      {shown.block ? (
        <dd className="orca-step__var-value">
          <BlockValue name={name} text={shown.text} />
        </dd>
      ) : (
        <dd className={`orca-step__var-value orca-mono ${textClass("mono-body")}`}>{shown.text}</dd>
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
        className={["orca-step__var-well", open ? "" : "orca-step__var-well--clamped"].filter(Boolean).join(" ")}
      >
        {text}
      </Well>
      {/* Open, it stays: it is the way back. Its name carries the variable's, which the eye
          gets from the line above and a list of the pane's buttons would otherwise not. */}
      {(cut || open) && (
        <Button
          tone="ghost"
          size="sm"
          className="orca-step__var-more"
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
