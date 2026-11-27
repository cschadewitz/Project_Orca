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

/** One keyring prompt window, from the first answer sent to it until it was gone. */
export interface PromptEvent {
  /** When the answer was first sent. */
  at: string;
  action: PromptAction;
  /** The prompt's X window id. Each ask gets a window of its own. */
  window: string;
  /** How often the answer was sent: more than once means a key was lost and sent again. */
  sends: number;
  /** Milliseconds from first seeing the window until it was gone; absent while it is still up. */
  closedAfterMs?: number;
}

/** GTK maps the prompt before it can take input; a key sent at once is lost. */
const PROMPT_SETTLE_MS = 400;
/**
 * How long an answered prompt may stay up before its answer is sent again. Cancel closes at
 * once. Unlock has the password to check first, and typing it again takes a moment itself.
 */
const PROMPT_RESEND_MS: Record<PromptAction, number> = { cancel: 1_000, unlock: 3_000 };
const PROMPT_POLL_MS = 100;
/**
 * The deadline on every xdotool call. `windowfocus --sync` can wait many seconds for a window
 * that never takes focus, and any call can hang on an X server that has stopped answering.
 */
const XDOTOOL_TIMEOUT_MS = 5_000;
/** The Xvfb screen. ORCA's window does not reach its bottom-right corner. */
const SCREEN = { width: 1280, height: 900 };

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
      spawn("Xvfb", ["-displayfd", "1", "-screen", "0", `${SCREEN.width}x${SCREEN.height}x24`, "-nolisten", "tcp"], {
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
    // When a focused prompt closes, the focus falls back to the root window, and a key then
    // goes to whatever window is under the pointer. The pointer starts in the middle of the
    // screen, where ORCA's window will be. A key that just misses its prompt must reach
    // nothing, so the pointer waits in a corner no window covers.
    await this.xdotool("mousemove", String(SCREEN.width - 1), String(SCREEN.height - 1));
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

  /**
   * Each prompt is followed by its X window id, never by "is a prompt showing". One ask of
   * the app's is several prompts in a row: cancel one and the keyring is asked again, for two
   * prompts on a fresh keyring and three once ORCA's key is stored in it (as measured here).
   * Each is a new window, mapped about 25 ms after the last one closed. A watcher that waits
   * for "no prompt on screen" sees that gap only if it happens to look inside it; otherwise
   * it waits out its deadline against a prompt nobody is answering. That was #1177: 10 s for
   * each gap missed, with the app's main process inside the synchronous keyring call the
   * whole time, so Playwright saw nothing of a page that was right.
   *
   * So: a window id not seen before is a new prompt and gets its answer once it has settled,
   * and a window still up well after its answer gets the answer again, because the key was
   * lost. Nothing here waits on a deadline.
   */
  private async watchPrompts() {
    let current: { window: string; seen: number; tries: number; sent?: number; event?: PromptEvent } | undefined;
    while (!this.stopping) {
      let window: string | undefined;
      try {
        window = await this.findPrompt();
      } catch {
        // The search itself failed, which says nothing about the prompt: what is known stays.
        await sleep(PROMPT_POLL_MS);
        continue;
      }
      if (window !== current?.window) {
        if (current?.event) current.event.closedAfterMs = Date.now() - current.seen;
        current = window ? { window, seen: Date.now(), tries: 0 } : undefined;
      }
      if (current) {
        const due =
          current.sent === undefined
            ? current.seen + PROMPT_SETTLE_MS
            : current.sent + PROMPT_RESEND_MS[current.event!.action];
        if (Date.now() >= due) {
          const action = current.event?.action ?? this.nextAction;
          try {
            await this.answerPrompt(current.window, action, current.tries++ > 0);
            current.sent = Date.now();
            if (current.event) current.event.sends += 1;
            else {
              current.event = { at: new Date().toISOString(), action, window: current.window, sends: 1 };
              this.prompts.push(current.event);
            }
          } catch {
            // The window can vanish between search and key; the next pass looks again.
          }
        }
      }
      await sleep(PROMPT_POLL_MS);
    }
  }

  private async answerPrompt(window: string, action: PromptAction, again: boolean) {
    await this.xdotool("windowfocus", "--sync", window);
    if (action === "cancel") {
      await this.xdotool("key", "Escape");
      return;
    }
    // Whatever an earlier try left in the field would make this one a wrong password.
    if (again) await this.xdotool("key", "ctrl+a", "BackSpace");
    await this.xdotool("type", "--delay", "15", KEYRING_PASSWORD);
    await this.xdotool("key", "Return");
  }

  /**
   * The one way this session runs xdotool, so that every call has a deadline. The watcher
   * runs these in a loop and `stop()` waits for the watcher: one call that never returned
   * would hold the prompt loop and the teardown behind it.
   */
  private xdotool(...args: string[]) {
    return execute("xdotool", args, { env: this.env, timeout: XDOTOOL_TIMEOUT_MS });
  }

  /**
   * The window id of the prompt on screen, or undefined when there is none. Throws when the
   * search did not finish, which is not the same as finding nothing.
   */
  private async findPrompt(): Promise<string | undefined> {
    try {
      const { stdout } = await this.xdotool("search", "--onlyvisible", "--name", `^${PROMPT_TITLE}$`);
      return stdout
        .split("\n")
        .find((line) => line.trim() !== "")
        ?.trim();
    } catch (error) {
      // xdotool exits 1 when nothing matches. A search killed at its deadline has no exit code.
      if ((error as { code?: unknown }).code === 1) return undefined;
      throw error;
    }
  }

  /** X11 ids of visible, mapped top-level windows whose name matches. */
  async visibleWindows(name: string): Promise<string[]> {
    try {
      const { stdout } = await this.xdotool("search", "--onlyvisible", "--name", name);
      return stdout.split("\n").filter((line) => line.trim() !== "");
    } catch {
      return [];
    }
  }

  /** Send a real X key event to a window (e.g. `ctrl+q`). */
  async key(window: string, keys: string): Promise<void> {
    // XTEST input to the focused window. `--window` would use XSendEvent instead, which
    // Chromium ignores as synthetic, and there is no window manager here to activate with.
    await this.xdotool("windowfocus", "--sync", window);
    await this.xdotool("key", "--clearmodifiers", keys);
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
