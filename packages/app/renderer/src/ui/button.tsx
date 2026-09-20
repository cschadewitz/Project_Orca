/**
 * `Button` — every clickable control that is not a row, a crumb or a chip.
 *
 * Tone is meaning, not decoration: `primary` is the accent, which means interactive and
 * never a state (rule 5); `danger` is the one control on a card that cancels or denies;
 * `ghost` is a control that must not compete with the content it sits on.
 *
 * Disabled is `aria-disabled` plus a swallowed click rather than the `disabled`
 * attribute, because a disabled button is unfocusable and so its reason is unreachable by
 * keyboard — and docs/design/40-connection-states.md requires the reason to be *on* the
 * control. In file mode the button is absent instead; that is the caller's decision.
 */
import type { ButtonHTMLAttributes, JSX, MouseEvent, ReactNode } from "react";
import type { TextStyle } from "@orca/design";
import { textClass } from "./text.js";

export type ButtonTone = "default" | "primary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

/* `.orca-btn` is noted `type: label` and `.orca-btn--sm` overrides it with `type: caption`
   (#211); the large button takes the label size too, and only its box grows. */
const TEXT: Record<ButtonSize, TextStyle> = { sm: "caption", md: "label", lg: "label" };

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "style"> {
  children?: ReactNode;
  tone?: ButtonTone;
  size?: ButtonSize;
  disabled?: boolean;
  /** Why it is disabled. Rendered as the button's `title`, so it is reachable on hover and focus. */
  disabledReason?: string;
}

export function Button({
  children,
  tone = "default",
  size = "md",
  disabled = false,
  disabledReason,
  className,
  onClick,
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    "orca-btn",
    textClass(TEXT[size]),
    tone === "default" ? "" : `orca-btn--${tone}`,
    size === "md" ? "" : `orca-btn--${size}`,
    className,
  ];

  return (
    <button
      type="button"
      className={classes.filter(Boolean).join(" ")}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (disabled) return;
        onClick?.(event);
      }}
      {...(disabled ? { "aria-disabled": true } : {})}
      {...(disabled && disabledReason !== undefined ? { title: disabledReason } : {})}
      {...rest}
    >
      {children}
    </button>
  );
}
