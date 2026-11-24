/**
 * The judge's note on a permission ask (#701): what a plain-language rule's judge said about the
 * call before the person was asked. It answers nothing. For an edit or a command it is advice,
 * and the person decides either way; for a read, a search or an MCP tool call it says why the
 * judge did not allow it, so the ask came to the person.
 *
 * The daemon carries it on the ask's free `context` record as `context.judge`
 * (`JudgeAskNoteSchema`). The wording is ORCA's own, from fixed verdicts and reason codes: never
 * model prose. A note this build does not recognise is not shown rather than guessed at.
 */
import type { JSX } from "react";
import { JudgeAskNoteSchema, type JudgeAskNote, type JudgeAskReason } from "@orca/protocol";
import { textClass } from "../ui/index.js";

/** The judge's note on an ask's context, when it carries one this build can read. */
export function judgeAskNote(context: Record<string, unknown>): JudgeAskNote | undefined {
  const parsed = JudgeAskNoteSchema.safeParse(context["judge"]);
  return parsed.success ? parsed.data : undefined;
}

const REASON_TEXT: Readonly<Record<JudgeAskReason, string>> = {
  "matches-criterion": "Your rule covers this.",
  "outside-criterion": "Your rule doesn't cover this.",
  "excluded-by-criterion": "Your rule excludes this.",
  "action-ambiguous": "It isn't clear what this would do.",
  "criterion-ambiguous": "It isn't clear whether your rule covers this.",
};

export interface JudgeNoteText {
  /** One sentence: what the judge said. */
  headline: string;
  /** The judge's fixed reason, in ORCA's words, when it gave one. */
  reason?: string;
  /** The rule the verdict is about, by its id, when the judge named one it covered. */
  ruleId?: string;
  /** Whether the person still decides because the verdict is only advice. */
  advice: boolean;
}

/** ORCA's wording for a note. */
export function judgeNoteText(note: JudgeAskNote): JudgeNoteText {
  const advice = note.advisory === true;
  const reason = note.reasonCode ? REASON_TEXT[note.reasonCode] : undefined;
  const headline = ((): string => {
    switch (note.verdict) {
      case "covered":
        return advice
          ? "The judge recommends allowing this. It's advice only: you decide."
          : "The judge said a rule covers this, but ORCA's check afterwards didn't hold, so you decide.";
      case "not-covered":
        return advice
          ? "The judge doesn't recommend allowing this. It's advice only: you decide."
          : "The judge didn't find a plain-language rule that covers this.";
      case "unsure":
        return "The judge wasn't sure, so it's your call.";
      case "unavailable":
        return "The judge couldn't be reached, so it's your call.";
      case "timeout":
        return "The judge didn't answer in time, so it's your call.";
      case "malformed":
        return "The judge's reply couldn't be read, so it's your call.";
      case "over-budget":
        return "The judge's daily budget is used up, so it wasn't asked.";
      case "injection-suspected":
        return "The judge wasn't asked: this request looked like it was trying to steer the judge.";
      case "hard-boundary":
        return "The judge wasn't asked: a rule you wrote asks or denies this.";
      case "outside-envelope":
        return "The judge wasn't asked: it can't vouch for this kind of call.";
    }
  })();
  return {
    headline,
    ...(reason ? { reason } : {}),
    ...(note.verdict === "covered" && note.ruleId ? { ruleId: note.ruleId } : {}),
    advice,
  };
}

export function JudgeNote({ note }: { note: JudgeAskNote }): JSX.Element {
  const text = judgeNoteText(note);
  return (
    <div className="orca-attn__judge" role="note" aria-label="Plain-language rule judge">
      <span className={textClass("caption")}>{text.headline}</span>
      {(text.reason || text.ruleId) && (
        <span className={`orca-attn__judge-reason ${textClass("caption")}`}>
          {text.reason}
          {text.ruleId && (
            <>
              {text.reason ? " " : ""}
              Rule <span className={`orca-id ${textClass("mono-id")}`}>{text.ruleId}</span>.
            </>
          )}
        </span>
      )}
    </div>
  );
}
