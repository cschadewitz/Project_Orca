/**
 * `Text` — the one way the renderer picks a type style.
 *
 * The scale lives in tokens.json and is emitted as the `orca-text-*` classes in
 * tokens.css; `TextStyle` is the generated union of their names, so a style that does not
 * exist is a type error rather than a class that silently does nothing. Rule 8 is the
 * reason this is a component at all: mono means ORCA produced it, sans means a person
 * wrote it, and that choice should be visible at the call site.
 *
 * The `style` prop deliberately shadows the DOM one, so `<Text>` cannot carry an inline
 * style — the place for a value is a token, not a call site (rule 1).
 */
import type { ElementType, HTMLAttributes, JSX, ReactNode } from "react";
import type { TextStyle } from "@orca/design";

export const textClass = (style: TextStyle): string => `orca-text-${style}`;

export interface TextProps extends Omit<HTMLAttributes<HTMLElement>, "style"> {
  style: TextStyle;
  children?: ReactNode;
  /** The element to render. Defaults to `span`; pass `h1`, `p`, `code`, … where it matters. */
  as?: ElementType;
}

export function Text({ style, children, as: As = "span", className, ...rest }: TextProps): JSX.Element {
  return (
    <As className={[textClass(style), className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </As>
  );
}
