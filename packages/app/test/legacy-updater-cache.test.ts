/** The first renamed launch removes the updater cache a pre-rename install left (src/main/legacy-updater-cache.ts). */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LEGACY_UPDATER_CACHE, removeLegacyUpdaterCache, UPDATER_CACHE } from "../src/main/legacy-updater-cache.js";

let local: string;
beforeEach(() => {
  local = mkdtempSync(join(tmpdir(), "legacy-updater-cache-"));
  mkdirSync(join(local, LEGACY_UPDATER_CACHE, "pending"), { recursive: true });
  writeFileSync(join(local, LEGACY_UPDATER_CACHE, "pending", "installer.exe"), "old installer");
  writeFileSync(join(local, LEGACY_UPDATER_CACHE, "installer.exe"), "old installer");
});
afterEach(() => rmSync(local, { recursive: true, force: true }));

it.runIf(LEGACY_UPDATER_CACHE !== UPDATER_CACHE)(
  "removes the pre-rename cache and leaves the current one and its neighbours alone",
  () => {
    mkdirSync(join(local, UPDATER_CACHE));
    writeFileSync(join(local, UPDATER_CACHE, "installer.exe"), "current installer");
    mkdirSync(join(local, "Programs"));
    expect(removeLegacyUpdaterCache(local)).toBe("removed");
    expect(existsSync(join(local, LEGACY_UPDATER_CACHE))).toBe(false);
    expect(existsSync(join(local, UPDATER_CACHE, "installer.exe"))).toBe(true);
    expect(existsSync(join(local, "Programs"))).toBe(true);
    // Every later launch finds nothing to do.
    expect(removeLegacyUpdaterCache(local)).toBe("absent");
  },
);

it("never removes the cache the running app uses", () => {
  // Before the codemod the two names are one: this is the app's own cache.
  const expected = LEGACY_UPDATER_CACHE === UPDATER_CACHE ? "same-name" : "removed";
  expect(removeLegacyUpdaterCache(local)).toBe(expected);
  expect(existsSync(join(local, UPDATER_CACHE))).toBe(expected === "same-name");
});

it.runIf(LEGACY_UPDATER_CACHE !== UPDATER_CACHE)("does nothing without LOCALAPPDATA or an old cache", () => {
  expect(removeLegacyUpdaterCache(undefined)).toBe("absent");
  rmSync(join(local, LEGACY_UPDATER_CACHE), { recursive: true });
  expect(removeLegacyUpdaterCache(local)).toBe("absent");
});
