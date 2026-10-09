/** Main-only real candidate/window/runtime composition; native activation remains unavailable. */
import type { MacCandidateDownloadPorts } from "./mac-candidate-download.js";
import { MacCandidateSession, type MacCandidatePrepared } from "./mac-update-candidates.js";
import { MacUpdateGuards } from "./mac-update-guards.js";
import type { DraftWindowBoundary } from "./update-ipc.js";
import type { CaptureMacDrain } from "./mac-update-drain.js";
import type { Workspace } from "./workspace.js";

/** Caller supplies approved catalog/native-inspection ownership and a read-only checkpoint.
 * No renderer options, feed/policy defaults, native staging, stop, installer or restore adapter.
 * Wiring this factory into app/index/preload is a separately coordinated change.
 */
export function createMacCandidateSession(options: {
  readonly download: MacCandidateDownloadPorts;
  readonly workspace: Workspace;
  readonly captureDrain?: CaptureMacDrain;
  readonly windows: DraftWindowBoundary;
  readonly checkPrepared: (prepared: MacCandidatePrepared) => Promise<"refused" | "unknown">;
}): MacCandidateSession {
  const guards = new MacUpdateGuards(options.workspace, options.windows, undefined, options.captureDrain);
  const check = options.checkPrepared;
  return new MacCandidateSession(options.download, {
    drainAdmission: (target, token) => guards.drainAdmission(target, token),
    prepareDrafts: () => guards.prepareDrafts(),
    prepareAdmission: (target, token, drain) => guards.prepareAdmission(target, token, drain),
    checkPrepared: async (prepared) => {
      if (!guards.draftsValid()) return "unknown";
      const result = await check(prepared);
      return guards.draftsValid() ? result : "unknown";
    },
  });
}
