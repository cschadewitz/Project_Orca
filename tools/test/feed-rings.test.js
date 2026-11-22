/** The desktop feed's ring rules and the CLI the release jobs run them through. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  emptyRings,
  hasServer,
  promote,
  publish,
  resumeServers,
  rolloutBucket,
  stopServers,
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

  it("never replaces a newer active rollout with an older version", () => {
    const rolling = promote(base, "stable", "0.7.2", 10).rings;
    expect(() => promote(rolling, "stable", "0.7.1", 50)).toThrow(/rolling out 0.7.2/);
    expect(() => promote(rolling, "stable", "0.7.1", 100)).toThrow(/rolling out 0.7.2/);
    expect(promote(rolling, "stable", "0.7.2", 30).rings.rings.stable.rollout.percent).toBe(30);
    expect(promote(rolling, "stable", "0.7.3", 5).rings.rings.stable.rollout).toEqual({ version: "0.7.3", percent: 5 });
    expect(promote(rolling, "stable", "0.7.2", 0).rings.rings.stable).toEqual({ version: "0.7.0" });
  });

  it("does not let publication clear a newer internal rollout", () => {
    const rolling = promote(
      // Internal's servers already run the rc the desktops are given (#877).
      { format: 1, rings: { internal: { version: "0.7.0" } }, server: { internal: { version: "0.8.0-rc.2" } } },
      "internal",
      "0.8.0-rc.1",
      50,
    ).rings;
    const result = publish(rolling, "0.7.1");
    expect(result.changed).toBe(false);
    expect(result.rings).toEqual(rolling);
    expect(publish(rolling, "0.8.0-rc.2").rings.rings.internal).toEqual({ version: "0.8.0-rc.2" });
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

  it("shows the validated ring state on one line without writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-rings-"));
    dirs.push(dir);
    const file = join(dir, "rings.json");
    expect(run([file, "show"])).toBe(JSON.stringify({ format: 1, rings: {} }));
    expect(existsSync(file)).toBe(false);
    const state = { format: 1, rings: { stable: { version: "0.7.0" } } };
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    expect(run([file, "show"])).toBe(JSON.stringify(state));
    writeFileSync(file, JSON.stringify({ format: 2, rings: {} }));
    expect(() => run([file, "show"])).toThrow();
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

  it("mints a token limited to the server channel (#877)", () => {
    const { entry } = mint("stable", Buffer.alloc(32, 8), { server: true });
    expect(Object.values(entry)).toEqual([{ ring: "stable", channel: "server" }]);
  });
});

describe("server bundle channel (#877)", () => {
  const base = { format: 1, rings: { internal: { version: "0.7.1" }, preview: { version: "0.7.1" } } };

  it("starts with the 0.8 line, release candidates included", () => {
    expect(hasServer("0.8.0-rc.1")).toBe(true);
    expect(hasServer("0.8.0")).toBe(true);
    expect(hasServer("1.0.0")).toBe(true);
    expect(hasServer("0.7.9")).toBe(false);
    expect(() => publish(base, "0.7.2", "server")).toThrow(/predates the server bundle/);
    expect(() => promote(base, "preview", "0.7.2", 100, "server")).toThrow(/predates the server bundle/);
  });

  it("publishes and promotes servers in their own rings, without touching the desktop ones", () => {
    const published = publish(base, "0.8.0-rc.1", "server");
    expect(published.changed).toBe(true);
    expect(published.message).toBe("internal servers now offer 0.8.0-rc.1");
    expect(published.rings.rings).toEqual(base.rings);
    expect(published.rings.server).toEqual({ internal: { version: "0.8.0-rc.1" } });
    const rolling = promote(published.rings, "preview", "0.8.0-rc.1", 25, "server");
    expect(rolling.message).toBe("preview servers offer 0.8.0-rc.1 to 25%");
    expect(rolling.rings.server.preview).toEqual({ rollout: { version: "0.8.0-rc.1", percent: 25 } });
    expect(promote(rolling.rings, "preview", "0.8.0-rc.1", 0, "server").message).toBe(
      "preview servers rollout of 0.8.0-rc.1 halted",
    );
    expect(() => promote(rolling.rings, "preview", "0.8.0-rc.2", 0, "server")).toThrow(
      "preview servers are not rolling out 0.8.0-rc.2",
    );
    const full = promote(rolling.rings, "preview", "0.8.0-rc.1", 100, "server").rings;
    expect(() => promote(full, "preview", "0.8.0-rc.1", 100, "server")).toThrow(/never move backwards/);
    expect(() => promote(full, "stable", "0.8.0-rc.1", 100, "server")).toThrow(/stable cannot take a prerelease/);
    expect(publish(full, "0.8.0-rc.1", "server").changed).toBe(false);
  });

  it("refuses to offer desktops a version their ring's servers are not all on", () => {
    expect(() => publish(base, "0.8.0-rc.1")).toThrow(
      "internal servers are offered nothing; offer the server bundle 0.8.0-rc.1 to all of internal first (servers never fall behind desktops)",
    );
    let rings = publish(base, "0.8.0-rc.1", "server").rings;
    rings = publish(rings, "0.8.0-rc.1").rings;
    expect(rings.rings.internal).toEqual({ version: "0.8.0-rc.1" });
    // A server rollout is not enough: servers outside it keep the full version.
    rings = promote(rings, "preview", "0.8.0-rc.1", 50, "server").rings;
    for (const percent of [5, 100])
      expect(() => promote(rings, "preview", "0.8.0-rc.1", percent)).toThrow(
        "preview servers are offered nothing; offer the server bundle 0.8.0-rc.1 to all of preview first",
      );
    rings = promote(rings, "preview", "0.8.0-rc.1", 100, "server").rings;
    rings = promote(rings, "preview", "0.8.0-rc.1", 5).rings;
    expect(rings.rings.preview).toEqual({ version: "0.7.1", rollout: { version: "0.8.0-rc.1", percent: 5 } });
    // Desktops of a ring never pass its servers' full version, servers may run ahead.
    rings = promote(rings, "internal", "0.8.0", 100, "server").rings;
    expect(() => promote(rings, "preview", "0.8.0", 100)).toThrow("preview servers are on 0.8.0-rc.1;");
    expect(promote(rings, "internal", "0.8.0", 100).rings.rings.internal).toEqual({ version: "0.8.0" });
  });

  it("always lets a desktop rollout halt, and leaves pre-0.8 desktops alone", () => {
    const rings = {
      format: 1,
      rings: { preview: { version: "0.7.1", rollout: { version: "0.8.0-rc.1", percent: 5 } } },
      server: {},
    };
    expect(promote(rings, "preview", "0.8.0-rc.1", 0).rings.rings.preview).toEqual({ version: "0.7.1" });
    expect(promote(base, "preview", "0.7.2", 100).rings.rings.preview).toEqual({ version: "0.7.2" });
    expect(publish(base, "0.7.2").rings.rings.internal).toEqual({ version: "0.7.2" });
  });

  it("validates the server rings like the desktop ones, and reads a file without them", () => {
    expect(validateRings(base)).toBe(base);
    for (const server of [
      [],
      { nightly: { version: "0.8.0" } },
      { stable: { version: "0.8.0-rc.1" } },
      { preview: { version: "0.8.0", rollout: { version: "0.8.0", percent: 5 } } },
    ])
      expect(() => validateRings({ ...base, server })).toThrow();
  });

  it("resolves a token's server version from the server rings", async () => {
    const rings = { ...base, server: { preview: { version: "0.8.0-rc.1" } } };
    expect(await versionFor(rings, "preview", "a".repeat(64), "server")).toBe("0.8.0-rc.1");
    expect(await versionFor(rings, "internal", "a".repeat(64), "server")).toBeUndefined();
    expect(await versionFor(base, "preview", "a".repeat(64), "server")).toBeUndefined();
    expect(await versionFor(rings, "preview", "a".repeat(64))).toBe("0.7.1");
  });

  it("runs both channels through the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-rings-server-"));
    try {
      const file = join(dir, "rings.json");
      writeFileSync(file, JSON.stringify(base));
      expect(run([file, "publish-server", "0.8.0-rc.1"])).toBe("internal servers now offer 0.8.0-rc.1");
      expect(run([file, "promote-server", "preview", "0.8.0-rc.1", "100"])).toBe(
        "preview servers now offer 0.8.0-rc.1 to everyone",
      );
      expect(run([file, "promote", "preview", "0.8.0-rc.1", "100"])).toBe("preview now offers 0.8.0-rc.1 to everyone");
      expect(JSON.parse(readFileSync(file, "utf8")).server).toEqual({
        internal: { version: "0.8.0-rc.1" },
        preview: { version: "0.8.0-rc.1" },
      });
      // A refusal leaves the file as it was.
      const before = readFileSync(file, "utf8");
      expect(() => run([file, "promote", "stable", "0.8.0", "100"])).toThrow(/stable servers are offered nothing/);
      expect(() => run([file, "promote-desktop", "stable", "0.8.0", "100"])).toThrow(/usage/);
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("servers' stop switch (#878)", () => {
  const rings = { format: 1, rings: { internal: { version: "0.8.0" } }, server: { internal: { version: "0.8.0" } } };

  it("is true or absent, and only resume-servers lifts it", () => {
    for (const serverStop of [false, "true", 1, null])
      expect(() => validateRings({ ...rings, serverStop })).toThrow(/serverStop/);
    const stopped = stopServers(rings).rings;
    expect(stopped.serverStop).toBe(true);
    expect(rings.serverStop).toBeUndefined();
    expect(stopServers(stopped).rings.serverStop).toBe(true);
    // Publication and promotion leave the switch as it is.
    expect(publish(stopped, "0.8.1", "server").rings.serverStop).toBe(true);
    expect(resumeServers(stopped).rings).toEqual(rings);
    expect(() => resumeServers(rings)).toThrow(/servers are not stopped/);
  });

  it("runs through the CLI and leaves the file untouched on a refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-rings-stop-"));
    try {
      const file = join(dir, "rings.json");
      writeFileSync(file, JSON.stringify(rings));
      const before = readFileSync(file, "utf8");
      expect(() => run([file, "resume-servers"])).toThrow(/not stopped/);
      expect(() => run([file, "stop-servers", "now"])).toThrow(/usage/);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(run([file, "stop-servers"])).toMatch(/^servers stopped/);
      expect(JSON.parse(readFileSync(file, "utf8")).serverStop).toBe(true);
      expect(run([file, "resume-servers"])).toMatch(/^servers resumed/);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(rings);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
