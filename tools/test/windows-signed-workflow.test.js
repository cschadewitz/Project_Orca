/** The signed Windows spike: resolve its builder overrides and hold its boundaries in place. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { verifyPackagedUpdatePublishers, verifyUpdatePublisher } from "../packaged-windows/verify-update-publisher.js";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const packagerRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { load } = packagerRequire("js-yaml");
const { configureBuildCommand, normalizeOptions } = builderRequire("./builder.js");
const yargs = builderRequire("yargs/yargs");

const read = (path) => load(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const signed = read(".github/workflows/windows-signed.yml");
const desktop = read(".github/workflows/desktop.yml");
const step = (workflow, job, name) => workflow.jobs[job].steps.find((s) => s.name === name);

const signing = {
  WINDOWS_SIGNING_PUBLISHER_CN: "Jane Q. Example",
  WINDOWS_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
  WINDOWS_SIGNING_ACCOUNT: "orca-signing",
  WINDOWS_SIGNING_PROFILE: "orca-public",
};

it.skipIf(process.platform === "win32")(
  "signs each Windows architecture with the Azure profile and forced signing",
  () => {
    const script = step(signed, "sign", "Package and sign").run;
    for (const version of ["0.7.0", "0.7.0-rc.1"]) {
      const output = execFileSync("bash", ["-c", 'pnpm() { printf "%s\\0" "$@"; printf "\\n"; }\n' + script], {
        env: { ...process.env, ...signing, VERSION: version },
        encoding: "utf8",
      });
      const commands = output.trimEnd().split("\n");
      expect(commands).toHaveLength(2);
      for (const [index, arch] of ["x64", "arm64"].entries()) {
        const args = commands[index].split("\0").filter(Boolean);
        expect(args).toContain("--publish");
        expect(args[args.indexOf("--publish") + 1]).toBe("never");
        const { config } = normalizeOptions(configureBuildCommand(yargs(args.slice(4))).parse());
        // The CLI hands booleans over as strings; the builder's schema validator coerces them.
        expect(String(config.forceCodeSigning)).toBe("true");
        expect(String(config.win.verifyUpdateCodeSignature)).toBe("true");
        expect(config.win.azureSignOptions).toEqual({
          publisherName: signing.WINDOWS_SIGNING_PUBLISHER_CN,
          endpoint: signing.WINDOWS_SIGNING_ENDPOINT,
          codeSigningAccountName: signing.WINDOWS_SIGNING_ACCOUNT,
          certificateProfileName: signing.WINDOWS_SIGNING_PROFILE,
          fileDigest: "SHA256",
          timestampDigest: "SHA256",
          timestampRfc3161: "http://timestamp.acs.microsoft.com",
        });
        expect(config.win.signtoolOptions).toBeUndefined();
        expect(config.directories.output).toBe(`dist/release/${arch}`);
        expect(config.publish.channel).toBe(`${version.includes("-") ? "prerelease" : "latest"}-${arch}`);
        expect(config.extraMetadata.version).toBe(version);
      }
    }
  },
);

it("keeps signing authority in one protected, main-only, unpublished job", () => {
  expect(Object.keys(signed.on)).toEqual(["workflow_dispatch"]);
  expect(signed.permissions).toEqual({ contents: "read" });
  expect(Object.keys(signed.jobs)).toEqual(["sign"]);
  const job = signed.jobs.sign;
  expect(job.if).toBe("github.ref == 'refs/heads/main'");
  expect(job.environment).toBe("windows-signing");
  expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  const text = JSON.stringify(signed);
  expect(text).not.toMatch(/AZURE_CLIENT_SECRET|AZURE_PASSWORD|AZURE_USERNAME|client-secret/);
  expect(text).not.toMatch(/actions\/cache|gh release|softprops|electron-builder[^"]*--publish (always|onTag)/);
  // Nothing but the OIDC login reads secrets.
  const secretSteps = job.steps.filter((s) => JSON.stringify(s).includes("secrets."));
  expect(secretSteps.map((s) => s.name)).toEqual(["Azure login (OIDC, no secret)"]);
});

it("stages native addons exactly as the unsigned Desktop lane does", () => {
  const name = "Stage native addons for all requested Windows architectures";
  expect(step(signed, "sign", name).run).toBe(step(desktop, "package", name).run);
});

it("leaves the ordinary Desktop lane unsigned", () => {
  expect(JSON.stringify(desktop)).not.toMatch(/azureSignOptions|id-token|forceCodeSigning/);
  expect(read("packages/app/electron-builder.yml").win.azureSignOptions).toBeUndefined();
});

describe("the packaged updater publisher check", () => {
  const cn = "Jane Q. Example";
  const config = (publisher) =>
    `provider: generic\nurl: https://updates.invalid/\nchannel: latest-x64\n${publisher}updaterCacheDirName: orca-updater\n`;

  it("accepts exactly the approved CN, as a list or a string", () => {
    expect(() => verifyUpdatePublisher(config(`publisherName:\n  - ${cn}\n`), cn)).not.toThrow();
    expect(() => verifyUpdatePublisher(config(`publisherName: "${cn}"\n`), cn)).not.toThrow();
  });

  it.each([
    ["missing", ""],
    ["empty", "publisherName: []\n"],
    ["a different CN", "publisherName:\n  - Someone Else\n"],
    ["a CN that merely contains it", `publisherName:\n  - ${cn} Ltd\n`],
    ["an extra entry beside it", `publisherName:\n  - ${cn}\n  - Someone Else\n`],
    ["only mentioned elsewhere", `# signed by ${cn}\n`],
  ])("refuses a publisherName that is %s", (_, publisher) => {
    expect(() => verifyUpdatePublisher(config(publisher), cn)).toThrow();
  });

  it("checks every packaged app-update.yml and refuses when there is none", () => {
    const root = mkdtempSync(join(tmpdir(), "orca-update-publisher-"));
    try {
      expect(() => verifyPackagedUpdatePublishers(root, cn)).toThrow(/No packaged app-update.yml/);
      const good = join(root, "win-unpacked", "resources");
      mkdirSync(good, { recursive: true });
      writeFileSync(join(good, "app-update.yml"), config(`publisherName:\n  - ${cn}\n`));
      expect(verifyPackagedUpdatePublishers(root, cn)).toHaveLength(1);
      const bad = join(root, "win-arm64-unpacked", "resources");
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, "app-update.yml"), config("publisherName:\n  - Someone Else\n"));
      expect(() => verifyPackagedUpdatePublishers(root, cn)).toThrow(/win-arm64-unpacked/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is what the workflow runs, for each architecture", () => {
    expect(step(signed, "sign", "Verify signatures and updater publisher").run).toContain(
      "node tools/packaged-windows/verify-update-publisher.js --root $root --publisher $expected",
    );
  });
});
