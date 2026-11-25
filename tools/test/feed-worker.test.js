/** The desktop feed Worker: token auth, ring resolution, rollouts, Range/HEAD, against a fake R2 bucket. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticate, handle, parseRange } from "../deploy/feed-worker/worker.js";
import { rolloutBucket } from "../deploy/feed-worker/rings.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const TOKENS = {
  internal: "i".repeat(43),
  preview: "p".repeat(43),
  stable: "s".repeat(43),
};

class FakeBucket {
  constructor(objects) {
    this.objects = new Map(Object.entries(objects).map(([k, v]) => [k, Buffer.from(v)]));
    this.calls = [];
  }
  async head(key) {
    this.calls.push(["head", key]);
    const data = this.objects.get(key);
    return data ? { size: data.length, httpEtag: `"${sha(data).slice(0, 8)}"` } : null;
  }
  async get(key, options = {}) {
    this.calls.push(["get", key, options.range]);
    const data = this.objects.get(key);
    if (!data) return null;
    const { offset = 0, length = data.length - offset } = options.range ?? {};
    const slice = data.subarray(offset, offset + length);
    return { body: new Uint8Array(slice), text: async () => slice.toString() };
  }
}

function env(rings, extra = {}) {
  const objects = {
    "0.7.0/latest-x64.yml": "version: 0.7.0\n",
    "0.7.0/complete.json": '{"format":1,"version":"0.7.0"}',
    "0.7.1-rc.1/complete.json": '{"format":1,"version":"0.7.1-rc.1"}',
    "0.7.0/ORCA-0.7.0-win-x64.exe": "0123456789",
    "0.7.0/ORCA-0.7.0-win-x64.exe.blockmap": "old-map",
    "0.7.1-rc.1/prerelease-x64.yml": "version: 0.7.1-rc.1\n",
    "0.7.1-rc.1/ORCA-0.7.1-rc.1-win-x64.exe": "abcdefghij",
    ...extra,
  };
  if (rings) objects["rings.json"] = JSON.stringify(rings);
  const tokens = Object.fromEntries(Object.entries(TOKENS).map(([ring, token]) => [sha(token), { ring }]));
  return { FEED: new FakeBucket(objects), FEED_TOKENS: JSON.stringify(tokens) };
}

const RINGS = {
  format: 1,
  rings: {
    internal: { version: "0.7.1-rc.1" },
    preview: { version: "0.7.0" },
    stable: { version: "0.7.0" },
  },
};

function get(path, { token, method = "GET", headers = {} } = {}) {
  const h = new Headers(headers);
  if (token) h.set("Authorization", `Bearer ${token}`);
  return new Request(`https://updates.example${path}`, { method, headers: h });
}

describe("authentication", () => {
  it.each([
    ["no header", undefined],
    ["an unknown token", "u".repeat(43)],
    ["a short token", "abc"],
  ])("refuses %s with 401 on every path and method", async (_label, token) => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      for (const path of ["/latest-x64.yml", "/ORCA-0.7.0-win-x64.exe", "/rings.json", "/"]) {
        const response = await handle(get(path, { token, method }), env(RINGS));
        expect(response.status).toBe(401);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    }
  });

  it("refuses a scheme other than Bearer and a token whose ring is unknown", async () => {
    const e = env(RINGS);
    const basic = new Request("https://updates.example/latest-x64.yml", {
      headers: { Authorization: `Basic ${TOKENS.stable}` },
    });
    expect((await handle(basic, e)).status).toBe(401);
    const odd = "o".repeat(43);
    const tokens = { [sha(odd)]: { ring: "nightly" } };
    expect(await authenticate(get("/", { token: odd }), tokens)).toBeUndefined();
  });

  it("does not trust inherited keys of the token map", async () => {
    expect(await authenticate(get("/", { token: "constructor".padEnd(40, "x") }), {})).toBeUndefined();
  });

  it("answers 503 when the token secret is not JSON", async () => {
    const e = { ...env(RINGS), FEED_TOKENS: "{" };
    expect((await handle(get("/latest-x64.yml", { token: TOKENS.stable }), e)).status).toBe(503);
  });

  it("allows only GET and HEAD once authenticated", async () => {
    const response = await handle(get("/latest-x64.yml", { token: TOKENS.stable, method: "POST" }), env(RINGS));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("channel resolution", () => {
  it("serves each ring its own version, ignoring the client's cache-busting query", async () => {
    const e = env(RINGS);
    const stable = await handle(get("/latest-x64.yml?noCache=1abc", { token: TOKENS.stable }), e);
    expect(stable.status).toBe(200);
    expect(await stable.text()).toBe("version: 0.7.0\n");
    expect(stable.headers.get("Content-Type")).toMatch(/^text\/yaml/);
    expect(stable.headers.get("Cache-Control")).toBe("no-store");
    // The rc snapshot only has prerelease-x64.yml; the internal ring still gets it as latest.
    const internal = await handle(get("/latest-x64.yml", { token: TOKENS.internal }), e);
    expect(await internal.text()).toBe("version: 0.7.1-rc.1\n");
  });

  it("answers 404 when the ring offers nothing, the arch has no metadata, or rings.json is missing", async () => {
    const empty = { format: 1, rings: { internal: { version: "0.7.0" } } };
    expect((await handle(get("/latest-x64.yml", { token: TOKENS.stable }), env(empty))).status).toBe(404);
    expect((await handle(get("/latest-arm64.yml", { token: TOKENS.stable }), env(RINGS))).status).toBe(404);
    expect((await handle(get("/latest-x64.yml", { token: TOKENS.stable }), env(undefined))).status).toBe(404);
  });

  it("answers 503 rather than guessing when rings.json is invalid", async () => {
    const bad = { format: 1, rings: { stable: { version: "0.7.1-rc.1" } } };
    expect((await handle(get("/latest-x64.yml", { token: TOKENS.stable }), env(bad))).status).toBe(503);
  });

  it("offers a rollout exactly to the tokens whose stable bucket is under the percentage", async () => {
    const hash = sha(TOKENS.preview);
    const bucket = await rolloutBucket(hash, "0.7.1-rc.1");
    const at = (percent) => ({
      format: 1,
      rings: { preview: { version: "0.7.0", rollout: { version: "0.7.1-rc.1", percent } } },
    });
    if (bucket < 99) {
      const inside = await handle(get("/latest-x64.yml", { token: TOKENS.preview }), env(at(bucket + 1)));
      expect(await inside.text()).toBe("version: 0.7.1-rc.1\n");
    }
    if (bucket > 0) {
      const outside = await handle(get("/latest-x64.yml", { token: TOKENS.preview }), env(at(bucket)));
      expect(await outside.text()).toBe("version: 0.7.0\n");
    }
  });

  it("refuses nested paths and names that are not feed files", async () => {
    for (const path of ["/rings.json", "/0.7.0/latest-x64.yml", "/prerelease-x64.yml", "/latest-ia32.yml", "/x.exe"]) {
      expect((await handle(get(path, { token: TOKENS.internal }), env(RINGS))).status).toBe(404);
    }
  });
});

describe("payload files", () => {
  it("serves installers under either side of the Orrery rename, and no other name", async () => {
    // rename-keep-start: both names on purpose
    const e = env(RINGS, {
      "0.7.0/ORCA-0.7.0-win-x64.exe": "0123456789",
      "0.7.0/Orrery-0.7.0-win-x64.exe": "renamed!!!",
      "0.7.0/Kepler-0.7.0-win-x64.exe": "other",
    });
    for (const [path, body] of [
      ["/ORCA-0.7.0-win-x64.exe", "0123456789"],
      ["/Orrery-0.7.0-win-x64.exe", "renamed!!!"],
    ])
      expect(await (await handle(get(path, { token: TOKENS.stable }), e)).text()).toBe(body);
    expect((await handle(get("/Kepler-0.7.0-win-x64.exe", { token: TOKENS.stable }), e)).status).toBe(404);
    // rename-keep-end
  });

  it("serves installers and old blockmaps by the version in their name, with HEAD", async () => {
    const e = env(RINGS);
    const whole = await handle(get("/ORCA-0.7.0-win-x64.exe", { token: TOKENS.stable }), e);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
    expect(whole.headers.get("Content-Length")).toBe("10");
    expect(await whole.text()).toBe("0123456789");
    const map = await handle(get("/ORCA-0.7.0-win-x64.exe.blockmap", { token: TOKENS.internal }), e);
    expect(await map.text()).toBe("old-map");
    const head = await handle(get("/ORCA-0.7.0-win-x64.exe", { token: TOKENS.stable, method: "HEAD" }), e);
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("10");
    expect(await head.text()).toBe("");
    expect((await handle(get("/ORCA-9.9.9-win-x64.exe", { token: TOKENS.stable }), e)).status).toBe(404);
  });

  it.each([
    ["bytes=2-4", 206, "234", "bytes 2-4/10"],
    ["bytes=7-", 206, "789", "bytes 7-9/10"],
    ["bytes=-3", 206, "789", "bytes 7-9/10"],
    ["bytes=8-99", 206, "89", "bytes 8-9/10"],
    ["bytes=-99", 206, "0123456789", "bytes 0-9/10"],
  ])("answers %s with one range", async (range, status, body, contentRange) => {
    const response = await handle(
      get("/ORCA-0.7.0-win-x64.exe", { token: TOKENS.stable, headers: { Range: range } }),
      env(RINGS),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    expect(await response.text()).toBe(body);
  });

  it("answers HEAD with a range without reading the object", async () => {
    const e = env(RINGS);
    const response = await handle(
      get("/ORCA-0.7.0-win-x64.exe", { token: TOKENS.stable, method: "HEAD", headers: { Range: "bytes=0-1" } }),
      e,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-1/10");
    expect(e.FEED.calls.some(([op, key]) => op === "get" && key.endsWith(".exe"))).toBe(false);
  });

  it.each(["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1, 4-5", "items=0-1", "bytes=-"])(
    "answers %s with 416 so the updater falls back to a full download",
    async (range) => {
      const response = await handle(
        get("/ORCA-0.7.0-win-x64.exe", { token: TOKENS.stable, headers: { Range: range } }),
        env(RINGS),
      );
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */10");
    },
  );
});

describe("snapshot completion", () => {
  it("serves nothing of a snapshot until its completion record exists", async () => {
    const partial = {
      "0.8.0/latest-x64.yml": "version: 0.8.0\n",
      "0.8.0/ORCA-0.8.0-win-x64.exe": "partial",
      "0.8.0/ORCA-0.8.0-win-x64.exe.blockmap": "partial-map",
    };
    const rings = { format: 1, rings: { internal: { version: "0.8.0" } } };
    const e = env(rings, partial);
    for (const path of ["/latest-x64.yml", "/ORCA-0.8.0-win-x64.exe", "/ORCA-0.8.0-win-x64.exe.blockmap"]) {
      expect((await handle(get(path, { token: TOKENS.internal }), e)).status).toBe(404);
    }
    const done = env(rings, { ...partial, "0.8.0/complete.json": "{}" });
    expect((await handle(get("/ORCA-0.8.0-win-x64.exe", { token: TOKENS.internal }), done)).status).toBe(200);
    // Completed historical snapshots stay reachable for differential downloads.
    expect((await handle(get("/ORCA-0.7.0-win-x64.exe.blockmap", { token: TOKENS.internal }), done)).status).toBe(200);
  });
});

describe("served architectures", () => {
  // Snapshots holding arm64 objects. Only a completion record that lists arm64 (feed-r2.sh
  // writes one for a release whose arm64 installer passed native acceptance, #889) serves them.
  const ARM_OBJECTS = {
    "0.7.0/latest-arm64.yml": "version: 0.7.0\n",
    "0.7.0/ORCA-0.7.0-win-arm64.exe": "armarmarm0",
    "0.7.0/ORCA-0.7.0-win-arm64.exe.blockmap": "arm-map",
    "0.7.1-rc.1/prerelease-arm64.yml": "version: 0.7.1-rc.1\n",
    "0.7.1-rc.1/ORCA-0.7.1-rc.1-win-arm64.exe": "armarmarm1",
  };
  const BOTH = {
    ...ARM_OBJECTS,
    "0.7.0/complete.json": '{"format":2,"version":"0.7.0","arches":["x64","arm64"]}',
    "0.7.1-rc.1/complete.json": '{"format":2,"version":"0.7.1-rc.1","arches":["x64","arm64"]}',
  };
  const ARM_PATHS = [
    ["/latest-arm64.yml", TOKENS.stable],
    ["/latest-arm64.yml", TOKENS.internal],
    ["/ORCA-0.7.0-win-arm64.exe", TOKENS.stable],
    ["/ORCA-0.7.0-win-arm64.exe.blockmap", TOKENS.stable],
    ["/ORCA-0.7.1-rc.1-win-arm64.exe", TOKENS.internal],
  ];

  it("can serve x64 and arm64", async () => {
    const { SERVED_ARCHES } = await import("../deploy/feed-worker/worker.js");
    expect(SERVED_ARCHES).toEqual(["x64", "arm64"]);
  });

  it("serves arm64 channel files, installers and blockmaps of snapshots published with arm64", async () => {
    const e = env(RINGS, BOTH);
    expect(await (await handle(get("/latest-arm64.yml", { token: TOKENS.stable }), e)).text()).toBe("version: 0.7.0\n");
    // The rc snapshot only has prerelease-arm64.yml; the internal ring still gets it as latest.
    expect(await (await handle(get("/latest-arm64.yml", { token: TOKENS.internal }), e)).text()).toBe(
      "version: 0.7.1-rc.1\n",
    );
    expect(await (await handle(get("/ORCA-0.7.0-win-arm64.exe", { token: TOKENS.stable }), e)).text()).toBe(
      "armarmarm0",
    );
    const map = await handle(get("/ORCA-0.7.0-win-arm64.exe.blockmap", { token: TOKENS.internal }), e);
    expect(map.status).toBe(200);
    expect(await map.text()).toBe("arm-map");
    const range = await handle(
      get("/ORCA-0.7.0-win-arm64.exe", { token: TOKENS.stable, method: "HEAD", headers: { Range: "bytes=0-1" } }),
      e,
    );
    expect(range.status).toBe(206);
  });

  it.each([
    ["a legacy record (format 1, no list)", {}],
    [
      "an x64-only list",
      {
        "0.7.0/complete.json": '{"format":2,"version":"0.7.0","arches":["x64"]}',
        "0.7.1-rc.1/complete.json": '{"format":2,"version":"0.7.1-rc.1","arches":["x64"]}',
      },
    ],
  ])("serves no arm64 object, not even directly, from a snapshot with %s, and keeps x64", async (_label, records) => {
    for (const method of ["GET", "HEAD"]) {
      for (const [path, token] of ARM_PATHS) {
        const e = env(RINGS, { ...ARM_OBJECTS, ...records });
        const response = await handle(get(path, { token, method }), e);
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(e.FEED.calls.filter(([, key]) => !key.endsWith("complete.json") && key !== "rings.json")).toEqual([]);
      }
    }
    const e = env(RINGS, { ...ARM_OBJECTS, ...records });
    expect(await (await handle(get("/latest-x64.yml", { token: TOKENS.stable }), e)).text()).toBe("version: 0.7.0\n");
    expect(await (await handle(get("/ORCA-0.7.0-win-x64.exe", { token: TOKENS.stable }), e)).text()).toBe("0123456789");
    expect((await handle(get("/ORCA-0.7.0-win-x64.exe.blockmap", { token: TOKENS.internal }), e)).status).toBe(200);
  });

  it("answers 404 for any other architecture without reading the bucket", async () => {
    for (const path of ["/latest-ia32.yml", "/latest-arm.yml", "/ORCA-0.7.0-win-ia32.exe", "/ORCA-0.7.0-win-arm.exe"]) {
      const e = env(RINGS, BOTH);
      const response = await handle(get(path, { token: TOKENS.stable }), e);
      expect(response.status, path).toBe(404);
      expect(e.FEED.calls).toEqual([]);
    }
  });
});

describe("snapshotArches", () => {
  it.each([
    ['{"format":1,"version":"1.0.0"}', ["x64"]],
    ["{}", ["x64"]],
    ['{"format":2,"version":"1.0.0","arches":["x64"]}', ["x64"]],
    ['{"format":2,"version":"1.0.0","arches":["x64","arm64"]}', ["x64", "arm64"]],
    ['{"format":2,"version":"1.0.0"}', undefined],
    ['{"format":2,"version":"1.0.0","arches":["arm64"]}', ["arm64"]],
    ['{"format":2,"version":"1.0.0","arches":[]}', undefined],
    ['{"format":2,"version":"1.0.0","arches":["x64","x64"]}', undefined],
    ['{"format":2,"version":"1.0.0","arches":["x64","ia32"]}', undefined],
    ['{"format":2,"version":"1.0.1","arches":["x64"]}', undefined],
    ['{"format":1,"version":"1.0.0","arches":["x64","arm64"]}', undefined],
    ["not json", undefined],
    ["[]", undefined],
  ])("reads %s as %j", async (text, arches) => {
    const { snapshotArches } = await import("../deploy/feed-worker/worker.js");
    expect(snapshotArches(text, "1.0.0")).toEqual(arches);
  });
});

describe("parseRange", () => {
  it("reads the forms R2 can answer in one read", () => {
    expect(parseRange(null)).toBeUndefined();
    expect(parseRange("bytes=0-0")).toEqual({ offset: 0, length: 1 });
    expect(parseRange("bytes=5-")).toEqual({ offset: 5 });
    expect(parseRange("bytes=-5")).toEqual({ suffix: 5 });
    expect(parseRange("bytes=1-2,3-4")).toEqual({ multiple: true });
  });
});

describe("server bundle channel (#877)", () => {
  const SERVER_TOKEN = "q".repeat(43);
  const files = (version) => {
    const stem = `orca-server-${version}-linux-x64`;
    return {
      [`server/${version}/${stem}.tar.xz`]: `archive ${version} bytes`,
      [`server/${version}/${stem}.manifest.json`]: `{"version":"${version}"}`,
      [`server/${version}/${stem}.manifest.json.sigstore.json`]: "{}",
      [`server/${version}/latest-linux-x64.yml`]: `version: ${version}\n`,
      [`server/${version}/complete.json`]: JSON.stringify({ format: 1, version, platform: "linux-x64" }),
    };
  };
  const SERVER_RINGS = {
    ...RINGS,
    server: {
      internal: { version: "0.8.0-rc.2" },
      preview: { version: "0.8.0-rc.1" },
    },
  };
  const serverEnv = (rings = SERVER_RINGS, extra = {}) => {
    const e = env(rings, { ...files("0.8.0-rc.1"), ...files("0.8.0-rc.2"), ...extra });
    const tokens = JSON.parse(e.FEED_TOKENS);
    tokens[sha(SERVER_TOKEN)] = { ring: "preview", channel: "server" };
    return { ...e, FEED_TOKENS: JSON.stringify(tokens) };
  };

  it("resolves each ring's server version, for any token of that ring", async () => {
    const e = serverEnv();
    for (const [token, version] of [
      [TOKENS.internal, "0.8.0-rc.2"],
      [TOKENS.preview, "0.8.0-rc.1"],
      [SERVER_TOKEN, "0.8.0-rc.1"],
    ]) {
      const response = await handle(get("/server/latest-linux-x64.yml?x=1", { token }), e);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/yaml; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe(`version: ${version}\n`);
    }
    // Stable has no server version yet; a rings.json from before the channel has no `server`.
    expect((await handle(get("/server/latest-linux-x64.yml", { token: TOKENS.stable }), e)).status).toBe(404);
    expect(
      (await handle(get("/server/latest-linux-x64.yml", { token: TOKENS.internal }), serverEnv(RINGS))).status,
    ).toBe(404);
  });

  it("applies a server rollout per token, independently of the desktop channel", async () => {
    const percent = 50;
    const rings = {
      ...SERVER_RINGS,
      server: { preview: { version: "0.8.0-rc.1", rollout: { version: "0.8.0-rc.2", percent } } },
    };
    const e = serverEnv(rings);
    for (const token of [TOKENS.preview, SERVER_TOKEN]) {
      const inRollout = (await rolloutBucket(sha(token), "0.8.0-rc.2")) < percent;
      const response = await handle(get("/server/latest-linux-x64.yml", { token }), e);
      expect(await response.text()).toBe(`version: ${inRollout ? "0.8.0-rc.2" : "0.8.0-rc.1"}\n`);
    }
    // The desktop channel of the same ring is untouched.
    expect(await (await handle(get("/latest-x64.yml", { token: TOKENS.preview }), e)).text()).toBe("version: 0.7.0\n");
  });

  it("serves the bundle, manifest and signature by the version in their name, with HEAD and Range", async () => {
    const e = serverEnv();
    const stem = "/server/orca-server-0.8.0-rc.1-linux-x64";
    const archive = await handle(get(`${stem}.tar.xz`, { token: SERVER_TOKEN }), e);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await archive.text()).toBe("archive 0.8.0-rc.1 bytes");
    const manifest = await handle(get(`${stem}.manifest.json`, { token: SERVER_TOKEN }), e);
    expect(manifest.headers.get("Content-Type")).toBe("application/json");
    expect(await manifest.text()).toBe('{"version":"0.8.0-rc.1"}');
    expect((await handle(get(`${stem}.manifest.json.sigstore.json`, { token: SERVER_TOKEN }), e)).status).toBe(200);
    const head = await handle(get(`${stem}.tar.xz`, { token: SERVER_TOKEN, method: "HEAD" }), e);
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("24");
    expect(head.body).toBeNull();
    const range = await handle(get(`${stem}.tar.xz`, { token: TOKENS.stable, headers: { Range: "bytes=0-6" } }), e);
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Range")).toBe("bytes 0-6/24");
    expect(await range.text()).toBe("archive");
    const rangeHead = await handle(
      get(`${stem}.tar.xz`, { token: SERVER_TOKEN, method: "HEAD", headers: { Range: "bytes=-5" } }),
      e,
    );
    expect(rangeHead.status).toBe(206);
    expect(rangeHead.headers.get("Content-Range")).toBe("bytes 19-23/24");
  });

  it("serves nothing of a server snapshot until its own completion record is exactly right", async () => {
    const version = "0.8.0-rc.1";
    for (const record of [
      undefined,
      "{}",
      '{"format":1,"version":"0.8.0-rc.2","platform":"linux-x64"}',
      '{"format":1,"version":"0.8.0-rc.1","platform":"linux-arm64"}',
      '{"format":2,"version":"0.8.0-rc.1","platform":"linux-x64"}',
      '{"format":1,"version":"0.8.0-rc.1","platform":"linux-x64","extra":1}',
      "not json",
    ]) {
      const e = serverEnv();
      if (record === undefined) e.FEED.objects.delete(`server/${version}/complete.json`);
      else e.FEED.objects.set(`server/${version}/complete.json`, Buffer.from(record));
      expect((await handle(get("/server/latest-linux-x64.yml", { token: SERVER_TOKEN }), e)).status).toBe(404);
      expect(
        (await handle(get(`/server/orca-server-${version}-linux-x64.tar.xz`, { token: SERVER_TOKEN }), e)).status,
      ).toBe(404);
    }
    // The desktop completion record never stands in for the server one.
    const e = serverEnv(SERVER_RINGS, { [`${version}/complete.json`]: `{"format":1,"version":"${version}"}` });
    e.FEED.objects.delete(`server/${version}/complete.json`);
    expect(
      (await handle(get(`/server/orca-server-${version}-linux-x64.tar.xz`, { token: SERVER_TOKEN }), e)).status,
    ).toBe(404);
  });

  it("keeps a server-only token out of the desktop channel", async () => {
    const e = serverEnv();
    for (const path of ["/latest-x64.yml", "/ORCA-0.7.0-win-x64.exe", "/ORCA-0.7.0-win-x64.exe.blockmap"])
      expect((await handle(get(path, { token: SERVER_TOKEN }), e)).status).toBe(404);
    // A desktop token of the same ring still reads it.
    expect((await handle(get("/latest-x64.yml", { token: TOKENS.preview }), e)).status).toBe(200);
  });

  it("refuses a token entry naming any other channel, and anonymous server requests", async () => {
    const e = serverEnv();
    const tokens = JSON.parse(e.FEED_TOKENS);
    tokens[sha("r".repeat(43))] = { ring: "preview", channel: "desktop" };
    const odd = { ...e, FEED_TOKENS: JSON.stringify(tokens) };
    for (const path of ["/server/latest-linux-x64.yml", "/latest-x64.yml"])
      expect((await handle(get(path, { token: "r".repeat(43) }), odd)).status).toBe(401);
    const anonymous = await handle(get("/server/latest-linux-x64.yml"), e);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toBe('Bearer realm="orca-feed"');
    expect((await handle(get("/server/latest-linux-x64.yml", { token: SERVER_TOKEN, method: "POST" }), e)).status).toBe(
      405,
    );
    expect(await authenticate(get("/", { token: SERVER_TOKEN }), JSON.parse(e.FEED_TOKENS))).toEqual({
      hash: sha(SERVER_TOKEN),
      ring: "preview",
      serverOnly: true,
    });
  });

  it("refuses other server paths and other platforms", async () => {
    const e = serverEnv();
    for (const path of [
      "/server/latest-linux-arm64.yml",
      "/server/orca-server-0.8.0-rc.1-linux-arm64.tar.xz",
      "/server/0.8.0-rc.1/complete.json",
      "/server/orca-server-0.8.0-rc.1-linux-x64.zip",
      "/server/rings.json",
      "/server/server/latest-linux-x64.yml",
      "/server/orca-server-0.8.0-..-linux-x64.tar.xz",
    ])
      expect((await handle(get(path, { token: TOKENS.internal }), e)).status, path).toBe(404);
  });

  it("answers 503 for an invalid server ring rather than guessing", async () => {
    const e = serverEnv({ ...RINGS, server: { nightly: { version: "0.8.0" } } });
    expect((await handle(get("/server/latest-linux-x64.yml", { token: TOKENS.internal }), e)).status).toBe(503);
  });
  it("answers every server's channel file 503 with the stop header while serverStop is set (#878)", async () => {
    const e = serverEnv({ ...SERVER_RINGS, serverStop: true });
    for (const token of [TOKENS.internal, TOKENS.preview, TOKENS.stable, SERVER_TOKEN]) {
      const response = await handle(get("/server/latest-linux-x64.yml", { token }), e);
      expect(response.status).toBe(503);
      // Both names, for one release: servers on either side of the Orrery rename stop.
      expect(response.headers.get("X-Orca-Feed-Stop")).toBe("servers"); // rename-keep: the old name, on purpose
      expect(response.headers.get("X-Orrery-Feed-Stop")).toBe("servers");
      expect(response.headers.get("Retry-After")).toBe("3600");
    }
    // Still only for authenticated callers, and the desktop channel is untouched.
    expect((await handle(get("/server/latest-linux-x64.yml"), e)).status).toBe(401);
    const desktop = await handle(get("/latest-x64.yml", { token: TOKENS.preview }), e);
    expect(desktop.status).toBe(200);
    expect(desktop.headers.get("X-Orca-Feed-Stop")).toBeNull();
    // Without the switch, nothing carries the header.
    const served = await handle(get("/server/latest-linux-x64.yml", { token: TOKENS.internal }), serverEnv());
    expect(served.headers.get("X-Orca-Feed-Stop")).toBeNull();
  });
});
