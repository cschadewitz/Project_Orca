/** Real Electron boundary for Mac draft leases; native activation remains disabled. */
import type { BrowserWindow, IpcMain, WebContents } from "electron";
import type { DraftWindowBoundary } from "./update-ipc.js";

type WindowEvent = Parameters<NonNullable<ReturnType<DraftWindowBoundary["acquire"]>>["listen"]>[0];
interface Document {
  window: BrowserWindow;
  generation: number;
  available: boolean;
}
interface Hold {
  intact: boolean;
  documents: Map<WebContents, { document: Document; generation: number; frame: WebContents["mainFrame"] }>;
  enabled: Map<BrowserWindow, boolean>;
  listener?: WindowEvent;
}
/** All app windows share one arbiter. Creation is deferred, native interaction is
 * disabled before capture, and document replacement permanently invalidates a hold.
 */
export class MacUpdateWindows implements DraftWindowBoundary {
  private readonly documents = new Map<WebContents, Document>();
  private held: Hold | undefined;
  private legacy: symbol | undefined;
  private deferredCreation = false;
  constructor(
    private readonly deps: {
      windows(): readonly BrowserWindow[];
      ipc: Pick<IpcMain, "on" | "off">;
      createDeferred(): void;
    },
  ) {}
  get active(): boolean {
    return this.held !== undefined;
  }
  requestCreation(): boolean {
    if (!this.held) return true;
    this.deferredCreation = true;
    return false;
  }
  /** Legacy callers receive their own release handle, never a global null unlock. */
  beginLegacy(): (() => void) | undefined {
    if (this.held || this.legacy) return undefined;
    const owner = Symbol("legacy-drafts");
    this.legacy = owner;
    return () => {
      if (this.legacy === owner) this.legacy = undefined;
    };
  }
  track(window: BrowserWindow): void {
    const contents = window.webContents;
    if (this.documents.has(contents)) return;
    const document: Document = { window, generation: 0, available: true };
    this.documents.set(contents, document);
    const changed = () => {
      const held = this.held;
      if (held) {
        held.intact = false;
        held.listener?.({ kind: "changed" });
      }
    };
    if (this.held) {
      this.held.enabled.set(window, window.isEnabled());
      window.setEnabled(false);
      changed();
    }
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        document.generation++;
        changed();
      }
    });
    contents.on("did-finish-load", () => {
      document.available = true;
    });
    contents.on("render-process-gone", () => {
      document.available = false;
      document.generation++;
      changed();
    });
    contents.on("destroyed", () => {
      document.available = false;
      this.documents.delete(contents);
      changed();
    });
    window.on("closed", () => {
      document.available = false;
      this.documents.delete(contents);
      changed();
    });
    contents.on("will-frame-navigate", (details) => {
      if (this.held && details.isMainFrame) details.preventDefault();
    });
    contents.on("before-input-event", (event) => {
      if (this.held) event.preventDefault();
    });
    contents.on("before-mouse-event", (event) => {
      if (this.held) event.preventDefault();
    });
    contents.setWindowOpenHandler(() => (this.held ? { action: "deny" } : { action: "allow" }));
  }
  acquire(): ReturnType<DraftWindowBoundary["acquire"]> {
    if (this.held || this.legacy) return undefined;
    const windows = this.deps.windows().filter((window) => !window.isDestroyed());
    for (const window of windows) this.track(window);
    if (
      !windows.length ||
      windows.some(
        (window) =>
          window.webContents.isDestroyed() ||
          window.webContents.isLoadingMainFrame() ||
          !this.documents.get(window.webContents)?.available,
      )
    )
      return undefined;
    const hold: Hold = { intact: true, documents: new Map(), enabled: new Map() };
    this.held = hold;
    for (const window of windows) {
      hold.enabled.set(window, window.isEnabled());
      window.setEnabled(false);
      const document = this.documents.get(window.webContents)!;
      hold.documents.set(window.webContents, {
        document,
        generation: document.generation,
        frame: window.webContents.mainFrame,
      });
    }
    const check = () =>
      this.held === hold &&
      hold.intact &&
      this.deps.windows().length === hold.documents.size &&
      [...hold.documents].every(
        ([contents, captured]) =>
          captured.document.available &&
          !captured.document.window.isDestroyed() &&
          !captured.document.window.isEnabled() &&
          !contents.isDestroyed() &&
          !contents.isLoadingMainFrame() &&
          captured.document.generation === captured.generation &&
          contents.mainFrame === captured.frame,
      );
    return {
      windows: [...hold.documents].map(([contents, captured]) => ({
        id: contents.id,
        generation: captured.generation,
      })),
      check,
      send: (message) => {
        if (!check()) throw new Error("Window lease changed");
        for (const [contents, captured] of hold.documents)
          contents.send("orca:macUpdate.prepare", { ...message, generation: captured.generation });
      },
      listen: (callback) => {
        hold.listener = callback;
        const listener = (event: Electron.IpcMainEvent, value: unknown) => {
          const captured = hold.documents.get(event.sender);
          if (
            this.held === hold &&
            hold.intact &&
            captured &&
            event.senderFrame === event.sender.mainFrame &&
            event.senderFrame === captured.frame &&
            captured.generation === captured.document.generation
          )
            callback({ kind: "ack", sender: event.sender.id, value });
        };
        this.deps.ipc.on("orca:macUpdate.prepared", listener);
        return () => {
          this.deps.ipc.off("orca:macUpdate.prepared", listener);
          delete hold.listener;
        };
      },
      release: () => {
        if (!check()) throw new Error("Window lease changed");
        for (const [window, enabled] of hold.enabled) window.setEnabled(enabled);
        this.held = undefined;
        if (this.deferredCreation) {
          this.deferredCreation = false;
          // Guard cleanup completes before a deferred constructor can reenter.
          queueMicrotask(() => this.deps.createDeferred());
        }
      },
    };
  }
}
