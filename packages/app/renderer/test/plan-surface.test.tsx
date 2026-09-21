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
import { rawTokens, SCHEDULE_PRESENTATION, THEMES, WORK_ITEM_STATUS_PRESENTATION } from "@orca/design";
import type { NotificationMessage, PlanJournalEntryView } from "@orca/protocol";
import { commandEntries } from "../src/palette/entries.js";
import { scheduleRowId } from "../src/plan/index.js";
import { ITEMS_PAGE } from "../src/plan/use-plan.js";
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

  /**
   * The two columns #170's spec asks for and the surface shipped without: the **request**
   * the item was decomposed from, and the item's **own status**.
   *
   * The status is not the classification and the row must not let them be confused: the
   * classification is where the scheduler *put* the item and is the tinted badge with the
   * **why** on it; the status is what the item says about itself, in a plain chip with its
   * own word and glyph. `auth-api` is the case that proves they are two facts — it is
   * `pending` and classified `ready` at the same time.
   */
  it("carries the request and the item's own status, told apart from the classification", async () => {
    const table = await openPlan();
    // The sticky head is the substrate's, above the rows rather than inside the listbox.
    const head = document.querySelector(".orca-plan__head")!;
    expect([...head.children].map((cell) => cell.textContent)).toEqual([
      "Schedule",
      "Work item",
      "Title",
      "Request",
      "Status",
      "Priority",
      "Risk",
      "Claim",
    ]);

    const api = rows(table).find((row) => row.id === scheduleRowId("wi-api"))!;
    // The request, in mono: it is ORCA's own name for that object (rule 8).
    expect(within(api).getByText("req-1").className).toContain("orca-text-mono-id");

    // Word *and* glyph, like every status in the app (rule 4) …
    const status = WORK_ITEM_STATUS_PRESENTATION.pending;
    const chip = within(api).getByText(status.word).closest(".orca-chip")!;
    expect(chip.textContent).toContain(status.glyph);
    // … and the plain chip, never a tinted one: a tinted chip means a run status.
    expect(chip.className).toContain("orca-chip--plain");
    // The classification is still its own mark, and still says a different word.
    expect(api.textContent).toContain(SCHEDULE_PRESENTATION.ready.word);
    expect(within(api).getByRole("button", { name: "Why auth-api is ready" })).toBeTruthy();
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
    /* The page is stated too — `limit` and `offset` are this surface's rather than the
       schema's default, which is what "200 of 260 items" needs to be a fact (#170). */
    await waitFor(() =>
      expect(callsTo("items.list").at(-1)).toEqual({
        planId: PLAN_ID,
        classification: ["waiting"],
        limit: ITEMS_PAGE,
        offset: 0,
      }),
    );
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
    const page = { limit: ITEMS_PAGE, offset: 0 };
    fireEvent.click(screen.getByRole("button", { name: "req-1" }));
    await waitFor(() =>
      expect(callsTo("items.list").at(-1)).toEqual({ planId: PLAN_ID, requestId: "req-1", ...page }),
    );

    fireEvent.click(screen.getByRole("button", { name: "req-1" }));
    await waitFor(() => expect(callsTo("items.list").at(-1)).toEqual({ planId: PLAN_ID, ...page }));
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
    /* The classification's *word*, which is the word the badge beside it draws: the raw
       key is `waiting` and the row says "waiting on deps", and a trigger whose accessible
       name disagrees with the label next to it is two names for one thing. */
    fireEvent.click(within(legal).getByRole("button", { name: "Why auth-legal is waiting on deps" }));
    const menu = await screen.findByRole("menu", { name: "Why auth-legal is waiting on deps" });
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

  /**
   * A link is a thing that arrives, not a thing that keeps arriving.
   *
   * The landing effect depended on `held`, which is a new array on every re-read, so every
   * `plan.changed` frame re-fired it: the mode was forced back to Schedule and the
   * explanation re-opened under somebody who had since gone to the Journal or closed it.
   */
  it("acts on a link once, and a later frame does not drag the surface back to it", async () => {
    await openPlan({ deepLink: "orca://item/auth-api" });
    await screen.findByRole("menu", { name: "Why auth-api is ready" });

    // The person closes the explanation and goes to read the journal instead.
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Why auth-api is ready" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    await screen.findByRole("listbox", { name: "Plan journal" });

    await act(async () => {
      fake.notify(planChanged(["items"], 11));
    });
    await waitFor(() => expect(callsTo("items.list").length).toBeGreaterThan(1));

    // Still the journal, and still no explanation: the link was handled when it landed.
    expect(screen.getByRole("listbox", { name: "Plan journal" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Schedule" })).toBeNull();
    expect(screen.queryByRole("menu", { name: "Why auth-api is ready" })).toBeNull();
  });

  /**
   * A protocol error is the daemon saying it could not answer. It is not one of the
   * scheduler's lines, and it used to be pushed into `lines` — where it became a menu row
   * like any other, indistinguishable from the scheduler's own words and copyable as one.
   * A person choosing it would walk off with `PLAN_NOT_FOUND: …` on the clipboard as
   * though the scheduler had said it about their work item.
   */
  it("says a failed explain as an error, not as a line, and not as something to copy", async () => {
    const table = await openPlan();
    fake.fail("schedule.explain", { code: "PLAN_NOT_FOUND", message: "no plan plan-sso" });

    const crypto = rows(table).find((row) => row.id === scheduleRowId("wi-crypto"))!;
    fireEvent.click(within(crypto).getByRole("button", { name: "Why auth-crypto is held" }));
    const menu = await screen.findByRole("menu", { name: "Why auth-crypto is held" });

    // The code is on screen — the scheduler's reason is not invented (rule 12) …
    await waitFor(() => expect(menu.textContent).toContain("PLAN_NOT_FOUND: no plan plan-sso"));
    // … and it is not a row: there is nothing here to choose, so nothing to copy.
    expect(within(menu).queryAllByRole("menuitem")).toHaveLength(0);
    expect(menu.querySelector(".orca-menu__error")).toBeTruthy();
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

  /**
   * A frame is "read that again", not "a new question". The table used to drop to
   * `{ phase: "loading" }` on every `itemsRevision` bump, which blanked the rows, dropped
   * `selected` — it is looked up in the list, and the list was empty — and so tore the
   * inspector out of the dock and put it back a tick later. A repaint is not a person
   * asking a different question.
   */
  it("re-reads the table in place: the rows, the selection and the inspector stay put", async () => {
    const table = await openPlan();
    fireEvent.click(rows(table).find((row) => row.id === scheduleRowId("wi-store"))!);
    await screen.findByLabelText("Work item auth-store");
    const before = rows(table).length;
    const selected = table.getAttribute("aria-activedescendant");
    expect(selected).toBe(scheduleRowId("wi-store"));

    /* Held in flight, which is the whole of the window the old code blanked: the rows have
       to still be there *while* the re-read is outstanding, not only after it lands. */
    const release = fake.hold("items.list");
    await act(async () => {
      fake.notify(planChanged(["items"], 11));
    });
    await waitFor(() => expect(callsTo("items.list").length).toBe(2));

    expect(screen.queryByText("Loading the schedule")).toBeNull();
    expect(rows(table)).toHaveLength(before);
    expect(table.getAttribute("aria-activedescendant")).toBe(selected);
    // And the inspector is still the selected item's, rather than having been unmounted.
    expect(screen.getByLabelText("Work item auth-store")).toBeTruthy();

    release();
    await waitFor(() => expect(rows(table)).toHaveLength(before));
    expect(table.getAttribute("aria-activedescendant")).toBe(selected);
  });

  /**
   * A filter *is* a new question, and the table blanks for it: what is on screen is an
   * answer to something nobody is asking any more.
   */
  it("blanks the table when the question changes, which a filter does", async () => {
    const table = await openPlan();
    const release = fake.hold("items.list");
    fireEvent.click(screen.getByRole("button", { name: "ready 1" }));

    await screen.findByText("Loading the schedule");
    release();
    await waitFor(() => expect(screen.queryByText("Loading the schedule")).toBeNull());
    expect(table).toBeTruthy();
  });

  /**
   * The inspector's two reads are not about the selection alone. A `dependencies`,
   * `risks` or `decisions` frame recomputes an `evaluation.detail` without the selected
   * item changing at all — and an inspector deaf to that shows a stored `status` beside a
   * live detail that no longer agrees with it.
   */
  it("re-reads the selected item's dependencies and risks on a dependencies frame", async () => {
    const table = await openPlan();
    fireEvent.click(rows(table).find((row) => row.id === scheduleRowId("wi-store"))!);
    await screen.findByLabelText("Work item auth-store");
    await waitFor(() => expect(callsTo("dependencies.list").length).toBe(1));
    const [deps, risks] = [callsTo("dependencies.list").length, callsTo("risks.list").length];

    await act(async () => {
      fake.notify(planChanged(["dependencies"], 11));
    });
    await waitFor(() => expect(callsTo("dependencies.list").length).toBe(deps + 1));
    expect(callsTo("risks.list").length).toBe(risks + 1);
    // Read for the same item: a repaint never re-picks what is selected.
    expect(callsTo("dependencies.list").at(-1)).toMatchObject({ workItemId: "wi-store" });
  });

  it("never polls: no read happens without a frame", async () => {
    await openPlan();
    await waitFor(() => expect(callsTo("items.list").length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callsTo("items.list")).toHaveLength(1);
  });
});

/**
 * A page of work items, and the count that has to be honest about it.
 *
 * `items.list` answers a page — the schema's `limit` caps it — and the surface used to say
 * nothing about paging, take the cap, and then print `total` beside the rows it had. On a
 * plan with 260 items that read "200 of 260 items" over a table that could never show the
 * other 60 and offered no way to ask for them.
 */
describe("paging the table", () => {
  const BIG = 260;

  /**
   * A plan bigger than one page, answered the way the daemon answers: `offset` and `limit`
   * are a window over one ordering, and `total` counts the filter rather than the page.
   */
  function bigPlan(): void {
    const pool = Array.from({ length: BIG }, (_unused, index) => {
      const base = PLAN_ITEMS[index % PLAN_ITEMS.length]!;
      return { ...base, id: `${base.id}-${index}`, slug: `${base.slug}-${index}` };
    });
    fake.script({
      "items.list": (params) => {
        const offset = params.offset ?? 0;
        const limit = params.limit ?? BIG;
        return { ok: true, result: { items: pool.slice(offset, offset + limit), total: pool.length, asOf: AS_OF } };
      },
    });
  }

  /** The chrome, on a plan of 260 items. `bigPlan` has to be scripted before the mount. */
  async function openBigPlan(): Promise<HTMLElement> {
    fake = installBridge();
    teardown.push(fake.install());
    bigPlan();
    h = harness();
    teardown.push(h.dispose);
    renderChrome(h);
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    return screen.findByRole("listbox", { name: "Schedule" });
  }

  it("sends its own page, says how much of the plan that is, and offers the rest", async () => {
    await openBigPlan();

    // The page is the surface's, not the schema's default.
    expect(callsTo("items.list").at(-1)).toMatchObject({ offset: 0, limit: ITEMS_PAGE });
    /* The count is a fact about what is held, and there is now a control beside it that
       makes it one — the old "200 of 260 items" was a number with nothing behind it. */
    expect(screen.getByText(`${ITEMS_PAGE} of ${BIG} items`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load more items" })).toBeTruthy();
  });

  it("asks for the next page by offset and appends it, leaving the selection alone", async () => {
    const table = await openBigPlan();
    fireEvent.keyDown(table, { key: "Home", code: "Home" });
    await waitFor(() => expect(table.getAttribute("aria-activedescendant")).toBeTruthy());
    const selected = table.getAttribute("aria-activedescendant");
    const first = rows(table)[0]!.id;

    fireEvent.click(screen.getByRole("button", { name: "Load more items" }));
    await waitFor(() => expect(screen.getByText(`${BIG} items`)).toBeTruthy());

    // By offset — what is held — rather than by a page number this surface counted.
    expect(callsTo("items.list").at(-1)).toMatchObject({ offset: ITEMS_PAGE, limit: ITEMS_PAGE });
    // Appended in place: the top of the table and the selection are where they were.
    expect(rows(table)[0]!.id).toBe(first);
    expect(table.getAttribute("aria-activedescendant")).toBe(selected);
    // And with the whole plan held there is nothing more to ask for.
    expect(screen.queryByRole("button", { name: "Load more items" })).toBeNull();
  });

  it("says nothing about more when the whole plan fits in a page", async () => {
    await openPlan();
    expect(screen.getByText("9 items")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more items" })).toBeNull();
  });

  it("re-reads every page it holds on a frame, not just the first", async () => {
    await openBigPlan();
    fireEvent.click(screen.getByRole("button", { name: "Load more items" }));
    await waitFor(() => expect(screen.getByText(`${BIG} items`)).toBeTruthy());

    await act(async () => {
      fake.notify(planChanged(["items"], 11));
    });

    /* The span that is held, from the top: a repaint that re-read one page would throw
       away the two a person had asked for and shrink the table under them. */
    await waitFor(() => expect(callsTo("items.list").at(-1)).toMatchObject({ offset: 0, limit: BIG }));
    expect(screen.getByText(`${BIG} items`)).toBeTruthy();
  });
});

/**
 * The dock opens on a *selection*, and on nothing else.
 *
 * The inspector's content is memoised over the dependencies and risks behind it, which
 * land a tick after the click and move again on every later frame — so `showInspector`
 * fired several times per selection. Opening the dock on "the content changed" meant `⌘\`
 * right after a click closed a panel that came straight back.
 */
describe("the inspector in the dock", () => {
  const panel = (): HTMLElement | null => document.querySelector<HTMLElement>(".orca-panel");

  it("opens on a new row, and a frame that only moves the detail does not re-open it", async () => {
    const table = await openPlan();
    fireEvent.click(rows(table).find((row) => row.id === scheduleRowId("wi-store"))!);
    await screen.findByLabelText("Work item auth-store");
    expect(panel()).toBeTruthy();

    // The person closes the dock, having seen what they came for.
    fireEvent.click(screen.getByRole("button", { name: /Close panel/ }));
    await waitFor(() => expect(panel()).toBeNull());

    /* A `dependencies` frame re-reads the selected item's detail, which re-renders the
       inspector — and must not put the dock back. Nobody asked for it again. */
    await act(async () => {
      fake.notify(planChanged(["dependencies"], 11));
    });
    await waitFor(() => expect(callsTo("dependencies.list").length).toBeGreaterThan(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel()).toBeNull();

    // Selecting another row *is* asking, and opens it again.
    fireEvent.click(rows(table).find((row) => row.id === scheduleRowId("wi-crypto"))!);
    await waitFor(() => expect(panel()).toBeTruthy());
    expect(await screen.findByLabelText("Work item auth-crypto")).toBeTruthy();
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
