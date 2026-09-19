/**
 * `Card` — the raised block with a left rail that an interruption arrives in.
 *
 * Three tones, and the two that are not `default` are the two interruptions the design
 * intends: a gate (a decision ORCA is waiting on) and a permission ask. Both take the
 * waiting colour, because waiting is the loud status (rule 6), and both announce
 * assertively when they open — which is why `interrupt` is a prop and not a guess: a card
 * replayed in a finished run must not announce at all.
 *
 * The card's contents — the question, the options, the artefact refs — come with the
 * surfaces that own them (#160); this is the shell they sit in.
 */
import type { JSX, ReactNode } from "react";

export type CardTone = "default" | "gate" | "permission";

export interface CardProps {
  children?: ReactNode;
  tone?: CardTone;
  /** Uppercase kicker above the question: "gate", "permission", "waiting 4m". */
  eyebrow?: ReactNode;
  /** True while the card is genuinely asking. Announces assertively; false when replaying. */
  interrupt?: boolean;
  className?: string;
}

export function Card({ children, tone = "default", eyebrow, interrupt = false, className }: CardProps): JSX.Element {
  return (
    <section
      className={["orca-card", tone === "default" ? "" : `orca-card--${tone}`, className].filter(Boolean).join(" ")}
      {...(interrupt ? { role: "alert", "aria-live": "assertive" as const } : {})}
    >
      {eyebrow !== undefined && <div className="orca-card__eyebrow">{eyebrow}</div>}
      {children}
    </section>
  );
}
