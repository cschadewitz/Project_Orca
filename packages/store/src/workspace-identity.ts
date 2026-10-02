/** Owner-controlled identity metadata. Backups include this directory as a unit. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./file-lock.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repair = () =>
  new Error(
    "Workspace identity metadata is damaged; restore a complete backup or explicitly repair it while the daemon is stopped",
  );
async function ownerPath(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw repair();
}

/**
 * The marker is published first: interrupted initialization fails closed. Losing the ID
 * after initialization is distinguishable from a first upgrade. Never remove the marker.
 */
export async function workspaceIdentity(storeDir: string): Promise<string> {
  return identityOperation(storeDir);
}

/** Explicit offline clone/repair operation; never called automatically by startup. */
export async function renewWorkspaceIdentity(storeDir: string): Promise<string> {
  return identityOperation(storeDir, true);
}
async function identityOperation(storeDir: string, renew = false): Promise<string> {
  await mkdir(storeDir, { recursive: true });
  return withFileLock(join(storeDir, ".workspace-identity.lock"), async () => {
    const dir = join(storeDir, "workspace-identity");
    const marker = join(storeDir, ".workspace-identified");
    let identified = false;
    try {
      await ownerPath(marker, false);
      identified = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let exists = false;
    try {
      await ownerPath(dir, true);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!renew && (identified || exists)) {
      if (!identified || !exists) throw repair();
      try {
        await ownerPath(join(dir, "id"), false);
        const id = (await readFile(join(dir, "id"), "utf8")).trim();
        if (!UUID.test(id)) throw repair();
        return id;
      } catch {
        throw repair();
      }
    }
    if (!identified) await writeFile(marker, "1\n", { flag: "wx", mode: 0o600 });
    if (!exists) await mkdir(dir, { mode: 0o700 });
    const id = randomUUID();
    const tmp = join(dir, `${id}.tmp`);
    await writeFile(tmp, `${id}\n`, { flag: "wx", mode: 0o600 });
    await rename(tmp, join(dir, "id"));
    return id;
  });
}
