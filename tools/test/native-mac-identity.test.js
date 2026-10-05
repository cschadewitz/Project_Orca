/** Negative producer tests use synthetic metadata/bytes, never a signed candidate. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assembleFixtureIdentity,
  readSelectedSource,
  produceFixtureIdentity,
} from "../../packages/app/scripts/native-mac-identity.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const source = {
    sourceCommit: "a".repeat(40),
    releaseVersion: "0.0.0-fixture.1",
    protocol: { major: 2, minor: 7 },
    storeEpoch: "synthetic",
    lockfileSha256: "b".repeat(64),
  };
  const daemonBytes = Buffer.from("// Synthetic daemon bytes; never executed.\n");
  return {
    source,
    metadata: {
      kind: "fixture",
      sourceCommit: source.sourceCommit,
      appVersion: source.releaseVersion,
      bundleId: "com.schadewitz.orca",
      expectedTeamId: "Q2FP9UY5T4",
      platform: "darwin",
      arch: "arm64",
      protocol: source.protocol,
      bundleShortVersion: "0.0.0",
      bundleVersion: "0007.02",
      buildId: "gha:0:0:mac-arm64",
      xcode: "0.0.0",
      macos: "0.0.0",
    },
    compiledProtocol: { ...source.protocol },
    hello: { authenticated: true, orcaVersion: source.releaseVersion, protocol: { ...source.protocol } },
    daemonBytes,
    expectedDaemonSha256: sha256(daemonBytes),
    toolchain: { electron: "44.4.5", electronBuilder: "26.15.3", node: "24.21.0", pnpm: "12.4.2" },
    builtAt: "2000-01-01T00:00:00.000Z",
  };
}

it("emits only delivery-v1 identity fields, preserving opaque plist versions and byte hashes", () => {
  const inputs = fixture();
  const identity = assembleFixtureIdentity(inputs);
  expect(Object.keys(identity).sort()).toEqual(
    "schemaVersion releaseVersion bundleId platform arch sourceCommit buildId builtAt appVersion bundleShortVersion bundleVersion daemon protocol storeEpoch toolchain"
      .split(" ")
      .sort(),
  );
  expect(identity.bundleId).toBe("com.schadewitz.orca");
  expect(identity.bundleVersion).toBe("0007.02");
  expect(identity.daemon).toEqual({
    path: "daemon/orca-daemon.mjs",
    sha256: sha256(inputs.daemonBytes),
    version: inputs.source.releaseVersion,
  });
  expect(identity.protocol).toEqual({ major: 2, minor: 7 });
  expect(identity.toolchain.xcode).toBe("0.0.0");
  expect(identity).not.toHaveProperty("kind");
  expect(identity).not.toHaveProperty("teamId");
});

it.each([
  [
    "missing metadata",
    (x) => {
      x.metadata = undefined;
    },
    "FIXTURE_ONLY",
  ],
  [
    "candidate metadata",
    (x) => {
      x.metadata.kind = "candidate";
    },
    "FIXTURE_ONLY",
  ],
  [
    "wrong source",
    (x) => {
      x.metadata.sourceCommit = "c".repeat(40);
    },
    "METADATA_SOURCE",
  ],
  [
    "wrong app version",
    (x) => {
      x.metadata.appVersion = "0.1.0";
    },
    "APP_VERSION",
  ],
  [
    "old bundle ID",
    (x) => {
      x.metadata.bundleId = "dev.orca.desktop";
    },
    "APPROVED_IDENTITY",
  ],
  [
    "wrong team",
    (x) => {
      x.metadata.expectedTeamId = "UNKNOWN";
    },
    "APPROVED_IDENTITY",
  ],
  [
    "x64",
    (x) => {
      x.metadata.arch = "x64";
    },
    "TARGET",
  ],
  [
    "wrong protocol input",
    (x) => {
      x.metadata.protocol = { major: 1, minor: 9 };
    },
    "METADATA_PROTOCOL",
  ],
  [
    "missing plist policy",
    (x) => {
      delete x.metadata.bundleVersion;
    },
    "PLIST_VERSIONS_REQUIRED",
  ],
  [
    "numeric plist coercion",
    (x) => {
      x.metadata.bundleVersion = 7.02;
    },
    "PLIST_VERSIONS_REQUIRED",
  ],
  [
    "lone high surrogate in short plist version",
    (x) => {
      x.metadata.bundleShortVersion = "0.0.0\ud800";
    },
    "PLIST_VERSIONS_REQUIRED",
  ],
  [
    "lone low surrogate in plist version",
    (x) => {
      x.metadata.bundleVersion = "0007.02\udc00";
    },
    "PLIST_VERSIONS_REQUIRED",
  ],
  [
    "missing build ID",
    (x) => {
      delete x.metadata.buildId;
    },
    "BUILD_ID",
  ],
  [
    "guessed Xcode",
    (x) => {
      x.metadata.xcode = "latest";
    },
    "NATIVE_VERSIONS_REQUIRED",
  ],
  [
    "missing macOS",
    (x) => {
      delete x.metadata.macos;
    },
    "NATIVE_VERSIONS_REQUIRED",
  ],
  [
    "stale compiled protocol",
    (x) => {
      x.compiledProtocol.minor++;
    },
    "BUILD_PROTOCOL",
  ],
  [
    "wrong hello protocol",
    (x) => {
      x.hello.protocol.major++;
    },
    "BUILD_PROTOCOL",
  ],
  [
    "wrong daemon version",
    (x) => {
      x.hello.orcaVersion = "0.1.0";
    },
    "DAEMON_VERSION",
  ],
  [
    "unauthenticated hello",
    (x) => {
      x.hello.authenticated = false;
    },
    "DAEMON_VERSION",
  ],
  [
    "empty daemon",
    (x) => {
      x.daemonBytes = Buffer.alloc(0);
    },
    "DAEMON_BYTES",
  ],
  [
    "tampered daemon",
    (x) => {
      x.daemonBytes = Buffer.concat([x.daemonBytes, Buffer.from("tamper")]);
    },
    "DAEMON_HASH",
  ],
  [
    "incorrect daemon hash",
    (x) => {
      x.expectedDaemonSha256 = "0".repeat(64);
    },
    "DAEMON_HASH",
  ],
  [
    "tool range",
    (x) => {
      x.toolchain.electron = "^44.4.5";
    },
    "TOOLCHAIN",
  ],
  [
    "missing tool",
    (x) => {
      delete x.toolchain.node;
    },
    "TOOLCHAIN",
  ],
  [
    "invalid date",
    (x) => {
      x.builtAt = "2000-02-30T00:00:00.000Z";
    },
    "BUILD_TIME",
  ],
])("refuses %s", (_label, mutate, code) => {
  const inputs = fixture();
  mutate(inputs);
  expect(() => assembleFixtureIdentity(inputs)).toThrow(`[${code}]`);
});

it.each([undefined, "candidate", "production", "unsigned"])(
  "rejects mode %s before reading or building anything",
  async (mode) => {
    await expect(produceFixtureIdentity({ mode })).rejects.toThrow("[FIXTURE_ONLY]");
  },
);

const directories = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "orca-synthetic-identity-source-"));
  directories.push(dir);
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ version: "0.0.0-fixture.1", packageManager: "pnpm@12.4.2" }),
  );
  writeFileSync(
    join(dir, "release-compatibility.json"),
    JSON.stringify({ storeEpoch: "synthetic", protocol: { major: 2, minor: 7 } }),
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "synthetic lockfile\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "synthetic source",
  );
  return { dir, git, commit: git("rev-parse", "HEAD") };
}

it("binds clean selected source, root version, compatibility and lock bytes", () => {
  const { dir, commit } = checkout();
  expect(readSelectedSource(dir, commit)).toMatchObject({
    sourceCommit: commit,
    releaseVersion: "0.0.0-fixture.1",
    storeEpoch: "synthetic",
    lockfileSha256: sha256("synthetic lockfile\n"),
  });
  expect(() => readSelectedSource(dir, "main")).toThrow("[SOURCE_SHA]");
  expect(() => readSelectedSource(dir, "0".repeat(40))).toThrow("[SOURCE_MISMATCH]");
});

it.each(["tracked", "staged", "untracked"])("refuses %s changes", (kind) => {
  const { dir, git, commit } = checkout();
  writeFileSync(join(dir, kind === "untracked" ? "new-source.js" : "pnpm-lock.yaml"), "changed\n");
  if (kind === "staged") git("add", ".");
  expect(() => readSelectedSource(dir, commit)).toThrow("[DIRTY_SOURCE]");
});
