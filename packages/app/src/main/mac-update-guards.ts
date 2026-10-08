/** Fail-closed Mac guard composition. Native installation remains unwired. */
import type { MacPreparation, MacDraftLease, MacAdmissionLease, MacUpdateTarget } from "./mac-updates.js";
import type { Workspace } from "./workspace.js";
import { NonceDraftGuard, type DraftWindowBoundary } from "./update-ipc.js";

export class MacUpdateGuards {
  private readonly drafts: NonceDraftGuard;
  constructor(
    private readonly workspace: Workspace,
    windows: DraftWindowBoundary,
    private readonly setupBusy: () => boolean = () => false,
  ) {
    this.drafts = new NonceDraftGuard(windows);
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
  async prepareAdmission(target: MacUpdateTarget, token: string): Promise<MacPreparation<MacAdmissionLease>> {
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
