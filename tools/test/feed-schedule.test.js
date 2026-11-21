/** The automatic promotion schedule: what is due for a version at a given age. */
import { describe, expect, it } from "vitest";
import { due, SCHEDULE } from "../deploy/feed-schedule.js";

const rings = (r) => ({ format: 1, rings: r });
const fresh = rings({ internal: { version: "0.8.0" }, preview: { version: "0.7.0" }, stable: { version: "0.7.0" } });

describe("feed promotion schedule", () => {
  it("is preview at 24 h, 20% of stable at 48 h and all of stable at 96 h", () => {
    expect(SCHEDULE.map((s) => [s.ring, s.percent, s.after])).toEqual([
      ["preview", 100, 24],
      ["stable", 20, 48],
      ["stable", 100, 96],
    ]);
  });

  it.each([
    [0, []],
    [23, []],
    [24, [["preview", "0.8.0", 100]]],
    [
      48,
      [
        ["preview", "0.8.0", 100],
        ["stable", "0.8.0", 20],
      ],
    ],
    [
      200,
      [
        ["preview", "0.8.0", 100],
        ["stable", "0.8.0", 20],
        ["stable", "0.8.0", 100],
      ],
    ],
  ])("at %i h a fresh final is due %j", (age, steps) => {
    expect(due(fresh, "0.8.0", age, false)).toEqual(steps);
  });

  it("emits only what is behind, so a second run is a no-op", () => {
    const partway = rings({
      internal: { version: "0.8.0" },
      preview: { version: "0.8.0" },
      stable: { version: "0.7.0", rollout: { version: "0.8.0", percent: 20 } },
    });
    expect(due(partway, "0.8.0", 50, false)).toEqual([]);
    expect(due(partway, "0.8.0", 100, false)).toEqual([["stable", "0.8.0", 100]]);
    const done = rings({ internal: { version: "0.8.0" }, preview: { version: "0.8.0" }, stable: { version: "0.8.0" } });
    expect(due(done, "0.8.0", 500, false)).toEqual([]);
  });

  it("keeps a wider manual rollout and never moves a ring that went past the version", () => {
    const manual = rings({
      internal: { version: "0.8.0" },
      preview: { version: "0.9.0" },
      stable: { version: "0.7.0", rollout: { version: "0.8.0", percent: 50 } },
    });
    expect(due(manual, "0.8.0", 50, false)).toEqual([]);
    expect(due(manual, "0.8.0", 100, false)).toEqual([["stable", "0.8.0", 100]]);
  });

  it("takes a release candidate to preview and never to stable", () => {
    const rc = rings({
      internal: { version: "0.8.0-rc.1" },
      preview: { version: "0.7.0" },
      stable: { version: "0.7.0" },
    });
    expect(due(rc, "0.8.0-rc.1", 500, false)).toEqual([["preview", "0.8.0-rc.1", 100]]);
  });

  it("does nothing for a halted version", () => {
    expect(due(fresh, "0.8.0", 500, true)).toEqual([]);
  });

  it("refuses a bad version or age", () => {
    expect(() => due(fresh, "v0.8.0", 1, false)).toThrow();
    expect(() => due(fresh, "0.8.0", Number.NaN, false)).toThrow();
  });
});
