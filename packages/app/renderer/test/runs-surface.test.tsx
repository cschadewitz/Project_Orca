// @vitest-environment happy-dom
/**
 * The Runs surface against the fake preload bridge: the tree's roots, the filter, selection
 * by keyboard, the four state views, and the live path — a `run.changed` repainting a row
 * and a `run.changed` for an unknown run inserting one.
 *
 * The roots of the run tree are the run list this surface used to be, with the same two
 * filters over them, so most of what this file asserts is unchanged by #156 — the listbox
 * is called "Run tree" now and a row's id is its path in the tree rather than a run id.
 * What the tree does *below* its roots is `run-tree.test.tsx`; the timeline is
 * `timeline.test.tsx`.
 *
 * Everything below goes through `window.orca`, which is the whole of "the daemon" as far as
 * the renderer is concerned. The fake's read methods genuinely filter and page (see
 * `fake-bridge.ts`), so a screen that sent the wrong `runs.list` params fails here rather
 * than against a real store three waves later.
 *
 * The dual-theme half is at the bottom and asserts on colours the *real* tokens.css
 * resolves, per docs/design/RULES.md rule 7.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { STATUS_PRESENTATION, THEMES } from "@orca/design";
import type { NotificationMessage } from "@orca/protocol";
import { RunsSurface } from "../src/runs/runs-surface.js";
import { AS_OF, RUNS } from "./fixtures.js";
import { installBridge, harness, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { expectedToken, installDesignSystem, resolved, setTheme } from "./themes.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

/** The surface as the chrome mounts it, with everything `main.tsx` installs above it. */
function renderRuns(connection: "live" | "disconnected" = "live"): void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <RunsSurface connection={connection} />
    </Providers>,
  );
}

const list = (): HTMLElement => screen.getByRole("tree", { name: "Run tree" });
/** Scoped to the tree: the timeline is a second listbox on this screen. */
const rows = (): HTMLElement[] => within(list()).queryAllByRole("treeitem");
const filterField = (): HTMLElement => screen.getByRole("searchbox", { name: "Filter runs" });

/** A bare key on the list, as the keyboard map reads it: `code` for letters, `key` for the rest. */
const press = (key: string, code: string): void => {
  fireEvent.keyDown(list(), { key, code });
};

/** A `run.changed` frame, with the envelope fields every notification carries. */
const runChanged = (runId: string, status: string, at = "2026-03-01T09:01:00.000Z"): NotificationMessage => ({
  kind: "notification",
  method: "run.changed",
  params: { subscriptionId: "sub-1", runId, seq: 99, at, status, event: "run.completed" },
});

describe("the Runs surface", () => {
  beforeEach(() => {
    fake = installBridge();
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
    setTheme(undefined);
  });

  it("makes every run the daemon sent a root of the tree, newest first", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });

    // The fixture's order is the daemon's: newest first by creation.
    expect(rows().map((row) => row.id)).toEqual(RUNS.map((run) => `tree-row-${run.id}`));
    expect(rows().every((row) => row.classList.contains("orca-tree-row"))).toBe(true);

    // `run-old` is the failed one at the top; a row says status, name, duration, agent.
    const old = within(rows()[0]!);
    expect(old.getByText(STATUS_PRESENTATION.failed.word)).toBeTruthy();
    expect(old.getByText("SSO rollout")).toBeTruthy();
    expect(rows()[0]!.textContent).toContain("1.0s");
  });

  it("asks the daemon once, and with no paging parameters it does not need", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });

    const listCalls = fake.calls.filter((c) => c.method === "runs.list");
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.params).toEqual({});
    // Nothing is selected and nothing is open, so no run has been read.
    expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(0);
  });

  it("filters by text over the name, the id, the workflow and the agent", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });

    fireEvent.change(filterField(), { target: { value: "login" } });
    expect(rows().map((r) => r.id)).toEqual(["tree-row-run-child-ok"]);

    // An id the row does not show: a person pasting one should still find the run.
    fireEvent.change(filterField(), { target: { value: "run-gate" } });
    expect(rows().map((r) => r.id)).toEqual(["tree-row-run-gate"]);

    // The text filter is local, so it costs no round trip.
    expect(fake.calls.filter((c) => c.method === "runs.list")).toHaveLength(1);
  });

  it("filters by status through runs.list, so the whole store is filtered and not one page", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });

    fireEvent.click(screen.getByRole("button", { name: /Filter by status/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: STATUS_PRESENTATION.waiting.word }));

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]!.id).toBe("tree-row-run-gate");

    const listCalls = fake.calls.filter((c) => c.method === "runs.list");
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]!.params).toEqual({ status: ["waiting"] });
  });

  /* The movement keys belong to the list substrate: `list/use-list-keys.ts` registers all
     eight in whichever scope the list's `scope` prop names, and the tree's is `run-tree`.
     The `list` scope is now the timeline's, which is why nothing is registered there until
     a run is selected. */
  it("moves the selection with the list keys, registered in the run-tree scope", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });

    const listKeys = h.keyboard
      .list()
      .filter((s) => s.scope === "run-tree")
      .map((s) => `${s.key}: ${s.label}`);
    /* The substrate's eight first — a child's effects run before its parent's, and the
       `VirtualList` is inside the component that registers the tree's five. */
    expect(listKeys).toEqual([
      "J: Next row",
      "ArrowDown: Next row",
      "K: Previous row",
      "ArrowUp: Previous row",
      "Home: First row",
      "End: Last row",
      "PageDown: Next page of rows",
      "PageUp: Previous page of rows",
      "ArrowRight: Expand the selected row",
      "ArrowLeft: Collapse the selected row, or go to its parent",
      "Shift+ArrowRight: Expand the whole subtree",
      "Enter: Open the step detail",
      "F: Filter to failed and waiting",
    ]);
    // Nothing is registered in `list` until a run is selected and the timeline has a log.
    expect(h.keyboard.list().filter((s) => s.scope === "list")).toHaveLength(0);

    // Nothing selected yet: J takes the first row, which is the newest run.
    press("j", "KeyJ");
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(list().getAttribute("aria-activedescendant")).toBe("tree-row-run-old");

    press("ArrowDown", "ArrowDown");
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");

    press("k", "KeyK");
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");

    // The ends hold: K on the first row stays on the first row.
    press("ArrowUp", "ArrowUp");
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");

    press("End", "End");
    expect(rows()[RUNS.length - 1]!.getAttribute("aria-selected")).toBe("true");

    press("Home", "Home");
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  /* The gutter is over the whole filtered list rather than the rendered window, and only
     the three statuses `.orca-minimap__tick--*` has a colour for get a mark: a run that
     failed, one waiting on a person, one that cannot proceed. The other five are on their
     rows and nowhere else. `virtual-list.test.tsx` proves a mark can be off screen. */
  it("marks the failed and the waiting run in the status gutter, and nothing else", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });

    const ticks = [...document.querySelectorAll(".orca-minimap__tick")];
    expect(ticks.map((tick) => tick.getAttribute("aria-label"))).toEqual([
      `SSO rollout, ${STATUS_PRESENTATION.failed.word}`,
      `Document the rollout, ${STATUS_PRESENTATION.waiting.word}`,
    ]);
    expect(ticks[0]!.classList.contains("orca-minimap__tick--failed")).toBe(true);
    expect(ticks[1]!.classList.contains("orca-minimap__tick--waiting")).toBe(true);

    // Clicking one selects nothing — it takes you to the row, which is a different act.
    fireEvent.click(ticks[0]!);
    expect(list().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("does not move the selection while a letter is being typed into the filter", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    press("j", "KeyJ");

    fireEvent.keyDown(filterField(), { key: "j", code: "KeyJ" });

    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("clears a selection whose row the filter took away", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    press("j", "KeyJ");
    expect(list().getAttribute("aria-activedescendant")).toBe("tree-row-run-old");

    fireEvent.change(filterField(), { target: { value: "login" } });

    expect(list().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("repaints a row from run.changed without re-reading the list", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    const running = STATUS_PRESENTATION.running.word;
    expect(within(rows()[4]!).getByText(running)).toBeTruthy();

    await act(async () => fake.notify(runChanged("run-parent", "succeeded")));

    await waitFor(() => expect(within(rows()[4]!).getByText(STATUS_PRESENTATION.succeeded.word)).toBeTruthy());
    // The whole point: no second `runs.list`.
    expect(fake.calls.filter((c) => c.method === "runs.list")).toHaveLength(1);
    // The row has stopped accruing and shows a total: 09:00:02 to 09:01:00.
    expect(rows()[4]!.textContent).toContain("58s");
  });

  it("inserts a run it has never seen, in creation order, with one runs.get", async () => {
    // A page that does not carry `run-gate` — which is the real case for a run started from
    // the CLI after the list was read. `run.changed` has no name, workflow or creation time
    // in it, so the row has to be resolved with one `runs.get` before it can be drawn.
    const page = RUNS.filter((run) => run.id !== "run-gate");
    fake.script({ "runs.list": () => ({ ok: true, result: { runs: page, total: page.length, asOf: AS_OF } }) });
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    expect(rows()).toHaveLength(page.length);

    await act(async () => fake.notify(runChanged("run-gate", "waiting")));

    await waitFor(() => expect(rows()).toHaveLength(RUNS.length));
    // Third row: it was created after `run-child-ok` and before `run-lost`.
    expect(rows()[2]!.id).toBe("tree-row-run-gate");
    expect(fake.calls.filter((c) => c.method === "runs.get")).toEqual([
      { method: "runs.get", params: { runId: "run-gate" } },
    ]);
  });

  it("drops a row that has left the status filter", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });

    fireEvent.click(screen.getByRole("button", { name: /Filter by status/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: STATUS_PRESENTATION.waiting.word }));
    await waitFor(() => expect(rows()).toHaveLength(1));

    await act(async () => fake.notify(runChanged("run-gate", "succeeded")));

    await waitFor(() => expect(screen.getByText("No runs match the filter")).toBeTruthy());
  });

  it("shows the loading state while the daemon is answering", async () => {
    const release = fake.hold("runs.list");
    renderRuns();

    expect(await screen.findByText("Loading runs")).toBeTruthy();
    release();
    await screen.findByRole("tree", { name: "Run tree" });
  });

  it("shows the empty state when the store has no runs", async () => {
    fake.script({
      "runs.list": () => ({ ok: true, result: { runs: [], total: 0, asOf: "2026-03-01T09:00:40.000Z" } }),
    });
    renderRuns();

    expect(await screen.findByText("No runs yet")).toBeTruthy();
  });

  it("shows the error state with the protocol code, and retries on demand", async () => {
    fake.fail("runs.list", { code: "STORE_UNAVAILABLE", message: "the store is locked" });
    renderRuns();

    expect(await screen.findByText("Could not load the runs")).toBeTruthy();
    expect(screen.getByText("STORE_UNAVAILABLE: the store is locked")).toBeTruthy();

    fake.script({ "runs.list": () => ({ ok: true, result: { runs: [...RUNS], total: RUNS.length, asOf: "x" } }) });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByRole("tree", { name: "Run tree" });
  });

  it("says it is disconnected rather than blaming the store, and stops the clock", async () => {
    fake.fail("runs.list", { code: "AGENT_TRANSPORT", message: "connect ECONNREFUSED" });
    renderRuns("disconnected");

    expect(await screen.findByText("No daemon to read runs from")).toBeTruthy();

    // With data in hand, a disconnected app keeps the rows and says not to trust them.
    fake.script({ "runs.list": () => ({ ok: true, result: { runs: [...RUNS], total: RUNS.length, asOf: "x" } }) });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByRole("tree", { name: "Run tree" });
    expect(screen.getByText(/these runs are the last the daemon sent/)).toBeTruthy();
    expect(document.querySelectorAll(".orca-stale-value").length).toBe(RUNS.length);
  });

  it("leaves no bridge subscription behind when it unmounts", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    expect(fake.subscribers).toBe(1);

    cleanup();

    expect(h.notifications.listeners).toBe(0);
    expect(fake.subscribers).toBe(0);
  });

  /* The right-hand column is unit F's (#158, #159), wired into this surface by wave 2's
     integration commit. With no run selected there is no `runs.get` projection to hand it,
     so the slot is still a state view — which is the case this asserts. What it renders
     once a run *is* selected is `step-detail.test.tsx`'s. */
  it("keeps the step detail slot beside the tree, empty until a run is selected", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });

    const slot = screen.getByRole("complementary", { name: "Step detail" });
    expect(within(slot).getByText("Step detail")).toBeTruthy();
    expect(within(slot).getByText(/Select a run in the tree/)).toBeTruthy();
  });
});

/**
 * The same tree, mounted once per theme against the real `tokens.css`
 * (docs/design/RULES.md rule 7).
 *
 * `inBothThemes` is not used here and this loop is its asynchronous twin: that helper mounts
 * and unmounts inside one synchronous call, and this surface needs a bridge round trip
 * before there is a row to measure.
 */
describe("the Runs surface in both themes", () => {
  beforeEach(() => {
    fake = installBridge();
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
    setTheme(undefined);
  });

  for (const theme of THEMES) {
    it(`binds a row's status and its selection to the tokens in ${theme}`, async () => {
      h = harness();
      teardown.push(h.dispose);
      const { Providers } = h;
      /* After the harness, not before: `installAppearance` applies the stored preference to
         `<html>`, and the default preference is `system` — which *removes* `data-theme`. */
      installDesignSystem();
      setTheme(theme);

      const container = document.createElement("div");
      container.className = "orca";
      document.body.append(container);
      render(
        <Providers>
          <RunsSurface connection="live" />
        </Providers>,
        { container },
      );
      await screen.findByRole("tree", { name: "Run tree" });
      expect(rows()).toHaveLength(RUNS.length);

      // Status: the chip is bound to its own token rather than to a colour typed here.
      const chip = container.querySelector(".orca-chip--failed")!;
      expect(resolved(chip, "color"), theme).toBe(expectedToken(theme, "status-failed"));

      // Selection: `surface-selected` plus the accent rail, which is a different thing from
      // focus and has to stay legible in both themes.
      press("j", "KeyJ");
      const selected = rows()[0]!;
      expect(resolved(selected, "background-color"), theme).toBe(expectedToken(theme, "surface-selected"));
      expect(resolved(selected, "border-left-color"), theme).toBe(expectedToken(theme, "accent"));

      container.remove();
    });
  }
});
