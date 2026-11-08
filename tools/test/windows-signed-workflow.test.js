/** The signed Windows spike: resolve its builder overrides and hold its boundaries in place. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

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
