/**
 * The Linux window icon path (src/main/window-icon.ts) and the packaging entry that puts the
 * file there: the two have to agree, or the packaged tar.gz opens a window with no icon.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { LINUX_ICON_RESOURCE, windowIcon } from "../src/main/window-icon.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const where = { resourcesPath: "/opt/ORCA/resources", appRoot };

describe("windowIcon", () => {
  test("Linux gets the packaged PNG beside app.asar", () => {
    expect(windowIcon("linux", { ...where, packaged: true })).toEqual({
      icon: join("/opt/ORCA/resources", "icon.png"),
    });
  });

  test("a dev run on Linux uses the build resource, which exists", () => {
    const { icon } = windowIcon("linux", { ...where, packaged: false });
    expect(icon).toBe(join(appRoot, "build", "icon.png"));
    expect(existsSync(icon!)).toBe(true);
  });

  test("macOS and Windows take the icon from the bundle and the executable", () => {
    expect(windowIcon("darwin", { ...where, packaged: true })).toEqual({});
    expect(windowIcon("win32", { ...where, packaged: true })).toEqual({});
  });

  test("electron-builder ships the PNG to the resource name the window reads", () => {
    const config = parse(readFileSync(join(appRoot, "electron-builder.yml"), "utf8")) as {
      linux: { extraResources?: { from: string; to: string }[] };
    };
    expect(config.linux.extraResources).toContainEqual({ from: "build/icon.png", to: LINUX_ICON_RESOURCE });
  });
});
