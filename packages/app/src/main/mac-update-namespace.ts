/** Explicit first provisioning, separate from opening an already established journal. */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ClosedUpdateWindow, provisionUpdateWindow, type UpdateWindowDurability } from "@orca/protocol/update-window";
import { loadDiagnosticsAddon } from "./diagnostics/native-addon.js";
import type { NativeStorageBackend } from "./diagnostics/native-storage.js";

const unavailable = () => new Error("Native replacement namespace unavailable");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function durability(backend: NativeStorageBackend): UpdateWindowDurability {
  const flush = backend.flushDescriptorSync;
  if (typeof flush !== "function") throw unavailable();
  return Object.freeze({ fileSync: (fd: number) => flush(fd) });
}
export function createNativeClosedUpdateWindow(control: string, fixture?: NativeStorageBackend): ClosedUpdateWindow {
  const backend =
    fixture ??
    (process.platform === "darwin" ? (loadDiagnosticsAddon("diagnostics_storage") as NativeStorageBackend) : undefined);
  if (!backend || backend.abi !== 1 || backend.replacementStorage !== 1 || (!fixture && backend.platform !== "darwin"))
    throw unavailable();
  return new ClosedUpdateWindow(control, durability(backend));
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
  const backend =
    fixture ??
    (process.platform === "darwin" ? (loadDiagnosticsAddon("diagnostics_storage") as NativeStorageBackend) : undefined);
  if (!backend || backend.abi !== 1 || backend.replacementStorage !== 1 || (!fixture && backend.platform !== "darwin"))
    throw unavailable();
  const flush = durability(backend);
  const guards = await Promise.all(
    protectedRoots.map(async (root) => {
      try {
        await lstat(join(root, ".orca-update-window.json"));
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
  if (names.some((name) => !["journal", "window.json", "window.json.tmp", "enrolled.json", "pairs"].includes(name)))
    throw unavailable();
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
