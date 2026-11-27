// @vitest-environment happy-dom
/**
 * An agent's question (#1133, #1169) on the Attention surface: a form card in tier 1, sent
 * with the live target and the form's content as the answer, declinable, and closed once its
 * turn's callback is gone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { OpenInputView } from "@orca/protocol";
import { type JSX } from "react";
import { cardName } from "../src/attention/answer-card.js";
import { AttentionSurface } from "../src/attention/attention-surface.js";
import { tierOf } from "../src/attention/items.js";
import { useAttention } from "../src/attention/use-attention.js";
import { harness, installBridge, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { FIVE_GATES, INPUTS_AS_OF, PERMISSION_ASK } from "./fixtures-inputs.js";

const teardown: (() => void)[] = [];
let fake: FakeBridge;
let h: Harness;

function Host(): JSX.Element {
  const feed = useAttention();
  return <AttentionSurface connection="live" feed={feed} />;
}

function mount(inputs: readonly OpenInputView[]): void {
  fake.script({
    "inputs.list": () => ({ ok: true, result: { inputs: [...inputs], waiting: inputs.length, asOf: INPUTS_AS_OF } }),
  });
  const { Providers } = h;
  render(
    <Providers>
      <Host />
    </Providers>,
  );
}

const QUESTION: OpenInputView = {
  ...PERMISSION_ASK,
  id: "ask-q",
  kind: "question",
  question: "Which database should the service use?",
  options: [],
  standing: undefined,
  context: {
    toolCallId: "tc-1",
    elicitation: {
      message: "Which database should the service use?",
      fields: [
        {
          key: "question_0",
          kind: "choice",
          title: "Database",
          required: true,
          options: [
            { value: "Postgres", label: "Postgres", description: "Relational, already in the stack." },
            { value: "SQLite", label: "SQLite" },
          ],
        },
        { key: "question_0_custom", kind: "text", title: "Other", required: false },
      ],
    },
  },
  live: { ...PERMISSION_ASK.live!, target: { ...PERMISSION_ASK.live!.target, requestId: "ask-q" } },
};

beforeEach(() => {
  stubMatchMedia(1440);
  fake = installBridge();
  teardown.push(fake.install());
  h = harness();
  teardown.push(h.dispose);
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

const answerCall = () => fake.calls.find((c) => c.method === "inputs.answer")?.params as Record<string, unknown>;

describe("an agent's question", () => {
  it("is tier 1, beside permission asks", () => {
    expect(tierOf(QUESTION)).toBe("permission");
    expect(tierOf({ ...QUESTION, context: {} })).toBe("gate");
  });

  it("shows the form and says who is asking", async () => {
    mount([FIVE_GATES[0]!, QUESTION]);
    const card = await screen.findByRole("region", { name: cardName("permission", QUESTION.question) });
    // The eyebrow says what it is, on the card around the region.
    expect(within(card.closest(".orca-attn__card")!).getByText("question")).toBeTruthy();
    expect(within(card).getByText("claude")).toBeTruthy();
    expect(within(card).getByRole("radio", { name: /Postgres/ })).toBeTruthy();
    expect(within(card).getByText("Relational, already in the stack.")).toBeTruthy();
    expect(within(card).getByLabelText("Other")).toBeTruthy();
    expect(within(card).queryByText("Always allow")).toBeNull();
  });

  it("answers with the form's content to the live callback", async () => {
    mount([QUESTION]);
    const card = await screen.findByRole("region", { name: cardName("permission", QUESTION.question) });
    const answer = within(card).getByRole("button", { name: "Answer" });
    // The required choice first.
    expect(answer.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(card).getByRole("radio", { name: /SQLite/ }));
    fireEvent.change(within(card).getByLabelText("Other"), { target: { value: "for now" } });
    fireEvent.click(within(card).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(answerCall()).toBeDefined());
    expect(answerCall()).toMatchObject({
      requestId: "ask-q",
      live: QUESTION.live!.target,
      optionId: JSON.stringify({ action: "accept", content: { question_0: "SQLite", question_0_custom: "for now" } }),
    });
  });

  it("declines", async () => {
    mount([QUESTION]);
    const card = await screen.findByRole("region", { name: cardName("permission", QUESTION.question) });
    fireEvent.click(within(card).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(answerCall()).toBeDefined());
    expect(answerCall()).toMatchObject({ optionId: JSON.stringify({ action: "decline" }) });
  });

  it("cannot be answered once its turn's callback is gone", async () => {
    mount([{ ...QUESTION, live: { ...QUESTION.live!, state: "expired" } }]);
    const card = await screen.findByRole("region", { name: cardName("permission", QUESTION.question) });
    expect(within(card).getByRole("button", { name: "Decline" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(card).getByRole("group")).toHaveProperty("disabled", true);
  });
});
