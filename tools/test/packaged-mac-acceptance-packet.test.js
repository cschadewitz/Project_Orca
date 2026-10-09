/** Real locked builder parser and inert package selection checks; never execute a native command. */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { createAcceptancePacket } from "../packaged-mac/acceptance-packet.js";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { createYargs, configureBuildCommand, normalizeOptions } = builderRequire("./builder.js");
const { Platform } = builderRequire("app-builder-lib");
const { Arch } = builderRequire("builder-util");
const { getConfig, validateConfiguration } = libRequire("./util/config/config.js");
const source = {
  sourceCommit: "a".repeat(40),
  releaseVersion: "0.0.0-fixture.1",
  packageManager: "pnpm@12.4.2",
  lockfileSha256: "b".repeat(64),
  protocol: { major: 2, minor: 0 },
  storeEpoch: "synthetic",
};
const ordinary = { identity: null, notarize: false };
const selections = () => ({
  stapledApp: "/private/stapled/ORCA.app",
  dmg: "/private/delivery/ORCA.dmg",
  zip: "/private/delivery/ORCA.zip",
  dmgApp: "/private/dmg-copy/ORCA.app",
  zipApp: "/private/zip-copy/ORCA.app",
  accountHome: "/Users/disposable",
  temporaryDirectory: "/private/scratch",
});
const packet = (input = selections()) => createAcceptancePacket(source, ordinary, input);

it("the locked builder parses only arm64 DMG/ZIP with the exact prepackaged app and publish-never", async () => {
  const step = packet().containerPreparation;
  const parsed = configureBuildCommand(createYargs())
    .exitProcess(false)
    .parse(step.args.slice(step.args.indexOf("electron-builder") + 1));
  const normalized = normalizeOptions(parsed);
  expect([...normalized.targets.keys()]).toEqual([Platform.MAC]);
  expect([...normalized.targets.get(Platform.MAC)]).toEqual([[Arch.arm64, ["dmg", "zip"]]]);
  expect(normalized.prepackaged).toBe(selections().stapledApp);
  expect(normalized.publish).toBe("never");
  const config = await getConfig(new URL("../../packages/app/", import.meta.url).pathname, null, normalized.config);
  await expect(validateConfiguration(config, { isEnabled: false })).resolves.toBeUndefined();
  expect(config.mac.identity).toBeNull();
  expect(config.mac.notarize).toBe(false);
  expect(config.directories.output).toBe("dist/release/mac-beta-containers");
  expect(config.extraMetadata.version).toBe(source.releaseVersion);
  expect(step.state).toBe("blocked");
});

it("keeps container/signing, candidate validation and actual launches gated, with serial bounded observations", () => {
  const result = packet();
  expect(result.candidateAcceptance).toBe("blocked");
  expect(result.workers).toBe(1);
  expect(result.retries).toBe(0);
  const observations = [...result.observations, ...result.copies.flatMap((copy) => copy.observations)];
  expect(observations).toHaveLength(20);
  expect(result.observations.find((step) => step.id === "dmg-gatekeeper").args).toEqual([
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    selections().dmg,
  ]);
  for (const step of observations) {
    expect(step.state).toBe("not-run");
    expect(step.timeoutMs).toBe(30000);
    expect(step.maxBufferBytes).toBe(16384);
    expect(Object.keys(step.env)).toEqual(["PATH", "LANG"]);
  }
  expect(result.remainingGates).toContain("SIGNED_CANDIDATE_VALIDATOR");
  expect(result.remainingGates).toContain("FIRST_RUN_ORPHAN_RECOVERY_570");
  expect(result.copies.map((copy) => copy.format)).toEqual(["dmg", "zip"]);
  for (const copy of result.copies) {
    const gatekeeper = copy.observations.find((step) => step.id === `${copy.format}-gatekeeper`);
    expect(gatekeeper.command).toBe("/usr/bin/syspolicy_check");
    expect(gatekeeper.args).toEqual(["distribution", selections()[`${copy.format}App`]]);
    expect(gatekeeper.requires).toEqual(["MACOS_14_PLUS_DISTRIBUTION_CHECK"]);
    expect(copy.launch.state).toBe("blocked");
    expect(copy.launch.args).toEqual([]);
    expect(Object.keys(copy.launch.env)).toEqual(["HOME", "TMPDIR", "PATH", "LANG", "LC_CTYPE"]);
    expect(copy.launch.command).toBe(`${selections()[`${copy.format}App`]}/Contents/MacOS/ORCA`);
  }
  expect(JSON.stringify(result)).not.toContain("--sign");
  expect(JSON.stringify(result)).not.toContain("--no-sandbox");
});

it("does not inherit developer daemon, signing, renderer or Node injection canaries", () => {
  const code = `import {createAcceptancePacket} from './tools/packaged-mac/acceptance-packet.js';
    console.log(JSON.stringify(createAcceptancePacket(${JSON.stringify(source)},
      ${JSON.stringify(ordinary)}, ${JSON.stringify(selections())})));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ORCA_DAEMON_URL: "synthetic-private-canary",
      ORCA_RENDERER_URL: "synthetic-private-canary",
      CSC_KEY_PASSWORD: "synthetic-private-canary",
      NODE_OPTIONS: "--no-warnings",
    },
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain("synthetic-private-canary");
  expect(Object.keys(JSON.parse(result.stdout).copies[0].launch.env)).toEqual([
    "HOME",
    "TMPDIR",
    "PATH",
    "LANG",
    "LC_CTYPE",
  ]);
  expect(() => packet({ ...selections(), environment: { CSC_KEY_PASSWORD: "synthetic-private-canary" } })).toThrow(
    "[INPUT]",
  );
});

it.each([
  ["dmg", "relative.dmg"],
  ["zip", "/private/../delivery.zip"],
  ["dmgApp", "/private/wrong.app"],
  ["stapledApp", "/private/ORCA.app\n"],
  ["zipApp", undefined],
  ["dmg", 1],
])("refuses malformed or missing target %s without exposing it", (key, value) => {
  expect(() => packet({ ...selections(), [key]: value })).toThrow("[INPUT]");
});

it("refuses reuse or nesting of final contained app targets", () => {
  expect(() => packet({ ...selections(), zipApp: selections().dmgApp })).toThrow("[DISTINCT_TARGETS]");
  expect(() => packet({ ...selections(), zipApp: `${selections().dmgApp}/nested/ORCA.app` })).toThrow(
    "[DISTINCT_TARGETS]",
  );
});

it("preserves spaces, Unicode and shell metacharacters in a single argument without a shell", () => {
  const app = "/private/Préparé $(not-a-command); `canary`/ORCA.app";
  const result = packet({ ...selections(), stapledApp: app });
  const args = result.containerPreparation.args;
  expect(args[args.indexOf("--prepackaged") + 1]).toBe(app);
  expect(args.filter((value) => value.includes("canary"))).toEqual([app]);
});

it.each([
  ["--run"],
  ["--mode", "candidate"],
  ["--source-commit", "private-invalid-value"],
  ["--dmg", "/private/first.dmg", "--dmg", "/private/second.dmg"],
])("CLI fails closed for execution/promotion/invalid source: %j", (args) => {
  const result = spawnSync(process.execPath, ["tools/packaged-mac/acceptance-packet.js", ...args], {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).status).toBe("blocked");
  expect(result.stderr).not.toContain("private-invalid-value");
});
