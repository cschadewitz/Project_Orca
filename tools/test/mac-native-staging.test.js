/** Actual config/workflow parsing with controlled compiler vectors, no downloads or packaging. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { requestedMacArchitectures, stageNativeAddons } from "../packaged-mac/stage-native-addons.js";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { load } = libRequire("js-yaml");
const config = load(readFileSync(new URL("../../packages/app/electron-builder.yml", import.meta.url), "utf8"));

it("stages and verifies every requested Mac architecture once before packaging", () => {
  const run = vi.fn();
  const verify = vi.fn();
  expect(stageNativeAddons(config, "/controlled/verified headers", run, verify)).toEqual(["arm64", "x64"]);
  expect(run.mock.calls.map((call) => call[1])).toEqual(
    ["arm64", "x64"].map((arch) => [
      "packages/app/scripts/diagnostics-native-package.js",
      "--arch",
      arch,
      "--headers",
      "/controlled/verified headers",
    ]),
  );
  expect(verify.mock.calls.map((call) => call[1])).toEqual(["arm64", "x64"]);
});

it.each([{ mac: { target: ["dmg"] } }, { mac: { target: [{ arch: ["universal"] }] } }, { mac: { target: [] } }])(
  "refuses ambiguous target selection %j",
  (input) => {
    expect(() => requestedMacArchitectures(input)).toThrow();
  },
);

it("staging failure stops before another architecture or packaging", () => {
  const run = vi.fn(() => {
    throw new Error("controlled compiler refusal");
  });
  const verify = vi.fn();
  expect(() => stageNativeAddons(config, "/controlled/headers", run, verify)).toThrow("compiler refusal");
  expect(run).toHaveBeenCalledTimes(1);
  expect(verify).not.toHaveBeenCalled();
});

it("the real Desktop workflow verifies exact runtime headers then stages before Package", () => {
  const workflow = load(readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.package.steps;
  const index = steps.findIndex((step) => step.name === "Stage native addons for all requested Mac architectures");
  expect(index).toBeGreaterThan(steps.findIndex((step) => step.name === "Build"));
  expect(index).toBeLessThan(steps.findIndex((step) => step.name === "Package"));
  expect(steps[index].if).toBe("matrix.name == 'macos'");
  const script = steps[index].run;
  expect(script.indexOf("shasum -a 256 -c headers.sha256")).toBeLessThan(script.indexOf("tar -xzf"));
  expect(script.indexOf("tar -xzf")).toBeLessThan(script.indexOf("stage-native-addons.js --headers"));
  expect(script).toContain("process.versions.node");
  expect(script).toContain("SHASUMS256.txt");
  expect(script).toContain("set -euo pipefail");
  expect(config.mac.identity).toBeNull();
  expect(config.mac.notarize).toBe(false);
  expect(config.afterPack).toBe("./scripts/verify-diagnostics-native.js");
});
