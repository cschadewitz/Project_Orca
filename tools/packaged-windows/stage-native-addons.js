/** Stage every ordinary Windows target with explicit local headers and import libraries. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { verifyNativePackage } from "../../packages/app/scripts/diagnostics-native-package.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
export function requestedWindowsArchitectures(config) {
  const targets = config?.win?.target;
  if (!Array.isArray(targets) || !targets.length) throw new Error("Explicit Windows architecture targets required");
  const selected = new Set();
  for (const target of targets) {
    if (!target || !Array.isArray(target.arch) || !target.arch.length)
      throw new Error("Explicit Windows architecture targets required");
    for (const arch of target.arch) {
      if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported Windows native architecture");
      selected.add(arch);
    }
  }
  return [...selected].sort();
}

export function stageNativeAddons(config, headers, run = execFileSync, verify = verifyNativePackage) {
  const architectures = requestedWindowsArchitectures(config);
  for (const arch of architectures) {
    run(
      process.execPath,
      ["packages/app/scripts/diagnostics-native-package.js", "--arch", arch, "--headers", resolve(headers)],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 360_000, maxBuffer: 16 * 1024, windowsHide: true },
    );
    verify(
      resolve(root, "packages/app/dist/diagnostics-native", `win32-${arch}`),
      arch,
      resolve(root, "packages/app"),
      "win32",
    );
  }
  return architectures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { headers: { type: "string" } } });
    if (process.platform !== "win32" || !values.headers) throw new Error("Local Windows headers required");
    const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
    const builderRequire = createRequire(appRequire.resolve("electron-builder"));
    const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
    const config = libRequire("js-yaml").load(
      readFileSync(new URL("../../packages/app/electron-builder.yml", import.meta.url), "utf8"),
    );
    const architectures = stageNativeAddons(config, values.headers);
    console.log(`Staged Windows native addons: ${architectures.join(", ")}; before-signing resources only`);
  } catch (error) {
    // The cause (a toolchain or build error) is what makes a refusal fixable, e.g. on a new
    // runner image; bounded so a build log cannot flood the job output.
    const detail = [error?.message, error?.stdout?.toString(), error?.stderr?.toString()].filter(Boolean).join("\n");
    console.error(detail.slice(-8000));
    console.error("Windows native staging refused; packaging must not continue");
    process.exitCode = 1;
  }
}
