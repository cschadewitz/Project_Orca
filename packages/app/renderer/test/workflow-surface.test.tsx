// @vitest-environment happy-dom
/**
 * The workflow viewer (#177), through the chrome that mounts it — which is the only way a
 * person reaches it: `orca://workflow/<name>` lands on Config, and `?run=` overlays a run.
 *
 * What is asserted here is what the issue's "done when" asks for and what the design decided
 * about the overlay, and nothing about pixels: happy-dom has no layout engine, so the
 * geometry is `workflow-layout.test.ts`'s job and this file is about what a person reads.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { rawTokens, THEMES } from "@orca/design";
import type { NotificationMessage } from "@orca/protocol";
import { commandEntries } from "../src/palette/entries.js";
import { nodeDomId } from "../src/workflow/workflow-canvas.js";
import { AI_SDLC, WORKFLOW_VIEWS } from "./fixtures-workflows.js";
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

/** Open the viewer the way every arrival at one happens: an `orca://` URL. */
async function open(url: string): Promise<HTMLElement> {
  fake = installBridge({ deepLink: url });
  teardown.push(fake.install());
  h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
  const canvas = await screen.findByRole("listbox", { name: /graph$/ });
  /* `findByRole` resolves on the DOM, and React commits the DOM *before* it runs the
     passive effects — which is where the canvas registers its twelve shortcuts. A press
     dispatched in that window resolves its scope, finds nothing registered for the key and
     is dropped; nothing ever re-fires it, so the `waitFor` after it times out on a
     selection that was never made. That is the first-press flake this file showed roughly
     once in forty runs, on whichever test happened to press first. One empty `act` flushes
     whatever is pending, so every press below meets a registered map. */
  await act(async () => {});
  return canvas;
}

/**
 * A key, pressed where the focus actually is. The `workflow` scope is resolved from the
 * focused element outwards, so a press dispatched at the window is a `global` press and
 * would reach none of the canvas's keys — which is the point of scopes.
 */
function press(canvas: HTMLElement, key: string, code: string, shiftKey = false): void {
  act(() => canvas.focus());
  fireEvent.keyDown(canvas, { key, code, shiftKey });
}

/** One `step.changed` frame, in the envelope the daemon sends it in. */
const stepChanged = (runId: string, stepRunId: string): NotificationMessage => ({
  kind: "notification",
  method: "step.changed",
  params: {
    subscriptionId: "sub-1",
    runId,
    seq: 20,
    at: "2026-03-01T09:00:20.000Z",
    stepRunId,
    status: "running",
    event: "step.started",
  },
});

const nodes = (canvas: HTMLElement): HTMLElement[] => within(canvas).getAllByRole("option");
const named = (canvas: HTMLElement, id: string): HTMLElement =>
  nodes(canvas).find((node) => node.id === nodeDomId(id))!;

describe("the definition, with no run overlaid", () => {
  it("draws every one of ai-sdlc's sixteen nodes", async () => {
    const canvas = await open("orca://workflow/ai-sdlc");
    // Sixteen: the eleven working nodes the issue counts, plus start, two `set`s and three
    // `end`s. The fixture is the projection of `workflows/ai-sdlc.yaml`.
    expect(AI_SDLC.nodes).toHaveLength(16);
    expect(nodes(canvas)).toHaveLength(16);
  });

  it("draws the review-to-build loop as a back edge", async () => {
    await open("orca://workflow/ai-sdlc");
    const back = [...document.querySelectorAll(".orca-edge--back")];
    // Two edges return to `bump-build`: the failed-test retry and the review verdict.
    expect(back.length).toBe(2);
    // And every edge that is not a back edge is drawn as an ordinary one.
    expect(document.querySelectorAll(".orca-edge").length).toBe(AI_SDLC.edges.length);
  });

  it("prints a when expression on the edge that carries one, verbatim", async () => {
    await open("orca://workflow/ai-sdlc");
    const labels = [...document.querySelectorAll(".orca-edge__label")].map((l) => l.textContent);
    expect(labels).toContain("changes requested");
    // An edge with no label of its own prints the condition as ORCA wrote it.
    expect(labels).toContain("choice == 'approve'");
  });

  it("names the type and the node in the accessible name, and draws the generic box for a plugin's type", async () => {
    const canvas = await open("orca://workflow/ai-sdlc");
    expect(named(canvas, "spec-gate").getAttribute("aria-label")).toBe("gate, Approve spec");
    // `custom:plan-await` is a plugin's node: named as it is, drawn as the generic box.
    const custom = named(canvas, "await-deps");
    expect(custom.getAttribute("aria-label")).toContain("custom:plan-await");
    expect(custom.className).not.toContain("orca-node--agent");
  });

  it("says no run is overlaid rather than leaving the question open", async () => {
    await open("orca://workflow/ai-sdlc");
    // Twice, and both are the point: the rail says what is on screen, and the header's
    // picker says what it would change.
    expect(screen.getAllByText(/No run overlaid/).length).toBeGreaterThan(0);
  });

  it("shows the id and the version as ai-sdlc v1, and no pinned chip", async () => {
    await open("orca://workflow/ai-sdlc");
    // In the object header, which the surface hands up: the crumbs and the version arrive
    // one commit after the canvas, so this is a find rather than a get.
    expect(await screen.findByText("ai-sdlc v1")).toBeTruthy();
    expect(document.querySelector(".orca-pinned")).toBeNull();
  });
});

describe("a run overlaid", () => {
  it("shows the attempts on the node the run retried", async () => {
    const canvas = await open("orca://workflow/sdlc?run=run-parent");
    // `run-parent` entered `build` twice: a failed attempt and then a successful one.
    await waitFor(() => expect(named(canvas, "build").getAttribute("aria-label")).toContain("attempt 2"));
    expect(named(canvas, "build").textContent).toContain("attempt 2");
    // The last visit's status is what the node carries; the failed attempt is a row in the
    // run tree, not a second box here.
    expect(named(canvas, "build").getAttribute("aria-label")).toContain("succeeded");
  });

  it("marks the nodes the run never reached as not taken", async () => {
    const canvas = await open("orca://workflow/sdlc?run=run-parent");
    await waitFor(() => expect(named(canvas, "build").className).toContain("orca-node--ran"));
    // The run is at `fanout`; `write`, `approve` and `done` are ahead of it.
    for (const id of ["write", "approve", "done"]) {
      expect(named(canvas, id).className, id).toContain("orca-node--untaken");
      expect(named(canvas, id).getAttribute("aria-label"), id).toContain("not taken");
    }
    expect(named(canvas, "fanout").className).not.toContain("orca-node--untaken");
  });

  it("marks the node the run is at now as the current one", async () => {
    const canvas = await open("orca://workflow/sdlc?run=run-parent");
    await waitFor(() => expect(named(canvas, "fanout").className).toContain("orca-node--current"));
    expect(named(canvas, "fanout").getAttribute("aria-label")).toContain("current node");
  });

  it("draws the edges the run took differently from the ones it did not", async () => {
    await open("orca://workflow/sdlc?run=run-parent");
    await waitFor(() => expect(document.querySelector(".orca-edge--active")).toBeTruthy());
    expect(document.querySelectorAll(".orca-edge--untaken").length).toBeGreaterThan(0);
  });

  it("says the run is pinned, and says which definition is on screen instead", async () => {
    await open("orca://workflow/sdlc?run=run-parent");
    // `run-parent` recorded v2; `sdlc` is at v3 on disk. The chip alone would leave a person
    // believing they were looking at what ran, so the caption says what they are looking at.
    await waitFor(() => expect(document.querySelector(".orca-pinned")).toBeTruthy());
    expect(document.querySelector(".orca-pinned")!.textContent).toContain("pinned");
    expect(screen.getByText(/pinned to v2\./)).toBeTruthy();
    expect(screen.getByText(/The graph drawn is v3, the definition on disk/)).toBeTruthy();
  });

  it("does not claim a pin when the run is on the version on disk", async () => {
    await open("orca://workflow/sdlc-item?run=run-child-ok");
    await waitFor(() => expect(screen.getByText(/overlaid/)).toBeTruthy());
    expect(document.querySelector(".orca-pinned")).toBeNull();
  });

  it("re-reads the run when a step changes, and never polls", async () => {
    await open("orca://workflow/sdlc?run=run-parent");
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1));
    const before = fake.calls.filter((c) => c.method === "runs.get").length;

    act(() => fake.notify(stepChanged("run-parent", "s-fan")));
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "runs.get").length).toBe(before + 1));

    // A push about another run is not this overlay's business.
    act(() => fake.notify(stepChanged("run-gate", "s-gate")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls.filter((c) => c.method === "runs.get").length).toBe(before + 1);
  });
});

describe("collapsing a container", () => {
  it("hides a parallel node's branches and says how many there are", async () => {
    const canvas = await open("orca://workflow/sdlc");
    const fanout = named(canvas, "fanout");
    // Collapsed is the default: the branches are not drawn and the node says what is behind it.
    expect(fanout.textContent).toContain("2 nested graphs");
    expect(screen.queryByRole("region", { name: /^Inside Fan out/ })).toBeNull();
    expect(nodes(canvas).map((n) => n.id)).not.toContain(nodeDomId("ui-build"));
  });

  it("draws the branches in a group box when it is expanded, and puts them away again", async () => {
    const canvas = await open("orca://workflow/sdlc");
    fireEvent.click(named(canvas, "fanout"));
    press(canvas, "Enter", "Enter");

    /* Both inline branches, each as a group box of its own named by the
       `parent::node::branch` id the daemon addresses it by — two regions called "Inside Fan
       out the pieces" would be two things a screen reader could not tell apart. */
    const group = await screen.findByRole("region", { name: "Inside Fan out the pieces: sdlc::fanout::auth-ui" });
    expect(within(group).getByText("3 nodes")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Inside Fan out the pieces: sdlc::fanout::auth-docs" })).toBeTruthy();
    expect(
      within(group)
        .getAllByRole("option")
        .map((n) => n.id),
    ).toContain(nodeDomId("ui-build"));
    expect(named(canvas, "fanout").textContent).not.toContain("2 nested graphs");

    press(canvas, "Enter", "Enter");
    await waitFor(() => expect(screen.queryAllByRole("region", { name: /^Inside Fan out/ })).toHaveLength(0));
  });
});

describe("the keyboard", () => {
  it("moves the selection with the arrows, on one tab stop", async () => {
    const canvas = await open("orca://workflow/ai-sdlc");
    expect(canvas.getAttribute("tabindex")).toBe("0");
    // One tab stop: no node is focusable on its own, however many there are.
    expect(nodes(canvas).some((node) => node.hasAttribute("tabindex"))).toBe(false);

    press(canvas, "ArrowRight", "ArrowRight");
    await waitFor(() => expect(canvas.getAttribute("aria-activedescendant")).toBe(nodeDomId("start")));

    press(canvas, "ArrowRight", "ArrowRight");
    await waitFor(() => expect(canvas.getAttribute("aria-activedescendant")).toBe(nodeDomId("plan")));
    expect(named(canvas, "plan").getAttribute("aria-selected")).toBe("true");

    press(canvas, "ArrowLeft", "ArrowLeft");
    await waitFor(() => expect(canvas.getAttribute("aria-activedescendant")).toBe(nodeDomId("start")));
  });

  it("steps between the nodes of one layer with the up and down arrows", async () => {
    const canvas = await open("orca://workflow/ai-sdlc");
    fireEvent.click(named(canvas, "spec-gate"));
    // Layer 4 holds both of the gate's targets: `await-deps` and `rejected`.
    press(canvas, "ArrowRight", "ArrowRight");
    const first = canvas.getAttribute("aria-activedescendant");
    press(canvas, "ArrowDown", "ArrowDown");
    await waitFor(() => expect(canvas.getAttribute("aria-activedescendant")).not.toBe(first));
  });

  it("zooms with + and - and puts it back with 0", async () => {
    const canvas = await open("orca://workflow/ai-sdlc");
    const scene = canvas.querySelector<HTMLElement>(".orca-wfcanvas__scene")!;
    const at = (): string => scene.style.transform;
    const rest = at();

    /* Pressed as a keyboard presses it: `+` is Shift and Equal, so the event carries
       `shiftKey: true` and it is `keyOfEvent`'s job to see that the shift spelled the
       character rather than modifying it. Sending a bare `+` here passed while the real
       key did nothing at all (#177). */
    press(canvas, "+", "Equal", true);
    await waitFor(() => expect(at()).not.toBe(rest));
    expect(at()).toContain("scale(1.5)");

    press(canvas, "-", "Minus");
    await waitFor(() => expect(at()).toBe(rest));

    press(canvas, "+", "Equal", true);
    press(canvas, "0", "Digit0");
    await waitFor(() => expect(at()).toBe(rest));
  });

  it("pans with a shifted arrow, which is a different thing from moving the selection", async () => {
    const canvas = await open("orca://workflow/ai-sdlc");
    const scene = canvas.querySelector<HTMLElement>(".orca-wfcanvas__scene")!;
    const rest = scene.style.transform;
    press(canvas, "ArrowRight", "ArrowRight", true);
    await waitFor(() => expect(scene.style.transform).not.toBe(rest));
    // Panning selects nothing: the two are different verbs.
    expect(canvas.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("lists every one of them in the command palette", async () => {
    await open("orca://workflow/ai-sdlc");
    const shortcuts = h.keyboard.list().filter((s) => s.scope === "workflow");
    // Fifteen: four arrows, Enter, three zoom keys and four shifted arrows — and three keyless
    // commands, the canvas controls' fit, direction and minimap, which the palette is the
    // keyboard's way to (#205).
    expect(shortcuts).toHaveLength(15);
    expect(shortcuts.filter((s) => s.key === undefined).map((s) => s.label)).toEqual(
      expect.arrayContaining(["Zoom to fit the whole graph", "Lay out top to bottom", "Hide the minimap"]),
    );

    const entries = commandEntries(h.keyboard.list(), "darwin", ["workflow", "global"]);
    for (const shortcut of shortcuts) {
      const entry = entries.find((e) => e.id === `command:${shortcut.id}`);
      expect(entry, shortcut.label).toBeDefined();
      expect(entry!.label).toBe(shortcut.label);
    }
  });
});

describe("the inspector", () => {
  it("shows the selected node's fields, as the daemon flattened them", async () => {
    const canvas = await open("orca://workflow/ai-sdlc");
    fireEvent.click(named(canvas, "build"));
    const inspector = await screen.findByRole("complementary", { name: "Node detail: Build: plan and implement" });
    expect(within(inspector).getByText("role")).toBeTruthy();
    expect(within(inspector).getByText("builder")).toBeTruthy();
    expect(within(inspector).getByText("sdlc/build")).toBeTruthy();

    /* The kind and the attempts are one run of chips, which wraps: a plugin's `custom:<name>`
       kind beside "up to 3 attempts" is wider than the inspector at its narrowest, and an
       unwrapped line ran past the pane's edge. */
    const kind = within(inspector).getByText("agent").closest(".orca-chip")!;
    expect(kind.parentElement!.classList.contains("orca-chips")).toBe(true);
  });

  it("shows a node selected inside an expanded branch, which is the same one selection", async () => {
    const canvas = await open("orca://workflow/sdlc");
    fireEvent.click(named(canvas, "fanout"));
    press(canvas, "Enter", "Enter");

    const group = await screen.findByRole("region", { name: "Inside Fan out the pieces: sdlc::fanout::auth-ui" });
    const nested = within(group)
      .getAllByRole("option")
      .find((option) => option.id === nodeDomId("ui-build"))!;
    fireEvent.click(nested);

    /* The selection is one id held by the surface, and it is resolved across the nested
       graphs — a click here used to select a node the inspector could not then find, which
       left the panel saying "select a node" about the node just selected (#177). */
    const inspector = await screen.findByRole("complementary", { name: "Node detail: Wire the login button" });
    expect(within(inspector).getByText("role")).toBeTruthy();
    expect(within(inspector).getByText("builder")).toBeTruthy();

    /* And the listbox that holds it is the one pointing at it: `aria-activedescendant` has
       to name an element its own listbox contains, so the group's does and the viewport's
       does not. */
    const listbox = within(group).getByRole("listbox", { name: "Nodes of sdlc::fanout::auth-ui" });
    await waitFor(() => expect(listbox.getAttribute("aria-activedescendant")).toBe(nodeDomId("ui-build")));
    expect(canvas.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("lists a node's configuration through the shared display: keys in mono, an object in a well", async () => {
    const canvas = await open("orca://workflow/sdlc");
    fireEvent.click(named(canvas, "approve"));
    const inspector = await screen.findByRole("complementary", { name: "Node detail: Approve spec" });
    /* `KeyValueList`, the display a run's variables use, rather than the inspector's own grid
       of compact JSON lines: one way to read a value wherever ORCA shows one. */
    const list = inspector.querySelector("dl.orca-kv")!;
    expect(list).toBeTruthy();
    const keys = [...list.querySelectorAll("dt")];
    expect(keys.map((dt) => dt.textContent)).toEqual(["question", "options"]);
    // A config key is an identifier the workflow file declared, not a label: mono (rule 8).
    for (const key of keys) expect(key.classList.contains("orca-text-mono-id"), key.textContent ?? "").toBe(true);

    // A string is itself, on the line beside its key.
    const question = keys[0]!.nextElementSibling!;
    expect(question.textContent).toBe("Ship the rollout?");
    expect(question.classList.contains("orca-text-mono-body")).toBe(true);

    // An array of objects is its indented JSON in a sunken well under its key, verbatim —
    // not the one compact line that used to run on past the inspector.
    const options = WORKFLOW_VIEWS["sdlc"]!.nodes.find((node) => node.id === "approve")!.fields["options"];
    const well = keys[1]!.nextElementSibling!.querySelector("pre.orca-well")!;
    expect(well).toBeTruthy();
    expect(well.textContent).toBe(JSON.stringify(options, null, 2));
    expect(inspector.textContent).not.toContain('[{"id":"approve"');
  });

  it("says a node type carries no configuration rather than showing an empty list", async () => {
    const canvas = await open("orca://workflow/ai-sdlc");
    fireEvent.click(named(canvas, "start"));
    const inspector = await screen.findByRole("complementary", { name: "Node detail: start" });
    expect(within(inspector).getByText(/carries no configuration/)).toBeTruthy();
  });
});

describe("both themes", () => {
  it("binds the node border and the overlay states to tokens, not to hexes", async () => {
    const canvas = await open("orca://workflow/sdlc?run=run-parent");
    await waitFor(() => expect(named(canvas, "fanout").className).toContain("orca-node--current"));
    installDesignSystem();
    // The chrome's own root class is what the component layer is scoped under.
    document.body.classList.add("orca");

    for (const theme of THEMES) {
      setTheme(theme);
      // A node with no overlay state draws the control border; the current node draws the
      // running colour; an untaken one is faded by the token that names that.
      expect(resolved(named(canvas, "start"), "border-top-color"), theme).toBe(
        rawTokens[theme]["border-control"]!.toLowerCase(),
      );
      expect(resolved(named(canvas, "fanout"), "border-top-color"), theme).toBe(
        rawTokens[theme]["status-running"]!.toLowerCase(),
      );
      expect(resolved(named(canvas, "approve"), "opacity"), theme).not.toBe("1");
    }
    document.body.classList.remove("orca");
  });
});
