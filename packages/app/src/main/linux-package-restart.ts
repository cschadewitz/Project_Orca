/**
 * "Restart to finish update" for the Linux `.deb` (#905). The package has no updater: the
 * person upgrades it with `apt` while ORCA may still be running, which replaces the files under
 * `/opt/ORCA` beneath the running app. This notices that (dpkg reports an installed
 * `orca-desktop` version other than the running one) and offers a restart that hands the store
 * over exactly as the Windows in-app updater does (#897): drafts prepared, bundled daemon
 * admission closed and drained, the exact daemon stopped and its exit observed, then the store
 * handed off to the installed version, and only then is the new binary started.
 *
 * The new app's bundled daemon then carries an older-format store forward under the same proof
 * as on Windows: it holds the first-run writer fence, its journal claim directly follows the
 * stopped daemon's, and it is the version the handoff names. Anything that fails before the
 * stop resumes this version's daemon, as on Windows. Electron-free: tests drive it with fakes.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LinuxRestartState } from "../linux-update-contract.js";
import { compareVersions, parseVersion } from "./linux-release-notice.js";
import { UpdatePreflightRefusal, type UpdateGuards } from "./updates.js";

export const DPKG_STATUS = "/var/lib/dpkg/status";
const PACKAGE = "orca-desktop";

/**
 * The `orca-desktop` version dpkg reports as fully installed, in the app's own spelling, or
 * `undefined` while it is absent, half-installed or unreadable. The `.deb` writes a prerelease
 * `0.8.0-rc.1` as Debian version `0.8.0~rc.1` (app-smoke.yml checks this), so the first `~`
 * goes back to `-`.
 */
export function installedDebVersion(status: string): string | undefined {
  for (const stanza of status.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of stanza.split("\n")) {
      const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (match) fields.set(match[1]!.toLowerCase(), match[2]!.trim());
    }
    if (fields.get("package") !== PACKAGE) continue;
    if (fields.get("status") !== "install ok installed") return undefined;
    const version = fields.get("version")?.replace("~", "-");
    return version && parseVersion(version) ? version : undefined;
  }
  return undefined;
}

export function readInstalledDebVersion(path = DPKG_STATUS): string | undefined {
  try {
    return installedDebVersion(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export interface LinuxPackageRestartOptions {
  current: string;
  readInstalled: () => string | undefined;
  guards: UpdateGuards;
  /** Starts the installed binary once this process exits, then quits. */
  relaunch: () => void;
  changed: (state: LinuxRestartState | undefined) => void;
  intervalMs?: number;
  setTimer?: (callback: () => void, ms: number) => { unref?(): void };
}

export const PACKAGE_CHECK_MS = 30_000;

export class LinuxPackageRestart {
  state: LinuxRestartState | undefined;
  private busy = false;
  private held = false;
  private stopped = false;
  constructor(private options: LinuxPackageRestartOptions) {}

  start(): void {
    this.check();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
  }

  private schedule(): void {
    if (this.stopped) return;
    const run = () => {
      this.check();
      this.schedule();
    };
    const ms = this.options.intervalMs ?? PACKAGE_CHECK_MS;
    // Unref'd: a pending check never keeps the app alive.
    if (this.options.setTimer) this.options.setTimer(run, ms).unref?.();
    else setTimeout(run, ms).unref();
  }

  /** Offer the restart while dpkg reports another installed version; never during one. */
  check(): void {
    if (this.busy || this.held || this.stopped) return;
    const installed = this.options.readInstalled();
    const current = parseVersion(this.options.current);
    const next = installed ? parseVersion(installed) : undefined;
    const state: LinuxRestartState | undefined =
      installed && next && current && compareVersions(next, current) !== 0
        ? { phase: "ready", current: this.options.current, installed }
        : undefined;
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.options.changed(state);
  }

  private set(state: LinuxRestartState): void {
    this.state = state;
    this.options.changed(state);
  }

  async restart(): Promise<LinuxRestartState | undefined> {
    if (this.busy || this.held || this.state?.phase !== "ready") return this.state;
    const { installed, current } = this.state;
    // The package must still be the one offered: apt may have moved on meanwhile.
    if (this.options.readInstalled() !== installed) {
      this.check();
      return this.state;
    }
    this.busy = true;
    this.held = true;
    const token = randomUUID();
    const guards = this.options.guards;
    let daemonAttempted = false;
    let daemonPrepared = false;
    try {
      this.set({ phase: "restarting", current, installed, message: "Checking drafts and bundled daemon activity" });
      await guards.prepareDrafts();
      daemonAttempted = true;
      await guards.prepareDaemon(token);
      daemonPrepared = true;
      await guards.stopDaemon(token);
      // Best effort, as on Windows: without it the new version still opens a store of its own
      // format, and refuses to convert an older one automatically.
      await guards.handOff?.(token, current, installed).catch(() => undefined);
      this.set({ phase: "restarting", current, installed, message: `Starting ORCA ${installed}` });
      this.options.relaunch();
      return this.state;
    } catch (error) {
      // As on Windows: a claimed attempt is resumed (after an observed stop, through saved-receipt
      // recovery, which withdraws the handoff); a refused preflight claimed nothing.
      try {
        const unclaimed =
          daemonAttempted && !daemonPrepared && error instanceof UpdatePreflightRefusal && error.token === token;
        if (daemonAttempted && !unclaimed) await guards.resume(token);
        guards.releaseDrafts();
        this.held = false;
      } catch {
        this.set({
          phase: "error",
          current,
          installed,
          message:
            "Recovery failed or is uncertain. Admission remains closed. Quit ORCA and open it again to finish the update.",
        });
        return this.state;
      }
      this.set({
        phase: "ready",
        current,
        installed,
        message:
          "Restart blocked before the new version could start. Save or discard drafts and finish bundled daemon work, then retry.",
      });
      return this.state;
    } finally {
      this.busy = false;
    }
  }
}
