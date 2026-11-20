/** feed-r2.sh against a fake `aws` CLI: upload order, immutability, conditional ring writes. */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// A stand-in for `aws s3api` that keeps objects as files and honours If-Match/If-None-Match.
const FAKE_AWS = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const store = process.env.FAKE_S3;
fs.appendFileSync(path.join(store, "..", "log"), JSON.stringify(args) + "\n");
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const op = args[3];
const file = path.join(store, encodeURIComponent(opt("--key")));
const etag = () => '"' + crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex") + '"';
const fail = (code) => { process.stderr.write("An error occurred (" + code + ")\n"); process.exit(254); };
if (op === "head-object") { if (!fs.existsSync(file)) fail("404"); process.exit(0); }
if (op === "get-object") {
  if (!fs.existsSync(file)) fail("NoSuchKey");
  fs.copyFileSync(file, args[args.length - 1]);
  console.log(etag());
  process.exit(0);
}
if (op === "put-object") {
  if (opt("--if-none-match") === "*" && fs.existsSync(file)) fail("PreconditionFailed");
  const match = opt("--if-match");
  if (match && (!fs.existsSync(file) || etag() !== match)) fail("PreconditionFailed");
  fs.copyFileSync(opt("--body"), file);
  process.exit(0);
}
fail("Unsupported");
`;

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "orca-feed-r2-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const store = join(root, "store");
  const artifacts = join(root, "artifacts");
  for (const d of [bin, store, artifacts]) mkdirSync(d);
  writeFileSync(join(bin, "aws"), FAKE_AWS);
  chmodSync(join(bin, "aws"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_S3: store,
    FEED_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    FEED_BUCKET: "orca-feed",
    GITHUB_STEP_SUMMARY: join(root, "summary"),
  };
  const run = (...args) => spawnSync("bash", ["tools/deploy/feed-r2.sh", ...args], { env, encoding: "utf8" });
  const object = (key) => join(store, encodeURIComponent(key));
  const log = () =>
    readFileSync(join(root, "log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const release = (version, channel) => {
    for (const arch of ["x64", "arm64"]) {
      writeFileSync(join(artifacts, `ORCA-${version}-win-${arch}.exe`), `exe ${version} ${arch}`);
      writeFileSync(join(artifacts, `ORCA-${version}-win-${arch}.exe.blockmap`), `map ${version} ${arch}`);
      writeFileSync(join(artifacts, `${channel}-${arch}.yml`), `version: ${version}\n`);
    }
  };
  return { run, object, log, release, artifacts, root };
}

describe.skipIf(process.platform === "win32")("feed-r2.sh", () => {
  it("uploads payload before metadata, then offers the version to internal", () => {
    const f = setup();
    f.release("0.7.1-rc.1", "prerelease");
    const result = f.run("snapshot", f.artifacts, "0.7.1-rc.1");
    expect(result.status, result.stderr).toBe(0);
    const puts = f.log().filter((a) => a[3] === "put-object");
    const keys = puts.map((a) => a[a.indexOf("--key") + 1]);
    expect(keys.slice(0, 4).every((k) => /\.exe(\.blockmap)?$/.test(k))).toBe(true);
    expect(keys.slice(4, 6)).toEqual(["0.7.1-rc.1/prerelease-x64.yml", "0.7.1-rc.1/prerelease-arm64.yml"]);
    expect(keys[6]).toBe("rings.json");
    expect(puts[4]).toContain("--if-none-match");
    expect(puts[6]).toContain("--if-none-match");
    expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8"))).toEqual({
      format: 1,
      rings: { internal: { version: "0.7.1-rc.1" } },
    });
    expect(readFileSync(join(f.root, "summary"), "utf8")).toContain("internal now offers 0.7.1-rc.1");
  });

  it("refuses to republish a complete snapshot and leaves the rings alone", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0").status).toBe(0);
    const rings = readFileSync(f.object("rings.json"), "utf8");
    const again = f.run("snapshot", f.artifacts, "0.7.0");
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("already exists");
    expect(readFileSync(f.object("rings.json"), "utf8")).toBe(rings);
  });

  it("promotes only complete snapshots and writes rings.json conditionally", () => {
    const f = setup();
    expect(f.run("promote", "stable", "0.7.0", "100").stderr).toContain("no complete feed snapshot");
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0").status).toBe(0);
    const promoted = f.run("promote", "stable", "0.7.0", "100");
    expect(promoted.status, promoted.stderr).toBe(0);
    const last = f.log().at(-1);
    expect(last).toContain("--if-match");
    expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8")).rings.stable).toEqual({ version: "0.7.0" });
    const backwards = f.run("promote", "stable", "0.7.0", "100");
    expect(backwards.status).not.toBe(0);
    expect(backwards.stderr).toContain("never move backwards");
  });

  it("refuses missing files, bad versions and bad configuration before writing anything", () => {
    const f = setup();
    expect(f.run("snapshot", f.artifacts, "0.7.0").stderr).toContain("missing ORCA-0.7.0-win-x64.exe");
    expect(f.run("snapshot", f.artifacts, "v0.7.0").stderr).toContain("invalid version");
    expect(existsSync(f.object("rings.json"))).toBe(false);
    const bad = spawnSync("bash", ["tools/deploy/feed-r2.sh", "promote", "stable", "0.7.0", "100"], {
      env: { ...process.env, FEED_ACCOUNT_ID: "nope", FEED_BUCKET: "orca-feed" },
      encoding: "utf8",
    });
    expect(bad.stderr).toContain("FEED_ACCOUNT_ID");
  });

  it("parses as bash", () => {
    expect(() => execFileSync("bash", ["-n", "tools/deploy/feed-r2.sh"])).not.toThrow();
  });
});
