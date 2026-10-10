// UNAPPROVED proposed operator-owned launcher. Never install inside candidate/.
// Root must review this file, complete source/runtime closure and the exact literal pin.
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installProcessErrorHandlers, serveWithInstalledPluginRelease } from "../../packages/cli/dist/index.js";

// Approval requires a separate operator-reviewed edit of this literal after exact root approval.
// No flag, YAML, RPC, environment variable or candidate output may authorize startup.
const ROOT_APPROVED = false;
const installedPluginRelease = Object.freeze({
  root: fileURLToPath(new URL("../../examples/m10-plugin/candidate/", import.meta.url)),
  manifestPath: "plugin-release.json",
  manifestSha256: "9ac49cd3b320421fa465bfce8b6876d43fff132c8c7a1ede389b25d25ea9c9ed",
});

if (!ROOT_APPROVED) throw new Error("UNAPPROVED M10 plugin release: root pin approval required");
if (process.argv.length !== 2) throw new Error("M10 launcher accepts no arguments");
// Reuse an existing dedicated daemon identity/store; never bootstrap a fresh host test account.
for (const path of ["auth/credentials.json", "auth/ownership.json", "../state/workspace-identity/id"])
  await access(join(installedPluginRelease.root, path));
installProcessErrorHandlers({ keepRunning: true });
process.exitCode = await serveWithInstalledPluginRelease(
  {
    cwd: installedPluginRelease.root,
    configPath: fileURLToPath(new URL("../../examples/m10-plugin/candidate/orca.config.json", import.meta.url)),
    flags: { host: "127.0.0.1", port: "6722" },
    positionals: [],
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  },
  installedPluginRelease,
).catch(() => {
  process.stderr.write("M10 daemon startup refused; check the approved composition\n");
  return 1;
});
