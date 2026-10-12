/**
 * The window's frame: which platforms lose the OS title bar, and that the OS buttons left
 * behind fit the room the renderer's title bar leaves for them. The renderer pads by the
 * same tokens as `var()`, so these are the two halves of one measurement.
 */
import { describe, expect, it } from "vitest";
import { rawTokens, THEMES, TITLEBAR_GEOMETRY } from "@orca/design";
import { hasTitleBarOverlay, MAC_WINDOW_BUTTONS, titleBarOverlay, windowChrome } from "../src/main/window-chrome.js";

describe("windowChrome", () => {
  it("hides the macOS title bar and centres the traffic lights in their inset and the bar", () => {
    const chrome = windowChrome("darwin", "light");
    expect(chrome.titleBarStyle).toBe("hidden");
    expect(chrome.titleBarOverlay).toBeUndefined();

    const { x, y } = chrome.trafficLightPosition!;
    const inset = TITLEBAR_GEOMETRY["titlebar-inset-traffic-lights"];
    // Equal room either side of the button block, so the brand mark starts clear of it.
    expect(x + MAC_WINDOW_BUTTONS.width + x).toBe(inset);
    expect(y + MAC_WINDOW_BUTTONS.height + y).toBe(TITLEBAR_GEOMETRY["bar-title"]);
  });

  it("hides the Windows title bar and keeps the caption buttons as an overlay on the bar", () => {
    for (const theme of THEMES) {
      const chrome = windowChrome("win32", theme);
      expect(chrome.titleBarStyle).toBe("hidden");
      expect(chrome.titleBarOverlay).toEqual(titleBarOverlay(theme));
      expect(chrome.trafficLightPosition).toBeUndefined();
    }
    expect(hasTitleBarOverlay("win32")).toBe(true);
  });

  it("leaves Linux its window manager's frame, since neither inset is reserved there", () => {
    expect(windowChrome("linux", "dark")).toEqual({});
    expect(hasTitleBarOverlay("linux")).toBe(false);
    expect(hasTitleBarOverlay("darwin")).toBe(false);
  });
});

describe("titleBarOverlay", () => {
  it("paints the caption buttons in the bar's own colours, in both themes", () => {
    for (const theme of THEMES) {
      const overlay = titleBarOverlay(theme);
      expect(overlay.color).toBe(rawTokens[theme]["surface-canvas"]);
      expect(overlay.symbolColor).toBe(rawTokens[theme]["ink-primary"]);
    }
  });

  it("stops one hairline short of the bar, so the rule under it runs the window's width", () => {
    expect(titleBarOverlay("light").height).toBe(TITLEBAR_GEOMETRY["bar-title"] - TITLEBAR_GEOMETRY["stroke-hairline"]);
  });
});
