/**
 * The client side of one-step server setup (#881): what the person is shown and confirms is
 * exactly what ssh would print, and the confirmation is bound to all of it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConnectionProfileSchema, type RemoteResult } from "../src/remote-access.js";
import {
  confirmationCode,
  confirmedResult,
  discoverServer,
  LEGACY_LAUNCHER,
  LEGACY_SETUP_LINE,
  readSetup,
  INSPECT_TIMEOUT_MS,
  inspectCommand,
  inspectInvocation,
  keyFingerprints,
  launcherCommand,
  managedLauncher,
  readInspection,
  serverOs,
  setupCommand,
  setupInvocation,
  SETUP_TIMEOUT_MS,
  WINDOWS_COMMAND,
  WINDOWS_SETUP_SCRIPT,
  WINDOWS_SETUP_TIMEOUT_MS,
} from "../src/server-setup.js";

/** The shipped setup files. */
const DEPLOY = fileURLToPath(new URL("../../../tools/deploy/", import.meta.url));

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMGC5YgJWg846Er1M8f6jE+18UxKVqDbV+HNuA7JZB+l";

describe("server setup confirmation (#881)", () => {
  it("shows host keys as ssh-keygen -l does", () => {
    // `ssh-keygen -lf` of this key: SHA256:AoBh5CZHxZdn9fXciS2K6KkP0njP09OhLkUwfWqW9Eo
    const keys = JSON.stringify([KEY, KEY]);
    expect(keyFingerprints(keys)).toEqual({
      server: ["ssh-ed25519 SHA256:AoBh5CZHxZdn9fXciS2K6KkP0njP09OhLkUwfWqW9Eo"],
      jump: ["ssh-ed25519 SHA256:AoBh5CZHxZdn9fXciS2K6KkP0njP09OhLkUwfWqW9Eo"],
    });
    expect(keyFingerprints(JSON.stringify([KEY, null]))).not.toHaveProperty("jump");
  });

  it("binds the code to the connection, keys, account, directory, install-or-repair, version, revision and scope", () => {
    const profile = ConnectionProfileSchema.parse({ id: "lab", name: "Lab", destination: "dev@lab" });
    const base = {
      profile,
      keys: JSON.stringify([KEY, null]),
      account: "dev",
      root: "/home/dev/.local/share/orca-server",
      current: null as string | null,
      version: "0.8.0",
      scope: "install" as const,
    };
    const code = confirmationCode(base);
    expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(confirmationCode({ ...base })).toBe(code);
    for (const changed of [
      { ...base, profile: { ...profile, sshPort: 2222 } },
      { ...base, profile: { ...profile, jump: { destination: "gw" } } },
      { ...base, keys: JSON.stringify([KEY, KEY]) },
      { ...base, account: "root" },
      { ...base, root: "/srv/orca-server" },
      { ...base, current: "0.8.0" },
      { ...base, version: "0.8.1" },
      { ...base, scope: "install-and-sign-in" as const },
      { ...base, revision: 1 },
      { ...base, os: "windows" as const },
    ])
      expect(confirmationCode(changed)).not.toBe(code);
  });

  it("inspects read only, and sets up only as the confirmed account", () => {
    expect(inspectCommand("0.8.0", 6722)).toEqual([
      "python3",
      "-",
      "--version",
      "0.8.0",
      "--port",
      "6722",
      "--inspect",
    ]);
    const root = "/home/dev/.local/share/orca-server";
    const as = (account: string, at = root, current: string | null = null) =>
      setupCommand("0.8.0", 6722, { account, root: at, current });
    expect(as("dev")).toEqual([
      "python3",
      "-",
      "--version",
      "0.8.0",
      "--port",
      "6722",
      "--expect-account",
      "dev",
      "--expect-root",
      root,
      "--expect-current",
      "none",
    ]);
    expect(as("dev", root, "0.8.0").at(-1)).toBe("0.8.0");
    expect(() => as("-oProxyCommand=x")).toThrow("account");
    expect(() => as("-x")).toThrow("account");
    expect(() => as("dev lab")).toThrow("account");
    expect(() => as("")).toThrow("account");
    expect(() => as("dev", "relative/dir")).toThrow("directory");
    expect(() => as("dev", "/home/dev/../root")).toThrow("directory");
    expect(() => as("dev", "/home/dev; rm -rf /")).toThrow("directory");
    expect(() => as("dev", root, "latest")).toThrow("release version");
  });

  it("reads an inspection, and nothing else as one", () => {
    const line = (value: unknown) => `orca-setup: ${JSON.stringify(value)}`;
    const inspected = { inspected: true, account: "dev", root: "/home/dev/.local/share/orca-server", current: null };
    expect(readInspection({ code: 0, serverLines: [], stdout: line(inspected) })).toMatchObject({
      kind: "inspected",
      inspected,
    });
    // A refusal wins over a stray inspected line; a nonzero exit is never inspected.
    expect(
      readInspection({
        code: 2,
        serverLines: [],
        stdout: [line({ step: "inventory", result: "refused", detail: "x" }), line(inspected)].join("\n"),
      }).kind,
    ).toBe("refused");
    expect(readInspection({ code: 1, serverLines: [], stdout: line(inspected) }).kind).toBe("unknown");
    expect(readInspection({ code: 0, serverLines: [], stdout: line({ ...inspected, account: "a b" }) }).kind).toBe(
      "unknown",
    );
  });

  it("calls a failure failed only once its put-back is confirmed", () => {
    const line = (value: unknown) => `orca-setup: ${JSON.stringify(value)}`;
    const failed = line({ step: "start", result: "failed", detail: "unhealthy" });
    const read = (...lines: string[]) => readSetup({ code: 1, serverLines: [], stdout: lines.join("\n") });
    expect(read(failed, line({ step: "cleanup", result: "ok", detail: "" }))).toMatchObject({
      kind: "failed",
      step: "start",
      detail: "unhealthy",
    });
    expect(read(failed, line({ step: "cleanup", result: "failed", detail: "active is not back" }))).toMatchObject({
      kind: "unknown",
      detail: "active is not back",
    });
    expect(read(failed)).toMatchObject({ kind: "unknown" });
    const refused = line({ step: "files", result: "refused", detail: "owned key" });
    expect(read(refused, line({ step: "cleanup", result: "ok", detail: "" })).kind).toBe("refused");
    expect(read(refused).kind).toBe("refused");
    expect(read(refused, line({ step: "cleanup", result: "failed", detail: "x" })).kind).toBe("unknown");
  });

  it("accepts a ready result only as exactly the setup confirmed", () => {
    const root = "/home/dev/.local/share/orca-server";
    const ready = {
      kind: "ready" as const,
      steps: [],
      command: `${root}/orca`,
      version: "0.8.0",
      port: 6722,
      account: "dev",
      root,
    };
    const expected = { version: "0.8.0", port: 6722, account: "dev", root };
    expect(confirmedResult(ready, expected)).toBe(ready);
    for (const changed of [
      { port: 7000 },
      { version: "0.8.1" },
      { account: "root" },
      { root: "/tmp/x" },
      { command: "/tmp/orca" },
      { command: `${root}/../orca` },
    ])
      expect(confirmedResult({ ...ready, ...changed }, expected).kind).toBe("mismatch");
  });

  it("accepts the launcher a server set up before the rename keeps, derived from the same directory", () => {
    const root = "/home/dev/.local/share/orca-server";
    const expected = { version: "0.9.0", port: 6722, account: "dev", root };
    const ready = { kind: "ready" as const, steps: [], version: "0.9.0", port: 6722, account: "dev", root };
    for (const command of [managedLauncher(root), `${root}/${LEGACY_LAUNCHER}`])
      expect(confirmedResult({ ...ready, command }, expected).kind).toBe("ready");
    expect(confirmedResult({ ...ready, command: `/elsewhere/${LEGACY_LAUNCHER}` }, expected).kind).toBe("mismatch");
  });

  it("reads the lines of a setup from before the rename", () => {
    const done = { done: true, root: "/srv/s", command: "/srv/s/x", account: "dev", version: "0.8.0", port: 6722 };
    const outcome = readSetup({
      code: 0,
      stdout: `${LEGACY_SETUP_LINE}${JSON.stringify({ step: "start", result: "ok" })}\n${LEGACY_SETUP_LINE}${JSON.stringify(done)}\n`,
      serverLines: [],
    });
    expect(outcome).toMatchObject({ kind: "ready", command: "/srv/s/x", steps: [{ step: "start", result: "ok" }] });
  });
});

describe("a Windows server (#1238)", () => {
  const account = "DESK-1\\casey";
  const root = "C:\\Users\\casey\\AppData\\Local\\orca-server";
  const line = (value: unknown) => `orca-setup: ${JSON.stringify(value)}`;
  const result = (stdout: string, code = 0): RemoteResult => ({ code, stdout, serverLines: [] });

  it("is told apart by its own answer to ver", async () => {
    const answering = (answer: RemoteResult) => ({ exec: async () => answer });
    const ver = "\r\nMicrosoft Windows [Version 10.0.26100.4349]\r\n";
    expect(await serverOs(answering(result(ver)))).toBe("windows");
    expect(await serverOs(answering(result("", 127)))).toBe("linux");
    expect(await serverOs(answering(result(ver, 1)))).toBe("linux");
    expect(await serverOs(answering(result("Microsoft Windows, said a shell script")))).toBe("linux");
  });

  it("sends fixed PowerShell words, and on standard input whole statements carrying its arguments and the script", () => {
    const script = readFileSync(join(DEPLOY, WINDOWS_SETUP_SCRIPT));
    const inspect = inspectInvocation("windows", DEPLOY, "0.9.0", 6722);
    expect(inspect.command).toEqual(WINDOWS_COMMAND);
    expect(inspect.command).toEqual([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "-",
    ]);
    const lines = inspect.input.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines[0]).toBe("$o=@{Version='0.9.0';Port=6722;Inspect=$true}");
    expect(lines[1]).toBe("$b=New-Object System.Text.StringBuilder");
    expect(lines.at(-2)).toBe(
      "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b.ToString())))) @o; exit $LASTEXITCODE",
    );
    // The chunks between are the script as shipped, byte for byte, each a statement of its own.
    const chunks = lines
      .slice(2, -2)
      .map((line) => /^\[void\]\$b\.Append\('([A-Za-z0-9+/=]{1,4000})'\)$/.exec(line)?.[1]);
    expect(chunks.every((chunk) => chunk !== undefined)).toBe(true);
    expect(Buffer.from(chunks.join(""), "base64").equals(script)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);

    const setup = setupInvocation("windows", DEPLOY, "0.9.0", 6723, { account, root, current: null });
    expect(setup.command).toEqual(WINDOWS_COMMAND);
    expect(setup.input.split("\n")[0]).toBe(
      `$o=@{Version='0.9.0';Port=6723;ExpectAccount='${account}';ExpectRoot='${root}';ExpectCurrent='none'}`,
    );
    expect(setupInvocation("windows", DEPLOY, "0.9.0", 6722, { account, root, current: "0.8.0" }).input).toContain(
      "ExpectCurrent='0.8.0'",
    );
    // Linux is unchanged.
    expect(inspectInvocation("linux", DEPLOY, "0.9.0", 6722).command).toEqual(inspectCommand("0.9.0", 6722));
  });

  it("gives a Windows setup's session longer than its own download deadlines, and Linux its own budget", () => {
    const confirmed = { account, root, current: null };
    expect(setupInvocation("windows", DEPLOY, "0.9.0", 6722, confirmed).timeoutMs).toBe(WINDOWS_SETUP_TIMEOUT_MS);
    expect(inspectInvocation("windows", DEPLOY, "0.9.0", 6722).timeoutMs).toBe(INSPECT_TIMEOUT_MS);
    const linux = { account: "casey", root: "/home/casey/.local/share/orca-server", current: null };
    expect(setupInvocation("linux", DEPLOY, "0.9.0", 6722, linux).timeoutMs).toBe(SETUP_TIMEOUT_MS);
    expect(inspectInvocation("linux", DEPLOY, "0.9.0", 6722).timeoutMs).toBe(INSPECT_TIMEOUT_MS);
    expect(SETUP_TIMEOUT_MS).toBe(30 * 60_000);
    expect(WINDOWS_SETUP_TIMEOUT_MS).toBeGreaterThan(SETUP_TIMEOUT_MS);
  });

  it("reports a Windows daemon started at its account's logon, not at boot", () => {
    const done = (start?: string) => ({
      code: 0,
      serverLines: [],
      stdout: `orca-setup: ${JSON.stringify({ done: true, root, command: `${root}\\orca.cmd`, account, version: "0.9.0", port: 6722, ...(start ? { start } : {}) })}`,
    });
    expect(readSetup(done("logon"))).toMatchObject({ kind: "ready", startsAt: "logon" });
    expect(readSetup(done("boot"))).not.toHaveProperty("startsAt");
    // The Linux setup says nothing of it.
    expect(readSetup(done())).not.toHaveProperty("startsAt");
    expect(readSetup(done("sometimes")).kind).toBe("unknown");
  });

  it("refuses anything that is not a Windows account, setup directory or release, and a carried bundle", () => {
    const run = (confirmed: { account: string; root: string; current: string | null }, bundle?: string) =>
      setupInvocation("windows", DEPLOY, "0.9.0", 6722, confirmed, bundle);
    for (const bad of ["casey", "DESK-1\\o'brien", "DESK-1\\a\\b", "DESK-1\\$(x)"])
      expect(() => run({ account: bad, root, current: null })).toThrow(/Not an account name/);
    for (const bad of [
      "/home/casey",
      "C:\\Users\\..\\Public",
      "C:\\Users\\o'brien",
      "\\\\host\\share\\orca",
      "C:/Users/casey",
    ])
      expect(() => run({ account, root: bad, current: null })).toThrow(/Not a setup directory/);
    expect(() => run({ account, root, current: "latest" })).toThrow(/Not a release version/);
    expect(() => run({ account, root, current: null }, "C:/Temp/bundle")).toThrow(/not available yet/);
    expect(() => inspectInvocation("windows", DEPLOY, "0.9", 6722)).toThrow(/Not a release version/);
  });

  it("reads what a Windows inspection found, in Windows forms only", () => {
    const found = { inspected: true, account, root, current: null };
    expect(readInspection(result(line(found)), "windows")).toMatchObject({ kind: "inspected", inspected: found });
    // A Linux inspection does not pass as a Windows one, nor the other way round.
    expect(readInspection(result(line(found)), "linux").kind).toBe("unknown");
    expect(
      readInspection(
        result(line({ ...found, account: "casey", root: "/home/casey/.local/share/orca-server" })),
        "windows",
      ).kind,
    ).toBe("unknown");
  });

  it("refuses at inspection a directory no server command can name, before anything is installed", () => {
    const spaced = "C:\\Users\\Casey S\\AppData\\Local\\orca-server";
    const outcome = readInspection(
      result(line({ inspected: true, account: "DESK-1\\Casey S", root: spaced, current: null })),
      "windows",
    );
    expect(outcome).toMatchObject({ kind: "refused", step: "inspect" });
    expect(outcome.kind === "refused" && outcome.detail).toMatch(/has a space\. Nothing was changed\./);
  });

  it("derives the launcher from the confirmed directory, and names it with / as a server command", () => {
    expect(managedLauncher(root, "windows")).toBe(`${root}\\orca.cmd`);
    expect(launcherCommand(root, "windows")).toBe("C:/Users/casey/AppData/Local/orca-server/orca.cmd");
    expect(launcherCommand("/home/casey/.local/share/orca-server")).toBe("/home/casey/.local/share/orca-server/orca");
    const ready = readSetup(
      result(
        line({
          done: true,
          root,
          command: `${root}\\orca.cmd`,
          account,
          version: "0.9.0",
          port: 6722,
          platform: "win-x64",
        }),
      ),
    );
    expect(ready.kind).toBe("ready");
    const expected = { version: "0.9.0", port: 6722, account, root };
    expect(confirmedResult(ready, expected, "windows")).toBe(ready);
    // The Linux launcher for that directory is not what was set up.
    expect(confirmedResult(ready, expected).kind).toBe("mismatch");
  });

  it("discovers a Windows server: asks which system it is, then inspects it with the Windows setup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-discover-windows-"));
    const pins = join(dir, "pins");
    writeFileSync(pins, `orca-lab ${KEY}\n`);
    const ran: { command: readonly string[]; input?: string }[] = [];
    try {
      const discovery = await discoverServer({
        base: {
          profile: ConnectionProfileSchema.parse({ id: "lab", name: "Lab", destination: "casey@desk" }),
          knownHostsFile: pins,
        },
        tunnel: () => ({
          open: async () => "http://127.0.0.1:1",
          exec: async (command, _timeout, input) => {
            ran.push({ command, ...(input !== undefined ? { input } : {}) });
            return command[0] === "ver"
              ? result("Microsoft Windows [Version 10.0.26100.4349]")
              : result(line({ inspected: true, account, root, current: null }));
          },
          close: async () => {},
          pinnedKeys: JSON.stringify([KEY, null]),
        }),
        version: "0.9.0",
        scripts: DEPLOY,
      });
      expect(discovery.os).toBe("windows");
      expect(discovery.outcome.kind).toBe("inspected");
      expect(ran.map((r) => r.command)).toEqual([["ver"], WINDOWS_COMMAND]);
      expect(ran[1]!.input).toBe(inspectInvocation("windows", DEPLOY, "0.9.0", 6722).input);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
