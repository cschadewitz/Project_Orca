/** Observe and seal delivery-v1 identity before signing; explicit native builder input only. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  IdentityError,
  readSelectedSource,
  checkCandidateMetadata,
  collectBuildIdentity,
} from "./native-mac-identity.js";
import { verifyPackagedDiagnostics } from "./diagnostics-native-package.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const appRoot = join(root, "packages/app");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireValue(condition, code) {
  if (!condition) throw new IdentityError(code);
}
function boundedFile(path, limit) {
  const info = lstatSync(path);
  requireValue(info.isFile() && info.size > 0 && info.size <= limit, "PACKAGED_FILE");
  const data = readFileSync(path);
  requireValue(data.length === info.size, "PACKAGED_CHANGED");
  return data;
}

/** Public workflow facts must match operator-selected provenance; protection is external. */
export function checkWorkflowIdentity(policy, env, host) {
  requireValue(host.platform === "darwin" && host.arch === "arm64", "NATIVE_ARM64_REQUIRED");
  requireValue(
    policy?.kind === "candidate" &&
      env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_REPOSITORY === "cschadewitz/Project_Orca" &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") &&
      policy.sourceCommit === env.GITHUB_SHA &&
      policy.buildId === `gha:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:mac-arm64` &&
      typeof policy.workflowRef === "string" &&
      /^cschadewitz\/Project_Orca\/\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml@.+$/.test(policy.workflowRef) &&
      policy.workflowRef === env.GITHUB_WORKFLOW_REF &&
      /^[a-f0-9]{40}$/.test(policy.workflowSha ?? "") &&
      policy.workflowSha === env.GITHUB_WORKFLOW_SHA,
    "TRUSTED_WORKFLOW_REQUIRED",
  );
}

function native(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    });
  } catch {
    throw new IdentityError("NATIVE_OBSERVATION_FAILED");
  }
}

export function checkPackagedFacts(policy, source, plist, packageVersion, macos, xcode) {
  requireValue(policy.appVersion === packageVersion, "APP_VERSION_POLICY");
  const observed = { ...policy, appVersion: packageVersion, macos, xcode };
  checkCandidateMetadata(observed, source);
  for (const [field, expected] of [
    ["CFBundleIdentifier", policy.bundleId],
    ["CFBundleShortVersionString", policy.bundleShortVersion],
    ["CFBundleVersion", policy.bundleVersion],
    ["LSMinimumSystemVersion", policy.minimumMacOS],
    ["CFBundleExecutable", "ORCA"],
  ])
    requireValue(typeof plist?.[field] === "string" && plist[field] === expected, "PACKAGED_PLIST_MISMATCH");
  return observed;
}

function asarReader(app) {
  const path = join(app, "Contents/Resources/app.asar");
  const info = lstatSync(path);
  requireValue(info.isFile() && info.size > 16 && info.size <= 512 * 1024 * 1024, "ASAR_BYTES");
  const descriptor = openSync(path, "r");
  const prefix = Buffer.alloc(16);
  try {
    requireValue(readSync(descriptor, prefix, 0, 16, 0) === 16, "ASAR_HEADER");
  } finally {
    closeSync(descriptor);
  }
  requireValue(
    prefix.readUInt32LE(0) === 4 &&
      prefix.readUInt32LE(4) <= 16 * 1024 * 1024 &&
      prefix.readUInt32LE(8) === prefix.readUInt32LE(4) - 4 &&
      prefix.readUInt32LE(12) <= prefix.readUInt32LE(4) - 8,
    "ASAR_HEADER",
  );
  const appRequire = createRequire(join(appRoot, "package.json"));
  const builderRequire = createRequire(appRequire.resolve("electron-builder"));
  const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
  asar.uncache(path);
  return { path, asar };
}

/** Recompiled bytes must equal the already packed main/preload/protocol output. */
export function verifyCompiledApp(app, compiledRoot = appRoot, protocolRoot = join(root, "packages/protocol")) {
  const { path, asar } = asarReader(app);
  let files = 0;
  let bytes = 0;
  const packed = new Set();
  const packedProtocol = new Set();
  for (const name of asar.listPackage(path)) {
    requireValue(++files <= 100_000, "ASAR_ENTRY_LIMIT");
    const isProtocol = name.startsWith("/node_modules/@orca/protocol/dist/") && name.endsWith(".js");
    if (!name.startsWith("/dist/") && !isProtocol) continue;
    const entry = asar.statFile(path, name.slice(1), false);
    if (entry.files) continue;
    requireValue(
      !entry.link && !entry.unpacked && Number.isSafeInteger(entry.size) && entry.size <= 512 * 1024 * 1024,
      "ASAR_BUILD_FILE",
    );
    bytes += entry.size;
    requireValue(bytes <= 512 * 1024 * 1024, "ASAR_BUILD_BYTES");
    const base = isProtocol ? protocolRoot : compiledRoot;
    const file = isProtocol ? name.slice("/node_modules/@orca/protocol/".length) : name.slice(1);
    const local = join(base, file);
    requireValue(relative(base, local).startsWith("dist/"), "ASAR_BUILD_PATH");
    (isProtocol ? packedProtocol : packed).add(file);
    requireValue(
      hash(asar.extractFile(path, name.slice(1))) === hash(boundedFile(local, 512 * 1024 * 1024)),
      "STALE_PACKAGED_APP",
    );
  }
  requireValue(files > 0 && asar.statFile(path, "dist/main/index.js", false).size > 0, "PACKAGED_MAIN_REQUIRED");
  const expected = new Set();
  const pending = ["dist"];
  while (pending.length) {
    const name = pending.pop();
    if (["dist/daemon", "dist/release", "dist/diagnostics-native"].includes(name)) continue;
    const info = lstatSync(join(compiledRoot, name));
    requireValue(!info.isSymbolicLink(), "COMPILED_SYMLINK");
    if (info.isDirectory()) {
      for (const child of readdirSync(join(compiledRoot, name))) {
        requireValue(pending.length + expected.size < 100_000, "COMPILED_ENTRY_LIMIT");
        pending.push(name + "/" + child);
      }
    } else {
      requireValue(info.isFile(), "COMPILED_REGULAR_FILE");
      if (!/\.(?:d\.ts|tsbuildinfo|map)$/.test(name)) expected.add(name);
    }
  }
  requireValue(
    expected.size === packed.size && [...expected].every((name) => packed.has(name)),
    "PACKAGED_BUILD_COVERAGE",
  );
  const protocolFiles = new Set();
  const protocolPending = ["dist"];
  while (protocolPending.length) {
    const name = protocolPending.pop();
    const info = lstatSync(join(protocolRoot, name));
    requireValue(!info.isSymbolicLink(), "COMPILED_PROTOCOL_SYMLINK");
    if (info.isDirectory()) {
      for (const child of readdirSync(join(protocolRoot, name))) {
        requireValue(protocolPending.length + protocolFiles.size < 100_000, "COMPILED_PROTOCOL_LIMIT");
        protocolPending.push(name + "/" + child);
      }
    } else if (name.endsWith(".js")) protocolFiles.add(name);
  }
  requireValue(
    protocolFiles.has("dist/index.js") &&
      protocolFiles.size === packedProtocol.size &&
      [...protocolFiles].every((name) => packedProtocol.has(name)),
    "PACKAGED_PROTOCOL_COVERAGE",
  );
}

export async function produceCandidateIdentity({ policy, app, output }) {
  // Refuse unsupported/fixture paths before filesystem reads or build activity.
  checkWorkflowIdentity(policy, process.env, { platform: process.platform, arch: process.arch });
  const source = readSelectedSource(root, policy.sourceCommit);
  app = resolve(app);
  requireValue(app.endsWith("/ORCA.app") && lstatSync(app).isDirectory(), "PACKAGED_APP_REQUIRED");
  for (const suffix of ["Contents", "Contents/Resources", "Contents/MacOS", "Contents/Resources/daemon"])
    requireValue(lstatSync(join(app, suffix)).isDirectory(), "PACKAGED_DIRECTORY_REQUIRED");
  const unsigned = spawnSync("/usr/bin/codesign", ["--display", app], {
    timeout: 30_000,
    maxBuffer: 16 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  requireValue(
    unsigned.status === 1 && unsigned.stderr?.toString("utf8").includes("code object is not signed at all"),
    "BEFORE_SIGNING_REQUIRED",
  );
  const plistPath = join(app, "Contents/Info.plist");
  const plistBytes = boundedFile(plistPath, 1024 * 1024);
  const plist = JSON.parse(native("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]));
  const { path, asar } = asarReader(app);
  const packageInfo = asar.statFile(path, "package.json", false);
  requireValue(!packageInfo.link && !packageInfo.unpacked && packageInfo.size <= 1024 * 1024, "PACKAGED_METADATA");
  const packageVersion = JSON.parse(asar.extractFile(path, "package.json").toString("utf8")).version;
  const macos = native("/usr/bin/sw_vers", ["-productVersion"]).trim();
  const xcodeOutput = native("/usr/bin/xcodebuild", ["-version"]);
  const match = /^Xcode ([0-9]+(?:\.[0-9]+)*)\nBuild version [A-Za-z0-9]+\n?$/.exec(xcodeOutput);
  requireValue(match, "XCODE_REQUIRED");
  const metadata = checkPackagedFacts(policy, source, plist, packageVersion, macos, match[1]);
  const electronPlistPath = join(
    app,
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist",
  );
  const electronPlistBytes = boundedFile(electronPlistPath, 1024 * 1024);
  const electronPlist = JSON.parse(native("/usr/bin/plutil", ["-convert", "json", "-o", "-", electronPlistPath]));
  const executable = join(app, "Contents/MacOS/ORCA");
  requireValue(
    lstatSync(executable).isFile() && native("/usr/bin/lipo", ["-archs", executable]).trim() === "arm64",
    "PACKAGED_ARCH",
  );
  const daemonPath = join(app, "Contents/Resources/daemon/orca-daemon.mjs");
  const expectedDaemonSha256 = hash(boundedFile(daemonPath, 64 * 1024 * 1024));
  const { identity, tools } = await collectBuildIdentity({
    source,
    metadata,
    daemonPath,
    expectedDaemonSha256,
    candidate: true,
  });
  verifyCompiledApp(app);
  requireValue(
    electronPlist.CFBundleVersion === identity.toolchain.electron &&
      readFileSync(electronPlistPath).equals(electronPlistBytes),
    "PACKAGED_ELECTRON_VERSION",
  );
  requireValue(readFileSync(plistPath).equals(plistBytes), "PLIST_CHANGED");
  checkWorkflowIdentity(policy, process.env, { platform: process.platform, arch: process.arch });
  requireValue(
    JSON.stringify(readSelectedSource(root, policy.sourceCommit)) === JSON.stringify(source),
    "SOURCE_CHANGED",
  );
  output = resolve(output);
  requireValue(output !== app && !output.startsWith(app + "/"), "DETACHED_RECEIPT_REQUIRED");
  mkdirSync(output); // New detached receipt directory; failed partial output never promotes.
  const bytes = Buffer.from(JSON.stringify(identity, null, 2) + "\n");
  writeFileSync(join(app, "Contents/Resources/orca-build.json"), bytes, { flag: "wx" });
  writeFileSync(
    join(output, "candidate-provenance.json"),
    JSON.stringify(
      {
        kind: "candidate",
        stage: "before-signing",
        sourceCommit: source.sourceCommit,
        lockfileSha256: source.lockfileSha256,
        identitySha256: hash(bytes),
        identity,
        buildId: identity.buildId,
        workflowRef: policy.workflowRef,
        workflowSha: policy.workflowSha,
        expectedTeamId: policy.expectedTeamId,
        esbuild: tools.esbuild,
        typescript: tools.typescript,
        hostPlatform: process.platform,
        hostArch: process.arch,
        minimumMacOS: policy.minimumMacOS,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  return identity;
}

/** Explicit replacement hook preserves #574 copied-resource verification before identity. */
export default async function afterPackCandidate(context) {
  requireValue(context.electronPlatformName === "darwin", "MAC_ONLY");
  verifyPackagedDiagnostics(context);
  const policyPath = process.env.ORCA_MAC_IDENTITY_POLICY;
  const output = process.env.ORCA_MAC_IDENTITY_RECEIPT;
  requireValue(policyPath && output, "EXPLICIT_POLICY_REQUIRED");
  const policy = JSON.parse(boundedFile(resolve(policyPath), 1024 * 1024).toString("utf8"));
  return produceCandidateIdentity({ policy, app: join(context.appOutDir, "ORCA.app"), output });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { policy: { type: "string" }, app: { type: "string" }, output: { type: "string" } },
    });
    requireValue(values.policy && values.app && values.output, "USAGE");
    requireValue(process.platform === "darwin" && process.arch === "arm64", "NATIVE_ARM64_REQUIRED");
    await produceCandidateIdentity({
      policy: JSON.parse(boundedFile(resolve(values.policy), 1024 * 1024).toString("utf8")),
      app: values.app,
      output: values.output,
    });
    console.log("Pre-signing candidate identity sealed; signing, containers and acceptance remain not run.");
  } catch (error) {
    console.error(error instanceof IdentityError ? error.message : "Native Mac identity refused [LOCAL_SETUP]");
    process.exitCode = 1;
  }
}
