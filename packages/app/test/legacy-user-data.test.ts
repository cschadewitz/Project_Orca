/** The one-time carry of settings from the pre-rename userData folder (src/main/legacy-user-data.ts). */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARRY_MARKER, carryLegacyUserData, LEGACY_USER_DATA_NAME } from "../src/main/legacy-user-data.js";

let appData: string;
let legacy: string;
let userData: string;
beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), "legacy-user-data-"));
  legacy = join(appData, LEGACY_USER_DATA_NAME);
  userData = join(appData, "Orrery");
  mkdirSync(join(legacy, "remote-daemons", "credentials"), { recursive: true });
  writeFileSync(join(legacy, "preferences.json"), '{"theme":"dark"}\n');
  writeFileSync(join(legacy, "remote-daemons", "profiles.json"), '{"version":1,"profiles":[]}\n');
  writeFileSync(join(legacy, "remote-daemons", "credentials", "p1.credential"), "sealed");
  writeFileSync(join(legacy, "admission-intents.enc"), "sealed with the old name's key");
  mkdirSync(join(legacy, "Cache"));
});
afterEach(() => rmSync(appData, { recursive: true, force: true }));

const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

test("copies preferences and remote daemons into a new, empty folder and leaves the old one", () => {
  expect(carryLegacyUserData(userData)).toBe("copied");
  expect(read(userData, "preferences.json")).toBe('{"theme":"dark"}\n');
  expect(read(userData, "remote-daemons", "profiles.json")).toBe('{"version":1,"profiles":[]}\n');
  expect(read(userData, "remote-daemons", "credentials", "p1.credential")).toBe("sealed");
  // Nothing else comes across, and nothing leaves the old folder.
  expect(existsSync(join(userData, "admission-intents.enc"))).toBe(false);
  expect(existsSync(join(userData, "Cache"))).toBe(false);
  expect(read(legacy, "preferences.json")).toBe('{"theme":"dark"}\n');
  expect(existsSync(join(legacy, "remote-daemons", "profiles.json"))).toBe(true);
});

test("counts a folder Chromium already made, with none of the carried items, as empty", () => {
  mkdirSync(join(userData, "GPUCache"), { recursive: true });
  expect(carryLegacyUserData(userData)).toBe("copied");
  expect(existsSync(join(userData, "preferences.json"))).toBe(true);
});

test("runs once: a later launch never copies again, even after the settings are reset", () => {
  expect(carryLegacyUserData(userData)).toBe("copied");
  rmSync(join(userData, "preferences.json"));
  rmSync(join(userData, "remote-daemons"), { recursive: true });
  expect(carryLegacyUserData(userData)).toBe("already-set-up");
  expect(existsSync(join(userData, "preferences.json"))).toBe(false);
  expect(existsSync(join(userData, CARRY_MARKER))).toBe(true);
});

test("never overwrites settings the new folder already has", () => {
  mkdirSync(userData);
  writeFileSync(join(userData, "preferences.json"), '{"theme":"light"}\n');
  expect(carryLegacyUserData(userData)).toBe("already-set-up");
  expect(read(userData, "preferences.json")).toBe('{"theme":"light"}\n');
  expect(existsSync(join(userData, "remote-daemons"))).toBe(false);
});

test("does nothing without an old folder, or when the folder never changed name", () => {
  rmSync(legacy, { recursive: true });
  expect(carryLegacyUserData(userData)).toBe("nothing-to-copy");
  expect(existsSync(userData)).toBe(false);
  expect(carryLegacyUserData(legacy)).toBe("same-folder");
});

test("copies whichever of the two the old folder has", () => {
  rmSync(join(legacy, "remote-daemons"), { recursive: true });
  expect(carryLegacyUserData(userData)).toBe("copied");
  expect(existsSync(join(userData, "preferences.json"))).toBe(true);
  expect(existsSync(join(userData, "remote-daemons"))).toBe(false);
});
