/** Node-only, fixed-location Windows first-run boundary. No environment or caller-selected addon. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

declare const __ORCA_FIRST_RUN_BUNDLED__: boolean | undefined;
const identity = z
  .object({
    path: z.string(),
    dev: z.string().regex(/^win32:ntfs:[a-f0-9]{16}:[a-f0-9-]{36}$/),
    ino: z.string().regex(/^win32:file:[a-f0-9]{32}$/),
    uid: z.string().regex(/^win32:sid:S-1-[0-9-]+$/),
  })
  .strict();
export type WindowsDirectory = z.infer<typeof identity>;
type Native = { abi: 1; platform: "win32"; call(operation: string, path: string | object, argument: unknown): unknown };
let loaded: Native | undefined;
function addonPath(name: "first_run_windows" | "diagnostics_clock"): string {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Windows first-run unavailable");
  if (typeof __ORCA_FIRST_RUN_BUNDLED__ !== "undefined" && __ORCA_FIRST_RUN_BUNDLED__)
    return fileURLToPath(new URL(`../native/diagnostics/win32-${process.arch}/${name}.node`, import.meta.url));
  if (process.versions.electron) {
    const root = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (!root || !isAbsolute(root) || resolve(root) !== root) throw new Error("Windows first-run unavailable");
    return join(root, "native", "diagnostics", `win32-${process.arch}`, `${name}.node`);
  }
  return fileURLToPath(new URL(`../../app/native/diagnostics/build/Release/${name}.node`, import.meta.url));
}
function native(): Native {
  if (!loaded) {
    const candidate: unknown = createRequire(import.meta.url)(addonPath("first_run_windows"));
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("abi" in candidate) ||
      candidate.abi !== 1 ||
      !("platform" in candidate) ||
      candidate.platform !== "win32" ||
      !("call" in candidate) ||
      typeof candidate.call !== "function"
    )
      throw new Error("Windows first-run unavailable");
    loaded = candidate as Native;
  }
  return loaded;
}
export function windowsDirectory(
  path: string,
  mode: "directory" | "project" | "parent" = "directory",
): WindowsDirectory {
  return identity.parse(native().call(mode, path, null));
}
export function windowsPrivateChild(path: string, parent?: WindowsDirectory): WindowsDirectory {
  return identity.parse(native().call("mkdir", path, parent ?? null));
}
export function windowsRead(path: string, limit = 4096): string {
  return z.string().parse(native().call("read", path, limit));
}
export function windowsFile(path: string): WindowsDirectory {
  return identity.parse(native().call("file", path, null));
}
export function windowsWrite(path: string, text: string, replace = false): void {
  native().call(replace ? "replace" : "write", path, text);
}
export function windowsLock(workspace: WindowsDirectory): { retain(): void; release(): void } {
  const backend = native();
  const handle = backend.call("lock", workspace.path, workspace);
  if (!handle || typeof handle !== "object") throw new Error("Windows first-run lock unavailable");
  return {
    retain: () => {
      backend.call("retain", handle, null);
    },
    release: () => {
      backend.call("release", handle, null);
    },
  };
}
export function windowsBoot(): { bootId: string; machine: string } {
  const clock: unknown = createRequire(import.meta.url)(addonPath("diagnostics_clock"));
  if (
    !clock ||
    typeof clock !== "object" ||
    !("abi" in clock) ||
    clock.abi !== 1 ||
    !("platform" in clock) ||
    clock.platform !== "win32" ||
    !("read" in clock) ||
    typeof clock.read !== "function"
  )
    throw new Error("Windows first-run boot unavailable");
  const reading = z.object({ bootId: z.string().uuid(), elapsedMs: z.number().nonnegative() }).parse(clock.read());
  const machine = z
    .string()
    .uuid()
    .parse(
      z
        .string()
        .parse(native().call("host", "", null))
        .toLowerCase(),
    );
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(machine)) throw new Error("Windows first-run host unavailable");
  return { bootId: reading.bootId, machine };
}
