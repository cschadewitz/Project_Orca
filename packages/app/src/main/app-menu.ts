/**
 * The application menu, which this app did not have until #164 gave it something to put in
 * one: **Open a store…** and **Connect to a daemon** are the File menu, and they are the
 * only way into and out of file mode that does not require a link or an environment
 * variable.
 *
 * Everything else here is a `role`. Electron's default menu is replaced the moment one is
 * set, and a window with no Edit menu has no ⌘C on macOS — where the clipboard shortcuts
 * are the *menu's*, not the web contents' — which would break **Copy link** on the very
 * surfaces this unit adds it to. So the standard roles are restated rather than dropped.
 *
 * The template is built by a plain function over a plain description so that what is in the
 * menu can be asserted without an Electron main process (`test/app-menu.test.ts`); turning
 * it into a real menu is one call in `index.ts`.
 */
import type { MenuItemConstructorOptions } from "electron";

/**
 * Electron's own template type, imported for its *type* only — the import is erased, so
 * this module still runs in a plain test with no Electron behind it, and the roles below
 * are checked against the list Electron actually accepts rather than against `string`.
 */
export type MenuTemplateItem = MenuItemConstructorOptions;

export interface AppMenuActions {
  /** File ▸ Open a store… — the dialog is the main process's, so this only asks for one. */
  openStore: () => void;
  /** File ▸ Connect to a daemon — leave file mode for the writable default. */
  connectLive: () => void;
}

/**
 * Quit, with its shortcut written down (#1209). Electron's `quit` role brings
 * `CommandOrControl+Q` on macOS and Linux but no accelerator at all on Windows, where the
 * role's only shortcut is the window manager's Alt+F4 — so Ctrl+Q did nothing there. The
 * role still does the quitting, so the shutdown is `app.quit()`, the same one closing the
 * last window reaches through `window-all-closed`.
 */
export const QUIT_ACCELERATOR = "CmdOrCtrl+Q";
const QUIT: MenuTemplateItem = { role: "quit", accelerator: QUIT_ACCELERATOR };

/**
 * The menu for this platform. macOS keeps the app menu in front and puts Quit in it;
 * everywhere else Quit belongs to File, which is why the two differ at all.
 */
export function appMenuTemplate(
  platform: string,
  appName: string,
  actions: AppMenuActions,
  isDev = false,
): MenuTemplateItem[] {
  const mac = platform === "darwin";

  const file: MenuTemplateItem = {
    label: "File",
    submenu: [
      // The ellipsis is the platform convention for "this opens a dialog", and it is the
      // one place the app writes a label that is not sentence case by its own rule (13) —
      // a menu item is a command, and "Open a store…" is how every other app spells it.
      { label: "Open a store…", accelerator: "CmdOrCtrl+O", click: actions.openStore },
      { label: "Connect to a daemon…", click: actions.connectLive },
      { type: "separator" },
      mac ? { role: "close" } : QUIT,
    ],
  };

  // Roles, not handlers: on macOS the clipboard shortcuts belong to the menu, so an app
  // that sets a menu without an Edit menu has no ⌘C at all.
  const edit: MenuTemplateItem = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const view: MenuTemplateItem = {
    label: "View",
    submenu: [
      { role: "reload" },
      // Only where a developer is already looking at a dev server: a packaged app that
      // offers the inspector in its menu invites a bug report about the inspector.
      ...(isDev ? [{ role: "toggleDevTools" } satisfies MenuTemplateItem] : []),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const windows: MenuTemplateItem = {
    label: "Window",
    submenu: mac ? [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] : [{ role: "minimize" }],
  };

  const appItem: MenuTemplateItem = {
    label: appName,
    submenu: [{ role: "about" }, { type: "separator" }, QUIT],
  };

  return [...(mac ? [appItem] : []), file, edit, view, windows];
}
