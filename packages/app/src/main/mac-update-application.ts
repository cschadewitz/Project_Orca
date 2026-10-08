/** App-owned Mac action boundary; absent trusted catalog/recovery/native owners means unavailable. */
import type { BridgeResult } from "../bridge.js";
import type { MacUpdateCommand, MacUpdateView } from "../mac-update-contract.js";
import type { MacCandidateSession } from "./mac-update-candidates.js";
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

export interface MacUpdateCaller {
  readonly ownedMainFrame: boolean;
  readonly epoch: number;
  readonly currentEpoch: number;
  readonly windowsHeld: boolean;
}
export class MacUpdateApplication {
  constructor(private readonly session?: MacCandidateSession) {}
  get state(): MacUpdateView {
    if (!this.session) return Object.freeze({ phase: "unavailable" });
    const { phase, offerId, blocker } = this.session.state;
    const candidate = this.session.offeredCandidate;
    return Object.freeze({
      phase,
      ...(offerId && candidate ? { offerId, ...candidate } : {}),
      ...(blocker ? { blocker } : {}),
    });
  }
  subscribe(listener: (state: MacUpdateView) => void): () => void {
    return this.session?.subscribe(() => listener(this.state)) ?? (() => undefined);
  }
  /** Admission epochs also fence approvals; defer remains usable during preparation. */
  async act(input: unknown, caller: MacUpdateCaller): Promise<BridgeResult<MacUpdateView>> {
    const invalid = (): BridgeResult<MacUpdateView> => ({
      ok: false,
      error: { code: "UPDATE", message: "Update request is unavailable or no longer current" },
    });
    if (
      !this.session ||
      !caller.ownedMainFrame ||
      !Number.isSafeInteger(caller.epoch) ||
      caller.epoch < 0 ||
      caller.epoch !== caller.currentEpoch ||
      caller.epoch !== this.session.targetEpoch ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    )
      return invalid();
    const value = input as Partial<MacUpdateCommand>;
    const keys = Object.keys(input);
    if (
      keys.length !== 3 ||
      !keys.every((key) => ["action", "offerId", "manifestSha256"].includes(key)) ||
      (value.action !== "approve" && value.action !== "defer") ||
      typeof value.offerId !== "string" ||
      typeof value.manifestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.manifestSha256)
    )
      return invalid();
    const current = this.state;
    if (
      value.offerId !== current.offerId ||
      value.manifestSha256 !== current.manifestSha256 ||
      (value.action === "approve" && caller.windowsHeld)
    )
      return invalid();
    try {
      if (value.action === "defer") {
        if (!this.session.defer(value.offerId)) return invalid();
      } else await this.session.approve(value.offerId);
      return { ok: true, result: this.state };
    } catch {
      return invalid();
    }
  }
}

/** Register actual app IPC without constructing a resolver, recovery owner or native driver. */
export function installMacUpdateIPC(
  application: MacUpdateApplication,
  boundary: {
    readonly ipc: Pick<IpcMain, "on" | "handle">;
    readonly windows: () => readonly Pick<BrowserWindow, "isDestroyed" | "webContents">[];
    readonly epoch: () => number;
    readonly held: () => boolean;
  },
): void {
  const owns = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    boundary.windows().some((win) => !win.isDestroyed() && win.webContents === event.sender) &&
    event.senderFrame === event.sender.mainFrame;
  application.subscribe((state) => {
    for (const win of boundary.windows())
      if (!win.isDestroyed()) {
        try {
          win.webContents.send("orca:macUpdate.changed", state);
        } catch {
          /* Window disposal cannot release update guards. */
        }
      }
  });
  boundary.ipc.on("orca:macUpdate.read", (event) => {
    event.returnValue = owns(event) ? application.state : { phase: "unavailable" };
  });
  boundary.ipc.handle("orca:macUpdate.act", (event, input: unknown, epoch: number) =>
    application.act(input, {
      ownedMainFrame: owns(event),
      epoch,
      currentEpoch: boundary.epoch(),
      windowsHeld: boundary.held(),
    }),
  );
}
