/**
 * The step between pressing "Always allow" / "Always deny" and a standing rule existing
 * (#702): the exact rule ORCA would write, who it is for, how long it lasts, and one button
 * that saves it and answers this call the same way.
 *
 * Before this, an always-button wrote whatever `derivePermissionRules` derived and reported it
 * afterwards. A standing grant is a decision about every later call, so the person sees it
 * first: the rule comes from the daemon's own preview (`OpenInputView.standing`, protocol 2.8),
 * derived from the same recorded tool call and workspace the write derives from, and the card
 * never composes one itself. Where the daemon sent no preview, or the preview says no rule
 * can be scoped to this call, the panel says so and offers nothing to save: the one-time
 * answers above still work.
 *
 * What the rule does *not* do is said too. ORCA answers the agent once, every time, and never
 * hands it a remembered grant, so a rule that expires or is removed is consulted again on the
 * very next ask. That is the property this panel is promising when it shows a lifetime.
 */
import type { JSX } from "react";
import type { OpenInputView, StandingRulePreview } from "@orca/protocol";
import { describeRule } from "../config/config-model.js";
import { Button, Text, textClass } from "../ui/index.js";

/** The lifetimes a person can pick, shortest first. `undefined` is "until removed". */
export const RULE_LIFETIMES: readonly { label: string; durationMs: number | undefined }[] = [
  { label: "1 hour", durationMs: 60 * 60 * 1000 },
  { label: "1 day", durationMs: 24 * 60 * 60 * 1000 },
  { label: "7 days", durationMs: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", durationMs: 30 * 24 * 60 * 60 * 1000 },
  { label: "Until removed", durationMs: undefined },
];

/** Seven days: long enough not to nag, short enough that a forgotten grant ends by itself. */
export const DEFAULT_RULE_LIFETIME = "7 days";

/** Why there is nothing to save, in a sentence, or undefined when there is a rule to show. */
export function standingUnavailable(
  standing: OpenInputView["standing"],
  decision: "allow" | "deny",
): string | undefined {
  if (!standing)
    return "This daemon does not show the rule before saving it (protocol 2.8). Update it to save rules from here; the one-time answers still work.";
  const preview: StandingRulePreview = standing[decision];
  if ("refused" in preview)
    return `ORCA will not save a rule for this call (${preview.refused.reason}): ${preview.refused.detail}. Answer once instead.`;
  return undefined;
}

export interface StandingRuleReviewProps {
  decision: "allow" | "deny";
  standing: OpenInputView["standing"];
  /** The agent the rule is written for; absent on an ask recorded before protocol 1.6. */
  agentId?: string | undefined;
  lifetime: string;
  onLifetime: (label: string) => void;
  /** Which rule is chosen: 0 the exact one, then the preview's wider command rules in order. */
  breadth?: number;
  onBreadth?: (breadth: number) => void;
  /** Why nothing can be sent right now (the card's own blocked reason, or the option mismatch). */
  blocked?: string | undefined;
  onSave: () => void;
  onCancel: () => void;
}

export function StandingRuleReview({
  decision,
  standing,
  agentId,
  lifetime,
  onLifetime,
  breadth = 0,
  onBreadth,
  blocked,
  onSave,
  onCancel,
}: StandingRuleReviewProps): JSX.Element {
  const unavailable = standingUnavailable(standing, decision);
  const preview = standing?.[decision];
  const choices = preview && "rules" in preview ? [preview.rules, ...(preview.broader ?? []).map((b) => b.rules)] : [];
  const rules = choices[breadth] ?? choices[0] ?? [];
  const describe = (rule: (typeof rules)[number]) => describeRule({ ...rule, source: "permissions" });
  const verb = decision === "allow" ? "allow" : "deny";
  const saveBlocked = unavailable ?? blocked;
  return (
    <section className="orca-attn__standing" aria-label={`Standing ${verb} rule`}>
      <Text style="caption">
        {`Standing ${verb} rule${agentId ? ` for ${agentId}` : ""}, written to the workspace permission sidecar`}
      </Text>
      {unavailable !== undefined ? (
        <p className={`orca-card__hint ${textClass("caption")}`} role="note">
          {unavailable}
        </p>
      ) : (
        <>
          {choices.length > 1 && onBreadth && (
            // A single shell command can be saved wider: `npm run build` as `npm run *` or `npm *`.
            <div className="orca-card__options" role="group" aria-label="Rule scope">
              {choices.map((choice, i) => (
                <Button
                  key={choice.map(describe).join("\n")}
                  size="sm"
                  tone={i === breadth ? "primary" : "default"}
                  aria-pressed={i === breadth}
                  onClick={() => onBreadth(i)}
                >
                  {i === 0 ? "Exactly this" : (choice[0]?.match.command ?? describe(choice[0]!))}
                </Button>
              ))}
            </div>
          )}
          <ul className={`orca-attn__standing-rules ${textClass("mono-log")}`} aria-label="Rules to save">
            {rules
              // The Config surface's own words for a rule, so the card and the list it lands in agree.
              .map(describe)
              .map((text) => (
                <li key={text}>{text}</li>
              ))}
          </ul>
          {breadth > 0 && (
            <p className={`orca-card__hint ${textClass("caption")}`}>
              A command rule allows each part of a compound command only when every part is allowed, and never covers
              sudo, bash -c, a variable or a redirection. Tools like npm run scripts the project defines, so a wide rule
              trusts those scripts too.
            </p>
          )}
          <div className="orca-card__options" role="group" aria-label="Rule lifetime">
            {RULE_LIFETIMES.map(({ label }) => (
              <Button
                key={label}
                size="sm"
                tone={label === lifetime ? "primary" : "default"}
                aria-pressed={label === lifetime}
                onClick={() => onLifetime(label)}
              >
                {label}
              </Button>
            ))}
          </div>
          <p className={`orca-card__hint ${textClass("caption")}`}>
            {`Until it ${lifetime === "Until removed" ? "is removed" : "expires"}, ORCA answers matching asks from this agent by this rule without asking. The agent is answered once each time and never told to remember the grant, so removing or expiring the rule takes effect on its next ask.`}
          </p>
        </>
      )}
      <div className="orca-card__options">
        <span className="orca-spacer" />
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          tone={decision === "deny" ? "danger" : "primary"}
          disabled={saveBlocked !== undefined}
          {...(saveBlocked !== undefined ? { disabledReason: saveBlocked } : {})}
          onClick={onSave}
        >
          {`Save rule and ${verb}`}
        </Button>
      </div>
    </section>
  );
}

/** The `previewRef` a save sends for the chosen breadth: the exact rule's, or a wider one's. */
export function previewRefAt(preview: StandingRulePreview, breadth: number): string | undefined {
  if (!("rules" in preview)) return undefined;
  return breadth === 0 ? preview.ref : (preview.broader?.[breadth - 1]?.ref ?? preview.ref);
}

/** The duration an answer carries for a lifetime label; undefined for "until removed". */
export function lifetimeDuration(label: string): number | undefined {
  return RULE_LIFETIMES.find((entry) => entry.label === label)?.durationMs;
}
