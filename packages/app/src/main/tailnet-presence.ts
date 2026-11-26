/**
 * Tailnet presence for the Machines view (#1230): for each profile on the view's screen that is
 * bound to a tailnet node, whether that node is online, read from this computer's Tailscale client without opening
 * any ssh connection.
 *
 * It reads only while some window shows the Machines view: the first watcher starts a read and
 * a modest interval, the last one leaving stops it. One read runs at a time. What it says is a
 * hint beside a machine; the connection state still comes from its SSH lease. With Tailscale not
 * running here, or the `tailnet-hosts` flag off, it says nothing.
 *
 * Electron-free, so its timing and watcher bookkeeping are a plain test.
 */
import type { TailnetBinding, TailnetPresence, TailnetRead } from "@orca/protocol/tailnet";
import { tailnetPresence } from "@orca/protocol/tailnet";

/** How often the client is asked while the view is open. */
export const PRESENCE_INTERVAL_MS = 30_000;

/** Presence by profile id, for the profiles bound to a node. Empty when there is nothing to say. */
export type PresenceSnapshot = Record<string, TailnetPresence>;

export interface TailnetPresenceOptions {
  /** One read of the local tailnet (`readTailnet`); never throws. */
  read: () => Promise<TailnetRead>;
  /** The profiles the view shows that are bound to a tailnet node, read fresh each time. */
  bindings: () => readonly { id: string; tailnet: TailnetBinding }[];
  /** Called with every new snapshot, for the watchers. */
  onChange: (snapshot: PresenceSnapshot) => void;
  intervalMs?: number;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * The bindings presence is read for: only the profiles bound to a node whose machine is on the
 * view's screen (`profile:<id>` keys), never every saved tailnet profile.
 */
export function shownBindings(
  profiles: readonly { id: string; tailnet?: TailnetBinding | undefined }[],
  machineKeys: readonly string[],
): { id: string; tailnet: TailnetBinding }[] {
  const shown = new Set(machineKeys);
  return profiles.flatMap((profile) =>
    profile.tailnet && shown.has(`profile:${profile.id}`) ? [{ id: profile.id, tailnet: profile.tailnet }] : [],
  );
}

export class TailnetPresenceWatch {
  private readonly watchers = new Set<number>();
  private timer: unknown;
  private reading = false;
  private current: PresenceSnapshot = {};
  /** Counts starts and stops, so a read that finishes after the last watcher left says nothing. */
  private epoch = 0;

  constructor(private readonly o: TailnetPresenceOptions) {}

  /** What is known now, only for the profiles shown now: never one that has left the screen. */
  get snapshot(): PresenceSnapshot {
    this.prune();
    return this.current;
  }

  /** A window started or stopped showing the Machines view. */
  watch(watcher: number, on: boolean): void {
    const before = this.watchers.size;
    if (on) this.watchers.add(watcher);
    else this.watchers.delete(watcher);
    if (before === 0 && this.watchers.size > 0) this.start();
    else if (before > 0 && this.watchers.size === 0) this.stop();
  }

  /** The profiles on screen changed: read again now, while a window watches. */
  refresh(): void {
    // A profile that left the screen is dropped now, not when the next read finishes.
    if (this.prune()) this.o.onChange(this.current);
    if (this.watchers.size > 0) void this.poll();
  }

  /** Drop entries for profiles no longer shown. Whether anything was dropped. */
  private prune(): boolean {
    const shown = new Set(this.o.bindings().map((binding) => binding.id));
    const kept = Object.fromEntries(Object.entries(this.current).filter(([id]) => shown.has(id)));
    if (Object.keys(kept).length === Object.keys(this.current).length) return false;
    this.current = kept;
    return true;
  }

  close(): void {
    this.watchers.clear();
    this.stop();
  }

  private start(): void {
    this.epoch++;
    void this.poll();
    this.timer = (this.o.setInterval ?? setInterval)(() => void this.poll(), this.o.intervalMs ?? PRESENCE_INTERVAL_MS);
  }

  private stop(): void {
    this.epoch++;
    if (this.timer !== undefined) (this.o.clearInterval ?? ((handle) => clearInterval(handle as never)))(this.timer);
    this.timer = undefined;
    this.current = {};
  }

  private async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const epoch = this.epoch;
    try {
      const read = await this.o.read();
      if (epoch !== this.epoch || this.watchers.size === 0) return;
      const next: PresenceSnapshot = {};
      if (read.state === "running")
        for (const { id, tailnet } of this.o.bindings()) next[id] = tailnetPresence(read.snapshot, tailnet);
      if (JSON.stringify(next) === JSON.stringify(this.current)) return;
      this.current = next;
      this.o.onChange(next);
    } finally {
      this.reading = false;
    }
  }
}
