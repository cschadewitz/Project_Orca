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
      // Opt-in per tier, and the one tier that holds an agent turn open is the one that is
      // on (#162, docs/design/20-attention-and-gates.md).
      alerts: { permission: true, gate: false, failure: false, unfocusedEscalationMs: 300_000 },
    });
    expect(new PreferencesFile(join(dir, "missing", "preferences.json")).read()).toEqual(DEFAULT_PREFERENCES);
  });

  it("writes a patch over what is on disk and reads it back", () => {
    const file = new PreferencesFile(join(dir, "nested", "preferences.json"));
    const alerts = DEFAULT_PREFERENCES.alerts;
    expect(file.write({ theme: "dark" })).toEqual({ theme: "dark", density: {}, alerts });
    expect(file.write({ density: { runs: "compact" } })).toEqual({
      theme: "dark",
      density: { runs: "compact" },
      alerts,
    });
    expect(file.write({ density: { config: "comfortable" } }).density).toEqual({
      runs: "compact",
      config: "comfortable",
    });
    expect(new PreferencesFile(file.path).read()).toEqual({
      theme: "dark",
      density: { runs: "compact", config: "comfortable" },
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
      alerts: DEFAULT_PREFERENCES.alerts,
    });
  });

  it("rejects a patch that is not a preference", () => {
    const file = new PreferencesFile(join(dir, "preferences.json"));
    expect(() => file.write({ theme: "sepia" })).toThrow();
    expect(() => file.write({ density: { runs: "tiny" } })).toThrow();
    expect(() => file.write("dark")).toThrow();
  });

  it("merges density by surface and replaces the theme", () => {
    const current = PreferencesSchema.parse({ theme: "light", density: { runs: "compact" } });
    expect(mergePreferences(current, {})).toEqual(current);
    expect(mergePreferences(current, { theme: "system", density: { plan: "compact" } })).toEqual({
      theme: "system",
      density: { runs: "compact", plan: "compact" },
      alerts: DEFAULT_PREFERENCES.alerts,
    });
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
