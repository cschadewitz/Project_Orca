// @vitest-environment happy-dom
/**
 * The Plan surface (#170), through the chrome that mounts it — the sidebar button a person
 * presses, or the `orca://item/<slug>` link that lands on it.
 *
 * What is asserted is what the issue's "done when" asks for and what the design decided:
 * every classification renders, the filters are the daemon's where the wire says they are,
 * the explanation is the scheduler's own words, the inspector shows a dependency's two
 * states, the journal pages backwards, and a push repaints only what moved. Geometry is
 * not asserted: happy-dom has no layout engine.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { rawTokens, SCHEDULE_PRESENTATION, THEMES } from "@orca/design";
import type { NotificationMessage, PlanJournalEntryView } from "@orca/protocol";
import { commandEntries } from "../src/palette/entries.js";
import { scheduleRowId } from "../src/plan/index.js";
import { AS_OF } from "./fixtures.js";
import { JOURNAL, PLAN_ID, PLAN_ITEMS } from "./fixtures-plan.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import { installDesignSystem, resolved, setTheme } from "./themes.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

beforeEach(() => {
  stubMatchMedia(1440);
});

afterEach(() => {
  cleanup();
  setTheme(undefined);
  while (teardown.length) teardown.pop()?.();
});

/** Mount the chrome, optionally on a URL, and go to Plan the way a person does. */
async function openPlan(options: { deepLink?: string; journalPage?: number } = {}): Promise<HTMLElement> {
  fake = installBridge(options.deepLink === undefined ? {} : { deepLink: options.deepLink });
  teardown.push(fake.install());
  // Before the chrome mounts: the journal's first page is read on mount, so a test that
  // wants a journal longer than one page has to say so before anything asks for it.
  if (options.journalPage !== undefined) pagedJournal(options.journalPage);
  h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
  if (options.deepLink === undefined) {
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
  }
  return screen.findByRole("listbox", { name: "Schedule" });
}

const rows = (table: HTMLElement): HTMLElement[] => within(table).getAllByRole("option");
const callsTo = (method: string): unknown[] => fake.calls.filter((call) => call.method === method).map((c) => c.params);

describe("the schedule table", () => {
  it("renders every item in the daemon's order, each classification as a glyph and a word", async () => {
    const table = await openPlan();

    // The order is `computeSchedule`'s — ready first and best first, then running,
    // waiting, held, unschedulable and the settled ones — and this list never re-sorts it.
    expect(rows(table).map((row) => row.id)).toEqual(PLAN_ITEMS.map((item) => scheduleRowId(item.id)));

    for (const item of PLAN_ITEMS) {
      const row = rows(table).find((candidate) => candidate.id === scheduleRowId(item.id))!;
      const text = row.textContent ?? "";
      expect(text).toContain(item.slug);
      expect(text).toContain(item.title);

      if (item.classification === "done" || item.classification === "failed") {
        // A settled item is an outcome, drawn as the run status that means the same.
        expect(text).toContain(item.classification === "done" ? "succeeded" : "failed");
      } else {
        const { word, glyph } = SCHEDULE_PRESENTATION[item.classification];
        // Word *and* glyph: a classification is never carried by its tint (rule 4).
        expect(text).toContain(word);
        expect(text).toContain(glyph);
      }
    }
  });

  it("shows the priority score with its first reason as the cell's title, and the claim as a link", async () => {
    const table = await openPlan();
    const api = rows(table).find((row) => row.id === scheduleRowId("wi-api"))!;

    expect(within(api).getByTitle("unblocks 2 items (auth-ui, auth-docs)").textContent).toBe("6.6");
    // The running item's claim names the run holding it.
    const metrics = rows(table).find((row) => row.id === scheduleRowId("wi-metrics"))!;
    expect(within(metrics).getByRole("button", { name: "run-metrics" })).toBeTruthy();
  });
});

describe("the sidebar's requests and filters", () => {
  it("sends classification to the daemon and applies the text locally, and the count says which", async () => {
    const table = await openPlan();
    expect(screen.getByText("9 items")).toBeTruthy();

    // Classification is an `items.list` parameter: the daemon applies it to the whole plan.
    fireEvent.click(screen.getByRole("button", { name: /^waiting on deps/ }));
    await waitFor(() => expect(callsTo("items.list").at(-1)).toEqual({ planId: PLAN_ID, classification: ["waiting"] }));
    await waitFor(() => expect(rows(screen.getByRole("listbox", { name: "Schedule" }))).toHaveLength(4));

    // The text half never reaches the daemon, and the count says so: "1 of 4 items".
    const before = callsTo("items.list").length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter work items" }), { target: { value: "auth-ui" } });
    await waitFor(() => expect(screen.getByText("1 of 4 items")).toBeTruthy());
    expect(callsTo("items.list")).toHaveLength(before);
    expect(table).toBeTruthy();
  });

  it("filters by request, and a second press clears it", async () => {
    await openPlan();
    fireEvent.click(screen.getByRole("button", { name: "req-1" }));
    await waitFor(() => expect(callsTo("items.list").at(-1)).toEqual({ planId: PLAN_ID, requestId: "req-1" }));

    fireEvent.click(screen.getByRole("button", { name: "req-1" }));
    await waitFor(() => expect(callsTo("items.list").at(-1)).toEqual({ planId: PLAN_ID }));
  });

  it("counts each classification from the plan's own counts, not from the rows on screen", async () => {
    await openPlan();
    // `plan.counts` is the schedule folded to seven numbers by the daemon; it does not
    // change when a filter narrows the table.
    expect(screen.getByRole("button", { name: "ready 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "waiting on deps 4" })).toBeTruthy();
  });
});

describe("the explanation", () => {
  it("opens in the app's one Menu and lists the scheduler's lines verbatim", async () => {
    const table = await openPlan();
    const crypto = rows(table).find((row) => row.id === scheduleRowId("wi-crypto"))!;

    fireEvent.click(within(crypto).getByRole("button", { name: "Why auth-crypto is held" }));
    const menu = await screen.findByRole("menu", { name: "Why auth-crypto is held" });

    await waitFor(() => expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(1));
    const lines = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    // `orca plan explain`'s output, word for word and in its order: the scheduler's own
    // account first, then the wave, then the risk line the CLI adds.
    expect(lines).toEqual([
      "auth-crypto: pending",
      "held: open critical risk key-leak exceeds the plan's appetite (high); accept or mitigate first",
      "why: exposed to critical risk: key-leak",
      "why: mitigates key-leak (critical)",
      "wave 1 of 2",
      "risk key-leak: open (L4 x I5)",
    ]);
    expect(callsTo("schedule.explain").at(-1)).toEqual({ planId: PLAN_ID, workItemId: "wi-crypto" });
  });

  it("names the cycle or the missing dependency for an item that cannot run", async () => {
    // The fixture's unschedulable case is `auth-legal`, waiting on something outside ORCA;
    // what matters is that the popover says *what* rather than that it is stuck.
    const table = await openPlan();
    const legal = rows(table).find((row) => row.id === scheduleRowId("wi-legal"))!;
    fireEvent.click(within(legal).getByRole("button", { name: "Why auth-legal is waiting" }));
    const menu = await screen.findByRole("menu", { name: "Why auth-legal is waiting" });
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toContain("waiting: waiting for external 'legal-review'"),
    );
  });

  it("opens on arrival when a link named the item", async () => {
    // "orca://item/auth-sso-epic — plan, that work item, explanation panel open."
    await openPlan({ deepLink: "orca://item/auth-api" });
    const menu = await screen.findByRole("menu", { name: "Why auth-api is ready" });
    expect(within(menu).getAllByRole("menuitem")[0]!.textContent).toBe("auth-api: pending (priority high)");
    // And the row it named is the selected one.
    const table = screen.getByRole("listbox", { name: "Schedule" });
    expect(table.getAttribute("aria-activedescendant")).toBe(scheduleRowId("wi-api"));
  });
});

describe("the inspector, in the docked panel", () => {
  it("shows a dependency's stored status and its live evaluation, and the risks that name the item", async () => {
    const table = await openPlan();
    fireEvent.click(rows(table).find((row) => row.id === scheduleRowId("wi-store"))!);

    const inspector = await screen.findByLabelText("Work item auth-store");
    const dependencies = within(inspector).getByLabelText("Dependencies");
    // The two facts the wire carries, said as two: what was written to the document, and
    // what `computeSchedule` decides against the plan as it stands now.
    await waitFor(() => expect(dependencies.textContent).toContain("recorded open"));
    expect(dependencies.textContent).toContain("now waiting: waiting for decision datastore");
    expect(dependencies.textContent).toContain("decision datastore");

    // The priority reasons are the scheduler's lines, not a paraphrase.
    fireEvent.click(
      rows(screen.getByRole("listbox", { name: "Schedule" })).find((r) => r.id === scheduleRowId("wi-api"))!,
    );
    const api = await screen.findByLabelText("Work item auth-api");
    expect(within(api).getByLabelText("Why it is in this position").textContent).toContain(
      "unblocks 2 items (auth-ui, auth-docs)",
    );
    await waitFor(() => expect(within(api).getByLabelText("Risks").textContent).toContain("vendor-slip"));
  });

  it("offers no write action: waive, release and the rest are the palette's", async () => {
    const table = await openPlan();
    fireEvent.click(rows(table).find((row) => row.id === scheduleRowId("wi-store"))!);
    const inspector = await screen.findByLabelText("Work item auth-store");
    for (const name of [/waive/i, /release/i, /start a run/i]) {
      expect(within(inspector).queryByRole("button", { name })).toBeNull();
    }
  });
});

/** A journal that is longer than one page, so the backward cursor has somewhere to go. */
function pagedJournal(size: number): void {
  fake.script({
    "journal.list": (params) => {
      const all: readonly PlanJournalEntryView[] = JOURNAL;
      const lastSeq = all[all.length - 1]!.seq;
      const window =
        params.before !== undefined
          ? all.filter((entry) => entry.seq < params.before!).slice(-size)
          : all.filter((entry) => params.after === undefined || entry.seq > params.after).slice(0, size);
      const first = window[0];
      const last = window[window.length - 1];
      return {
        ok: true,
        result: {
          entries: window,
          ...(last ? { nextCursor: last.seq } : {}),
          ...(first ? { prevCursor: first.seq } : {}),
          hasMore:
            params.before !== undefined
              ? first !== undefined && all.some((entry) => entry.seq < first.seq)
              : last !== undefined && all.some((entry) => entry.seq > last.seq),
          lastSeq,
          asOf: AS_OF,
        },
      };
    },
  });
}

describe("the journal", () => {
  async function goToJournal(size = 4): Promise<HTMLElement> {
    await openPlan({ journalPage: size });
    // The mode control on the object header, which is the new `ObjectHeader` variant.
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    return screen.findByRole("listbox", { name: "Plan journal" });
  }

  it("lands on the newest entries, newest first, each with its summary verbatim and its origin", async () => {
    const list = await goToJournal();
    await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(0));

    const first = within(list).getAllByRole("option")[0]!;
    // The newest entry: the daemon's own one-line rendering, and who did it.
    expect(first.textContent).toContain("dep-legal-external waived: not needed for the pilot");
    expect(first.textContent).toContain("human · daemon");
  });

  it("pages backwards with before, and folds the page in without duplicating it", async () => {
    const list = await goToJournal();
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(4));

    fireEvent.click(await screen.findByRole("button", { name: "Load earlier entries" }));
    await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(4));

    const seqs = within(list)
      .getAllByRole("option")
      .map((row) => row.id);
    // No repeats, and still newest first.
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe("plan-journal-10");
    expect(callsTo("journal.list").some((params) => (params as { before?: number }).before !== undefined)).toBe(true);
  });
});

/** One `plan.changed`, in the envelope the daemon sends it in. */
const planChanged = (kinds: string[], seq: number): NotificationMessage => ({
  kind: "notification",
  method: "plan.changed",
  params: { subscriptionId: "sub-1", planId: PLAN_ID, kinds, seq, at: "2026-03-01T09:00:20.000Z" },
});

describe("plan.changed", () => {
  it("re-reads the schedule for a schedule frame, only the journal for a journal frame, and a repeat for neither", async () => {
    await openPlan();
    await waitFor(() => expect(callsTo("items.list").length).toBe(1));
    const items = () => callsTo("items.list").length;
    const journal = () => callsTo("journal.list").length;
    const [itemsBefore, journalBefore] = [items(), journal()];

    await act(async () => {
      fake.notify(planChanged(["schedule"], 11));
    });
    await waitFor(() => expect(items()).toBe(itemsBefore + 1));
    expect(journal()).toBe(journalBefore);

    await act(async () => {
      fake.notify(planChanged(["journal"], 12));
    });
    await waitFor(() => expect(journal()).toBe(journalBefore + 1));
    expect(items()).toBe(itemsBefore + 1);

    /* A frame whose `seq` has already been folded is dropped: the daemon may repeat one,
       and repainting twice for one act is what `kinds` and `seq` exist to prevent. */
    const [itemsNow, journalNow] = [items(), journal()];
    await act(async () => {
      fake.notify(planChanged(["schedule", "journal"], 12));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(items()).toBe(itemsNow);
    expect(journal()).toBe(journalNow);
  });

  it("never polls: no read happens without a frame", async () => {
    await openPlan();
    await waitFor(() => expect(callsTo("items.list").length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callsTo("items.list")).toHaveLength(1);
  });
});

describe("the keyboard", () => {
  it("registers the surface's keys where the palette can list them", async () => {
    await openPlan();
    const labels = (): string[] =>
      commandEntries(h.keyboard.list(), "darwin", ["list", "plan-journal", "global"]).map((entry) => entry.label);

    // The one key this surface owns, and the table's movement keys — a shortcut that
    // skipped the registry would be one nobody could discover (AGENTS.md).
    expect(labels()).toContain("Explain the selected work item");
    expect(labels()).toContain("Next work item");

    /* The journal's are registered while the journal is what is on screen, in a scope of
       its own: what is in the map is what the person can reach right now. */
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    await screen.findByRole("listbox", { name: "Plan journal" });
    expect(labels()).toContain("Next entry");
  });

  it("explains the selected row on Enter", async () => {
    const table = await openPlan();
    fireEvent.keyDown(table, { key: "End", code: "End" });
    await waitFor(() => expect(table.getAttribute("aria-activedescendant")).toBeTruthy());
    fireEvent.keyDown(table, { key: "Enter", code: "Enter" });
    // The last row is `auth-legacy`, which failed; a settled item explains itself too.
    await screen.findByRole("menu", { name: "Why auth-legacy is failed" });
  });
});

describe("a daemon with no plan", () => {
  it("says so rather than showing an error, when the capability is absent", async () => {
    fake = installBridge({
      // A daemon that reads runs and nothing else: `plan.read` is a class of functionality
      // it does not offer, which is a state and not a failure.
      connection: { state: "live", since: AS_OF, capabilities: ["runs.read"] },
    });
    teardown.push(fake.install());
    h = harness();
    teardown.push(h.dispose);
    renderChrome(h);

    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    expect(await screen.findByText("This daemon serves no plan")).toBeTruthy();
    // Nothing was asked of it either.
    expect(callsTo("plans.list")).toHaveLength(0);
  });

  it("says a store with no plan in it is empty rather than broken", async () => {
    fake = installBridge();
    teardown.push(fake.install());
    fake.script({ "plans.list": () => ({ ok: true, result: { plans: [], asOf: AS_OF } }) });
    h = harness();
    teardown.push(h.dispose);
    renderChrome(h);

    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    expect(await screen.findByText("No plan in this store")).toBeTruthy();
  });
});

describe("both themes", () => {
  it("binds the badge's colour to the classification's tokens, not to a hex", async () => {
    const table = await openPlan();
    installDesignSystem();
    document.body.classList.add("orca");

    const badge = (slug: string, id: string): HTMLElement =>
      within(rows(table).find((row) => row.id === scheduleRowId(id))!).getByText(
        SCHEDULE_PRESENTATION[slug === "ready" ? "ready" : "held"].word,
      ).parentElement!;

    for (const theme of THEMES) {
      setTheme(theme);
      expect(resolved(badge("ready", "wi-api"), "color"), theme).toBe(
        rawTokens[theme]["status-succeeded"]!.toLowerCase(),
      );
      expect(resolved(badge("held", "wi-crypto"), "color"), theme).toBe(rawTokens[theme]["status-held"]!.toLowerCase());
    }
    document.body.classList.remove("orca");
  });
});
