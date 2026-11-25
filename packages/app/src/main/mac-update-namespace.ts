/** Explicit first provisioning, separate from opening an already established journal, plus
 * the re-anchoring of an open namespace and the person-confirmed reset of a lost one. */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ClosedUpdateWindow,
  provisionUpdateWindow,
  enrollUpdateWindowRoots,
  reanchorUpdateWindow,
  resetUpdateWindow,
  updateWindowResettable,
  type UpdateWindowDurability,
  type UpdateWindowState,
} from "@orca/protocol/update-window";
import { loadDiagnosticsAddon } from "./diagnostics/native-addon.js";
import type { NativeStorageBackend } from "./diagnostics/native-storage.js";

const unavailable = () => new Error("Native replacement namespace unavailable");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function durability(backend: NativeStorageBackend): UpdateWindowDurability {
  const flush = backend.flushDescriptorSync;
  if (typeof flush !== "function") throw unavailable();
  return Object.freeze({ fileSync: (fd: number) => flush(fd) });
}
/** The packaged Darwin addon, or an injected conformance backend. */
function nativeBackend(fixture?: NativeStorageBackend): NativeStorageBackend {
  const backend =
    fixture ??
    (process.platform === "darwin" ? (loadDiagnosticsAddon("diagnostics_storage") as NativeStorageBackend) : undefined);
  if (!backend || backend.abi !== 1 || backend.replacementStorage !== 1 || (!fixture && backend.platform !== "darwin"))
    throw unavailable();
  return backend;
}
export function createNativeClosedUpdateWindow(control: string, fixture?: NativeStorageBackend): ClosedUpdateWindow {
  return new ClosedUpdateWindow(control, durability(nativeBackend(fixture)));
}

export async function enrollMacUpdateRoots(
  control: string,
  roots: readonly string[],
  fixture?: NativeStorageBackend,
): Promise<void> {
  await enrollUpdateWindowRoots(control, roots, durability(nativeBackend(fixture)));
}

/** True when the updater journal holds nothing but its lock. A journal record binds its
 * encryption AAD to the journal's original path and may be an attempt in flight, so a
 * namespace holding one is never re-anchored or reset. */
async function journalClear(control: string, allowMissing: boolean): Promise<boolean> {
  try {
    return (await readdir(join(control, "journal"))).every((name) => name === "writer.lock");
  } catch (error) {
    if (allowMissing && missing(error)) return true;
    throw error;
  }
}

/** Re-anchor an established, open namespace no attempt holds, after its directories were
 * migrated, restored or moved, or a crash tore provisioning or an enrollment. Refuses an
 * attempt recorded in the window or the journal. */
export async function reanchorMacUpdateNamespace(
  control: string,
  protectedRoots: readonly string[],
  fixture?: NativeStorageBackend,
): Promise<UpdateWindowState> {
  const flush = durability(nativeBackend(fixture));
  if (!(await journalClear(control, false))) throw unavailable();
  return reanchorUpdateWindow(control, protectedRoots, flush);
}

/** Whether startup may offer the person a reset: the window is unreadable, or lost behind a
 * surviving app-root guard, and neither the window nor the journal records an attempt. */
export async function macUpdateNamespaceResettable(control: string, protectedRoots: readonly string[]) {
  try {
    return (await journalClear(control, true)) && updateWindowResettable(control, protectedRoots);
  } catch {
    return false;
  }
}

/** Only after the person confirms. The next launch provisions as on first launch. */
export async function resetMacUpdateNamespace(control: string, protectedRoots: readonly string[]): Promise<void> {
  if (!(await journalClear(control, true))) throw unavailable();
  await resetUpdateWindow(control, protectedRoots);
}

/** Must run under the already captured pre-producer launch authority, before startup
 * inspection. Existing root guards independently remember control identity; missing control
 * behind any surviving guard is lost authority and may never be silently provisioned.
 * Injection is only compiled-backend conformance evidence, never production activation. */
export async function provisionMacUpdateNamespace(
  control: string,
  protectedRoots: readonly string[],
  fixture?: NativeStorageBackend,
): Promise<void> {
  const backend = nativeBackend(fixture);
  const flush = durability(backend);
  const guards = await Promise.all(
    protectedRoots.map(async (root) => {
      try {
        await lstat(join(root, ".orca-update-window.json")); // rename-keep: the update-window guard the release being updated from writes (protocol update-window.ts)
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    }),
  );
  let existing = false;
  try {
    await lstat(control);
    existing = true;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (!existing && guards.some(Boolean)) throw unavailable();
  const provision = async (path: string) => {
    const handle = await backend.call(
      "provisionReplacementRoot",
      undefined,
      undefined,
      path,
      "replacement",
      undefined,
      0,
      0,
      0,
    );
    await backend.call("closeRoot", handle, undefined, "", "", undefined, 0, 0, 0);
  };
  await provision(control);
  const names = await readdir(control);
  const known = ["journal", "window.json", "window.json.tmp", "enrolled.json", "enrolled.json.tmp"];
  if (names.some((name) => ![...known, "pairs", "inspection", "downloads"].includes(name))) throw unavailable();
  const journal = join(control, "journal");
  try {
    await lstat(journal);
  } catch (error) {
    if (!missing(error) || names.includes("enrolled.json") || names.includes("window.json")) throw unavailable();
    await provision(journal);
  }
  const journalHandle = await backend.call(
    "openRoot",
    undefined,
    undefined,
    journal,
    "replacement",
    undefined,
    0,
    0,
    0,
  );
  await backend.call("closeRoot", journalHandle, undefined, "", "", undefined, 0, 0, 0);
  await provisionUpdateWindow(control, protectedRoots, flush);
}
