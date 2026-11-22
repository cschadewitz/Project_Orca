/** feed-local.js: the feed Worker's own handler over a directory, for the Windows update test (#863, item 5). */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { directoryBucket, feedServer, snapshot, writeRings } from "../deploy/feed-local.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const TOKENS = { internal: "i".repeat(43), preview: "p".repeat(43) };

let root;
let server;
let base;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "feed-local-"));
  const files = mkdtempSync(join(tmpdir(), "feed-files-"));
  for (const version of ["99.0.0", "99.0.1"]) {
    const exe = join(files, `ORCA-${version}-win-x64.exe`);
    writeFileSync(exe, `installer ${version}`);
    writeFileSync(`${exe}.blockmap`, `map ${version}`);
    const yml = join(files, `latest-x64-${version}.yml`);
    writeFileSync(yml, `version: ${version}\n`);
    snapshot(join(root, "bucket"), version, [exe, `${exe}.blockmap`]);
    writeFileSync(join(root, "bucket", version, "latest-x64.yml"), `version: ${version}\n`);
  }
  writeRings(join(root, "bucket"), {
    format: 1,
    rings: { internal: { version: "99.0.1" }, preview: { version: "99.0.0" } },
  });
  const tokens = JSON.stringify(
    Object.fromEntries(Object.entries(TOKENS).map(([ring, token]) => [sha(token), { ring }])),
  );
  server = feedServer({ root: join(root, "bucket"), tokens });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const get = (name, ring, headers = {}) =>
  fetch(new URL(name, base), {
    headers: { ...(ring ? { Authorization: `Bearer ${TOKENS[ring]}` } : {}), ...headers },
  });

describe("local feed", () => {
  it("refuses a request without a token, as the Worker does", async () => {
    const response = await get("latest-x64.yml");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("offers each ring its own version", async () => {
    expect(await (await get("latest-x64.yml", "internal")).text()).toBe("version: 99.0.1\n");
    expect(await (await get("latest-x64.yml", "preview")).text()).toBe("version: 99.0.0\n");
  });

  it("serves installers and blockmaps whole and by range", async () => {
    expect(await (await get("ORCA-99.0.1-win-x64.exe", "preview")).text()).toBe("installer 99.0.1");
    const range = await get("ORCA-99.0.0-win-x64.exe", "internal", { Range: "bytes=0-8" });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 0-8/16");
    expect(await range.text()).toBe("installer");
    expect(await (await get("ORCA-99.0.0-win-x64.exe.blockmap", "internal")).text()).toBe("map 99.0.0");
  });

  it("marks a snapshot complete the way feed-r2.sh does, and validates rings", () => {
    expect(JSON.parse(readFileSync(join(root, "bucket", "99.0.0", "complete.json"), "utf8"))).toEqual({
      format: 2,
      version: "99.0.0",
      arches: ["x64"],
    });
    expect(() => writeRings(root, { format: 1, rings: { stable: { version: "1.0.0-rc.1" } } })).toThrow(/prerelease/);
    expect(() => snapshot(root, "v1", [])).toThrow(/invalid version/);
  });

  it("never reads outside the bucket", async () => {
    const bucket = directoryBucket(join(root, "bucket"));
    writeFileSync(join(root, "outside"), "secret");
    expect(await bucket.head("../outside")).toBeUndefined();
    expect(await bucket.get("../outside")).toBeNull();
    expect(await bucket.head("missing/file")).toBeUndefined();
  });
});
