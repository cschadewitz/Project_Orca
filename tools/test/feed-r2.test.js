/** feed-r2.sh against a fake `aws` CLI: upload order, immutability, conditional ring writes. */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ringState, watch } from "../deploy/feed-watchdog.js";

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
if (op === "delete-object") { if (fs.existsSync(file)) fs.rmSync(file); process.exit(0); }
if (op === "head-object") { if (!fs.existsSync(file)) fail("404"); process.exit(0); }
if (op === "get-object") {
  if (!fs.existsSync(file)) fail("NoSuchKey");
  fs.copyFileSync(file, args[args.length - 1]);
  console.log(etag());
  process.exit(0);
}
if (op === "put-object") {
  // FAKE_RACE names a file holding a rings.json another writer stores just before this put.
  if (opt("--key") === "rings.json" && process.env.FAKE_RACE && fs.existsSync(process.env.FAKE_RACE)) {
    fs.copyFileSync(process.env.FAKE_RACE, file);
    fs.rmSync(process.env.FAKE_RACE);
  }
  // FAKE_IGNORE_CONDITIONS stands for a store that silently ignores conditional headers.
  if (!process.env.FAKE_IGNORE_CONDITIONS) {
    if (opt("--if-none-match") === "*" && fs.existsSync(file)) fail("PreconditionFailed");
    const match = opt("--if-match");
    if (match && (!fs.existsSync(file) || etag() !== match)) fail("PreconditionFailed");
  }
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
  return { run, runWith, object, log, release, artifacts, root, env };
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
      format: 2,
      version: "0.7.1-rc.1",
      arches: ["x64", "arm64"],
    });
    expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8")).rings.internal).toEqual({
      version: "0.7.1-rc.1",
    });
  });

  // A first publish by the pre-#889 script wrote a format 1 completion record and stopped
  // before the ring update. The retry runs the current script.
  const legacySnapshot = (f, version) => {
    f.release(version, "latest");
    for (const name of [`ORCA-${version}-win-x64.exe`, `ORCA-${version}-win-x64.exe.blockmap`, "latest-x64.yml"]) {
      writeFileSync(f.object(`${version}/${name}`), readFileSync(join(f.artifacts, name)));
    }
    writeFileSync(f.object(`${version}/complete.json`), `{"format":1,"version":"${version}"}\n`);
  };

  it("finishes an interrupted legacy x64 publish, keeping its completion record", () => {
    const f = setup();
    legacySnapshot(f, "0.7.0");
    const resumed = f.run("snapshot", f.artifacts, "0.7.0", "x64");
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("legacy x64 record");
    expect(readFileSync(f.object("0.7.0/complete.json"), "utf8")).toBe('{"format":1,"version":"0.7.0"}\n');
    const keys = f
      .log()
      .filter((a) => a[3] === "put-object")
      .map((a) => a[a.indexOf("--key") + 1]);
    expect(keys).not.toContain("0.7.0/complete.json");
    expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8")).rings.internal).toEqual({ version: "0.7.0" });
  });

  it("never extends a legacy x64 snapshot to arm64", () => {
    const f = setup();
    legacySnapshot(f, "0.7.0");
    const result = f.run("snapshot", f.artifacts, "0.7.0", "x64 arm64");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot be extended to arm64");
    expect(existsSync(f.object("0.7.0/ORCA-0.7.0-win-arm64.exe"))).toBe(false);
    expect(existsSync(f.object("0.7.0/latest-arm64.yml"))).toBe(false);
    expect(existsSync(f.object("rings.json"))).toBe(false);
    expect(readFileSync(f.object("0.7.0/complete.json"), "utf8")).toBe('{"format":1,"version":"0.7.0"}\n');
  });

  it("refuses a completion record that is neither this snapshot's nor the legacy one", () => {
    const f = setup();
    legacySnapshot(f, "0.7.0");
    writeFileSync(f.object("0.7.0/complete.json"), '{"format":1,"version":"0.6.9"}\n');
    const result = f.run("snapshot", f.artifacts, "0.7.0", "x64");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already exists with different bytes");
    expect(existsSync(f.object("rings.json"))).toBe(false);
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

  it("re-reads and reapplies a ring change when another writer got there first", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0", "x64").status).toBe(0);
    const race = join(f.root, "race.json");
    writeFileSync(
      race,
      JSON.stringify({ format: 1, rings: { internal: { version: "0.7.0" }, preview: { version: "0.7.0" } } }),
    );
    const result = f.runWith({ FAKE_RACE: race }, "promote", "stable", "0.7.0", "100");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("retrying");
    expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8")).rings).toEqual({
      internal: { version: "0.7.0" },
      preview: { version: "0.7.0" },
      stable: { version: "0.7.0" },
    });
  });

  it("sets and lifts the servers' stop switch conditionally, keeping the rings (#878)", () => {
    const f = setup();
    f.release("0.7.0", "latest");
    expect(f.run("snapshot", f.artifacts, "0.7.0", "x64").status).toBe(0);
    const stopped = f.run("stop-servers");
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("servers stopped");
    expect(f.log().at(-1)).toContain("--if-match");
    const rings = JSON.parse(readFileSync(f.object("rings.json"), "utf8"));
    expect(rings).toEqual({ format: 1, rings: { internal: { version: "0.7.0" } }, serverStop: true });
    expect(f.run("stop-servers", "now").stderr).toContain("usage: feed-r2.sh stop-servers");
    expect(f.run("resume-servers").status).toBe(0);
    expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8"))).toEqual({
      format: 1,
      rings: { internal: { version: "0.7.0" } },
    });
    const again = f.run("resume-servers");
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("servers are not stopped");
  });

  it("proves conditional writes on a throwaway key, and stops when they are ignored", () => {
    const f = setup();
    const ok = f.run("probe");
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("R2 honours If-None-Match and If-Match.");
    expect(readdirSync(join(f.root, "store"))).toEqual([]);
    const ignored = f.runWith({ FAKE_IGNORE_CONDITIONS: "1" }, "probe");
    expect(ignored.status).not.toBe(0);
    expect(ignored.stderr).toContain("R2 accepted a write whose condition");
    expect(readdirSync(join(f.root, "store"))).toEqual([]);
  });

  describe("server bundle snapshots (#877)", () => {
    const VERSION = "0.8.0-rc.1";
    const STEM = `orca-server-${VERSION}-linux-x64`;
    const bundle = (f) => {
      const dir = join(f.root, "server");
      mkdirSync(dir, { recursive: true });
      for (const name of [`${STEM}.tar.xz`, `${STEM}.manifest.json`, `${STEM}.manifest.json.sigstore.json`])
        writeFileSync(join(dir, name), `${name} bytes`);
      writeFileSync(join(dir, "latest-linux-x64.yml"), `version: ${VERSION}\n`);
      return dir;
    };

    it("uploads the bundle, then its channel file, then its completion record, then offers it to internal servers", () => {
      const f = setup();
      const result = f.run("server-snapshot", bundle(f), VERSION);
      expect(result.status, result.stderr).toBe(0);
      const puts = f
        .log()
        .filter((a) => a[3] === "put-object")
        .map((a) => a[a.indexOf("--key") + 1]);
      expect(puts).toEqual([
        `server/${VERSION}/${STEM}.tar.xz`,
        `server/${VERSION}/${STEM}.manifest.json`,
        `server/${VERSION}/${STEM}.manifest.json.sigstore.json`,
        `server/${VERSION}/latest-linux-x64.yml`,
        `server/${VERSION}/complete.json`,
        "rings.json",
      ]);
      for (const args of f.log().filter((a) => a[3] === "put-object" && a.includes(`server/${VERSION}/complete.json`)))
        expect(args).toContain("--if-none-match");
      expect(JSON.parse(readFileSync(f.object(`server/${VERSION}/complete.json`), "utf8"))).toEqual({
        format: 1,
        version: VERSION,
        platform: "linux-x64",
      });
      const rings = JSON.parse(readFileSync(f.object("rings.json"), "utf8"));
      expect(rings).toEqual({ format: 1, rings: {}, server: { internal: { version: VERSION } } });
      // A rerun of identical bytes is a no-op; different bytes are refused.
      expect(f.run("server-snapshot", bundle(f), VERSION).status).toBe(0);
      writeFileSync(join(f.root, "server", `${STEM}.tar.xz`), "other bytes");
      expect(f.run("server-snapshot", join(f.root, "server"), VERSION).stderr).toContain(
        "already exists with different bytes",
      );
    });

    it("reads the live ring state, and fails rather than inventing one when there is none", () => {
      const f = setup();
      const out = join(f.root, "read.json");
      const missing = f.run("read-rings", out);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("the feed has no rings.json");
      expect(existsSync(out)).toBe(false);
      expect(f.run("server-snapshot", bundle(f), VERSION).status).toBe(0);
      const before = f.log().length;
      expect(f.run("read-rings", out).status).toBe(0);
      // Only reads.
      expect(
        f
          .log()
          .slice(before)
          .map((a) => a[3]),
      ).toEqual(["get-object"]);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(JSON.parse(readFileSync(f.object("rings.json"), "utf8")));
      // A store error is not mistaken for an empty feed.
      const failed = f.runWith({ FAKE_FAIL_OP: "get-object" }, "read-rings", out);
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain("could not read rings.json");
    });

    it("refuses a missing file before writing anything, and a pre-0.8 version before offering it", () => {
      const f = setup();
      const dir = bundle(f);
      rmSync(join(dir, "latest-linux-x64.yml"));
      expect(f.run("server-snapshot", dir, VERSION).stderr).toContain("missing latest-linux-x64.yml");
      expect(existsSync(f.object("rings.json"))).toBe(false);
      expect(existsSync(join(f.root, "log"))).toBe(false);
    });

    it("promotes servers only from a complete server snapshot, and desktops only behind them", () => {
      const f = setup();
      expect(f.run("promote-server", "preview", VERSION, "100").stderr).toContain("no complete server snapshot");
      expect(f.run("server-snapshot", bundle(f), VERSION).status).toBe(0);
      const promoted = f.run("promote-server", "preview", VERSION, "100");
      expect(promoted.status, promoted.stderr).toBe(0);
      expect(f.log().at(-1)).toContain("--if-match");
      expect(JSON.parse(readFileSync(f.object("rings.json"), "utf8")).server.preview).toEqual({ version: VERSION });
      // The desktop snapshot of the same version may now be offered to internal and preview.
      f.release(VERSION, "prerelease");
      expect(f.run("snapshot", f.artifacts, VERSION, "x64").status).toBe(0);
      expect(f.run("promote", "preview", VERSION, "100").status).toBe(0);
      // The desktop rules still apply on top: rings never move backwards.
      const again = f.run("promote", "internal", VERSION, "100");
      expect(again.stderr).toContain("internal already offers 0.8.0-rc.1");
    });

    it("never offers desktops a server-era version before internal's servers have it", () => {
      const f = setup();
      f.release(VERSION, "prerelease");
      const result = f.run("snapshot", f.artifacts, VERSION, "x64");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("offer the server bundle 0.8.0-rc.1 to all of internal first");
      expect(existsSync(f.object("rings.json"))).toBe(false);
    });
  });

  it("parses as bash", () => {
    expect(() => execFileSync("bash", ["-n", "tools/deploy/feed-r2.sh"])).not.toThrow();
  });
});

// The watchdog's `rings` job step, run as the workflow runs it, handing its output to the
// watchdog the way the `watch` job receives it (an output that was never set arrives empty).
describe.skipIf(process.platform === "win32")("watchdog ring state handoff (#877)", () => {
  const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
  const workflow = parse(readFileSync(".github/workflows/feed-watchdog.yml", "utf8"));
  const readStep = workflow.jobs.rings.steps.find((s) => s.id === "read");
  const check = workflow.jobs.watch.steps.find((s) => s.name === "Check every ring and architecture");

  const handoff = (f) => {
    const temp = mkdtempSync(join(f.root, "runner-"));
    const output = join(temp, "output");
    writeFileSync(output, "");
    const step = spawnSync("bash", ["-e", "-c", readStep.run], {
      env: { ...f.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    const rings = /^rings=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1] ?? "";
    expect(check.env.FEED_RINGS).toBe("${{ needs.rings.outputs.rings }}");
    // The rings job only runs while ORCA_FEED_BUCKET is set, so the watch job sees "true".
    return { step, state: ringState({ FEED_RINGS: rings, FEED_COMMISSIONED: "true" }) };
  };
  // A feed that refuses anonymous requests and offers nothing to anyone.
  const quiet = { fetch: async (url, init) => new Response("", { status: init?.headers?.Authorization ? 404 : 401 }) };
  const watched = (state) =>
    watch({ url: "https://feed.test", tokens: { internal: "i".repeat(43) }, repo: "o/r", ...quiet, ...state });
  const unavailable = "the feed is switched on (ORCA_FEED_BUCKET) but its ring state (rings.json) was not available";

  it("fails a switched-on feed whose rings.json is missing", async () => {
    const f = setup();
    const { step, state } = handoff(f);
    expect(step.status).not.toBe(0);
    expect(step.stderr).toContain("the feed has no rings.json");
    expect(state).toEqual({ record: undefined, commissioned: true });
    expect((await watched(state)).problems).toContain(unavailable);
  });

  it("fails a switched-on feed whose rings.json could not be read", async () => {
    const f = setup();
    writeFileSync(f.object("rings.json"), JSON.stringify({ format: 1, rings: {} }));
    const { step, state } = handoff({ ...f, env: { ...f.env, FAKE_FAIL_OP: "get-object" } });
    expect(step.status).not.toBe(0);
    expect((await watched(state)).problems).toContain(unavailable);
  });

  it("accepts an existing empty ring state as valid", async () => {
    const f = setup();
    writeFileSync(f.object("rings.json"), JSON.stringify({ format: 1, rings: {} }));
    const { step, state } = handoff(f);
    expect(step.status, step.stderr).toBe(0);
    expect(state).toEqual({ record: { format: 1, rings: {} }, commissioned: true });
    const { problems } = await watched(state);
    expect(problems).not.toContain(unavailable);
    expect(problems).toEqual([]);
  });
});
