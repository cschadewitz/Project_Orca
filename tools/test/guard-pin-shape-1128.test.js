/**
 * The Claude Agent SDK route's pin (#1128): a row that runs on `driver: "claude-agent-sdk"`
 * pins Claude Code and the Agent SDK, with the SDK's integrity, the Claude Code image and the
 * bridge's code, and takes only receipts from that driver. An ACP row's pin is as it was.
 */
import { describe, expect, it } from "vitest";
import {
  PIN_SHAPES,
  artifactsOf,
  checkSupportMatrix,
  installedInputProblems,
  loadCatalogue,
  loadMatrix,
  pinShape,
  receiptProblems,
} from "../guard-qualification/check-support-matrix.js";
import { recordReceipts } from "../guard-qualification/record-receipts.js";

const build = "0123456789abcdef0123456789abcdef01234567";
const sdkInputs = {
  sdk: { version: "0.3.332", integrity: "sha512-sdk" },
  runtime: { sha256: "a".repeat(64) },
  bridge: { sha256: "b".repeat(64) },
  settingSources: [],
  permissionMode: "default",
  profile: "c".repeat(64),
};
const sdkArtifacts = { sdkIntegrity: "sha512-sdk", runtimeSha256: "a".repeat(64), bridgeSha256: "b".repeat(64) };
const sdkPin = { agentVersion: "2.1.332", sdkVersion: "0.3.332", host: "linux-x64", build, artifacts: sdkArtifacts };
const sdkRow = (extra = {}) => ({
  id: "claude-sdk",
  driver: "claude-agent-sdk",
  tier: "none",
  pin: sdkPin,
  routes: ["claude-sdk-hook"],
  receipts: [],
  ...extra,
});
const sdkReceipt = (extra = {}) => ({
  format: "orca-enforcement-receipt/1",
  kind: "installed",
  driver: "claude-agent-sdk",
  agent: "claude-sdk",
  agentVersion: "2.1.332",
  sdkVersion: "0.3.332",
  host: "linux-x64",
  route: "claude-sdk-hook",
  build,
  cases: [],
  checks: { connects: "pass", uncoveredRoutesRefused: "pass" },
  uncoveredRoutes: [],
  inputs: sdkInputs,
  ...extra,
});
const acpReceipt = {
  ...sdkReceipt(),
  driver: undefined,
  sdkVersion: undefined,
  adapterVersion: "0.109.1",
  inputs: {
    adapter: { integrity: "sha512-abc" },
    runtime: { sha256: "a".repeat(64) },
    hookProgram: { sha256: "b".repeat(64) },
    profile: "c".repeat(64),
  },
};
const installed = (receipt, row) => receiptProblems(receipt, row, "claude-sdk-hook", "installed", []);

describe("the pin shape follows the row's driver (#1128)", () => {
  it("an ACP row pins the adapter and hook program; an SDK row the SDK and the bridge", () => {
    expect(pinShape({})).toBe(PIN_SHAPES.acp);
    expect(pinShape({ driver: "acp" })).toBe(PIN_SHAPES.acp);
    expect(pinShape(sdkRow()).versions).toEqual(["agentVersion", "sdkVersion"]);
    expect(pinShape(sdkRow()).artifacts).toEqual(["sdkIntegrity", "runtimeSha256", "bridgeSha256"]);
    expect(pinShape({ driver: "something-else" })).toBeUndefined();
    expect(artifactsOf(sdkReceipt())).toEqual(sdkArtifacts);
  });

  it("an SDK receipt backs an SDK row on its pin, and nothing else", () => {
    expect(installed(sdkReceipt(), sdkRow())).toEqual([]);
    expect(installed(sdkReceipt({ sdkVersion: "0.3.331" }), sdkRow())).toEqual(["sdkVersion 0.3.331"]);
    expect(installed(sdkReceipt({ agentVersion: "2.1.330" }), sdkRow())).toEqual(["agentVersion 2.1.330"]);
    // A receipt from the ACP route never backs the SDK row, nor the reverse.
    expect(installed(acpReceipt, sdkRow())).toEqual(
      expect.arrayContaining(["driver acp, needs claude-agent-sdk", "sdkVersion undefined"]),
    );
    const acpRow = { id: "claude-sdk", tier: "none", pin: { ...sdkPin, adapterVersion: "0.109.1" } };
    expect(installed(sdkReceipt(), acpRow)).toEqual(
      expect.arrayContaining(["driver claude-agent-sdk, needs acp", "adapterVersion undefined"]),
    );
  });

  it("an SDK receipt binds the SDK, the image, the bridge and the settings the route ran under", () => {
    const row = sdkRow();
    expect(installedInputProblems(sdkReceipt(), row)).toEqual([]);
    const without = { ...sdkInputs, bridge: undefined };
    expect(installedInputProblems(sdkReceipt({ inputs: without }), row)).toEqual([
      "needs inputs: the SDK's integrity, the runtime and bridge digests, the setting sources, the permission mode and the profile",
    ]);
    expect(installedInputProblems(sdkReceipt({ inputs: { ...sdkInputs, settingSources: ["project"] } }), row)).toEqual([
      "loaded Claude settings (project); the route loads none",
    ]);
    expect(
      installedInputProblems(sdkReceipt({ inputs: { ...sdkInputs, permissionMode: "bypassPermissions" } }), row),
    ).toEqual(["ran Claude in permission mode bypassPermissions, not default"]);
    expect(
      installedInputProblems(sdkReceipt({ inputs: { ...sdkInputs, bridge: { sha256: "d".repeat(64) } } }), row),
    ).toEqual([`bridgeSha256 ${"d".repeat(64)} is not the row's pinned ${"b".repeat(64)}`]);
    // An ACP row's inputs are what they were.
    expect(installedInputProblems(acpReceipt, { pin: { artifacts: artifactsOf(acpReceipt) } })).toEqual([]);
  });

  it("a tier on an SDK row needs the SDK row's pin", () => {
    const matrix = loadMatrix();
    const catalogue = loadCatalogue();
    const claimed = sdkRow({ tier: "A", pin: { agentVersion: "2.1.332", host: "linux-x64", build } });
    const problems = checkSupportMatrix(
      { ...matrix, agents: [claimed] },
      catalogue,
      () => false,
      () => undefined,
      undefined,
      () => [],
      ["A"],
    );
    expect(problems).toContain(
      "agent claude-sdk: tier A needs a pinned agent version, SDK version, host and exact build",
    );
  });

  it("recording pins an SDK row to an SDK receipt, and refuses one across drivers", () => {
    const file = "tools/guard-qualification/receipts/claude-sdk-claude-sdk-hook.json";
    const matrix = { agents: [sdkRow({ pin: null }), { id: "claude", tier: "none", pin: null, receipts: [] }] };
    const next = recordReceipts(matrix, [{ file, receipt: sdkReceipt() }]);
    expect(next.agents[0]).toMatchObject({ pin: sdkPin, receipts: [file] });
    expect(() => recordReceipts(matrix, [{ file, receipt: sdkReceipt({ agent: "claude" }) }])).toThrow(
      /a receipt on driver claude-agent-sdk cannot pin row claude, which is on driver acp/,
    );
  });
});
