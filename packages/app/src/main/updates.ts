/** Manual updater state machine. Raw transport errors may contain credentials: never forward them. */
import { randomUUID } from "node:crypto";
import type { UpdateAction, UpdateSnapshot } from "../update-contract.js";
export interface UpdateDriver {
  check(this: void): Promise<string | undefined>;
  download(this: void, progress: (percent: number) => void): Promise<void>;
  install(this: void): Promise<void>;
}
export interface UpdateGuards {
  prepareDrafts(this: void): Promise<void>;
  prepareDaemon(this: void, token: string): Promise<void>;
  stopDaemon(this: void): Promise<void>;
  resume(this: void, token: string): Promise<void>;
  releaseDrafts(this: void): void;
}
export class Updates {
  state: UpdateSnapshot;
  private busy = false;
  private downloaded = false;
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
    if (this.busy || !this.driver) return this.state;
    if (action === "check" && this.downloaded) return this.state;
    if (action === "download" && (!this.state.version || this.downloaded)) return this.state;
    if (action === "restart" && !this.downloaded) return this.state;
    this.busy = true;
    const token = randomUUID();
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
        await this.guards.prepareDrafts();
        await this.guards.prepareDaemon(token);
        await this.guards.stopDaemon();
        await this.driver.install();
      }
    } catch {
      if (action === "restart") {
        await this.guards.resume(token).catch(() => undefined);
        this.guards.releaseDrafts();
      }
      this.set({
        phase: this.downloaded ? "ready" : "error",
        message:
          action === "restart"
            ? "Restart blocked. Save or discard drafts, finish bundled daemon work, then retry. If disconnected, restore the connection first."
            : "Update failed. Check the network and private feed credentials, then retry.",
      });
    } finally {
      this.busy = false;
    }
    return this.state;
  }
}
