/**
 * `orca remote add` (#881): the first run inspects read only and holds a first-seen host key
 * aside; only `--confirm` with the code bound to what the server still presents pins that key
 * and runs the setup, pinned-only and as the confirmed account. The transport is a fake that
 * behaves like the real one about pins; the setup script itself is tested in tools/deploy.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pinState,
  tunnelKeyIdentity,
  TunnelRefusal,
  type RemoteResult,
  type SshTunnelOptions,
} from "@orca/protocol/remote-access";
import { remoteCommand, setupScripts } from "../src/commands/remote.js";
import type { CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
let config: string;
const saved = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  config = temp();
  process.env.XDG_CONFIG_HOME = config;
});
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-remote-add-"));
  dirs.push(dir);
  return dir;
}

function scripts(): string {
  const dir = temp();
  writeFileSync(join(dir, "orca-server-setup.py"), "print('setup')\n");
  writeFileSync(join(dir, "orca-release.py"), "print('adapter')\n");
  return dir;
}

function ctx(positionals: string[], flags: CommandContext["flags"] = {}) {
  const lines: string[] = [];
  const errs: string[] = [];
  const context: CommandContext = {
    cwd: process.cwd(),
    flags,
    positionals,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
  };
  return { context, lines, errs };
}

const line = (value: unknown) => `orca-setup: ${JSON.stringify(value)}`;
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrcaServerKeyOne000000000000000000000000";
const OTHER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrcaServerKeyTwo000000000000000000000000";

const INSPECTED: RemoteResult = {
  code: 0,
  serverLines: [],
  stdout: [
    line({ step: "platform", result: "ok", detail: "Linux x64" }),
    line({ inspected: true, account: "dev", root: "/home/dev/.local/share/orca-server", current: null }),
  ].join("\n"),
};
const READY: RemoteResult = {
  code: 0,
  serverLines: [],
  stdout: [
    "noise from a login shell",
    line({ step: "platform", result: "ok", detail: "Linux x86_64" }),
    line({ step: "stage", result: "changed", detail: "" }),
    line({
      done: true,
      account: "dev",
      root: "/home/dev/.local/share/orca-server",
      command: "/home/dev/.local/share/orca-server/orca",
      version: "0.8.0",
      port: 6722,
    }),
  ].join("\n"),
};

/** A server presenting `key`, answering an inspection and a setup. */
function fakeServer(opts: { key?: string; inspect?: RemoteResult; setup?: RemoteResult } = {}) {
  const server = {
    key: opts.key ?? KEY,
    commands: [] as { command: string[]; input?: string | undefined; options: SshTunnelOptions }[],
  };
  const make = (options: SshTunnelOptions) => {
    let sealed: string | undefined;
    return {
      get pinnedKeys() {
        return sealed;
      },
      open: async () => {
        const pins = options.knownHostsFile;
        if (pinState(pins) === "none") {
          if (options.pinnedOnly) throw new TunnelRefusal("host-key-missing");
          mkdirSync(dirname(pins), { recursive: true });
          writeFileSync(pins, `lab ${server.key}\n`); // accept-new
        }
        if (!readFileSync(pins, "utf8").includes(server.key)) throw new TunnelRefusal("host-key-changed");
        sealed = tunnelKeyIdentity(pins, false);
        if (options.expectKeys !== undefined && sealed !== options.expectKeys)
          throw new TunnelRefusal("host-key-changed");
        return "http://127.0.0.1:1";
      },
      exec: async (command: readonly string[], _timeout?: number, input?: string) => {
        server.commands.push({ command: [...command], input, options });
        return command.includes("--inspect") ? (opts.inspect ?? INSPECTED) : (opts.setup ?? READY);
      },
      close: async () => {},
    };
  };
  return { server, make };
}

const pinFile = () => join(config, "orca", "known_hosts", "lab");
const codeOf = (errs: string[]) => /--confirm (\S+)$/.exec(errs.at(-1)!)![1]!;

describe("orca remote add (#881)", () => {
  it("finds the setup files in a source checkout", () => {
    expect(setupScripts()).toBeTruthy();
  });

  it("first only inspects: it pins nothing, changes nothing, and asks for a confirmation", async () => {
    const { server, make } = fakeServer();
    const { context, lines, errs } = ctx(["add", "lab"]);
    const code = await remoteCommand(context, { tunnel: make, scripts: scripts(), version: "0.8.0" });
    expect(code).toBe(3);
    expect(server.commands.map((c) => c.command)).toEqual([
      ["python3", "-", "--version", "0.8.0", "--port", "6722", "--inspect"],
    ]);
    // The first-seen key was held aside, never pinned for the server.
    expect(server.commands[0]!.options.knownHostsFile).not.toBe(pinFile());
    expect(existsSync(pinFile())).toBe(false);
    expect(lines.join("\n")).toMatch(/Host key: ssh-ed25519 SHA256:\S+ \(not pinned yet\)/);
    expect(lines).toContain("Account: dev");
    expect(lines.join("\n")).toContain("Would install ORCA 0.8.0");
    expect(errs.at(-1)).toMatch(/run again with --confirm [0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });

  it("with the code: pins exactly the keys shown, then sets up pinned-only as the confirmed account", async () => {
    const { server, make } = fakeServer();
    const first = ctx(["add", "dev@lab"], { "ssh-port": "2222" });
    expect(await remoteCommand(first.context, { tunnel: make, scripts: scripts(), version: "0.8.0" })).toBe(3);

    const { context, lines, errs } = ctx(["add", "dev@lab"], { "ssh-port": "2222", confirm: codeOf(first.errs) });
    const code = await remoteCommand(context, { tunnel: make, scripts: scripts(), version: "0.8.0" });
    expect(code).toBe(0);
    const setup = server.commands.at(-1)!;
    const pins = setup.options.knownHostsFile;
    expect(dirname(pins)).toBe(join(config, "orca", "known_hosts"));
    expect(readFileSync(pins, "utf8")).toContain(KEY);
    expect(setup.command).toEqual([
      "python3",
      "-",
      "--version",
      "0.8.0",
      "--port",
      "6722",
      "--expect-account",
      "dev",
      "--expect-root",
      "/home/dev/.local/share/orca-server",
      "--expect-current",
      "none",
    ]);
    expect(setup.options).toMatchObject({ pinnedOnly: true, expectKeys: expect.any(String) });
    expect(setup.options.profile).toMatchObject({ destination: "dev@lab", sshPort: 2222 });
    expect(setup.input).toContain("EMBEDDED_ADAPTER");
    expect(setup.input).toContain("print('setup')");
    expect(lines.slice(-3)).toEqual([
      "platform: already done (Linux x86_64)",
      "stage: done",
      expect.stringContaining("dev@lab is a managed ORCA server (v0.8.0)"),
    ]);
    // It issues no credential and prints none.
    expect([...lines, ...errs].join("\n")).not.toMatch(/orca1\./);
  });

  it("refuses a code that no longer matches what the server presents, and pins nothing", async () => {
    const { server, make } = fakeServer();
    const first = ctx(["add", "lab"]);
    await remoteCommand(first.context, { tunnel: make, scripts: scripts(), version: "0.8.0" });
    const confirmation = codeOf(first.errs);

    // Another key answers now: the code was for the first one.
    server.key = OTHER;
    let run = ctx(["add", "lab"], { confirm: confirmation });
    expect(await remoteCommand(run.context, { tunnel: make, scripts: scripts(), version: "0.8.0" })).toBe(2);
    expect(run.errs.at(-1)).toContain("does not match");
    expect(existsSync(pinFile())).toBe(false);
    expect(server.commands.every((c) => c.command.includes("--inspect"))).toBe(true);

    // The same key, but another directory, or a repair where an install was confirmed.
    for (const changed of [
      INSPECTED.stdout.replace("/home/dev/.local/share/orca-server", "/srv/orca-server"),
      INSPECTED.stdout.replace('"current":null', '"current":"0.8.0"'),
    ]) {
      const moved = fakeServer({ inspect: { ...INSPECTED, stdout: changed } });
      run = ctx(["add", "lab"], { confirm: confirmation });
      expect(await remoteCommand(run.context, { tunnel: moved.make, scripts: scripts(), version: "0.8.0" })).toBe(2);
      expect(moved.server.commands.every((c) => c.command.includes("--inspect"))).toBe(true);
    }

    // The same key under another account, or for another version: also not what was confirmed.
    const other = fakeServer({
      inspect: { ...INSPECTED, stdout: INSPECTED.stdout.replace('"account":"dev"', '"account":"root"') },
    });
    run = ctx(["add", "lab"], { confirm: confirmation });
    expect(await remoteCommand(run.context, { tunnel: other.make, scripts: scripts(), version: "0.8.0" })).toBe(2);
    server.key = KEY;
    run = ctx(["add", "lab"], { confirm: confirmation });
    expect(await remoteCommand(run.context, { tunnel: make, scripts: scripts(), version: "0.8.1" })).toBe(2);
    expect(existsSync(pinFile())).toBe(false);
    expect(other.server.commands.every((c) => c.command.includes("--inspect"))).toBe(true);
  });

  it("an already pinned server is inspected pinned-only, and a changed key refuses", async () => {
    mkdirSync(dirname(pinFile()), { recursive: true });
    writeFileSync(pinFile(), `lab ${KEY}\n`);
    const { server, make } = fakeServer();
    const run = ctx(["add", "lab"]);
    expect(await remoteCommand(run.context, { tunnel: make, scripts: scripts(), version: "0.8.0" })).toBe(3);
    expect(server.commands[0]!.options).toMatchObject({ knownHostsFile: pinFile(), pinnedOnly: true });
    expect(run.lines.join("\n")).toContain("(pinned)");
    server.key = OTHER;
    await expect(
      remoteCommand(ctx(["add", "lab"]).context, { tunnel: make, scripts: scripts(), version: "0.8.0" }),
    ).rejects.toThrow(TunnelRefusal);
  });

  it("maps a refused, failed or unreported setup to its exit code", async () => {
    const confirmed = async (result: RemoteResult) => {
      rmSync(join(config, "orca"), { recursive: true, force: true });
      const { make } = fakeServer({ setup: result });
      const first = ctx(["add", "lab"]);
      await remoteCommand(first.context, { tunnel: make, scripts: scripts(), version: "0.8.0" });
      const run = ctx(["add", "lab"], { confirm: codeOf(first.errs) });
      return { code: await remoteCommand(run.context, { tunnel: make, scripts: scripts(), version: "0.8.0" }), run };
    };
    let { code, run } = await confirmed({
      code: 2,
      serverLines: [],
      stdout: line({ step: "existing", result: "refused", detail: "current is v0.7.9, not v0.8.0." }),
    });
    expect(code).toBe(2);
    expect(run.errs.at(-1)).toContain("Not set up");
    ({ code, run } = await confirmed({
      code: 1,
      serverLines: [],
      stdout: [
        line({ step: "start", result: "failed", detail: "The unit did not start." }),
        line({ step: "cleanup", result: "ok", detail: "" }),
      ].join("\n"),
    }));
    expect(code).toBe(1);
    expect(run.errs.at(-1)).toContain('Setup failed at "start"');
    ({ code, run } = await confirmed({ code: 255, serverLines: [], stdout: "" }));
    expect(code).toBe(1);
    expect(run.errs.at(-1)).toContain("did not report how it ended");
    ({ code, run } = await confirmed({
      code: 1,
      serverLines: [],
      stdout: [
        line({ step: "start", result: "failed", detail: "health" }),
        line({ step: "cleanup", result: "failed", detail: "active is not back as it was" }),
      ].join("\n"),
    }));
    expect(code).toBe(1);
    expect(run.errs.at(-1)).toContain("could not confirm that everything is back");
    // A result other than the one confirmed: none of it is used.
    ({ code, run } = await confirmed({
      ...READY,
      stdout: READY.stdout.replace('"port":6722', '"port":7000'),
    }));
    expect(code).toBe(1);
    expect(run.errs.at(-1)).toContain("port 7000, not 6722");
    expect(run.lines.join("\n")).not.toContain("is a managed ORCA server");

    // A refusal found by the inspection itself: before any confirmation.
    const { make } = fakeServer({
      inspect: {
        code: 2,
        serverLines: [],
        stdout: line({ step: "inventory", result: "refused", detail: "An unmanaged ORCA launcher." }),
      },
    });
    const refused = ctx(["add", "other"]);
    expect(await remoteCommand(refused.context, { tunnel: make, scripts: scripts(), version: "0.8.0" })).toBe(2);
    expect(refused.errs.at(-1)).toContain("Not set up");
  });

  it("refuses bad arguments before reaching any server", async () => {
    const { server, make } = fakeServer();
    for (const [positionals, flags] of [
      [["add"], {}],
      [["list"], {}],
      [["add", "a", "b"], {}],
      [["add", "lab"], { port: "70000" }],
      [["add", "lab"], { "ssh-port": "x" }],
      [["add", "-oProxyCommand=x"], {}],
    ] as [string[], CommandContext["flags"]][]) {
      await expect(
        remoteCommand(ctx(positionals, flags).context, { tunnel: make, scripts: scripts(), version: "0.8.0" }),
      ).rejects.toThrow();
    }
    expect(server.commands).toEqual([]);
  });
});
