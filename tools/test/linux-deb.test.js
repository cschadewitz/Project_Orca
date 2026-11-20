/**
 * #853: the rc.2 Linux tarball aborted on stock Ubuntu 24.04 because Chromium's sandbox could
 * neither create a user namespace (AppArmor restricts them) nor use the SUID helper (a
 * download cannot carry root:4755). The supported install there is the .deb, whose root
 * install script loads an AppArmor profile for /opt/ORCA/orca-desktop alone. These checks hold the
 * packaging and the workflow's install-and-launch proof to that, with the locked builder.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  // The postinst is the repository's (no setuid fallback, no cache refreshes); the postrm
  // and the AppArmor profile stay electron-builder's.
  expect(config.deb.afterInstall).toBe("build/linux/after-install.tpl");
  for (const key of ["afterRemove", "appArmorProfile"]) {
    expect(config.deb[key]).toBeUndefined();
    expect(config.linux[key]).toBeUndefined();
  }
  expect(config.linux.afterInstall).toBeUndefined();
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

it("uses electron-builder's scoped userns profile and its removal script", () => {
  const profile = template("apparmor-profile.tpl");
  expect(profile).toContain('"/opt/${sanitizedProductName}/${executable}"');
  expect(profile).toMatch(/^\s*userns,$/m);
  expect(template("after-remove.tpl")).toContain("apparmor_parser --remove");
});

// Cal's review: electron-builder's postinst falls back to a setuid helper and refreshes the
// MIME and desktop caches. The repository's never does either.
const postinstTemplate = readFileSync(
  new URL("../../packages/app/build/linux/after-install.tpl", import.meta.url),
  "utf8",
);
const code = postinstTemplate
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

it("has a postinst that never makes the helper setuid and leaves cache refreshes to dpkg triggers", () => {
  expect(code).not.toMatch(/4755|[ug]?\+s\b|update-mime-database|update-desktop-database|no-sandbox|userns=0/);
  expect(code).toContain('chmod 0755 "$HELPER"');
  expect(code).toContain("HELPER='/opt/${sanitizedProductName}/chrome-sandbox'");
  expect(code).toContain("PROFILE_TARGET='/etc/apparmor.d/${executable}'");
  expect(code).toContain("apparmor_parser --replace --write-cache --skip-read-cache");
  // Only the two macros electron-builder fills; any other ${name} would throw at build time.
  expect(new Set([...postinstTemplate.matchAll(/\$\{([a-zA-Z]+)\}/g)].map((m) => m[1]))).toEqual(
    new Set(["executable", "sanitizedProductName"]),
  );
});

describe("the postinst, run against a fake root", () => {
  // The rendered script with every absolute path it touches moved under a scratch root, on a
  // PATH holding only core utilities: no update-alternatives, AppArmor tools or ischroot.
  const run = ({ restricted, profileLoaded = false, helperMode = 0o4755 }) => {
    const root = mkdtempSync(join(tmpdir(), "orca-postinst-"));
    try {
      const bin = join(root, "bin");
      for (const dir of [
        "bin",
        "opt/ORCA/resources",
        "usr/bin",
        "etc/apparmor.d",
        "proc/sys/kernel",
        "sys/kernel/security/apparmor",
      ])
        mkdirSync(join(root, dir), { recursive: true });
      for (const tool of ["bash", "cat", "chmod", "cp", "grep", "ln", "readlink", "rm"])
        symlinkSync(execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
      writeFileSync(join(root, "opt/ORCA/orca-desktop"), "");
      writeFileSync(join(root, "opt/ORCA/chrome-sandbox"), "");
      chmodSync(join(root, "opt/ORCA/chrome-sandbox"), helperMode);
      writeFileSync(join(root, "proc/sys/kernel/apparmor_restrict_unprivileged_userns"), restricted ? "1\n" : "0\n");
      writeFileSync(
        join(root, "sys/kernel/security/apparmor/profiles"),
        profileLoaded ? "orca-desktop (unconfined)\n" : "",
      );
      const script = postinstTemplate
        .replaceAll("${executable}", "orca-desktop")
        .replaceAll("${sanitizedProductName}", "ORCA")
        .replaceAll("/usr/bin/ischroot", `${root}/absent/ischroot`)
        .replaceAll(/(['"( ])\/(opt|usr\/bin|etc\/apparmor\.d|proc\/sys|sys\/kernel)\//g, `$1${root}/$2/`);
      writeFileSync(join(root, "postinst"), script);
      const result = spawnSync(join(bin, "bash"), [join(root, "postinst"), "configure"], {
        env: { PATH: bin },
        encoding: "utf8",
      });
      return {
        status: result.status,
        stderr: result.stderr,
        helper: lstatSync(join(root, "opt/ORCA/chrome-sandbox")).mode & 0o7777,
        link: readlinkSync(join(root, "usr/bin/orca-desktop")),
        root,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("resets a setuid helper to 0755 and links the command where user namespaces are open", () => {
    const result = run({ restricted: false });
    expect(result.status).toBe(0);
    expect(result.helper).toBe(0o755);
    expect(result.link).toBe(`${result.root}/opt/ORCA/orca-desktop`);
  });

  it("succeeds where the restriction is on and the profile is loaded", () => {
    expect(run({ restricted: true, profileLoaded: true }).status).toBe(0);
  });

  it("refuses clearly, without weakening anything, where the restriction is on and no profile loaded", () => {
    const result = run({ restricted: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("restricts unprivileged user namespaces");
    expect(result.stderr).toContain("The sandbox is not disabled and the helper is not made setuid.");
    expect(result.helper).toBe(0o755);
  });
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
  // Numeric modes, special bits included, in the payload and once installed.
  expect(run).toContain("m.mode & 0o7000");
  expect(run).toContain("test \"$(stat -c '%a %u:%g' /opt/ORCA/chrome-sandbox)\" = '755 0:0'");
  expect(run).toContain("-perm /7000");
  // The generated postinst is read and held to the template's promises.
  expect(run).toContain(`grep -qx 'chmod 0755 "$HELPER"' "$scripts/postinst"`);
  expect(run).toContain("update-mime-database|update-desktop-database");
  expect(run).toContain("grep -qx 'Exec=/opt/ORCA/orca-desktop %U' /usr/share/applications/orca-desktop.desktop");
  expect(run).toContain('test "$(id -u)" != 0');
  expect(run).toContain("sha256sum ORCA-*.deb");
  expect(run).toContain("/ns/user");
  // The daemon is /opt/ORCA/orca-desktop too (run as Node), so it must not be taken for the browser.
  expect(run).toContain("*orca-daemon.mjs*) ;;");
  expect(run).toContain('kill -TERM "$main"');
  expect(run).toContain("apt-get remove -y -q orca-desktop");
  expect(run).not.toMatch(/apt-get (?:remove|purge)[^\n]* orca$/m);
  // The proof is that the package alone is enough: no sandbox bypass, no profile of the
  // job's own, no lifting the restriction. Lines that only search for those words (the
  // maintainer-script checks) are not commands that do them.
  const commands = run
    .split("\n")
    .filter((line) => !/\bgrep\b/.test(line))
    .join("\n");
  expect(commands).not.toMatch(
    /--no-sandbox|ORCA_SMOKE_NO_SANDBOX|apparmor_parser|\/etc\/apparmor\.d\/[^o]|userns=0|chmod/,
  );
  const upload = steps.find((candidate) => candidate.name === "Upload the artifacts");
  expect(upload.with.path).toContain("packages/app/dist/release/*.deb");
});
