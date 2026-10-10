/** Render inactive templates against a synthetic entry; prove launch refusal without host/tunnel access. */
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const directory = new URL("../../../tools/deploy/maintenance-mcp/", import.meta.url);
const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

it("starts only the fixed observer entry and refuses root or additional arguments", async () => {
  const folder = await mkdtemp(join(tmpdir(), "orca-observer-launcher-"));
  cleanup.push(folder);
  const stub = join(folder, "stub.mjs");
  const launcher = join(folder, "launcher.mjs");
  const template = await readFile(new URL("launcher.mjs.template", directory), "utf8");
  await writeFile(launcher, template.replace("@REVIEWED_BUILT_PACKAGE_INDEX@", pathToFileURL(stub).href));
  const run = (args: string[] = []) =>
    execFileSync(process.execPath, [launcher, ...args], {
      env: {},
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
      maxBuffer: 4096,
    });
  await writeFile(
    stub,
    'Object.defineProperty(process, "platform", { value: "linux" }); process.getuid = () => 1234; export function serveLinuxMaintenanceStdio() { process.stdout.write("observer_started"); }\n',
  );
  expect(run()).toBe("observer_started");
  expect(() => run(["--path=/etc/shadow"])).toThrow();
  await writeFile(
    stub,
    'process.getuid = () => 0; export function serveLinuxMaintenanceStdio() { throw new Error("must_not_launch"); }\n',
  );
  expect(() => run()).toThrow();
});

it("keeps tunnel/service handoff independent of the work route and contains no populated identity", async () => {
  const profile = await readFile(new URL("tunnel-profile.yaml.template", directory), "utf8");
  const unit = await readFile(new URL("maintenance-tunnel.service.template", directory), "utf8");
  expect(profile).toContain("api_key: file:@DEDICATED_MAINTENANCE_KEY_FILE@");
  expect(profile).toContain("command: @PINNED_NODE@ @REVIEWED_MAINTENANCE_LAUNCHER@");
  expect(unit).toContain("ExecStart=/usr/bin/env -i ");
  expect(unit).toContain("Restart=no");
  expect(unit).toContain("KillMode=control-group");
  expect(unit).not.toMatch(/^(?:After|Wants|Requires|PartOf|BindsTo)=.*orca-/m);
  expect(profile + unit).not.toMatch(
    /ORCA_MCP_TOKEN|ORCA_CONFIG|MCP_SERVER_URL|MCP_COMMAND|NODE_OPTIONS|\/home\/casey|tunnel_[a-z0-9]{12,}/,
  );
});
