/**
 * rename-keep-start: this paragraph names the old folder
 * The ORCA -> Orrery rename moved the app's settings folder: Electron names it after
 * productName, so `ORCA` became `Orrery` beside it (`%APPDATA%`, `~/Library/Application
 * Support`, `~/.config`). On the first launch under the new name this copies the saved
 * preferences and remote daemon profiles across, once, and leaves the old folder where it is.
 * rename-keep-end
 *
 * Those two, and the first-run selection receipt (`first-run/selection.json`), so a workspace
 * set up before the rename reopens without being chosen again. Everything else in the folder
 * is either Chromium's own cache or sealed with a key the new name does not hold. A profile's
 * sealed credential comes across with its profile and is read, or refused and asked for
 * again, exactly as `RemoteProfiles` does today.
 *
 * Compatibility for v0.9.0 only; v0.10.0 removes it with the other old-name reads.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The folder name before the rename. */
export const LEGACY_USER_DATA_NAME = "ORCA"; // rename-keep: the pre-rename settings folder
/** What is carried across. */
export const CARRIED_ITEMS = ["preferences.json", "remote-daemons", "first-run"] as const;
/** Written once the carry has run, so it never runs a second time. */
export const CARRY_MARKER = "legacy-user-data.json";

export type CarryResult = "copied" | "nothing-to-copy" | "already-set-up" | "same-folder";

export function carryLegacyUserData(userData: string, legacyName: string = LEGACY_USER_DATA_NAME): CarryResult {
  const legacy = join(dirname(userData), legacyName);
  if (basename(userData) === legacyName) return "same-folder";
  if ([CARRY_MARKER, ...CARRIED_ITEMS].some((item) => existsSync(join(userData, item)))) return "already-set-up";
  const items = CARRIED_ITEMS.filter((item) => existsSync(join(legacy, item)));
  if (items.length === 0) return "nothing-to-copy";
  mkdirSync(userData, { recursive: true });
  for (const item of items)
    cpSync(join(legacy, item), join(userData, item), { recursive: true, errorOnExist: true, force: false });
  writeFileSync(join(userData, CARRY_MARKER), `${JSON.stringify({ from: legacy, items }, null, 2)}\n`);
  return "copied";
}
