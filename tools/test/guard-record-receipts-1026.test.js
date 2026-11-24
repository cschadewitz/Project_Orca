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
