/**
 * A disposable Linux desktop session for the native acceptance specs: an X display, a
 * session bus, a GNOME login keyring that starts locked behind a password, the real
 * gcr-prompter that asks to unlock it, and on request a headless Wayland compositor.
 *
 * Everything lives under one temporary directory and one process list, and `stop()` takes
 * all of it down. Nothing is installed or reconfigured on the host: the tools are expected
 * on PATH (the workflow installs them with apt) and `requireTools()` names the missing ones.
 *
 * Why each piece exists is in `README.md` next to this file. The short version: Xvfb alone
 * never reproduced #858 (Wayland), and Playwright cannot see the keyring prompt of #857
 * because it is another process's window, so the prompt is answered with xdotool.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** The login keyring's password. Disposable: the keyring lives in this session's temp dir. */
export const KEYRING_PASSWORD = "orca-native-acceptance";

/** gcr-prompter's window title for the login keyring. */
const PROMPT_TITLE = "Unlock Login Keyring";

const TOOLS = ["Xvfb", "dbus-daemon", "gnome-keyring-daemon", "secret-tool", "xdotool", "weston"];

export type PromptAction = "cancel" | "unlock";

export interface PromptEvent {
  at: string;
  action: PromptAction;
}

export async function requireTools(): Promise<void> {
  const missing: string[] = [];
  for (const tool of TOOLS) {
    try {
      await execute("sh", ["-c", `command -v ${tool}`]);
    } catch {
      missing.push(tool);
    }
  }
  if (missing.length > 0)
    throw new Error(
      `The native Linux session needs ${missing.join(", ")} on PATH. On Ubuntu 24.04: sudo apt-get install xvfb dbus-x11 gnome-keyring gcr libsecret-tools xdotool weston`,
    );
  if (process.getuid?.() === 0)
    throw new Error("Run the native Linux specs as an unprivileged user: Chromium's sandbox refuses root.");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout} ms waiting for ${what}`);
    await sleep(100);
  }
}

async function exited(child: ChildProcess, timeout = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  await done;
  clearTimeout(timer);
}

export class NativeSession {
  readonly root: string;
  /** Environment for every child of this session, the app included. */
  readonly env: Record<string, string>;
  readonly prompts: PromptEvent[] = [];
  private readonly children: ChildProcess[] = [];
  private keyring: ChildProcess | undefined;
  private weston: ChildProcess | undefined;
  private answering: Promise<void> | undefined;
  private nextAction: PromptAction = "cancel";
  private stopping = false;

  private constructor(root: string, env: Record<string, string>) {
    this.root = root;
    this.env = env;
  }

  static async start(): Promise<NativeSession> {
    await requireTools();
    const root = await mkdtemp(join(tmpdir(), "orca-native-"));
    const home = join(root, "home");
    const runtime = join(root, "runtime");
    await mkdir(home, { recursive: true });
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    // A clean environment: nothing from the caller's desktop (a real DISPLAY, bus or
    // keyring) can leak in, so a pass here is a pass in this session and nowhere else.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      USER: process.env.USER ?? "tester",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: runtime,
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      // Electron picks its password store from the desktop name; without one it falls back
      // to basic_text and never asks the keyring, which is a different code path (#857).
      XDG_CURRENT_DESKTOP: "GNOME",
      XDG_SESSION_TYPE: "x11",
    };
    const session = new NativeSession(root, env);
    try {
      await session.startDisplay();
      await session.startBus();
      return session;
    } catch (error) {
      await session.stop();
      throw error;
    }
  }

  private track(child: ChildProcess) {
    this.children.push(child);
    child.on("error", () => undefined);
    return child;
  }

  private async startDisplay() {
    // -displayfd picks a free display number and writes it once the server is ready.
    const xvfb = this.track(
      spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
        env: this.env,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    let output = "";
    xvfb.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const display = await until("Xvfb's display number", async () => {
      const line = output.split("\n")[0]?.trim();
      return line && /^\d+$/.test(line) && output.includes("\n") ? line : undefined;
    });
    this.env.DISPLAY = `:${display}`;
  }

  private async startBus() {
    // The bus inherits DISPLAY, so the services it activates (gcr-prompter above all) can
    // open their windows on this display without dbus-update-activation-environment.
    const bus = this.track(
      spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1", "--nopidfile"], {
        env: this.env,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    let output = "";
    bus.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    this.env.DBUS_SESSION_BUS_ADDRESS = await until("the session bus address", async () =>
      output.includes("\n") ? output.split("\n")[0]!.trim() : undefined,
    );
  }

  /** Does the login keyring exist on disk yet? */
  async hasLoginKeyring(): Promise<boolean> {
    try {
      await stat(join(this.env.XDG_DATA_HOME!, "keyrings", "login.keyring"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A login keyring that exists, has a password and is locked, which is how a GNOME login
   * keyring looks to an app after auto-login or a manual lock. The first call creates it
   * (unlocking with a password creates it with that password); every call then restarts the
   * daemon without unlocking, because `secret-tool lock` hangs on gnome-keyring 46.
   */
  async lockedKeyring(): Promise<void> {
    await this.stopKeyring();
    if (!(await this.hasLoginKeyring())) {
      const creator = this.track(
        spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], {
          env: this.env,
          stdio: ["pipe", "ignore", "ignore"],
        }),
      );
      creator.stdin!.end(KEYRING_PASSWORD);
      await until("the login keyring to be created", async () => ((await this.hasLoginKeyring()) ? true : undefined));
      // A stored item proves the keyring is usable and gives it content, as a real one has.
      await this.secretTool(["store", "--label=orca-native-probe", "orca-native", "probe"], "probe");
      await exited(creator);
    }
    this.keyring = this.track(
      spawn("gnome-keyring-daemon", ["--foreground", "--components=secrets"], {
        env: this.env,
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
    await until("the keyring daemon to own org.freedesktop.secrets", async () => {
      const { stdout } = await execute(
        "dbus-send",
        [
          "--session",
          "--print-reply",
          "--dest=org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus.NameHasOwner",
          "string:org.freedesktop.secrets",
        ],
        { env: this.env },
      );
      return stdout.includes("boolean true") ? true : undefined;
    });
  }

  private async stopKeyring() {
    if (this.keyring) await exited(this.keyring);
    this.keyring = undefined;
  }

  private async secretTool(args: string[], input: string) {
    const child = spawn("secret-tool", args, { env: this.env, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(input);
    const [code] = (await once(child, "exit")) as [number | null];
    if (code !== 0) throw new Error(`secret-tool ${args[0]} failed with ${code}`);
  }

  /**
   * Answer every login-keyring prompt that appears with `action` until changed. The watcher
   * runs for the whole session; prompts are recorded in `this.prompts` so a spec can assert
   * the app asked (and how often).
   */
  answerPrompts(action: PromptAction): void {
    this.nextAction = action;
    this.answering ??= this.watchPrompts();
  }

  private async watchPrompts() {
    while (!this.stopping) {
      const window = await this.findPrompt();
      if (window) {
        const action = this.nextAction;
        // GTK maps the window before it can take input; a key sent at once is lost.
        await sleep(400);
        try {
          await execute("xdotool", ["windowfocus", "--sync", window], { env: this.env });
          if (action === "unlock") {
            await execute("xdotool", ["type", "--delay", "15", KEYRING_PASSWORD], { env: this.env });
            await execute("xdotool", ["key", "Return"], { env: this.env });
          } else {
            await execute("xdotool", ["key", "Escape"], { env: this.env });
          }
          this.prompts.push({ at: new Date().toISOString(), action });
          await until(
            "the keyring prompt to close",
            async () => ((await this.findPrompt()) ? undefined : true),
            10_000,
          );
        } catch {
          // The window can vanish between search and key; the next pass looks again.
        }
      }
      await sleep(200);
    }
  }

  private async findPrompt(): Promise<string | undefined> {
    try {
      const { stdout } = await execute("xdotool", ["search", "--onlyvisible", "--name", `^${PROMPT_TITLE}$`], {
        env: this.env,
      });
      return stdout
        .split("\n")
        .find((line) => line.trim() !== "")
        ?.trim();
    } catch {
      // xdotool exits 1 when nothing matches.
      return undefined;
    }
  }

  /** X11 ids of visible, mapped top-level windows whose name matches. */
  async visibleWindows(name: string): Promise<string[]> {
    try {
      const { stdout } = await execute("xdotool", ["search", "--onlyvisible", "--name", name], { env: this.env });
      return stdout.split("\n").filter((line) => line.trim() !== "");
    } catch {
      return [];
    }
  }

  /** Send a real X key event to a window (e.g. `ctrl+q`). */
  async key(window: string, keys: string): Promise<void> {
    // XTEST input to the focused window. `--window` would use XSendEvent instead, which
    // Chromium ignores as synthetic, and there is no window manager here to activate with.
    await execute("xdotool", ["windowfocus", "--sync", window], { env: this.env });
    await execute("xdotool", ["key", "--clearmodifiers", keys], { env: this.env });
  }

  /**
   * A headless Wayland compositor on this session's runtime dir. Returns the socket name to
   * pass as WAYLAND_DISPLAY; the app is then launched with `--ozone-platform=wayland`.
   */
  async startWayland(): Promise<string> {
    if (this.weston) return "orca-native-wayland";
    const socket = "orca-native-wayland";
    this.weston = this.track(
      spawn("weston", ["--backend=headless", `--socket=${socket}`, "--width=1280", "--height=900", "--idle-time=0"], {
        env: this.env,
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
    await until("weston's socket", async () => {
      const names = await readdir(this.env.XDG_RUNTIME_DIR!);
      return names.includes(socket) ? true : undefined;
    });
    return socket;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.answering?.catch(() => undefined);
    for (const child of [...this.children].reverse()) await exited(child).catch(() => undefined);
    await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }
}
