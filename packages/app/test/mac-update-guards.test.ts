/** Synthetic window lifecycle and nonce draft lease state contracts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NonceDraftGuard, type DraftWindowBoundary } from "../src/main/update-ipc.js";

function windows() {
  let barrier = false;
  let intact = true;
  let auto = true;
  let draft = false;
  let receive: Parameters<NonNullable<ReturnType<DraftWindowBoundary["acquire"]>>["listen"]>[0] = () => {};
  const sent: { nonce: string; phase: "prepare" | "release" }[] = [];
  const release = vi.fn(() => {
    barrier = false;
  });
  const boundary: DraftWindowBoundary = {
    acquire: () => {
      if (barrier) return undefined;
      barrier = true;
      intact = true;
      return {
        windows: [
          { id: 1, generation: 3 },
          { id: 2, generation: 7 },
        ],
        check: () => intact,
        release,
        listen: (listener) => {
          receive = listener;
          return () => {
            receive = () => {};
          };
        },
        send: (message) => {
          sent.push(message);
          if (auto)
            for (const [sender, generation] of [
              [1, 3],
              [2, 7],
            ]) {
              receive({
                kind: "ack",
                sender: sender!,
                value: { ...message, generation, ready: message.phase === "release" || !draft },
              });
            }
        },
      };
    },
  };
  return {
    boundary,
    sent,
    release,
    frozen: () => barrier,
    auto: (value: boolean) => {
      auto = value;
    },
    draft: () => {
      draft = true;
    },
    ack: (sender: number, value: unknown) => receive({ kind: "ack", sender, value }),
    changed: () => {
      intact = false;
      receive({ kind: "changed" });
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("nonce draft leases", () => {
  it("owns all captured documents until positive scoped release, rejecting stale releases", async () => {
    const w = windows();
    const guard = new NonceDraftGuard(w.boundary);
    const first = await guard.prepare();
    expect(first.outcome).toBe("ready");
    if (first.outcome !== "ready") throw new Error("Expected ready");
    expect(guard.valid()).toBe(true);
    expect(w.frozen()).toBe(true);
    expect(await guard.prepare()).toMatchObject({ outcome: "blocked" });
    expect(await first.lease.release()).toBe("released");
    const second = await guard.prepare();
    expect(second.outcome).toBe("ready");
    expect(w.sent[0]!.nonce).not.toBe(w.sent.at(-1)!.nonce);
    expect(await first.lease.release()).toBe("unknown");
    expect(w.frozen()).toBe(true);
    if (second.outcome === "ready") await second.lease.release();
  });
  it.each(["synchronous", "delayed-before-continuation"] as const)(
    "owns release through cleanup with %s acknowledgements",
    async (timing) => {
      const w = windows();
      const guard = new NonceDraftGuard(w.boundary);
      const prepared = await guard.prepare();
      if (prepared.outcome !== "ready") throw new Error("Expected ready");
      if (timing !== "synchronous") w.auto(false);
      const first = prepared.lease.release();
      if (timing !== "synchronous") {
        const message = w.sent.at(-1)!;
        w.ack(1, { ...message, generation: 3, ready: true });
        w.ack(2, { ...message, generation: 7, ready: true });
      }
      // ACK already cleared waiting, but the first release continuation has not run.
      const duplicate = prepared.lease.release();
      expect(await duplicate).toBe("unknown");
      expect(await first).toBe("released");
      expect(w.sent.filter((message) => message.phase === "release")).toHaveLength(1);
      expect(w.release).toHaveBeenCalledOnce();
    },
  );
  it.each(["confirmed", "throws"] as const)("handles throwing snapshot extraction with %s cleanup", async (cleanup) => {
    const release = vi.fn(() => {
      if (cleanup === "throws") throw new Error("release unknown");
    });
    const acquire = vi.fn(() => ({
      get windows(): readonly { id: number; generation: number }[] {
        throw new Error("snapshot unavailable");
      },
      release,
      check: () => true,
      listen: () => () => {},
      send: () => {},
    }));
    const guard = new NonceDraftGuard({ acquire });
    expect(await guard.prepare()).toEqual({ outcome: "unknown" });
    if (cleanup === "throws") {
      expect(await guard.prepare()).toMatchObject({ outcome: "blocked" });
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } else {
      expect(await guard.prepare()).toEqual({ outcome: "unknown" });
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(2);
    }
  });

  it("ignores foreign, wrong nonce, wrong phase and reloaded-document acknowledgements", async () => {
    vi.useFakeTimers();
    const w = windows();
    w.auto(false);
    const guard = new NonceDraftGuard(w.boundary);
    const prepared = guard.prepare();
    const message = w.sent[0]!;
    w.ack(3, { ...message, generation: 3, ready: true });
    w.ack(1, { ...message, nonce: "foreign", generation: 3, ready: true });
    w.ack(1, { ...message, phase: "release", generation: 3, ready: true });
    w.ack(1, { ...message, generation: 4, ready: true });
    w.ack(2, { ...message, generation: 7, ready: true });
    expect(guard.valid()).toBe(false);
    w.ack(1, { ...message, generation: 3, ready: true });
    const ready = await prepared;
    expect(ready.outcome).toBe("ready");
    if (ready.outcome !== "ready") throw new Error("Expected ready");
    const released = ready.lease.release();
    w.ack(1, { ...message, generation: 3, ready: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await released).toBe("unknown");
    expect(w.release).not.toHaveBeenCalled();
    expect(w.frozen()).toBe(true);
  });
  it.each(["created", "reloaded", "destroyed"])(
    "invalidates %s windows before use and retains unknown boundaries",
    async () => {
      const w = windows();
      const guard = new NonceDraftGuard(w.boundary);
      const ready = await guard.prepare();
      if (ready.outcome !== "ready") throw new Error("Expected ready");
      w.changed();
      expect(guard.valid()).toBe(false);
      expect(await ready.lease.release()).toBe("unknown");
      expect(w.release).not.toHaveBeenCalled();
    },
  );
  it("returns known drafts only after acknowledged unlock", async () => {
    const w = windows();
    w.draft();
    expect(await new NonceDraftGuard(w.boundary).prepare()).toEqual({ outcome: "blocked", blocker: "drafts" });
    expect(w.frozen()).toBe(false);
    expect(w.sent.map((message) => message.phase)).toEqual(["prepare", "release"]);
  });
  it("does not reacquire after uncertain barrier acquisition", async () => {
    const acquire = vi.fn(() => {
      throw new Error("barrier result lost");
    });
    const guard = new NonceDraftGuard({ acquire });
    expect(await guard.prepare()).toEqual({ outcome: "unknown" });
    expect(await guard.prepare()).toMatchObject({ outcome: "blocked" });
    expect(acquire).toHaveBeenCalledOnce();
  });
  it("retains an unacknowledged freeze after renderer timeout", async () => {
    vi.useFakeTimers();
    const w = windows();
    w.auto(false);
    const guard = new NonceDraftGuard(w.boundary);
    const prepared = guard.prepare();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await prepared).toEqual({ outcome: "unknown" });
    expect(w.frozen()).toBe(true);
    expect(await guard.prepare()).toMatchObject({ outcome: "blocked" });
  });
});
