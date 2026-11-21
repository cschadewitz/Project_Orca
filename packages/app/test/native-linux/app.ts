/**
 * Launch, observe and quit the *installed* ORCA package inside a `NativeSession`.
 *
 * Playwright drives the packaged binary through `executablePath`, so this is the same file
 * a tester starts from the menu. That works because the package leaves Electron's
 * `EnableNodeCliInspectArguments` fuse on; if a later hardening pass turns it off,
 * `launchInstalled` fails at once with Playwright's "inspector" error rather than hanging.
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { readdir, readFile, readlink } from "node:fs/promises";
import type { NativeSession } from "./session.js";

/** The package's install path (build/linux/after-install.tpl, docs/INSTALL-LINUX.md). */
export const EXECUTABLE = process.env.ORCA_NATIVE_EXECUTABLE ?? "/opt/ORCA/orca-desktop";

/**
 * How long a reopened window may take to be visible. The #860 fix shows the window on
 * `ready-to-show`, else 500 ms after load, else 4 s after creation, so anything past this
 * is the fallback having failed too.
 */
export const VISIBLE_BUDGET_MS = 8_000;

export type Backend = "x11" | "wayland";

export interface Launched {
  app: ElectronApplication;
  page: Page;
  /** Milliseconds from launch until the main process reported a visible window. */
  msToVisible: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launchInstalled(
  session: NativeSession,
  profile: string,
  backend: Backend = "x11",
  extraEnv: Record<string, string> = {},
): Promise<Launched> {
  const env = { ...session.env, ...extraEnv };
  const args = [`--user-data-dir=${profile}`];
  if (backend === "wayland") {
    env.WAYLAND_DISPLAY = await session.startWayland();
    env.XDG_SESSION_TYPE = "wayland";
    // No X fallback: if Wayland fails, this launch must fail rather than quietly use Xvfb.
    delete env.DISPLAY;
    args.push("--ozone-platform=wayland");
  }
  const started = Date.now();
  const app = await electron.launch({ executablePath: EXECUTABLE, args, env, timeout: 30_000 });
  try {
    const page = await app.firstWindow({ timeout: 30_000 });
    // firstWindow resolves when the BrowserWindow exists, which is not when anyone can see
    // it: #858's window existed and was never shown. Ask the main process instead.
    const msToVisible = await windowVisible(app, started);
    return { app, page, msToVisible };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

/** Poll the main process until a window reports `isVisible()`, within the budget. */
export async function windowVisible(app: ElectronApplication, started: number): Promise<number> {
  const deadline = started + VISIBLE_BUDGET_MS;
  for (;;) {
    const visible = await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()))
      .catch(() => false);
    if (visible) return Date.now() - started;
    if (Date.now() > deadline)
      throw new Error(`No ORCA window became visible within ${VISIBLE_BUDGET_MS} ms of launch (#858)`);
    await sleep(100);
  }
}

/** Processes running the installed executable (the app, its helpers and the bundled daemon). */
export async function installedProcesses(): Promise<number[]> {
  const pids: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if ((await readlink(`/proc/${name}/exe`)) === EXECUTABLE) pids.push(Number(name));
    } catch {
      // Gone, or another user's process.
    }
  }
  return pids;
}

export async function commandLine(pid: number): Promise<string> {
  return (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).replaceAll("\0", " ");
}

/**
 * Quit the way a person does and require that the app and its bundled daemon are all gone.
 *
 * On X11 that is a real Ctrl+Q sent to the ORCA window by xdotool: Playwright's own key
 * presses go through the DevTools protocol into the page and never reach Electron's menu
 * accelerators. Headless Wayland has no input injection, so there the app menu's own Quit
 * item is clicked from the main process, which is the action Ctrl+Q is bound to.
 */
export async function quit(session: NativeSession, launched: Launched, backend: Backend): Promise<void> {
  const { app } = launched;
  const exit = new Promise<void>((resolve) => {
    const child = app.process();
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  if (backend === "x11") {
    const [window] = await session.visibleWindows("^ORCA$");
    if (!window) throw new Error("No visible X11 window named ORCA to send Ctrl+Q to");
    await session.key(window, "ctrl+q");
  } else {
    const clicked = await app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const item of items) {
          if (
            item.role === "quit" ||
            /^(CmdOrCtrl|CommandOrControl|Ctrl|Control)\+Q$/i.test(String(item.accelerator ?? ""))
          )
            return item;
          const inner = item.submenu ? find(item.submenu.items) : undefined;
          if (inner) return inner;
        }
        return undefined;
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      if (!item) return false;
      // Deferred, so this evaluate returns before the main process starts shutting down.
      setTimeout(() => item.click(), 0);
      return true;
    });
    if (!clicked) throw new Error("The app menu has no Quit item (role quit or Ctrl+Q)");
  }
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000));
  if ((await Promise.race([exit, timer])) === "timeout") {
    await app.close().catch(() => undefined);
    throw new Error(`Quit (${backend}) did not end ORCA within 15 s`);
  }
  await noneLeft();
}

/** Every process of the installed executable has exited (the daemon may take a moment). */
export async function noneLeft(timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const left = await installedProcesses();
    if (left.length === 0) return;
    if (Date.now() > deadline) {
      const lines = await Promise.all(left.map(async (pid) => `${pid} ${await commandLine(pid)}`));
      throw new Error(`ORCA processes outlived quit:\n${lines.join("\n")}`);
    }
    await sleep(200);
  }
}
