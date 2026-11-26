// @vitest-environment happy-dom
/**
 * The graph canvas's view controls, on the workflow viewer's canvas: the zoom group in the
 * corner, zoom to fit, the ⌘/Ctrl wheel, the layout direction and the minimap.
 *
 * happy-dom has no layout, so the viewport's size is injected the way `Menu`'s tests inject
 * rectangles — `measure` — and every position asserted is computed from the same plain
 * functions the canvas uses (`layout.ts`, `ui/canvas-view.ts`) rather than restated. What is
 * asserted here is the wiring: that a button and a key are one zoom, that the toggles re-lay
 * the graph and are remembered as a person's preference, and that the minimap's rectangle is
 * where the view is and moves it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type JSX } from "react";
import { GRAPH_GEOMETRY } from "@orca/design";
import type { WorkflowView } from "@orca/protocol";
import {
  REST,
  centreOn,
  fitView,
  fromMinimap,
  minimapGeometry,
  toMinimap,
  visibleRect,
  wheelZoomFactor,
  zoomAt,
  type CanvasView,
} from "../src/ui/canvas-view.js";
import { MINIMAP_BOX } from "../src/ui/graph-minimap.js";
import { WorkflowCanvas, nodeDomId } from "../src/workflow/workflow-canvas.js";
import { layoutWorkflow, toDirection, type GraphMetrics, type LayoutDirection } from "../src/workflow/layout.js";
import { AI_SDLC } from "./fixtures-workflows.js";
import { harness, type Harness } from "./harness.js";

const METRICS: GraphMetrics = {
  nodeW: GRAPH_GEOMETRY["node-w"],
  nodeH: GRAPH_GEOMETRY["node-h"],
  layerGap: GRAPH_GEOMETRY["layer-gap"],
  rankGap: GRAPH_GEOMETRY["rank-gap"],
};
const PAD = METRICS.rankGap;
const VIEWPORT = { width: 800, height: 600 };

/** The drawing's extent, margin included, as the canvas computes it. */
const contentOf = (workflow: WorkflowView, direction: LayoutDirection = "horizontal") => {
  const layout = layoutWorkflow(workflow, METRICS, direction);
  return { width: layout.width + PAD * 2, height: layout.height + PAD * 2 };
};

/** The scene's transform for a view, in the one spelling the canvas writes it. */
const transformOf = (view: CanvasView): string => `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.scale})`;

let h: Harness;
const teardown: (() => void)[] = [];

beforeEach(() => {
  h = harness();
  teardown.push(h.dispose);
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

/** The canvas the viewer mounts, with the surface's selection and expansion around it. */
function Canvas({
  workflow = AI_SDLC,
  size = VIEWPORT,
}: {
  workflow?: WorkflowView;
  size?: typeof VIEWPORT;
}): JSX.Element {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <WorkflowCanvas
      workflow={workflow}
      selected={selected}
      onSelect={setSelected}
      expanded={expanded}
      onToggleExpanded={(id) =>
        setExpanded((open) => {
          const next = new Set(open);
          if (!next.delete(id)) next.add(id);
          return next;
        })
      }
      label={`${workflow.name} graph`}
      measure={() => size}
    />
  );
}

async function mount({ atRest = true, size = VIEWPORT } = {}): Promise<{
  viewport: HTMLElement;
  scene: HTMLElement;
  controls: HTMLElement;
}> {
  const { Providers } = h;
  render(
    <Providers>
      <Canvas size={size} />
    </Providers>,
  );
  const viewport = screen.getByRole("listbox", { name: `${AI_SDLC.name} graph` });
  // The keys are registered from an effect; one empty act lets every press below meet them.
  await act(async () => {});
  // ai-sdlc is wider than the canvas, so it opens fitted (#1112); the tests of the controls
  // start from rest, which is `0`.
  if (atRest) press(viewport, "0", "Digit0");
  return {
    viewport,
    scene: viewport.querySelector<HTMLElement>(".orca-wfcanvas__scene")!,
    controls: screen.getByRole("group", { name: `${AI_SDLC.name} graph view` }),
  };
}

/** A key, pressed where the focus is — the canvas — so it resolves in the `workflow` scope. */
function press(target: HTMLElement, key: string, code: string, shiftKey = false): void {
  act(() => target.focus());
  fireEvent.keyDown(target, { key, code, shiftKey });
}

const button = (controls: HTMLElement, name: string | RegExp): HTMLElement =>
  within(controls).getByRole("button", { name });

interface WheelInit {
  deltaX?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  clientX?: number;
  clientY?: number;
}

/**
 * A wheel event as Chromium sends one, dispatched on `target`; returns whether it went
 * unprevented, as `fireEvent` does. happy-dom's `WheelEvent` is a `UIEvent` with deltas and
 * nothing else — no modifiers, no pointer position — so those are put on the event here
 * rather than left `undefined`, which would make every ⌘-wheel read as a plain one.
 */
function wheel(target: HTMLElement, init: WheelInit): boolean {
  const { deltaX = 0, deltaY = 0, ...rest } = init;
  const event = new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true });
  const modifiers = { ctrlKey: false, metaKey: false, shiftKey: false, clientX: 0, clientY: 0, ...rest };
  for (const [name, value] of Object.entries(modifiers)) Object.defineProperty(event, name, { value });
  let unprevented = true;
  act(() => {
    unprevented = target.dispatchEvent(event);
  });
  return unprevented;
}

describe("the zoom controls", () => {
  /* #1112: a wide graph opened at 100% showed its first few nodes and nothing to say there was
     more. It opens fitted; a graph that fits at 100% opens at rest. */
  it("opens a graph wider than the canvas fitted, and one that fits at rest", async () => {
    const wide = await mount({ atRest: false });
    expect(wide.scene.style.transform).toBe(transformOf(fitView(contentOf(AI_SDLC), VIEWPORT)));
    cleanup();

    const roomy = { width: contentOf(AI_SDLC).width + 100, height: contentOf(AI_SDLC).height + 100 };
    const fits = await mount({ atRest: false, size: roomy });
    expect(fits.scene.style.transform).toBe(transformOf(REST));
  });

  it("are the same zoom as the keys: a click and a press move one state, about the canvas's middle", async () => {
    const { viewport, scene, controls } = await mount();
    const middle = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    expect(scene.style.transform).toBe(transformOf(REST));
    expect(button(controls, /^Reset the zoom and the pan/).textContent).toBe("100%");

    // The button zooms in about the middle of the canvas …
    fireEvent.click(button(controls, "Zoom in"));
    const in1 = zoomAt(REST, 1.5, middle);
    expect(scene.style.transform).toBe(transformOf(in1));
    expect(button(controls, /^Reset the zoom and the pan/).textContent).toBe("150%");

    // … and the key goes back out from where the button left it, to exactly where it started.
    press(viewport, "-", "Minus");
    expect(scene.style.transform).toBe(transformOf(REST));
    expect(button(controls, /^Reset the zoom and the pan/).textContent).toBe("100%");

    // The other way round: a key in, then the readout — which is `0` — back to rest.
    press(viewport, "+", "Equal", true);
    expect(button(controls, "Reset the zoom and the pan, now 150%")).toBeTruthy();
    fireEvent.click(button(controls, /^Reset the zoom and the pan/));
    expect(scene.style.transform).toBe(transformOf(REST));
  });

  it("says why it cannot zoom further, at both ends, and does nothing when pressed there", async () => {
    const { scene, controls } = await mount();
    const zoomIn = button(controls, "Zoom in");
    expect(zoomIn.getAttribute("title")).toBe("Zoom in (+)");
    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    expect(scene.style.transform).toContain("scale(2)");
    expect(zoomIn.getAttribute("aria-disabled")).toBe("true");
    expect(zoomIn.getAttribute("title")).toBe("Zoomed in as far as the canvas goes, 200%");
    fireEvent.click(zoomIn);
    expect(scene.style.transform).toContain("scale(2)");

    const zoomOut = button(controls, "Zoom out");
    for (let i = 0; i < 6; i++) fireEvent.click(zoomOut);
    expect(scene.style.transform).toContain("scale(0.25)");
    expect(zoomOut.getAttribute("aria-disabled")).toBe("true");
    expect(zoomIn.hasAttribute("aria-disabled")).toBe(false);
  });

  it("fits the whole graph from the button and from the palette's command, which are one action", async () => {
    const { viewport, scene, controls } = await mount();
    const fitted = fitView(contentOf(AI_SDLC), VIEWPORT);
    // ai-sdlc is wider than the canvas, so fit is a zoom out, and centred.
    expect(fitted.scale).toBeLessThan(1);

    fireEvent.click(button(controls, "Zoom to fit the whole graph"));
    expect(scene.style.transform).toBe(transformOf(fitted));

    press(viewport, "0", "Digit0");
    expect(scene.style.transform).toBe(transformOf(REST));

    // Keyless (#205): in the palette with no chip, and the palette is the keyboard's way to it.
    const command = h.keyboard.list().find((s) => s.scope === "workflow" && s.label === "Zoom to fit the whole graph");
    expect(command).toBeDefined();
    expect(command!.key).toBeUndefined();
    act(() => command!.action());
    expect(scene.style.transform).toBe(transformOf(fitted));
  });

  it("zooms about the pointer on a ⌘/Ctrl wheel or a pinch, and keeps the window's own zoom out of it", async () => {
    const { viewport, scene } = await mount();
    const pointer = { x: 120, y: 80 };
    const notPrevented = wheel(viewport, {
      deltaY: -100,
      ctrlKey: true,
      clientX: pointer.x,
      clientY: pointer.y,
    });
    // Prevented: unprevented, Electron zooms the whole window.
    expect(notPrevented).toBe(false);
    const zoomed = zoomAt(REST, wheelZoomFactor(-100), pointer);
    expect(zoomed.scale).toBeGreaterThan(1);
    expect(scene.style.transform).toBe(transformOf(zoomed));
  });

  it("pans on a plain wheel while the drawing has further to go, and lets the wheel through at its edge", async () => {
    const { viewport, scene } = await mount();
    // ai-sdlc runs wider than the canvas and fits its height, so there is somewhere to go
    // sideways and nowhere to go down.
    const content = contentOf(AI_SDLC);
    expect(content.width).toBeGreaterThan(VIEWPORT.width);
    expect(content.height).toBeLessThan(VIEWPORT.height);

    // Down: nowhere to go, so the event is the canvas's to scroll on to the group boxes.
    expect(wheel(viewport, { deltaY: 100 })).toBe(true);
    expect(scene.style.transform).toBe(transformOf(REST));

    // Sideways — a trackpad's deltaX, or ⇧ and a wheel — pans, and is the drawing's.
    expect(wheel(viewport, { deltaX: 100 })).toBe(false);
    expect(scene.style.transform).toBe(transformOf({ scale: 1, pan: { x: -100, y: 0 } }));
    expect(wheel(viewport, { deltaY: 100, shiftKey: true })).toBe(false);
    expect(scene.style.transform).toBe(transformOf({ scale: 1, pan: { x: -200, y: 0 } }));
    // Back past the start is nowhere.
    wheel(viewport, { deltaX: -200 });
    expect(wheel(viewport, { deltaX: -100 })).toBe(true);
  });

  it("sits outside the canvas's keyboard scope, so Enter on a button is the button's", async () => {
    const { viewport, controls } = await mount();
    expect(viewport.closest("[data-kbd-scope]")!.getAttribute("data-kbd-scope")).toBe("workflow");
    expect(controls.closest("[data-kbd-scope]")).toBeNull();
    // A named group of ordinary buttons, not a toolbar that would promise roving arrows.
    expect(controls.getAttribute("role")).toBe("group");
    // An icon is never the only label: every button has a name.
    for (const control of within(controls).getAllByRole("button")) {
      expect(control.getAttribute("aria-label")).toBeTruthy();
    }
  });
});

describe("the layout direction", () => {
  it("re-lays the graph top to bottom, says what it will do next, and is remembered for the person", async () => {
    const { controls } = await mount();
    const box = (id: string) => document.getElementById(nodeDomId(id))!.parentElement!;
    const left = layoutWorkflow(AI_SDLC, METRICS);
    const plan = left.nodes.find((n) => n.node.id === "plan")!;
    expect([box("plan").style.left, box("plan").style.top]).toEqual([`${plan.x + PAD}px`, `${plan.y + PAD}px`]);

    fireEvent.click(button(controls, "Lay out top to bottom"));

    // Re-laid: the node is where the turned lattice puts it.
    const turned = toDirection(plan, "vertical", METRICS);
    expect([box("plan").style.left, box("plan").style.top]).toEqual([`${turned.x + PAD}px`, `${turned.y + PAD}px`]);
    expect(document.querySelector(".orca-wfcanvas")!.getAttribute("data-direction")).toBe("vertical");
    // The toggle now says what it will do from here.
    expect(button(controls, "Lay out left to right")).toBeTruthy();
    // The arrows point the way the layers now run: down is the next layer.
    const down = h.keyboard.list().find((s) => s.scope === "workflow" && s.key === "ArrowDown")!;
    expect(down.label).toBe("Next layer");
    expect(h.keyboard.list().find((s) => s.scope === "workflow" && s.key === "ArrowRight")!.label).toBe(
      "Next node in this layer",
    );

    // A person's preference, beside their densities and pane sizes — never the workflow's.
    expect(h.appearance.preferences().canvases?.workflow).toEqual({ direction: "vertical" });

    // Remembered: a canvas mounted later starts the way it was left.
    cleanup();
    await mount();
    expect(document.querySelector(".orca-wfcanvas")!.getAttribute("data-direction")).toBe("vertical");

    // And the palette's command is the same toggle, named for what it will do.
    const command = h.keyboard.list().find((s) => s.scope === "workflow" && s.label === "Lay out left to right")!;
    act(() => command.action());
    expect(h.appearance.preferences().canvases?.workflow?.direction).toBe("horizontal");
    expect(document.querySelector(".orca-wfcanvas")!.getAttribute("data-direction")).toBe("horizontal");
  });

  it("puts the view back at rest when the graph turns, rather than somewhere in the old drawing", async () => {
    const { viewport, scene, controls } = await mount();
    press(viewport, "ArrowRight", "ArrowRight", true);
    fireEvent.click(button(controls, "Zoom in"));
    expect(scene.style.transform).not.toBe(transformOf(REST));
    fireEvent.click(button(controls, "Lay out top to bottom"));
    expect(scene.style.transform).toBe(transformOf(REST));
  });
});

describe("the minimap", () => {
  const svgOf = () => document.querySelector<SVGSVGElement>(".orca-graphmap__svg")!;
  const frameOf = () => {
    const rect = document.querySelector(".orca-graphmap__view")!;
    return ["x", "y", "width", "height"].map((a) => Number(rect.getAttribute(a)));
  };

  it("shows every node as a box and the viewport as a rectangle, and is hidden from assistive technology", async () => {
    const { viewport } = await mount();
    const map = document.querySelector(".orca-graphmap")!;
    // A pointer convenience over what the keys already do, and a copy of the listbox beside it.
    expect(map.getAttribute("aria-hidden")).toBe("true");
    expect(map.querySelector("[tabindex]")).toBeNull();
    expect(map.querySelectorAll(".orca-graphmap__node")).toHaveLength(AI_SDLC.nodes.length);
    // Not inside the listbox: an `option`-free drawing beside it.
    expect(viewport.contains(map)).toBe(false);

    const geometry = minimapGeometry(contentOf(AI_SDLC), MINIMAP_BOX);
    const frame = toMinimap(geometry, visibleRect(REST, VIEWPORT));
    expect(frameOf()).toEqual([frame.x, frame.y, frame.width, frame.height]);

    // The selection is marked, in accent (rule 5).
    press(viewport, "ArrowRight", "ArrowRight");
    expect(document.querySelector(`.orca-graphmap__node--selected`)!.getAttribute("data-node")).toBe("start");
  });

  it("follows the view as it is panned and zoomed", async () => {
    const { viewport, controls } = await mount();
    const geometry = minimapGeometry(contentOf(AI_SDLC), MINIMAP_BOX);
    press(viewport, "ArrowRight", "ArrowRight", true);
    const panned: CanvasView = { scale: 1, pan: { x: -(METRICS.nodeW + METRICS.layerGap), y: 0 } };
    const after = toMinimap(geometry, visibleRect(panned, VIEWPORT));
    expect(frameOf()).toEqual([after.x, after.y, after.width, after.height]);

    fireEvent.click(button(controls, "Zoom out"));
    expect(frameOf()[2]).toBeGreaterThan(after.width);
  });

  it("centres the view where it is clicked, and pans by a drag of the rectangle", async () => {
    const { scene } = await mount();
    const geometry = minimapGeometry(contentOf(AI_SDLC), MINIMAP_BOX);
    const svg = svgOf();

    // A click away from the rectangle: the view is centred on that point of the drawing.
    const [fx, fy, fw] = frameOf();
    const click = { x: fx! + fw! + 20, y: fy! + 5 };
    fireEvent.pointerDown(svg, { clientX: click.x, clientY: click.y, pointerId: 1, button: 0 });
    fireEvent.pointerUp(svg, { clientX: click.x, clientY: click.y, pointerId: 1 });
    const centred = centreOn(fromMinimap(geometry, click), 1, VIEWPORT);
    const [px, py] = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\)/.exec(scene.style.transform)!.slice(1).map(Number);
    expect(px).toBeCloseTo(centred.pan.x, 6);
    expect(py).toBeCloseTo(centred.pan.y, 6);

    // A drag of the rectangle moves the view by the drag, in the drawing's px.
    const [gx, gy] = frameOf();
    fireEvent.pointerDown(svg, { clientX: gx! + 2, clientY: gy! + 2, pointerId: 2, button: 0 });
    fireEvent.pointerMove(svg, { clientX: gx! + 12, clientY: gy! + 2, pointerId: 2 });
    fireEvent.pointerUp(svg, { clientX: gx! + 12, clientY: gy! + 2, pointerId: 2 });
    const [qx, qy] = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\)/.exec(scene.style.transform)!.slice(1).map(Number);
    expect(qx! - px!).toBeCloseTo(-10 / geometry.scale, 6);
    expect(qy).toBeCloseTo(py!, 6);
  });

  it("hides and shows from its toggle, and the choice is remembered for the person", async () => {
    const { controls } = await mount();
    fireEvent.click(button(controls, "Hide the minimap"));
    expect(document.querySelector(".orca-graphmap")).toBeNull();
    expect(h.appearance.preferences().canvases?.workflow).toEqual({ minimap: false });
    expect(button(controls, "Show the minimap")).toBeTruthy();

    cleanup();
    const again = await mount();
    expect(document.querySelector(".orca-graphmap")).toBeNull();
    fireEvent.click(button(again.controls, "Show the minimap"));
    expect(document.querySelector(".orca-graphmap")).not.toBeNull();
  });
});
