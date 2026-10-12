/**
 * `Well` — a sunken block for text ORCA produced: a command, a payload, a handshake
 * result, a stack trace.
 *
 * `surface-sunken` is what tells a reader "this is machine output, not prose", and rule 8
 * is why the default type style is mono. It is a `<pre>`, so whitespace the machine
 * emitted is whitespace the reader sees; a well that reflowed a command would be a well
 * that changed it.
 */
import type { JSX, ReactNode, Ref } from "react";
import type { TextStyle } from "@orca/design";
import { textClass } from "./text.js";

export interface WellProps {
  children?: ReactNode;
  /** Defaults to `mono-log`. `mono-id` for a single identifier, `mono-body` for a snippet. */
  style?: TextStyle;
  /** Names the block for a screen reader, which reads it as a region on demand. */
  label?: string;
  className?: string;
  /** So a control that opens or closes the well can name it in `aria-controls`. */
  id?: string;
  /** The `<pre>` itself, for a caller that has to ask whether the block is cut short. */
  ref?: Ref<HTMLPreElement>;
}

export function Well({ children, style = "mono-log", label, className, id, ref }: WellProps): JSX.Element {
  return (
    <pre
      ref={ref}
      {...(id === undefined ? {} : { id })}
      className={["orca-well", textClass(style), className].filter(Boolean).join(" ")}
      {...(label === undefined ? {} : { role: "region", "aria-label": label })}
    >
      {children}
    </pre>
  );
}
