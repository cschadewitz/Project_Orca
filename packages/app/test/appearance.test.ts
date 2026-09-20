/**
 * The renderer's theme and density under the real design CSS, in a happy-dom window. Each
 * scenario builds its own window because happy-dom caches computed style per document and
 * does not invalidate it when the device preferences (colour scheme, reduced motion) change.
 * The CSS is what the app loads: tokens.css, components.css and the renderer's own sheet.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window as HappyWindow } from "happy-dom";
import { rawTokens } from "@orca/design";
import { installAppearance, type AppearanceStore } from "../renderer/src/appearance.js";
import { KeyboardMap, keyOfEvent, normalizeKey, shortcutLabel } from "../renderer/src/keyboard-map.js";
import { nextTheme, THEME_CYCLE } from "../renderer/src/theme.js";
import { DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch } from "../src/preferences/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");
// @font-face rules point at files a test window cannot fetch; everything else stays.
const CSS = [
  read("../../design/css/tokens.css"),
  read("../../design/css/components.css"),
  read("../renderer/src/app.css"),
]
  .join("\n")
  .replace(/@font-face\s*\{[^}]*\}/g, "");

const PAGE = `
  <main class="orca-surface" data-surface="runs" tabindex="-1">
    <div class="orca-tree-row" id="run-row" style="height: var(--row-h)"></div>
    <span class="orca-dot orca-dot--running" id="dot"></span>
    <button id="run-button">in runs</button>
  </main>
  <section class="orca-surface" data-surface="config" tabindex="-1">
    <div id="config-row" style="height: var(--row-h)"></div>
  </section>`;

interface Device {
  prefersColorScheme?: "light" | "dark";
  prefersReducedMotion?: "no-preference" | "reduce";
}

/** The slice of KeyboardEventInit these tests use; lib.dom's full one does not fit happy-dom's. */
interface KeyInit {
  key: string;
  code: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** A window with the app's CSS and two surfaces, plus an in-memory preferences store. */
function page(device: Device = {}, initial: Partial<Preferences> = {}) {
  const happy = new HappyWindow({ settings: { device } });
  // happy-dom's own types are a near-miss of lib.dom's; the code under test is written
  // against lib.dom, so the window is used through that view.
  const win = happy as unknown as Window;
  const doc = win.document;
  const style = doc.createElement("style");
  style.textContent = CSS;
  doc.head.appendChild(style);
  doc.body.className = "orca";
  doc.body.innerHTML = PAGE;

  let saved: Preferences = { ...DEFAULT_PREFERENCES, ...initial };
  const writes: PreferencesPatch[] = [];
  const store: AppearanceStore = {
    read: () => saved,
    write: (patch) => {
      writes.push(patch);
      saved = { ...saved, theme: patch.theme ?? saved.theme, density: { ...saved.density, ...patch.density } };
      return Promise.resolve({ ok: true, result: saved });
    },
  };
  const computed = (selector: string) => win.getComputedStyle(doc.querySelector(selector)!);
  const key = (init: KeyInit) =>
    new happy.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
  const press = (init: KeyInit) => doc.body.dispatchEvent(key(init));
  return { win, doc, html: doc.documentElement, store, writes, computed, key, press, saved: () => saved };
}

describe("theme", () => {
  it("resolves a custom property from the dark block under [data-theme=dark], and from the light block otherwise", () => {
    const p = page();
    expect(p.computed("body").backgroundColor).toBe(rawTokens.light["surface-canvas"]);
    p.html.setAttribute("data-theme", "dark");
    expect(p.computed("body").backgroundColor).toBe(rawTokens.dark["surface-canvas"]);
    expect(p.computed("html").colorScheme).toBe("dark");
    p.html.setAttribute("data-theme", "light");
    expect(p.computed("body").backgroundColor).toBe(rawTokens.light["surface-canvas"]);
    expect(p.computed("html").colorScheme).toBe("light");
  });

  it("follows the OS when the attribute is absent, color-scheme included", () => {
    const dark = page({ prefersColorScheme: "dark" });
    expect(dark.computed("body").backgroundColor).toBe(rawTokens.dark["surface-canvas"]);
    expect(dark.computed("html").colorScheme).toBe("dark");
    dark.html.setAttribute("data-theme", "light");
    expect(dark.computed("body").backgroundColor).toBe(rawTokens.light["surface-canvas"]);

    const light = page({ prefersColorScheme: "light" });
    expect(light.computed("body").backgroundColor).toBe(rawTokens.light["surface-canvas"]);
    expect(light.computed("html").colorScheme).toBe("light");
  });

  it("applies the persisted choice on install and only sets the attribute", () => {
    const p = page({}, { theme: "dark" });
    installAppearance(p.win, p.store, new KeyboardMap("darwin"));
    expect(p.html.getAttribute("data-theme")).toBe("dark");
    expect(p.computed("body").backgroundColor).toBe(rawTokens.dark["surface-canvas"]);
    expect(p.writes).toEqual([]);
  });

  it("cycles system, light, dark on ⌘⇧L and persists each step", async () => {
    const p = page();
    const map = new KeyboardMap("darwin");
    const appearance = installAppearance(p.win, p.store, map);
    map.listen(p.doc);
    expect(p.html.hasAttribute("data-theme")).toBe(false);

    p.press({ key: "L", code: "KeyL", metaKey: true, shiftKey: true });
    expect(p.html.getAttribute("data-theme")).toBe("light");
    p.press({ key: "L", code: "KeyL", metaKey: true, shiftKey: true });
    expect(p.html.getAttribute("data-theme")).toBe("dark");
    p.press({ key: "L", code: "KeyL", metaKey: true, shiftKey: true });
    expect(p.html.hasAttribute("data-theme")).toBe(false);
    await Promise.resolve();
    expect(p.writes.map((w) => w.theme)).toEqual(["light", "dark", "system"]);

    // Ctrl is not the modifier on macOS, and without Shift it is somebody else's key.
    p.press({ key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });
    p.press({ key: "l", code: "KeyL", metaKey: true });
    expect(p.html.hasAttribute("data-theme")).toBe(false);
    appearance.dispose();
  });

  it("keeps the attribute and warns when the write is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = page();
    const refusing: AppearanceStore = {
      read: p.store.read,
      write: () => Promise.resolve({ ok: false, error: { code: "PREFERENCES", message: "disk full" } }),
    };
    installAppearance(p.win, refusing, new KeyboardMap("darwin")).cycleTheme();
    await Promise.resolve();
    expect(p.html.getAttribute("data-theme")).toBe("light");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    warn.mockRestore();
  });

  it("walks the cycle in the documented order", () => {
    expect(THEME_CYCLE).toEqual(["system", "light", "dark"]);
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });
});

describe("density", () => {
  it("rebinds --row-h on the surface the attribute is set on, and nothing else", () => {
    const p = page();
    const runs = p.doc.querySelector("[data-surface=runs]")!;
    expect(p.computed("#run-row").height).toBe("32px");
    runs.setAttribute("data-density", "compact");
    expect(p.computed("#run-row").height).toBe("24px");
    expect(p.computed("#config-row").height).toBe("32px");
    // The point of the toggle is more rows, not smaller text.
    expect(p.computed("body").fontSize).toBe("14px");
  });

  it("toggles the focused surface on ⌘⇧D and remembers the choice per surface", async () => {
    const p = page({}, { density: { config: "compact" } });
    const map = new KeyboardMap("linux");
    installAppearance(p.win, p.store, map);
    map.listen(p.doc);
    expect(p.computed("#config-row").height).toBe("24px");
    expect(p.computed("#run-row").height).toBe("32px");

    p.doc.getElementById("run-button")!.focus();
    p.press({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
    expect(p.computed("#run-row").height).toBe("24px");
    expect(p.computed("#config-row").height).toBe("24px");
    await Promise.resolve();
    expect(p.writes).toEqual([{ density: { runs: "compact" } }]);

    p.doc.querySelector<HTMLElement>("[data-surface=config]")!.focus();
    p.press({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
    expect(p.computed("#config-row").height).toBe("32px");
    expect(p.computed("#run-row").height).toBe("24px");
    await Promise.resolve();
    expect(p.saved()).toEqual({
      theme: "system",
      density: { config: "comfortable", runs: "compact" },
      alerts: DEFAULT_PREFERENCES.alerts,
    });
  });

  it("acts on the first surface when focus is nowhere in particular", () => {
    const p = page();
    const appearance = installAppearance(p.win, p.store, new KeyboardMap("linux"));
    appearance.toggleDensity();
    expect(p.doc.querySelector("[data-surface=runs]")!.getAttribute("data-density")).toBe("compact");
    expect(p.doc.querySelector("[data-surface=config]")!.hasAttribute("data-density")).toBe(false);
  });

  it("gives a surface mounted later its remembered density on refresh", () => {
    const p = page({}, { density: { plan: "compact" } });
    const appearance = installAppearance(p.win, p.store, new KeyboardMap("linux"));
    p.doc.body.insertAdjacentHTML("beforeend", `<section class="orca-surface" data-surface="plan"></section>`);
    const plan = p.doc.querySelector("[data-surface=plan]")!;
    expect(plan.hasAttribute("data-density")).toBe(false);
    appearance.refresh();
    expect(plan.getAttribute("data-density")).toBe("compact");
  });
});

describe("motion", () => {
  it("pulses the running dot by default and holds it static under prefers-reduced-motion", () => {
    const moving = page();
    installAppearance(moving.win, moving.store, new KeyboardMap("linux"));
    expect(moving.computed("#dot").animation).toMatch(/^orca-pulse .*infinite$/);

    const still = page({ prefersReducedMotion: "reduce" });
    installAppearance(still.win, still.store, new KeyboardMap("linux"));
    const dot = still.computed("#dot");
    expect(dot.animation).toBe("none");
    // The static replacement: a filled dot with its own ring, so running still reads as running.
    expect(dot.boxShadow).toBe(`0 0 0 2px ${rawTokens.light["status-running-bg"]}`);
  });
});

describe("keyboard map", () => {
  it("lists both shortcuts with their labels", () => {
    const p = page();
    const map = new KeyboardMap("darwin");
    installAppearance(p.win, p.store, map);
    expect(
      // Both of these have a key; `Shortcut.key` is optional as of #205 and the fallback
      // is what keeps this a comparison of strings rather than of `string | undefined`.
      map
        .list()
        .map((s) => [s.scope, s.key, shortcutLabel(s.key ?? "", "darwin"), shortcutLabel(s.key ?? "", "win32")]),
    ).toEqual([
      ["global", "Mod+Shift+L", "⌘⇧L", "Ctrl+Shift+L"],
      ["global", "Mod+Shift+D", "⌘⇧D", "Ctrl+Shift+D"],
    ]);
  });

  it("refuses two registrations of one key in one scope, and frees the key on unregister", () => {
    const map = new KeyboardMap("darwin");
    const off = map.register({ scope: "global", key: "mod+shift+l", label: "a", action: () => {} });
    expect(() => map.register({ scope: "global", key: "Mod+Shift+L", label: "b", action: () => {} })).toThrow(
      /already registered/,
    );
    map.register({ scope: "run-tree", key: "Mod+Shift+L", label: "c", action: () => {} });
    off();
    expect(() => map.register({ scope: "global", key: "Mod+Shift+L", label: "d", action: () => {} })).not.toThrow();
  });

  it("normalises keys and reads them off events with the platform's modifier", () => {
    expect(normalizeKey("shift+mod+l")).toBe("Mod+Shift+L");
    expect(normalizeKey("Escape")).toBe("Escape");
    expect(() => normalizeKey("Hyper+L")).toThrow(/unknown modifier/);
    const p = page();
    expect(keyOfEvent(p.key({ key: "L", code: "KeyL", metaKey: true, shiftKey: true }), "darwin")).toBe("Mod+Shift+L");
    expect(keyOfEvent(p.key({ key: "L", code: "KeyL", metaKey: true, shiftKey: true }), "linux")).toBe("Shift+L");
    expect(keyOfEvent(p.key({ key: "l", code: "KeyL", ctrlKey: true }), "win32")).toBe("Mod+L");
    expect(keyOfEvent(p.key({ key: "1", code: "Digit1", metaKey: true }), "darwin")).toBe("Mod+1");
    expect(keyOfEvent(p.key({ key: "Escape", code: "Escape" }), "darwin")).toBe("Escape");
    expect(keyOfEvent(p.key({ key: "Shift", code: "ShiftLeft", shiftKey: true }), "darwin")).toBeUndefined();
  });

  it("dispatches in the first scope that has the key and prevents the default", () => {
    const map = new KeyboardMap("darwin");
    const global = vi.fn();
    const tree = vi.fn();
    map.register({ scope: "global", key: "F", label: "global f", action: global });
    map.register({ scope: "run-tree", key: "F", label: "tree f", action: tree });
    const p = page();
    const event = p.key({ key: "f", code: "KeyF" });
    expect(map.handle(event, ["run-tree", "global"])).toBe(true);
    expect(tree).toHaveBeenCalledOnce();
    expect(global).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(map.handle(p.key({ key: "g", code: "KeyG" }))).toBe(false);
  });
});
