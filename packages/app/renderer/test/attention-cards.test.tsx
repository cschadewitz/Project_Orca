// @vitest-environment happy-dom
/**
 * The card's own behaviour and the surface's states, mounted without the chrome: the note,
 * a free-text ask, `J`/`K`, `G`, an answer in flight, and the four things the surface can
 * be looking at instead of a list.
 *
 * Mounted through a small host component rather than `renderChrome`, because the feed is
 * the chrome's (`App.tsx` holds it so the title bar can carry the count on every screen) —
 * so a test of the surface alone has to hold it too. That host is four lines and is the
 * whole of what this file knows about the wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NotificationMessage, OpenInputView } from "@orca/protocol";
import type { ConnectionState } from "@orca/design";
import { type JSX } from "react";
import { cardName } from "../src/attention/answer-card.js";
import { AttentionSurface } from "../src/attention/attention-surface.js";
import { useAttention } from "../src/attention/use-attention.js";
import { harness, installBridge, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { FIVE_GATES, INPUTS_AS_OF, PERMISSION_ASK } from "./fixtures-inputs.js";
import { AS_OF } from "./fixtures.js";

const teardown: (() => void)[] = [];
let fake: FakeBridge;
let h: Harness;

function Host({
  connection,
  onOpenRun,
}: {
  connection: ConnectionState;
  onOpenRun?: (id: string) => void;
}): JSX.Element {
  const feed = useAttention();
  return <AttentionSurface connection={connection} feed={feed} {...(onOpenRun ? { onOpenRun } : {})} />;
}

/** Put the surface on screen against whatever the bridge is currently answering. */
function renderHost(options: { connection?: ConnectionState; onOpenRun?: (id: string) => void } = {}): void {
  const { Providers } = h;
  render(
    <Providers>
      <Host
        connection={options.connection ?? "live"}
        {...(options.onOpenRun ? { onOpenRun: options.onOpenRun } : {})}
      />
    </Providers>,
  );
}

/** `inputs.list` answering with exactly these, then the surface. */
function mount(
  inputs: readonly OpenInputView[],
  options: { connection?: ConnectionState; onOpenRun?: (id: string) => void } = {},
): void {
  fake.script({
    "inputs.list": (params) => {
      const matching = inputs.filter((i) => params.runId === undefined || i.runId === params.runId);
      return { ok: true, result: { inputs: [...matching], waiting: matching.length, asOf: INPUTS_AS_OF } };
    },
  });
  renderHost(options);
}

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

describe("answering with a note", () => {
  it("opens the note field on ⇧Enter, says where the note goes, and sends it", async () => {
    mount([FIVE_GATES[0]!]);
    const gate = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    gate.focus();

    expect(within(gate).queryByLabelText("Note")).toBeNull();
    fireEvent.keyDown(gate, { key: "Enter", code: "Enter", shiftKey: true });

    const note = within(gate).getByLabelText("Note");
    // #238: `human.answered` has no field for it, so the card must not let a person think
    // the workflow will see it.
    expect(within(gate).getByText(/recorded with the answer in the run/)).toBeTruthy();
    expect(document.activeElement).toBe(note);

    fireEvent.change(note, { target: { value: "checked with the release manager" } });
    fireEvent.keyDown(note, { key: "Enter" });

    await waitFor(() => expect(fake.calls.some((c) => c.method === "inputs.answer")).toBe(true));
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({
      optionId: "approve",
      note: "checked with the release manager",
    });
  });

  it("submits a written note when ⇧Enter is pressed again rather than reopening the field", async () => {
    mount([FIVE_GATES[0]!]);
    const gate = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    gate.focus();
    fireEvent.keyDown(gate, { key: "Enter", code: "Enter", shiftKey: true });
    fireEvent.change(within(gate).getByLabelText("Note"), { target: { value: "on the record" } });

    gate.focus();
    fireEvent.keyDown(gate, { key: "Enter", code: "Enter", shiftKey: true });
    await waitFor(() => expect(fake.calls.some((c) => c.method === "inputs.answer")).toBe(true));
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({ note: "on the record" });
  });
});

describe("a permission ask naming who it blocks", () => {
  it("says the agent and its host off the ask, and the run only when there is no agent", async () => {
    mount([PERMISSION_ASK]);
    const card = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    // `OpenInputView.agent` (protocol 1.6, #248) - what makes "always allow" sizeable.
    expect(within(card).getByText("claude")).toBeTruthy();
    expect(card.textContent).toContain("build-box");

    cleanup();
    const { agent: _agent, ...anonymous } = PERMISSION_ASK;
    mount([anonymous]);
    const fallback = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    expect(within(fallback).getByText("release 1")).toBeTruthy();
    expect(fallback.textContent).not.toContain("build-box");
  });
});

describe("a question with no options", () => {
  it("takes free text, and will not send an empty answer", async () => {
    const question: OpenInputView = { ...FIVE_GATES[0]!, id: "q-1", question: "Which branch?", options: [] };
    mount([question]);
    const gate = await screen.findByRole("region", { name: cardName("gate", "Which branch?") });

    const answer = within(gate).getByRole("button", { name: /^Answer/ });
    expect(answer.getAttribute("aria-disabled")).toBe("true");
    expect(answer.getAttribute("title")).toBe("type an answer first");

    fireEvent.change(within(gate).getByLabelText("Answer"), { target: { value: "release/4" } });
    fireEvent.click(within(gate).getByRole("button", { name: /^Answer/ }));

    await waitFor(() => expect(fake.calls.some((c) => c.method === "inputs.answer")).toBe(true));
    // The free text *is* the answer, which is what the protocol says of an empty option list.
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({ optionId: "release/4" });
  });
});

describe("moving between cards", () => {
  it("moves with J and K and stops at both ends", async () => {
    mount([FIVE_GATES[0]!, FIVE_GATES[1]!, FIVE_GATES[2]!]);
    const first = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    first.focus();

    fireEvent.keyDown(document.activeElement!, { key: "j", code: "KeyJ" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(cardName("gate", "Ship release 2?"));
    fireEvent.keyDown(document.activeElement!, { key: "k", code: "KeyK" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(cardName("gate", "Ship release 1?"));
    // The top is the top: `K` on the first card is not a wrap to the last.
    fireEvent.keyDown(document.activeElement!, { key: "k", code: "KeyK" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(cardName("gate", "Ship release 1?"));
  });

  it("registers G and opens the run only when there is somewhere to open it", async () => {
    const opened: string[] = [];
    mount([FIVE_GATES[0]!], { onOpenRun: (id) => opened.push(id) });
    const gate = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    gate.focus();

    expect(h.keyboard.list().some((s) => s.scope === "card" && s.key === "G")).toBe(true);
    fireEvent.keyDown(gate, { key: "g", code: "KeyG" });
    expect(opened).toEqual(["run-1"]);
  });
});

/**
 * `Enter` pressed the way a browser presses it: the keydown goes to the focused element, and
 * when nothing prevented it a focused button is clicked. happy-dom does not activate a button
 * from a key, so the test does what the platform would — which is exactly the step the
 * keyboard map's `preventDefault` used to take away.
 */
function pressEnter(target: HTMLElement): void {
  const notPrevented = fireEvent.keyDown(target, { key: "Enter", code: "Enter" });
  if (notPrevented && target.tagName === "BUTTON") fireEvent.click(target);
}

const answers = (): Record<string, unknown>[] =>
  fake.calls.filter((c) => c.method === "inputs.answer").map((c) => c.params as Record<string, unknown>);

describe("Enter on a control inside a card is the control's", () => {
  it("selects Deny when Deny has focus, sends nothing, and Answer then sends deny", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    // "2 Deny": never on `1`, but it has a digit. Case matters — "Always deny" is the other one.
    const deny = within(ask).getByRole("button", { name: /Deny$/ });

    // Tabbed to: the press lands on the option, and the option is what it presses.
    deny.focus();
    pressEnter(deny);
    expect(deny.getAttribute("aria-pressed")).toBe("true");
    expect(answers()).toEqual([]);

    const answer = within(ask).getByRole("button", { name: /^Answer/ });
    answer.focus();
    pressEnter(answer);
    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]).toMatchObject({ requestId: "ask-1", optionId: "deny" });
    expect(answers()[0]!.always).toBeUndefined();
  });

  it("sends Always deny's own answer when Always deny has focus, never the card's plain one", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    const always = within(ask).getByRole("button", { name: "Always deny" });

    always.focus();
    pressEnter(always);
    // Enter opens the rule review rather than saving anything (#702).
    expect(answers()).toEqual([]);
    const save = within(ask).getByRole("button", { name: "Save rule and deny" });
    save.focus();
    pressEnter(save);

    await waitFor(() => expect(answers()).toHaveLength(1));
    // The button's request, with the standing rule it names — not `Enter` on the card, which
    // is the selected Allow once and no rule at all. And it denies this call too: the selected
    // option is Allow once, so it answers with the one option marked destructive.
    expect(answers()[0]).toMatchObject({ optionId: "deny", always: { decision: "deny" } });
  });

  it("denies, with a deny rule, from the keyboard alone: Deny, then Always deny", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });

    const deny = within(ask).getByRole("button", { name: /Deny$/ });
    deny.focus();
    pressEnter(deny);
    const always = within(ask).getByRole("button", { name: "Always deny" });
    always.focus();
    pressEnter(always);
    const save = within(ask).getByRole("button", { name: "Save rule and deny" });
    save.focus();
    pressEnter(save);

    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]).toMatchObject({ optionId: "deny", always: { decision: "deny" } });
  });

  it("still answers with the selected option when Enter is pressed on the card itself", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    ask.focus();
    pressEnter(ask);

    await waitFor(() => expect(answers()).toHaveLength(1));
    // The first safe option, which is what the card opens with selected.
    expect(answers()[0]).toMatchObject({ optionId: "allow" });
    expect(answers()[0]!.always).toBeUndefined();
  });
});

describe("an always-button answers this call the same way as its rule", () => {
  it("Always deny with Allow once selected denies this call, never lets it through", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    // Allow once is what the card opens with selected.
    expect(
      within(ask)
        .getByRole("button", { name: /Allow once$/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(ask).getByRole("button", { name: "Always deny" }));
    fireEvent.click(within(ask).getByRole("button", { name: "Save rule and deny" }));
    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]).toMatchObject({ optionId: "deny", always: { decision: "deny" } });
  });

  it("Always allow with Deny selected allows this call", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    fireEvent.click(within(ask).getByRole("button", { name: /Deny$/ }));
    fireEvent.click(within(ask).getByRole("button", { name: "Always allow" }));
    fireEvent.click(within(ask).getByRole("button", { name: "Save rule and allow" }));
    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]).toMatchObject({ optionId: "allow", always: { decision: "allow" } });
  });

  it("says why Always deny cannot go when the ask marks no option as a rejection", async () => {
    const unmarked: OpenInputView = {
      ...PERMISSION_ASK,
      options: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
    mount([unmarked]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    const deny = within(ask).getByRole("button", { name: "Always deny" });
    expect(deny.getAttribute("aria-disabled")).toBe("true");
    expect(deny.getAttribute("title")).toBe("this ask names no deny option");
    fireEvent.click(deny);
    expect(answers()).toEqual([]);
    // Allowing still has an unambiguous option to answer with.
    fireEvent.click(within(ask).getByRole("button", { name: "Always allow" }));
    fireEvent.click(within(ask).getByRole("button", { name: "Save rule and allow" }));
    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]).toMatchObject({ optionId: "allow", always: { decision: "allow" } });
  });
});

describe("an always-button shows the rule before anything is saved (#702)", () => {
  it("shows the exact rule, whose it is and its lifetime, and sends the chosen lifetime only on save", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    fireEvent.click(within(ask).getByRole("button", { name: "Always allow" }));
    const review = within(ask).getByRole("region", { name: "Standing allow rule" });
    expect(within(review).getByRole("list", { name: "Rules to save" }).textContent).toBe(
      "allow execute matching ^rm -rf build/$",
    );
    expect(review.textContent).toContain("for claude");
    // The default lifetime is bounded; it is pressed, and nothing has been sent yet.
    expect(within(review).getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe("true");
    expect(answers()).toEqual([]);

    fireEvent.click(within(review).getByRole("button", { name: "1 hour" }));
    fireEvent.click(within(review).getByRole("button", { name: "Save rule and allow" }));
    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]).toMatchObject({ optionId: "allow", always: { decision: "allow", durationMs: 3_600_000 } });
  });

  it("sends no duration for Until removed", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    fireEvent.click(within(ask).getByRole("button", { name: "Always allow" }));
    fireEvent.click(within(ask).getByRole("button", { name: "Until removed" }));
    fireEvent.click(within(ask).getByRole("button", { name: "Save rule and allow" }));
    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]!.always).toEqual({ decision: "allow" });
  });

  it("cancels without sending anything", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    fireEvent.click(within(ask).getByRole("button", { name: "Always deny" }));
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(within(ask).queryByRole("region", { name: "Standing deny rule" })).toBeNull();
    expect(answers()).toEqual([]);
  });

  it("offers nothing to save when the daemon refused to derive a rule, and says why", async () => {
    mount([
      {
        ...PERMISSION_ASK,
        standing: {
          allow: { refused: { reason: "outside-workspace", detail: "/etc/hosts is not inside the workspace" } },
          deny: { refused: { reason: "outside-workspace", detail: "/etc/hosts is not inside the workspace" } },
        },
      },
    ]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    fireEvent.click(within(ask).getByRole("button", { name: "Always allow" }));
    const review = within(ask).getByRole("region", { name: "Standing allow rule" });
    expect(review.textContent).toContain("/etc/hosts is not inside the workspace");
    const save = within(review).getByRole("button", { name: "Save rule and allow" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(save);
    expect(answers()).toEqual([]);
  });

  it("offers nothing to save against a daemon that sends no preview", async () => {
    const { standing: _none, ...older } = PERMISSION_ASK;
    mount([older]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    fireEvent.click(within(ask).getByRole("button", { name: "Always allow" }));
    const save = within(ask).getByRole("button", { name: "Save rule and allow" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.getAttribute("title")).toContain("protocol 2.8");
  });
});

describe("a push while a person is working in a card", () => {
  let seq = 200;
  const envelope = (method: string, params: Record<string, unknown>): NotificationMessage => ({
    kind: "notification",
    method,
    params: { subscriptionId: "sub-1", seq: seq++, at: INPUTS_AS_OF, ...params },
  });
  const answeredElsewhere = (gate: OpenInputView): NotificationMessage =>
    envelope("input.answered", {
      runId: gate.runId,
      stepRunId: gate.stepRunId,
      requestId: gate.id,
      answer: gate.kind === "permission" ? "allow" : "approve",
    });
  const label = (): string | null | undefined => document.activeElement?.getAttribute("aria-label");

  it("leaves focus in a half-typed note when a permission ask arrives above the card", async () => {
    const served: OpenInputView[] = [FIVE_GATES[0]!, FIVE_GATES[1]!, FIVE_GATES[2]!];
    mount(served);
    const third = await screen.findByRole("region", { name: cardName("gate", "Ship release 3?") });
    // In `act`, so the card has registered its keys by the time the next key arrives — the
    // separate keypress a person makes, with a frame between the two.
    act(() => third.focus());
    fireEvent.keyDown(third, { key: "Enter", code: "Enter", shiftKey: true });
    const note = within(third).getByLabelText<HTMLInputElement>("Note");
    fireEvent.change(note, { target: { value: "half a thou" } });
    expect(document.activeElement).toBe(note);

    // A permission ask sorts first, so every card below it moves down one place.
    served.push(PERMISSION_ASK);
    fake.notify(
      envelope("input.opened", {
        runId: PERMISSION_ASK.runId,
        stepRunId: PERMISSION_ASK.stepRunId,
        requestId: PERMISSION_ASK.id,
        kind: "permission",
        question: PERMISSION_ASK.question,
        options: PERMISSION_ASK.options,
      }),
    );
    await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });

    // Still in the note, still holding what was typed: the next letter is a letter.
    await waitFor(() => expect(document.activeElement).toBe(note));
    expect(note.value).toBe("half a thou");
    expect(answers()).toEqual([]);
  });

  it("keeps focus and the card's keys on the card a person is on when a gate above it is answered elsewhere", async () => {
    mount([FIVE_GATES[0]!, FIVE_GATES[1]!, FIVE_GATES[2]!, FIVE_GATES[3]!]);
    const third = await screen.findByRole("region", { name: cardName("gate", "Ship release 3?") });
    act(() => third.focus());

    fake.notify(answeredElsewhere(FIVE_GATES[0]!));
    await waitFor(() => expect(screen.queryByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeNull());

    // Not the card that slid into index 2, which is release 4.
    await waitFor(() => expect(label()).toBe(cardName("gate", "Ship release 3?")));
    fireEvent.keyDown(document.activeElement!, { key: "2", code: "Digit2" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]).toMatchObject({ requestId: "gate-3", optionId: "hold" });
  });

  it("moves focus to the card that takes its place only when the focused card itself leaves", async () => {
    mount([FIVE_GATES[0]!, FIVE_GATES[1]!, FIVE_GATES[2]!]);
    const second = await screen.findByRole("region", { name: cardName("gate", "Ship release 2?") });
    act(() => second.focus());

    fake.notify(answeredElsewhere(FIVE_GATES[1]!));
    await waitFor(() => expect(screen.queryByRole("region", { name: cardName("gate", "Ship release 2?") })).toBeNull());
    // Focus went with the card, so it lands on the neighbour, never on the page body.
    await waitFor(() => expect(label()).toBe(cardName("gate", "Ship release 3?")));
  });

  it.each([FIVE_GATES[0]!, PERMISSION_ASK])(
    "returns focus to the named Attention region when the final card ($kind) leaves holding a control's focus",
    async (input) => {
      mount([input]);
      const last = await screen.findByRole("region", {
        name: cardName(input.kind === "permission" ? "permission" : "gate", input.question),
      });
      act(() =>
        within(last)
          .getByRole("button", { name: /^Answer/ })
          .focus(),
      );

      fake.notify(answeredElsewhere(input));
      await waitFor(() => expect(last.isConnected).toBe(false));

      expect(document.activeElement).toBe(screen.getByTestId("attention"));
      const attention = screen.getByRole("region", { name: "Attention" });
      expect(attention.tabIndex).toBe(-1);
      expect(within(attention).getByText("Nothing needs you")).toBeTruthy();
      expect(answers()).toEqual([]);
    },
  );

  it("moves focus to the preceding card when the final card in a multi-card list leaves", async () => {
    mount([FIVE_GATES[0]!, FIVE_GATES[1]!]);
    const first = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    const last = screen.getByRole("region", { name: cardName("gate", "Ship release 2?") });
    act(() =>
      within(last)
        .getByRole("button", { name: /^Answer/ })
        .focus(),
    );

    fake.notify(answeredElsewhere(FIVE_GATES[1]!));
    await waitFor(() => expect(last.isConnected).toBe(false));
    expect(document.activeElement).toBe(first);
    expect(answers()).toEqual([]);
  });

  it("keeps explicit user focus outside Attention when the final card leaves during an answer", async () => {
    mount([FIVE_GATES[0]!]);
    const last = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    fake.script({
      "inputs.answer": (params) => ({
        ok: true,
        result: { requestId: params.requestId, runId: "run-1", answer: params.optionId, asOf: INPUTS_AS_OF },
      }),
    });
    const release = fake.hold("inputs.answer");
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Enter", code: "Enter" });
    await within(last).findByRole("button", { name: "Answering…" });

    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    try {
      act(() => elsewhere.focus());
      release();
      await waitFor(() => expect(last.isConnected).toBe(false));
      expect(document.activeElement).toBe(elsewhere);
      expect(answers()).toHaveLength(1);
      expect(answers()[0]).toMatchObject({ requestId: "gate-1", optionId: "approve" });
    } finally {
      elsewhere.remove();
    }
  });

  it("does not take focus back to the list when the focused card leaves after the person left it", async () => {
    mount([FIVE_GATES[0]!, FIVE_GATES[1]!]);
    const first = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    first.focus();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();

    fake.notify(answeredElsewhere(FIVE_GATES[0]!));
    await waitFor(() => expect(screen.queryByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeNull());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe("an answer in flight", () => {
  it("says so on the control and does not send a second one", async () => {
    mount([FIVE_GATES[0]!]);
    const gate = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    const release = fake.hold("inputs.answer");

    gate.focus();
    fireEvent.keyDown(gate, { key: "Enter", code: "Enter" });
    await screen.findByRole("button", { name: "Answering…" });

    fireEvent.keyDown(gate, { key: "Enter", code: "Enter" });
    const answer = within(gate).getByRole("button", { name: "Answering…" });
    expect(answer.getAttribute("title")).toBe("this answer is still with the daemon");

    release();
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "inputs.answer")).toHaveLength(1));
  });
});

describe("what the surface is looking at", () => {
  it("says it is loading, then says what it could not load, and can be asked again", async () => {
    const release = fake.hold("inputs.list");
    mount([]);
    expect(await screen.findByText("Loading what needs you")).toBeTruthy();
    release();

    cleanup();
    fake.fail("inputs.list", { code: "STORE_UNAVAILABLE", message: "no store here" });
    renderHost();
    expect(await screen.findByText("Could not load the attention list")).toBeTruthy();
    expect(screen.getByText(/STORE_UNAVAILABLE/)).toBeTruthy();

    fake.script({
      "inputs.list": () => ({ ok: true, result: { inputs: [FIVE_GATES[0]!], waiting: 1, asOf: INPUTS_AS_OF } }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeTruthy();
  });

  it("calls a daemon that never answered disconnected rather than broken", async () => {
    fake.fail("inputs.list", { code: "AGENT_TRANSPORT", message: "connection refused" });
    renderHost({ connection: "disconnected" });
    expect(await screen.findByText("No daemon to ask")).toBeTruthy();
  });

  it("says the list is last-known when the connection is not live", async () => {
    mount([FIVE_GATES[0]!], { connection: "reconnecting" });
    expect(await screen.findByText(/last the daemon said/)).toBeTruthy();
  });

  it("still shows the gates when the run list will not answer", async () => {
    mount([FIVE_GATES[0]!]);
    fake.fail("runs.list", { code: "STORE_UNAVAILABLE", message: "no run list" });
    // The gates are the thing a person came for; the failures are the other half of the
    // screen and their absence is not a reason to withhold them.
    expect(await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Failed runs" })).toBeNull();
  });
});

describe("runs that fail while the surface is open", () => {
  let sequence = 100;
  const changed = (runId: string, status: string): NotificationMessage => ({
    kind: "notification",
    method: "run.changed",
    params: { subscriptionId: "sub-1", runId, seq: sequence++, at: AS_OF, status, event: `run.${status}` },
  });

  it("resolves a newly failed run to a row, and drops it when it is re-driven", async () => {
    mount([PERMISSION_ASK]);
    const list = await screen.findByRole("listbox", { name: "Failed runs" });
    expect(within(list).queryByText("Document the rollout")).toBeNull();

    // `run-gate` is a run the failures list has never seen; the notification carries no
    // name, so it takes one `runs.get` to become a row.
    fake.notify(changed("run-gate", "failed"));
    await waitFor(() => expect(fake.calls.some((c) => c.method === "runs.get")).toBe(true));
    expect(await within(list).findByText("Document the rollout")).toBeTruthy();

    fake.notify(changed("run-gate", "running"));
    await waitFor(() => expect(within(list).queryByText("Document the rollout")).toBeNull());
  });

  it("asks once for a run that changes twice before the answer lands", async () => {
    mount([PERMISSION_ASK]);
    await screen.findByRole("listbox", { name: "Failed runs" });
    const release = fake.hold("runs.get");

    fake.notify(changed("run-gate", "failed"));
    fake.notify(changed("run-gate", "failed"));
    release();

    await waitFor(() => expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1));
  });
});

describe("resuming a run from the card", () => {
  it("re-drives it and says what it settled as", async () => {
    mount([FIVE_GATES[0]!]);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    fake.script({
      "runs.resume": ({ runId }) => ({
        ok: true,
        result: {
          run: {
            id: runId,
            name: "release 1",
            workflowId: "release",
            workflowVersion: "1",
            status: "succeeded" as const,
            createdAt: AS_OF,
          },
          asOf: AS_OF,
        },
      }),
    });

    const resume = h.keyboard.list().find((s) => s.label.startsWith("Resume the run"))!;
    expect(resume.key).toBeUndefined();
    resume.action();

    await waitFor(() => expect(fake.calls.some((c) => c.method === "runs.resume")).toBe(true));
    // `runs.resume` answers when the run parks again, so the sentence is a settled status.
    expect(await screen.findByText(/succeeded\./)).toBeTruthy();
  });
});
