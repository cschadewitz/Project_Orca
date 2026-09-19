import { describe, expect, it } from "vitest";
import { formatAbsolute, formatDuration, formatRelative } from "../src/ui/format-time.js";

/* docs/design/30-long-running-content.md: "Durations are rendered to two units at most
   (`1h 12m`, `4.2s`)." Every case here is that rule, or the edge either side of it. */
describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [412, "412ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [4200, "4.2s"],
    [9949, "9.9s"],
    [10_000, "10s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [72_000, "1m 12s"],
    [3_600_000, "1h"],
    [4_320_000, "1h 12m"],
    [86_399_000, "23h 59m"],
    [86_400_000, "1d"],
    [97_200_000, "1d 3h"],
  ])("%ims is %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("never renders three units", () => {
    for (const ms of [4_321_000, 97_265_000, 90_061_000]) {
      expect(formatDuration(ms).split(" ")).toHaveLength(2);
    }
  });

  it("treats a negative span as zero rather than rendering a minus", () => {
    expect(formatDuration(-5)).toBe("0ms");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-09-19T14:08:31Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("stays quiet for the first few seconds", () => {
    expect(formatRelative(ago(0), now)).toBe("just now");
    expect(formatRelative(ago(4999), now)).toBe("just now");
  });

  it("reads as recency, in the same two units", () => {
    expect(formatRelative(ago(6000), now)).toBe("6.0s ago");
    expect(formatRelative(ago(360_000), now)).toBe("6m ago");
    expect(formatRelative(ago(4_320_000), now)).toBe("1h 12m ago");
  });

  it("says 'in' rather than a negative 'ago' for something still to come", () => {
    expect(formatRelative(new Date(now.getTime() + 360_000), now)).toBe("in 6m");
  });
});

describe("formatAbsolute", () => {
  it("is a 24-hour clock with seconds, because the events it labels can be a second apart", () => {
    const at = new Date(2026, 8, 19, 14, 2, 31);
    expect(formatAbsolute(at, new Date(2026, 8, 19, 18, 0, 0))).toBe("14:02:31");
  });

  it("adds the date only when it is not today", () => {
    const at = new Date(2026, 8, 18, 14, 2, 31);
    const rendered = formatAbsolute(at, new Date(2026, 8, 19, 18, 0, 0));
    expect(rendered).toContain("14:02:31");
    expect(rendered).not.toBe("14:02:31");
  });
});
