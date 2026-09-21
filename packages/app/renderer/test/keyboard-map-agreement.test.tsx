// @vitest-environment happy-dom
/**
 * The keyboard map in `docs/design/50-accessibility-and-keyboard.md`, and the command
 * palette, asserted against each other (#167).
 *
 * The spec makes one claim in each direction and they are not the same claim:
 *
 * - **every action in the table is registered**, in the scope the table files it under. A
 *   surface that stopped registering `F`, or moved it to `list`, is a shortcut the table
 *   still promises and the app no longer has.
 * - **every registered shortcut is in the palette**, with its key beside it. That is the
 *   whole point of the registry — "a shortcut that skips it is a shortcut nobody can
 *   discover" (AGENTS.md) — and since #205 made `Shortcut.key` optional it has a second
 *   edge: a keyless command is *only* reachable from the palette, so a palette that
 *   dropped it would make it unreachable rather than merely undiscoverable.
 *
 * The converse of the first claim is deliberately not asserted, because the spec
 * deliberately does not hold it: "a command may register with no key at all and be
 * reachable from the palette alone".
 *
 * **What this cannot see, and what it is for anyway.** No test can prove an action nobody
 * wrote down is missing — a button with an `onClick` and no registration is invisible to
 * the registry by construction. What this does is make the table and the registry agree, so
 * a later surface that adds a mouse-only action has to either register it (and appear in
 * the palette) or leave the table's promise unkept in a way that shows up here rather than
 * in somebody's hands.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { DockedPanel } from "../src/chrome/docked-panel.js";
import { ArtifactPanelProvider, useArtifactPanel, type ArtifactTarget } from "../src/artifacts/panel-context.js";
import { cardName } from "../src/attention/answer-card.js";
import { commandEntries } from "../src/palette/entries.js";
import { shortcutLabel, type RegisteredShortcut, type ShortcutScope } from "../src/keyboard-map.js";
import { RUN_ART } from "./fixtures-artifacts.js";
import { FIVE_GATES, INPUTS_AS_OF } from "./fixtures-inputs.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
const teardown: (() => void)[] = [];

beforeEach(() => {
  stubMatchMedia(1440);
  fake = installBridge();
  teardown.push(fake.install());
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

/**
 * The table in `docs/design/50-accessibility-and-keyboard.md`, transcribed — the design's
 * column headings on the left, the map's own notation on the right (`Mod` is ⌘ on macOS and
 * Ctrl elsewhere; `keyboard-map.ts` normalises both).
 *
 * `Esc` is the one row with no entry here and it is not an omission: "`Esc` belongs to the
 * layer stack, not to your component" (AGENTS.md). It closes the topmost transient layer
 * from one place above every scope, is asserted in `layers.test.ts`, and registering it in
 * the map would be the second implementation #202 exists to prevent.
 */
const KEYBOARD_MAP: readonly { scope: ShortcutScope; key: string; action: string }[] = [
  { scope: "global", key: "Mod+K", action: "Command palette" },
  { scope: "global", key: "Mod+1", action: "Attention" },
  { scope: "global", key: "Mod+2", action: "Runs" },
  { scope: "global", key: "Mod+3", action: "Plan" },
  { scope: "global", key: "Mod+4", action: "Agents" },
  { scope: "global", key: "Mod+5", action: "Config" },
  { scope: "global", key: "Mod+\\", action: "Toggle the docked panel" },
  { scope: "global", key: "Mod+Shift+D", action: "Toggle density on the focused surface" },
  { scope: "global", key: "Mod+Shift+L", action: "Cycle theme" },
  { scope: "list", key: "J", action: "Move selection down" },
  { scope: "list", key: "K", action: "Move selection up" },
  { scope: "list", key: "ArrowDown", action: "Move selection down" },
  { scope: "list", key: "ArrowUp", action: "Move selection up" },
  { scope: "run-tree", key: "ArrowRight", action: "Expand" },
  { scope: "run-tree", key: "ArrowLeft", action: "Collapse, or go to the parent" },
  { scope: "run-tree", key: "Shift+ArrowRight", action: "Expand the whole subtree" },
  { scope: "run-tree", key: "Enter", action: "Open step detail" },
  { scope: "run-tree", key: "F", action: "Filter to failed and waiting descendants" },
  { scope: "stream", key: "G", action: "Top" },
  { scope: "stream", key: "Shift+G", action: "Bottom, and re-enter following" },
  { scope: "stream", key: "/", action: "Search within the stream" },
  { scope: "stream", key: "N", action: "Next match" },
  { scope: "stream", key: "Shift+N", action: "Previous match" },
  { scope: "card", key: "1", action: "Select option 1" },
  { scope: "card", key: "Enter", action: "Submit" },
  { scope: "card", key: "Shift+Enter", action: "Submit with a note" },
  { scope: "card", key: "G", action: "Go to the run" },
  { scope: "panel", key: "[", action: "Previous artifact version" },
  { scope: "panel", key: "]", action: "Next artifact version" },
  { scope: "workflow", key: "ArrowDown", action: "Next node in this layer" },
  { scope: "workflow", key: "ArrowUp", action: "Previous node in this layer" },
  { scope: "workflow", key: "ArrowRight", action: "Next layer" },
  { scope: "workflow", key: "ArrowLeft", action: "Previous layer" },
  { scope: "workflow", key: "Enter", action: "Expand or collapse the selected node" },
  { scope: "workflow", key: "+", action: "Zoom in" },
  { scope: "workflow", key: "-", action: "Zoom out" },
  { scope: "workflow", key: "0", action: "Reset the zoom and the pan" },
  { scope: "workflow", key: "Shift+ArrowRight", action: "Pan right" },
  { scope: "workflow", key: "Shift+ArrowLeft", action: "Pan left" },
  { scope: "workflow", key: "Shift+ArrowDown", action: "Pan down" },
  { scope: "workflow", key: "Shift+ArrowUp", action: "Pan up" },
];

const slotsOf = (shortcuts: readonly RegisteredShortcut[]): Set<string> =>
  new Set(shortcuts.filter((s) => s.key !== undefined).map((s) => `${s.scope}:${s.key!}`));

/**
 * Mount, wait for whatever the mounting waits for, read the registry, then take it down.
 *
 * The mounting builds its own harness rather than being handed one, because two of the
 * three below have to arrange the bridge *before* `harness()` reads it — the notification
 * stream is built over `window.orca` at construction, exactly as `main.tsx` builds it.
 */
async function registered(mount: () => Promise<Harness>): Promise<readonly RegisteredShortcut[]> {
  const h = await mount();
  const list = h.keyboard.list();
  cleanup();
  h.dispose();
  return list;
}

/** The chrome on Attention, with a gate that has the keyboard: `global`, `list` and `card`. */
async function chromeOnAttention(): Promise<Harness> {
  const inputs = [FIVE_GATES[0]!];
  fake.script({ "inputs.list": () => ({ ok: true, result: { inputs, waiting: 1, asOf: INPUTS_AS_OF } }) });
  const h = harness();
  renderChrome(h);
  const gate = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
  // The card registers its keys while it has the keyboard, which is what makes them the
  // card's rather than the list's — the same card mounted inline in a run brings them with it.
  await act(async () => {
    gate.focus();
  });
  return h;
}

/**
 * The chrome on a step, reached the way every arrival at a step is reached — an `orca://`
 * URL through the route table (#165). It is the chrome rather than a bare `RunsSurface`
 * because the step pane only opens once the run's projection has answered and the tree has
 * resolved the node, which is the path a person takes and the one worth asserting over:
 * `run-tree`, `list` (the timeline) and `stream`.
 */
async function chromeOnAStep(): Promise<Harness> {
  fake = installBridge({ deepLink: "orca://run/run-parent/step/build.2" });
  teardown.push(fake.install());
  const h = harness();
  renderChrome(h);
  await screen.findByRole("tree", { name: "Run tree" });
  await screen.findByRole("log", { name: /^Output of build/ });
  return h;
}

/**
 * The chrome on a workflow, reached the way every arrival at one is: an `orca://workflow/…`
 * URL through the route table. The canvas is the whole of the `workflow` scope, and it holds
 * the scope alone — a nested graph draws through the same component with no registrations of
 * its own, because two `↑`s in one scope is an error by design.
 */
async function chromeOnAWorkflow(): Promise<Harness> {
  fake = installBridge({ deepLink: "orca://workflow/ai-sdlc" });
  teardown.push(fake.install());
  const h = harness();
  renderChrome(h);
  await screen.findByRole("listbox", { name: /graph$/ });
  return h;
}

/** The docked panel on an artifact with three versions: `panel`. */
async function panelOnAnArtifact(): Promise<Harness> {
  fake.script({
    "runs.get": ({ runId }) =>
      runId === "run-art"
        ? { ok: true, result: RUN_ART }
        : { ok: false, error: { code: "RUN_NOT_FOUND", message: runId } },
  });
  const h = harness();
  const { Providers } = h;
  const target: ArtifactTarget = { runId: "run-art", name: "spec", version: 3 };
  render(
    <Providers>
      <ArtifactPanelProvider>
        <Opener target={target} />
        <DockedPanel onClose={() => {}} />
      </ArtifactPanelProvider>
    </Providers>,
  );
  await waitFor(() => expect(screen.getByRole("group", { name: "Artifact versions" })).toBeTruthy());
  return h;
}

function Opener({ target }: { target: ArtifactTarget }): null {
  const panel = useArtifactPanel();
  useEffect(() => panel.open(target), []);
  return null;
}

describe("every action in the map is registered", () => {
  it("covers the whole table, in the scope the table files it under", async () => {
    /* Four mountings rather than one, because the table spans four screens: no single
       screen has a card, a run tree, a stream, an open artifact panel and a graph canvas at
       once, and a fourth list on one screen is not a missing scope (AGENTS.md). The union is
       what the app offers across the surfaces that exist. */
    const found = new Set<string>();
    for (const mount of [chromeOnAttention, chromeOnAStep, panelOnAnArtifact, chromeOnAWorkflow]) {
      for (const slot of slotsOf(await registered(mount))) found.add(slot);
    }

    const missing = KEYBOARD_MAP.filter((row) => !found.has(`${row.scope}:${row.key}`));
    expect(missing.map((row) => `${row.scope} ${row.key} (${row.action})`)).toEqual([]);
  });

  it("registers a digit per option on a card, never one that leads nowhere", async () => {
    // "1–9" in the table is a range over the options a card actually has: the gate fixture
    // offers two, so two digits are bound and `3` is not a key that does nothing.
    const card = (await registered(chromeOnAttention)).filter((s) => s.scope === "card");
    const digits = card.filter((s) => s.key !== undefined && /^[1-9]$/.test(s.key)).map((s) => s.key);
    expect(digits.sort()).toEqual(["1", "2"]);
    expect(FIVE_GATES[0]!.options).toHaveLength(2);
  });
});

describe("every registered shortcut is in the palette", () => {
  it("turns each one into exactly one row, keyed by the slot the map gave it", async () => {
    const shortcuts = await registered(chromeOnAttention);
    const entries = commandEntries(shortcuts, "darwin", ["card", "list", "global"]);

    // One row per shortcut, and the ids are unique because they are the map's own slots —
    // `scope:key` is not a name two keyless commands could differ by (#205).
    expect(entries).toHaveLength(shortcuts.length);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const shortcut of shortcuts) {
      const entry = entries.find((e) => e.id === `command:${shortcut.id}`);
      expect(entry, shortcut.label).toBeDefined();
      expect(entry!.label).toBe(shortcut.label);
      // The key is rendered for the platform, and absent entirely when there is none.
      expect(entry!.shortcut).toBe(shortcut.key === undefined ? undefined : shortcutLabel(shortcut.key, "darwin"));
    }
  });

  it("lists a keyless command with no chip rather than leaving it out", async () => {
    const h = harness();
    teardown.push(h.dispose);
    // A command worth doing but not worth one of the letters left (#205). The palette is
    // then the whole of how it is reached, so a palette that dropped it would lose it.
    teardown.push(h.keyboard.register({ scope: "global", label: "Re-read the workspace", action: () => {} }));

    const entries = commandEntries(h.keyboard.list(), "darwin", ["global"]);
    const keyless = entries.find((e) => e.label === "Re-read the workspace");
    expect(keyless).toBeDefined();
    expect(keyless!.shortcut).toBeUndefined();
    expect("shortcut" in keyless!).toBe(false);
  });

  it("shows every one of them as a row a person can run, in the palette on screen", async () => {
    const inputs = [FIVE_GATES[0]!];
    fake.script({ "inputs.list": () => ({ ok: true, result: { inputs, waiting: 1, asOf: INPUTS_AS_OF } }) });
    const h = harness();
    teardown.push(h.dispose);
    renderChrome(h);
    const gate = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    await act(async () => {
      gate.focus();
    });

    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });

    /* Every shortcut in the map, on screen, at once. Not "the palette has some rows": the
       registry is the source and the palette is a view of it, so the assertion is that the
       view has lost nothing — including the shortcuts belonging to scopes focus is not in,
       which are still things the person can reach right now. */
    const rows = within(palette).getAllByRole("option");
    const labels = new Set(rows.map((row) => row.textContent ?? ""));
    for (const shortcut of h.keyboard.list()) {
      expect(
        [...labels].some((text) => text.includes(shortcut.label)),
        shortcut.label,
      ).toBe(true);
    }

    // And the key is beside the one that has it, in this platform's notation.
    const opener = rows.find((row) => (row.textContent ?? "").includes("Open the command palette"))!;
    expect(opener).toBeDefined();
    expect(opener.textContent).toContain(shortcutLabel("Mod+K", "darwin"));
  });
});
