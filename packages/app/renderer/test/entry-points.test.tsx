// @vitest-environment happy-dom
/**
 * How a person arrives at an object (#165, #164, #206): a pasted link, an opened store and
 * a palette entry, all through the one route table.
 *
 * Everything here is driven at the seam the real app has — `window.orca` — so a deep link
 * that arrives on a cold start and one that arrives on an open window are the same two
 * bridge calls they are in Electron (`deepLink.take`, `deepLink.subscribe`), and file mode
 * is the workspace snapshot plus a connection state, which is exactly what the main
 * process pushes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ObjectHeader } from "../src/ui/object-header.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import { AS_OF } from "./fixtures.js";
import type { FakeBridge } from "./fake-bridge.js";

const teardown: (() => void)[] = [];

function mount(options: Parameters<typeof installBridge>[0] = {}): { h: Harness; fake: FakeBridge } {
  const fake = installBridge(options);
  const h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
  return { h, fake };
}

/** Which surface the sidebar says is showing. */
const activeSurface = (): string | null =>
  screen.getByRole("navigation", { name: "Surfaces" }).querySelector('[aria-current="page"]')?.textContent ?? null;

/** The landing bar a link leaves behind, whatever it says. */
const landing = (): HTMLElement | undefined =>
  screen.queryAllByRole("status").find((element) => element.textContent?.includes("Dismiss"));

beforeEach(() => {
  stubMatchMedia(1440);
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

describe("deep links", () => {
  it("opens the URL the window was started for, before anything is subscribed", async () => {
    mount({ deepLink: "orca://agent/claude" });

    await waitFor(() => expect(activeSurface()).toContain("Agents"));
    // A link that worked says nothing: the surface is the answer.
    expect(landing()).toBeUndefined();
  });

  it("opens a URL that arrives while the window is up, and lands it on the same surface", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });

    fake.link("orca://run/run-old/step/build.2");

    await waitFor(() => expect(activeSurface()).toContain("Runs"));
    expect(landing()).toBeUndefined();
  });

  it("selects the row the URL names, not only the surface it is on", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });

    // `run-parent`'s `build` ran twice. The attempt in the URL is the one a person meant.
    fake.link("orca://run/run-parent/step/build.1");

    const detail = await screen.findByRole("complementary", { name: "Step detail" });
    await waitFor(() => expect(detail.textContent).toContain("attempt 1"));
    expect(detail.textContent).toContain("build");
  });

  it("hands a linked run back to the reader until the same link is explicitly opened again", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });
    await act(async () => fake.link("orca://run/run-parent"));
    const tree = await screen.findByRole("tree", { name: "Run tree" });
    await waitFor(() => expect(tree.getAttribute("aria-activedescendant")).toBe("tree-row-run-parent"));

    fireEvent.click(document.getElementById("tree-row-run-old")!);
    await waitFor(() => expect(tree.getAttribute("aria-activedescendant")).toBe("tree-row-run-old"));
    // A chrome update must not turn the retained route into another navigation request.
    await act(async () => fake.connect({ ...fake.connection, orcaVersion: "updated" }));
    expect(tree.getAttribute("aria-activedescendant")).toBe("tree-row-run-old");

    await act(async () => fake.link("orca://run/run-parent"));
    await waitFor(() => expect(tree.getAttribute("aria-activedescendant")).toBe("tree-row-run-parent"));
  });

  it("applies a step link once and honors the same explicit step link again", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });
    await act(async () => fake.link("orca://run/run-parent/step/build.1"));
    const detail = await screen.findByRole("complementary", { name: "Step detail" });
    await waitFor(() => expect(detail.textContent).toContain("attempt 1"));
    const tree = screen.getByRole("tree", { name: "Run tree" });
    // Expand the linked run and choose the later attempt.
    fireEvent.keyDown(tree, { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() => expect(document.getElementById("tree-row-run-parent/s-build-2")).toBeTruthy());
    fireEvent.click(document.getElementById("tree-row-run-parent/s-build-2")!);
    await waitFor(() => expect(detail.textContent).toContain("attempt 2"));
    await act(async () => fake.connect({ ...fake.connection, orcaVersion: "updated" }));
    expect(detail.textContent).toContain("attempt 2");
    await act(async () =>
      fake.notify({
        kind: "notification",
        method: "step.changed",
        params: {
          subscriptionId: "sub-1",
          runId: "run-parent",
          seq: 40,
          at: AS_OF,
          stepRunId: "s-fan",
          status: "failed",
          event: "step.failed",
        },
      }),
    );
    expect(detail.textContent).toContain("attempt 2");

    await act(async () => fake.link("orca://run/run-parent/step/build.1"));
    await waitFor(() => expect(detail.textContent).toContain("attempt 1"));
  });

  it("lets a user selection supersede a step link whose projection is still loading", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });
    const release = fake.hold("runs.get");
    await act(async () => fake.link("orca://run/run-parent/step/build.1"));
    const tree = await screen.findByRole("tree", { name: "Run tree" });
    await waitFor(() => expect(tree.getAttribute("aria-activedescendant")).toBe("tree-row-run-parent"));
    // Choosing the run itself asks for its summary, superseding the pending step landing.
    fireEvent.click(document.getElementById("tree-row-run-parent")!);
    await act(async () => release());
    const detail = screen.getByRole("complementary", { name: "Step detail" });
    await waitFor(() => expect(detail.textContent).toContain("Variables ("));
    expect(detail.textContent).not.toContain("attempt 1");
  });

  it("takes the highest attempt when the URL names a node and no attempt", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });

    fake.link("orca://run/run-parent/step/build");

    const detail = await screen.findByRole("complementary", { name: "Step detail" });
    await waitFor(() => expect(detail.textContent).toContain("attempt 2"));
  });

  it("takes the waiting URL once, so a reload does not drag a person back", async () => {
    const { fake } = mount({ deepLink: "orca://run/run-old" });
    await waitFor(() => expect(activeSurface()).toContain("Runs"));
    expect(fake.bridge.deepLink.take()).toBeUndefined();
  });

  it("lands a link that arrives with no daemon answering, rather than dropping it", async () => {
    const { fake } = mount({ connection: { state: "disconnected", since: AS_OF } });
    await screen.findByRole("button", { name: "Attention" });

    fake.link("orca://run/run-old");

    await waitFor(() => expect(landing()?.textContent).toContain("No daemon is answering"));
    // On the object's own surface, with its id shown — never a blank window.
    expect(activeSurface()).toContain("Runs");
    expect(landing()?.textContent).toContain("run-old");
  });

  it("says so for a URL this version cannot open, and the landing can be dismissed", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });

    fake.link("orca://nonsense/1");

    await waitFor(() => expect(landing()?.textContent).toContain("orca://nonsense/1"));
    fireEvent.click(within(landing()!).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(landing()).toBeUndefined());
  });

  it("lands a config link on the document it names", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });

    fake.link("orca://config/permissions");

    await waitFor(() => expect(activeSurface()).toContain("Config"));
    // The sidecar has the keyboard: landing on a document means being in it, and a person
    // who followed that link did not ask for the YAML.
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("orca.permissions.json"));
    expect(landing()).toBeUndefined();
  });

  it("lands the bare config link in the YAML, which is the document it names", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });

    // `orca://config` is the configuration, and the configuration is `orca.config.yaml`
    // (`route-table.ts`). Landing on a document means being in it, so the bytes take the
    // keyboard rather than the form the person did not ask for.
    fake.link("orca://config");

    await waitFor(() => expect(activeSurface()).toContain("Config"));
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("orca.config.yaml"));
  });

  it("lands an item link on Plan, and says which item it is holding", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });

    fake.link("orca://item/wi-1");

    await waitFor(() => expect(activeSurface()).toContain("Plan"));
    // The surface is built as of #170, so the link lands on the schedule itself. `wi-1` is
    // not in this store's plan, which leaves the table as it is and the landing naming the
    // id — a link is never dropped because the object behind it is not there.
    await screen.findByRole("grid", { name: "Schedule" });
    await waitFor(() => expect(landing()?.textContent).toContain("No work item here matches"));
    expect(landing()?.textContent).toContain("wi-1");
  });

  it("dismisses the landing without leaving the place it landed", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });

    fake.link("orca://item/wi-1");
    await waitFor(() => expect(landing()?.textContent).toContain("wi-1"));
    fireEvent.click(within(landing()!).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(landing()).toBeUndefined());
    // The sentence goes; the surface the link opened stays.
    expect(activeSurface()).toContain("Plan");
    expect(screen.getByRole("grid", { name: "Schedule" })).toBeTruthy();
  });

  it("draws the landing under the object header, not across the sidebar", async () => {
    const { fake } = mount();
    await screen.findByRole("button", { name: "Attention" });

    fake.link("orca://nonsense/2");

    await waitFor(() => expect(landing()).toBeDefined());
    // Inside the primary pane, so the rail stays flush under the title bar.
    expect(landing()!.closest("main.orca-main")).not.toBeNull();
  });
});

describe("Copy link", () => {
  const crumbs = [
    { type: "run", id: "run-old", label: "SSO rollout" },
    { type: "step", id: "s-build-1", label: "build", current: true },
  ] as const;

  it("copies the canonical URL for the crumb it was opened from", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    teardown.push(() => Reflect.deleteProperty(navigator, "clipboard"));

    const h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    render(
      <Providers>
        <ObjectHeader crumbs={crumbs} />
      </Providers>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Links for build" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Copy link/ }));

    // The step's canonical form: node and attempt inside the run, per the route table.
    expect(writeText).toHaveBeenCalledWith("orca://run/run-old/step/build");
  });
});

describe("the object header's links, in the chrome", () => {
  /** Select a run that claims a work item, which is what puts a full trail in the header. */
  const selectARun = async (): Promise<HTMLElement> => {
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    const tree = await screen.findByRole("tree", { name: "Run tree" });
    const row = within(tree)
      .getAllByRole("treeitem")
      .find((item) => item.textContent?.includes("Add the SSO callback"));
    fireEvent.click(row!);
    return screen.findByRole("navigation", { name: "Object" });
  };

  it("opens a crumb through the route table", async () => {
    mount();
    const header = await selectARun();

    // The run is the current crumb, so the work item above it is the link to take.
    // The crumb itself, not its menu trigger: both carry the object's name.
    fireEvent.click(within(header).getAllByRole("button", { name: /Add the SSO callback/ })[0]!);

    await waitFor(() => expect(activeSurface()).toContain("Plan"));
    // `wi-1` is not in this store's plan, so the landing says which id the crumb was holding.
    await waitFor(() => expect(landing()?.textContent).toContain("wi-1"));
  });

  it("opens a folded crumb through the route table, from the trail's `…`", async () => {
    /* A pane too narrow for the trail: every crumb 200 wide in a trail 300 wide folds the
       work item between the request and the run. happy-dom lays nothing out, so the boxes
       the header measures are given here; everything else keeps happy-dom's zero box. */
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.matches(".orca-objhead__trail")
        ? 300
        : this.hasAttribute("data-orca-crumb")
          ? 200
          : this.matches(".orca-objhead__measure-row > li:last-child")
            ? 30
            : 0;
      return new DOMRect(0, 0, width, 0);
    });
    teardown.push(() => spy.mockRestore());

    mount();
    const header = await selectARun();
    const folded = await within(header).findByRole("button", {
      name: /^1 hidden level: work item Add the SSO callback/,
    });

    fireEvent.click(folded);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Add the SSO callback/ }));

    // Where the work item crumb itself goes: Plan, landing on the id it was holding.
    await waitFor(() => expect(activeSurface()).toContain("Plan"));
    await waitFor(() => expect(landing()?.textContent).toContain("wi-1"));
  });

  it("says which counterpart it cannot follow yet rather than swallowing the click", async () => {
    mount();
    const header = await selectARun();

    // The work item's menu: the request crumb before it has one too now (Copy id).
    fireEvent.click(within(header).getAllByRole("button", { name: /^Links for Add the SSO callback/ })[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Runs that attempted this/ }));

    await waitFor(() => expect(landing()?.textContent).toContain("not something this app can open yet"));
  });
});

describe("file mode", () => {
  it("names the store it is replaying and offers the way back to a daemon", async () => {
    const { fake } = mount({
      connection: { state: "file", since: AS_OF, capabilities: ["runs.read"] },
      workspace: { path: "/work/other", readOnly: true, source: "chosen" },
    });
    await screen.findByRole("button", { name: "Attention" });

    const banner = screen.getAllByRole("status").find((element) => element.textContent?.includes("Read-only replay"));
    expect(banner?.textContent).toContain("/work/other");
    // `◷ file mode · read-only` in the status bar, from the design's own presentation.
    expect(document.querySelector(".orca-conn")?.textContent).toContain("file mode");

    fireEvent.click(within(banner!).getByRole("button", { name: "Connect to a daemon" }));
    await waitFor(() => expect(fake.workspace.readOnly).toBe(false));
  });
});

describe("the palette's object rows", () => {
  const open = async (): Promise<void> => {
    await screen.findByRole("button", { name: "Attention" });
    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    await screen.findByRole("dialog", { name: "Command palette" });
  };
  const query = (): HTMLInputElement => screen.getByRole("combobox", { name: "Command palette" });
  /**
   * Scoped to the palette on purpose: the Attention surface behind it draws its failed runs
   * as `option` rows of its own (#161), so a store-wide query for a run's name matches the
   * palette row *and* the failure row and says only that two things are called the same.
   */
  const rows = (): ReturnType<typeof within> => within(screen.getByRole("dialog", { name: "Command palette" }));

  it("lists recent runs and agents under Navigation", async () => {
    mount();
    await open();

    expect(await rows().findByRole("option", { name: /SSO rollout/ })).toBeTruthy();
    // The agent rows say the host and the health beside the id: an agent nobody has
    // contacted is `unknown` rather than missing (#222).
    expect(await rows().findByRole("option", { name: /claude local/ })).toBeTruthy();
  });

  it("searches step and artifact names, and opening one goes through the route table", async () => {
    mount();
    await open();
    fireEvent.change(query(), { target: { value: "build" } });

    // Several runs have a `build` step; the first row is the one a person would take.
    const steps = await screen.findAllByRole("option", { name: /step in/ });
    fireEvent.mouseDown(steps[0]!);

    await waitFor(() => expect(activeSurface()).toContain("Runs"));
    expect(landing()).toBeUndefined();
  });

  it("does not search on a single character, which would list every step in the store", async () => {
    mount();
    await open();
    fireEvent.change(query(), { target: { value: "b" } });

    await waitFor(() => expect(screen.queryAllByRole("option", { name: /step in/ })).toHaveLength(0));
  });

  it("lists artifacts beside steps, addressed by the run that produced them", async () => {
    mount();
    await open();
    fireEvent.change(query(), { target: { value: "spec" } });

    const artifact = await screen.findByRole("option", { name: /artifact v/ });
    fireEvent.mouseDown(artifact);

    await waitFor(() => expect(activeSurface()).toContain("Runs"));
    expect(landing()).toBeUndefined();
  });

  it("is an empty palette rather than a broken one when the store cannot be read", async () => {
    const { fake } = mount();
    fake.fail("runs.list", { code: "AGENT_TRANSPORT", message: "no daemon" });
    fake.fail("agents.list", { code: "AGENT_TRANSPORT", message: "no daemon" });
    await open();
    fireEvent.change(query(), { target: { value: "build" } });

    await waitFor(() => expect(screen.queryAllByRole("option", { name: /step in/ })).toHaveLength(0));
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("forgets what it holds when the store says a run changed", async () => {
    const { fake } = mount();
    await open();
    await rows().findByRole("option", { name: /SSO rollout/ });
    const before = fake.calls.filter((call) => call.method === "runs.list").length;

    fake.notify({
      kind: "notification",
      method: "run.changed",
      params: {
        subscriptionId: "sub-1",
        runId: "run-old",
        seq: 1,
        at: AS_OF,
        status: "running",
        event: "run.started",
      },
    });
    fireEvent.change(query(), { target: { value: "SSO" } });

    // Read again, once: a notification drops the cache, it does not poll.
    await waitFor(() =>
      expect(fake.calls.filter((call) => call.method === "runs.list").length).toBeGreaterThan(before),
    );
  });

  it("jumps from a typed run id, through the same table", async () => {
    mount();
    await open();
    fireEvent.change(query(), { target: { value: "run_01J7K3QF8ZC4W2M6NP0XYTB5RD" } });

    fireEvent.mouseDown(await screen.findByRole("option", { name: /Open run/ }));

    await waitFor(() => expect(activeSurface()).toContain("Runs"));
    expect(landing()).toBeUndefined();
  });
});
