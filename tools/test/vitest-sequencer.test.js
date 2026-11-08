// Checks the cold-runner test ordering in vitest.sequencer.ts: failed first, untimed next, then longest, with the checked-in seed only filling in for files that have no cached result.
import { describe, expect, it } from "vitest";
import SeededSequencer, { loadSeed, orderByDuration } from "../../vitest.sequencer.js";

describe("orderByDuration", () => {
  it("runs failed files first, then untimed files, then the longest", () => {
    const info = {
      slow: { failed: false, duration: 5000 },
      fast: { failed: false, duration: 10 },
      unknown: { failed: false, duration: undefined },
      broken: { failed: true, duration: 1 },
    };
    expect(orderByDuration(Object.keys(info), (name) => info[name])).toEqual(["broken", "unknown", "slow", "fast"]);
  });
});

describe("SeededSequencer", () => {
  const root = "/repo";
  const spec = (file) => ({ moduleId: `${root}/${file}` });

  it("orders a cold run by the checked-in seed, and a cached result wins over the seed", async () => {
    const seed = loadSeed();
    const [long, short] = Object.entries(seed)
      .sort(([, a], [, b]) => b - a)
      .map(([file]) => file);
    expect(seed[long]).toBeGreaterThan(seed[short]);

    const cold = new SeededSequencer({ config: { root }, cache: { getTestSpecificationResult: () => undefined } });
    expect((await cold.sort([spec(short), spec(long)])).map((s) => s.moduleId)).toEqual([
      `${root}/${long}`,
      `${root}/${short}`,
    ]);

    const cached = new SeededSequencer({
      config: { root },
      cache: {
        getTestSpecificationResult: (s) => ({ failed: false, duration: s.moduleId.endsWith(short) ? 99_999 : 1 }),
      },
    });
    expect((await cached.sort([spec(long), spec(short)])).map((s) => s.moduleId)).toEqual([
      `${root}/${short}`,
      `${root}/${long}`,
    ]);
  });

  it("seeds only files that exist", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const missing = Object.keys(loadSeed()).filter((file) => !existsSync(resolve(import.meta.dirname, "../..", file)));
    expect(missing).toEqual([]);
  });
});
