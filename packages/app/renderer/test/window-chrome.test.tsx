// @vitest-environment happy-dom
/**
 * The window chrome: surface routing, the ⌘1–⌘5 and ⌘\ shortcuts, and the sidebar/panel
 * breakpoints ("the layout holds from 960px to 2560px",
 * docs/design/50-accessibility-and-keyboard.md). The full renderer harness (dual-theme
 * helper, fake preload bridge fixtures, coverage thresholds for packages/app) is #154;
 * this covers what #148 itself needs to claim its "done when".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LIVE, harness, renderChrome as mountChrome, stubBridge, stubMatchMedia, type Harness } from "./harness.js";

const teardown: (() => void)[] = [];

/** The chrome with everything `main.tsx` installs above it. */
function renderChrome(): ReturnType<typeof render> {
  const h = harness();
  teardown.push(h.dispose);
  return mountChrome(h);
}

/** Same, when the test needs to reach the keyboard map the chrome registered into. */
function renderWithHarness(): Harness {
  const h = harness();
  teardown.push(h.dispose);
  mountChrome(h);
  return h;
}

/** ⌘<key>, as the keyboard map reads it: `code` for letters and digits, `key` for the rest. */
const press = (key: string, code: string): boolean => fireEvent.keyDown(window, { key, code, metaKey: true });

const body = (): Element => document.querySelector(".orca-body")!;

describe("window chrome", () => {
  beforeEach(() => {
    stubBridge(() => Promise.resolve(LIVE));
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("lands on Attention", async () => {
    stubMatchMedia(1440);
    renderChrome();
    const attention = await screen.findByRole("button", { name: "Attention" });
    expect(attention.getAttribute("aria-current")).toBe("page");
  });

  it("switches surfaces with ⌘1–⌘5", async () => {
    stubMatchMedia(1440);
    renderChrome();
    await screen.findByRole("button", { name: "Attention" });

    press("2", "Digit2");

    const runs = await screen.findByRole("button", { name: "Runs" });
    expect(runs.getAttribute("aria-current")).toBe("page");
    // Runs is the one surface with content behind it (#152, #156); the other four still
    // render the placeholder state view.
    expect(await screen.findByRole("listbox", { name: "Run tree" })).toBeTruthy();
    // The pane is the surface root density is remembered by.
    expect(document.querySelector(".orca-main")?.getAttribute("data-surface")).toBe("runs");
  });

  it("registers its shortcuts in the keyboard map, so the palette can list them", async () => {
    stubMatchMedia(1440);
    const { keyboard } = renderWithHarness();
    await screen.findByRole("button", { name: "Attention" });

    const keys = keyboard.list().map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["Mod+1", "Mod+2", "Mod+3", "Mod+4", "Mod+5", "Mod+\\"]));
  });

  it("toggles the docked panel with ⌘\\", async () => {
    stubMatchMedia(1440);
    renderChrome();
    await screen.findByRole("button", { name: "Attention" });
    expect(screen.queryByText("Nothing pinned")).toBeNull();

    press("\\", "Backslash");
    expect(await screen.findByText("Nothing pinned")).toBeTruthy();

    press("\\", "Backslash");
    expect(screen.queryByText("Nothing pinned")).toBeNull();
  });

  it("holds a two-column layout with the sidebar expanded from 960px up to 2560px", async () => {
    for (const width of [960, 1440, 2560]) {
      stubMatchMedia(width);
      const view = renderChrome();
      await screen.findByRole("button", { name: "Attention" });
      expect(body().hasAttribute("data-sidebar")).toBe(false);
      view.unmount();
    }
  });

  it("collapses the sidebar below the sidebar breakpoint", async () => {
    stubMatchMedia(959);
    renderChrome();
    await screen.findByRole("button", { name: "Attention" });
    expect(body().getAttribute("data-sidebar")).toBe("collapsed");
  });

  it("overlays the docked panel below the panel breakpoint but not at or above it", async () => {
    stubMatchMedia(1099);
    const narrow = renderChrome();
    await screen.findByRole("button", { name: "Attention" });
    press("\\", "Backslash");
    await screen.findByText("Nothing pinned");
    expect(body().getAttribute("data-panel")).toBe("overlay");
    narrow.unmount();

    stubMatchMedia(1100);
    renderChrome();
    await screen.findByRole("button", { name: "Attention" });
    press("\\", "Backslash");
    await screen.findByText("Nothing pinned");
    expect(body().hasAttribute("data-panel")).toBe(false);
    expect(body().className).toContain("orca-body--panel");
  });

  /* The connection is pushed now, not probed (#163): the state machine is in the main
     process, so a chrome test says what it was told rather than arranging a failed
     handshake and waiting for the renderer to draw a conclusion from it. */
  it("shows disconnected when the main process says the daemon is gone", async () => {
    stubMatchMedia(1440);
    const fake = stubBridge(() => Promise.resolve(LIVE));
    renderChrome();
    await screen.findByRole("button", { name: "Attention" });

    act(() => fake.connect({ state: "disconnected", since: new Date().toISOString() }));

    expect(screen.getByText("disconnected")).toBeTruthy();
    // And the screen below it says so too, rather than only the status bar.
    expect(document.querySelector(".orca-stale-rule")).not.toBeNull();
  });
});
