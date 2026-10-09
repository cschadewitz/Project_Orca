/** Inert plans and real locked-builder CLI parsing; no build, install, Apple tools or app launch. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { macStagingPlan } from "../packaged-mac/packaging-plan.js";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { createYargs, configureBuildCommand, normalizeOptions } = builderRequire("./builder.js");
const { Platform } = builderRequire("app-builder-lib");
const { Arch } = builderRequire("builder-util");
const { getConfig, validateConfiguration } = libRequire("./util/config/config.js");
const { loadAll } = libRequire("js-yaml");
const unsigned = { identity: null, notarize: false };
const source = () => ({
  sourceCommit: "a".repeat(40),
  releaseVersion: "0.0.0-fixture.1",
  packageManager: "pnpm@12.4.2",
  lockfileSha256: "b".repeat(64),
  protocol: { major: 2, minor: 0 },
  storeEpoch: "synthetic",
});

it("produces only an unsigned unexecuted staging plan and keeps every candidate gate blocked", () => {
  const plan = macStagingPlan(source(), unsigned);
  expect(plan.scope).toBe("unsigned-staging-plan-only");
  expect(plan.signedCandidate).toBe("blocked");
  expect(plan.steps.every((step) => step.state === "not-run")).toBe(true);
  expect(plan.steps.find((step) => step.id === "frozen-install").args).toEqual([
    "install",
    "--frozen-lockfile",
    "--no-trust-lockfile",
  ]);
  expect(plan.steps.some((step) => ["codesign", "xcrun", "security", "gh", "ssh", "curl"].includes(step.command))).toBe(
    false,
  );
  expect(plan.candidateBlockers).toContain("SIGNED_IDENTITY_ADAPTER_MISSING");
  expect(plan.candidateBlockers).toContain("PACKAGED_AND_PHYSICAL_ACCEPTANCE_UNRUN");
});

it("the real locked builder parses the exact plan as only Mac arm64 directory, unsigned and publish-never", async () => {
  const lock = loadAll(readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8")).find(
    (doc) => doc?.importers?.["packages/app"],
  );
  expect(appRequire("electron-builder/package.json").version).toBe(
    lock.importers["packages/app"].devDependencies["electron-builder"].version.split("(")[0],
  );
  const step = macStagingPlan(source(), unsigned).steps.find((step) => step.id === "unsigned-directory");
  const parsed = configureBuildCommand(createYargs())
    .exitProcess(false)
    .parse(step.args.slice(step.args.indexOf("electron-builder") + 1));
  const normalized = normalizeOptions(parsed);
  expect([...normalized.targets.keys()]).toEqual([Platform.MAC]);
  expect([...normalized.targets.get(Platform.MAC)]).toEqual([[Arch.arm64, ["dir"]]]);
  expect(normalized.publish).toBe("never");
  expect(normalized.config.mac.identity).toBeNull();
  expect(normalized.config.mac.notarize).toBeUndefined();
  const config = await getConfig(new URL("../../packages/app/", import.meta.url).pathname, null, normalized.config);
  await expect(validateConfiguration(config, { isEnabled: false })).resolves.toBeUndefined();
  expect(config.mac.identity).toBeNull();
  expect(config.mac.notarize).toBe(false);
  expect(config.directories.output).toBe("dist/release/mac-beta-staging");
  expect(config.extraMetadata.version).toBe("0.0.0-fixture.1");
  expect(config.win.appId).toBe("dev.orca.desktop");
});

it.each([
  ["sourceCommit", "main"],
  ["sourceCommit", "a".repeat(39)],
  ["lockfileSha256", "unknown"],
  ["releaseVersion", "latest"],
  ["releaseVersion", "0.1.0\n-c.mac.identity=-"],
  ["releaseVersion", "0.1.0; echo secret"],
  ["packageManager", "pnpm@12.10.1"],
  ["protocol", { major: true, minor: 0 }],
  ["protocol", { major: 2, minor: -1 }],
  ["protocol", null],
  ["storeEpoch", "private/path"],
])("rejects invalid public source fact %s", (key, value) => {
  expect(() => macStagingPlan({ ...source(), [key]: value }, unsigned)).toThrow("[SOURCE_FACTS]");
});

it("retains source facts only, without arbitrary environment or secret fields", () => {
  const plan = macStagingPlan(
    {
      ...source(),
      credential: "synthetic-secret-canary",
      environment: { APPLE_API_KEY: "synthetic-key" },
    },
    unsigned,
  );
  expect(JSON.stringify(plan)).not.toContain("synthetic-secret-canary");
  expect(JSON.stringify(plan)).not.toContain("synthetic-key");
  expect(plan.protocol).toEqual({ major: 2, minor: 0 });
});

it.each([
  undefined,
  {},
  { identity: "-", notarize: false },
  { identity: "Developer ID", notarize: false },
  { identity: null, notarize: true },
  { identity: null, notarize: "false" },
])("refuses changed or unknown signing policy %j", (ordinaryMac) => {
  expect(() => macStagingPlan(source(), ordinaryMac)).toThrow("[UNSIGNED_POLICY_REQUIRED]");
});

it.each(["sourceCommit", "lockfileSha256"])("does not coerce non-string %s into a digest", (key) => {
  expect(() =>
    macStagingPlan({ ...source(), [key]: BigInt("1".repeat(key === "sourceCommit" ? 40 : 64)) }, unsigned),
  ).toThrow("[SOURCE_FACTS]");
});

it.each([["--run"], ["--mode", "candidate"], ["--source-commit", "private-input"]])(
  "CLI refuses unsafe/incomplete input without executing steps: %j",
  (args) => {
    const result = spawnSync(process.execPath, ["tools/packaged-mac/packaging-plan.js", ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).status).toBe("blocked");
    expect(result.stderr).not.toContain("private-input");
  },
);
