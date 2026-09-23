// @vitest-environment happy-dom
/**
 * The scroll sweep (#275): every surface, and the docked panel, mounted through the chrome
 * that mounts them, with the real stylesheets read off disk — and each one asked the one
 * question a surface author is currently free to forget. *Where does this scroll?*
 *
 * It is one file rather than an assertion on each surface's own test for the reason the
 * a11y sweep is: the claim is about the app, not about a component. `body` is
 * `overflow: hidden` and `.orca-window` is a fixed three-row grid, so a surface that
 * declares no scroller does not get a scrollbar — it gets content below the fold that has
 * no wheel, no scrollbar and no keyboard way down. Nothing fails; the content is simply not
 * there. That is a failure mode no per-surface test would ever notice, because each
 * surface's own test is about what it renders and this is about what happens to what it
 * rendered.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not measure.** happy-dom has no layout engine, so "is this taller than the
 *   window" is not a question it can answer. What is asserted instead is the *declaration*:
 *   a scroll region exists in the subtree, and the boxes above it are bounded so that the
 *   region has a height to scroll against. Both halves are needed — an `overflow-y: auto`
 *   under a parent that grew to its content scrolls nothing, which is exactly what the Plan
 *   inspector's own scroller was doing before this change.
 * - **It does not name the surfaces.** The sidebar is walked from `SURFACES`, which is
 *   `@orca/design`'s list, so the sixth surface is swept the day it is added.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { SURFACES } from "../src/chrome/surfaces.js";
import { PLAN_MODES } from "../src/plan/index.js";
import { FIVE_GATES, INPUTS_AS_OF, PERMISSION_ASK } from "./fixtures-inputs.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import { installDesignSystem, installSurfaceStyles, resolved } from "./themes.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

beforeEach(() => {
  stubMatchMedia(1440);
  installDesignSystem();
  installSurfaceStyles();
  fake = installBridge();
  teardown.push(fake.install());
  /* Two cards and a handful of failures: the shape that overflows. The cards are the point
     — they are the one list in the app that is not fixed-height and not virtualised. */
  const inputs = [PERMISSION_ASK, ...FIVE_GATES];
  fake.script({
    "inputs.list": () => ({ ok: true, result: { inputs, waiting: inputs.length, asOf: INPUTS_AS_OF } }),
  });
  h = harness();
  teardown.push(h.dispose);
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

/**
 * Whether a box is a scroll region in the block direction. Both the longhand and the
 * shorthand are read: `overflow: auto` and `overflow-y: auto` are the same statement, and
 * which one a stylesheet used is not the sweep's business.
 */
function scrolls(element: Element): boolean {
  const scrollable = new Set(["auto", "scroll", "overlay"]);
  return scrollable.has(resolved(element, "overflow-y")) || scrollable.has(resolved(element, "overflow"));
}

/** Every scroll region in a subtree, the root included. */
function scrollers(root: Element): HTMLElement[] {
  const all = [root, ...root.querySelectorAll("*")];
  return all.filter((el): el is HTMLElement => el instanceof HTMLElement && scrolls(el));
}

/**
 * Whether a box cannot be pushed past the height it was given.
 *
 * The thing being looked for is `min-height: auto`, which is the *default* for a flex or
 * grid item and means "at least as tall as your content" — the one declaration that lets a
 * child stretch a column past the window. Any explicit `min-height` overrides it, a floor
 * (`calc(var(--row-h) * 6)`) as much as a zero, because the automatic minimum is gone
 * either way and the container's height governs from there. A definite `height` bounds a
 * box without needing any of it.
 */
function bounded(element: Element): boolean {
  const min = resolved(element, "min-height");
  if (min !== "" && min !== "auto") return true;
  const height = resolved(element, "height");
  return height !== "" && height !== "auto";
}

const pane = (): HTMLElement => document.querySelector<HTMLElement>(".orca-main")!;

/** What the pane renders below the optional object header: the surface's own root. */
const surfaceRoot = (): HTMLElement => pane().lastElementChild as HTMLElement;

/** Go to a surface the way a person does, and wait for it to have rendered something. */
async function goTo(label: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: label }));
  await screen.findByRole("main");
}

describe("the shell is bounded, so a scroller has something to scroll against", () => {
  it("keeps the primary pane and the dock inside the window rather than letting them grow", async () => {
    renderChrome(h);
    await screen.findByRole("main");

    /* The fix that makes every other assertion in this file mean anything. A grid item's
       automatic minimum size is its content, so without `min-height: 0` a tall surface
       stretches this column past the window instead of being bounded by it — and then an
       `overflow-y: auto` inside it has an infinite height and never scrolls. */
    expect(bounded(pane())).toBe(true);

    fireEvent.keyDown(window, { key: "\\", code: "Backslash", metaKey: true });
    await screen.findByText("Nothing pinned");
    const panel = document.querySelector<HTMLElement>(".orca-panel")!;
    expect(bounded(panel)).toBe(true);
  });

  it("puts the dock's scroll in its body, not on the column that clips the animation", async () => {
    renderChrome(h);
    await screen.findByRole("main");
    fireEvent.keyDown(window, { key: "\\", code: "Backslash", metaKey: true });
    await screen.findByText("Nothing pinned");

    const panel = document.querySelector<HTMLElement>(".orca-panel")!;
    const body = panel.querySelector<HTMLElement>(".orca-panel__body")!;

    /* The panel's own `overflow: hidden` is the clip that keeps the enter animation and the
       overlay's shadow inside the column. If it were the scroller, the head would scroll
       away with the content it labels. */
    expect(scrolls(panel)).toBe(false);
    expect(scrolls(body)).toBe(true);
    // And the head is outside it, which is what "the head stays put" means structurally.
    expect(body.contains(panel.querySelector(".orca-pane__head"))).toBe(false);
    // Whatever the dock is showing is inside the region, whichever of the three it is.
    expect(body.textContent).toContain("Nothing pinned");
  });
});

describe("every surface declares where it scrolls", () => {
  for (const surface of SURFACES) {
    it(`${surface.label} has a scroll region under the pane`, async () => {
      renderChrome(h);
      await goTo(surface.label);

      /* Waited for rather than read once: a surface that reads the daemon renders a
         loading state first, and the scroll region arrives with the content it holds. */
      await waitFor(() => expect(scrollers(surfaceRoot()).length).toBeGreaterThan(0));

      /* Every box between a scroll region and the pane has to be bounded too, or the
         region inherits a height that grew to its content and scrolls nothing — which is
         what the Plan inspector's own `overflow-y` was doing before this change. */
      for (const region of scrollers(surfaceRoot())) {
        for (let box = region.parentElement; box !== null && box !== pane(); box = box.parentElement) {
          expect(bounded(box), `${box.className || box.tagName} is between a scroller and the pane, unbounded`).toBe(
            true,
          );
        }
      }
    });
  }

  /* Plan is one surface with several modes, and each mode is its own layout (#171–#173):
     the risk matrix over its register, the decision table, the graph over its strip. Walked
     from `PLAN_MODES`, so a mode is swept the day it is added, as a surface is. */
  for (const mode of PLAN_MODES) {
    it(`Plan's ${mode.label} mode has a bounded scroll region`, async () => {
      renderChrome(h);
      await goTo("Plan");
      fireEvent.click(await screen.findByRole("button", { name: mode.label }));
      const plan = await waitFor(() => {
        const root = document.querySelector<HTMLElement>(".orca-plan__pane");
        expect(root).toBeTruthy();
        return root!;
      });
      await waitFor(() => expect(scrollers(plan).length).toBeGreaterThan(0));
      for (const region of scrollers(plan)) {
        for (let box = region.parentElement; box !== null && box !== pane(); box = box.parentElement) {
          expect(bounded(box), `${box.className || box.tagName} is between a scroller and the pane, unbounded`).toBe(
            true,
          );
        }
      }
    });
  }

  it("scrolls the Attention surface at its root, because its cards are not rows", async () => {
    renderChrome(h);
    await goTo("Attention");

    /* The worst instance the issue found, asserted by name rather than by the loop above:
       a gate card carries a question, its consequences and its controls, so five of them
       are taller than the window — and this is the one screen whose entire job is showing
       what is blocked on a person. It scrolls at the root because it is a stack of content
       rather than its own split layout. */
    const root = document.querySelector<HTMLElement>(".orca-attn-surface")!;
    expect(scrolls(root)).toBe(true);
    expect(resolved(root, "flex-grow")).toBe("1");
  });
});

describe("one scroller per scroll", () => {
  it("never nests a scroll region inside the virtual list's", async () => {
    renderChrome(h);

    for (const surface of SURFACES) {
      await goTo(surface.label);
      for (const scroller of document.querySelectorAll(".orca-list__scroller")) {
        /* The second-scroller trap (`components.css`, the log pane's note): the substrate
           windows rows against *its* scroller, and a scroller inside it takes the wheel,
           breaks the arithmetic and hides the rows it was supposed to show. The list's own
           row elements are the only thing under here. */
        const nested = scrollers(scroller).filter((el) => el !== scroller);
        expect(nested.map((el) => el.className)).toEqual([]);
      }
    }
  });
});
