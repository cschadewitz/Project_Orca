/** Emit a source-bound unsigned staging plan; never execute packaging or promote a candidate. */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readSelectedSource, IdentityError } from "../../packages/app/scripts/native-mac-identity.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));

export class PackagingPlanError extends Error {
  constructor(code) {
    super(`Mac packaging plan refused [${code}]`);
    this.code = code;
  }
}

function readers() {
  try {
    const builderRequire = createRequire(appRequire.resolve("electron-builder"));
    const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
    return { validVersion: builderRequire("semver").valid, load: libRequire("js-yaml").load };
  } catch {
    throw new PackagingPlanError("TOOLCHAIN_SETUP");
  }
}

/** Public source facts come from the existing clean-source reader, not a candidate manifest. */
export function macStagingPlan(source, ordinaryMac) {
  const { validVersion } = readers();
  if (
    !source ||
    typeof source.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(source.sourceCommit) ||
    typeof source.releaseVersion !== "string" ||
    validVersion(source.releaseVersion) !== source.releaseVersion ||
    source.packageManager !== "pnpm@12.4.2" ||
    typeof source.lockfileSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.lockfileSha256) ||
    typeof source.storeEpoch !== "string" ||
    !/^[a-z0-9-]{1,64}$/.test(source.storeEpoch) ||
    ![source.protocol?.major, source.protocol?.minor].every((value) => Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new PackagingPlanError("SOURCE_FACTS");
  }
  if (ordinaryMac?.identity !== null || ordinaryMac.notarize !== false) {
    throw new PackagingPlanError("UNSIGNED_POLICY_REQUIRED");
  }
  const step = (id, command, args) => ({ id, command, args, state: "not-run" });
  return {
    scope: "unsigned-staging-plan-only",
    sourceCommit: source.sourceCommit,
    sourceVersion: source.releaseVersion,
    lockfileSha256: source.lockfileSha256,
    protocol: { major: source.protocol.major, minor: source.protocol.minor },
    storeEpoch: source.storeEpoch,
    signedCandidate: "blocked",
    steps: [
      step("executor", "node", ["tools/packaged-mac/executor-preflight.js"]),
      step("frozen-install", "pnpm", ["install", "--frozen-lockfile", "--no-trust-lockfile"]),
      step("build", "pnpm", ["run", "build"]),
      step("daemon-bundle", "pnpm", ["--filter", "@orca/app", "run", "build:daemon"]),
      step("authenticated-bundle-probe", "node", ["tools/probe-bundled-daemon.js"]),
      step("unsigned-directory", "pnpm", [
        "--filter",
        "@orca/app",
        "exec",
        "electron-builder",
        "--mac",
        "dir",
        "--arm64",
        "--publish",
        "never",
        `-c.extraMetadata.version=${source.releaseVersion}`,
        "-c.directories.output=dist/release/mac-beta-staging",
        "-c.mac.identity=null",
      ]),
    ],
    candidateBlockers: [
      "NATIVE_SIGNING_AUTHORITY_UNVERIFIED",
      "NOTARY_METHOD_UNVERIFIED",
      "MACOS_AND_PLIST_POLICY_UNCONFIRMED",
      "SIGNED_IDENTITY_ADAPTER_MISSING",
      "SIGNING_ENTITLEMENT_SEQUENCE_UNPROVEN",
      "NATIVE_CONTAINER_VERIFICATION_UNIMPLEMENTED",
      "PRIVATE_DELIVERY_UNVERIFIED",
      "GUIDED_SAMPLE_BINDING_PENDING",
      "PACKAGED_AND_PHYSICAL_ACCEPTANCE_UNRUN",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { "source-commit": { type: "string" } } });
    const source = readSelectedSource(root, values["source-commit"]);
    const { load } = readers();
    const ordinary = load(readFileSync(new URL("../../packages/app/electron-builder.yml", import.meta.url), "utf8"));
    const plan = macStagingPlan(source, ordinary.mac);
    if (JSON.stringify(readSelectedSource(root, source.sourceCommit)) !== JSON.stringify(source)) {
      throw new PackagingPlanError("SOURCE_CHANGED");
    }
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    const code = error instanceof PackagingPlanError || error instanceof IdentityError ? error.code : "USAGE_OR_SETUP";
    console.error(JSON.stringify({ scope: "unsigned-staging-plan-only", status: "blocked", code }));
    process.exitCode = 2;
  }
}
