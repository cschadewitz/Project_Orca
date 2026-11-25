/**
 * Moving a workspace's store from its name before the rename to Orrery (0.9) to its name since,
 * {@link STORE_DIR_NAME}.
 *
 * Until the codemod runs the two names are the same string and this does nothing. After it,
 * a workspace whose store is still under the old name is moved once, atomically, under the
 * store's format lock and with no writer registered (the same terms as a metadata switch,
 * store-writers.ts). A pointer stays at the old name for one release: a symlink on POSIX, so
 * an older binary still finds the store, and a small marker file on Windows, where a symlink
 * needs a privilege, so an older binary fails to open it rather than starting an empty store.
 *
 * Any failure leaves the old directory exactly as it was, and the store is opened there.
 */
import { lstatSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { OrcaError } from "@orca/core";
import { withFileLock } from "./file-lock.js";
import { STORE_FORMAT_LOCK } from "./store-format-lock.js";
import { activeStoreSwitch, beginStoreSwitch, liveStoreWriters, STORE_SWITCH_FILE } from "./store-writers.js";

/** The store directory's default name, beside the config file. */
export const STORE_DIR_NAME = ".orca";
/** Its name before the rename. Moved from, and pointed back to for one release; never created. */
export const LEGACY_STORE_DIR_NAME = ".orca"; // rename-keep: the pre-rename store directory, moved once

export interface AdoptLegacyStoreDirOptions {
  /** The old directory. Default: {@link LEGACY_STORE_DIR_NAME} beside a store named {@link STORE_DIR_NAME}. */
  legacyDir?: string;
  /** Recorded in the switch announcement while the move runs. */
  appVersion?: string;
  /** What stays at the old name. Default: a symlink, or a marker file on Windows. */
  pointer?: "symlink" | "marker";
  warn?: (message: string) => void;
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * The directory to open for `storeDir`: `storeDir` itself, after moving the old directory there
 * when only the old one exists, or the old directory when that move could not be made. Only a
 * store under the default name is moved; a `storeDir` the config names otherwise is the user's.
 */
export async function adoptLegacyStoreDir(storeDir: string, options: AdoptLegacyStoreDirOptions = {}): Promise<string> {
  const warn = options.warn ?? ((message: string) => void process.stderr.write(`${message}\n`));
  if (options.legacyDir === undefined && basename(storeDir) !== STORE_DIR_NAME) return storeDir;
  const legacy = options.legacyDir ?? join(dirname(storeDir), LEGACY_STORE_DIR_NAME);
  if (legacy === storeDir || exists(storeDir)) return storeDir;
  try {
    if (!lstatSync(legacy).isDirectory()) return storeDir;
  } catch {
    return storeDir;
  }
  const lock = join(legacy, STORE_FORMAT_LOCK);
  try {
    await withFileLock(lock, async (stillHeld) => {
      if (exists(storeDir)) return; // another process moved it while this one waited
      // This holder's token, to release the lock where it lands after the move: the lock
      // directory moves with the store, and the old path stops resolving on Windows.
      const tokens = readdirSync(lock);
      if (tokens.length !== 1 || !tokens[0]!.startsWith(`owner.${process.pid}.`))
        throw new OrcaError("STORE_LOCK_LOST", `lock ${lock} is not held by this process`, { path: lock });
      const active = activeStoreSwitch(legacy);
      if (active)
        throw new OrcaError("STORE_FORMAT", `${legacy} is being switched by process ${active.pid} on ${active.host}`, {
          reason: "SWITCHING",
          storeDir: legacy,
        });
      const announcement = beginStoreSwitch(legacy, options.appVersion ?? "unknown");
      try {
        const writers = liveStoreWriters(legacy);
        if (writers.length)
          throw new OrcaError("STORE_FORMAT", `${legacy} is open in ${writers.length} other process(es)`, {
            reason: "BUSY",
            storeDir: legacy,
          });
        await stillHeld();
        renameSync(legacy, storeDir);
      } catch (error) {
        announcement.end();
        throw error;
      }
      // Moved. End the announcement and release the lock at the new path; the lock's own release
      // then finds nothing at the old one.
      try {
        rmSync(join(storeDir, STORE_SWITCH_FILE), { force: true });
        unlinkSync(join(storeDir, STORE_FORMAT_LOCK, tokens[0]!));
        rmdirSync(join(storeDir, STORE_FORMAT_LOCK));
      } catch (error) {
        warn(`warning: moved ${legacy} to ${storeDir}, but could not release its lock: ${(error as Error).message}`);
      }
    });
  } catch (error) {
    if (exists(storeDir)) return storeDir;
    warn(`warning: could not move ${legacy} to ${storeDir} (${(error as Error).message}); opening it where it is`);
    return legacy;
  }
  if (!exists(storeDir)) return legacy;
  if (exists(legacy)) return storeDir; // a pointer another process left, or a store an older binary began meanwhile
  try {
    if ((options.pointer ?? (process.platform === "win32" ? "marker" : "symlink")) === "symlink")
      symlinkSync(relative(dirname(legacy), storeDir), legacy, "dir");
    else
      writeFileSync(
        legacy,
        `This store moved to ${storeDir} when ORCA was renamed Orrery (0.9). Delete this file once nothing older runs here.\n`, // rename-keep: names the product as it was
        { flag: "wx" },
      );
  } catch (error) {
    warn(`warning: moved ${legacy} to ${storeDir}, but could not leave a pointer: ${(error as Error).message}`);
  }
  warn(`moved the store ${legacy} to ${storeDir}`);
  return storeDir;
}
