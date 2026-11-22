/** feed-watchdog.js: the scheduled outside-in check of the live feed (#863, item 6). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canaryMapDigest,
  channelProblems,
  latestRecord,
  offerProblem,
  parseChannel,
  watch,
} from "../deploy/feed-watchdog.js";

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
    calls.push({ href, auth: init.headers?.Authorization, method: init.method ?? "GET" });
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
    if (files[name] === undefined) return reply(404);
    if (init.method === "HEAD")
      return new Response(null, { status: 200, headers: { "Content-Length": String(files[name].length) } });
    return reply(200, files[name]);
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
      "no recorded ring state: a 404 cannot be told from an empty ring; only servers-first is checked",
      "internal x64: 0.7.1-rc.1, served bytes match the published release",
      "stable x64: 0.7.0, served bytes match the published release",
      "internal server: nothing offered yet",
      "stable server: nothing offered yet",
    ]);
  });

  it("downloads each installer once, and sends tokens only to the feed", async () => {
    const w = world({ offers: { internal: "0.7.0", stable: "0.7.0" } });
    expect((await run(w)).problems).toEqual([]);
    const installer = w.calls.filter((c) => c.href.endsWith("ORCA-0.7.0-win-x64.exe"));
    // One full download, and a HEAD with the other ring's own token.
    expect(installer.map((c) => c.method)).toEqual(["GET", "HEAD"]);
    expect(new Set(installer.map((c) => c.auth)).size).toBe(2);
    for (const call of w.calls.filter((c) => c.href.startsWith("https://api.github.com/")))
      expect(call.auth ?? "").not.toMatch(/i{43}|s{43}/);
  });

  it("fails when a second ring cannot reach an installer another ring downloaded", async () => {
    const w = world({ offers: { internal: "0.7.0", stable: "0.7.0" } });
    const fetch = async (url, init) =>
      init?.method === "HEAD" ? new Response(null, { status: 404 }) : w.fetch(url, init);
    const { problems } = await run({ fetch });
    expect(problems).toContain("stable x64: HEAD ORCA-0.7.0-win-x64.exe got 404, length null");
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
    expect(problems).toContain(
      "stable x64: ORCA-0.7.0-win-x64.exe does not match the channel file's files[0] size and sha512",
    );
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
  const good = () => parseChannel(yml("0.7.0", "x64", "abc"));

  it("reads files[] as the updater does, and the legacy fields", () => {
    expect(good()).toEqual({
      version: "0.7.0",
      files: [{ url: "ORCA-0.7.0-win-x64.exe", sha512: sha512("abc"), size: "3" }],
      path: "ORCA-0.7.0-win-x64.exe",
      sha512: sha512("abc"),
      releaseDate: "2026-11-21T00:00:00.000Z",
    });
    expect(channelProblems("stable", "x64", good())).toEqual([]);
  });

  it.each([
    ["files[0] names another installer", (c) => (c.files[0].url = "ORCA-0.6.0-win-x64.exe"), /files\[0\] ORCA-0\.6\.0/],
    ["files[0] has another digest", (c) => (c.files[0].sha512 = sha512("other")), /legacy path\/sha512 disagree/],
    ["the legacy path points elsewhere", (c) => (c.path = "ORCA-0.6.0-win-x64.exe"), /legacy path\/sha512 disagree/],
    ["files[0] has no size", (c) => delete c.files[0].size, /no valid size/],
    ["files[0] requires admin", (c) => (c.files[0].isAdminRightsRequired = "true"), /requires admin rights/],
    ["two installers", (c) => c.files.push({ ...c.files[0] }), /names 2 installers/],
    ["no files[]", (c) => delete c.files, /names 0 installers/],
  ])("refuses a channel file where %s", (_label, change, message) => {
    const channel = good();
    change(channel);
    expect(channelProblems("stable", "x64", channel).join("\n")).toMatch(message);
  });

  it.each([
    ["an unknown key", "version: 0.7.0\nchannel: beta\n"],
    ["a nested list", "version: 0.7.0\nfiles:\n  - url: a\n      deep: x\n"],
    ["a flow value", "version: [0.7.0]\n"],
  ])("does not parse %s", (_label, text) => {
    expect(() => parseChannel(text)).toThrow();
  });

  it("fails the run when the served bytes disagree with files[0], even if the legacy fields agree", async () => {
    const w = world({ offers: { stable: "0.7.0" } });
    const fetch = async (url, init) => {
      const response = await w.fetch(url, init);
      if (!String(url).endsWith("latest-x64.yml") || response.status !== 200) return response;
      const text = (await response.text()).replace(/^( {4}sha512: ).*$/m, `$1${sha512("other")}`);
      return new Response(text, { status: 200 });
    };
    const { problems } = await run({ fetch });
    expect(problems).toContain("stable latest-x64.yml: legacy path/sha512 disagree with files[0]");
  });

  it("fails the run when the served installer has another size than files[0]", async () => {
    const w = world({ offers: { stable: "0.7.0" } });
    const fetch = async (url, init) => {
      const response = await w.fetch(url, init);
      if (!String(url).endsWith("latest-x64.yml") || response.status !== 200) return response;
      return new Response((await response.text()).replace(/size: \d+/, "size: 999"), { status: 200 });
    };
    const { problems } = await run({ fetch });
    expect(problems).toContain(
      "stable x64: ORCA-0.7.0-win-x64.exe does not match the channel file's files[0] size and sha512",
    );
  });

  it.each([
    ["0.7.1-dryrun.3", "unexpected version"],
    ["0.7.1-beta.1", "unexpected version"],
  ])("refuses the version %s", (version, message) => {
    const channel = parseChannel(yml(version, "x64", "x"));
    expect(channelProblems("internal", "x64", channel).join()).toContain(message);
  });

  it("refuses an installer for another architecture", () => {
    const channel = parseChannel(yml("0.7.0", "arm64", "x"));
    expect(channelProblems("stable", "x64", channel).join()).toContain("is not x64's installer");
  });
});

describe("feed-watchdog.yml", () => {
  const text = readFileSync(".github/workflows/feed-watchdog.yml", "utf8");

  it("is read-only, scheduled, and skipped until the feed is configured", () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(text).toContain("schedule:");
    // Canary tokens are read only by reviewed main, from their own environment, which holds
    // no write credential.
    expect(text).toContain("if: github.ref == 'refs/heads/main' && vars.ORCA_FEED_URL != ''");
    expect(text).toContain("environment: feed-canary");
    expect(text).not.toMatch(/desktop-feed|ORCA_FEED_ACCESS_KEY|ORCA_FEED_SECRET/);
    expect(text).toContain("FEED_CANARY_TOKENS: ${{ secrets.ORCA_FEED_CANARY_TOKENS }}");
    expect(text).toContain("run: node tools/deploy/feed-watchdog.js");
  });
});

const VECTOR = "5d3f25569a9aa339f4cd723849053e73975eef8b2ff42a2cf3cc8a2daf8e1a16";

describe("canaryMapDigest", () => {
  const b64 = (byte) => Buffer.alloc(32, byte).toString("base64url");
  const FULL = { internal: b64(1), preview: b64(2), stable: b64(255) };

  it("hashes the canonical { sha256(token): { ring } } map with sorted hashes", () => {
    const hash = (t) => createHash("sha256").update(t).digest("hex");
    const map = Object.fromEntries(
      Object.entries(FULL)
        .map(([ring, token]) => [hash(token), { ring }])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    expect(canaryMapDigest(FULL)).toBe(createHash("sha256").update(JSON.stringify(map)).digest("hex"));
    expect(canaryMapDigest({ stable: FULL.stable, internal: FULL.internal, preview: FULL.preview })).toBe(
      canaryMapDigest(FULL),
    );
  });

  it("matches a fixed vector shared with the Worker's registry tooling", () => {
    expect(canaryMapDigest(FULL)).toBe(VECTOR);
  });

  it("gives no digest for a missing, extra, duplicate or malformed canary", () => {
    expect(canaryMapDigest({ internal: FULL.internal, stable: FULL.stable })).toBeUndefined();
    expect(canaryMapDigest({ ...FULL, beta: b64(3) })).toBeUndefined();
    expect(canaryMapDigest({ ...FULL, preview: FULL.internal })).toBeUndefined();
    expect(canaryMapDigest({ ...FULL, stable: "short" })).toBeUndefined();
    expect(canaryMapDigest({ ...FULL, stable: 42 })).toBeUndefined();
    expect(canaryMapDigest(undefined)).toBeUndefined();
  });
});

describe("server bundle channel (#877)", () => {
  const SHA = "c".repeat(40);
  const hex = (text) => createHash("sha256").update(text).digest("hex");
  const stem = (version) => `orca-server-${version}-linux-x64`;
  const serverFiles = (version) => ({
    [`server/${stem(version)}.tar.xz`]: `archive ${version}`,
    [`server/${stem(version)}.manifest.json`]: `manifest ${version}`,
    [`server/${stem(version)}.manifest.json.sigstore.json`]: `signature ${version}`,
  });
  const channel = (version, files = serverFiles(version)) => {
    const [archive, manifest, signature] = Object.values(files);
    return [
      `version: ${version}`,
      "platform: linux-x64",
      `sourceSha: ${SHA}`,
      `archive: ${stem(version)}.tar.xz`,
      `archiveSha256: ${hex(archive)}`,
      `archiveSize: ${archive.length}`,
      `manifest: ${stem(version)}.manifest.json`,
      `manifestSha256: ${hex(manifest)}`,
      `manifestSize: ${manifest.length}`,
      `signature: ${stem(version)}.manifest.json.sigstore.json`,
      `signatureSha256: ${hex(signature)}`,
      `signatureSize: ${signature.length}`,
      "",
    ].join("\n");
  };
  const release = (version, files = serverFiles(version)) => ({
    draft: false,
    published_at: "x",
    assets: Object.entries(files).map(([path, body]) => ({ name: path.slice("server/".length), digest: sha256(body) })),
  });

  /** The desktop world, plus a server channel: `servers` maps ring to version. */
  function serverWorld({ servers, files, releases, text, anonymous = 401 } = {}) {
    const offered = servers ?? { internal: "0.8.0-rc.1", stable: "0.8.0" };
    const bodies = { ...serverFiles("0.8.0-rc.1"), ...serverFiles("0.8.0"), ...files };
    const base = world({
      offers: {},
      releases: releases ?? { "0.8.0-rc.1": release("0.8.0-rc.1"), "0.8.0": release("0.8.0") },
    });
    const fetch = async (url, init = {}) => {
      const name = new URL(String(url)).pathname.slice(1);
      if (String(url).startsWith("https://api.github.com/") || !name.startsWith("server/"))
        return base.fetch(url, init);
      base.calls.push({ href: String(url), auth: init.headers?.Authorization, method: init.method ?? "GET" });
      const auth = init.headers?.Authorization;
      if (!auth) return new Response(null, { status: anonymous });
      const ring = Object.keys(TOKENS).find((r) => auth === `Bearer ${TOKENS[r]}`);
      if (name === "server/latest-linux-x64.yml")
        return offered[ring]
          ? new Response(text?.(offered[ring]) ?? channel(offered[ring]), { status: 200 })
          : new Response(null, { status: 404 });
      if (bodies[name] === undefined) return new Response(null, { status: 404 });
      if (init.method === "HEAD")
        return new Response(null, { status: 200, headers: { "Content-Length": String(bodies[name].length) } });
      return new Response(bodies[name], { status: 200 });
    };
    return { fetch, calls: base.calls };
  }

  it("passes a healthy server channel and downloads each file once", async () => {
    const w = serverWorld({ servers: { internal: "0.8.0", stable: "0.8.0" } });
    const { problems, report } = await run(w);
    expect(problems).toEqual([]);
    expect(report.filter((line) => / server: /.test(line))).toEqual([
      "internal server: 0.8.0, served bytes match the published release",
      "stable server: 0.8.0, served bytes match the published release",
    ]);
    const archive = w.calls.filter((c) => c.href.endsWith(".tar.xz"));
    expect(archive.map((c) => c.method)).toEqual(["GET", "HEAD"]);
  });

  it("fails when the server channel answers without a token", async () => {
    const { problems } = await run(serverWorld({ anonymous: 200 }));
    expect(problems).toContain("a server channel request without a token got 200, not 401");
  });

  it("fails when stable servers are offered a prerelease", async () => {
    const { problems } = await run(serverWorld({ servers: { stable: "0.8.0-rc.1" } }));
    expect(problems).toContain("stable server/latest-linux-x64.yml: stable offers the prerelease 0.8.0-rc.1");
  });

  it("fails on a channel file this feed does not write", async () => {
    const { problems } = await run(
      serverWorld({ text: (v) => channel(v).replace("platform: linux-x64", "platform: x") }),
    );
    expect(problems.join("\n")).toMatch(/internal server\/latest-linux-x64\.yml: not a server channel file/);
  });

  it("fails when a served file is not the release's asset, or not the listed bytes", async () => {
    const releases = {
      "0.8.0-rc.1": release("0.8.0-rc.1", {
        ...serverFiles("0.8.0-rc.1"),
        [`server/${stem("0.8.0-rc.1")}.tar.xz`]: "x",
      }),
    };
    const { problems } = await run(serverWorld({ servers: { internal: "0.8.0-rc.1" }, releases }));
    expect(problems.join("\n")).toContain(
      `internal server: ${stem("0.8.0-rc.1")}.tar.xz is not release v0.8.0-rc.1's asset`,
    );
    const swapped = { [`server/${stem("0.8.0")}.manifest.json`]: "manifest tampered" };
    const tampered = await run(
      serverWorld({ servers: { stable: "0.8.0" }, files: swapped, text: () => channel("0.8.0") }),
    );
    expect(tampered.problems).toContain(
      `stable server: server/${stem("0.8.0")}.manifest.json does not match the channel file's size and sha256`,
    );
  });

  it("fails when a ring is offered a server version with no published release", async () => {
    const { problems } = await run(serverWorld({ servers: { internal: "0.8.0" }, releases: {} }));
    expect(problems).toContain("internal server: 0.8.0 has no published GitHub release");
  });

  describe("against the recorded ring state", () => {
    // The desktop world offers internal 0.7.1-rc.1 and stable 0.7.0 on x64.
    const desktop = { internal: { version: "0.7.1-rc.1" }, stable: { version: "0.7.0" } };
    const both = (servers) => {
      const d = world();
      const s = serverWorld({ servers });
      // Server paths and the 0.8 releases come from the server world, the rest from the desktop one.
      const server = (url) => new URL(String(url)).pathname.startsWith("/server/") || String(url).includes("/tags/v0.8");
      return { fetch: (url, init) => (server(url) ? s.fetch(url, init) : d.fetch(url, init)) };
    };

    it("passes when every ring is offered exactly what was recorded, an empty ring included", async () => {
      const record = { format: 1, rings: desktop, server: { internal: { version: "0.8.0-rc.1" } } };
      const { problems, report } = await run(both({ internal: "0.8.0-rc.1" }), { record });
      expect(problems).toEqual([]);
      expect(report).toContain("stable server: nothing offered (none recorded)");
      expect(report.join("\n")).not.toContain("no recorded ring state");
    });

    it("fails on a 404 where the record has an offer, on either channel", async () => {
      const record = {
        format: 1,
        rings: { ...desktop, preview: { version: "0.7.0" } },
        server: { internal: { version: "0.8.0-rc.1" }, stable: { version: "0.8.0" } },
      };
      const { problems } = await run(both({ internal: "0.8.0-rc.1" }), {
        record,
        tokens: { ...TOKENS },
      });
      expect(problems).toContain(
        "stable server/latest-linux-x64.yml: got 404, but the recorded ring state offers 0.8.0",
      );
      const missingDesktop = await run(
        {
          fetch: (url, init) =>
            String(url).endsWith("latest-x64.yml") && init.headers?.Authorization
              ? new Response(null, { status: 404 })
              : both({}).fetch(url, init),
        },
        { record: { format: 1, rings: desktop } },
      );
      expect(missingDesktop.problems).toContain(
        "internal latest-x64.yml: got 404, but the recorded ring state offers 0.7.1-rc.1",
      );
    });

    it("fails on an offer the record does not name, and accepts the rollout version", async () => {
      const rolling = {
        format: 1,
        rings: desktop,
        server: { internal: { version: "0.8.0-rc.1", rollout: { version: "0.8.0", percent: 10 } } },
      };
      expect((await run(both({ internal: "0.8.0" }), { record: rolling })).problems).toEqual([]);
      const stale = { format: 1, rings: desktop, server: { internal: { version: "0.8.0" } } };
      expect((await run(both({ internal: "0.8.0-rc.1" }), { record: stale })).problems).toContain(
        "internal server/latest-linux-x64.yml: offers 0.8.0-rc.1, but the recorded ring state offers 0.8.0",
      );
      const none = { format: 1, rings: desktop };
      expect((await run(both({ internal: "0.8.0-rc.1" }), { record: none })).problems).toContain(
        "internal server/latest-linux-x64.yml: offers 0.8.0-rc.1, but the recorded ring state offers nothing",
      );
    });

    it("refuses a record that is not a valid ring state", async () => {
      await expect(run(both({}), { record: { format: 1, rings: {}, server: { nightly: {} } } })).rejects.toThrow();
    });

    it("holds servers first without a record: desktops on a server-era version need servers on it", async () => {
      const d = world({
        offers: { internal: "0.8.0" },
        bodies: { "ORCA-0.8.0-win-x64.exe": "eight" },
        releases: {
          "0.8.0": {
            draft: false,
            published_at: "x",
            assets: [{ name: "ORCA-0.8.0-win-x64.exe", digest: sha256("eight") }, ...release("0.8.0").assets],
          },
          "0.8.0-rc.1": release("0.8.0-rc.1"),
        },
      });
      const servers = (offered) => {
        const s = serverWorld({ servers: offered });
        return {
          fetch: (url, init) =>
            new URL(String(url)).pathname.startsWith("/server/") ? s.fetch(url, init) : d.fetch(url, init),
        };
      };
      expect((await run(servers({}))).problems).toContain(
        "internal server/latest-linux-x64.yml: got 404, but internal's desktops are offered 0.8.0 (servers first)",
      );
      expect((await run(servers({ internal: "0.8.0-rc.1" }))).problems).toContain(
        "internal server/latest-linux-x64.yml: offers 0.8.0-rc.1, older than the 0.8.0 internal's desktops are offered (servers first)",
      );
      expect((await run(servers({ internal: "0.8.0" }))).problems).toEqual([]);
    });
  });
});

describe("offerProblem", () => {
  it("tells an expected-empty ring from an unexpected 404, and needs a record to judge", () => {
    expect(offerProblem("x", undefined, [], 404)).toBeNull();
    expect(offerProblem("x", {}, [], 404)).toBeNull();
    expect(offerProblem("x", {}, ["0.8.0"], 404)).toBe("x: got 404, but the recorded ring state offers 0.8.0");
    expect(offerProblem("x", {}, ["0.8.0", "0.8.1"], 200, "0.8.1")).toBeNull();
  });
});

describe("latestRecord", () => {
  const artifact = (id, name, run, created, branch = "main") => ({
    id,
    name,
    expired: false,
    created_at: created,
    workflow_run: { id: run, head_branch: branch },
  });
  const runs = {
    1: { id: 1, path: ".github/workflows/feed-promote.yml", head_branch: "main", event: "workflow_dispatch" },
    2: { id: 2, path: ".github/workflows/feed-publish.yml", head_branch: "main", event: "workflow_dispatch" },
    3: { id: 3, path: ".github/workflows/ci.yml", head_branch: "main", event: "workflow_dispatch" },
    4: { id: 4, path: ".github/workflows/feed-promote.yml", head_branch: "main", event: "pull_request" },
  };
  const api = (artifacts) => async (url) => {
    const path = String(url).replace("https://api.github.com/repos/o/r/", "");
    if (path.startsWith("actions/artifacts")) return new Response(JSON.stringify({ artifacts }), { status: 200 });
    const id = /^actions\/runs\/(\d+)$/.exec(path)?.[1];
    return runs[id] ? new Response(JSON.stringify(runs[id]), { status: 200 }) : new Response(null, { status: 404 });
  };

  it("takes the newest record kept by a main dispatch of the feed workflows", async () => {
    const fetch = api([
      artifact(10, "feed-rings-promote", 1, "2026-11-22T10:00:00Z"),
      artifact(11, "feed-rings-server", 2, "2026-11-22T11:00:00Z"),
      artifact(12, "feed-rings-promote", 3, "2026-11-22T12:00:00Z"),
      artifact(13, "feed-rings-promote", 4, "2026-11-22T13:00:00Z"),
      artifact(14, "feed-rings-promote", 1, "2026-11-22T14:00:00Z", "attacker"),
      artifact(15, "other", 2, "2026-11-22T15:00:00Z"),
      { ...artifact(16, "feed-rings-desktop", 2, "2026-11-22T16:00:00Z"), expired: true },
    ]);
    expect(await latestRecord({ repo: "o/r", fetch })).toEqual({ run: 2, name: "feed-rings-server" });
  });

  it("answers undefined without a record, and fails rather than guessing when GitHub does", async () => {
    expect(await latestRecord({ repo: "o/r", fetch: api([]) })).toBeUndefined();
    await expect(latestRecord({ repo: "o/r", fetch: async () => new Response(null, { status: 500 }) })).rejects.toThrow(
      /answered 500/,
    );
  });
});
