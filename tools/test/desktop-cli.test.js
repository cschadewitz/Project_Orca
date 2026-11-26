/**
 * #1207: desktop installs ship ORCA's command line as `orca-cli`, never plain `orca` (on
 * Ubuntu Desktop that is the GNOME screen reader). These checks hold the packaging, the
 * launchers and the Windows installer's PATH edit to that; the desktop workflow installs the
 * real .deb and NSIS installer on GitHub-hosted runners and runs the command from them.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const packagerRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { load } = packagerRequire("js-yaml");

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const config = load(read("packages/app/electron-builder.yml"));
const workflow = load(read(".github/workflows/desktop.yml"));

describe("packaging", () => {
  it("ships the Linux launcher in resources/bin and the .deb's /usr/bin/orca-cli as a package file", () => {
    expect(config.linux.extraResources).toContainEqual({ from: "build/cli/orca-cli", to: "bin/orca-cli" });
    // The rest of fpm's arguments are the rename's package relationships (linux-deb.test.js).
    expect(config.deb.fpm.filter((arg) => !arg.startsWith("--"))).toEqual(["build/linux/orca-cli=/usr/bin/orca-cli"]);
    // Not through the maintainer scripts: the postinst and postrm never name it.
    expect(read("packages/app/build/linux/after-install.tpl")).not.toContain("orca-cli");
    expect(config.deb.afterRemove).toBeUndefined();
  });

  it("ships the Windows launcher alone in resources\\bin, the PATH script beside it, and the NSIS include", () => {
    expect(config.win.extraResources).toContainEqual({ from: "build/cli/orca-cli.cmd", to: "bin/orca-cli.cmd" });
    expect(config.win.extraResources).toContainEqual({
      from: "build/win/orca-cli-path.ps1",
      to: "installer/orca-cli-path.ps1",
    });
    const intoBin = [...(config.extraResources ?? []), ...config.win.extraResources].filter((entry) =>
      String(entry.to).startsWith("bin/"),
    );
    expect(intoBin).toEqual([{ from: "build/cli/orca-cli.cmd", to: "bin/orca-cli.cmd" }]);
    expect(config.nsis.include).toBe("build/installer.nsh");
  });

  it("never names a command, link or package plain `orca`", () => {
    for (const entry of [...config.linux.extraResources, ...config.win.extraResources])
      expect(String(entry.to)).not.toMatch(/(^|\/)orca(\.cmd)?$/);
    expect(config.deb.fpm.join(" ")).not.toMatch(/\/usr\/bin\/orca(\s|$)/);
  });
});

describe("the Linux launcher", () => {
  const launcher = read("packages/app/build/cli/orca-cli");
  let root;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  // An unpacked app whose `orca-desktop` reports how it was run instead of being Electron.
  const fakeApp = () => {
    root = mkdtempSync(join(tmpdir(), "orca-cli-"));
    const app = join(root, "ORCA");
    mkdirSync(join(app, "resources/bin"), { recursive: true });
    mkdirSync(join(app, "resources/daemon"), { recursive: true });
    writeFileSync(
      join(app, "orca-desktop"),
      '#!/bin/sh\nprintf "%s\\n" "node=$ELECTRON_RUN_AS_NODE" "$0" "$@"\nexit 7\n',
    );
    chmodSync(join(app, "orca-desktop"), 0o755);
    writeFileSync(join(app, "resources/bin/orca-cli"), launcher);
    chmodSync(join(app, "resources/bin/orca-cli"), 0o755);
    return app;
  };
  const run = (path, args) => spawnSync(path, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });

  it("runs the bundled CLI with the app's own binary as Node, passing arguments and exit code through", () => {
    const app = fakeApp();
    const result = run(join(app, "resources/bin/orca-cli"), ["remote", "enroll", "a b", "--host-key", "SHA256:x"]);
    expect(result.status).toBe(7);
    expect(result.stdout.split("\n")).toEqual([
      "node=1",
      join(app, "orca-desktop"),
      join(app, "resources/daemon/orca-daemon.mjs"),
      "remote",
      "enroll",
      "a b",
      "--host-key",
      "SHA256:x",
      "",
    ]);
  });

  it("finds its app through a symlink, as from a link a person put on PATH", () => {
    const app = fakeApp();
    mkdirSync(join(root, "bin"));
    symlinkSync(join(app, "resources/bin/orca-cli"), join(root, "bin/orca-cli"));
    const result = run(join(root, "bin/orca-cli"), ["--version"]);
    expect(result.stdout.split("\n").slice(0, 3)).toEqual([
      "node=1",
      join(app, "orca-desktop"),
      join(app, "resources/daemon/orca-daemon.mjs"),
    ]);
  });

  it("refuses, rather than guessing an app, when it is not at <app>/resources/bin/orca-cli", () => {
    root = mkdtempSync(join(tmpdir(), "orca-cli-"));
    writeFileSync(join(root, "orca-cli"), launcher);
    chmodSync(join(root, "orca-cli"), 0o755);
    const result = run(join(root, "orca-cli"), ["--version"]);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("the app it belongs to is unknown");
  });

  it("is LF-only POSIX sh, and the .deb's /usr/bin/orca-cli execs the installed launcher", () => {
    expect(launcher).not.toContain("\r");
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
    execFileSync("sh", ["-n", "-c", launcher]);
    const usrBin = read("packages/app/build/linux/orca-cli");
    expect(usrBin).not.toContain("\r");
    expect(usrBin.trim().split("\n").at(-1)).toBe('exec /opt/ORCA/resources/bin/orca-cli "$@"');
    // The .deb's install prefix and executable, as electron-builder derives them.
    expect(config.linux.executableName).toBe("orca-desktop");
    expect(launcher).toContain('"$app/orca-desktop"');
  });
});

describe("the Windows launcher and PATH edit", () => {
  it("runs the bundled CLI with ORCA.exe as Node and passes its exit code back", () => {
    const cmd = read("packages/app/build/cli/orca-cli.cmd");
    // cmd.exe needs CRLF; .gitattributes keeps it whatever the checkout.
    expect(
      cmd
        .split("\r\n")
        .slice(0, -1)
        .every((line) => !line.includes("\n")),
    ).toBe(true);
    expect(cmd.endsWith("\r\n")).toBe(true);
    const lines = cmd.split("\r\n").filter((line) => line && !/^rem\b/i.test(line));
    expect(lines).toEqual([
      "@echo off",
      "setlocal",
      "set ELECTRON_RUN_AS_NODE=1",
      '"%~dp0..\\..\\ORCA.exe" "%~dp0..\\daemon\\orca-daemon.mjs" %*',
      "endlocal & exit /b %ERRORLEVEL%",
    ]);
    // ORCA.exe is the productName, which is what electron-builder names the Windows binary.
    expect(config.productName).toBe("ORCA");
    expect(config.win.executableName).toBeUndefined();
    // No redirection characters in its comments.
    expect(cmd).not.toMatch(/^rem .*[<>|]/im);
  });

  it("adds and removes exactly the resources\\bin entry, through the shipped script, never on update", () => {
    const nsh = read("packages/app/build/installer.nsh");
    expect(nsh).toContain(
      '-ExecutionPolicy Bypass -File "$INSTDIR\\resources\\installer\\orca-cli-path.ps1" -Action ${ACTION} -Directory "$INSTDIR\\resources\\bin"',
    );
    expect(nsh).toMatch(/!macro customInstall\s+!insertmacro orcaCliPath "add"\s+!macroend/);
    expect(nsh).toMatch(
      /!macro customUnInstall[\s\S]*\$\{ifNot\} \$\{isUpdated\}\s+!insertmacro orcaCliPath "remove"\s+(?:(?!\$\{)[^\n]*\n\s*)*\$\{endIf\}\s+!macroend/,
    );
    // WM_SETTINGCHANGE to every top-level window, so new terminals see the change.
    expect(nsh).toContain('SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000');
    // Registers kept: $0 is pushed before and popped after.
    expect(nsh.match(/^\s*Push \$0$/gm)).toHaveLength(1);
    expect(nsh.match(/^\s*Pop \$0$/gm)).toHaveLength(2);
  });

  it("edits HKCU\\Environment\\Path whole, unexpanded, keeping its type and every other entry", () => {
    const ps1 = read("packages/app/build/win/orca-cli-path.ps1");
    expect(ps1).toContain("[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')");
    expect(ps1).toContain("[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames");
    expect(ps1).toContain("$key.SetValue('Path', $value + $appended, $path.Kind)");
    // Ownership: remove does nothing without the record add made, and cuts off exactly its text.
    expect(ps1).toContain("$recordPath = 'Software\\ORCA\\orca-cli-path'");
    expect(ps1).toContain("$value.EndsWith($appended, [StringComparison]::Ordinal)");
    expect(ps1).toContain("This install added nothing to the user PATH, so it was left unchanged.");
    expect(ps1).toContain("[ValidateSet('add', 'remove')]");
    expect(ps1).not.toMatch(/SetEnvironmentVariable|setx|Invoke-Expression|\biex\b/i);
  });

  it("is proved on a GitHub-hosted runner: installed, run from a new terminal's PATH, uninstalled", () => {
    const step = workflow.jobs.package.steps.find(
      (candidate) => candidate.name === "The Windows installer puts orca-cli on the user PATH and takes it off again",
    );
    expect(step.if).toBe("matrix.name == 'windows' && runner.environment == 'github-hosted'");
    expect(step.run).toContain("'/S', '/currentuser'");
    expect(step.run).toContain("$out = orca-cli --version");
    expect(step.run).toContain("if ($final -cne $before)");
    const cases = workflow.jobs.package.steps.find(
      (candidate) => candidate.name === "The installer's PATH edit round-trips the user PATH exactly",
    );
    expect(cases.if).toBe(step.if);
    expect(cases.run).toContain(
      "packages/app/test/windows/orca-cli-path.cases.ps1 -Script packages/app/build/win/orca-cli-path.ps1",
    );
  });
});

it("gives new app profiles orca-cli, keeps an omitted command meaning orca, and installs both names", () => {
  const protocol = read("packages/protocol/src/remote-access.ts");
  expect(protocol).toContain('export const DEFAULT_SERVER_COMMAND = "orca-cli";');
  expect(protocol).toContain('export const LEGACY_SERVER_COMMAND = "orca";'); // rename-keep: an omitted command keeps naming the old CLI
  const cli = JSON.parse(read("packages/cli/package.json"));
  expect(cli.bin).toEqual({ orca: "./dist/main.js", "orca-cli": "./dist/main.js" });
  // An omitted command resolves to the legacy name only, through the one constant, never a literal.
  for (const file of ["packages/app/src/main/remote-credentials.ts", "packages/daemon/src/delegation/enrollment.ts"]) {
    expect(read(file)).not.toMatch(/serverCommand \?\? "orca/);
    expect(read(file)).not.toMatch(/serverCommand \?\? DEFAULT_SERVER_COMMAND/);
  }
});
