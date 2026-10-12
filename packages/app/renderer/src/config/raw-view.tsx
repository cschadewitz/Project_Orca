/**
 * The document as it is on disk: the bytes, editable, in the `.orca-yaml` block.
 *
 * Three things worth knowing:
 *
 * - **It is a `textarea`, not an editor.** The design system styles the block and the type;
 *   a code editor with folding, a gutter and its own keymap would be a second keyboard
 *   contract in an app that has one (AGENTS.md), and nothing on this screen needs one. The
 *   `patch` write exists precisely so that the ordinary case never comes through here.
 * - **The highlight is a locator strip above the text, not a decoration inside it.** A
 *   `textarea` holds characters and cannot hold a `<span class="orca-yaml__hl">`, and
 *   painting one behind a transparent textarea means matching two boxes' metrics forever.
 *   So "show raw" scrolls here, puts the caret on the line, and draws that one line in the
 *   `.orca-yaml__hl` block with its number — which is the thing a person came for: *which*
 *   line this key is on.
 * - **Nothing is redacted, and the view says so.** `config.get` hands over the bytes,
 *   comments and ssh hosts and command lines included, because a form that edits a file has
 *   to show the file and a redacted text written back would destroy what it hid
 *   (`config.ts` in `@orca/protocol`). A person reading over a shoulder deserves to be told
 *   that, once, where they can see it.
 */
import { useEffect, useRef, type JSX } from "react";
import { Text, textClass } from "../ui/index.js";
import { lineOfPath } from "./config-model.js";

export interface RawViewProps {
  /** The document's absolute path, named so a person can open the same file elsewhere. */
  path: string;
  /** The text as it is now: the draft when there is one, the file when there is not. */
  text: string;
  /** The path "show raw" jumped to, if any. Highlighted and scrolled to. */
  target?: string;
  /** Absent makes the view read-only — the sidecar here (#176 edits it), and file mode. */
  onChange?: (text: string) => void;
  /** Named in the label so two raw views on one screen are told apart. */
  label: string;
  /**
   * Take the keyboard when this becomes true: a deep link naming this document
   * (`orca://config/permissions`) landed on it, and the honest way to land on a thing is to
   * put the focus in it.
   */
  autoFocus?: boolean;
}

export function RawView({ path, text, target, onChange, label, autoFocus = false }: RawViewProps): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null);
  const line = target === undefined ? undefined : lineOfPath(text, target);
  const lines = text.split("\n");

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    if (line === undefined) {
      if (autoFocus) element.focus();
      return;
    }
    /* The caret is put on the line rather than the element scrolled to it: a caret is
       where the keyboard already is, it survives a resize, and moving it scrolls the line
       into view as a side effect of the thing the person is about to do anyway. */
    /* Read off the element rather than off the `text` prop: the prop changes on every
       keystroke, and an effect that depended on it would drag the caret back to the
       highlighted line while somebody was typing three lines below it. */
    const current = element.value.split("\n");
    const start = current.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0);
    element.focus();
    element.setSelectionRange(start, start + (current[line - 1]?.length ?? 0));
  }, [autoFocus, line, target, path]);

  return (
    <div className="orca-config__rawview">
      <div className="orca-config__rawhead">
        <span className={`orca-config__path ${textClass("mono-id")}`}>{path}</span>
        <Text style="caption">This is the file as it is on disk. Nothing in it is hidden or redacted.</Text>
      </div>

      {target !== undefined && (
        <div className="orca-config__locator">
          <Text style="caption">
            {line === undefined
              ? `${target} is not written in this file — it would take its default.`
              : `${target} is on line ${line}.`}
          </Text>
          {line !== undefined && (
            <pre className={`orca-yaml ${textClass("mono-log")}`} aria-label={`Line ${line}`}>
              <span className="orca-yaml__hl">{lines[line - 1]}</span>
            </pre>
          )}
        </div>
      )}

      <textarea
        ref={area}
        className={`orca-yaml orca-config__editor ${textClass("mono-log")}`}
        data-config-editor=""
        aria-label={label}
        value={text}
        spellCheck={false}
        readOnly={onChange === undefined}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </div>
  );
}
