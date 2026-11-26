/**
 * Tailnet presence for the Machines view (#1230): read only while a window watches, one read at
 * a time, only for profiles bound to a node, and nothing at all without a running client.
 */
import { describe, expect, it } from "vitest";
import type { TailnetRead, TailnetSnapshot } from "@orca/protocol/tailnet";
import { shownBindings, TailnetPresenceWatch, type PresenceSnapshot } from "../src/main/tailnet-presence.js";

const snapshot = (online: boolean): TailnetSnapshot => ({
  peers: [
    {
      nodeId: "nBuild1",
      dnsName: "build-1.example-tailnet.ts.net",
      hostName: "build-1",
      os: "linux",
      online,
      ...(online ? {} : { lastSeen: "2026-11-26T18:04:05Z" }),
      addresses: ["100.101.102.103"],
      tags: [],
      sharedIn: false,
      sshHostKeys: [],
      tailscaleSsh: true,
      hostSupported: true,
    },
  ],
});

function rig(initial: TailnetRead = { state: "running", snapshot: snapshot(true) }) {
  let shown = ["lab", "moved"];
  let answer = initial;
  const pending: (() => void)[] = [];
  let held = false;
  let reads = 0;
  const ticks: (() => void)[] = [];
  let cleared = 0;
  const changes: PresenceSnapshot[] = [];
  const watch = new TailnetPresenceWatch({
    read: () => {
      reads++;
      const value = answer;
      return held ? new Promise((resolve) => pending.push(() => resolve(value))) : Promise.resolve(value);
    },
    bindings: () =>
      [
        { id: "lab", tailnet: { node: "nBuild1", name: "build-1.example-tailnet.ts.net" } },
        { id: "moved", tailnet: { node: "nGone", name: "build-1.example-tailnet.ts.net" } },
      ].filter((binding) => shown.includes(binding.id)),
    onChange: (next) => changes.push(next),
    setInterval: (run) => {
      ticks.push(run);
      return ticks.length;
    },
    clearInterval: () => cleared++,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    watch,
    changes,
    ticks,
    get reads() {
      return reads;
    },
    get cleared() {
      return cleared;
    },
    answer: (next: TailnetRead) => (answer = next),
    show: (ids: string[]) => (shown = ids),
    hold: () => (held = true),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    settle,
  };
}

describe("tailnet presence", () => {
  it("reads only while a window watches, and says each bound profile's state", async () => {
    const r = rig();
    expect(r.reads).toBe(0);
    r.watch.watch(1, true);
    r.watch.watch(2, true);
    await r.settle();
    expect(r.reads).toBe(1);
    expect(r.ticks).toHaveLength(1);
    expect(r.changes.at(-1)).toEqual({
      lab: { kind: "online", name: "build-1.example-tailnet.ts.net" },
      moved: { kind: "different-machine" },
    });

    // Goes offline: the next interval says so, with when it was last seen.
    r.answer({ state: "running", snapshot: snapshot(false) });
    r.ticks[0]!();
    await r.settle();
    expect(r.changes.at(-1)!.lab).toEqual({
      kind: "offline",
      name: "build-1.example-tailnet.ts.net",
      lastSeen: "2026-11-26T18:04:05Z",
    });
    // Unchanged: nobody is told again.
    const told = r.changes.length;
    r.ticks[0]!();
    await r.settle();
    expect(r.changes).toHaveLength(told);

    // The last window leaving stops the reads and forgets what was said.
    r.watch.watch(1, false);
    expect(r.cleared).toBe(0);
    r.watch.watch(2, false);
    expect(r.cleared).toBe(1);
    expect(r.watch.snapshot).toEqual({});
  });

  it("reads again at once when the machines on screen change, only while watched", async () => {
    const r = rig();
    r.watch.refresh();
    await r.settle();
    expect(r.reads).toBe(0);
    r.watch.watch(1, true);
    await r.settle();
    r.watch.refresh();
    await r.settle();
    expect(r.reads).toBe(2);
  });

  it("covers only the tailnet profiles whose machines are on screen", () => {
    const lab = { node: "nBuild1", name: "build-1.example-tailnet.ts.net" };
    const other = { node: "nOther", name: "other.example-tailnet.ts.net" };
    expect(
      shownBindings(
        [{ id: "lab", tailnet: lab }, { id: "other", tailnet: other }, { id: "plain" }],
        ["bundled", "profile:lab", "profile:plain"],
      ),
    ).toEqual([{ id: "lab", tailnet: lab }]);
  });

  it("drops a profile that left the screen at once, even while a read is pending, for a new subscriber too", async () => {
    const r = rig();
    r.watch.watch(1, true);
    await r.settle();
    expect(Object.keys(r.watch.snapshot)).toEqual(["lab", "moved"]);
    // A read is pending when `lab` leaves the screen.
    r.hold();
    r.ticks[0]!();
    r.show(["moved"]);
    r.watch.refresh();
    // The watching window is told now, and a window joining now gets no `lab` either.
    expect(r.changes.at(-1)).toEqual({ moved: { kind: "different-machine" } });
    r.watch.watch(2, true);
    expect(r.watch.snapshot).toEqual({ moved: { kind: "different-machine" } });
    r.release();
    await r.settle();
    expect(r.watch.snapshot).not.toHaveProperty("lab");
  });

  it("says nothing without a running client", async () => {
    const r = rig({ state: "stopped" });
    r.watch.watch(1, true);
    await r.settle();
    expect(r.watch.snapshot).toEqual({});
    expect(r.changes).toEqual([]);
  });

  it("runs one read at a time, and drops one that finishes after the view closed", async () => {
    const r = rig();
    r.hold();
    r.watch.watch(1, true);
    r.ticks[0]!();
    expect(r.reads).toBe(1);
    r.watch.watch(1, false);
    r.release();
    await r.settle();
    expect(r.changes).toEqual([]);
    expect(r.watch.snapshot).toEqual({});
  });
});
