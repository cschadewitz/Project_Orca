// @vitest-environment happy-dom
/** The judge's note on a permission ask (#701): parsed strictly, worded by ORCA, shown under the command. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { JUDGE_ASK_VERDICTS, type JudgeAskNote } from "@orca/protocol";
import { PermissionCard } from "../src/attention/permission-card.js";
import { judgeAskNote, judgeNoteText } from "../src/attention/judge-note.js";
import { PERMISSION_ASK } from "./fixtures-inputs.js";
import { harness, type Harness } from "./harness.js";

let h: Harness | undefined;
afterEach(() => {
  cleanup();
  h?.dispose();
  h = undefined;
});

function card(input: typeof PERMISSION_ASK, onAnswer = vi.fn()) {
  h ??= harness();
  const H = h;
  return (
    <H.Providers>
      <PermissionCard input={input} placement="inbox" onAnswer={onAnswer} />
    </H.Providers>
  );
}

const withJudge = (judge: unknown) => ({ ...PERMISSION_ASK, context: { ...PERMISSION_ASK.context, judge } });

describe("judgeAskNote", () => {
  it("reads a well-formed note", () => {
    expect(
      judgeAskNote({ judge: { verdict: "covered", kind: "command", advisory: true, ruleId: "config:2" } }),
    ).toEqual({ verdict: "covered", kind: "command", advisory: true, ruleId: "config:2" });
  });

  it.each([
    ["none", {}],
    ["not an object", { judge: "covered" }],
    ["an unknown verdict", { judge: { verdict: "probably-fine" } }],
    ["an unknown reason", { judge: { verdict: "not-covered", reasonCode: "the model said so" } }],
    ["model prose", { judge: { verdict: "covered", explanation: "looks safe to me" } }],
    ["advisory false", { judge: { verdict: "covered", advisory: false } }],
    ["a long rule id", { judge: { verdict: "covered", ruleId: "x".repeat(65) } }],
  ])("shows nothing for %s", (_name, context) => {
    expect(judgeAskNote(context)).toBeUndefined();
  });
});

describe("judgeNoteText", () => {
  it("has wording for every verdict, advice or not", () => {
    for (const verdict of JUDGE_ASK_VERDICTS)
      for (const advisory of [undefined, true] as const) {
        const note: JudgeAskNote = { verdict, ...(advisory ? { advisory } : {}) };
        expect(judgeNoteText(note).headline.length).toBeGreaterThan(0);
      }
  });

  it("calls a covered command advice, not an allow", () => {
    const text = judgeNoteText({
      verdict: "covered",
      kind: "command",
      advisory: true,
      reasonCode: "matches-criterion",
      ruleId: "sidecar:0",
    });
    expect(text).toEqual({
      headline: "The judge recommends allowing this. It's advice only: you decide.",
      reason: "Your rule covers this.",
      ruleId: "sidecar:0",
      advice: true,
    });
  });

  it("names a rule only when the judge found one that covers the call", () => {
    expect(
      judgeNoteText({ verdict: "not-covered", reasonCode: "outside-criterion", ruleId: "config:1" }).ruleId,
    ).toBeUndefined();
  });

  it("never repeats a reason from another verdict's family", () => {
    for (const verdict of ["changed-since", "malformed", "unavailable", "not-covered"] as const)
      expect(judgeNoteText({ verdict, reasonCode: "matches-criterion", ruleId: "config:1" })).toEqual({
        headline: judgeNoteText({ verdict }).headline,
        advice: false,
      });
  });

  it("says why the judge was not asked", () => {
    // Neutral: an unreadable policy or another safety restriction closes the lane too, not only a user's rule.
    expect(judgeNoteText({ verdict: "hard-boundary" }).headline).toBe(
      "The judge wasn't asked: a safety restriction applies to this call, so it's your call.",
    );
    expect(judgeNoteText({ verdict: "over-budget" }).headline).toMatch(/daily budget is used up/);
  });
});

describe("PermissionCard with a judge's note", () => {
  it("shows the advice under the command and keeps the answer the person's", () => {
    const onAnswer = vi.fn();
    render(
      card(
        withJudge({
          verdict: "covered",
          kind: "command",
          advisory: true,
          reasonCode: "matches-criterion",
          ruleId: "config:2",
        }),
        onAnswer,
      ),
    );
    const note = screen.getByRole("note", { name: "Plain-language rule judge" });
    expect(note.textContent).toContain("The judge recommends allowing this. It's advice only: you decide.");
    expect(note.textContent).toContain("Your rule covers this. Rule config:2.");
    // Nothing is answered for the person.
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getAllByText("Allow once").length).toBeGreaterThan(0);
  });

  it("shows no note when the ask carries none, or one it cannot read", () => {
    const { rerender } = render(card(PERMISSION_ASK));
    expect(screen.queryByRole("note", { name: "Plain-language rule judge" })).toBeNull();
    rerender(card(withJudge({ verdict: "approve" })));
    expect(screen.queryByRole("note", { name: "Plain-language rule judge" })).toBeNull();
  });
});
