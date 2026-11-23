/**
 * "Switch to SQLite" for the desktop app's own workspace (#339). The daemon switches its store
 * in place, under the workspace's kernel-lifetime writer fence, on a launch the app asks for
 * (cli/src/desktop-sqlite-switch.ts). This is the asking: the restart goes through the same
 * guards as an update (drafts prepared, bundled daemon admission closed and drained, the exact
 * daemon stopped and its exit observed, its reservation settled), then a request naming the
 * workspace is written, and ORCA starts again. The next start's daemon for that workspace is
 * launched with the switch, and the request is spent by that launch whatever it does.
 *
 * Offered only while the connected daemon is the app's own first-run daemon and reports the
 * switch available (on files, its fence held, not Windows), and only in a build that enables it:
 * the switch reaches people only after its native signed/installed acceptance. A failure before
 * the stop reopens admission on the running daemon; after it nothing restarts the old daemon
 * here, and quitting and reopening ORCA starts it normally (without the switch unless the
 * request was written). Electron-free: tests drive it with fakes.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { StoreStatus } from "@orca/protocol";
import type { StoreSwitchState } from "../store-switch-contract.js";
import { UpdatePreflightRefusal, type UpdateGuards } from "./updates.js";

const RequestSchema = z.object({ version: z.literal(1), workspace: z.string().min(1) }).strict();

/** Ask for the switch on `workspace`'s next daemon launch: one request, replaced atomically. */
export function writeStoreSwitchRequest(file: string, workspace: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, workspace }) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Whether a request names `workspace`. Spent by asking: any request is removed, so a launch
 * that fails, or a request for another workspace, is never acted on later.
 */
export function takeStoreSwitchRequest(file: string, workspace: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  rmSync(file, { force: true });
  try {
    return RequestSchema.parse(JSON.parse(text)).workspace === workspace;
  } catch {
    return false;
  }
}

export interface StoreSwitchRestartOptions {
  guards: UpdateGuards;
  /** The app's own workspace and its store, while its bundled first-run daemon is connected. */
  target: () => { path: string; store: StoreStatus } | undefined;
  /** After the exact stop: settle the stopped daemon's reservation; returns its workspace. */
  settle: (token: string) => Promise<string>;
  /** Record the request for `workspace`'s next launch. */
  request: (workspace: string) => void;
  /** Start ORCA again once this process exits, then quit. */
  relaunch: () => void;
  changed: (state: StoreSwitchState) => void;
  /** This build offers the switch (after its native acceptance); off by default. */
  enabled: boolean;
  /** Tests; defaults to this process's platform. */
  platform?: NodeJS.Platform;
}

export class StoreSwitchRestart {
  state: StoreSwitchState = { phase: "unavailable" };
  private busy = false;
  private held = false;
  constructor(private options: StoreSwitchRestartOptions) {}

  /** Recompute what is offered from the connected daemon; never while a restart runs. */
  refresh(): void {
    if (this.busy || this.held) return;
    const target = this.options.target();
    const store = target?.store;
    const offered =
      this.options.enabled &&
      (this.options.platform ?? process.platform) !== "win32" &&
      store?.backend === "file" &&
      store.sqliteSwitch === "available";
    const next: StoreSwitchState = {
      phase: offered ? "ready" : "unavailable",
      ...(store ? { backend: store.backend } : {}),
      ...(store?.lastSwitch ? { last: store.lastSwitch } : {}),
      ...(this.state.phase === "error" && offered && this.state.message ? { message: this.state.message } : {}),
    };
    this.set(next);
  }

  private set(state: StoreSwitchState): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.options.changed(state);
  }

  async restart(): Promise<StoreSwitchState> {
    this.refresh();
    if (this.busy || this.held || this.state.phase !== "ready") return this.state;
    const target = this.options.target();
    if (!target) return this.state;
    const base = { backend: this.state.backend ?? "file" } as const;
    this.busy = true;
    this.held = true;
    const token = randomUUID();
    const guards = this.options.guards;
    let daemonAttempted = false;
    let daemonPrepared = false;
    let stopping = false;
    try {
      this.set({ ...base, phase: "restarting", message: "Checking drafts and bundled daemon activity" });
      await guards.prepareDrafts();
      daemonAttempted = true;
      await guards.prepareDaemon(token);
      daemonPrepared = true;
      stopping = true;
      await guards.stopDaemon(token);
      // From here the daemon is gone. Nothing below resumes it: every failure stops with
      // admission closed, and reopening ORCA starts the workspace again.
      let workspace: string;
      try {
        workspace = await this.options.settle(token);
      } catch {
        return this.stranded("The background service stopped, but its workspace could not be released safely.");
      }
      if (workspace !== target.path)
        return this.stranded("The background service that stopped was not this workspace's.");
      try {
        this.options.request(workspace);
      } catch {
        return this.stranded("The switch could not be recorded for the next start.");
      }
      this.set({ ...base, phase: "restarting", message: "Restarting ORCA to switch to SQLite" });
      this.options.relaunch();
      return this.state;
    } catch (error) {
      if (stopping) return this.stranded("The background service could not be stopped or resumed with certainty.");
      // Before the stop: a claimed attempt reopens admission on the running daemon; a refused
      // preflight claimed nothing.
      try {
        const unclaimed =
          daemonAttempted && !daemonPrepared && error instanceof UpdatePreflightRefusal && error.token === token;
        if (daemonAttempted && !unclaimed) await guards.resume(token);
        guards.releaseDrafts();
        this.held = false;
      } catch {
        return this.stranded("The background service could not be stopped or resumed with certainty.");
      }
      this.set({
        ...base,
        phase: "error",
        message:
          "The switch to SQLite did not start. Save or discard drafts and let running work finish, then try again. Nothing was changed.",
      });
      return this.state;
    } finally {
      this.busy = false;
    }
  }

  /** After the stop: held, with admission closed. Quitting and reopening ORCA starts it again. */
  private stranded(cause: string): StoreSwitchState {
    this.set({
      phase: "error",
      backend: this.state.backend ?? "file",
      message: `${cause} The store was not switched. Quit and reopen ORCA to continue on files.`,
    });
    return this.state;
  }
}
