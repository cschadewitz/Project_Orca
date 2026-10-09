/** Fail-closed Mac guard composition. Native installation remains unwired. */
import type {
  MacPreparation,
  MacDraftLease,
  MacAdmissionLease,
  MacUpdateTarget,
  MacDrainLease,
} from "./mac-updates.js";
import type { Workspace } from "./workspace.js";
import { NonceDraftGuard, type DraftWindowBoundary } from "./update-ipc.js";

import { captureMacDrain, prepareMacDrain, type CaptureMacDrain } from "./mac-update-drain.js";

export class MacUpdateGuards {
  private readonly drafts: NonceDraftGuard;
  constructor(
    private readonly workspace: Workspace,
    windows: DraftWindowBoundary,
    private readonly setupBusy: () => boolean = () => false,
    private readonly captureDrain?: CaptureMacDrain,
  ) {
    this.drafts = new NonceDraftGuard(windows);
  }
  drainAdmission(target: MacUpdateTarget, token: string): Promise<MacPreparation<MacDrainLease>> {
    if (this.setupBusy()) return Promise.resolve({ outcome: "blocked", blocker: "window-unavailable" });
    return captureMacDrain(this.captureDrain, target, token);
  }
  prepareDrafts(): Promise<MacPreparation<MacDraftLease>> {
    if (this.setupBusy()) return Promise.resolve({ outcome: "blocked", blocker: "window-unavailable" });
    return this.drafts.prepare();
  }
  draftsValid(): boolean {
    return this.drafts.valid();
  }

  /** Only the additive, authenticated proof method can acquire runtime admission.
   * Missing proof sends no maintenance request. Lost/mismatched responses retain
   * the local target reservation; cleanup never targets a replacement daemon.
   */
  async prepareAdmission(
    target: MacUpdateTarget,
    token: string,
    drain?: MacDrainLease,
  ): Promise<MacPreparation<MacAdmissionLease>> {
    if (drain) return prepareMacDrain(drain, target, token, () => this.drafts.valid());
    if (!this.drafts.valid()) return { outcome: "blocked", blocker: "window-unavailable" };
    try {
      const owned = await this.workspace.captureMacUpdateTarget(target);
      if (!owned) return { outcome: "blocked", blocker: "identity" };
      if (!owned.check() || !owned.maintenanceRuntime) {
        owned.release();
        return { outcome: "blocked", blocker: owned.maintenanceRuntime ? "identity" : "activity" };
      }
      const rpc = owned.maintenanceRuntime;
      const matches = (result: import("@orca/protocol").RuntimeMaintenanceResult) =>
        result.target.workspaceId === target.workspaceId && result.target.instanceId === target.instanceId;
      const prepared = await rpc("prepare", token);
      if (!matches(prepared)) return { outcome: "unknown" };
      if (prepared.outcome === "blocked") {
        owned.release();
        return { outcome: "blocked", blocker: "activity" };
      }
      if (prepared.outcome !== "held" || !owned.check() || !this.drafts.valid()) return { outcome: "unknown" };
      let releasing = false;
      let stopping = false;
      return {
        outcome: "ready",
        lease: {
          target: owned.target,
          stopOwned: (signal, operationMs) => {
            if (releasing || !owned.check() || !this.drafts.valid()) return Promise.resolve({ outcome: "unknown" });
            stopping = true;
            return owned.stopOwned(signal, operationMs, () => this.drafts.valid(), token);
          },
          release: async () => {
            if (releasing || stopping || !owned.check()) return "unknown";
            releasing = true;
            try {
              const released = await rpc("resume", token);
              if (!matches(released) || released.outcome !== "released" || !owned.check()) return "unknown";
              owned.release();
              return "released";
            } catch {
              return "unknown";
            }
          },
        },
      };
    } catch {
      return { outcome: "unknown" };
    }
  }
}
