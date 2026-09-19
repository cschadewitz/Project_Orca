// @vitest-environment happy-dom
/**
 * The window chrome: surface routing, the ⌘1–⌘5 and ⌘\ shortcuts, and the sidebar/panel
 * breakpoints ("the layout holds from 960px to 2560px",
 * docs/design/50-accessibility-and-keyboard.md). The full renderer harness (dual-theme
 * helper, fake preload bridge fixtures, coverage thresholds for packages/app) is #154;
 * this covers what #148 itself needs to claim its "done when".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HelloResult } from "@orca/protocol";
import { App } from "../src/App.js";
import { AppearanceProvider } from "../src/appearance-context.js";
import { installAppearance, type AppearanceStore } from "../src/appearance.js";
import { KeyboardMap } from "../src/keyboard-map.js";
import { KeyboardProvider } from "../src/keyboard-context.js";
import type { BridgeResult } from "../../src/bridge.js";
import { DEFAULT_PREFERENCES, mergePreferences, type Preferences } from "../../src/preferences/schema.js";

const LIVE: BridgeResult<HelloResult> = {
  ok: true,
  result: { protocol: { major: 1, minor: 0 }, orcaVersion: "0.2.0-test", capabilities: [] },
};

/** Preferences that never touch disk; the chrome only reads them through `Appearance`. */
const store = (): AppearanceStore => {
  let preferences: Preferences = DEFAULT_PREFERENCES;
  return {
    read: () => preferences,
    write: (patch) => {
      preferences = mergePreferences(preferences, patch);
      return Promise.resolve({ ok: true, result: preferences });
    },
  };
};

function stubMatchMedia(width: number): void {
  const matchMedia = (query: string): MediaQueryList => {
    const threshold = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches = threshold ? width <= Number(threshold[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  };
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: matchMedia });
}

function stubBridge(hello: () => Promise<BridgeResult<HelloResult>>): void {
  const bridge = { platform: "darwin", hello, preferences: { read: () => DEFAULT_PREFERENCES, write: () => {} } };
  Object.defineProperty(window, "orca", { configurable: true, writable: true, value: bridge });
}

const teardown: (() => void)[] = [];

/** The chrome with the two things `main.tsx` installs above it: the keyboard map and appearance. */
function renderChrome(): ReturnType<typeof render> {
  const keyboard = new KeyboardMap("darwin");
  teardown.push(keyboard.listen(window));
  const appearance = installAppearance(window, store(), keyboard);
  teardown.push(appearance.dispose);
  return render(
    <KeyboardProvider value={keyboard}>
      <AppearanceProvider value={appearance}>
        <App />
      </AppearanceProvider>
    </KeyboardProvider>,
  );
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
    expect(await screen.findByText("Runs", { selector: ".orca-state__title" })).toBeTruthy();
    // The pane is the surface root density is remembered by.
    expect(document.querySelector(".orca-main")?.getAttribute("data-surface")).toBe("runs");
  });

  it("registers its shortcuts in the keyboard map, so the palette can list them", async () => {
    stubMatchMedia(1440);
    const keyboard = new KeyboardMap("darwin");
    const appearance = installAppearance(window, store(), keyboard);
    teardown.push(appearance.dispose);
    render(
      <KeyboardProvider value={keyboard}>
        <AppearanceProvider value={appearance}>
          <App />
        </AppearanceProvider>
      </KeyboardProvider>,
    );
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

  it("shows disconnected when the daemon handshake fails", async () => {
    stubMatchMedia(1440);
    stubBridge(() => Promise.resolve({ ok: false, error: { code: "AGENT_TRANSPORT", message: "no daemon" } }));
    renderChrome();
    expect(await screen.findByText("disconnected")).toBeTruthy();
  });
});
