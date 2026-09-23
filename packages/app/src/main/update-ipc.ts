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
