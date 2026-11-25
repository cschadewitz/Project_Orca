/**
 * How guard-receipts.yml records signed receipts in the support matrix (record-receipts.js):
 * each one on its agent's row, the row pinned to it, and the tier left as it was.
 */
import { describe, expect, it } from "vitest";
import { recordReceipts } from "../guard-qualification/record-receipts.js";

const build = "0123456789abcdef0123456789abcdef01234567";
const receipt = {
  agent: "claude",
  kind: "installed",
  route: "claude-native-hook",
  agentVersion: "2.1.330",
  adapterVersion: "0.109.1",
  host: "linux-x64",
  build,
  inputs: {
    adapter: { version: "0.109.1", integrity: "sha512-abc" },
    runtime: { sha256: "a".repeat(64) },
    hookProgram: { sha256: "b".repeat(64) },
    profile: "c".repeat(64),
  },
};
const artifacts = { adapterIntegrity: "sha512-abc", runtimeSha256: "a".repeat(64), hookProgramSha256: "b".repeat(64) };
const matrix = {
  agents: [
    { id: "claude", tier: "none", pin: null, receipts: [] },
    { id: "pi", tier: "none", pin: null, receipts: [] },
  ],
};
const file = "tools/guard-qualification/receipts/claude-claude-native-hook.json";

describe("recording receipts", () => {
  it("lists the receipt on its row, pins the row to it, and leaves every tier alone", () => {
    const next = recordReceipts(matrix, [{ file, receipt }]);
    expect(next.agents[0]).toEqual({
      id: "claude",
      tier: "none",
      pin: { agentVersion: "2.1.330", adapterVersion: "0.109.1", host: "linux-x64", build, artifacts },
      receipts: [file],
    });
    expect(next.agents[1]).toEqual(matrix.agents[1]);
    expect(matrix.agents[0].receipts).toEqual([]);
  });

  it("drops a row's receipts from another pin: one row, one build", () => {
    const old = { ...matrix.agents[0], pin: { ...receipt, build: "f".repeat(40) }, receipts: ["old.json"] };
    const next = recordReceipts({ agents: [old] }, [{ file, receipt }]);
    expect(next.agents[0].receipts).toEqual([file]);
    expect(next.agents[0].pin.build).toBe(build);
  });

  it("refuses a receipt for no row, or without a complete pin", () => {
    expect(() => recordReceipts(matrix, [{ file, receipt: { ...receipt, agent: "nobody" } }])).toThrow(
      "no support-matrix row for agent nobody",
    );
    expect(() => recordReceipts(matrix, [{ file, receipt: { ...receipt, host: undefined } }])).toThrow(
      "names no complete pin",
    );
    expect(() => recordReceipts(matrix, [{ file, receipt: { ...receipt, inputs: undefined } }])).toThrow(
      "names no artifact digests",
    );
  });
});

describe("a scoped claim on the receipt's route", () => {
  const claim = {
    level: "A",
    route: "claude-native-hook",
    pin: {
      agentVersion: "2.1.330",
      adapterVersion: "0.109.1",
      host: "linux-x64",
      build: "f".repeat(40),
      artifacts: { ...artifacts, hookProgramSha256: "d".repeat(64) },
    },
    settings: { nativeToolHook: "experimental" },
    covers: ["L01"],
    excludes: { A04: "A live agent cannot make this call from another working directory." },
    stillOff: ["something"],
    unverified: ["something else"],
    judge: "unverified",
    receipts: [file],
  };
  const row = (scoped) => ({
    agents: [{ id: "claude", tier: "none", pin: claim.pin, receipts: [file], scoped }],
  });

  it("moves to the new build and hook program with the receipt, in the same edit, and changes nothing else", () => {
    const next = recordReceipts(row(claim), [{ file, receipt }], () => receipt);
    const pin = { agentVersion: "2.1.330", adapterVersion: "0.109.1", host: "linux-x64", build, artifacts };
    expect(next.agents[0].pin).toEqual(pin);
    expect(next.agents[0].scoped).toEqual({ ...claim, pin, receipts: [file] });
    // The input is left as it was.
    expect(claim.pin.build).toBe("f".repeat(40));
  });

  it("lists only the new receipt, whatever the claim listed before", () => {
    const next = recordReceipts(row({ ...claim, receipts: ["old.json"] }), [{ file, receipt }], () => receipt);
    expect(next.agents[0].scoped.receipts).toEqual([file]);
  });

  it("is refused, not moved, when the receipt is for another agent, adapter, host or runtime", () => {
    for (const [changed, why] of [
      [{ agentVersion: "2.1.331" }, "agentVersion"],
      [
        {
          adapterVersion: "0.110.0",
          inputs: { ...receipt.inputs, adapter: { version: "0.110.0", integrity: "sha512-abc" } },
        },
        "adapterVersion",
      ],
      [{ host: "linux-arm64" }, "host"],
      [
        { inputs: { ...receipt.inputs, adapter: { version: "0.109.1", integrity: "sha512-other" } } },
        "adapterIntegrity",
      ],
      [{ inputs: { ...receipt.inputs, runtime: { sha256: "e".repeat(64) } } }, "runtimeSha256"],
    ])
      expect(() => recordReceipts(row(claim), [{ file, receipt: { ...receipt, ...changed } }], () => receipt)).toThrow(
        new RegExp(`scoped claim on claude-native-hook pins another ${why}\\b.*re-scope it in a reviewed change`),
      );
  });

  it("is left alone by a receipt for another route", () => {
    const other = { ...claim, route: "acp-ask" };
    const next = recordReceipts(row(other), [{ file, receipt }], () => receipt);
    expect(next.agents[0].scoped).toEqual(other);
  });
});

describe("the recorded files pass the repository's format check", () => {
  it("leaves signed receipts and their bundles as signed, and formats the matrix", async () => {
    const prettier = await import("prettier");
    const { join } = await import("node:path");
    const { readFileSync } = await import("node:fs");
    const { REPO_ROOT } = await import("../guard-qualification/check-support-matrix.js");
    const ignorePath = join(REPO_ROOT, ".prettierignore");
    for (const f of [file, `${file}.sigstore.json`])
      expect((await prettier.getFileInfo(join(REPO_ROOT, f), { ignorePath })).ignored, f).toBe(true);
    const at = join(REPO_ROOT, "tools/guard-qualification/support-matrix.json");
    expect((await prettier.getFileInfo(at, { ignorePath })).ignored).toBe(false);
    // What the propose job writes before formatting is not what the check accepts, so the job formats it.
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/guard-receipts.yml"), "utf8");
    const record = workflow.indexOf("node tools/guard-qualification/record-receipts.js");
    const format = workflow.indexOf("prettier --write tools/guard-qualification/support-matrix.json");
    const add = workflow.indexOf(
      "git add tools/guard-qualification/receipts tools/guard-qualification/support-matrix.json",
    );
    expect(record).toBeGreaterThan(0);
    expect(format).toBeGreaterThan(record);
    expect(add).toBeGreaterThan(format);
  });
});
