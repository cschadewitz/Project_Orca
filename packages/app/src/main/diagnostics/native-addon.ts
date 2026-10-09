/** Fixed native location: Electron uses external resources and never repository fallback. */
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Addon = "diagnostics_clock" | "diagnostics_storage";
export interface NativeAddonRuntime {
  platform: string;
  arch: string;
  electron: boolean;
  resourcesPath?: string;
}

/** Pure location seam for source/compiled/packaged acceptance. No caller-selected filename. */
export function diagnosticsAddonPath(addon: Addon, runtime: NativeAddonRuntime): string | undefined {
  if (addon !== "diagnostics_clock" && addon !== "diagnostics_storage") return undefined;
  if (!["darwin", "win32"].includes(runtime.platform) || !["arm64", "x64"].includes(runtime.arch)) return undefined;
  if (runtime.electron) {
    const root = runtime.resourcesPath;
    if (!root || !isAbsolute(root) || resolve(root) !== root) return undefined;
    return join(root, "native", "diagnostics", `${runtime.platform}-${runtime.arch}`, `${addon}.node`);
  }
  // src/main/diagnostics and dist/main/diagnostics have the same depth.
  return fileURLToPath(new URL(`../../../native/diagnostics/build/Release/${addon}.node`, import.meta.url));
}

export function loadDiagnosticsAddon(addon: Addon): unknown {
  const path = diagnosticsAddonPath(addon, {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron !== undefined,
    ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {}),
  });
  if (!path) return undefined;
  try {
    return createRequire(import.meta.url)(path) as unknown;
  } catch {
    return undefined;
  }
}
