/**
 * #853: the rc.2 Linux tarball aborted on stock Ubuntu 24.04 because Chromium's sandbox could
 * neither create a user namespace (AppArmor restricts them) nor use the SUID helper (a
 * download cannot carry root:4755). The supported install there is the .deb, whose root
 * install script loads an AppArmor profile for /opt/ORCA/orca-desktop alone. These checks hold the
 * packaging and the workflow's install-and-launch proof to that, with the locked builder.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import afterPack from "../../packages/app/scripts/after-pack.js";
import { stripSharedWrite } from "../../packages/app/scripts/linux-file-modes.js";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const packagerRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { load } = packagerRequire("js-yaml");
const { AppInfo } = packagerRequire("./appInfo.js");
const { LinuxTargetHelper } = packagerRequire("./targets/LinuxTargetHelper.js");
const { computeArchToTargetNamesMap } = packagerRequire("./targets/targetFactory.js");
const { Platform } = builderRequire("app-builder-lib");
const { Arch } = builderRequire("builder-util");

const config = load(readFileSync(new URL("../../packages/app/electron-builder.yml", import.meta.url), "utf8"));
const metadata = JSON.parse(readFileSync(new URL("../../packages/app/package.json", import.meta.url), "utf8"));
const workflow = load(readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8"));
const templates = packagerRequire
  .resolve("app-builder-lib/templates/linux/after-install.tpl")
  .replace(/after-install\.tpl$/, "");
const template = (name) => readFileSync(`${templates}${name}`, "utf8");

it("builds a .deb for both architectures beside the existing Linux targets", () => {
  const targets = computeArchToTargetNamesMap(
    new Map(),
    { platformSpecificBuildOptions: config.linux },
    Platform.LINUX,
  );
  expect(Object.fromEntries([...targets].map(([arch, names]) => [Arch[arch], [...names].sort()]))).toEqual({
    x64: ["AppImage", "deb", "tar.gz"],
    arm64: ["deb", "tar.gz"],
  });
});

it("has the Debian control fields fpm requires, under a lowercase package name", () => {
  // Never `orca`: Ubuntu Desktop's screen reader is package `orca` and owns /usr/bin/orca,
  // so apt would take this for a version of it. Nor a declared relationship with it.
  expect(config.deb.packageName).toBe("orca-desktop");
  for (const key of ["conflicts", "replaces", "provides", "breaks"]) expect(config.deb[key]).toBeUndefined();
  expect(config.deb.maintainer).toBeTruthy();
  expect(metadata.homepage).toMatch(/^https:\/\//);
  // The install path the builder's scripts and profile name, and the binary a tester runs.
  const info = new AppInfo({ config, metadata }, undefined, config.linux);
  expect(info.sanitizedProductName).toBe("ORCA");
  expect(config.linux.executableName).toBe("orca-desktop");
  // No custom maintainer scripts or profile: the builder's own are what grant the exception.
  for (const key of ["afterInstall", "afterRemove", "appArmorProfile"]) {
    expect(config.deb[key]).toBeUndefined();
    expect(config.linux[key]).toBeUndefined();
  }
});

it("installs a desktop entry, icon and command none of which the screen reader owns", async () => {
  const helper = new LinuxTargetHelper({
    appInfo: new AppInfo({ config, metadata }, undefined, config.linux),
    executableName: config.linux.executableName,
    platformSpecificBuildOptions: config.linux,
    config,
    info: { metadata },
    fileAssociations: [],
  });
  expect(helper.getDesktopFileName()).toBe("orca-desktop");
  const entry = await helper.computeDesktopEntry(config.linux);
  expect(entry).toContain("Exec=/opt/ORCA/orca-desktop %U");
  expect(entry).toContain("Icon=orca-desktop\n");
});

it("relies on a builder whose scripts install a scoped userns profile and keep the helper unprivileged", () => {
  const profile = template("apparmor-profile.tpl");
  expect(profile).toContain('"/opt/${sanitizedProductName}/${executable}"');
  expect(profile).toMatch(/^\s*userns,$/m);
  const install = template("after-install.tpl");
  expect(install).toContain("apparmor_parser --replace");
  expect(install).toContain("chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox'");
  expect(install).not.toMatch(/apparmor_restrict_unprivileged_userns/);
  expect(template("after-remove.tpl")).toContain("apparmor_parser --remove");
});

// The Electron zip unpacks 0666/0777 on the build hosts, and fpm copies modes verbatim: the
// first hosted run of the install step refused a .deb whose /opt/ORCA/orca binary was world-writable.
it("removes group and other write from the unpacked Linux tree before targets are built", () => {
  expect(config.afterPack).toBe("./scripts/after-pack.js");
  const root = mkdtempSync(join(tmpdir(), "orca-linux-modes-"));
  try {
    mkdirSync(join(root, "locales"));
    writeFileSync(join(root, "orca"), "");
    writeFileSync(join(root, "chrome-sandbox"), "");
    writeFileSync(join(root, "locales/en-US.pak"), "");
    symlinkSync("orca", join(root, "link"));
    chmodSync(join(root, "orca"), 0o777);
    chmodSync(join(root, "chrome-sandbox"), 0o755);
    chmodSync(join(root, "locales/en-US.pak"), 0o666);
    chmodSync(join(root, "locales"), 0o777);
    afterPack({ electronPlatformName: "linux", appOutDir: root });
    const mode = (path) => lstatSync(join(root, path)).mode & 0o7777;
    expect(mode("orca")).toBe(0o755);
    expect(mode("chrome-sandbox")).toBe(0o755);
    expect(mode("locales/en-US.pak")).toBe(0o644);
    expect(mode("locales")).toBe(0o755);
    expect(stripSharedWrite(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("installs the .deb and launches it sandboxed on a restricted GitHub-hosted runner", () => {
  const steps = workflow.jobs.package.steps;
  const step = steps.find((candidate) => candidate.name === "The .deb installs and launches sandboxed on stock Ubuntu");
  expect(step.if).toBe("matrix.name == 'linux' && runner.environment == 'github-hosted'");
  expect(steps.indexOf(step)).toBeGreaterThan(steps.findIndex((candidate) => candidate.name === "Package"));
  const run = step.run;
  expect(run).toContain('apt-get install -y -q "$deb"');
  expect(run).toContain('test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1');
  expect(run).toContain("grep -q '^orca-desktop ' /sys/kernel/security/apparmor/profiles");
  // The screen reader is installed first and must come through untouched.
  expect(run).toContain("apt-get install -y -q --no-install-recommends orca\n");
  expect(run.match(/test "\$\(reader\)" = "\$before"/g)).toHaveLength(2);
  expect(run).toContain('test "$(dpkg-deb -f "$deb" Package)" = orca-desktop');
  expect(run).toContain('test "$(stat -c %a /opt/ORCA/chrome-sandbox)" = 755');
  expect(run).toContain("/ns/user");
  // The daemon is /opt/ORCA/orca-desktop too (run as Node), so it must not be taken for the browser.
  expect(run).toContain("*orca-daemon.mjs*) ;;");
  expect(run).toContain('kill -TERM "$main"');
  expect(run).toContain("apt-get remove -y -q orca-desktop");
  expect(run).not.toMatch(/apt-get (?:remove|purge)[^\n]* orca$/m);
  // The proof is that the package alone is enough: no sandbox bypass, no profile of the
  // job's own, no lifting the restriction.
  expect(run).not.toMatch(/--no-sandbox|ORCA_SMOKE_NO_SANDBOX|apparmor_parser|\/etc\/apparmor\.d\/[^o]|userns=0|chmod/);
  const upload = steps.find((candidate) => candidate.name === "Upload the artifacts");
  expect(upload.with.path).toContain("packages/app/dist/release/*.deb");
});
