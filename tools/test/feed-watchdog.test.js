/** feed-watchdog.js: the scheduled outside-in check of the live feed (#863, item 6). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { channelProblems, parseChannel, watch } from "../deploy/feed-watchdog.js";

const TOKENS = { internal: "i".repeat(43), stable: "s".repeat(43) };
const sha512 = (text) => createHash("sha512").update(text).digest("base64");
const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const yml = (version, arch, body) =>
  `version: ${version}\nfiles:\n  - url: ORCA-${version}-win-${arch}.exe\n    sha512: ${sha512(body)}\n    size: ${body.length}\npath: ORCA-${version}-win-${arch}.exe\nsha512: ${sha512(body)}\nreleaseDate: '2026-11-21T00:00:00.000Z'\n`;

/** A fake feed and GitHub API. `offers` maps ring to version; `bodies` maps file to bytes. */
function world({ offers = { internal: "0.7.1-rc.1", stable: "0.7.0" }, bodies = {}, releases, anonymous = 401 } = {}) {
  const files = {
    "ORCA-0.7.0-win-x64.exe": "seven-oh",
    "ORCA-0.7.1-rc.1-win-x64.exe": "seven-one-rc",
    ...bodies,
  };
  const published = releases ?? {
    "0.7.0": {
      draft: false,
      published_at: "x",
      assets: [{ name: "ORCA-0.7.0-win-x64.exe", digest: sha256("seven-oh") }],
    },
    "0.7.1-rc.1": {
      draft: false,
      published_at: "x",
      assets: [{ name: "ORCA-0.7.1-rc.1-win-x64.exe", digest: sha256("seven-one-rc") }],
    },
  };
  const calls = [];
  const fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, auth: init.headers?.Authorization });
    const reply = (status, body = "") => new Response(status === 200 ? body : null, { status });
    if (href.startsWith("https://api.github.com/")) {
      const version = /releases\/tags\/v(.+)$/.exec(href)?.[1];
      return published[version] ? reply(200, JSON.stringify(published[version])) : reply(404);
    }
    const auth = init.headers?.Authorization;
    if (!auth) return reply(anonymous);
    const ring = Object.keys(TOKENS).find((r) => auth === `Bearer ${TOKENS[r]}`);
    const name = new URL(href).pathname.slice(1);
    const channel = /^latest-(x64|arm64)\.yml$/.exec(name);
    if (channel) {
      if (channel[1] !== "x64" || !offers[ring]) return reply(404);
      const version = offers[ring];
      return reply(200, yml(version, "x64", files[`ORCA-${version}-win-x64.exe`] ?? ""));
    }
    return files[name] === undefined ? reply(404) : reply(200, files[name]);
  };
  return { fetch, calls };
}

const run = (w, extra = {}) =>
  watch({ url: "https://feed.example", tokens: TOKENS, repo: "o/r", fetch: w.fetch, served: ["x64"], ...extra });

describe("feed watchdog", () => {
  it("passes a healthy feed and reports each ring", async () => {
    const { problems, report } = await run(world());
    expect(problems).toEqual([]);
    expect(report).toEqual([
      "internal x64: 0.7.1-rc.1, served bytes match the published release",
      "stable x64: 0.7.0, served bytes match the published release",
    ]);
  });

  it("downloads each installer once, and sends tokens only to the feed", async () => {
    const w = world({ offers: { internal: "0.7.0", stable: "0.7.0" } });
    expect((await run(w)).problems).toEqual([]);
    expect(w.calls.filter((c) => c.href.endsWith("ORCA-0.7.0-win-x64.exe"))).toHaveLength(1);
    for (const call of w.calls.filter((c) => c.href.startsWith("https://api.github.com/")))
      expect(call.auth ?? "").not.toMatch(/i{43}|s{43}/);
  });

  it("fails when the feed answers without a token", async () => {
    expect((await run(world({ anonymous: 200 }))).problems).toContain("a request without a token got 200, not 401");
  });

  it("fails when an unserved architecture is served", async () => {
    const { problems } = await run(world(), { served: [] });
    expect(problems).toContain("internal latest-x64.yml: x64 is not served but got 200");
  });

  it("fails when stable offers a prerelease", async () => {
    const { problems } = await run(world({ offers: { stable: "0.7.1-rc.1" } }));
    expect(problems).toContain("stable latest-x64.yml: stable offers the prerelease 0.7.1-rc.1");
  });

  it("fails when a ring is offered a version with no published release", async () => {
    const releases = { "0.7.0": { draft: true, published_at: null, assets: [] } };
    const { problems } = await run(world({ offers: { stable: "0.7.0" }, releases }));
    expect(problems).toContain("stable x64: 0.7.0 has no published GitHub release");
  });

  it("fails when the served installer does not match the release asset", async () => {
    const releases = {
      "0.7.0": {
        draft: false,
        published_at: "x",
        assets: [{ name: "ORCA-0.7.0-win-x64.exe", digest: sha256("other") }],
      },
    };
    const { problems } = await run(world({ offers: { stable: "0.7.0" }, releases }));
    expect(problems).toContain("stable x64: ORCA-0.7.0-win-x64.exe differs from the published release asset");
  });

  it("fails when the served installer does not match its channel file", async () => {
    const w = world({ offers: { stable: "0.7.0" } });
    const fetch = async (url, init) => {
      if (String(url).endsWith(".exe")) return new Response("tampered", { status: 200 });
      return w.fetch(url, init);
    };
    const { problems } = await run({ fetch });
    expect(problems).toContain("stable x64: ORCA-0.7.0-win-x64.exe does not match the channel file's sha512");
  });

  it("reports a ring that is offered nothing yet without failing", async () => {
    const { problems, report } = await run(world({ offers: { internal: "0.7.0" } }));
    expect(problems).toEqual([]);
    expect(report).toContain("stable x64: nothing offered yet");
  });

  it("refuses an empty or unknown canary list", async () => {
    expect((await run(world(), { tokens: {} })).problems).toContain(
      "no canary tokens: set FEED_CANARY_TOKENS for at least one ring",
    );
    expect((await run(world(), { tokens: { ...TOKENS, beta: "b".repeat(43) } })).problems).toContain(
      "canary token for unknown ring beta",
    );
  });
});

describe("channel files", () => {
  it("reads the fields the client uses", () => {
    expect(parseChannel(yml("0.7.0", "x64", "abc"))).toEqual({
      version: "0.7.0",
      path: "ORCA-0.7.0-win-x64.exe",
      sha512: sha512("abc"),
    });
  });

  it.each([
    ["0.7.1-dryrun.3", "unexpected version"],
    ["0.7.1-beta.1", "unexpected version"],
  ])("refuses the version %s", (version, message) => {
    const channel = { version, path: `ORCA-${version}-win-x64.exe`, sha512: sha512("x") };
    expect(channelProblems("internal", "x64", channel).join()).toContain(message);
  });

  it("refuses a path for another architecture", () => {
    const channel = { version: "0.7.0", path: "ORCA-0.7.0-win-arm64.exe", sha512: sha512("x") };
    expect(channelProblems("stable", "x64", channel).join()).toContain("is not x64's installer");
  });
});

describe("feed-watchdog.yml", () => {
  const text = readFileSync(".github/workflows/feed-watchdog.yml", "utf8");

  it("is read-only, scheduled, and skipped until the feed is configured", () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(text).toContain("schedule:");
    expect(text).toContain("if: vars.ORCA_FEED_URL != ''");
    expect(text).not.toMatch(/environment: desktop-feed|ORCA_FEED_ACCESS_KEY|ORCA_FEED_SECRET/);
    expect(text).toContain("FEED_CANARY_TOKENS: ${{ secrets.ORCA_FEED_CANARY_TOKENS }}");
    expect(text).toContain("run: node tools/deploy/feed-watchdog.js");
  });
});
