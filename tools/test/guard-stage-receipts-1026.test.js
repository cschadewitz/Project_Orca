/**
 * How guard-receipts.yml stages what it signs (stage-receipts.js, #1026): only this run's
 * validated installed receipts, under their expected names, with a manifest of their digests;
 * and how a staged directory is checked before anything is proposed.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST, stage, stageProblems, verifyStaged } from "../guard-qualification/stage-receipts.js";

const build = "0123456789abcdef0123456789abcdef01234567";
const receipt = {
  format: "orca-enforcement-receipt/1",
  kind: "installed",
  agent: "claude",
  route: "claude-native-hook",
  build,
};
const dir = () => mkdtempSync(join(tmpdir(), "guard-stage-"));
const write = (d, name, r) => {
  const p = join(d, name);
  writeFileSync(p, `${JSON.stringify(r)}\n`);
  return p;
};

describe("staging receipts to sign", () => {
  it("stages this run's installed receipts with a manifest of their digests", () => {
    const src = dir();
    const out = join(dir(), "signed");
    const entries = stage(out, [write(src, "claude-claude-native-hook.json", receipt)], build);
    expect(entries).toEqual([
      expect.objectContaining({ name: "claude-claude-native-hook.json", agent: "claude", kind: "installed" }),
    ]);
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST), "utf8"));
    expect(manifest.build).toBe(build);
    expect(manifest.receipts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses another build, kind, agent, route or name, and a test receipt under a real name", () => {
    expect(stageProblems("claude-claude-native-hook.json", receipt, build)).toEqual([]);
    expect(stageProblems("claude-claude-native-hook.json", { ...receipt, build: "f".repeat(40) }, build)).toEqual([
      `claude-claude-native-hook.json: build ${"f".repeat(40)}, not this run's ${build}`,
    ]);
    expect(stageProblems("claude-claude-native-hook.json", { ...receipt, kind: "connected" }, build)).toEqual([
      "claude-claude-native-hook.json: kind connected, only installed receipts are signed",
    ]);
    expect(stageProblems("nobody-claude-native-hook.json", { ...receipt, agent: "nobody" }, build)).toEqual([
      "nobody-claude-native-hook.json: no row for agent nobody",
    ]);
    expect(stageProblems("claude-claude-connected.json", { ...receipt, route: "claude-connected" }, build)).toEqual([
      "claude-claude-connected.json: claude-connected is not a route in the matrix",
    ]);
    expect(stageProblems("old.json", receipt, build)).toEqual([
      "old.json: must be named claude-claude-native-hook.json",
    ]);
    expect(stageProblems("claude-claude-native-hook.json", { ...receipt, scope: "verifier-test" }, build)).toEqual([
      "claude-claude-native-hook.json: must be named test-claude-native-hook.json",
    ]);
    expect(stageProblems("test-claude-native-hook.json", { ...receipt, scope: "verifier-test" }, build)).toEqual([]);
    expect(stageProblems("test-claude-native-hook.json", { ...receipt, scope: "trusted" }, build)).toEqual([
      "test-claude-native-hook.json: unknown scope trusted",
    ]);
    expect(stageProblems("x.json", { format: "other" }, build)).toEqual(["x.json: not an orca-enforcement-receipt/1"]);
  });

  it("refuses to stage into a directory that already holds files, or nothing at all", () => {
    const src = dir();
    const out = dir();
    writeFileSync(join(out, "historical.json"), "{}");
    expect(() => stage(out, [write(src, "claude-claude-native-hook.json", receipt)], build)).toThrow("is not empty");
    expect(() => stage(join(dir(), "signed"), [], build)).toThrow("no receipts to stage");
  });
});

describe("checking a staged directory before proposing", () => {
  const staged = () => {
    const out = join(dir(), "signed");
    stage(out, [write(dir(), "claude-claude-native-hook.json", receipt)], build);
    return out;
  };
  const signed = () => [];

  it("holds when the manifest lists exactly the receipts present, digests match and each verifies", () => {
    expect(verifyStaged(staged(), signed)).toEqual([]);
  });

  it("refuses a changed receipt, an extra one, a missing one, or one whose attestation fails", () => {
    const changed = staged();
    write(changed, "claude-claude-native-hook.json", { ...receipt, cases: [] });
    expect(verifyStaged(changed, signed)).toEqual(["claude-claude-native-hook.json: its digest is not the manifest's"]);
    const extra = staged();
    write(extra, "claude-other.json", receipt);
    expect(verifyStaged(extra, signed)).toEqual(["claude-other.json: not in the manifest"]);
    const missing = staged();
    const manifest = JSON.parse(readFileSync(join(missing, MANIFEST), "utf8"));
    manifest.receipts.push({ ...manifest.receipts[0], name: "gone.json" });
    writeFileSync(join(missing, MANIFEST), JSON.stringify(manifest));
    expect(verifyStaged(missing, signed)).toEqual(["gone.json: listed but missing"]);
    expect(verifyStaged(staged(), () => ["attestation does not verify: no bundle"])).toEqual([
      "claude-claude-native-hook.json: attestation does not verify: no bundle",
    ]);
  });
});
