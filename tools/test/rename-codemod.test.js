// Pins the ORCA -> Orrery naming map (tools/rename/map.json). The codemod rewrites the
// whole tree at cutover, so a rule that is one character too greedy is a bug in 1,800 files.
import { describe, expect, it } from "vitest";
import { isExcluded, leftovers, loadMap, renamePath, renameText } from "../rename/lib.mjs";

const map = loadMap();
const rename = (s) => renameText(map, s).text;

describe("rename rules", () => {
  it.each([
    ["ORCA runs agents.", "Orrery runs agents."],
    ["the Orca desktop", "the Orrery desktop"],
    ["import { x } from '@orca/core';", "import { x } from '@orrery/core';"],
    ["ORCA_DAEMON_URL=1", "ORRERY_DAEMON_URL=1"],
    ["$ORCA506_NODE", "$ORRERY506_NODE"],
    ['"-DORCA_PAIR_FAULTS"', '"-DORRERY_PAIR_FAULTS"'],
    ["FAKE_ORCA_HOME", "FAKE_ORRERY_HOME"],
    ['"SECRET\\nORCA_TEST"', '"SECRET\\nORRERY_TEST"'],
    ["class OrcaError extends Error", "class OrreryError extends Error"],
    ["isOrcaError(e)", "isOrreryError(e)"],
    ["hello.orcaVersion", "hello.orreryVersion"],
    ["join(dir, '.orca')", "join(dir, '.orrery')"],
    ["orca.config.yaml", "orrery.config.yaml"],
    ["orca://item/1", "orrery://item/1"],
    ["window.orca.connection", "window.orrery.connection"],
    ["X-Orca-Feed-Stop", "X-Orrery-Feed-Stop"],
    ["https://github.com/cschadewitz/Project_Orca/pull/1", "https://github.com/cschadewitz/Orrery/pull/1"],
    ["cschadewitz/Project_Orca_Infra", "cschadewitz/Orrery-Infra"],
    ['"\\norca"', '"\\norrery"'],
  ])("%s", (from, to) => {
    expect(rename(from)).toBe(to);
  });

  it.each([
    "EditorCanvas",
    "appId: dev.orca.desktop",
    "bucket orca-desktop-feed",
    "Entra app orca-infra-ci",
    "${{ secrets.ORCA_FEED_ACCESS_KEY_ID }}",
    'TOKEN_PREFIX = "orca1"',
    "AAAAC3NzaC1lZDI1NTE5AAAAIOrcaServerKeyOne0000",
    "header ORCADP01",
    "orrery and Orrery are already renamed",
    '      "note": "targets not verified by ORCA",',
  ])("leaves %s alone", (text) => {
    expect(rename(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = rename("ORCA_X @orca/core OrcaError .orca Project_Orca");
    expect(rename(once)).toBe(once);
  });

  it("leaves rename-keep lines and blocks", () => {
    const text = [
      "ORCA one",
      "accept('cschadewitz/Project_Orca'); // rename-keep: bridge accepts the old identity",
      "// rename-keep-start",
      "ORCA_LEGACY",
      "// rename-keep-end",
      "ORCA two",
    ].join("\n");
    expect(rename(text).split("\n")).toEqual([
      "Orrery one",
      "accept('cschadewitz/Project_Orca'); // rename-keep: bridge accepts the old identity",
      "// rename-keep-start",
      "ORCA_LEGACY",
      "// rename-keep-end",
      "Orrery two",
    ]);
  });
});

describe("paths", () => {
  it("renames each segment", () => {
    expect(renamePath(map, "tools/deploy/orca-release.py")).toBe("tools/deploy/orrery-release.py");
    expect(renamePath(map, "examples/orca.config.yaml")).toBe("examples/orrery.config.yaml");
  });

  it("never touches excluded paths", () => {
    const fixture = "packages/app/test/fixtures/store-v0.6.0/store/work/docs/.orca-attempts/x.md";
    expect(isExcluded(map, fixture)).toBe(true);
    expect(renamePath(map, fixture)).toBe(fixture);
    expect(isExcluded(map, "CHANGELOG.md")).toBe(true);
    expect(isExcluded(map, "docs/preparation/a/b.md")).toBe(true);
    expect(isExcluded(map, "docs/WORKFLOWS.md")).toBe(false);
  });
});

describe("audit", () => {
  it("reports what the rules leave and skips what is kept", () => {
    const found = leftovers(map, "Orrery\nlinkorca://\ndev.orca.desktop\nORCA // rename-keep\n");
    expect(found).toEqual([{ line: 2, column: 5, text: "linkorca://" }]);
  });
});
