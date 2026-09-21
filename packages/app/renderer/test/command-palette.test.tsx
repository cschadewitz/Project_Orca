// @vitest-environment happy-dom
/**
 * The palette's "done when" (#149): every registered shortcut is listed with its key
 * beside it, the whole thing opens and navigates from the keyboard alone, and focus goes
 * back where it was on close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { THEMES } from "@orca/design";
import { LIVE, harness, renderChrome, stubBridge, stubMatchMedia, type Harness } from "./harness.js";
import { expectedToken, installDesignSystem, resolved, setTheme } from "./themes.js";
import { commandEntries, filterEntries, groupEntries } from "../src/palette/entries.js";
import type { RegisteredShortcut } from "../src/keyboard-map.js";
import { parseJump } from "../src/palette/jump.js";

const teardown: (() => void)[] = [];

function mount(): Harness {
  const h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
  return h;
}

const palette = (): HTMLElement => screen.getByRole("dialog", { name: "Command palette" });
const query = (): HTMLInputElement => screen.getByRole("combobox", { name: "Command palette" });
// Scoped to the palette: the Attention surface behind it is a screen with its own listbox
// in it now (the failed runs), and "the listbox" stopped being a unique thing on the page.
const options = (): HTMLElement[] => within(within(palette()).getByRole("listbox")).getAllByRole("option");
const selectedOption = (): HTMLElement => options().find((o) => o.getAttribute("aria-selected") === "true")!;

async function open(): Promise<void> {
  await screen.findByRole("button", { name: "Attention" });
  fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
  await screen.findByRole("dialog", { name: "Command palette" });
}

describe("the command palette", () => {
  beforeEach(() => {
    stubMatchMedia(1440);
    stubBridge(() => Promise.resolve(LIVE));
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("opens with ⌘K and closes with Esc", async () => {
    mount();
    await open();
    fireEvent.keyDown(query(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens from the title bar too, so it is not keyboard-only", async () => {
    mount();
    await screen.findByRole("button", { name: "Attention" });
    fireEvent.click(screen.getByRole("button", { name: /Commands/ }));
    expect(palette()).toBeTruthy();
  });

  it("gives the field the system's own focus ring, drawn from --border-focus (#260)", async () => {
    /* Rule 10 from the pixels' side, and the fix for #260. The field used to carry
       `outline: none`, deferring to a ring on `.orca-palette` that was never written — so
       ⌘K led to the only focusable thing on screen and nothing said so.

       `focus-and-selection.test.ts` reads the stylesheets as text and asserts nothing
       suppresses the ring anywhere; this asserts the other half, which text cannot: that
       *this* field, focused, in the real cascade, comes out bound to `--border-focus`. The
       expected side is the token's value in the theme, never a hex written here. */
    installDesignSystem();
    document.body.classList.add("orca"); // `index.html` puts it there; the layer is scoped under it.
    mount();
    await open();
    query().focus();
    expect(document.activeElement).toBe(query());

    for (const theme of THEMES) {
      setTheme(theme);
      expect(resolved(query(), "outline-color"), theme).toBe(expectedToken(theme, "border-focus"));
      // The ring's own width, and the palette-specific inset that keeps all four sides of
      // it inside an overlay that clips its content. Both are tokens, read as tokens.
      const width = resolved(document.documentElement, "--stroke-focus");
      expect(resolved(query(), "outline-width"), theme).toBe(width);
      expect(resolved(query(), "outline-style"), theme).toBe("solid");
      expect(resolved(query(), "outline-offset"), theme).toBe(`calc(-1 * ${width})`);
    }
    setTheme(undefined);
    document.body.classList.remove("orca");
  });

  it("lists every registered shortcut, each with its key beside it", async () => {
    const { keyboard } = mount();
    await open();

    const registered = keyboard.list();
    expect(registered.length).toBeGreaterThan(0);
    const rows = options().map((o) => o.textContent ?? "");
    for (const shortcut of registered) {
      // ⌘ notation, because the harness reports darwin. Matched on the label *and* the chip
      // rather than on the label alone: the list substrate gives `J` and `↓` one label
      // between them, so a row found by label could be the other one's. A keyless command
      // (#205) has no chip, and then the row itself is the whole assertion.
      const chip = shortcut.key?.replace("Mod+", "⌘").replace("Shift+", "⇧");
      const row = rows.find((text) => text.startsWith(shortcut.label) && (!chip || text.includes(chip)));
      expect(row, `${shortcut.label} ${chip ?? "(no key)"} is missing from the palette`).toBeTruthy();
    }
  });

  it("puts actions before navigation before search", async () => {
    mount();
    await open();
    const headers = [...within(palette()).getByRole("listbox").querySelectorAll(".orca-palette__group")].map(
      (h) => h.textContent,
    );
    expect(headers).toEqual(["Actions", "Navigation"]);
  });

  it("moves the selection and runs the selected entry from the keyboard alone", async () => {
    mount();
    await open();

    fireEvent.change(query(), { target: { value: "Go to Runs" } });
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(selectedOption().textContent).toContain("Go to Runs");

    fireEvent.keyDown(query(), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Runs" }).getAttribute("aria-current")).toBe("page");
  });

  it("wraps the selection at both ends", async () => {
    mount();
    await open();
    const first = selectedOption().id;

    fireEvent.keyDown(query(), { key: "ArrowUp" });
    expect(selectedOption().id).toBe(options()[options().length - 1]?.id);

    fireEvent.keyDown(query(), { key: "ArrowDown" });
    expect(selectedOption().id).toBe(first);
  });

  it("points aria-activedescendant at the selected row while focus stays in the field", async () => {
    mount();
    await open();
    expect(document.activeElement).toBe(query());
    expect(query().getAttribute("aria-activedescendant")).toBe(selectedOption().id);

    fireEvent.keyDown(query(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(query());
    expect(query().getAttribute("aria-activedescendant")).toBe(selectedOption().id);
  });

  it("returns focus to where it was when it closes", async () => {
    mount();
    const attention = await screen.findByRole("button", { name: "Attention" });
    attention.focus();

    fireEvent.keyDown(attention, { key: "k", code: "KeyK", metaKey: true });
    await screen.findByRole("dialog");
    expect(document.activeElement).toBe(query());

    fireEvent.keyDown(query(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(attention);
  });

  it("does not let the query field's letters reach the shortcuts beneath it", async () => {
    const { keyboard } = mount();
    const ran = vi.fn();
    teardown.push(keyboard.register({ scope: "global", key: "J", label: "Move down", action: ran }));
    await open();

    fireEvent.keyDown(query(), { key: "j", code: "KeyJ" });
    expect(ran).not.toHaveBeenCalled();
    expect(palette()).toBeTruthy();
  });

  it("offers a jump row for a run id, and it is runnable now that the route table exists", async () => {
    mount();
    await open();
    fireEvent.change(query(), { target: { value: "run_01J7K3QF8ZC4W2M6NP0XYTB5RD" } });

    const jump = await screen.findByRole("option", { name: /Open run/ });
    // Not `aria-disabled`: the chrome passes `onJump`, so the row resolves (#165).
    expect(jump.getAttribute("aria-disabled")).toBeNull();
    expect(jump.textContent).toContain("run_01J7K3QF8ZC4W2M6NP0XYTB5RD");
  });

  it("lists a source's entries under its section", async () => {
    const { paletteSources } = mount();
    teardown.push(
      paletteSources.register({
        id: "recent-runs",
        section: "navigation",
        entries: () => [{ id: "one", label: "Nightly build", detail: "run_01J", run: () => {} }],
      }),
    );
    await open();
    expect(await screen.findByRole("option", { name: /Nightly build/ })).toBeTruthy();
  });
});

describe("palette entries", () => {
  // Registered shortcuts, so each one carries the map's slot as its `id` (#205): that is
  // the name a row is keyed by, because `scope:key` is not a name two keyless commands
  // could differ by.
  const shortcuts: RegisteredShortcut[] = [
    {
      scope: "global",
      key: "Mod+1",
      id: "global:Mod+1",
      label: "Go to Attention",
      section: "navigation",
      action: () => {},
    },
    { scope: "run-tree", key: "F", id: "run-tree:F", label: "Filter to failed", action: () => {} },
    { scope: "global", key: "Mod+Shift+L", id: "global:Mod+Shift+L", label: "Cycle theme", action: () => {} },
  ];

  it("files a shortcut under its section, defaulting to actions", () => {
    const grouped = groupEntries(commandEntries(shortcuts, "darwin", ["global"]));
    expect(grouped.map((g) => g.id)).toEqual(["actions", "navigation"]);
    expect(grouped[0]?.entries.map((e) => e.label)).toContain("Filter to failed");
  });

  it("orders the scope focus is in first", () => {
    const inTree = commandEntries(shortcuts, "darwin", ["run-tree", "global"]);
    expect(inTree[0]?.label).toBe("Filter to failed");
    const outside = commandEntries(shortcuts, "darwin", ["global"]);
    expect(outside[0]?.label).toBe("Go to Attention");
  });

  it("renders each key for the platform", () => {
    const [attention] = commandEntries(shortcuts, "win32", ["global"]);
    expect(attention?.shortcut).toBe("Ctrl+1");
  });

  it("ranks a match at the start of a label above one in the middle", () => {
    const entries = commandEntries(shortcuts, "darwin", ["global"]);
    expect(filterEntries(entries, "go to").map((e) => e.label)).toEqual(["Go to Attention"]);
    expect(filterEntries(entries, "theme").map((e) => e.label)).toEqual(["Cycle theme"]);
    expect(filterEntries(entries, "nothing here")).toEqual([]);
  });
});

describe("jump targets", () => {
  it("recognises a run id with or without its prefix, and canonicalises it", () => {
    const id = "01J7K3QF8ZC4W2M6NP0XYTB5RD";
    expect(parseJump(id)?.url).toBe(`orca://run/run_${id}`);
    expect(parseJump(`run_${id}`)?.url).toBe(`orca://run/run_${id}`);
    expect(parseJump(`  run_${id.toLowerCase()}  `)?.url).toBe(`orca://run/run_${id}`);
  });

  it("recognises an orca:// URL as typed", () => {
    expect(parseJump("orca://gate/91c4")?.url).toBe("orca://gate/91c4");
    expect(parseJump("orca://artifact/spec.md@v3")?.label).toBe("Open link");
  });

  it("is not fooled by ordinary words or by a half-remembered id", () => {
    expect(parseJump("cancel run")).toBeUndefined();
    expect(parseJump("7f3a2c")).toBeUndefined();
    expect(parseJump("")).toBeUndefined();
    expect(parseJump("https://example.com/run")).toBeUndefined();
  });
});
