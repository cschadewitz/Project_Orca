// @vitest-environment happy-dom
/**
 * The splitter itself (#276): the control, its keys, what it writes onto the container and what
 * it remembers. The arithmetic behind it is `panes.test.ts`.
 *
 * **What this cannot see.** happy-dom has no layout and no input modality, so every rect here is
 * stubbed and a pointer drag is not a thing this environment can perform — the real drag, the
 * real cursor and the real width are checked in `test/smoke/app-shell.spec.ts`, in an Electron
 * window. What is asserted here is everything that is markup, state or a preference: the
 * separator's role and range, the arrow keys, the restore, the clamp on mount, and which
 * boundaries the app actually offers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import type { JSX } from "react";
import { PaneSplitter } from "../src/chrome/pane-splitter.js";
import { PANE_BOUNDARIES, type PaneId } from "../src/panes.js";
import type { BridgeResult } from "../../src/bridge.js";
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  type Preferences,
  type PreferencesPatch,
} from "../../src/preferences/schema.js";
import { LIVE, harness, installBridge, renderChrome, stubBridge, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import type { AppearanceStore } from "../src/appearance.js";

const teardown: (() => void)[] = [];
let rects: () => void;

/**
 * A layout, since happy-dom has none: every element measures what its `data-w`/`data-h` say and
 * nothing else measures at all. The splitter reads the container's box for the extent and the
 * sibling's for the size it is starting from, so those two attributes are the whole geometry.
 */
function stubRects(): () => void {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const width = Number(this.getAttribute("data-w") ?? 0);
    const height = Number(this.getAttribute("data-h") ?? 0);
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
  };
  return () => {
    if (original) Object.defineProperty(Element.prototype, "getBoundingClientRect", original);
  };
}

/** A preferences store that records what was written, so persistence is assertable. */
function recordingStore(panes: Record<string, number> = {}): {
  store: AppearanceStore;
  writes: PreferencesPatch[];
  read: () => Preferences;
} {
  let current: Preferences = { ...DEFAULT_PREFERENCES, panes };
  const writes: PreferencesPatch[] = [];
  return {
    store: {
      read: () => current,
      write: (patch: PreferencesPatch): Promise<BridgeResult<Preferences>> => {
        writes.push(patch);
        current = mergePreferences(current, patch);
        return Promise.resolve({ ok: true, result: current });
      },
    },
    writes,
    read: () => current,
  };
}

interface HostProps {
  boundary: PaneId;
  /** The container's extent along the axis, and the sized pane's own measurement. */
  extent: number;
  pane: number;
}

/**
 * The shape every splitter in the app stands in: a container, the pane it sizes, and the
 * splitter between them. Which sibling is the sized one is the registry's, so both are here.
 */
function Host({ boundary, extent, pane }: HostProps): JSX.Element {
  const spec = PANE_BOUNDARIES[boundary];
  const across = spec.orientation === "vertical";
  const size = (px: number) => (across ? { "data-w": px, "data-h": 400 } : { "data-w": 400, "data-h": px });
  const leading = spec.edge === "leading" ? pane : extent - pane;
  return (
    <div data-testid="host" {...size(extent)}>
      <div data-testid="leading" {...size(leading)} />
      <PaneSplitter boundary={boundary} label="Resize the pane" />
      <div data-testid="trailing" {...size(spec.edge === "leading" ? extent - pane : pane)} />
    </div>
  );
}

function mount(props: HostProps, panes: Record<string, number> = {}): ReturnType<typeof recordingStore> {
  const recorder = recordingStore(panes);
  const h = harness("darwin", recorder.store);
  teardown.push(h.dispose);
  render(
    <h.Providers>
      <Host {...props} />
    </h.Providers>,
  );
  return recorder;
}

const host = (): HTMLElement => screen.getByTestId("host");
const splitter = (): HTMLElement => screen.getByRole("separator", { name: "Resize the pane" });
const applied = (boundary: PaneId): string => host().style.getPropertyValue(PANE_BOUNDARIES[boundary].property);

beforeEach(() => {
  stubMatchMedia(1440);
  rects = stubRects();
});

afterEach(() => {
  cleanup();
  rects();
  while (teardown.length) teardown.pop()?.();
});

describe("the splitter as a control", () => {
  it("is a separator with a tab stop, the axis it moves on and the range it may take", () => {
    mount({ boundary: "panel", extent: 1400, pane: 420 });
    const handle = splitter();

    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    expect(handle.getAttribute("aria-valuemin")).toBe(String(PANE_BOUNDARIES.panel.min));
    expect(handle.getAttribute("aria-valuemax")).toBe(String(PANE_BOUNDARIES.panel.max));
  });

  it("says the window's ceiling rather than the design's when the window is the lower one", () => {
    // 900px of window, a 320px floor opposite: 580 is as wide as the dock can go here.
    mount({ boundary: "panel", extent: 900, pane: 420 });
    expect(splitter().getAttribute("aria-valuemax")).toBe("580");
  });

  it("is a horizontal separator where the panes are stacked", () => {
    mount({ boundary: "runs-tree", extent: 800, pane: 320 });
    expect(splitter().getAttribute("aria-orientation")).toBe("horizontal");
    expect(splitter().getAttribute("aria-valuenow")).toBe("320");
  });
});

describe("resizing from the keyboard", () => {
  it("moves the boundary one step per arrow press and remembers where it stopped", () => {
    const prefs = mount({ boundary: "sidebar", extent: 1400, pane: 228 });

    fireEvent.keyDown(splitter(), { key: "ArrowRight" });

    expect(applied("sidebar")).toBe("244px");
    expect(prefs.writes).toEqual([{ panes: { sidebar: 244 } }]);
    expect(splitter().getAttribute("aria-valuenow")).toBe("244");
  });

  it("presses towards a trailing pane to widen it", () => {
    const prefs = mount({ boundary: "panel", extent: 1400, pane: 420 });

    fireEvent.keyDown(splitter(), { key: "ArrowLeft" });

    expect(applied("panel")).toBe("436px");
    expect(prefs.writes).toEqual([{ panes: { panel: 436 } }]);
  });

  it("uses the other axis's arrows for a stacked boundary, and leaves this one's alone", () => {
    const prefs = mount({ boundary: "runs-tree", extent: 800, pane: 320 });

    fireEvent.keyDown(splitter(), { key: "ArrowRight" });
    expect(prefs.writes).toEqual([]);

    fireEvent.keyDown(splitter(), { key: "ArrowDown" });
    expect(applied("runs-tree")).toBe("336px");
  });

  it("will not step past the floor, however many times it is pressed", () => {
    const prefs = mount({ boundary: "sidebar", extent: 1400, pane: 228 }, { sidebar: PANE_BOUNDARIES.sidebar.min });

    fireEvent.keyDown(splitter(), { key: "ArrowLeft" });

    expect(applied("sidebar")).toBe(`${PANE_BOUNDARIES.sidebar.min}px`);
    expect(prefs.read().panes.sidebar).toBe(PANE_BOUNDARIES.sidebar.min);
  });
});

describe("back to the default", () => {
  it("forgets the size on Enter, rather than writing the token's value back", () => {
    const prefs = mount({ boundary: "panel", extent: 1400, pane: 420 }, { panel: 600 });
    expect(applied("panel")).toBe("600px");

    fireEvent.keyDown(splitter(), { key: "Enter" });

    // The property is gone, so the stylesheet's fallback — the token — is the width again.
    expect(applied("panel")).toBe("");
    expect(prefs.writes).toEqual([{ panes: { panel: null } }]);
    expect(prefs.read().panes.panel).toBeUndefined();
  });

  it("does the same on a double-click, which is the pointer's way to say it", () => {
    const prefs = mount({ boundary: "panel", extent: 1400, pane: 420 }, { panel: 600 });

    fireEvent.doubleClick(splitter());

    expect(applied("panel")).toBe("");
    expect(prefs.writes).toEqual([{ panes: { panel: null } }]);
  });
});

describe("a size that was remembered", () => {
  it("is applied the moment the splitter is in the document, before anything is dragged", () => {
    mount({ boundary: "panel", extent: 1400, pane: 420 }, { panel: 520 });
    expect(applied("panel")).toBe("520px");
  });

  it("is applied as far as the window allows, and is not overwritten by what fitted", () => {
    // 900px of window against a 700px dock: 580 is applied, 700 is still what was asked for.
    const prefs = mount({ boundary: "panel", extent: 900, pane: 420 }, { panel: 700 });
    expect(applied("panel")).toBe("580px");
    expect(prefs.read().panes.panel).toBe(700);
    expect(prefs.writes).toEqual([]);
  });
});

describe("the boundaries the app offers", () => {
  let fake: FakeBridge;

  beforeEach(() => {
    fake = installBridge();
    teardown.push(fake.install());
  });

  const chrome = (): RenderResult => {
    const h: Harness = harness();
    teardown.push(h.dispose);
    return renderChrome(h);
  };

  it("offers the sidebar's boundary, and none where the rail is collapsed instead", async () => {
    chrome();
    await screen.findByRole("button", { name: "Attention" });
    expect(screen.getByRole("separator", { name: "Resize the sidebar" })).toBeTruthy();

    cleanup();
    // Below `bp-sidebar-collapse` the width is the breakpoint's, so there is nothing to drag.
    stubMatchMedia(900);
    chrome();
    await screen.findByRole("button", { name: "Attention" });
    expect(screen.queryByRole("separator", { name: "Resize the sidebar" })).toBeNull();
  });

  it("offers the dock's boundary with the dock, and not while it is an overlay", async () => {
    chrome();
    await screen.findByRole("button", { name: "Attention" });
    expect(screen.queryByRole("separator", { name: "Resize the panel" })).toBeNull();

    fireEvent.keyDown(window, { key: "\\", code: "Backslash", metaKey: true });
    expect(await screen.findByRole("separator", { name: "Resize the panel" })).toBeTruthy();

    cleanup();
    // Below `bp-panel-overlay` the panel floats over the pane rather than trading width with it.
    stubMatchMedia(1000);
    chrome();
    await screen.findByRole("button", { name: "Attention" });
    fireEvent.keyDown(window, { key: "\\", code: "Backslash", metaKey: true });
    await screen.findByText("Nothing pinned");
    expect(screen.queryByRole("separator", { name: "Resize the panel" })).toBeNull();
  });

  it("offers both of the Runs surface's, so the tree and the detail can be traded for", async () => {
    chrome();
    await screen.findByRole("button", { name: "Attention" });
    fireEvent.keyDown(window, { key: "2", code: "Digit2", metaKey: true });
    await screen.findByRole("tree", { name: "Run tree" });

    expect(screen.getByRole("separator", { name: "Resize the run tree" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize the step detail" })).toBeTruthy();
  });

  it("offers the Plan surface's request rail", async () => {
    chrome();
    await screen.findByRole("button", { name: "Attention" });
    fireEvent.keyDown(window, { key: "3", code: "Digit3", metaKey: true });
    await screen.findByRole("navigation", { name: "Requests and filters" });

    expect(screen.getByRole("separator", { name: "Resize the requests rail" })).toBeTruthy();
  });
});

describe("with no daemon answering", () => {
  it("still offers the chrome's boundaries: the layout is not the connection's business", async () => {
    const fake = stubBridge(() => Promise.resolve(LIVE));
    teardown.push(fake.install());
    const h = harness();
    teardown.push(h.dispose);
    renderChrome(h);
    await screen.findByRole("button", { name: "Attention" });
    expect(screen.getByRole("separator", { name: "Resize the sidebar" })).toBeTruthy();
  });
});
