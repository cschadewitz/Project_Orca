/** The server bundle channel file (#877): written from a verified bundle, parsed strictly. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleNames, parseServerChannel, serverChannel } from "../deploy/feed-server.js";

const SHA = "a".repeat(40);
const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const hex = (text) => createHash("sha256").update(text).digest("hex");

function bundle(version = "0.8.0", manifest = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orca-feed-server-"));
  dirs.push(dir);
  const names = bundleNames(version);
  writeFileSync(join(dir, names.archive), "archive bytes");
  writeFileSync(
    join(dir, names.manifest),
    JSON.stringify({
      schema: "orca-server-bundle/1",
      name: "orca-server",
      version,
      sourceSha: SHA,
      platform: "linux-x64",
      archive: { name: names.archive, sha256: hex("archive bytes"), size: 13 },
      ...manifest,
    }),
  );
  writeFileSync(join(dir, names.signature), "{}");
  return dir;
}

describe("serverChannel", () => {
  it("names the three files with their digests and sizes, in a fixed order", () => {
    const dir = bundle("0.8.0-rc.1");
    const names = bundleNames("0.8.0-rc.1");
    const text = serverChannel(dir, "0.8.0-rc.1");
    const manifest = readFileSync(join(dir, names.manifest), "utf8");
    expect(text).toBe(
      [
        "version: 0.8.0-rc.1",
        "platform: linux-x64",
        `sourceSha: ${SHA}`,
        `archive: ${names.archive}`,
        `archiveSha256: ${hex("archive bytes")}`,
        "archiveSize: 13",
        `manifest: ${names.manifest}`,
        `manifestSha256: ${hex(manifest)}`,
        `manifestSize: ${manifest.length}`,
        `signature: ${names.signature}`,
        `signatureSha256: ${hex("{}")}`,
        "signatureSize: 2",
        "",
      ].join("\n"),
    );
    expect(parseServerChannel(text)).toMatchObject({ version: "0.8.0-rc.1", archiveSize: 13, signatureSize: 2 });
  });

  it.each([
    ["another version", { version: "0.8.1" }],
    ["another platform", { platform: "linux-arm64" }],
    ["another schema", { schema: "orca-server-bundle/2" }],
    ["no commit", { sourceSha: "main" }],
    [
      "another archive digest",
      { archive: { name: "orca-server-0.8.0-linux-x64.tar.xz", sha256: "0".repeat(64), size: 13 } },
    ],
    [
      "another archive size",
      { archive: { name: "orca-server-0.8.0-linux-x64.tar.xz", sha256: hex("archive bytes"), size: 12 } },
    ],
  ])("refuses a manifest with %s", (_label, manifest) => {
    expect(() => serverChannel(bundle("0.8.0", manifest), "0.8.0")).toThrow(/does not describe/);
  });

  it("refuses dry runs and other prereleases", () => {
    expect(() => serverChannel(bundle("0.8.0-dryrun.1"), "0.8.0-dryrun.1")).toThrow(/not a final or an -rc.N/);
  });

  it("writes the file from the command line", () => {
    const dir = bundle();
    const result = spawnSync("node", ["tools/deploy/feed-server.js", "channel", dir, "0.8.0"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, "latest-linux-x64.yml"), "utf8")).toBe(result.stdout);
    const bad = spawnSync("node", ["tools/deploy/feed-server.js", "channel", dir, "0.8.1"], { encoding: "utf8" });
    expect(bad.status).not.toBe(0);
  });
});

describe("parseServerChannel", () => {
  const good = () => serverChannel(bundle(), "0.8.0");
  it("reads a channel naming a bundle from either side of the Orrery rename (the v0.8.1 bridge)", () => {
    // rename-keep-start: both names on purpose
    for (const product of ["orca", "orrery"]) {
      const text = good().replace(/(orca|orrery)-server-/g, `${product}-server-`);
      expect(parseServerChannel(text).archive).toBe(`${product}-server-0.8.0-linux-x64.tar.xz`);
    }
    expect(() => parseServerChannel(good().replace(/(orca|orrery)-server-/g, "kepler-server-"))).toThrow();
    // rename-keep-end
  });
  it.each([
    ["a missing final newline", (t) => t.slice(0, -1)],
    ["a reordered key", (t) => t.replace(/^version: (.*)\nplatform: (.*)\n/, "platform: $2\nversion: $1\n")],
    ["an extra key", (t) => `${t}extra: 1\n`],
    ["another archive name", (t) => t.replace("archive: orca-server-0.8.0", "archive: orca-server-0.8.1")],
    ["a non-hex digest", (t) => t.replace(/archiveSha256: \w+/, "archiveSha256: nope")],
    ["a non-numeric size", (t) => t.replace(/archiveSize: \d+/, "archiveSize: 1e9")],
    ["a CRLF file", (t) => t.replaceAll("\n", "\r\n")],
    ["another platform", (t) => t.replace("platform: linux-x64", "platform: linux-arm64")],
  ])("refuses %s", (_label, change) => {
    expect(() => parseServerChannel(change(good()))).toThrow();
  });
});
