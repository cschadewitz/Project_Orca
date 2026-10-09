/** Synthetic producer inputs and workflow observations; no Mac signing or native acceptance. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assembleCandidateIdentity } from "../../packages/app/scripts/native-mac-identity.js";
import {
  checkWorkflowIdentity,
  checkPackagedFacts,
  produceCandidateIdentity,
  verifyCompiledApp,
} from "../../packages/app/scripts/native-mac-candidate-identity.js";

const scratch = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const source = {
    sourceCommit: "a".repeat(40),
    releaseVersion: "0.0.0-controlled.1",
    protocol: { major: 2, minor: 0 },
    storeEpoch: "controlled",
  };
  const policy = {
    kind: "candidate",
    sourceCommit: source.sourceCommit,
    appVersion: source.releaseVersion,
    bundleId: "com.schadewitz.orca",
    expectedTeamId: "Q2FP9UY5T4",
    platform: "darwin",
    arch: "arm64",
    protocol: source.protocol,
    buildId: "gha:12:3:mac-arm64",
    workflowRef: "cschadewitz/Project_Orca/.github/workflows/controlled.yml@refs/heads/controlled",
    workflowSha: "b".repeat(40),
    bundleShortVersion: "0.0.0",
    bundleVersion: "0007.02",
    minimumMacOS: "14.0",
  };
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "cschadewitz/Project_Orca",
    GITHUB_SHA: source.sourceCommit,
    GITHUB_RUN_ID: "12",
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_WORKFLOW_REF: policy.workflowRef,
    GITHUB_WORKFLOW_SHA: policy.workflowSha,
  };
  const plist = {
    CFBundleIdentifier: policy.bundleId,
    CFBundleShortVersionString: policy.bundleShortVersion,
    CFBundleVersion: policy.bundleVersion,
    LSMinimumSystemVersion: policy.minimumMacOS,
    CFBundleExecutable: "ORCA",
  };
  return { source, policy, env, plist };
}

it("requires the exact workflow/run/attempt/source on native arm64 before admitting production identity", () => {
  const { policy, env } = fixture();
  expect(() => checkWorkflowIdentity(policy, env, { platform: "darwin", arch: "arm64" })).not.toThrow();
  for (const key of Object.keys(env)) {
    expect(() =>
      checkWorkflowIdentity(policy, { ...env, [key]: "other" }, { platform: "darwin", arch: "arm64" }),
    ).toThrow("TRUSTED_WORKFLOW_REQUIRED");
  }
});

it.each([
  { platform: "linux", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
])("refuses unsupported native host %j", (host) => {
  const { policy, env } = fixture();
  expect(() => checkWorkflowIdentity(policy, env, host)).toThrow("NATIVE_ARM64_REQUIRED");
});

it("compares actual plist strings and package version with explicit candidate policy", () => {
  const { policy, source, plist } = fixture();
  const metadata = checkPackagedFacts(policy, source, plist, source.releaseVersion, "14.7.1", "16.1");
  expect(metadata.bundleVersion).toBe("0007.02");
  expect(metadata.macos).toBe("14.7.1");
  expect(metadata.xcode).toBe("16.1");
  for (const key of Object.keys(plist)) {
    expect(() =>
      checkPackagedFacts(policy, source, { ...plist, [key]: 7 }, source.releaseVersion, "14.7.1", "16.1"),
    ).toThrow("PACKAGED_PLIST_MISMATCH");
  }
  expect(() =>
    checkPackagedFacts({ ...policy, appVersion: "99.0.0" }, source, plist, source.releaseVersion, "14.7.1", "16.1"),
  ).toThrow("APP_VERSION_POLICY");
});

it.each(["bundleShortVersion", "bundleVersion", "minimumMacOS"])(
  "refuses unresolved %s without guessing a mapping",
  (key) => {
    const { policy, source, plist } = fixture();
    delete policy[key];
    expect(() => checkPackagedFacts(policy, source, plist, source.releaseVersion, "14.7.1", "16.1")).toThrow();
  },
);

it("production assembly uses the existing delivery-v1 fields and authenticated compiled daemon contract", () => {
  const { policy, source, plist } = fixture();
  const daemonBytes = Buffer.from("// controlled source bytes\n");
  const inputs = {
    source,
    metadata: checkPackagedFacts(policy, source, plist, source.releaseVersion, "14.7.1", "16.1"),
    compiledProtocol: source.protocol,
    hello: { authenticated: true, orcaVersion: source.releaseVersion, protocol: source.protocol },
    daemonBytes,
    expectedDaemonSha256: createHash("sha256").update(daemonBytes).digest("hex"),
    toolchain: { electron: "44.4.5", electronBuilder: "26.15.3", node: "24.19.0", pnpm: "12.4.2" },
    builtAt: "2000-01-01T00:00:00.000Z",
  };
  const identity = assembleCandidateIdentity(inputs);
  expect(identity.buildId).toBe(policy.buildId);
  expect(identity).not.toHaveProperty("kind");
  expect(identity).not.toHaveProperty("workflowRef");
  expect(() => assembleCandidateIdentity({ ...inputs, metadata: { ...inputs.metadata, kind: "fixture" } })).toThrow(
    "CANDIDATE_POLICY",
  );
  expect(() => assembleCandidateIdentity({ ...inputs, hello: { ...inputs.hello, authenticated: false } })).toThrow(
    "DAEMON_VERSION",
  );
  expect(() => assembleCandidateIdentity({ ...inputs, compiledProtocol: { major: 99, minor: 0 } })).toThrow(
    "BUILD_PROTOCOL",
  );
});

it("actual producer refuses Linux before reading or writing nonexistent selected paths", async () => {
  if (process.platform !== "linux") return;
  await expect(
    produceCandidateIdentity({
      policy: fixture().policy,
      app: "/nonexistent/ORCA.app",
      output: "/nonexistent/receipt",
    }),
  ).rejects.toThrow("NATIVE_ARM64_REQUIRED");
});

it("real locked ASAR parsing checks fresh bytes and complete compiled-file coverage", async () => {
  const base = mkdtempSync(join(tmpdir(), "orca-candidate-asar-"));
  scratch.push(base);
  const compiled = join(base, "compiled");
  const app = join(base, "ORCA.app");
  const protocolRoot = join(base, "protocol");
  mkdirSync(join(compiled, "dist/main"), { recursive: true });
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  writeFileSync(join(compiled, "package.json"), JSON.stringify({ version: "0.0.0-controlled" }));
  writeFileSync(join(compiled, "dist/main/index.js"), "// controlled inert compiled bytes\n");
  mkdirSync(join(compiled, "node_modules/@orca/protocol/dist"), { recursive: true });
  mkdirSync(join(protocolRoot, "dist"), { recursive: true });
  writeFileSync(join(protocolRoot, "dist/index.js"), "// controlled compiled protocol\n");
  writeFileSync(join(compiled, "node_modules/@orca/protocol/dist/index.js"), "// controlled compiled protocol\n");
  const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
  const builderRequire = createRequire(appRequire.resolve("electron-builder"));
  const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
  await asar.createPackage(compiled, join(app, "Contents/Resources/app.asar"));
  expect(() => verifyCompiledApp(app, compiled, protocolRoot)).not.toThrow();
  writeFileSync(join(compiled, "dist/main/index.js"), "// changed source output\n");
  expect(() => verifyCompiledApp(app, compiled, protocolRoot)).toThrow("STALE_PACKAGED_APP");
  writeFileSync(join(compiled, "dist/main/index.js"), "// controlled inert compiled bytes\n");
  mkdirSync(join(compiled, "dist/preload"));
  writeFileSync(join(compiled, "dist/preload/index.cjs"), "// omitted compiled preload\n");
  expect(() => verifyCompiledApp(app, compiled, protocolRoot)).toThrow("PACKAGED_BUILD_COVERAGE");
  rmSync(join(compiled, "dist/preload"), { recursive: true });
  writeFileSync(join(protocolRoot, "dist/index.js"), "// changed compiled protocol\n");
  expect(() => verifyCompiledApp(app, compiled, protocolRoot)).toThrow("STALE_PACKAGED_APP");
});
