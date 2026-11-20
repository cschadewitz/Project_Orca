/** The desktop feed's ring rules and the CLI the release jobs run them through. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  emptyRings,
  promote,
  publish,
  rolloutBucket,
  validateRings,
  versionFor,
} from "../deploy/feed-worker/rings.js";
import { run } from "../deploy/feed-rings.js";
import { mint } from "../deploy/feed-token.js";

describe("compareVersions", () => {
  it.each([
    ["0.7.0", "0.6.9", 1],
    ["0.7.0", "0.7.0-rc.2", 1],
    ["0.7.0-rc.10", "0.7.0-rc.2", 1],
    ["0.7.0-rc.2", "0.7.0-rc.2", 0],
    ["0.7.0-alpha", "0.7.0-alpha.1", -1],
    ["0.7.0-1", "0.7.0-alpha", -1],
    ["1.0.0", "0.99.99", 1],
  ])("%s vs %s is %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
    expect(compareVersions(b, a)).toBe(-expected || 0);
  });

  it("refuses anything that is not a plain semantic version", () => {
    expect(() => compareVersions("v0.7.0", "0.7.0")).toThrow(/Invalid version/);
    expect(() => compareVersions("0.7.0+build", "0.7.0")).toThrow(/Invalid version/);
  });
});

describe("validateRings", () => {
  it.each([
    ["the wrong format", { format: 2, rings: {} }],
    ["an unknown ring", { format: 1, rings: { nightly: { version: "0.7.0" } } }],
    ["a prerelease in stable", { format: 1, rings: { stable: { version: "0.7.0-rc.1" } } }],
    [
      "a prerelease stable rollout",
      { format: 1, rings: { stable: { rollout: { version: "0.8.0-rc.1", percent: 5 } } } },
    ],
    ["a rollout at 100", { format: 1, rings: { preview: { rollout: { version: "0.7.0", percent: 100 } } } }],
    [
      "a rollout not newer",
      { format: 1, rings: { preview: { version: "0.7.0", rollout: { version: "0.7.0", percent: 5 } } } },
    ],
    ["a bad version", { format: 1, rings: { preview: { version: "latest" } } }],
  ])("refuses %s", (_label, value) => {
    expect(() => validateRings(value)).toThrow();
  });
});

describe("publish", () => {
  it("offers a new version to internal only", () => {
    const { rings, changed } = publish(
      { format: 1, rings: { preview: { version: "0.7.0" }, stable: { version: "0.7.0" } } },
      "0.7.1-rc.1",
    );
    expect(changed).toBe(true);
    expect(rings.rings).toEqual({
      internal: { version: "0.7.1-rc.1" },
      preview: { version: "0.7.0" },
      stable: { version: "0.7.0" },
    });
  });

  it("stores an older hotfix without moving internal backwards", () => {
    const start = { format: 1, rings: { internal: { version: "0.8.0-rc.1" } } };
    const result = publish(start, "0.7.1");
    expect(result.changed).toBe(false);
    expect(result.rings).toEqual(start);
    expect(result.message).toMatch(/stored only/);
  });
});

describe("promote", () => {
  const base = { format: 1, rings: { preview: { version: "0.7.0" }, stable: { version: "0.7.0" } } };

  it("rolls out to a percentage, widens it, then completes it", () => {
    let rings = promote(base, "preview", "0.7.1-rc.1", 10).rings;
    expect(rings.rings.preview).toEqual({ version: "0.7.0", rollout: { version: "0.7.1-rc.1", percent: 10 } });
    rings = promote(rings, "preview", "0.7.1-rc.1", 50).rings;
    expect(rings.rings.preview.rollout.percent).toBe(50);
    rings = promote(rings, "preview", "0.7.1-rc.1", 100).rings;
    expect(rings.rings.preview).toEqual({ version: "0.7.1-rc.1" });
  });

  it("halts a rollout without touching the ring's version", () => {
    const rolling = promote(base, "stable", "0.7.1", 20).rings;
    const halted = promote(rolling, "stable", "0.7.1", 0);
    expect(halted.rings.rings.stable).toEqual({ version: "0.7.0" });
    expect(() => promote(rolling, "stable", "0.7.2", 0)).toThrow(/not rolling out/);
  });

  it("never moves a ring backwards and keeps prereleases out of stable", () => {
    expect(() => promote(base, "stable", "0.7.0", 100)).toThrow(/never move backwards/);
    expect(() => promote(base, "stable", "0.6.9", 50)).toThrow(/never move backwards/);
    expect(() => promote(base, "stable", "0.7.1-rc.1", 100)).toThrow(/prerelease/);
    expect(() => promote(base, "nightly", "0.7.1", 100)).toThrow(/Unknown ring/);
    expect(() => promote(base, "stable", "0.7.1", 101)).toThrow(/percent/);
  });

  it("starts a ring that has never offered anything", () => {
    expect(promote(emptyRings(), "stable", "0.7.0", 100).rings.rings).toEqual({ stable: { version: "0.7.0" } });
  });
});

describe("rollouts", () => {
  it("bucket is stable per token and version and spreads across 0-99", async () => {
    expect(await rolloutBucket("abc", "0.7.1")).toBe(await rolloutBucket("abc", "0.7.1"));
    const buckets = await Promise.all(Array.from({ length: 400 }, (_, i) => rolloutBucket(`t${i}`, "0.7.1")));
    expect(Math.min(...buckets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...buckets)).toBeLessThan(100);
    const share = buckets.filter((b) => b < 25).length / buckets.length;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.35);
  });

  it("raising the percentage only adds tokens", async () => {
    const at = (percent) => ({
      format: 1,
      rings: { preview: { version: "0.7.0", rollout: { version: "0.7.1", percent } } },
    });
    const tokens = Array.from({ length: 200 }, (_, i) => `token-${i}`);
    const offered = async (percent) =>
      new Set(
        (
          await Promise.all(
            tokens.map(async (t) => ((await versionFor(at(percent), "preview", t)) === "0.7.1" ? t : null)),
          )
        ).filter(Boolean),
      );
    const small = await offered(10);
    const large = await offered(60);
    for (const t of small) expect(large.has(t)).toBe(true);
    expect(large.size).toBeGreaterThan(small.size);
  });
});

describe("feed-rings CLI and feed-token", () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("creates rings.json on first publish and applies promotions in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-rings-"));
    dirs.push(dir);
    const file = join(dir, "rings.json");
    expect(run([file, "publish", "0.7.0"])).toBe("internal now offers 0.7.0");
    expect(run([file, "promote", "stable", "0.7.0", "100"])).toBe("stable now offers 0.7.0 to everyone");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      format: 1,
      rings: { internal: { version: "0.7.0" }, stable: { version: "0.7.0" } },
    });
  });

  it("leaves the file untouched when a transition is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-rings-"));
    dirs.push(dir);
    const file = join(dir, "rings.json");
    const before = JSON.stringify({ format: 1, rings: { stable: { version: "0.7.0" } } });
    writeFileSync(file, before);
    expect(() => run([file, "promote", "stable", "0.6.0", "100"])).toThrow(/backwards/);
    expect(() => run([file, "promote", "stable", "0.7.1", "ten"])).toThrow(/usage/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("mints a token the Worker accepts and keeps only its hash", () => {
    const { token, entry } = mint("preview", Buffer.alloc(32, 7));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [[hash, value]] = Object.entries(entry);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(value).toEqual({ ring: "preview" });
    expect(JSON.stringify(entry)).not.toContain(token);
    expect(() => mint("nightly")).toThrow(/ring must be/);
  });
});
