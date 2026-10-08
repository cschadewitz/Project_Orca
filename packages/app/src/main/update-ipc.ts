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
  releasing: boolean;
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
    // Reserve before any adapter call or snapshot accessor can reenter preparation.
    this.uncertain = true;
    try {
      boundary = this.windows.acquire();
    } catch {
      this.uncertain = true;
      return { outcome: "unknown" };
    }
    if (!boundary) {
      this.uncertain = false;
      return { outcome: "blocked", blocker: "window-unavailable" };
    }
    let captured: { id: number; generation: number }[];
    try {
      captured = boundary.windows.map((window) => ({ ...window }));
    } catch {
      // No prepare message was sent. Only positively completed local cleanup
      // permits another acquisition after uncertain snapshot extraction.
      try {
        boundary.release();
        this.uncertain = false;
      } catch {
        /* Retain the acquisition uncertainty. */
      }
      return { outcome: "unknown" };
    }
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
        this.uncertain = false;
      } catch {
        this.uncertain = true;
        return { outcome: "unknown" };
      }
      return { outcome: "blocked", blocker: "window-unavailable" };
    }
    const held: HeldDrafts = {
      boundary,
      nonce: randomUUID(),
      intact: true,
      ready: false,
      releasing: false,
      unlisten: () => {},
    };
    this.held = held;
    this.uncertain = false;
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
        if (this.held !== held || held.waiting || held.releasing) return "unknown";
        // The ACK waiter may disappear synchronously. Ownership lasts through
        // boundary release and listener cleanup, including reentrant adapter calls.
        held.releasing = true;
        held.ready = false;
        try {
          if (!(await acknowledge("release"))) return "unknown";
          if (this.held !== held || !held.intact || !boundary.check()) return "unknown";
          boundary.release();
          held.unlisten();
          if (this.held !== held) return "unknown";
          this.held = undefined;
          return "released";
        } catch {
          return "unknown";
        }
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
