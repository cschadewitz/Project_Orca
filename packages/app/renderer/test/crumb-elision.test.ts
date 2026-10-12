/**
 * Which crumbs the object header folds into `…` (`ui/crumb-elision.ts`), over real widths —
 * the half of chain elision happy-dom cannot exercise, because it measures every box as zero.
 *
 * The widths are a request token, a work item, a run with its version, and a step, as the
 * Runs header draws them: `❝ 5BNH42 REQUEST ▸ Database schema ITEM ⬡ 5M579G ▸ …`.
 */
import { describe, expect, it } from "vitest";
import { elideTrail, sameElision, type TrailMeasurement } from "../src/ui/crumb-elision.js";

const CHAIN = [120, 220, 300, 240] as const;
const GAP = 8;
const ELISION = 24;

const at = (available: number, crumbs: readonly number[] = CHAIN): TrailMeasurement => ({
  available,
  crumbs,
  elision: ELISION,
  gap: GAP,
});

/** The width of these items laid out in a row, the way the trail lays them out. */
const row = (...widths: number[]): number => widths.reduce((sum, width) => sum + width, 0) + GAP * (widths.length - 1);

describe("elideTrail", () => {
  it("shows the whole chain when it fits, to the pixel", () => {
    const whole = row(...CHAIN);
    expect(elideTrail(at(2000))).toBeUndefined();
    expect(elideTrail(at(whole))).toBeUndefined();
    expect(elideTrail(at(whole - 1))).toBeDefined();
  });

  it("folds the crumb after the root first, keeping the root and the last two", () => {
    const [root, , parent, current] = CHAIN;
    const kept = row(root, ELISION, parent, current);
    // request ▸ … ▸ run ▸ step
    expect(elideTrail(at(kept))).toEqual({ from: 1, to: 2 });
    expect(elideTrail(at(row(...CHAIN) - 1))).toEqual({ from: 1, to: 2 });
  });

  it("folds the parent only when the root, `…`, parent and current do not fit", () => {
    const [root, , parent, current] = CHAIN;
    // request ▸ … ▸ step
    expect(elideTrail(at(row(root, ELISION, parent, current) - 1))).toEqual({ from: 1, to: 3 });
    expect(elideTrail(at(row(root, ELISION, current)))).toEqual({ from: 1, to: 3 });
  });

  it("goes no further than the root, `…` and the current crumb, however narrow — the name is cut instead", () => {
    expect(elideTrail(at(100))).toEqual({ from: 1, to: 3 });
    expect(elideTrail(at(1))).toEqual({ from: 1, to: 3 });
  });

  it("decides by width, not by how many crumbs there are", () => {
    // Four short crumbs fit a window four long ones do not.
    expect(elideTrail(at(400, [60, 60, 60, 60]))).toBeUndefined();
    expect(elideTrail(at(400, [200, 200, 200, 200]))).toEqual({ from: 1, to: 3 });
  });

  it("never folds a trail of three that fits, and folds only its middle when it does not", () => {
    const three = [220, 300, 240];
    expect(elideTrail(at(row(...three), three))).toBeUndefined();
    expect(elideTrail(at(row(...three) - 1, three))).toEqual({ from: 1, to: 2 });
  });

  it("never folds a trail of one or two: there is no middle", () => {
    expect(elideTrail(at(10, [300, 300]))).toBeUndefined();
    expect(elideTrail(at(10, [300]))).toBeUndefined();
    expect(elideTrail(at(10, []))).toBeUndefined();
  });

  it("folds a longer chain one crumb at a time, nearest the root first", () => {
    const five = [100, 100, 100, 100, 100];
    // All five: 532. The root, `…` and the last three: 456. The last two: 348. The last one: 240.
    expect(elideTrail(at(532, five))).toBeUndefined();
    expect(elideTrail(at(500, five))).toEqual({ from: 1, to: 2 });
    expect(elideTrail(at(400, five))).toEqual({ from: 1, to: 3 });
    expect(elideTrail(at(300, five))).toEqual({ from: 1, to: 4 });
  });

  it("never folds the root or the current crumb, at any width, for any length", () => {
    for (let count = 0; count <= 7; count += 1) {
      const crumbs = Array.from({ length: count }, (_, index) => 80 + 37 * index);
      for (let available = 1; available <= 1400; available += 7) {
        const folded = elideTrail(at(available, crumbs));
        if (folded === undefined) continue;
        expect(folded.from).toBe(1);
        expect(folded.to).toBeLessThanOrEqual(count - 1);
        expect(folded.to).toBeGreaterThan(folded.from);
      }
    }
  });

  it("shows everything when nothing has been measured — happy-dom, and the first frame", () => {
    expect(elideTrail({ available: 0, crumbs: [0, 0, 0, 0], elision: 0, gap: 0 })).toBeUndefined();
    // Even with a gap read from a stylesheet and no layout behind it.
    expect(elideTrail({ available: 0, crumbs: [0, 0, 0, 0], elision: 0, gap: GAP })).toBeUndefined();
  });

  it("folds less as the room grows, never more", () => {
    let hidden = Number.POSITIVE_INFINITY;
    for (let available = 1; available <= 1200; available += 1) {
      const folded = elideTrail(at(available));
      const count = folded === undefined ? 0 : folded.to - folded.from;
      expect(count).toBeLessThanOrEqual(hidden);
      hidden = count;
    }
    expect(hidden).toBe(0);
  });
});

describe("sameElision", () => {
  it("treats two equal answers as one, so a resize that changes nothing re-renders nothing", () => {
    expect(sameElision(undefined, undefined)).toBe(true);
    expect(sameElision({ from: 1, to: 2 }, { from: 1, to: 2 })).toBe(true);
    expect(sameElision({ from: 1, to: 2 }, { from: 1, to: 3 })).toBe(false);
    expect(sameElision(undefined, { from: 1, to: 2 })).toBe(false);
  });
});
