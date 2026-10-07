/** Fail-closed Mac guard composition. Native installation remains unwired. */
import type { MacPreparation, MacDraftLease, MacAdmissionLease, MacUpdateTarget } from "./mac-updates.js";
import type { Workspace } from "./workspace.js";
import { NonceDraftGuard, type DraftWindowBoundary } from "./update-ipc.js";

export class MacUpdateGuards {
  private readonly drafts: NonceDraftGuard;
  constructor(
    private readonly workspace: Workspace,
    windows: DraftWindowBoundary,
  ) {
    this.drafts = new NonceDraftGuard(windows);
  }
  prepareDrafts(): Promise<MacPreparation<MacDraftLease>> {
    return this.drafts.prepare();
  }
  draftsValid(): boolean {
    return this.drafts.valid();
  }

  /** Legacy maintenance.ready covers RPC lifetimes only. It cannot prove that
   * acknowledged attached execution or a live callback is idle. Until the daemon
   * exposes an authoritative atomic idle fence, refuse without issuing maintenance.
   * In particular, do not fence first and discover missing proof after the response.
   */
  async prepareAdmission(target: MacUpdateTarget, _token: string): Promise<MacPreparation<MacAdmissionLease>> {
    try {
      const owned = await this.workspace.captureMacUpdateTarget(target);
      if (!owned) return { outcome: "blocked", blocker: "identity" };
      try {
        if (!owned.check()) return { outcome: "blocked", blocker: "identity" };
        return { outcome: "blocked", blocker: "activity" };
      } finally {
        owned.release();
      }
    } catch {
      return { outcome: "unknown" };
    }
  }
}
