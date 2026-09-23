// @vitest-environment happy-dom
/**
 * The pane boundaries' arithmetic (#276): the registry, the clamp, and the one place a size is
 * written onto the document. A plain module with a plain test, like `list-window.ts` and
 * `layout.ts` — the component over it (`chrome/pane-splitter.tsx`) has its own file.
 *
 * The clamp is the half worth testing hardest, because it is what makes a drag safe: a pane
 * that could be dragged to nothing, or that could squeeze the pane opposite to nothing, is the
 * failure this feature would introduce rather than fix.
 */
import { describe, expect, it } from "vitest";
import { PANE_GEOMETRY } from "@orca/design";
import {
  PANE_BOUNDARIES,
  PANE_IDS,
  PANE_STEP,
  applyPaneSize,
  clampPaneSize,
  dragPaneSize,
  keyPaneSize,
  paneExtent,
  panePreferenceOf,
  panePx,
  readPaneSize,
} from "../src/panes.js";

const SIDEBAR = PANE_BOUNDARIES.sidebar;
const PANEL = PANE_BOUNDARIES.panel;
const TREE = PANE_BOUNDARIES["runs-tree"];

describe("pane boundaries", () => {
  it("names one custom property per boundary, and one id per remembered size", () => {
    const properties = PANE_IDS.map((id) => PANE_BOUNDARIES[id].property);
    expect(new Set(properties).size).toBe(properties.length);
    // Every property is `--pane-<id>`, so a stylesheet's track and the preferences key agree.
    for (const id of PANE_IDS) expect(PANE_BOUNDARIES[id].property).toBe(`--pane-${id}`);
  });

  it("takes its limits from the tokens rather than from a number written here", () => {
    expect(SIDEBAR.min).toBe(PANE_GEOMETRY["pane-min-sidebar"]);
    expect(PANEL.max).toBe(PANE_GEOMETRY["pane-max-side"]);
    expect(PANE_STEP).toBe(PANE_GEOMETRY["pane-step"]);
    /* The stacked boundary is the one with no ceiling and no default token: its default is the
       stylesheet's `2fr`, which is not a length, and the container is its only ceiling. */
    expect(TREE.max).toBeUndefined();
    expect(TREE.token).toBeUndefined();
  });

  it("says which boundaries are a length and which is a ratio, and names each one", () => {
    /* The four column boundaries are lengths, because a side pane is sized to what it holds.
       The stacked one is a ratio, because its two halves are not (#281). */
    expect(PANE_IDS.filter((id) => PANE_BOUNDARIES[id].size === "fraction")).toEqual(["runs-tree", "plan-risk"]);
    expect(PANE_IDS.filter((id) => PANE_BOUNDARIES[id].orientation === "horizontal")).toEqual([
      "runs-tree",
      "plan-risk",
    ]);
    // Every boundary has something a person would call it: the preferences section lists them.
    for (const id of PANE_IDS) expect(PANE_BOUNDARIES[id].label).not.toBe("");
  });
});

describe("a preference and the px it means", () => {
  it("leaves a length alone in both directions, with or without a container", () => {
    expect(panePx(SIDEBAR, 268, 1400)).toBe(268);
    expect(panePx(SIDEBAR, 268, 0)).toBe(268);
    expect(panePreferenceOf(SIDEBAR, 268.4, 1400)).toBe(268);
    expect(panePreferenceOf(SIDEBAR, 268.4, 0)).toBe(268);
  });

  it("turns a stacked boundary into a share of its container, and back", () => {
    expect(panePreferenceOf(TREE, 320, 800)).toBe(0.4);
    expect(panePx(TREE, 0.4, 800)).toBe(320);
    // The same choice on a shorter column is the same split rather than the same height.
    expect(panePx(TREE, 0.4, 500)).toBe(200);
  });

  it("keeps a fraction strictly inside its own range, whatever the clamp handed it", () => {
    /* A container too small for two panes has `clampPaneSize` return the floor, which can be
       more than the container — "more than all of it" is not a ratio, and the schema rejects
       1 as much as 0. */
    expect(panePreferenceOf(TREE, 900, 400)).toBeLessThan(1);
    expect(panePreferenceOf(TREE, 0, 400)).toBeGreaterThan(0);
  });

  it("answers nothing for a ratio with no container to be a ratio of", () => {
    // Which is every container under happy-dom, and every one before the first layout.
    expect(panePx(TREE, 0.4, 0)).toBeUndefined();
    expect(panePreferenceOf(TREE, 320, 0)).toBeUndefined();
    expect(panePx(TREE, undefined, 800)).toBeUndefined();
  });
});

describe("clampPaneSize", () => {
  it("keeps a size inside the design's range", () => {
    expect(clampPaneSize(PANEL, 500, 2000)).toBe(500);
    expect(clampPaneSize(PANEL, 40, 2000)).toBe(PANEL.min);
    expect(clampPaneSize(PANEL, 5000, 5000)).toBe(PANEL.max);
  });

  it("also leaves the pane opposite its own floor, whatever the design's ceiling says", () => {
    // 900px of window and a 320px floor: the widest the dock may be is 580, not the token's 720.
    expect(clampPaneSize(PANEL, 700, 900)).toBe(580);
  });

  it("gives the floor to a container too small for both, rather than a pane of nothing", () => {
    expect(clampPaneSize(PANEL, 500, 400)).toBe(PANEL.min);
  });

  it("applies the design's limits only, for a container that has not been laid out", () => {
    // Which is every container under happy-dom, and every one on the first render in a browser.
    expect(clampPaneSize(PANEL, 900, 0)).toBe(PANEL.max);
    expect(clampPaneSize(TREE, 900, 0)).toBe(900);
  });
});

describe("dragPaneSize", () => {
  it("grows a leading pane as the pointer moves away from it", () => {
    expect(dragPaneSize(SIDEBAR, 228, 40, 2000)).toBe(268);
    expect(dragPaneSize(SIDEBAR, 228, -40, 2000)).toBe(188);
  });

  it("grows a trailing pane as the pointer moves towards it", () => {
    // The dock is on the right: dragging its edge left is asking for more of it.
    expect(dragPaneSize(PANEL, 420, -60, 2000)).toBe(480);
    expect(dragPaneSize(PANEL, 420, 60, 2000)).toBe(360);
  });

  it("clamps the drag rather than the pointer", () => {
    // A pointer that has left the window entirely still leaves a usable pane behind it.
    expect(dragPaneSize(SIDEBAR, 228, -9000, 2000)).toBe(SIDEBAR.min);
    expect(dragPaneSize(SIDEBAR, 228, 9000, 2000)).toBe(SIDEBAR.max);
  });
});

describe("keyPaneSize", () => {
  it("moves a column boundary with the left and right arrows and nothing else", () => {
    expect(keyPaneSize(SIDEBAR, "ArrowRight", 228, 2000)).toBe(228 + PANE_STEP);
    expect(keyPaneSize(SIDEBAR, "ArrowLeft", 228, 2000)).toBe(228 - PANE_STEP);
    // The two keys the other axis owns do nothing here, so they stay the scroller's.
    expect(keyPaneSize(SIDEBAR, "ArrowUp", 228, 2000)).toBeUndefined();
    expect(keyPaneSize(SIDEBAR, "ArrowDown", 228, 2000)).toBeUndefined();
    expect(keyPaneSize(SIDEBAR, "Home", 228, 2000)).toBeUndefined();
  });

  it("moves a stacked boundary with the up and down arrows", () => {
    expect(keyPaneSize(TREE, "ArrowDown", 300, 900)).toBe(300 + PANE_STEP);
    expect(keyPaneSize(TREE, "ArrowUp", 300, 900)).toBe(300 - PANE_STEP);
    expect(keyPaneSize(TREE, "ArrowRight", 300, 900)).toBeUndefined();
  });

  it("presses towards the pane's own edge to shrink it, whichever side it is on", () => {
    // Trailing: the dock is on the right, so `←` is more of it — the way the pointer would go.
    expect(keyPaneSize(PANEL, "ArrowLeft", 420, 2000)).toBe(420 + PANE_STEP);
    expect(keyPaneSize(PANEL, "ArrowRight", 420, 2000)).toBe(420 - PANE_STEP);
  });

  it("stops at the same limits a drag stops at", () => {
    expect(keyPaneSize(SIDEBAR, "ArrowLeft", SIDEBAR.min, 2000)).toBe(SIDEBAR.min);
    expect(keyPaneSize(TREE, "ArrowUp", TREE.min, 900)).toBe(TREE.min);
  });
});

describe("applyPaneSize", () => {
  it("writes the size onto the container as its custom property, in whole pixels", () => {
    const host = document.createElement("div");
    applyPaneSize(host, SIDEBAR, 268.4);
    expect(host.style.getPropertyValue("--pane-sidebar")).toBe("268px");
    expect(readPaneSize(host, SIDEBAR)).toBe(268);
  });

  it("removes the property to hand the boundary back to its default", () => {
    const host = document.createElement("div");
    applyPaneSize(host, SIDEBAR, 268);
    applyPaneSize(host, SIDEBAR, undefined);
    /* Removed, never set to the token's value: an unset property *is* the default, so the
       stylesheet's `var(--pane-sidebar, var(--sidebar-width))` keeps one statement of it. */
    expect(host.getAttribute("style") ?? "").not.toContain("--pane-sidebar");
    expect(readPaneSize(host, SIDEBAR)).toBeUndefined();
  });

  it("writes a stacked boundary as a percentage, which is what travels between two heights", () => {
    const host = document.createElement("div");
    applyPaneSize(host, TREE, 336, 800);
    expect(host.style.getPropertyValue("--pane-runs-tree")).toBe("42.00%");
    // And reads back as the px it was, given the same container it was written against.
    expect(readPaneSize(host, TREE, 800)).toBe(336);
  });

  it("leaves the stylesheet's own fraction in place while there is nothing to measure", () => {
    /* `2fr` is a better answer than a percentage of nothing: the default holds until the
       container has a height, rather than the pane collapsing for one frame. */
    const host = document.createElement("div");
    applyPaneSize(host, TREE, 336, 0);
    expect(host.getAttribute("style") ?? "").not.toContain("--pane-runs-tree");
  });
});

describe("paneExtent", () => {
  it("measures the axis the boundary moves on", () => {
    const host = document.createElement("div");
    host.getBoundingClientRect = () => ({ width: 1400, height: 800 }) as DOMRect;
    expect(paneExtent(host, SIDEBAR)).toBe(1400);
    expect(paneExtent(host, TREE)).toBe(800);
  });
});
