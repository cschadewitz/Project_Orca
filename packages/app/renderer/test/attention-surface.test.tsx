// @vitest-environment happy-dom
/**
 * The Attention surface, through the chrome that mounts it: answering, the one count, the
 * two ways a control refuses, and what the main process is told to notify about.
 *
 * Mounted with `renderChrome` rather than on its own, because three of the things under
 * test are only true of the whole app — the title bar and the sidebar carry the same number
 * the surface does, and the command palette is a view of the same keyboard map the cards
 * register into. Attention is the app's default surface, so the chrome comes up on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { NotificationMessage, OpenInputView, RunSummaryView } from "@orca/protocol";
import { ANNOUNCER_ATTRIBUTE } from "../src/a11y/announcer.js";
import { cardName } from "../src/attention/answer-card.js";
import { RUNS } from "./fixtures.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { DESTRUCTIVE_GATE, FIVE_GATES, INPUTS_AS_OF, PERMISSION_ASK, UNLOADED_GATE } from "./fixtures-inputs.js";

const teardown: (() => void)[] = [];
let fake: FakeBridge;
let h: Harness;

/** `inputs.list` answering with exactly these, the way the daemon would. */
function serve(inputs: readonly OpenInputView[]): void {
  fake.script({
    "inputs.list": (params) => {
      const matching = inputs.filter((i) => params.runId === undefined || i.runId === params.runId);
      return { ok: true, result: { inputs: [...matching], waiting: matching.length, asOf: INPUTS_AS_OF } };
    },
  });
}

function mount(inputs: readonly OpenInputView[]): void {
  serve(inputs);
  renderChrome(h);
}

/* A card's accessible name is the tier's word and then the question — "gate, Ship release
   1?" (#167) — so a test that knows only the question asks for a name that ends in it. */
const card = (question: string): HTMLElement => screen.getByRole("region", { name: endingIn(question) });
const endingIn = (question: string): RegExp => new RegExp(`${question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const answerButton = (question: string): HTMLElement => within(card(question)).getByRole("button", { name: /^Answer/ });

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
  vi.restoreAllMocks();
});

describe("clearing what is waiting", () => {
  it("clears five gates in five keystrokes, and the count goes five to zero", async () => {
    const open = new Set(FIVE_GATES.map((g) => g.id));
    fake.script({
      "inputs.list": () => {
        const inputs = FIVE_GATES.filter((g) => open.has(g.id));
        return { ok: true, result: { inputs, waiting: inputs.length, asOf: INPUTS_AS_OF } };
      },
      "inputs.answer": (params) => {
        open.delete(params.requestId);
        return {
          ok: true,
          result: { requestId: params.requestId, runId: "run-1", answer: params.optionId, asOf: INPUTS_AS_OF },
        };
      },
    });
    renderChrome(h);

    // The one number, in both places it appears, before anything is answered.
    expect(await screen.findByRole("button", { name: /5\swaiting/ })).toBeTruthy();
    // The sidebar's Attention row carries the same number, which is why its accessible
    // name is "Attention 5" and not "Attention".
    expect(screen.getByRole("button", { name: "Attention 5" })).toBeTruthy();

    const first = card("Ship release 1?");
    first.focus();

    for (const n of [1, 2, 3, 4, 5]) {
      // `Enter` on the focused card answers with the option that is selected, which is the
      // first non-destructive one — no digit needed, and no mouse.
      fireEvent.keyDown(document.activeElement!, { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: cardName("gate", `Ship release ${n}?`) })).toBeNull(),
      );
      // Each answer focuses the surviving neighbour; the final answer returns focus to
      // the Attention region, which remains mounted with the empty state.
      if (n < 5) {
        await waitFor(() =>
          expect(document.activeElement?.getAttribute("aria-label")).toBe(cardName("gate", `Ship release ${n + 1}?`)),
        );
      } else {
        expect(document.activeElement).toBe(screen.getByRole("region", { name: "Attention" }));
      }
    }

    expect(fake.calls.filter((c) => c.method === "inputs.answer")).toHaveLength(5);
    // Five to zero without navigating: the surface is still the one on screen.
    await waitFor(() => expect(screen.queryByRole("button", { name: /waiting/ })).toBeNull());
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
  });

  it("answers with the digit that was pressed, and sends the option's id and not its label", async () => {
    mount([FIVE_GATES[0]!]);
    const first = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    first.focus();

    fireEvent.keyDown(first, { key: "2", code: "Digit2" });
    fireEvent.keyDown(first, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(fake.calls.some((c) => c.method === "inputs.answer")).toBe(true));
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({
      requestId: "gate-1",
      optionId: "hold",
    });
  });

  it("keeps the ask when the daemon refuses the write, and says why", async () => {
    mount([FIVE_GATES[0]!]);
    fake.fail("inputs.answer", { code: "RUN_LEASED_ELSEWHERE", message: "run-1 is held by pid 811 on build-2" });
    const first = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });

    fireEvent.click(within(first).getByRole("button", { name: /^Answer/ }));

    // Said on the card, beside the control that was pressed — and said once.
    expect(await within(card("Ship release 1?")).findByText(/RUN_LEASED_ELSEWHERE/)).toBeTruthy();
    expect(screen.getAllByText(/RUN_LEASED_ELSEWHERE/)).toHaveLength(1);
    // Still there to answer again: a refused write is not a lost keystroke.
    expect(card("Ship release 1?")).toBeTruthy();
  });
});

describe("the destructive option", () => {
  it("is never bound to 1 and is never what Enter would send", async () => {
    mount([DESTRUCTIVE_GATE]);
    const gate = await screen.findByRole("region", { name: /Roll back\?$/ });

    const digits = [...gate.querySelectorAll(".orca-kbd")].map((k) => k.textContent);
    const labels = [...gate.querySelectorAll(".orca-btn")].map((b) => b.textContent ?? "");
    expect(digits).toEqual(["1", "2"]);
    expect(labels[0]).toContain("Retry the step");
    expect(labels[1]).toContain("Roll back");

    gate.focus();
    fireEvent.keyDown(gate, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(fake.calls.some((c) => c.method === "inputs.answer")).toBe(true));
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({ optionId: "retry" });
  });
});

describe("what a person is not allowed to approve blind", () => {
  it("disables the options with the reason when the artifacts did not load", async () => {
    mount([UNLOADED_GATE]);
    const gate = await screen.findByRole("region", { name: cardName("gate", "Approve the spec?") });

    const approve = within(gate).getByRole("button", { name: /Approve$/ });
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    expect(approve.getAttribute("title")).toContain("have not loaded");
    expect(within(gate).getByText(/have not loaded/)).toBeTruthy();
  });

  it("disables every answer with the connection's own reason when it cannot write", async () => {
    mount([FIVE_GATES[0]!]);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });

    fake.connect({ state: "disconnected", since: INPUTS_AS_OF });

    await waitFor(() => {
      const answer = answerButton("Ship release 1?");
      expect(answer.getAttribute("aria-disabled")).toBe("true");
      // `useWritability()`'s sentence, verbatim: a control never composes its own.
      expect(answer.getAttribute("title")).toBe("no daemon is answering");
    });

    // And a daemon that simply does not offer control says a different thing, not an error.
    fake.connect({ state: "live", since: INPUTS_AS_OF, capabilities: ["runs.read"] });
    await waitFor(() =>
      expect(answerButton("Ship release 1?").getAttribute("title")).toBe("this daemon offers no run control"),
    );
  });
});

describe("the permission card", () => {
  it("shows the command verbatim and offers always, which promises only what was written", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    expect(within(ask).getByText("rm -rf build/")).toBeTruthy();

    fake.script({
      "inputs.answer": (params) => ({
        ok: true,
        result: {
          requestId: params.requestId,
          runId: "run-1",
          answer: params.optionId,
          permission: {
            file: "/work/orca/orca.permissions.json",
            agentId: "claude",
            rules: [{ match: { kind: "execute" as const, path: "build" }, decision: "allow" as const }],
            added: [{ match: { kind: "execute" as const, path: "build" }, decision: "allow" as const }],
            alreadyPresent: [],
          },
          asOf: INPUTS_AS_OF,
        },
      }),
    });

    fireEvent.click(within(ask).getByRole("button", { name: "Always allow" }));
    fireEvent.click(within(ask).getByRole("button", { name: "Save rule and allow" }));

    expect(await screen.findByText(/ORCA will not ask again/)).toBeTruthy();
    // The client says which way the rule goes; ORCA does not read the option id and guess.
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({
      optionId: "allow",
      always: { decision: "allow" },
    });
  });

  it("does not promise when the daemon refused to derive a rule", async () => {
    mount([PERMISSION_ASK]);
    const ask = await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });
    fake.script({
      "inputs.answer": (params) => ({
        ok: true,
        result: {
          requestId: params.requestId,
          runId: "run-1",
          answer: params.optionId,
          permission: {
            file: "/work/orca/orca.permissions.json",
            agentId: "claude",
            rules: [],
            added: [],
            alreadyPresent: [],
            refused: { reason: "the ask named no tool", detail: "nothing to match on" },
          },
          asOf: INPUTS_AS_OF,
        },
      }),
    });

    fireEvent.click(within(ask).getByRole("button", { name: "Always deny" }));
    fireEvent.click(within(ask).getByRole("button", { name: "Save rule and deny" }));
    expect(await screen.findByText(/ORCA will ask again/)).toBeTruthy();
  });
});

describe("the push stream", () => {
  const envelope = (method: string, params: Record<string, unknown>): NotificationMessage => ({
    kind: "notification",
    method,
    params: { subscriptionId: "sub-1", seq: 7, at: INPUTS_AS_OF, ...params },
  });

  it("resolves an ask it has never seen with one scoped read, and counts it", async () => {
    const served: OpenInputView[] = [];
    serve(served);
    renderChrome(h);
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();

    served.push(FIVE_GATES[0]!);
    fake.notify(
      envelope("input.opened", {
        runId: "run-1",
        stepRunId: "s-gate-1",
        requestId: "gate-1",
        kind: "decision",
        question: "Ship release 1?",
        options: FIVE_GATES[0]!.options,
      }),
    );

    expect(await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeTruthy();
    // One call, scoped to the run — not a re-read of the whole list.
    const scoped = () =>
      fake.calls.filter((c) => c.method === "inputs.list" && (c.params as { runId?: string }).runId !== undefined);
    expect(scoped()).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /1\swaiting/ })).toBeTruthy();

    // A second frame about the same ask asks nothing further.
    fake.notify(
      envelope("input.opened", {
        runId: "run-1",
        stepRunId: "s-gate-1",
        requestId: "gate-1",
        kind: "decision",
        question: "Ship release 1?",
        options: FIVE_GATES[0]!.options,
      }),
    );
    expect(scoped()).toHaveLength(1);
  });

  it("drops an ask answered somewhere else", async () => {
    mount([FIVE_GATES[0]!, FIVE_GATES[1]!]);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });

    fake.notify(
      envelope("input.answered", { runId: "run-1", stepRunId: "s-gate-1", requestId: "gate-1", answer: "approve" }),
    );

    await waitFor(() => expect(screen.queryByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeNull());
    expect(await screen.findByRole("button", { name: /1\swaiting/ })).toBeTruthy();
  });
});

describe("failed runs, below the waits", () => {
  it("lists them as rows with an identity of their own, and no duplicate keys", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    mount([FIVE_GATES[0]!]);

    const list = await screen.findByRole("listbox", { name: "Failed runs" });
    const rows = within(list).getAllByRole("option");
    // Row identity, not only row content: a virtualised list keyed by index renders the
    // right text and the wrong rows (the bug that reached CI in wave 2).
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("attention-failure-run-"))).toBe(true);
    expect(within(list).getByText("SSO rollout")).toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("what the landing screen says at zero (#256)", () => {
  /** `runs.list` answering from exactly these, honouring the status filter the hook sends. */
  function serveRuns(runs: readonly RunSummaryView[]): void {
    fake.script({
      "runs.list": (params) => {
        const wanted = params.status;
        const matching = runs.filter((r) => !wanted?.length || wanted.includes(r.status));
        return { ok: true, result: { runs: [...matching], total: matching.length, asOf: INPUTS_AS_OF } };
      },
    });
  }

  const RUNNING = RUNS.filter((r) => r.status === "running");
  const FAILED = RUNS.filter((r) => r.status === "failed");

  it("lists the running runs, rather than saying nothing needs you, when nothing waits and nothing failed", async () => {
    serve([]);
    serveRuns(RUNNING);
    renderChrome(h);

    const list = await screen.findByRole("listbox", { name: "Running runs" });
    const rows = within(list).getAllByRole("option");
    expect(rows).toHaveLength(RUNNING.length);
    expect(within(list).getByText("Add the SSO callback")).toBeTruthy();
    // The landing screen answers "what is happening" instead of "there is nothing".
    expect(screen.queryByText("Nothing needs you")).toBeNull();
    // Still nothing waiting, and the count says so in the daemon's own words.
    expect(screen.getByText("nothing waiting")).toBeTruthy();
    // Rows, not cards, and not a second opinion about what is in flight.
    expect(screen.queryByRole("region", { name: /^gate,/ })).toBeNull();
  });

  it("says nothing needs you when nothing is waiting, nothing failed and nothing is running", async () => {
    serve([]);
    serveRuns([]);
    renderChrome(h);

    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Running runs" })).toBeNull();
    expect(screen.queryByRole("listbox", { name: "Failed runs" })).toBeNull();
  });

  it("is unchanged when something has failed: the rows are the failures, and the running runs stay off", async () => {
    serve([]);
    serveRuns([...FAILED, ...RUNNING]);
    renderChrome(h);

    const list = await screen.findByRole("listbox", { name: "Failed runs" });
    expect(within(list).getByText("SSO rollout")).toBeTruthy();
    // One `VirtualList` per scope: the running list is never mounted beside this one, which
    // is what keeps both of them in `list` legal.
    expect(screen.queryByRole("listbox", { name: "Running runs" })).toBeNull();
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
  });

  it("opens a running run with Enter, and adds no live region and no second subscription", async () => {
    serve([]);
    serveRuns(RUNNING);
    renderChrome(h);
    const list = await screen.findByRole("listbox", { name: "Running runs" });

    // Still the app's one announcer, and the rows are not in it: a run that is merely
    // running is not something to say out loud (RULES.md rule 11).
    expect(document.querySelectorAll(`[${ANNOUNCER_ATTRIBUTE}]`)).toHaveLength(1);
    expect(list.closest("[aria-live]")).toBeNull();
    // One feed for the whole app, as #253 left it — the running runs are one more read on
    // the page, not a second opinion pushed to a second subscriber.
    expect(fake.subscribers).toBe(1);

    fireEvent.click(within(list).getAllByRole("option")[0]!);
    fireEvent.keyDown(list, { key: "Enter", code: "Enter" });

    // Each row opens its run: Attention is left behind for the run it named.
    await waitFor(() => expect(screen.queryByTestId("attention")).toBeNull());
  });
});

describe("what the main process is told", () => {
  it("sends the daemon's count and every open item, and re-sends when one is answered", async () => {
    const open = [PERMISSION_ASK, FIVE_GATES[0]!];
    mount(open);
    fake.script({
      "inputs.answer": (params) => {
        const at = open.findIndex((i) => i.id === params.requestId);
        if (at >= 0) open.splice(at, 1);
        return {
          ok: true,
          result: { requestId: params.requestId, runId: "run-1", answer: params.optionId, asOf: INPUTS_AS_OF },
        };
      },
    });
    await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });

    await waitFor(() => expect(fake.alerts.length).toBeGreaterThan(0));
    const sent = fake.alerts.at(-1)!;
    expect(sent.waiting).toBe(2);
    expect(sent.items.map((i) => i.tier)).toEqual(["permission", "gate", "failure"]);

    fireEvent.click(answerButton("Run a shell command?"));
    await waitFor(() => expect(fake.alerts.at(-1)!.waiting).toBe(1));
    expect(fake.alerts.at(-1)!.items.some((i) => i.id === "ask-1")).toBe(false);
  });
});

describe("a notification that was clicked", () => {
  it("opens Attention, wherever the person was", async () => {
    mount([FIVE_GATES[0]!]);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });

    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeNull());

    // The main process has already focused the window; this is the renderer's half. The
    // item on the activation is what #165 turns into the card's own deep link.
    fake.activate({
      item: {
        id: "gate-1",
        tier: "gate",
        title: "release 1 is waiting",
        body: "Ship release 1?",
        runId: "run-1",
        inputId: "gate-1",
        since: INPUTS_AS_OF,
      },
    });

    expect(await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeTruthy();
  });
});

describe("the keyboard map and the palette", () => {
  it("registers the card keys only while a card has focus", async () => {
    mount([FIVE_GATES[0]!]);
    const gate = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    const cardKeys = (): string[] =>
      h.keyboard
        .list()
        .filter((s) => s.scope === "card" && s.key !== undefined)
        .map((s) => s.key!);

    // `J` and `K` are the list's and are there as soon as there is a card to move to; the
    // digits, `Enter`, `⇧Enter` and `G` belong to whichever card has the keyboard. `G` is
    // among them now that the chrome passes `onOpenRun` — the route table gives it
    // somewhere to go (#165), and it is registered because it was passed, not by default.
    expect(cardKeys()).toEqual(expect.arrayContaining(["J", "K", "1", "2", "Enter", "Shift+Enter", "G"]));
    // One card holds them, not five: the slot is `card:1`, and a second registration of it
    // is the collision the duplicate-key throw exists to find.
    expect(cardKeys().filter((key) => key === "1")).toHaveLength(1);
    expect(gate).toBeTruthy();
  });

  it("lists the two keyless write commands, with no chip beside them", async () => {
    mount([FIVE_GATES[0]!]);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });

    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const row = within(palette).getByRole("option", { name: /Cancel the run this is waiting on/ });
    // #205: a command with no key is still a command. It is in the palette, and the palette
    // is the whole of how it is reached — so there is nothing to draw in the chip slot.
    expect(row.querySelector(".orca-kbd")).toBeNull();
    expect(within(palette).getByRole("option", { name: /Resume the run this is waiting on/ })).toBeTruthy();
  });

  it("cancels the run the focused card is waiting on, after the row has been confirmed", async () => {
    mount([FIVE_GATES[0]!]);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });

    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    // `mouseDown`, not `click`: the palette picks on mousedown so that the query field is
    // not blurred first (`command-palette.tsx`).
    fireEvent.mouseDown(within(palette).getByRole("option", { name: /Cancel the run this is waiting on/ }));

    /* Cancelling is destructive, so the first choice arms the row rather than running it
       (#178): the label becomes the confirmation and nothing has been sent. It names the run
       by its name and its id token, said as "run run-1" — never the raw id alone. */
    const armed = await within(palette).findByRole("option", {
      name: new RegExp(`Cancel ${FIVE_GATES[0]!.runName} run run-1 — confirm`),
    });
    expect(fake.calls.some((c) => c.method === "runs.cancel")).toBe(false);
    fireEvent.mouseDown(armed);

    await waitFor(() => expect(fake.calls.some((c) => c.method === "runs.cancel")).toBe(true));
    expect(fake.calls.find((c) => c.method === "runs.cancel")?.params).toMatchObject({ runId: "run-1" });
  });
});

describe("a palette row whose card moved while the palette was open", () => {
  let seq = 300;
  const envelope = (method: string, params: Record<string, unknown>): NotificationMessage => ({
    kind: "notification",
    method,
    params: { subscriptionId: "sub-1", seq: seq++, at: INPUTS_AS_OF, ...params },
  });
  const calls = (method: string): unknown[] => fake.calls.filter((c) => c.method === method).map((c) => c.params);

  async function openPaletteOn(question: string): Promise<HTMLElement> {
    (await screen.findByRole("region", { name: endingIn(question) })).focus();
    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    return screen.findByRole("dialog", { name: "Command palette" });
  }

  it("answers nothing, and says so, when the card it names was answered elsewhere", async () => {
    mount([FIVE_GATES[0]!, FIVE_GATES[1]!]);
    const palette = await openPaletteOn("Ship release 1?");
    const approve = within(palette).getByRole("option", { name: /^Answer Ship release 1\?: Approve/ });

    // Answered from the CLI while the palette was up: release 2 is now the first card.
    fake.notify(
      envelope("input.answered", { runId: "run-1", stepRunId: "s-gate-1", requestId: "gate-1", answer: "hold" }),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeNull());

    fireEvent.mouseDown(approve);
    expect(await screen.findByText(/Nothing was sent: "Ship release 1\?"/)).toBeTruthy();
    // Release 2 shares the option id, so a row that fell through to the current card would
    // have approved it.
    expect(calls("inputs.answer")).toEqual([]);
  });

  it("cancels the run it names, not the run of a permission ask that arrived above it", async () => {
    const served: OpenInputView[] = [FIVE_GATES[0]!];
    mount(served);
    const palette = await openPaletteOn("Ship release 1?");
    fireEvent.mouseDown(within(palette).getByRole("option", { name: /Cancel the run this is waiting on/ }));
    const armed = await within(palette).findByRole("option", { name: /Cancel release 1 run run-1 — confirm/ });

    // A permission ask on another run sorts first while the row is armed.
    const ask: OpenInputView = {
      ...PERMISSION_ASK,
      id: "ask-9",
      runId: "run-9",
      runName: "release 9",
      live: { ...PERMISSION_ASK.live!, target: { ...PERMISSION_ASK.live!.target, runId: "run-9", requestId: "ask-9" } },
    };
    served.push(ask);
    fake.notify(
      envelope("input.opened", {
        runId: "run-9",
        stepRunId: ask.stepRunId,
        requestId: "ask-9",
        kind: "permission",
        question: ask.question,
        options: ask.options,
      }),
    );
    await screen.findByRole("region", { name: cardName("permission", "Run a shell command?") });

    fireEvent.mouseDown(armed);
    await waitFor(() => expect(calls("runs.cancel")).toHaveLength(1));
    expect(calls("runs.cancel")[0]).toMatchObject({ runId: "run-1" });
  });

  it("cancels nothing when the card it names has gone", async () => {
    mount([FIVE_GATES[0]!, FIVE_GATES[1]!]);
    const palette = await openPaletteOn("Ship release 1?");
    fireEvent.mouseDown(within(palette).getByRole("option", { name: /Cancel the run this is waiting on/ }));
    const armed = await within(palette).findByRole("option", { name: /Cancel release 1 run run-1 — confirm/ });

    fake.notify(
      envelope("input.answered", { runId: "run-1", stepRunId: "s-gate-1", requestId: "gate-1", answer: "hold" }),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: cardName("gate", "Ship release 1?") })).toBeNull());

    fireEvent.mouseDown(armed);
    expect(await screen.findByText(/Nothing was sent/)).toBeTruthy();
    expect(calls("runs.cancel")).toEqual([]);
  });
});
