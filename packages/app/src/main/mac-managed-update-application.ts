/** Main-owned composition of one managed target, closed window and full-pair recovery.
 * The independently approved delivery/native authority is required. It is never inferred
 * from a candidate, renderer request, installed version or a missing configuration. */
import type { AutoUpdater } from "electron";
import { MacUpdateApplication } from "./mac-update-application.js";
import { MacCandidateSession, type MacCandidateOffer, type MacCandidatePrepared } from "./mac-update-candidates.js";
import { macBounded, type MacCandidateDownloadPorts } from "./mac-candidate-download.js";
import { matchesSealedMacIdentity } from "./mac-candidate-manifest.js";
import { MacClosedWindowCommit } from "./mac-closed-window-commit.js";
import { MacClosedWindowValidation, type ClosedValidationPorts } from "./mac-closed-window-validation.js";
import { MacFixedPathRecovery, type FixedPathRecoveryPorts } from "./mac-fixed-path-recovery.js";
import { createPairTreePort } from "./mac-fixed-path-files.js";
import { MacNativeHandoff, type MacNativeCommitRequest } from "./mac-native-handoff.js";
import { createNativeClosedUpdateWindow } from "./mac-update-namespace.js";
import type { MacUpdateGuards } from "./mac-update-guards.js";
import type { MacUpdateTarget } from "./mac-updates.js";
import type { Workspace } from "./workspace.js";
import type { ClosedUpdateWindow } from "@orca/protocol/update-window";
import { isAbsolute, resolve } from "node:path";

export interface ManagedMacUpdateAuthority {
  readonly download: MacCandidateDownloadPorts;
  readonly binaryRoot: string;
  /** Independently accepted installed image, not appVersion or candidate declarations. */
  readonly previousManifestSha256: string;
  readonly verifyBinary: FixedPathRecoveryPorts["verifyBinary"];
  readonly continuity: FixedPathRecoveryPorts["continuity"];
  readonly startClosed: ClosedValidationPorts["startClosed"];
}

/** All authority callbacks are main-only. Missing approved catalog/native acceptance
 * keeps the complete app boundary unavailable. Constructing this owner never downloads,
 * signals a process, restores state, stages an update or reopens admission. */
export function createManagedMacUpdateApplication(options: {
  readonly control: string;
  readonly workspace: Workspace;
  readonly guards: MacUpdateGuards;
  readonly authority?: ManagedMacUpdateAuthority;
  readonly native: () => Pick<AutoUpdater, "on" | "off" | "setFeedURL" | "checkForUpdates" | "quitAndInstall">;
  readonly activationAllowed: () => boolean;
  readonly pauseAppWriters: (signal: AbortSignal) => Promise<boolean>;
}) {
  const supplied = options.authority;
  const authority =
    supplied &&
    isAbsolute(supplied.binaryRoot) &&
    resolve(supplied.binaryRoot) === supplied.binaryRoot &&
    /^[a-f0-9]{64}$/.test(supplied.previousManifestSha256) &&
    [
      supplied.verifyBinary,
      supplied.continuity,
      supplied.startClosed,
      supplied.download?.trust?.catalog,
      supplied.download?.trust?.inspect,
      supplied.download?.fetch,
    ].every((port) => typeof port === "function")
      ? Object.freeze({
          ...supplied,
          download: Object.freeze({
            ...supplied.download,
            limits: Object.freeze({ ...supplied.download.limits }),
            trust: Object.freeze({ ...supplied.download.trust }),
          }),
        })
      : undefined;
  let window: ClosedUpdateWindow | undefined;
  let facts: ReturnType<Workspace["captureMacUpdateOwnerFacts"]>;
  let recovery: MacFixedPathRecovery | undefined;
  let validation: MacClosedWindowValidation | undefined;
  let handoff: MacNativeHandoff | undefined;
  const allowed = () => !!authority && options.activationAllowed();
  const openWindow = () => {
    if (!allowed() || !facts?.check()) return undefined;
    return (window ??= createNativeClosedUpdateWindow(options.control));
  };
  const sameTarget = (a: MacUpdateTarget, b: MacUpdateTarget) =>
    a.epoch === b.epoch && a.workspaceId === b.workspaceId && a.instanceId === b.instanceId;
  const targetMatches = (prepared: MacCandidatePrepared) =>
    facts?.check() === true && sameTarget(prepared.target, facts.target);
  const revalidateBounded = async (
    prepared: MacCandidatePrepared,
    signal: AbortSignal,
  ): Promise<"valid" | "refused" | "unknown"> => {
    if (!allowed() || !authority || !window || !targetMatches(prepared) || !options.guards.draftsValid())
      return "unknown";
    const state = window.snapshot;
    if (
      state.phase !== "draining" ||
      state.candidate !== prepared.binding.candidate.manifestSha256 ||
      ![facts!.configDir, facts!.storeDir].every((path) =>
        state.roots.some((root) => path === root.path || path.startsWith(root.path + "/")),
      )
    )
      return "unknown";
    const catalog = await authority.download.trust.catalog(prepared.binding, signal);
    if (catalog !== "trusted") return catalog === "refused" ? "refused" : "unknown";
    const proof = await authority.download.trust.inspect(prepared.binding, prepared.directory, signal);
    if (proof.outcome !== "verified") return proof.outcome;
    if (
      proof.manifestSha256 !== state.candidate ||
      proof.copies.length !== 2 ||
      new Set(proof.copies.map((copy) => copy.format)).size !== 2 ||
      !proof.copies.every(
        (copy) =>
          copy.daemonSha256 === prepared.binding.manifest.identity.daemon.sha256 &&
          matchesSealedMacIdentity(prepared.binding.manifest, copy.identityBytes),
      )
    )
      return "refused";
    if (!(await authority.verifyBinary(authority.binaryRoot, authority.previousManifestSha256, signal)))
      return "refused";
    return !signal.aborted && allowed() && targetMatches(prepared) && options.guards.draftsValid()
      ? "valid"
      : "unknown";
  };
  const revalidate = (prepared: MacCandidatePrepared) =>
    authority
      ? macBounded(new AbortController().signal, authority.download.limits.operationMs, (signal) =>
          revalidateBounded(prepared, signal),
        )
      : Promise.resolve("unknown" as const);
  const activate = async (request: MacNativeCommitRequest): Promise<"committed" | "refused" | "unknown"> => {
    if (!allowed() || !authority || !window || !facts || !targetMatches(request.prepared)) return "refused";
    if (!handoff) {
      recovery = new MacFixedPathRecovery(window, options.control, authority.binaryRoot, {
        trees: createPairTreePort("darwin"),
        verifyBinary: authority.verifyBinary,
        continuity: authority.continuity,
      });
      const captured = facts;
      const owner = new MacClosedWindowCommit(
        {
          window,
          recovery,
          storeDir: captured.storeDir,
          pauseAppWriters: options.pauseAppWriters,
          authorize: async (candidate, signal) => {
            if (
              signal.aborted ||
              !allowed() ||
              !captured.check() ||
              !options.guards.draftsValid() ||
              candidate.prepared.binding.candidate.manifestSha256 !== window!.snapshot.candidate ||
              !targetMatches(candidate.prepared) ||
              !candidate.lease.token ||
              !sameTarget(candidate.lease.target, captured.target) ||
              (await authority.download.trust.catalog(candidate.prepared.binding, signal)) !== "trusted"
            )
              return undefined;
            return {
              token: candidate.lease.token,
              previousTarget: captured.previousTarget,
              previousManifestSha256: authority.previousManifestSha256,
            };
          },
        },
        authority.download.limits.operationMs,
      );
      handoff = new MacNativeHandoff({
        native: options.native(),
        owner,
        zipBytes: authority.download.limits.fileBytes,
        operationMs: authority.download.limits.operationMs,
      });
    }
    return handoff.activate(request);
  };
  const session = authority
    ? new MacCandidateSession(
        authority.download,
        {
          drainAdmission: (target, token) => options.guards.drainAdmission(target, token),
          prepareDrafts: () => options.guards.prepareDrafts(),
          prepareAdmission: (target, token, drain) => options.guards.prepareAdmission(target, token, drain),
          checkPrepared: async () => "unknown",
        },
        { revalidate, activate },
      )
    : undefined;
  return Object.freeze({
    application: new MacUpdateApplication(session, openWindow, allowed),
    /** Trusted main supplies a catalog offer; this is not a renderer or polling API. */
    async offer(input: MacCandidateOffer, target: MacUpdateTarget, signal: AbortSignal) {
      if (!allowed() || !session || window?.snapshot.attempt) return { outcome: "refused" as const };
      const owner = options.workspace.captureMacUpdateOwnerFacts(target);
      if (!owner) return { outcome: "refused" as const };
      const result = await session.offer(input, target, signal);
      if (result.outcome === "available") {
        facts = owner;
        window = undefined;
      }
      return result;
    },
    /** Explicit same-boot recovery shell entry. Recapture all original writer slots
     * before reading pair receipts; a busy/changed namespace is retained, never reset. */
    async captureClosedRecovery(signal: AbortSignal) {
      if (!allowed() || !authority || signal.aborted || window || recovery || handoff) return "unknown" as const;
      const captured = createNativeClosedUpdateWindow(options.control);
      if (!captured.snapshot.attempt || captured.snapshot.phase === "open" || !(await captured.capture()))
        return "unknown" as const;
      window = captured;
      recovery = new MacFixedPathRecovery(captured, options.control, authority.binaryRoot, {
        trees: createPairTreePort("darwin"),
        verifyBinary: authority.verifyBinary,
        continuity: authority.continuity,
      });
      const identity = await recovery.readStartupIdentity(signal);
      return !signal.aborted && identity.candidate.manifestSha256 === captured.snapshot.candidate
        ? ("captured-closed" as const)
        : ("unknown" as const);
    },
    /** Same-boot recovery is explicit and remains closed. Nothing auto-replays a journal
     * or launches a normal daemon behind a replacement-closed startup shell. */
    async verifyClosed(signal: AbortSignal) {
      if (!allowed() || !authority || !window || !recovery)
        return { outcome: "refused" as const, reason: "ownership" as const };
      validation ??= new MacClosedWindowValidation(
        window,
        recovery,
        { startClosed: authority.startClosed },
        authority.download.limits.operationMs,
      );
      return validation.verify(signal);
    },
    async finishAfterCleanChildExit(signal: AbortSignal) {
      if (!allowed() || !validation) return "unknown" as const;
      return validation.finishAfterCleanChildExit(signal);
    },
    async restoreClosed(candidateManifestSha256: string, signal: AbortSignal) {
      if (!allowed() || !authority || !recovery) throw new Error("Protected restoration unavailable");
      return recovery.restore(authority.previousManifestSha256, candidateManifestSha256, signal);
    },
  });
}
