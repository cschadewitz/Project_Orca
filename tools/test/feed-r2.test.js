/** feed-r2.sh against a fake `aws` CLI: upload order, immutability, conditional ring writes. */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
if (process.env.FAKE_FAIL_OP === op) { process.stderr.write("An error occurred (InternalError) (500)\n"); process.exit(254); }
if (op === "put-object" && process.env.FAKE_PUT_LIMIT) {
  const counter = path.join(store, "..", "puts");
  const done = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  if (done >= Number(process.env.FAKE_PUT_LIMIT)) { process.stderr.write("Connection was closed\n"); process.exit(255); }
  fs.writeFileSync(counter, String(done + 1));
}
const file = path.join(store, encodeURIComponent(opt("--key")));
const etag = () => '"' + crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex") + '"';
const fail = (code) => { process.stderr.write("An error occurred (" + code + ")\n"); process.exit(254); };
if (op === "head-object") {
  if (!fs.existsSync(file)) fail("404");
  if (opt("--query") === "LastModified") console.log(fs.statSync(file).mtime.toISOString().replace(/\.\d+Z$/, "+00:00"));
  process.exit(0);
}
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
  const runWith = (extra, ...args) =>
    spawnSync("bash", ["tools/deploy/feed-r2.sh", ...args], { env: { ...env, ...extra }, encoding: "utf8" });
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
  return { run, runWith, object, log, release, artifacts, root };
}

describe.skipIf(process.platform === "win32")("feed-r2.sh", () => {
  it("uploads payload before metadata, then offers the version to internal", () => {
    const f = setup();
    f.release("0.7.1-rc.1", "prerelease");
    const result = f.run("snapshot", f.artifacts, "0.7.1-rc.1", "x64 arm64");
    expect(result.status, result.stderr).toBe(0);
    const puts = f.log().filter((a) => a[3] === "put-object");
    const keys = puts.map((a) => a[a.indexOf("--key") + 1]);
    expect(keys.slice(0, 4).every((k) => /\.exe(\.blockmap)?$/.test(k))).toBe(true);
    expect(keys.slice(4, 6)).toEqual(["0.7.1-rc.1/prerelease-x64.yml", "0.7.1-rc.1/prerelease-arm64.yml"]);
    expect(keys[6]).toBe("0.7.1-rc.1/complete.json");
    expect(keys[7]).toBe("rings.json");
    expect(puts[4]).toContain("--if-none-match");
    expect(puts[7]).toContain("--if-none-match");
    expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8"))).toEqual({
      format: 1,
      rings: { internal: { version: "0.7.1-rc.1" } },
    });
    expect(readFileSync(join(f.root, "summary"), "utf8")).toContain("internal now offers 0.7.1-rc.1");
  });

  it("serves only x64 when asked, leaving the arm64 installer and channel file out", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    const result = f.run("snapshot", f.artifacts, "0.7.0", "x64");
    expect(result.status, result.stderr).toBe(0);
    const keys = f
      .log()
      .filter((a) => a[3] === "put-object")
      .map((a) => a[a.indexOf("--key") + 1]);
    expect(keys).toEqual([
      "0.7.0/ORCA-0.7.0-win-x64.exe",
      "0.7.0/ORCA-0.7.0-win-x64.exe.blockmap",
      "0.7.0/latest-x64.yml",
      "0.7.0/complete.json",
      "rings.json",
    ]);
    expect(keys.some((k) => k.includes("arm64"))).toBe(false);
  });

  it("refuses a snapshot without an explicit, known architecture list", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0").stderr).toContain("usage");
    for (const arches of ["arm64", "arm64 x64", "x64 x64", "", "x86"]) {
      expect(f.run("snapshot", f.artifacts, "0.7.0", arches).stderr).toContain("ARCHES must be");
    }
    expect(existsSync(f.object("rings.json"))).toBe(false);
  });

  it("writes every object conditionally", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0", "x64 arm64").status).toBe(0);
    const puts = f.log().filter((a) => a[3] === "put-object");
    expect(puts).toHaveLength(8);
    expect(puts.every((a) => a.includes("--if-none-match") || a.includes("--if-match"))).toBe(true);
  });

  it("treats a rerun of identical bytes as a no-op and refuses different bytes", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0", "x64 arm64").status).toBe(0);
    const rings = readFileSync(f.object("rings.json"), "utf8");
    const again = f.run("snapshot", f.artifacts, "0.7.0", "x64 arm64");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("identical bytes");
    expect(readFileSync(f.object("rings.json"), "utf8")).toBe(rings);
    writeFileSync(join(f.artifacts, "ORCA-0.7.0-win-x64.exe"), "tampered");
    const changed = f.run("snapshot", f.artifacts, "0.7.0", "x64 arm64");
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain("already exists with different bytes");
    expect(readFileSync(f.object("0.7.0/ORCA-0.7.0-win-x64.exe"), "utf8")).toBe("exe 0.7.0 x64");
  });

  // 8 writes: 4 payload, 2 metadata, the completion record, rings.json. Interrupt before each.
  it.each([0, 1, 2, 3, 4, 5, 6, 7])("resumes after an interruption once %i objects were written", (written) => {
    const f = setup();
    f.release("0.7.1-rc.1", "prerelease");
    const cut = f.runWith({ FAKE_PUT_LIMIT: String(written) }, "snapshot", f.artifacts, "0.7.1-rc.1", "x64 arm64");
    expect(cut.status).not.toBe(0);
    expect(existsSync(f.object("rings.json"))).toBe(false);
    const resumed = f.run("snapshot", f.artifacts, "0.7.1-rc.1", "x64 arm64");
    expect(resumed.status, resumed.stderr).toBe(0);
    for (const arch of ["x64", "arm64"]) {
      expect(readFileSync(f.object(`0.7.1-rc.1/ORCA-0.7.1-rc.1-win-${arch}.exe`), "utf8")).toBe(
        `exe 0.7.1-rc.1 ${arch}`,
      );
      expect(existsSync(f.object(`0.7.1-rc.1/prerelease-${arch}.yml`))).toBe(true);
    }
    expect(JSON.parse(readFileSync(f.object("0.7.1-rc.1/complete.json"), "utf8"))).toEqual({
      format: 1,
      version: "0.7.1-rc.1",
    });
    expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8")).rings.internal).toEqual({
      version: "0.7.1-rc.1",
    });
  });

  it("stops on a lookup or write error instead of reading it as absence", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    const head = f.runWith({ FAKE_FAIL_OP: "head-object" }, "promote", "stable", "0.7.0", "100");
    expect(head.status).not.toBe(0);
    expect(head.stderr).toContain("could not look up");
    const put = f.runWith({ FAKE_FAIL_OP: "put-object" }, "snapshot", f.artifacts, "0.7.0", "x64 arm64");
    expect(put.status).not.toBe(0);
    expect(put.stderr).toContain("could not write");
    const get = f.runWith({ FAKE_FAIL_OP: "get-object" }, "promote", "stable", "0.7.0", "100");
    expect(get.status).not.toBe(0);
  });

  it("promotes only complete snapshots and writes rings.json conditionally", () => {
    const f = setup();
    expect(f.run("promote", "stable", "0.7.0", "100").stderr).toContain("no complete feed snapshot");
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0", "x64 arm64").status).toBe(0);
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
    expect(f.run("snapshot", f.artifacts, "0.7.0", "x64 arm64").stderr).toContain("missing ORCA-0.7.0-win-x64.exe");
    expect(f.run("snapshot", f.artifacts, "v0.7.0", "x64 arm64").stderr).toContain("invalid version");
    expect(existsSync(f.object("rings.json"))).toBe(false);
    const bad = spawnSync("bash", ["tools/deploy/feed-r2.sh", "promote", "stable", "0.7.0", "100"], {
      env: { ...process.env, FEED_ACCOUNT_ID: "nope", FEED_BUCKET: "orca-feed" },
      encoding: "utf8",
    });
    expect(bad.stderr).toContain("FEED_ACCOUNT_ID");
  });

  it("schedules the promotions that are due for internal's version, once", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0", "x64").status).toBe(0);
    const completed = Math.floor(statSync(f.object("0.7.0/complete.json")).mtimeMs / 1000);
    const at = (hours) => f.runWith({ FEED_NOW: String(completed + hours * 3600 + 60) }, "schedule");
    const rings = () => JSON.parse(readFileSync(f.object("rings.json"), "utf8")).rings;

    expect(at(1).status).toBe(0);
    expect(rings().preview).toBeUndefined();
    expect(at(49).status).toBe(0);
    expect(rings().preview).toEqual({ version: "0.7.0" });
    expect(rings().stable).toEqual({ rollout: { version: "0.7.0", percent: 20 } });
    const again = at(49);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("nothing due");
    expect(at(97).status).toBe(0);
    expect(rings().stable).toEqual({ version: "0.7.0" });
  });

  it("stops the schedule for good once a rollout of the version is halted", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0", "x64").status).toBe(0);
    expect(f.run("promote", "stable", "0.7.0", "20").status).toBe(0);
    const halt = f.run("promote", "stable", "0.7.0", "0");
    expect(halt.status, halt.stderr).toBe(0);
    expect(existsSync(f.object("0.7.0/halted.json"))).toBe(true);
    const later = f.runWith({ FEED_NOW: String(Math.floor(Date.now() / 1000) + 500 * 3600) }, "schedule");
    expect(later.status, later.stderr).toBe(0);
    expect(later.stdout).toContain("halted=1");
    expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8")).rings.stable).toEqual({});
  });

  it("schedules nothing before anything is fed", () => {
    const f = setup();
    const result = f.run("schedule");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No rings yet");
  });

  it("parses as bash", () => {
    expect(() => execFileSync("bash", ["-n", "tools/deploy/feed-r2.sh"])).not.toThrow();
  });
});
