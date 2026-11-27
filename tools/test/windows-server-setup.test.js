/**
 * tools/deploy/orca-server-setup.ps1 (#1238) verifies the Windows server bundle on the host by
 * itself, so its pins must be the ones the rest of the release trusts: the Windows release
 * workflow's signer and cosign, and orca-release.py's carried Sigstore roots. Its behaviour runs
 * on Windows in the Windows server bundle check (tools/deploy/tests/windows-setup/run.ps1).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const setup = read("tools/deploy/orca-server-setup.ps1");
const adapter = read("tools/deploy/orca-release.py");
const value = (name) => setup.match(new RegExp(`^\\$${name} = "([^"]*)"$`, "m"))?.[1];

it("trusts exactly the Windows release workflow's signer and cosign", () => {
  const release = parse(read(".github/workflows/release-server-bundle-windows.yml"));
  const verify = release.jobs.verify.steps.find((step) => step.name?.startsWith("Verify the signature"));
  expect(value("CosignVersion")).toBe(verify.env.COSIGN_VERSION);
  expect(value("CosignSha256")).toBe(verify.env.COSIGN_SHA256);
  expect(value("CosignName")).toBe("cosign-windows-amd64.exe");
  expect(verify.run).toContain(`/${value("CosignName")}"`);
  expect(value("BundleRepository")).toBe(adapter.match(/^BUNDLE_REPOSITORY = "([^"]+)"$/m)[1]);
  expect(setup).toContain(
    '$BundleSigner = "https://github.com/$BundleRepository/.github/workflows/release-server-bundle-windows.yml@refs/heads/main"',
  );
  expect(value("BundleIssuer")).toBe(adapter.match(/^BUNDLE_ISSUER = "([^"]+)"$/m)[1]);
  expect(value("BundleTrigger")).toBe("workflow_dispatch");
  expect(Object.keys(release.on)).toContain("workflow_dispatch");
  expect(value("BundlePlatform")).toBe("win-x64");
});

it("fetches a release's Windows bundle only by the record its release workflow writes", () => {
  const attach = read("tools/deploy/release-attach.sh");
  const token = attach.match(/^server_token\(\) \{ if \[\[ "\$SP" == win-x64 \]\]; then echo (\S+);/m)[1];
  expect(value("BundleRecordToken")).toBe(token);
  const pattern = setup.match(/^\$BundleRecordPattern = '([^']+)'$/m)[1];
  expect(pattern).toBe(`<!-- ${token}: [0-9]+ sha256:([0-9a-f]{64}) sha256:([0-9a-f]{64}) sha256:([0-9a-f]{64}) -->`);
  // The record lists the archive, the manifest and the signature, in that order.
  expect(attach).toMatch(/echo "\$s\.\$ext \$s\.manifest\.json \$s\.manifest\.json\.sigstore\.json"/);
  expect(setup).toContain(
    "$names.archive = $records[0].Groups[1].Value; $names.manifest = $records[0].Groups[2].Value; $names.signature = $records[0].Groups[3].Value",
  );
});

it("accepts a carried Sigstore root only by the pins orca-release.py has", () => {
  const pins = (text) => [...text.matchAll(/"([0-9a-f]{64})"/g)].map((match) => match[1]);
  const ours = pins(setup.match(/\$TrustedRootSha256 = @\(([^)]*)\)/)[1]);
  expect(ours).toEqual(pins(adapter.match(/TRUSTED_ROOT_SHA256 = \(([^)]*)\)/)[1]));
  expect(ours.length).toBeGreaterThan(0);
  expect(value("PushedTrustedRoot")).toBe(adapter.match(/^PUSHED_TRUSTED_ROOT = "([^"]+)"$/m)[1]);
});

it("is run end to end on Windows by the Windows server bundle check, in Windows PowerShell", () => {
  const check = parse(read(".github/workflows/windows-server-bundle.yml"));
  for (const path of [
    "tools/deploy/orca-server-setup.ps1",
    "tools/deploy/orca-windows-ssh.ps1",
    "tools/deploy/tests/windows-setup/**",
  ])
    expect(check.on.pull_request.paths).toContain(path);
  const step = check.jobs.bundle.steps.find((candidate) => candidate.run?.includes("tests/windows-setup/run.ps1"));
  // Windows PowerShell 5.1, the one every Windows host has, not PowerShell 7.
  expect(step.shell).toBe("powershell");
  expect(step.run).toContain("powershell -NoProfile");
});

it("gives the client's Windows setup session longer than every download deadline the setup can spend", () => {
  const seconds = (name) => Number(setup.match(new RegExp(`^\\$${name} = (\\d+)$`, "m"))?.[1]);
  const client = read("packages/protocol/src/server-setup.ts");
  const minutes = Number(client.match(/^export const WINDOWS_SETUP_TIMEOUT_MS = (\d+) \* 60_000;$/m)?.[1]);
  // Three small downloads: the release record (one use), then the manifest and the signature
  // (the other); then the archive, and cosign when it is fetched. Its definition and two uses:
  expect(setup.match(/\$DownloadSmallSeconds\b/g)).toHaveLength(3);
  const downloads =
    3 * seconds("DownloadSmallSeconds") + seconds("DownloadArchiveSeconds") + seconds("DownloadCosignSeconds");
  expect(downloads).toBeGreaterThan(0);
  // With room left for unpacking, verifying, the task and the daemon's health check.
  expect(minutes * 60).toBeGreaterThanOrEqual(downloads + 15 * 60);
});

it("documents the OpenSSH Server bootstrap as a checked download, ships it, and tests it on Windows", () => {
  const docs = read("docs/MULTI-MACHINE.md");
  expect(docs).toContain("orca-cli remote windows-ssh");
  // Never a download piped into an elevated session.
  expect(docs).not.toMatch(/\|\s*iex\b|Invoke-Expression/);
  const builder = parse(read("packages/app/electron-builder.yml"));
  const setup = builder.extraResources.find((entry) => entry.to === "server-setup");
  expect(setup.filter).toContain("orca-windows-ssh.ps1");
  // Its digest is the shipped copy's: the same bytes on every checkout.
  expect(read(".gitattributes")).toMatch(/^tools\/deploy\/orca-windows-ssh\.ps1 text eol=lf$/m);
  expect(read("tools/deploy/orca-windows-ssh.ps1")).toContain("Windows Update");
  expect(read("tools/deploy/tests/windows-setup/run.ps1")).toContain('"openssh.ps1"');
});
