/** Prepare exact #388 command vectors; execute nothing and preserve all native acceptance gates. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { IdentityError, readSelectedSource } from "../../packages/app/scripts/native-mac-identity.js";
import { macStagingPlan, PackagingPlanError } from "./packaging-plan.js";
import { createMacAppEnvironment, LaunchEnvironmentError } from "./launch-environment.js";
import { SYSTEM_PATH } from "./executor-preflight.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pathKeys = ["stapledApp", "dmg", "zip", "dmgApp", "zipApp"];
export class AcceptancePacketError extends Error {
  constructor(code) {
    super(`Mac acceptance packet refused [${code}]`);
    this.code = code;
  }
}
function path(value, suffix) {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    value.isWellFormed() &&
    value.startsWith("/") &&
    posix.normalize(value) === value &&
    value.endsWith(suffix) &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

/** Local execution selections, not a delivery manifest or evidence; paths are lexical observations only. */
export function createAcceptancePacket(source, ordinaryMac, input) {
  const staging = macStagingPlan(source, ordinaryMac);
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some((key) => ![...pathKeys, "accountHome", "temporaryDirectory"].includes(key)) ||
    !pathKeys.every((key) => path(input[key], key.endsWith("App") ? "/ORCA.app" : `.${key}`))
  ) {
    throw new AcceptancePacketError("INPUT");
  }
  const selected = pathKeys.map((key) => input[key]);
  if (
    new Set(selected).size !== selected.length ||
    selected.some((value) => selected.some((other) => value !== other && value.startsWith(`${other}/`)))
  ) {
    throw new AcceptancePacketError("DISTINCT_TARGETS");
  }
  const appEnvironment = createMacAppEnvironment({
    accountHome: input.accountHome,
    temporaryDirectory: input.temporaryDirectory,
  });
  const observe = (id, command, args, oracle) => ({
    id,
    command,
    args,
    env: { PATH: SYSTEM_PATH, LANG: "C" },
    timeoutMs: 30000,
    maxBufferBytes: 16384,
    state: "not-run",
    oracle,
  });
  const copies = ["dmg", "zip"].map((format) => {
    const app = input[`${format}App`];
    return {
      format,
      observations: [
        observe(`${format}-signature`, "/usr/bin/codesign", ["--verify", "--deep", "--strict", app], "exit 0"),
        observe(
          `${format}-publisher`,
          "/usr/bin/codesign",
          ["--display", "--verbose=4", app],
          "Match approved Developer ID authority, Team Q2FP9UY5T4 and hardened runtime; public fingerprint/expiry need the native verifier",
        ),
        observe(
          `${format}-entitlements`,
          "/usr/bin/codesign",
          ["--display", "--entitlements", ":-", app],
          "Exact reviewed entitlement policy; observation is not recursive per-file policy verification",
        ),
        observe(`${format}-ticket`, "/usr/bin/xcrun", ["stapler", "validate", app], "exit 0; enclosed app ticket"),
        {
          ...observe(
            `${format}-gatekeeper`,
            "/usr/bin/syspolicy_check",
            ["distribution", app],
            "exit 0 on macOS 14+; physical browser/Finder first-open remains separate",
          ),
          requires: ["MACOS_14_PLUS_DISTRIBUTION_CHECK"],
        },
        observe(
          `${format}-architecture`,
          "/usr/bin/lipo",
          ["-archs", `${app}/Contents/MacOS/ORCA`],
          "arm64 only; record actual app and owned daemon process architecture separately",
        ),
        observe(
          `${format}-identity`,
          "/usr/bin/shasum",
          ["-a", "256", `${app}/Contents/Resources/orca-build.json`],
          "Match trusted delivery-v1 identitySha256, then compare parsed identity/plist to selected source/build",
        ),
        observe(
          `${format}-daemon`,
          "/usr/bin/shasum",
          ["-a", "256", `${app}/Contents/Resources/daemon/orca-daemon.mjs`],
          "Match trusted delivery-v1 daemon.sha256; JavaScript has no separate Mach-O architecture",
        ),
      ],
      launch: {
        command: `${app}/Contents/MacOS/ORCA`,
        args: [],
        env: appEnvironment,
        state: "blocked",
        requires: [
          "SIGNED_CANDIDATE_VALIDATOR",
          "OWNED_EXTRACTION_AND_ISOLATION",
          "ARM64_GUI_EXECUTOR",
          "SIGNED_APP_AUTOMATION",
        ],
        oracle: "Real Config setup/Launch work actions, authenticated app-owned daemon and actual runtime architecture",
      },
    };
  });
  return {
    scope: "mac-acceptance-command-packet-only",
    sourceCommit: staging.sourceCommit,
    sourceVersion: staging.sourceVersion,
    lockfileSha256: staging.lockfileSha256,
    protocol: staging.protocol,
    storeEpoch: staging.storeEpoch,
    workers: 1,
    retries: 0,
    candidateAcceptance: "blocked",
    evidence: "Private local selections; never upload raw tool output, paths or packet without sanitization",
    containerPreparation: {
      command: "pnpm",
      args: [
        "--filter",
        "@orca/app",
        "exec",
        "electron-builder",
        "--mac",
        "dmg",
        "zip",
        "--arm64",
        "--prepackaged",
        input.stapledApp,
        "--publish",
        "never",
        `-c.extraMetadata.version=${source.releaseVersion}`,
        "-c.directories.output=dist/release/mac-beta-containers",
      ],
      state: "blocked",
      requires: [
        "PRODUCTION_IDENTITY_BEFORE_SIGNING",
        "SIGNED_NOTARIZED_STAPLED_APP",
        "APPROVED_VERSION_PLIST_OS_POLICY",
      ],
      oracle:
        "One DMG and ZIP from the same accepted app; prepackaged skips signing hooks; DMG notary/staple is still required",
    },
    observations: [
      observe(
        "dmg-digest",
        "/usr/bin/shasum",
        ["-a", "256", input.dmg],
        "Match expected final DMG digest from trusted metadata",
      ),
      observe(
        "zip-digest",
        "/usr/bin/shasum",
        ["-a", "256", input.zip],
        "Match expected final ZIP digest from trusted metadata",
      ),
      observe("dmg-ticket", "/usr/bin/xcrun", ["stapler", "validate", input.dmg], "exit 0; final DMG ticket"),
      observe(
        "dmg-gatekeeper",
        "/usr/sbin/spctl",
        ["--assess", "--type", "open", "--context", "context:primary-signature", input.dmg],
        "exit 0 for the final DMG; physical browser/Finder first-open remains separate",
      ),
    ],
    copies,
    remainingGates: [
      "PRODUCTION_IDENTITY_PRODUCER",
      "SIGNED_CANDIDATE_VALIDATOR",
      "NATIVE_CONTAINER_CONTAINMENT",
      "TRUSTED_METADATA_AND_PRIVATE_DELIVERY",
      "ACTUAL_ARM64_APP_AND_DAEMON_EXECUTION",
      "GATE_ARTIFACT_CANCEL_FIXTURES",
      "FIRST_RUN_ORPHAN_RECOVERY_570",
      "REAL_AGENT_CONFIGURATION_PERSISTENCE",
      "SIGNED_N_TO_N_PLUS_1_RECOVERY",
      "NATIVE_DIAGNOSTICS_PRIVACY",
      "PHYSICAL_UNASSISTED_WALKTHROUGH",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = [
      "source-commit",
      "stapled-app",
      "dmg",
      "zip",
      "dmg-app",
      "zip-app",
      "account-home",
      "temporary-directory",
    ];
    const { values, tokens } = parseArgs({
      options: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
      tokens: true,
    });
    const selectedOptions = tokens.filter((token) => token.kind === "option").map((token) => token.name);
    if (new Set(selectedOptions).size !== selectedOptions.length) throw new AcceptancePacketError("DUPLICATE_OPTION");
    const source = readSelectedSource(root, values["source-commit"]);
    const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
    const builderRequire = createRequire(appRequire.resolve("electron-builder"));
    const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
    const ordinary = libRequire("js-yaml").load(
      readFileSync(new URL("../../packages/app/electron-builder.yml", import.meta.url), "utf8"),
    );
    const packet = createAcceptancePacket(source, ordinary.mac, {
      stapledApp: values["stapled-app"],
      dmg: values.dmg,
      zip: values.zip,
      dmgApp: values["dmg-app"],
      zipApp: values["zip-app"],
      accountHome: values["account-home"],
      temporaryDirectory: values["temporary-directory"],
    });
    if (JSON.stringify(readSelectedSource(root, source.sourceCommit)) !== JSON.stringify(source)) {
      throw new AcceptancePacketError("SOURCE_CHANGED");
    }
    console.log(JSON.stringify(packet, null, 2));
  } catch (error) {
    const known = [AcceptancePacketError, IdentityError, PackagingPlanError, LaunchEnvironmentError];
    const code = known.some((type) => error instanceof type) ? error.code : "USAGE_OR_SETUP";
    console.error(JSON.stringify({ scope: "mac-acceptance-command-packet-only", status: "blocked", code }));
    process.exitCode = 2;
  }
}
