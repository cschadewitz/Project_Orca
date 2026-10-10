/**
 * Delivery-v1 build identity and fixture producer. The native adapter observes actual
 * pre-signing resources separately. No signing, credentials or publishing.
 * See docs/preparation/native-mac-delivery/signing-foundation.md for the input seam.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const APPROVED_BUNDLE_ID = "com.schadewitz.orca";
export const EXPECTED_TEAM_ID = "Q2FP9UY5T4";
const daemonResource = "daemon/orca-daemon.mjs";
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const exactVersion = /^[0-9]+(?:\.[0-9]+)*(?:[-+][0-9A-Za-z.-]+)?$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

export class IdentityError extends Error {
  constructor(code) {
    super(`Native Mac identity refused [${code}]`);
    this.code = code;
  }
}
function requireValue(condition, code) {
  if (!condition) throw new IdentityError(code);
}
function text(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.isWellFormed() &&
    value === value.trim() &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}
function protocol(value) {
  return value && [value.major, value.minor].every((part) => Number.isSafeInteger(part) && part >= 0);
}
function sameProtocol(a, b) {
  return protocol(a) && protocol(b) && a.major === b.major && a.minor === b.minor;
}
function run(command, args, cwd = root) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    });
  } catch {
    throw new IdentityError("COMMAND_FAILED");
  }
}

/** Check the index, tracked working tree and untracked source, including submodules. */
export function readSelectedSource(repoRoot, sourceCommit) {
  requireValue(typeof sourceCommit === "string" && sha.test(sourceCommit), "SOURCE_SHA");
  requireValue(run("git", ["rev-parse", "HEAD"], repoRoot).trim() === sourceCommit, "SOURCE_MISMATCH");
  requireValue(
    run("git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], repoRoot) === "",
    "DIRTY_SOURCE",
  );
  const manifest = json(join(repoRoot, "package.json"));
  const compatibility = json(join(repoRoot, "release-compatibility.json"));
  requireValue(text(manifest.version), "ROOT_VERSION");
  requireValue(text(compatibility.storeEpoch) && protocol(compatibility.protocol), "COMPATIBILITY");
  return {
    sourceCommit,
    releaseVersion: manifest.version,
    packageManager: manifest.packageManager,
    storeEpoch: compatibility.storeEpoch,
    protocol: compatibility.protocol,
    lockfileSha256: hash(readFileSync(join(repoRoot, "pnpm-lock.yaml"))),
  };
}

/** This is a producer's input check, not a second artifact/manifest validator. */
function checkMetadata(metadata, source) {
  requireValue(metadata.sourceCommit === source.sourceCommit, "METADATA_SOURCE");
  requireValue(metadata.appVersion === source.releaseVersion, "APP_VERSION");
  requireValue(
    metadata.bundleId === APPROVED_BUNDLE_ID && metadata.expectedTeamId === EXPECTED_TEAM_ID,
    "APPROVED_IDENTITY",
  );
  requireValue(metadata.platform === "darwin" && metadata.arch === "arm64", "TARGET");
  requireValue(sameProtocol(metadata.protocol, source.protocol), "METADATA_PROTOCOL");
  // No SemVer-to-plist conversion; D5 remains an owner decision.
  requireValue(text(metadata.bundleShortVersion) && text(metadata.bundleVersion), "PLIST_VERSIONS_REQUIRED");
  requireValue(
    typeof metadata.buildId === "string" && /^gha:[0-9]+:[0-9]+:mac-arm64$/.test(metadata.buildId),
    "BUILD_ID",
  );
  requireValue(
    [metadata.xcode, metadata.macos].every((v) => typeof v === "string" && exactVersion.test(v)),
    "NATIVE_VERSIONS_REQUIRED",
  );
}

export function checkFixtureMetadata(metadata, source) {
  requireValue(metadata?.kind === "fixture", "FIXTURE_ONLY");
  checkMetadata(metadata, source);
}

export function checkCandidateMetadata(metadata, source) {
  requireValue(metadata?.kind === "candidate", "CANDIDATE_POLICY");
  checkMetadata(metadata, source);
  requireValue(
    typeof metadata.minimumMacOS === "string" && /^[0-9]+(?:\.[0-9]+)*$/.test(metadata.minimumMacOS),
    "MINIMUM_OS_REQUIRED",
  );
}

/** All output fields are delivery-v1 fields; provenance stays outside the identity. */
function assembleIdentity(
  { source, metadata, compiledProtocol, hello, daemonBytes, expectedDaemonSha256, toolchain, builtAt },
  check,
) {
  check(metadata, source);
  requireValue(
    sameProtocol(compiledProtocol, source.protocol) && sameProtocol(hello?.protocol, compiledProtocol),
    "BUILD_PROTOCOL",
  );
  requireValue(hello?.authenticated === true && hello.orcaVersion === source.releaseVersion, "DAEMON_VERSION");
  requireValue(Buffer.isBuffer(daemonBytes) && daemonBytes.length > 0, "DAEMON_BYTES");
  requireValue(
    typeof expectedDaemonSha256 === "string" &&
      digest.test(expectedDaemonSha256) &&
      hash(daemonBytes) === expectedDaemonSha256,
    "DAEMON_HASH",
  );
  requireValue(
    ["electron", "electronBuilder", "node", "pnpm"].every(
      (key) => typeof toolchain?.[key] === "string" && exactVersion.test(toolchain[key]),
    ),
    "TOOLCHAIN",
  );
  requireValue(
    typeof builtAt === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(builtAt) &&
      Number.isFinite(Date.parse(builtAt)) &&
      new Date(builtAt).toISOString() === builtAt,
    "BUILD_TIME",
  );
  return {
    schemaVersion: 1,
    releaseVersion: source.releaseVersion,
    bundleId: APPROVED_BUNDLE_ID,
    platform: "darwin",
    arch: "arm64",
    sourceCommit: source.sourceCommit,
    buildId: metadata.buildId,
    builtAt,
    appVersion: metadata.appVersion,
    bundleShortVersion: metadata.bundleShortVersion,
    bundleVersion: metadata.bundleVersion,
    daemon: { path: daemonResource, sha256: hash(daemonBytes), version: hello.orcaVersion },
    protocol: { major: compiledProtocol.major, minor: compiledProtocol.minor },
    storeEpoch: source.storeEpoch,
    toolchain: {
      electron: toolchain.electron,
      electronBuilder: toolchain.electronBuilder,
      node: toolchain.node,
      pnpm: toolchain.pnpm,
      xcode: metadata.xcode,
      macos: metadata.macos,
    },
  };
}

export function assembleFixtureIdentity(inputs) {
  return assembleIdentity(inputs, checkFixtureMetadata);
}

/** Candidate callers must supply observed native values; no synthetic mode conversion. */
export function assembleCandidateIdentity(inputs) {
  return assembleIdentity(inputs, checkCandidateMetadata);
}

/** Resolve installed tools against the selected lock, never package manifest ranges. */
function resolvedTools(source) {
  const appRequire = createRequire(join(root, "packages/app/package.json"));
  const rootRequire = createRequire(join(root, "package.json"));
  const builderRequire = createRequire(appRequire.resolve("electron-builder"));
  const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const { loadAll } = libRequire("js-yaml");
  // pnpm 12 has separate package-manager and workspace YAML documents.
  const lock = loadAll(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).find(
    (doc) => doc?.importers?.["packages/app"],
  );
  requireValue(lock, "LOCKFILE");
  requireValue(libRequire("semver").valid(source.releaseVersion) === source.releaseVersion, "ROOT_VERSION");
  const toolchain = {};
  for (const [name, field, importer, resolver] of [
    ["electron", "electron", "packages/app", appRequire],
    ["electron-builder", "electronBuilder", "packages/app", appRequire],
    ["esbuild", "esbuild", "packages/app", appRequire],
    ["typescript", "typescript", ".", rootRequire],
  ]) {
    const version = resolver(`${name}/package.json`).version;
    requireValue(version === lock.importers[importer].devDependencies[name].version.split("(")[0], "LOCKED_TOOLCHAIN");
    toolchain[field] = version;
  }
  const pnpm = run("pnpm", ["--version"]).trim();
  requireValue(source.packageManager === `pnpm@${pnpm}`, "PACKAGE_MANAGER");
  return { ...toolchain, node: process.versions.node, pnpm };
}

/** Reuse locked compilation and the owned authenticated daemon probe in both modes. */
export async function collectBuildIdentity({ source, metadata, daemonPath, expectedDaemonSha256, candidate }) {
  const tools = resolvedTools(source);
  requireValue(lstatSync(daemonPath).isFile(), "DAEMON_FILE");
  const daemonBytes = readFileSync(daemonPath);
  requireValue(digest.test(expectedDaemonSha256) && hash(daemonBytes) === expectedDaemonSha256, "DAEMON_HASH");
  const scratch = mkdtempSync(join(tmpdir(), "orca-build-identity-"));
  try {
    run("pnpm", ["exec", "tsc", "-b", "tsconfig.build.json", "--force"]);
    if (candidate) run("pnpm", ["--filter", "@orca/app", "run", "build:renderer"]);
    const freshBundle = join(scratch, "orca-daemon.mjs");
    run(process.execPath, ["scripts/build-daemon.js", "--outfile", freshBundle], join(root, "packages/app"));
    requireValue(readFileSync(freshBundle).equals(daemonBytes), "STALE_DAEMON");
    const compiledProtocol = JSON.parse(
      run(process.execPath, [
        "--input-type=module",
        "-e",
        'import { PROTOCOL_VERSION } from "./packages/protocol/dist/index.js"; console.log(JSON.stringify(PROTOCOL_VERSION));',
      ]),
    );
    const { probeBundledDaemon } = await import("../../../tools/probe-bundled-daemon.js");
    const hello = await probeBundledDaemon({ bundlePath: freshBundle });
    requireValue(
      JSON.stringify(readSelectedSource(root, source.sourceCommit)) === JSON.stringify(source),
      "SOURCE_CHANGED",
    );
    requireValue(readFileSync(daemonPath).equals(daemonBytes), "DAEMON_CHANGED");
    const { esbuild: _esbuild, typescript: _typescript, ...toolchain } = tools;
    const identity = (candidate ? assembleCandidateIdentity : assembleFixtureIdentity)({
      source,
      metadata,
      compiledProtocol,
      hello,
      daemonBytes,
      expectedDaemonSha256,
      toolchain,
      builtAt: new Date().toISOString(),
    });
    return { identity, tools };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Rebuild selected source, compare the staged daemon, and reuse the authenticated probe. */
export async function produceFixtureIdentity({
  mode,
  sourceCommit,
  metadata,
  daemonPath,
  expectedDaemonSha256,
  output,
}) {
  requireValue(mode === "fixture", "FIXTURE_ONLY");
  const source = readSelectedSource(root, sourceCommit);
  checkFixtureMetadata(metadata, source);
  const { identity, tools } = await collectBuildIdentity({
    source,
    metadata,
    daemonPath,
    expectedDaemonSha256,
    candidate: false,
  });
  const { esbuild, typescript } = tools;
  // A new directory only: no overwriting an existing identity or a packaged app.
  mkdirSync(output);
  writeFileSync(join(output, "orca-build.json"), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
  writeFileSync(
    join(output, "fixture-provenance.json"),
    `${JSON.stringify(
      {
        kind: "fixture",
        sourceCommit,
        lockfileSha256: source.lockfileSha256,
        identitySha256: hash(readFileSync(join(output, "orca-build.json"))),
        expectedTeamId: EXPECTED_TEAM_ID,
        esbuild,
        typescript,
        hostPlatform: process.platform,
        hostArch: process.arch,
        syntheticFields: ["buildId", "bundleShortVersion", "bundleVersion", "toolchain.xcode", "toolchain.macos"],
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  return identity;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        ["mode", "source-commit", "metadata", "daemon", "daemon-sha256", "output"].map((key) => [
          key,
          { type: "string" },
        ]),
      ),
    });
    requireValue(values.mode === "fixture", "FIXTURE_ONLY");
    requireValue(
      ["source-commit", "metadata", "daemon", "daemon-sha256", "output"].every((key) => text(values[key])),
      "USAGE",
    );
    await produceFixtureIdentity({
      mode: values.mode,
      sourceCommit: values["source-commit"],
      metadata: json(values.metadata),
      daemonPath: resolve(values.daemon),
      expectedDaemonSha256: values["daemon-sha256"],
      output: resolve(values.output),
    });
    console.log("Fixture identity written; no candidate or native acceptance.");
  } catch (error) {
    console.error(error instanceof IdentityError ? error.message : "Native Mac identity refused [LOCAL_SETUP]");
    process.exitCode = 1;
  }
}
