/** Existing native installer handoff backed by the smaller fixed-path closed-window proof. */
import type { ClosedUpdateWindow } from "@orca/protocol/update-window";
import type { MacNativeCommitOwner, MacNativeCommitRequest } from "./mac-native-handoff.js";
import type { MacReplacementAuthorization } from "./mac-replacement-commit.js";
import type { MacFixedPathRecovery } from "./mac-fixed-path-recovery.js";
import { macAbortable, macBounded } from "./mac-candidate-download.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export interface ClosedWindowCommitPorts {
  authorize(request: MacNativeCommitRequest, signal: AbortSignal): Promise<MacReplacementAuthorization | undefined>;
  readonly window: ClosedUpdateWindow;
  readonly recovery: MacFixedPathRecovery;
  readonly storeDir: string;
  /** Main owns full IPC/draft freeze, waits for dispatched intent/preference/config and
   * diagnostics writes, then releases its participating writer leases. Never just a flag. */
  pauseAppWriters(signal: AbortSignal): Promise<boolean>;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Installation remains disabled unless all actual native/approval ports are supplied.
 * Durable closeAdmission is called at exact approval BEFORE the existing drain coordinator.
 * This final handoff consumes that same attempt, never creates another drain/approval.
 * Timeout/lost response leaves the durable window closed and forbids retry/ordinary quit. */
export class MacClosedWindowCommit implements MacNativeCommitOwner {
  private attempt: Promise<"ready" | "refused" | "unknown"> | undefined;
  private request: MacNativeCommitRequest | undefined;
  constructor(
    private readonly ports: ClosedWindowCommitPorts,
    private readonly operationMs: number,
  ) {}
  readonly prepare = (request: MacNativeCommitRequest): Promise<"ready" | "refused" | "unknown"> => {
    if (this.attempt) return request === this.request ? this.attempt : Promise.resolve("unknown");
    this.request = request;
    this.attempt = Promise.resolve().then(async () => {
      if (!Number.isSafeInteger(this.operationMs) || this.operationMs <= 0 || !request.lease.stopOwned)
        return "refused";
      try {
        return await macBounded(new AbortController().signal, this.operationMs, async (signal) => {
          const approval = await macAbortable(() => this.ports.authorize(request, signal), signal);
          if (!approval) return "refused";
          const captured = structuredClone(approval),
            window = this.ports.window.snapshot;
          if (
            captured.token !== request.lease.token ||
            window.candidate !== request.prepared.binding.candidate.manifestSha256 ||
            window.phase !== "draining"
          )
            return "unknown";
          this.ports.window.beginStop();
          const stopped = await request.lease.stopOwned!(signal, this.operationMs);
          if (stopped.outcome !== "stopped" || !same(stopped.receipt.target, captured.previousTarget)) return "unknown";
          if (
            !(await macAbortable(() => this.ports.pauseAppWriters(signal), signal)) ||
            !(await macAbortable(() => this.ports.window.capture(), signal))
          )
            return "unknown";
          const fresh = await macAbortable(() => this.ports.authorize(request, signal), signal);
          if (!fresh || !same(fresh, captured) || !this.ports.window.check()) return "unknown";
          await this.ports.recovery.backupPrevious(captured.previousManifestSha256, signal);
          const metadata = await open(
            join(request.prepared.directory, "native-mac-artifact.json"),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          let manifest: Buffer;
          try {
            const stat = await metadata.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 12288)
              throw new Error("Startup metadata unavailable");
            manifest = await metadata.readFile();
            if (manifest.length !== stat.size) throw new Error("Startup metadata changed");
          } finally {
            await metadata.close();
          }
          await this.ports.recovery.retainStartupIdentity(
            {
              previousTarget: captured.previousTarget,
              candidate: request.prepared.binding.candidate,
              storeDir: this.ports.storeDir,
              manifestBase64: manifest.toString("base64"),
            },
            signal,
          );
          const final = await macAbortable(() => this.ports.authorize(request, signal), signal);
          return final && same(final, captured) && this.ports.window.check() && !signal.aborted ? "ready" : "unknown";
        });
      } catch {
        return "unknown";
      }
    });
    return this.attempt;
  };
}
