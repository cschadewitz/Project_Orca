/**
 * The window's icon on Linux: the ORCA mark (`packages/design/brand`, rendered into
 * `build/icon.png`). macOS takes the app icon from the bundle's `.icns` and Windows from the
 * executable's `.ico`, both written by electron-builder, so neither is given one here. A
 * Linux window has no such source: AppImage puts the PNG in its launcher metadata, but the
 * tar.gz is the bare unpacked app, so without an explicit icon its window shows none.
 *
 * Packaged, the PNG is beside app.asar, copied there by the `linux.extraResources` entry in
 * `electron-builder.yml` (an asar path is not a file the window manager can read); in a dev
 * run it is the build resource itself. A plain function, so the path can be asserted without
 * an Electron main process (`test/window-icon.test.ts`).
 */
import { join } from "node:path";

/** The name the icon is shipped under in `process.resourcesPath`. */
export const LINUX_ICON_RESOURCE = "icon.png";

export function windowIcon(
  platform: NodeJS.Platform,
  where: { packaged: boolean; resourcesPath: string; appRoot: string },
): { icon?: string } {
  if (platform !== "linux") return {};
  return {
    icon: where.packaged
      ? join(where.resourcesPath, LINUX_ICON_RESOURCE)
      : join(where.appRoot, "build", LINUX_ICON_RESOURCE),
  };
}
