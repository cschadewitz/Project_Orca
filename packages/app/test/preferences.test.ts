import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferencesFile } from "../src/preferences/preferences-file.js";
import { DEFAULT_PREFERENCES, mergePreferences, PreferencesSchema } from "../src/preferences/schema.js";

describe("preferences", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-prefs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("defaults to following the OS with every surface comfortable", () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      theme: "system",
      density: {},
      // Every pane at the width the design chose, which is the absence of a remembered one (#276).
      panes: {},
      // Opt-in per tier, and the one tier that holds an agent turn open is the one that is
      // on (#162, docs/design/20-attention-and-gates.md).
      alerts: { permission: true, gate: false, failure: false, unfocusedEscalationMs: 300_000 },
    });
    expect(new PreferencesFile(join(dir, "missing", "preferences.json")).read()).toEqual(DEFAULT_PREFERENCES);
  });

  it("writes a patch over what is on disk and reads it back", () => {
    const file = new PreferencesFile(join(dir, "nested", "preferences.json"));
    const alerts = DEFAULT_PREFERENCES.alerts;
    expect(file.write({ theme: "dark" })).toEqual({ theme: "dark", density: {}, panes: {}, alerts });
    expect(file.write({ density: { runs: "compact" } })).toEqual({
      theme: "dark",
      density: { runs: "compact" },
      panes: {},
      alerts,
    });
    expect(file.write({ density: { config: "comfortable" } }).density).toEqual({
      runs: "compact",
      config: "comfortable",
    });
    expect(new PreferencesFile(file.path).read()).toEqual({
      theme: "dark",
      density: { runs: "compact", config: "comfortable" },
      panes: {},
      alerts,
    });
    expect(JSON.parse(readFileSync(file.path, "utf8"))).toEqual(file.read());
  });

  it("falls back to defaults on a corrupt or invalid file, with a warning, and recovers on the next write", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = new PreferencesFile(join(dir, "preferences.json"));
    writeFileSync(file.path, "{ not json");
    expect(file.read()).toEqual(DEFAULT_PREFERENCES);
    writeFileSync(file.path, JSON.stringify({ theme: "sepia" }));
    expect(file.read()).toEqual(DEFAULT_PREFERENCES);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(file.write({ theme: "light" })).toEqual({
      theme: "light",
      density: {},
      panes: {},
      alerts: DEFAULT_PREFERENCES.alerts,
    });
  });

  it("rejects a patch that is not a preference", () => {
    const file = new PreferencesFile(join(dir, "preferences.json"));
    expect(() => file.write({ theme: "sepia" })).toThrow();
    expect(() => file.write({ density: { runs: "tiny" } })).toThrow();
    /* A pane size is a whole number of px or a fraction of its container below 1 (#276,
       #281). A pane of nothing is neither, and nor is a fractional *length*. */
    expect(() => file.write({ panes: { sidebar: 0 } })).toThrow();
    expect(() => file.write({ panes: { sidebar: 240.5 } })).toThrow();
    expect(() => file.write({ panes: { "runs-tree": -0.4 } })).toThrow();
    expect(() => file.write("dark")).toThrow();
  });

  it("takes a fraction as well as a length, because a stacked boundary is a ratio (#281)", () => {
    const file = new PreferencesFile(join(dir, "fractions", "preferences.json"));
    /* Which id is which shape is the renderer's registry, not this schema's: what is asserted
       here is only that both shapes survive a write and a re-read of the file. */
    expect(file.write({ panes: { "runs-tree": 0.42, sidebar: 300 } }).panes).toEqual({
      "runs-tree": 0.42,
      sidebar: 300,
    });
    expect(new PreferencesFile(file.path).read().panes).toEqual({ "runs-tree": 0.42, sidebar: 300 });
  });

  it("merges density by surface and replaces the theme", () => {
    const current = PreferencesSchema.parse({ theme: "light", density: { runs: "compact" } });
    expect(mergePreferences(current, {})).toEqual(current);
    expect(mergePreferences(current, { theme: "system", density: { plan: "compact" } })).toEqual({
      theme: "system",
      density: { runs: "compact", plan: "compact" },
      panes: {},
      alerts: DEFAULT_PREFERENCES.alerts,
    });
  });

  it("merges pane sizes by boundary, and null is how one goes back to its default (#276)", () => {
    const file = new PreferencesFile(join(dir, "panes", "preferences.json"));
    expect(file.write({ panes: { sidebar: 300 } }).panes).toEqual({ sidebar: 300 });
    // A second boundary is a second key: resizing the dock says nothing about the sidebar.
    expect(file.write({ panes: { panel: 560 } }).panes).toEqual({ sidebar: 300, panel: 560 });
    /* Back to the default is a deletion and not a write of the token's value: the record holds
       only the sizes somebody chose, so the next change to `panel-width` reaches this window. */
    expect(file.write({ panes: { panel: null } }).panes).toEqual({ sidebar: 300 });
    expect(new PreferencesFile(file.path).read().panes).toEqual({ sidebar: 300 });
  });

  it("merges a graph canvas's view by canvas and by field, and never mentions graphs until one is set", () => {
    const file = new PreferencesFile(join(dir, "canvases", "preferences.json"));
    // A person who has never turned a graph has a file that does not say anything about graphs.
    expect("canvases" in file.write({ theme: "dark" })).toBe(false);

    expect(file.write({ canvases: { workflow: { direction: "vertical" } } }).canvases).toEqual({
      workflow: { direction: "vertical" },
    });
    // Hiding the minimap says only that: the direction chosen a moment ago is kept.
    expect(file.write({ canvases: { workflow: { minimap: false } } }).canvases).toEqual({
      workflow: { direction: "vertical", minimap: false },
    });
    // A second canvas is a second key: the plan graph is read its own way.
    expect(file.write({ canvases: { "plan-graph": { direction: "horizontal" } } }).canvases).toEqual({
      workflow: { direction: "vertical", minimap: false },
      "plan-graph": { direction: "horizontal" },
    });
    expect(new PreferencesFile(file.path).read().canvases?.workflow).toEqual({ direction: "vertical", minimap: false });
    // Two directions and no third.
    expect(() => file.write({ canvases: { workflow: { direction: "diagonal" } } })).toThrow();
  });

  it("merges alert tiers one at a time, so turning gates on says only that", () => {
    const file = new PreferencesFile(join(dir, "alerts", "preferences.json"));
    expect(file.write({ alerts: { gate: true } }).alerts).toEqual({
      permission: true,
      gate: true,
      failure: false,
      unfocusedEscalationMs: 300_000,
    });
    // The tier that was not named keeps what it had, rather than going back to its default.
    expect(file.write({ alerts: { permission: false } }).alerts.gate).toBe(true);
    expect(new PreferencesFile(file.path).read().alerts).toEqual({
      permission: false,
      gate: true,
      failure: false,
      unfocusedEscalationMs: 300_000,
    });
    expect(() => file.write({ alerts: { unfocusedEscalationMs: 0 } })).toThrow();
  });
});
