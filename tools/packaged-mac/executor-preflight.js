/** Read-only executor observations for #388; no app launch or candidate acceptance. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const execute = promisify(execFile);

/** A native arm64 tooling process is necessary, but GUI and product checks are separate. */
export async function inspectMacExecutor({ platform = process.platform, arch = process.arch, run = execute } = {}) {
  const blocked = (code) => ({ status: "blocked", scope: "executor-only", code });
  if (platform !== "darwin") return blocked("HOST_PLATFORM");
  if (arch !== "arm64") return blocked("HARNESS_ARCHITECTURE");
  try {
    const read = async (command, args) => {
      const { stdout } = await run(command, args, {
        env: { PATH: SYSTEM_PATH, LANG: "C" },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1024,
        windowsHide: true,
      });
      return stdout.trim();
    };
    // Deliberately sequential and bounded: at most three system observations.
    const hostArch = await read("/usr/bin/uname", ["-m"]);
    if (hostArch !== "arm64") return blocked("HOST_ARCHITECTURE");
    const macOS = await read("/usr/bin/sw_vers", ["-productVersion"]);
    const macOSBuild = await read("/usr/bin/sw_vers", ["-buildVersion"]);
    if (!/^\d{1,3}(?:\.\d{1,3}){1,2}$/.test(macOS) || !/^[0-9A-Za-z]{1,32}$/.test(macOSBuild)) {
      return blocked("OS_OBSERVATION");
    }
    return {
      status: "observed",
      scope: "executor-only",
      hostArch,
      harnessArch: arch,
      macOS,
      macOSBuild,
      gui: "not-checked",
      appArch: "not-checked",
      daemonArch: "not-checked",
      candidate: "not-run",
    };
  } catch {
    // Never publish command output, environment, paths or content-bearing errors.
    return blocked("SYSTEM_OBSERVATION");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error(JSON.stringify({ status: "blocked", scope: "executor-only", code: "USAGE" }));
    process.exitCode = 2;
  } else {
    const result = await inspectMacExecutor();
    console.log(JSON.stringify(result));
    if (result.status === "blocked") process.exitCode = 2;
  }
}
