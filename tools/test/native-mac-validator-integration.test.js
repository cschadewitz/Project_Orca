/** A produced synthetic identity crosses the fixture adapter into the single #442 validator. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assembleFixtureIdentity } from "../../packages/app/scripts/native-mac-identity.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const adapter = "tools/deploy/tests/native-mac/make_fixture.py";
const validator = "tools/deploy/native-mac-verify.py";
const directories = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orca-identity-validator-"));
  directories.push(dir);
  const output = join(dir, "producer");
  const destination = join(dir, "fixture");
  const daemon = join(dir, "daemon.mjs");
  mkdirSync(output);
  const daemonBytes = Buffer.from("// Synthetic daemon bytes, never executed.\n");
  writeFileSync(daemon, daemonBytes);
  const source = {
    sourceCommit: "b".repeat(40),
    releaseVersion: "0.6.0",
    protocol: { major: 2, minor: 7 },
    storeEpoch: "synthetic",
  };
  const metadata = {
    kind: "fixture",
    sourceCommit: source.sourceCommit,
    appVersion: source.releaseVersion,
    bundleId: "com.schadewitz.orca",
    expectedTeamId: "Q2FP9UY5T4",
    platform: "darwin",
    arch: "arm64",
    protocol: source.protocol,
    bundleShortVersion: "0.6.0",
    bundleVersion: "0007.02",
    buildId: "gha:0:0:mac-arm64",
    xcode: "0.0.0",
    macos: "0.0.0",
  };
  const identity = assembleFixtureIdentity({
    source,
    metadata,
    compiledProtocol: source.protocol,
    hello: { authenticated: true, orcaVersion: source.releaseVersion, protocol: source.protocol },
    daemonBytes,
    expectedDaemonSha256: hash(daemonBytes),
    toolchain: { electron: "0.0.0", electronBuilder: "0.0.0", node: "0.0.0", pnpm: "0.0.0" },
    builtAt: "2000-01-01T00:00:00.000Z",
  });
  const identityBytes = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`);
  writeFileSync(join(output, "orca-build.json"), identityBytes);
  writeFileSync(
    join(output, "fixture-provenance.json"),
    JSON.stringify({ kind: "fixture", sourceCommit: source.sourceCommit, identitySha256: hash(identityBytes) }),
  );
  const adapt = () =>
    spawnSync("python3", [adapter, "--producer-output", output, "--daemon", daemon, destination], {
      encoding: "utf8",
    });
  const verify = () =>
    spawnSync(
      "python3",
      [validator, "--mode", "fixture", "--fixture-app", join(destination, "ORCA.app"), join(destination, "delivery")],
      {
        encoding: "utf8",
      },
    );
  return { output, destination, daemon, identityBytes, adapt, verify };
}

it("passes the producer identity, sealed bytes, daemon and plist through the shared validator", () => {
  const f = fixture();
  const adapted = f.adapt();
  expect(adapted.status).toBe(0);
  expect(readFileSync(join(f.destination, "ORCA.app/Contents/Resources/orca-build.json"))).toEqual(f.identityBytes);
  expect(f.verify()).toMatchObject({ status: 0, stderr: "" });
  expect(readFileSync(join(f.destination, "delivery/native-mac-artifact.json"), "utf8")).toContain(
    "ORCA-0.6.0-mac-arm64.dmg",
  );
});

it("refuses candidate-labelled and changed producer output before creating a fixture", () => {
  const f = fixture();
  const receiptPath = join(f.output, "fixture-provenance.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.kind = "candidate";
  writeFileSync(receiptPath, JSON.stringify(receipt));
  expect(f.adapt().status).not.toBe(0);
  receipt.kind = "fixture";
  writeFileSync(receiptPath, JSON.stringify(receipt));
  writeFileSync(join(f.output, "orca-build.json"), Buffer.concat([f.identityBytes, Buffer.from(" ")]));
  expect(f.adapt().status).not.toBe(0);
});

it("refuses daemon bytes that differ from the produced digest", () => {
  const f = fixture();
  writeFileSync(f.daemon, "// Different synthetic bytes.\n");
  expect(f.adapt().status).not.toBe(0);
});

it("refuses a fixture version that would escape the synthetic artifact filenames", () => {
  const f = fixture();
  const identity = JSON.parse(f.identityBytes.toString());
  identity.releaseVersion = "../outside";
  const identityBytes = Buffer.from(`${JSON.stringify(identity)}\n`);
  writeFileSync(join(f.output, "orca-build.json"), identityBytes);
  const receiptPath = join(f.output, "fixture-provenance.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.identitySha256 = hash(identityBytes);
  writeFileSync(receiptPath, JSON.stringify(receipt));
  expect(f.adapt().status).not.toBe(0);
});

it.each([
  ["sealed identity", "ORCA.app/Contents/Resources/orca-build.json"],
  ["daemon", "ORCA.app/Contents/Resources/daemon/orca-daemon.mjs"],
  ["plist", "ORCA.app/Contents/Info.plist"],
])("the validator rejects changed %s after fixture assembly", (_label, path) => {
  const f = fixture();
  expect(f.adapt().status).toBe(0);
  const target = join(f.destination, path);
  writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("changed")]));
  const result = f.verify();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("FAIL (fixture only)");
});
