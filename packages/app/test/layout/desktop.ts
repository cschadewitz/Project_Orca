/**
 * A disposable Linux desktop for the layout spec: Xvfb, a private session bus and an unlocked
 * GNOME keyring, so Config > Launch work can keep a run intent and render its form. On Windows
 * (#1112's scaling audit on a GitHub-hosted Windows runner) the runner's own session is the
 * desktop and DPAPI is the key store, so there is nothing to start: only a temp root and an
 * environment without a daemon named in it.
 *
 * Lighter than `../native-linux/session.ts`: that one drives a *locked* keyring and its
 * unlock prompt with xdotool, which this spec has no use for. Everything lives under one temp
 * directory with its own HOME, so the keyring and the profile of the machine running it are
 * never touched.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * The larger window size the spec measures at. 1280×900 under Xvfb, whose screen is larger
 * still. A GitHub-hosted Windows runner's screen is 1024×768, and Windows keeps a window inside
 * it, so there the larger size is one that fits with its frame.
 */
export const LARGE: readonly [number, number] = process.platform === "win32" ? [1000, 680] : [1280, 900];
const TOOLS = ["Xvfb", "dbus-daemon", "gnome-keyring-daemon"];

async function until<T>(what: string, probe: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await done;
  clearTimeout(timer);
}

export class Desktop {
  private readonly children: ChildProcess[] = [];
  private constructor(
    readonly root: string,
    readonly env: Record<string, string>,
  ) {}

  static async start(): Promise<Desktop> {
    if (process.platform === "win32") {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("ORCA_DAEMON_"),
        ),
      );
      return new Desktop(await mkdtemp(join(tmpdir(), "orca-layout-")), env);
    }
    const missing: string[] = [];
    for (const tool of TOOLS)
      await execute("sh", ["-c", `command -v ${tool}`]).catch(() => {
        missing.push(tool);
      });
    if (missing.length > 0)
      throw new Error(
        `The layout spec needs ${missing.join(", ")} on PATH. On Ubuntu 24.04: sudo apt-get install xvfb dbus gnome-keyring`,
      );
    const root = await mkdtemp(join(tmpdir(), "orca-layout-"));
    const home = join(root, "home");
    const runtime = join(root, "runtime");
    await mkdir(home, { recursive: true });
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      USER: process.env.USER ?? "tester",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: runtime,
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      // Electron picks the libsecret store for GNOME; `keyring-store.cjs` undoes Playwright's
      // `--password-store=basic` so that choice stands.
      XDG_CURRENT_DESKTOP: "GNOME",
      XDG_SESSION_TYPE: "x11",
    };
    const desktop = new Desktop(root, env);
    try {
      await desktop.display();
      await desktop.bus();
      await desktop.keyring();
      return desktop;
    } catch (error) {
      await desktop.stop();
      throw error;
    }
  }

  private spawn(command: string, args: string[], stdin: "ignore" | "pipe" = "ignore"): ChildProcess {
    const child = spawn(command, args, { env: this.env, stdio: [stdin, "pipe", "ignore"] });
    child.on("error", () => undefined);
    this.children.push(child);
    return child;
  }

  private async firstLine(child: ChildProcess, what: string): Promise<string> {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    return until(what, async () => (output.includes("\n") ? output.split("\n")[0]!.trim() : undefined));
  }

  private async display(): Promise<void> {
    // A screen larger than any window the spec asks for, so a resize is never clamped.
    const xvfb = this.spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1600x1000x24", "-nolisten", "tcp"]);
    this.env.DISPLAY = `:${await this.firstLine(xvfb, "Xvfb's display number")}`;
  }

  private async bus(): Promise<void> {
    const bus = this.spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1", "--nopidfile"]);
    this.env.DBUS_SESSION_BUS_ADDRESS = await this.firstLine(bus, "the session bus address");
  }

  /** A login keyring created with a password and left unlocked, as after a desktop sign-in. */
  private async keyring(): Promise<void> {
    const keyring = this.spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], "pipe");
    keyring.stdin!.end("orca-layout-spec");
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

  async stop(): Promise<void> {
    for (const child of [...this.children].reverse()) await stopped(child).catch(() => undefined);
    await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }
}
