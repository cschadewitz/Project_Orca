/**
 * The folder the NSIS uninstaller removes (#1109) is the one electron-builder writes: its
 * `updaterCacheDirName` is package.json's name with the characters a file name cannot hold
 * removed, lower-cased, plus `-updater`. A rename of the package would otherwise leave the
 * uninstaller deleting a folder nobody writes.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { UPDATER_CACHE } from "../src/main/legacy-updater-cache.js";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

it("removes the updater cache electron-builder names after the package", () => {
  const { name } = JSON.parse(read("../package.json")) as { name: string };
  const cache = `${name.replace(/[/\\:*?"<>|]/g, "").toLowerCase()}-updater`;
  expect(cache).toBe("@orcaapp-updater");
  // The app's first renamed launch tells the old cache from its own by this name.
  expect(UPDATER_CACHE).toBe(cache);
  const nsh = read("../build/installer.nsh");
  expect(nsh).toContain(`RMDir /r "$LOCALAPPDATA\\${cache}"`);
  // Never during an update, which runs the uninstaller with --updated.
  expect(nsh).toMatch(/\$\{ifNot\} \$\{isUpdated\}[\s\S]*RMDir[\s\S]*\$\{endIf\}/);
});
