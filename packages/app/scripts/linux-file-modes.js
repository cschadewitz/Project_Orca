/**
 * Strip group and other write from every file in the unpacked Linux app before any target is
 * built from it (#853). electron-builder extracts the Electron zip without applying a umask,
 * so the tree it hands to fpm is 0666/0777, and fpm copies those modes into the .deb as they
 * are: installed under /opt/ORCA, any local user could then replace the binary the package's
 * AppArmor profile grants user namespaces to. Symlinks are left alone (their mode means
 * nothing), and nothing gains a bit it did not have.
 */
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WRITE_BY_OTHERS = 0o022;

/** Returns the paths whose mode it changed, relative to `root`. */
export function stripSharedWrite(root) {
  const changed = [];
  const visit = (path, relative) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    const mode = stat.mode & 0o7777;
    if (mode & WRITE_BY_OTHERS) {
      chmodSync(path, mode & ~WRITE_BY_OTHERS);
      changed.push(relative || ".");
    }
    if (stat.isDirectory())
      for (const name of readdirSync(path)) visit(join(path, name), relative ? `${relative}/${name}` : name);
  };
  visit(root, "");
  return changed;
}
