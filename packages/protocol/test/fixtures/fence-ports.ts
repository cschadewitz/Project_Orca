/** Kernel-fence port selection for disposable fixtures (#807, #819, #1084, #1088).
 *
 * The update window fences a directory by listening on eight loopback ports hashed from its
 * identity (path, device, inode), and the first-run fence holds one such port for a workspace.
 * Those ports land anywhere in 20000-59999, and most of that
 * span overlaps the kernel's ephemeral (autobind) range, where every outgoing loopback
 * connection made by any process on the machine, including parallel test workers, takes
 * its local port. A fixture whose slot fell there failed with EADDRINUSE, or startup closed
 * as "unknown", whenever another worker happened to hold that port.
 *
 * Production keeps its mapping. Fixtures instead choose directory identities whose slots
 * lie outside the autobind range, so nothing the kernel assigns can collide with them. Only
 * the fixture's inode is chosen; every scenario still binds the real hashed ports. */
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { fenceBoot, fenceDirectory, fenceHash, fencePort } from "@orca/protocol/first-run-fence";

export type FenceIdentity = ReturnType<typeof fenceDirectory>;

/** Mirrors update-window's identity-to-port mapping: eight consecutive slots. */
export function fencePorts(identity: FenceIdentity): number[] {
  const start =
    20000 +
    (Number.parseInt(
      fenceHash(JSON.stringify(["orca-update-window-v1", fenceBoot().kernelDomain, identity])).slice(0, 8), // rename-keep: mirrors protocol's update-window guard, which keeps its pre-rename name
      16,
    ) %
      5000) *
      8;
  return Array.from({ length: 8 }, (_, slot) => start + slot);
}

let range: readonly [number, number] | undefined;
/** The kernel's ephemeral port range. Off Linux, or if it cannot be read, assume the widest
 * common range so selection stays conservative. */
export function autobindRange(): readonly [number, number] {
  if (range) return range;
  try {
    const [low, high] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
    if (Number.isInteger(low) && Number.isInteger(high) && low! > 0 && high! >= low!) return (range = [low!, high!]);
  } catch {
    // Fall through to the conservative default.
  }
  return (range = [32768, 65535]);
}

/** Which fences a fixture directory is held under: the update window's eight slots (the
 * default), the first-run fence's one port for a workspace, or both. */
export type Fences = { readonly updateWindow?: boolean; readonly firstRun?: boolean };
const UPDATE_WINDOW: Fences = { updateWindow: true };

/** Whether no port of `identity`, fenced under any of `paths` by `fences`, can be taken by kernel autobind. */
export function clearOfAutobind(
  identity: FenceIdentity,
  paths: readonly string[] = [identity.path],
  fences: Fences = UPDATE_WINDOW,
): boolean {
  const [low, high] = autobindRange();
  const clear = (port: number) => port < low || port > high;
  return paths.every((path) => {
    const at = { ...identity, path };
    return (!fences.updateWindow || fencePorts(at).every(clear)) && (!fences.firstRun || clear(fencePort(at)));
  });
}

const SELECTION_LIMIT = 256;

/** Replace the empty directory at `path` with fresh ones until its identity is clear of
 * autobind for `fences` under `path` and every alias (paths the same inode is later fenced
 * under, such as after a rename). Rejected directories are kept until the end so a freed
 * inode cannot come straight back. About a third of identities qualify per path and fence,
 * so this is bounded. */
export async function selectFenceDirectory(
  path: string,
  aliases: readonly string[] = [],
  fences: Fences = UPDATE_WINDOW,
): Promise<void> {
  const { mode } = await stat(path);
  const rejected: string[] = [];
  try {
    for (let attempt = 0; attempt < SELECTION_LIMIT; attempt++) {
      if (clearOfAutobind(fenceDirectory(path), [path, ...aliases], fences)) return;
      const aside = `${path}.rejected-${attempt}`;
      await rename(path, aside);
      rejected.push(aside);
      await mkdir(path, { mode: mode & 0o7777 });
    }
    throw new Error(`No fixture identity clear of the autobind range after ${SELECTION_LIMIT} directories`);
  } finally {
    for (const aside of rejected) await rm(aside, { recursive: true, force: true });
  }
}

/** Copy `source` to `path` (which must not exist) as a new inode clear of autobind under
 * `path` and every alias. Each rejected copy is kept until the end, as above. */
export async function copyToFenceDirectory(
  source: string,
  path: string,
  copy: (from: string, to: string) => Promise<void>,
  aliases: readonly string[] = [],
): Promise<void> {
  const rejected: string[] = [];
  try {
    for (let attempt = 0; attempt < SELECTION_LIMIT; attempt++) {
      const candidate = `${path}.candidate-${attempt}`;
      await copy(source, candidate);
      if (clearOfAutobind(fenceDirectory(candidate), [path, ...aliases])) {
        await rename(candidate, path);
        return;
      }
      rejected.push(candidate);
    }
    throw new Error(`No fixture copy clear of the autobind range after ${SELECTION_LIMIT} directories`);
  } finally {
    for (const candidate of rejected) await rm(candidate, { recursive: true, force: true });
  }
}
