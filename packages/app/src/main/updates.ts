/** Manual updater state machine. Raw transport errors may contain credentials: never forward them. */
import { randomUUID } from "node:crypto";
import type { UpdateAction, UpdateSnapshot } from "../update-contract.js";
export interface UpdateDriver {
  check(this: void): Promise<string | undefined>;
  download(this: void, progress: (percent: number) => void): Promise<void>;
  /** Only a positive pre-launch observation may return not-launched. Rejections are unknown. */
  install(this: void): Promise<"not-launched" | "launched">;
}
/** Main-only proof that this token was refused before a workspace update reservation.
 * Never emitted after a claim or installer invocation; it grants no authority over another token.
 */
export class UpdatePreflightRefusal extends Error {
  constructor(
    readonly token: string,
    message: string,
  ) {
    super(message);
  }
}
export interface UpdateGuards {
  prepareDrafts(this: void): Promise<void>;
  prepareDaemon(this: void, token: string): Promise<void>;
  stopDaemon(this: void, token: string): Promise<void>;
  /**
   * After the exact stop, before the installer: hand the stopped daemon's store to the first
   * start of `to` (#897). Best effort: without a handoff the new version still opens a store of
   * its own format, and refuses to convert an older one automatically.
   */
  handOff?(this: void, token: string, from: string, to: string): Promise<void>;
  resume(this: void, token: string): Promise<void>;
  releaseDrafts(this: void): void;
}
export class Updates {
  state: UpdateSnapshot;
  private busy = false;
  private downloaded = false;
  private restartHeld = false;
  constructor(
    private driver: UpdateDriver | undefined,
    current: string,
    private guards: UpdateGuards,
    private changed: (s: UpdateSnapshot) => void,
  ) {
    this.state = { phase: driver ? "idle" : "unavailable", current };
  }
  private set(patch: Partial<UpdateSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  async act(action: UpdateAction): Promise<UpdateSnapshot> {
    if (this.busy || this.restartHeld || !this.driver) return this.state;
    if (action === "check" && this.downloaded) return this.state;
    if (action === "download" && (!this.state.version || this.downloaded)) return this.state;
    if (action === "restart" && !this.downloaded) return this.state;
    this.busy = true;
    const token = randomUUID();
    let daemonAttempted = false;
    let daemonPrepared = false;
    let installerUnknown = false;
    try {
      if (action === "check") {
        this.set({ phase: "checking", message: "Checking for updates" });
        const version = await this.driver.check();
        this.downloaded = false;
        this.state = {
          current: this.state.current,
          phase: version ? "available" : "current",
          ...(version ? { version } : {}),
        };
        this.changed(this.state);
      } else if (action === "download") {
        this.set({ phase: "downloading", percent: 0, message: "Downloading update" });
        await this.driver.download((percent) => this.set({ percent: Math.max(0, Math.min(100, percent)) }));
        this.downloaded = true;
        this.set({ phase: "ready", message: "Update downloaded" });
      } else {
        this.set({ phase: "restarting", message: "Checking drafts and bundled daemon activity" });
        this.restartHeld = true;
        await this.guards.prepareDrafts();
        daemonAttempted = true;
        await this.guards.prepareDaemon(token);
        daemonPrepared = true;
        await this.guards.stopDaemon(token);
        if (this.state.version)
          await this.guards.handOff?.(token, this.state.current, this.state.version).catch(() => undefined);
        // Enter unknown BEFORE calling the driver, including synchronous throws.
        installerUnknown = true;
        const outcome = await this.driver.install();
        if (outcome === "not-launched") {
          installerUnknown = false;
          throw new Error("Installer did not launch");
        }
        if (outcome !== "launched") throw new Error("Unknown installer result");
        this.set({ message: "Installer launched. Waiting for this app to exit; admission remains closed." });
      }
    } catch (error) {
      if (action === "restart") {
        if (installerUnknown) {
          this.set({
            phase: "error",
            message:
              "Installer outcome is unknown. Admission remains closed. Preserve the workspace and update evidence for operator review.",
          });
          return this.state;
        }
        try {
          const unclaimed =
            daemonAttempted && !daemonPrepared && error instanceof UpdatePreflightRefusal && error.token === token;
          if (daemonAttempted && !unclaimed) await this.guards.resume(token);
          this.guards.releaseDrafts();
          this.restartHeld = false;
        } catch {
          this.set({
            phase: "error",
            message:
              "Recovery failed or is uncertain. Admission remains closed. Preserve the workspace and ownership evidence for operator review.",
          });
          return this.state;
        }
      }
      this.set({
        phase: this.downloaded ? "ready" : "error",
        message:
          action === "restart"
            ? "Restart blocked before installer launch. Save or discard drafts and finish bundled daemon work, then retry."
            : "Update failed. Check the network and private feed credentials, then retry.",
      });
    } finally {
      this.busy = false;
    }
    return this.state;
  }
}
