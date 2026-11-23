/**
 * Automatic desktop updates (#566): check and download in the background, then install at a
 * natural idle moment. It only drives `Updates`, so every guard of a manual restart still
 * applies, and an automatic restart additionally needs the daemon's runtime idle proof
 * (`UpdateGuards.prepareDaemon`'s `idleProof`). Nothing here stops, cancels or waits on work:
 * a busy app is simply tried again later.
 *
 * - **Check** shortly after start, then every four hours; **download** whatever a check found.
 * - **Install** once a download is ready and the person has not touched the computer for 15
 *   minutes, at most once every five minutes. The idle proof refuses on any running work and
 *   the window guard refuses on unsaved drafts, before anything is stopped.
 * - **On close.** Closing the last window tries the same install without starting the app
 *   again (`installOnClose`). Refused, the window closes as it always did.
 * - **Overdue.** A download that has waited three days for an idle moment is marked
 *   `overdue`; the header says so. It still kills nothing.
 *
 * Off (`enabled()` false), nothing here acts: Check, Download and Restart are manual again.
 */
import type { UpdateAction, UpdateSnapshot } from "../update-contract.js";
import type { UpdateActOptions } from "./updates.js";

export const AUTO_UPDATE_TIMING = Object.freeze({
  /** First check after start: late enough not to compete with startup. */
  firstCheckMs: 2 * 60_000,
  checkEveryMs: 4 * 60 * 60_000,
  /** Seconds without keyboard or mouse input before an install may start. */
  idleSeconds: 15 * 60,
  /** Between automatic install attempts, so a busy daemon is not asked every tick. */
  retryMs: 5 * 60_000,
  overdueMs: 3 * 24 * 60 * 60_000,
  tickMs: 60_000,
});

export interface AutoUpdateTarget {
  readonly state: UpdateSnapshot;
  readonly held: boolean;
  act(action: UpdateAction, options?: UpdateActOptions): Promise<UpdateSnapshot>;
  setAutomatic(automatic: boolean): void;
  setOverdue(overdue: boolean): void;
}

export interface AutoUpdateDeps {
  updates: AutoUpdateTarget;
  /** The person's preference; read on every tick, so turning it off takes effect at once. */
  enabled(): boolean;
  /** Seconds since the last keyboard or mouse input (Electron `powerMonitor.getSystemIdleTime`). */
  idleSeconds(): number;
  now(): number;
  timing?: Partial<typeof AUTO_UPDATE_TIMING>;
}

export class AutoUpdates {
  private readonly timing: typeof AUTO_UPDATE_TIMING;
  private readonly startedAt: number;
  private lastCheck: number | undefined;
  private lastAttempt: number | undefined;
  private readySince: number | undefined;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closeTried = false;
  /** The app is quitting: an idle install in preparation must not reach the stop. */
  private stopped = false;

  constructor(private readonly deps: AutoUpdateDeps) {
    this.timing = { ...AUTO_UPDATE_TIMING, ...deps.timing };
    this.startedAt = deps.now();
    deps.updates.setAutomatic(this.on);
  }

  private get on(): boolean {
    try {
      return this.deps.enabled() && this.deps.updates.state.phase !== "unavailable";
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.timing.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass; overlapping passes share the running one. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const updates = this.deps.updates;
    const on = this.on;
    updates.setAutomatic(on);
    if (!on || updates.held || this.stopped) return;
    const now = this.deps.now();
    const phase = updates.state.phase;
    if (phase !== "ready") {
      this.readySince = undefined;
      updates.setOverdue(false);
    }
    if (phase === "idle" || phase === "current" || phase === "error") {
      const due =
        this.lastCheck === undefined
          ? now - this.startedAt >= this.timing.firstCheckMs
          : now - this.lastCheck >= this.timing.checkEveryMs;
      if (!due) return;
      this.lastCheck = now;
      const checked = await updates.act("check");
      if (checked.phase === "available" && this.on) await updates.act("download");
      if (updates.state.phase === "ready") this.readySince = now;
      return;
    }
    if (phase === "available") {
      // Found by a manual check, or while this was off. A failed download is `error`, which
      // waits for the next check.
      await updates.act("download");
      if (updates.state.phase === "ready") this.readySince = now;
      return;
    }
    if (phase !== "ready") return;
    this.readySince ??= now;
    updates.setOverdue(now - this.readySince >= this.timing.overdueMs);
    if (this.lastAttempt !== undefined && now - this.lastAttempt < this.timing.retryMs) return;
    let idle: number;
    try {
      idle = this.deps.idleSeconds();
    } catch {
      return;
    }
    if (!(idle >= this.timing.idleSeconds)) return;
    this.lastAttempt = now;
    await updates.act("restart", { automatic: true, stillWanted: () => this.idleStillWanted() });
  }

  /** Still off, still idle and not quitting, read fresh at the stop boundary. */
  private idleStillWanted(): boolean {
    if (this.stopped || !this.on) return false;
    try {
      return this.deps.idleSeconds() >= this.timing.idleSeconds;
    } catch {
      return false;
    }
  }

  /** The preference changed: the header learns at once, the next tick acts on it. */
  refresh(): void {
    this.deps.updates.setAutomatic(this.on);
  }

  /** Whether closing the last window should first try to install (synchronous, for `close`). */
  get installsOnClose(): boolean {
    const updates = this.deps.updates;
    return !this.closeTried && this.on && !updates.held && updates.state.phase === "ready";
  }

  /**
   * The last window is closing. Returns true when the installer launched (the app is going
   * anyway); false means close as usual. Tried once per app run, so a refused install never
   * holds a close twice.
   */
  async installOnClose(): Promise<boolean> {
    const updates = this.deps.updates;
    if (!this.installsOnClose) return false;
    this.closeTried = true;
    await this.running;
    if (updates.held || updates.state.phase !== "ready") return false;
    const result = await updates.act("restart", {
      automatic: true,
      relaunch: false,
      // Closing is the reason; turning automatic updates off, or another quit, withdraws it.
      stillWanted: () => !this.stopped && this.on,
    });
    return result.phase === "restarting";
  }
}

/**
 * `ORCA_UPDATE_IDLE_SECONDS`: how long without input before an idle install, in whole seconds
 * (1 to 1e9). Anything else keeps the default 15 minutes. The Windows update test uses it to
 * take one path at a time; a machine that is never idle long enough can raise it, not lower
 * the guards: the runtime idle proof and draft checks still decide.
 */
export function idleThreshold(value: string | undefined): { idleSeconds?: number } {
  if (!value || !/^[1-9][0-9]{0,9}$/.test(value)) return {};
  const seconds = Number(value);
  return seconds <= 1e9 ? { idleSeconds: seconds } : {};
}
