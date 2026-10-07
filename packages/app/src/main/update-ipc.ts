/** Narrow IPC validation and all-window draft acknowledgement; Electron-free for tests. */
import { randomUUID } from "node:crypto";
import type { UpdateAction } from "../update-contract.js";
export function isUpdateAction(value: unknown): value is UpdateAction {
  return typeof value === "string" && ["check", "download", "restart"].includes(value);
}
export interface DraftChallenge {
  ids: readonly number[];
  send(nonce: string): void;
  listen(callback: (sender: number, value: unknown) => void): () => void;
}
export function prepareDrafts(challenge: DraftChallenge): Promise<void> {
  return new Promise((resolve, reject) => {
    const nonce = randomUUID();
    const pending = new Set(challenge.ids);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      unlisten();
      if (ready) resolve();
      else reject(new Error("Unsaved drafts or renderer unavailable"));
    };
    const timer = setTimeout(() => finish(false), 5000);
    const unlisten = challenge.listen((sender, value) => {
      if (!value || typeof value !== "object" || !("nonce" in value) || value.nonce !== nonce || !pending.has(sender))
        return;
      if (!("ready" in value) || value.ready !== true) return finish(false);
      pending.delete(sender);
      if (!pending.size) finish(true);
    });
    if (!pending.size) return finish(false);
    challenge.send(nonce);
  });
}

/** A main-owned barrier must deny window creation/reload/interaction before snapshot.
 * listen observes authenticated main-frame acknowledgements and every lifecycle change.
 * Generation identifies a document, not just a reusable webContents ID. The real Electron
 * binding is intentionally pending; ordinary string/null Windows messages cannot own it.
 */
export interface DraftWindowBoundary {
  acquire():
    | {
        readonly windows: readonly { id: number; generation: number }[];
        check(): boolean;
        send(message: { nonce: string; phase: "prepare" | "release" }): void;
        listen(
          callback: (event: { kind: "changed" } | { kind: "ack"; sender: number; value: unknown }) => void,
        ): () => void;
        /** Only after positive release acknowledgement from the exact captured documents. */
        release(): void;
      }
    | undefined;
}
interface HeldDrafts {
  boundary: NonNullable<ReturnType<DraftWindowBoundary["acquire"]>>;
  nonce: string;
  intact: boolean;
  ready: boolean;
  unlisten: () => void;
  waiting?: { phase: "prepare" | "release"; pending: Set<number>; finish: (ready: boolean) => void };
}
/** One owner, fresh nonce per lease, positive release, and lifecycle checks through use. */
export class NonceDraftGuard {
  private held: HeldDrafts | undefined;
  private uncertain = false;
  constructor(private readonly windows: DraftWindowBoundary) {}
  valid(): boolean {
    const held = this.held;
    try {
      return Boolean(held?.ready && held.intact && held.boundary.check());
    } catch {
      return false;
    }
  }
  async prepare(): Promise<import("./mac-updates.js").MacPreparation<import("./mac-updates.js").MacDraftLease>> {
    if (this.held || this.uncertain) return { outcome: "blocked", blocker: "window-unavailable" };
    let boundary: ReturnType<DraftWindowBoundary["acquire"]>;
    try {
      boundary = this.windows.acquire();
    } catch {
      this.uncertain = true;
      return { outcome: "unknown" };
    }
    if (!boundary) return { outcome: "blocked", blocker: "window-unavailable" };
    const captured = boundary.windows.map((window) => ({ ...window }));
    if (
      !captured.length ||
      new Set(captured.map((window) => window.id)).size !== captured.length ||
      captured.some(
        (window) =>
          !Number.isSafeInteger(window.id) ||
          window.id < 1 ||
          !Number.isSafeInteger(window.generation) ||
          window.generation < 0,
      )
    ) {
      // No messages were sent, so no renderer freeze can have been acquired.
      try {
        boundary.release();
      } catch {
        this.uncertain = true;
        return { outcome: "unknown" };
      }
      return { outcome: "blocked", blocker: "window-unavailable" };
    }
    const held: HeldDrafts = { boundary, nonce: randomUUID(), intact: true, ready: false, unlisten: () => {} };
    this.held = held;
    try {
      held.unlisten = boundary.listen((event) => {
        if (event.kind === "changed") {
          held.intact = false;
          held.waiting?.finish(false);
          return;
        }
        const waiting = held.waiting;
        const value = event.value;
        const window = captured.find((window) => window.id === event.sender);
        if (
          !waiting ||
          !window ||
          !waiting.pending.has(event.sender) ||
          !value ||
          typeof value !== "object" ||
          !("nonce" in value) ||
          value.nonce !== held.nonce ||
          !("phase" in value) ||
          value.phase !== waiting.phase ||
          !("generation" in value) ||
          value.generation !== window.generation
        )
          return;
        if (!("ready" in value) || value.ready !== true) return waiting.finish(false);
        waiting.pending.delete(event.sender);
        if (!waiting.pending.size) waiting.finish(true);
      });
      const acknowledge = (phase: "prepare" | "release") =>
        new Promise<boolean>((resolve) => {
          let finished = false;
          const finish = (ready: boolean) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            delete held.waiting;
            resolve(ready);
          };
          const timer = setTimeout(() => finish(false), 5000);
          held.waiting = { phase, pending: new Set(captured.map((window) => window.id)), finish };
          try {
            if (!held.intact || !boundary.check()) finish(false);
            else boundary.send({ nonce: held.nonce, phase });
          } catch {
            finish(false);
          }
        });
      const release = async (): Promise<"released" | "unknown"> => {
        // A stale or concurrent release cannot unlock a different owner.
        if (this.held !== held || held.waiting) return "unknown";
        held.ready = false;
        if (!(await acknowledge("release"))) return "unknown";
        if (!held.intact || !boundary.check()) return "unknown";
        boundary.release();
        held.unlisten();
        this.held = undefined;
        return "released";
      };
      if (!(await acknowledge("prepare"))) {
        if ((await release()) === "unknown") return { outcome: "unknown" };
        return { outcome: "blocked", blocker: "drafts" };
      }
      if (!held.intact || !boundary.check()) return { outcome: "unknown" };
      held.ready = true;
      return { outcome: "ready", lease: { release } };
    } catch {
      // A possibly sent freeze or failed cleanup remains held; never report safe idle.
      held.ready = false;
      return { outcome: "unknown" };
    }
  }
}
