/** Resolve the actual Windows packaging commands without building Electron installers. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const packagerRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { load } = packagerRequire("js-yaml");
const { configureBuildCommand, normalizeOptions } = builderRequire("./builder.js");
const { computeArchToTargetNamesMap } = packagerRequire("./targets/targetFactory.js");
const { Platform } = builderRequire("app-builder-lib");
const { Arch } = builderRequire("builder-util");
const yargs = builderRequire("yargs/yargs");

it.skipIf(process.platform === "win32")("packages each Windows architecture once with its own update channel", () => {
  const workflow = load(readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8"));
  const config = load(readFileSync(new URL("../../packages/app/electron-builder.yml", import.meta.url), "utf8"));
  const script = workflow.jobs.package.steps.find((step) => step.name === "Package").run;

  for (const version of ["0.6.0", "0.6.1-rc.1"]) {
    // Run the workflow's shell loop, replacing only pnpm with an argument recorder.
    const output = execFileSync(
      "bash",
      ["-c", 'pnpm() { printf "%s\\0" "$@"; printf "\\n"; }\n' + script.replaceAll("${{ matrix.name }}", "windows")],
      { env: { ...process.env, VERSION: version }, encoding: "utf8" },
    );
    const commands = output.trimEnd().split("\n");
    expect(commands).toHaveLength(2);
    for (const [index, arch] of ["x64", "arm64"].entries()) {
      const args = commands[index].split("\0").filter(Boolean);
      expect(args.slice(0, 4)).toEqual(["--filter", "@orca/app", "exec", "electron-builder"]);
      const options = normalizeOptions(configureBuildCommand(yargs(args.slice(4))).parse());
      const targets = computeArchToTargetNamesMap(
        options.targets.get(Platform.WINDOWS),
        { platformSpecificBuildOptions: config.win },
        Platform.WINDOWS,
      );
      expect([...targets]).toEqual([[Arch[arch], ["nsis", "zip"]]]);
      expect(options.config.directories.output).toBe(`dist/release/${arch}`);
      expect(options.config.publish.channel).toBe(`${version.includes("-") ? "prerelease" : "latest"}-${arch}`);
      expect(options.config.extraMetadata.version).toBe(version);
    }
  }
});
