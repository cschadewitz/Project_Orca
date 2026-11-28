/**
 * A Windows server's setup (#1238) over a real Windows OpenSSH server: the client tells it is
 * Windows, sends `tools/deploy/orca-server-setup.ps1` through cmd.exe to Windows PowerShell on
 * standard input, and reads its lines, with the confirmed account and directory carried into the
 * script exactly. Runs when `ORCA_SSH_TUNNEL_TEST` names a Windows sshd (the SSH tunnel check's
 * Windows job; see remote-access.test.ts). The setup's own behaviour on Windows is the Windows
 * server bundle check's (tools/deploy/tests/windows-setup/run.ps1). On any Windows, also the line
 * that turns a Windows machine's OpenSSH Server on: it runs exactly the bytes it checked, or none.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ConnectionProfileSchema, SshTunnel } from "../src/remote-access.js";
import {
  discoverServer,
  dropDiscovery,
  inspectInvocation,
  readSetup,
  serverOs,
  setupInvocation,
  type Inspected,
  WINDOWS_SSH_SCRIPT,
  windowsSshBootstrap,
} from "../src/server-setup.js";

const live = process.env.ORCA_SSH_TUNNEL_TEST
  ? (JSON.parse(process.env.ORCA_SSH_TUNNEL_TEST) as { destination: string; sshPort?: number; identity: string })
  : undefined;
const DEPLOY = fileURLToPath(new URL("../../../tools/deploy/", import.meta.url));

describe.skipIf(!live || process.platform !== "win32")("a Windows server's setup over a real sshd", () => {
  // A function: a skipped suite's body still runs, without `live`.
  const dir = mkdtempSync(join(tmpdir(), "orca-windows-setup-live-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const base = () => ({
    profile: ConnectionProfileSchema.parse({
      id: "winlive",
      name: "Windows live",
      destination: live!.destination,
      ...(live!.sshPort ? { sshPort: live!.sshPort } : {}),
      identityFile: live!.identity,
      remotePort: 6722,
    }),
    knownHostsFile: join(dir, "winlive"),
  });
  let inspected: Inspected | undefined;

  it("answers the probe that tells it is Windows", async () => {
    const tunnel = new SshTunnel({ ...base(), knownHostsFile: join(dir, "winlive-probe") });
    try {
      await tunnel.open();
      const probe = await tunnel.exec(["ver"], 30_000);
      expect(probe, JSON.stringify(probe)).toMatchObject({ code: 0 });
      expect(await serverOs(tunnel), JSON.stringify(probe)).toBe("windows");
      // The inspection itself, as discovery sends it, with everything it printed.
      const inspect = inspectInvocation("windows", DEPLOY, "0.0.1", 6722);
      const raw = await tunnel.exec(inspect.command, 120_000, inspect.input);
      expect(raw, JSON.stringify(raw).slice(0, 6000)).toMatchObject({ code: 0 });
    } finally {
      await tunnel.close();
    }
  }, 180_000);

  it("tells the server is Windows and inspects it read only with the Windows setup", async () => {
    const discovery = await discoverServer({
      base: base(),
      tunnel: (o) => new SshTunnel(o),
      version: "0.0.1",
      scripts: DEPLOY,
    });
    dropDiscovery(discovery);
    expect(discovery.os).toBe("windows");
    expect(discovery.outcome.kind, JSON.stringify(discovery.outcome)).toBe("inspected");
    if (discovery.outcome.kind !== "inspected") return;
    inspected = discovery.outcome.inspected;
    // The sshd session's own account and its own per-user directory, a first install.
    expect(inspected.account.split("\\")[1]?.toLowerCase()).toBe(live!.destination.split("@")[0]!.toLowerCase());
    expect(inspected.root.toLowerCase()).toBe(join(process.env.LOCALAPPDATA!, "orca-server").toLowerCase());
    expect(inspected.current).toBeNull();
    // Read only: nothing was made there.
    expect(existsSync(inspected.root)).toBe(false);
  }, 120_000);

  it("runs the confirmed setup as exactly that account and directory, and puts back a failed one", async () => {
    expect(inspected).toBeDefined();
    const { account, root, current } = inspected!;
    // No release 0.0.1 exists: the run gets through its checks of what was confirmed (account,
    // directory, first install) and its first writes, fails at the download, and puts back.
    const run = setupInvocation("windows", DEPLOY, "0.0.1", 6722, { account, root, current });
    const tunnel = new SshTunnel({ ...base(), knownHostsFile: join(dir, "winlive-setup") });
    let outcome;
    try {
      await tunnel.open();
      outcome = readSetup(await tunnel.exec(run.command, run.timeoutMs, run.input));
    } finally {
      await tunnel.close();
    }
    const steps = Object.fromEntries(outcome.steps.map((step) => [step.step, step.result]));
    expect(steps).toMatchObject({
      account: "ok",
      inventory: "ok",
      fence: "ok",
      confirmed: "ok",
      stage: "failed",
      cleanup: "ok",
    });
    expect(outcome).toMatchObject({ kind: "failed", step: "stage" });
    expect(outcome.kind === "failed" && outcome.detail).toMatch(/0\.0\.1/);
  }, 600_000);
});

describe.skipIf(process.platform !== "win32")("the Windows OpenSSH bootstrap line, in Windows PowerShell", () => {
  // In place of the tag's address, a local file: what the line fetches, checks and runs.
  const dir = mkdtempSync(join(tmpdir(), "orca-windows-ssh-line-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const shipped = join(dir, "shipped");
  const served = join(dir, "served.ps1");
  const run = (command: string) =>
    execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { encoding: "utf8" },
    );
  const bootstrap = (from = pathToFileURL(served).href) => windowsSshBootstrap(shipped, "0.9.0", from).command;
  const script = "Write-Host ('ran the bytes ' + 'it checked')\n";

  it("runs exactly the fetched bytes when they are the shipped copy's, writing no file", () => {
    mkdirSync(shipped);
    writeFileSync(join(shipped, WINDOWS_SSH_SCRIPT), script);
    writeFileSync(served, script);
    const before = new Set(readdirSync(tmpdir()));
    expect(run(bootstrap())).toContain("ran the bytes it checked");
    const after = readdirSync(tmpdir());
    expect(after.filter((name) => name.includes("orca-windows-ssh") && !before.has(name))).toEqual([]);
  });

  it("runs nothing when the fetched bytes differ, or the fetch fails", () => {
    writeFileSync(served, "Write-Host 'ran other bytes'\n");
    const other = run(bootstrap());
    expect(other).toContain("Not the orca-windows-ssh.ps1 this ORCA ships, so nothing was run.");
    expect(other).not.toContain("ran");
    const missing = run(bootstrap(pathToFileURL(join(dir, "missing.ps1")).href));
    expect(missing).toContain("Could not download orca-windows-ssh.ps1, so nothing was run:");
    expect(missing).not.toContain("Not the orca-windows-ssh.ps1");
  });
});
