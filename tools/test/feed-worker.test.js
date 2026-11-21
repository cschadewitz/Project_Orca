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
    expect(e.FEED.calls.some(([op]) => op === "get")).toBe(false);
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

describe("parseRange", () => {
  it("reads the forms R2 can answer in one read", () => {
    expect(parseRange(null)).toBeUndefined();
    expect(parseRange("bytes=0-0")).toEqual({ offset: 0, length: 1 });
    expect(parseRange("bytes=5-")).toEqual({ offset: 5 });
    expect(parseRange("bytes=-5")).toEqual({ suffix: 5 });
    expect(parseRange("bytes=1-2,3-4")).toEqual({ multiple: true });
  });
});
