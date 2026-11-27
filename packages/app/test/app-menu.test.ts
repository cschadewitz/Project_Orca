/**
 * The application menu (#164): the two commands that are this app's, and the roles that
 * have to survive replacing Electron's default menu.
 *
 * The second half is the part worth a test — setting a menu replaces the whole default
 * one, and an app with no Edit menu has no ⌘C on macOS, which would break **Copy link** on
 * every surface that offers it.
 */
import { describe, expect, it } from "vitest";
import { appMenuTemplate, type MenuTemplateItem } from "../src/main/app-menu.js";

const NOTHING = { openStore: () => {}, connectLive: () => {} };

const menu = (template: MenuTemplateItem[], label: string): MenuTemplateItem[] => {
  const found = template.find((item) => item.label === label);
  return Array.isArray(found?.submenu) ? found.submenu : [];
};

const roles = (items: MenuTemplateItem[]): (string | undefined)[] => items.map((item) => item.role);

describe("appMenuTemplate", () => {
  it("puts opening a store and reconnecting in the File menu", () => {
    const opened: string[] = [];
    const template = appMenuTemplate("linux", "ORCA", {
      openStore: () => opened.push("open"),
      connectLive: () => opened.push("live"),
    });

    const file = menu(template, "File");
    expect(file.map((item) => item.label)).toContain("Open a store…");
    expect(file.map((item) => item.label)).toContain("Connect to a daemon…");

    // Electron hands a click three arguments this app has no use for; the handler takes none.
    const open = file.find((item) => item.label === "Open a store…")?.click as (() => void) | undefined;
    open?.();
    expect(opened).toEqual(["open"]);
  });

  it("keeps the clipboard roles, which is where ⌘C lives once a menu is set", () => {
    expect(roles(menu(appMenuTemplate("darwin", "ORCA", NOTHING), "Edit"))).toEqual(
      expect.arrayContaining(["cut", "copy", "paste", "selectAll"]),
    );
  });

  it("gives macOS an app menu with Quit in it, and everyone else Quit in File", () => {
    const mac = appMenuTemplate("darwin", "ORCA", NOTHING);
    expect(mac[0]?.label).toBe("ORCA");
    expect(roles(menu(mac, "ORCA"))).toContain("quit");
    expect(roles(menu(mac, "File"))).toContain("close");

    const linux = appMenuTemplate("linux", "ORCA", NOTHING);
    expect(linux[0]?.label).toBe("File");
    expect(roles(menu(linux, "File"))).toContain("quit");
  });

  it("binds Ctrl+Q to Quit on every platform, Windows included (#1209)", () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      const template = appMenuTemplate(platform, "ORCA", NOTHING);
      const quits = template
        .flatMap((item) => (Array.isArray(item.submenu) ? item.submenu : []))
        .filter((item) => item.role === "quit");
      expect(quits, platform).toHaveLength(1);
      expect(quits[0]?.accelerator, platform).toBe("CmdOrCtrl+Q");
    }
  });

  it("offers the inspector only where a developer is already running a dev server", () => {
    expect(roles(menu(appMenuTemplate("linux", "ORCA", NOTHING, true), "View"))).toContain("toggleDevTools");
    expect(roles(menu(appMenuTemplate("linux", "ORCA", NOTHING, false), "View"))).not.toContain("toggleDevTools");
  });
});
