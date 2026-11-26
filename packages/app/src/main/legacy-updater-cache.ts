/**
 * electron-builder names the Windows updater's cache after package.json's name (#1109): the
 * installer keeps a copy of itself there for differential updates, beside the updater's
 * pending download. The rename changed that name, so an install from before it leaves its old
 * cache under `%LOCALAPPDATA%` that neither the renamed updater nor the uninstaller touches.
 * The first launch under the new name removes it, best-effort, for v0.9.0 only.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/** `@orca/app`, sanitized, plus `-updater` (test/windows-uninstall-cache.test.ts). */
export const UPDATER_CACHE: string = "@orcaapp-updater";
/** The same before the rename. */
export const LEGACY_UPDATER_CACHE: string = "@orcaapp-updater"; // rename-keep: the cache a pre-rename install left

export type CacheCleanup = "removed" | "absent" | "same-name" | "failed";

export function removeLegacyUpdaterCache(localAppData: string | undefined): CacheCleanup {
  if (LEGACY_UPDATER_CACHE === UPDATER_CACHE) return "same-name";
  if (!localAppData) return "absent";
  const legacy = join(localAppData, LEGACY_UPDATER_CACHE);
  if (!existsSync(legacy)) return "absent";
  try {
    rmSync(legacy, { recursive: true, force: true, maxRetries: 2 });
    return "removed";
  } catch {
    // A file held open (an antivirus scan, a stray installer) leaves it for the next launch.
    return "failed";
  }
}
