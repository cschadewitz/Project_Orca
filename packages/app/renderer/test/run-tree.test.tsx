// @vitest-environment happy-dom
/**
 * The run tree below its roots (#156): what one `runs.get` becomes, what the five tree keys
 * do to it, and what a `step.changed` does and does not touch.
 *
 * The fixture is `fixtures.ts`'s `run-parent`, which is the story the issue asks for — a
 * `parallel` fan-out with one finished child, one child whose log is gone, one branch that
 * never ran, and a `build` node retried after a transport failure. `tree-rows.test.ts`
 * asserts the rows as data; this asserts them as a screen, including the thing a greyscale
 * screenshot depends on: a glyph *and* a word on every row.
 *
 * `timelineRowId` is wrapped rather than spied on because it is the one function the
 * timeline's `VirtualList` calls once per rendered row, which makes it the cheapest honest
 * count of "did the timeline's rows re-render" — see the last test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { STATUS_PRESENTATION } from "@orca/design";
import type { Crumb } from "../src/ui/index.js";
import type { NotificationMessage } from "@orca/protocol";

const rendered = vi.hoisted(() => ({ rows: 0 }));
vi.mock("../src/runs/timeline/timeline-entries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runs/timeline/timeline-entries.js")>();
  return {
    ...actual,
    timelineRowId: (seq: number) => {
      rendered.rows += 1;
      return actual.timelineRowId(seq);
    },
  };
});

const { RunsSurface } = await import("../src/runs/runs-surface.js");
const { installBridge, harness } = await import("./harness.js");
const { RUN_DETAILS } = await import("./fixtures.js");
type Harness = Awaited<ReturnType<typeof import("./harness.js").harness>>;
type FakeBridge = ReturnType<typeof import("./fake-bridge.js").fakeBridge>;

let fake: FakeBridge;
let h: Harness;
let crumbs: readonly Crumb[] = [];
const teardown: (() => void)[] = [];

function renderRuns(): void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <RunsSurface
        connection="live"
        onCrumbs={(next) => {
          crumbs = next;
        }}
      />
    </Providers>,
  );
}

/* A `tree` of `treeitem`s, not a listbox of options: the rows have depth and #156 says so.
   The timeline beside it is still a listbox, which is why these two helpers name the role
   rather than taking whatever list is on screen. */
const list = (): HTMLElement => screen.getByRole("tree", { name: "Run tree" });
const rows = (): HTMLElement[] => within(list()).queryAllByRole("treeitem");
const ids = (): string[] => rows().map((row) => row.id.replace(/^tree-row-/, ""));
const press = (key: string, code: string, shift = false): void => {
  fireEvent.keyDown(list(), { key, code, shiftKey: shift });
};

/** The twisty is `aria-hidden`, so it is found by class rather than by role. */
const twisty = (row: HTMLElement): HTMLElement => row.querySelector(".orca-tree-row__twisty")!;

/** Select the last root, which is `run-parent` — the fixture with everything in it. */
async function openParent(): Promise<void> {
  renderRuns();
  await screen.findByRole("tree", { name: "Run tree" });
  press("End", "End");
  await act(async () => {
    press("ArrowRight", "ArrowRight");
  });
  await waitFor(() => expect(ids().length).toBeGreaterThan(5));
}

describe("the run tree", () => {
  beforeEach(() => {
    fake = installBridge();
    rendered.rows = 0;
    crumbs = [];
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("reads a run once when it is opened, and draws its step groups", async () => {
    await openParent();

    expect(ids()).toEqual([
      "run-old",
      "run-lost",
      "run-gate",
      "run-child-ok",
      "run-parent",
      // One row per node, at the newest attempt: `build` was tried twice and is one row.
      "run-parent/s-build-2",
      "run-parent/s-fan",
    ]);
    expect(fake.calls.filter((c) => c.method === "runs.get")).toEqual([
      { method: "runs.get", params: { runId: "run-parent" } },
    ]);
  });

  it("puts the earlier attempt under the newest one, and says which attempt each is", async () => {
    await openParent();
    fireEvent.click(twisty(rows()[5]!));

    expect(ids()).toEqual([
      "run-old",
      "run-lost",
      "run-gate",
      "run-child-ok",
      "run-parent",
      "run-parent/s-build-2",
      // A key is a path, not an id: the earlier attempt hangs off the newest one.
      "run-parent/s-build-2/s-build-1",
      "run-parent/s-fan",
    ]);
    expect(rows()[5]!.textContent).toContain("attempt 2 of 2");
    expect(rows()[6]!.textContent).toContain("attempt 1 of 2");
    // One attempt at `fanout`, so no "attempt 1 of 1" on it.
    expect(rows()[7]!.textContent).not.toContain("attempt");
  });

  it("draws the whole fan-out: the finished child, the stale one, and the branch that never ran", async () => {
    await openParent();
    fireEvent.click(twisty(rows()[6]!));

    expect(ids().slice(6)).toEqual([
      "run-parent/s-fan",
      "run-parent/s-fan/run-child-ok",
      "run-parent/s-fan/run-child-gone",
      "run-parent/s-fan/!auth-perf",
    ]);
    const skipped = rows()[9]!;
    expect(skipped.textContent).toContain("skipped");
    expect(skipped.textContent).toContain("auth-perf");
    expect(skipped.textContent).toContain("a dependency was not met");
  });

  /* Rule 4, and #156's "a greyscale screenshot still reads": the status is never colour
     alone. Every row that has one renders its glyph *and* its word, in that order and
     before the name, which is also the order of the row's accessible name. */
  it("says the status in a glyph and a word, first, on every row", async () => {
    await openParent();
    fireEvent.click(twisty(rows()[6]!));

    const expected: Record<string, string> = {
      "run-old": "failed",
      "run-lost": "stale",
      "run-gate": "waiting",
      "run-child-ok": "succeeded",
      "run-parent": "running",
      "run-parent/s-build-2": "succeeded",
      "run-parent/s-fan": "running",
      "run-parent/s-fan/run-child-ok": "succeeded",
      "run-parent/s-fan/run-child-gone": "stale",
    };

    for (const row of rows()) {
      const key = row.id.replace(/^tree-row-/, "");
      // The twisty is decorative and aria-hidden, so it is not part of the name.
      const said = (row.textContent ?? "").replace(/^▸?/, "");
      if (key === "run-parent/s-fan/!auth-perf") {
        expect(said.startsWith("skipped"), key).toBe(true);
        continue;
      }
      const status = expected[key]!;
      const { glyph, word } = STATUS_PRESENTATION[status as keyof typeof STATUS_PRESENTATION];
      expect(said.startsWith(`${glyph}${word}`), `${key}: ${said}`).toBe(true);
    }
  });

  it("draws an indeterminate meter on a running run and no percentage anywhere", async () => {
    await openParent();
    fireEvent.click(twisty(rows()[6]!));

    // One meter: the running *run*. The running fan-out step does not get one, and
    // nothing on this screen says a percentage — ORCA has none to give (rule 12).
    const meters = [...document.querySelectorAll(".orca-meter")];
    expect(meters).toHaveLength(1);
    expect(rows()[4]!.contains(meters[0]!)).toBe(true);
    expect(meters[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(list().textContent).not.toMatch(/\d+\s*%/);
  });

  it("expands and collapses with the arrows, and goes to the parent from a closed row", async () => {
    await openParent();
    // `→` on an open row steps into it rather than opening it again.
    press("ArrowRight", "ArrowRight");
    expect(rows()[5]!.getAttribute("aria-selected")).toBe("true");

    // `←` on a closed row goes to its parent.
    press("ArrowLeft", "ArrowLeft");
    expect(rows()[4]!.getAttribute("aria-selected")).toBe("true");

    // And `←` on the open parent closes it.
    press("ArrowLeft", "ArrowLeft");
    expect(ids()).toEqual(["run-old", "run-lost", "run-gate", "run-child-ok", "run-parent"]);
  });

  it("opens a whole subtree with shift and the right arrow", async () => {
    await openParent();
    // Back onto the run itself — `End` is the fan-out now that the run is open.
    fireEvent.click(rows()[4]!);
    await act(async () => {
      press("ArrowRight", "ArrowRight", true);
    });

    // Both step groups opened in one press: the retried node's earlier attempt and the
    // fan-out's children and skipped branch.
    await waitFor(() =>
      expect(ids().slice(5)).toEqual([
        "run-parent/s-build-2",
        "run-parent/s-build-2/s-build-1",
        "run-parent/s-fan",
        "run-parent/s-fan/run-child-ok",
        "run-parent/s-fan/run-child-gone",
        "run-parent/s-fan/!auth-perf",
      ]),
    );
  });

  it("filters to the failed and the waiting with F, and back again", async () => {
    await openParent();
    fireEvent.click(twisty(rows()[5]!));

    act(() => press("f", "KeyF"));

    expect(ids()).toEqual([
      // The failed run, the waiting one, and the retried attempt with the run above it.
      "run-old",
      "run-gate",
      "run-parent",
      "run-parent/s-build-2",
      "run-parent/s-build-2/s-build-1",
    ]);
    expect(screen.getByText("failed and waiting only")).toBeTruthy();

    act(() => press("f", "KeyF"));
    expect(ids()).toContain("run-child-ok");
  });

  /* #156 and docs/design/50-accessibility-and-keyboard.md: depth has to be *announced*, not
     only drawn. Indentation and the guide lines say nothing to a screen reader, so a tree
     rendered as a flat listbox reads every step as a sibling of the run it belongs to. */
  it("is a tree whose rows carry their depth and whether they are open", async () => {
    await openParent();
    fireEvent.click(twisty(rows()[6]!));

    expect(list().getAttribute("role")).toBe("tree");
    expect(rows().every((row) => row.getAttribute("role") === "treeitem")).toBe(true);

    const levelOf = (key: string) =>
      rows()
        .find((row) => row.id === `tree-row-${key}`)!
        .getAttribute("aria-level");
    // A root, its step, and a child run two levels below it.
    expect(levelOf("run-parent")).toBe("1");
    expect(levelOf("run-parent/s-fan")).toBe("2");
    expect(levelOf("run-parent/s-fan/run-child-ok")).toBe("3");

    const rowFor = (key: string) => rows().find((row) => row.id === `tree-row-${key}`)!;
    expect(rowFor("run-parent").getAttribute("aria-expanded")).toBe("true");
    expect(rowFor("run-parent/s-build-2").getAttribute("aria-expanded")).toBe("false");
    // A child run is a run: it opens into its own steps, so it says it is closed.
    expect(rowFor("run-parent/s-fan/run-child-ok").getAttribute("aria-expanded")).toBe("false");
    /* A leaf has no `aria-expanded` at all. "Closed" and "nothing to open" are different
       facts and a reader says so — `false` on a leaf promises children that do not exist.
       The skipped branch is the leaf here: it never became a run, so there is nothing under
       it to open. */
    expect(rowFor("run-parent/s-fan/!auth-perf").hasAttribute("aria-expanded")).toBe(false);
  });

  it("indents each row by its depth, not just the guides beside it", async () => {
    await openParent();
    fireEvent.click(twisty(rows()[6]!));

    /* `.orca-tree-row` pads by `--level`; the row element is the substrate's, so the depth
       has to reach it through `rowStyle`. Without it every row sat at level 0 and only the
       hairline guides moved. `aria-level` is one-based, `--level` zero-based. */
    const levelVar = (key: string) =>
      rows()
        .find((row) => row.id === `tree-row-${key}`)!
        .style.getPropertyValue("--level");
    expect(levelVar("run-parent")).toBe("0");
    expect(levelVar("run-parent/s-fan")).toBe("1");
    expect(levelVar("run-parent/s-fan/run-child-ok")).toBe("2");
  });

  it("puts the ancestor chain in the sticky header once a row has one", async () => {
    await openParent();
    press("End", "End");
    press("ArrowDown", "ArrowDown");

    const head = document.querySelector(".orca-runs__tree-head")!;
    expect(head.textContent).toContain("Add the SSO callback");
  });

  it("hands the chrome request ▸ work item ▸ run ▸ step for the selection", async () => {
    await openParent();

    // The run alone: request, work item, run — and the run is the current crumb.
    await waitFor(() => expect(crumbs.map((c) => c.type)).toEqual(["request", "item", "run"]));
    expect(crumbs.map((c) => c.label)).toEqual(["req-1", "Add the SSO callback", "Add the SSO callback"]);
    expect(crumbs[2]!.current).toBe(true);

    /* The run crumb carries the workflow it executes *and* the version it is pinned to —
       `sdlc v2` — which is 70-workflow-editing.md's "shown wherever a run's workflow is
       named", on the run header (#177). The `◷ pinned` chip is not here: whether v2 is still
       the version on disk is a `workflows.get` this surface does not make. */
    expect(crumbs[2]!.version).toBe("sdlc v2");
    expect(crumbs.filter((c) => c.version !== undefined)).toHaveLength(1);

    // And the step, once a step is selected.
    act(() => press("Enter", "Enter"));
    press("ArrowDown", "ArrowDown");
    await waitFor(() => expect(crumbs.map((c) => c.type)).toEqual(["request", "item", "run", "step"]));
    expect(crumbs[3]!.label).toBe("build");
  });

  it("folds a step.changed into the open run without re-reading it", async () => {
    await openParent();
    expect(within(rows()[6]!).getByText(STATUS_PRESENTATION.running.word)).toBeTruthy();

    act(() => fake.notify(stepChanged({ stepRunId: "s-fan", status: "waiting", event: "step.waiting" })));

    await waitFor(() => expect(within(rows()[6]!).getByText(STATUS_PRESENTATION.waiting.word)).toBeTruthy());
    expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1);
  });

  /* A settled step may have set variables, and no notification carries them: the step
     detail's Variables kept the first read's until the run was selected again (#1109). The
     status is folded at once; the one re-read follows. */
  it("re-reads the open run once a step settles, after folding its status", async () => {
    await openParent();

    act(() => fake.notify(stepChanged({ stepRunId: "s-fan", status: "failed", event: "step.failed" })));

    await waitFor(() => expect(within(rows()[6]!).getByText(STATUS_PRESENTATION.failed.word)).toBeTruthy());
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(2));
    expect(fake.calls.filter((c) => c.method === "runs.get").at(-1)).toEqual({
      method: "runs.get",
      params: { runId: "run-parent" },
    });
  });

  /* A reconnect starts a new subscription generation while a re-read is still out. The old
     answer is dropped, and it must not leave the run marked as being re-read, or every later
     settle would only mark it dirty and Variables would stay stale. */
  it("re-reads again after a reconnect that overtook an earlier re-read", async () => {
    await openParent();
    const reads = (): number => fake.calls.filter((c) => c.method === "runs.get").length;
    const release = fake.hold("runs.get");

    act(() => fake.notify(stepChanged({ stepRunId: "s-fan", status: "failed", event: "step.failed" })));
    await waitFor(() => expect(reads()).toBe(2));

    act(() => fake.connect({ ...fake.bridge.connection.read(), generation: 7 }));
    await waitFor(() => expect(reads()).toBe(3));
    await act(async () => {
      release();
    });
    await waitFor(() => expect(ids()).toContain("run-parent/s-fan"));

    act(() => fake.notify(stepChanged({ stepRunId: "s-fan", status: "failed", event: "step.failed", seq: 41 })));
    await waitFor(() => expect(reads()).toBe(4));
  });

  it("re-reads again after a re-read the bridge rejected", async () => {
    await openParent();
    const reads = (): number => fake.calls.filter((c) => c.method === "runs.get").length;
    let rejectNext = true;
    fake.script({
      "runs.get": ({ runId }) => {
        if (!rejectNext) return { ok: true, result: RUN_DETAILS[runId]! };
        rejectNext = false;
        return Promise.reject(new Error("bridge gone"));
      },
    });

    act(() => fake.notify(stepChanged({ stepRunId: "s-fan", status: "failed", event: "step.failed" })));
    await waitFor(() => expect(reads()).toBe(2));
    await act(async () => {});

    act(() => fake.notify(stepChanged({ stepRunId: "s-fan", status: "failed", event: "step.failed", seq: 41 })));
    await waitFor(() => expect(reads()).toBe(3));
  });

  /* The first read can predate a step that settles while it is out, and the status patch
     queued behind it carries no variables: the run is read once more when that read lands. */
  it("re-reads a run whose step settled while its first read was out", async () => {
    const release = fake.hold("runs.get");
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    press("End", "End");
    await act(async () => {
      press("ArrowRight", "ArrowRight");
    });
    const reads = () => fake.calls.filter((c) => c.method === "runs.get");
    await waitFor(() => expect(reads()).toHaveLength(1));

    act(() => fake.notify(stepChanged({ stepRunId: "s-fan", status: "failed", event: "step.failed" })));
    expect(reads()).toHaveLength(1);
    await act(async () => {
      release();
    });

    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(reads().at(-1)!.params).toEqual({ runId: "run-parent" });
    await waitFor(() => expect(within(rows()[6]!).getByText(STATUS_PRESENTATION.failed.word)).toBeTruthy());
  });

  it("draws a step it has never seen, from the step.scheduled that introduces it", async () => {
    await openParent();

    act(() =>
      fake.notify(
        stepChanged({
          stepRunId: "s-deploy",
          status: "waiting",
          event: "step.scheduled",
          nodeId: "deploy",
          nodeType: "agent",
          attempt: 1,
        }),
      ),
    );

    await waitFor(() => expect(ids()).toContain("run-parent/s-deploy"));
    expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1);
  });

  /* docs/design/60-implementation.md, read the other way round: the tree subscribes to
     `run.changed` and `step.changed`, and those are the tree's. A step moving must not cost
     a re-render of a list that may be ten thousand event rows long. */
  it("does not re-render the timeline's rows when a step changes", async () => {
    await openParent();
    await screen.findByRole("listbox", { name: "Event timeline" });
    await waitFor(() =>
      expect(
        within(screen.getByRole("listbox", { name: "Event timeline" })).queryAllByRole("option").length,
      ).toBeGreaterThan(0),
    );

    const before = rendered.rows;
    act(() => fake.notify(stepChanged({ stepRunId: "s-fan", status: "failed", event: "step.failed" })));
    await waitFor(() => expect(within(rows()[6]!).getByText(STATUS_PRESENTATION.failed.word)).toBeTruthy());

    expect(rendered.rows).toBe(before);
  });
});

/** A `step.changed` frame about `run-parent`, with the envelope every notification carries. */
function stepChanged(over: Record<string, unknown> & { stepRunId: string }): NotificationMessage {
  return {
    kind: "notification",
    method: "step.changed",
    params: {
      subscriptionId: "sub-1",
      runId: "run-parent",
      seq: 40,
      at: "2026-03-01T09:00:50.000Z",
      status: "running",
      event: "step.started",
      ...over,
    },
  };
}
