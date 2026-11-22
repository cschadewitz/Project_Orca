/** feed-arches.js (#889): arm64 is fed only with signing and acceptance records for its exact bytes. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { feedArches } from "../deploy/feed-arches.js";

const ARM = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const X64 = `sha256:${"c".repeat(64)}`;
const signed = (digest, run = 7) => `<!-- orca-signed-run-arm64: ${run} ${digest} -->`;
const accepted = (digest, run = 9) => `<!-- orca-arm64-accepted: ${run} ${digest} -->`;

function release({ arm = ARM, body = [signed(ARM), accepted(ARM)] } = {}) {
  const assets = [
    { name: "ORCA-0.7.1-linux-amd64.deb", digest: OTHER },
    { name: "ORCA-0.7.1-win-x64.exe", digest: X64 },
  ];
  if (arm !== null) assets.push({ name: "ORCA-0.7.1-win-arm64.exe", digest: arm });
  return { assets, body: [`notes`, `<!-- orca-signed-run: 7 ${X64} -->`, ...body].join("\n\n") };
}

describe("feedArches", () => {
  it("serves arm64 beside x64 when both records name the published installer", () => {
    expect(feedArches("0.7.1", release())).toEqual({ arches: ["x64", "arm64"] });
  });

  it.each([
    [
      "no arm64 installer (every release before #889)",
      release({ arm: null, body: [] }),
      /has no ORCA-0.7.1-win-arm64.exe/,
    ],
    ["no acceptance record", release({ body: [signed(ARM)] }), /native acceptance/],
    ["acceptance of other bytes", release({ body: [signed(ARM), accepted(OTHER)] }), /native acceptance/],
    ["two acceptance records", release({ body: [signed(ARM), accepted(ARM), accepted(ARM, 10)] }), /native acceptance/],
    ["no signing record", release({ body: [accepted(ARM)] }), /signing record/],
    ["a signing record for other bytes", release({ body: [signed(OTHER), accepted(ARM)] }), /signing record/],
    ["an installer without a digest", release({ arm: "" }), /digest/],
  ])("serves x64 alone with %s", (_label, json, reason) => {
    const result = feedArches("0.7.1", json);
    expect(result.arches).toEqual(["x64"]);
    expect(result.reason).toMatch(reason);
  });

  it("prints the list on stdout and the reason on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-arches-"));
    try {
      const file = join(dir, "release.json");
      writeFileSync(file, JSON.stringify(release()));
      const both = spawnSync(process.execPath, ["tools/deploy/feed-arches.js", "0.7.1", file], { encoding: "utf8" });
      expect([both.status, both.stdout, both.stderr]).toEqual([0, "x64 arm64\n", ""]);
      writeFileSync(file, JSON.stringify(release({ body: [signed(ARM)] })));
      const one = spawnSync(process.execPath, ["tools/deploy/feed-arches.js", "0.7.1", file], { encoding: "utf8" });
      expect([one.status, one.stdout]).toEqual([0, "x64\n"]);
      expect(one.stderr).toMatch(/^arm64 not served: /);
      const bad = spawnSync(process.execPath, ["tools/deploy/feed-arches.js", "v0.7.1", file], { encoding: "utf8" });
      expect(bad.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
