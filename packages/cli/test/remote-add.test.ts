/**
 * `orca remote add` (#881): it runs this checkout's setup program on the server over ORCA's own
 * ssh, pins the host key per server, reports each step, and maps how the setup ended to an exit
 * code. The transport is a fake; the setup script itself is tested in tools/deploy.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteResult } from "@orca/protocol/remote-access";
import { remoteCommand, setupScripts } from "../src/commands/remote.js";
import type { CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scripts(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-remote-add-"));
  dirs.push(dir);
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

function fakeTunnel(result: RemoteResult) {
  const calls: { options?: unknown; command?: string[]; input?: string | undefined; closed: boolean } = {
    closed: false,
  };
  const make = (options: unknown) => {
    calls.options = options;
    return {
      hostKeyFingerprint: "SHA256:abc",
      open: async () => {},
      exec: async (command: string[], _timeout?: number, input?: string) => {
        calls.command = command;
        calls.input = input;
        return result;
      },
      close: async () => {
        calls.closed = true;
      },
    };
  };
  return { make: make as never, calls };
}

describe("orca remote add (#881)", () => {
  it("finds the setup files in a source checkout", () => {
    expect(setupScripts()).toBeTruthy();
  });

  it("runs the setup over ssh with its adapter embedded and reports a ready server", async () => {
    const { make, calls } = fakeTunnel({
      code: 0,
      serverLines: [],
      stdout: [
        "noise from a login shell",
        line({ step: "platform", result: "ok", detail: "Linux x86_64" }),
        line({ step: "stage", result: "changed", detail: "" }),
        line({
          done: true,
          root: "/home/u/.local/share/orca-server",
          command: "/home/u/.local/share/orca-server/orca",
          version: "0.8.0",
          port: 6722,
        }),
      ].join("\n"),
    });
    const { context, lines, errs } = ctx(["add", "dev@lab"], { "ssh-port": "2222" });
    const code = await remoteCommand(context, { tunnel: make, scripts: scripts(), version: "0.8.0" });
    expect(code).toBe(0);
    expect(calls.command).toEqual(["python3", "-", "--version", "0.8.0", "--port", "6722"]);
    expect(calls.input).toContain("EMBEDDED_ADAPTER");
    expect(calls.input).toContain("print('setup')");
    expect(calls.closed).toBe(true);
    const options = calls.options as { profile: { destination: string; sshPort?: number }; knownHostsFile: string };
    expect(options.profile).toMatchObject({ destination: "dev@lab", sshPort: 2222 });
    expect(options.knownHostsFile).toMatch(/orca[\\/]known_hosts[\\/]/);
    expect(lines).toEqual([
      "platform: already done (Linux x86_64)",
      "stage: done",
      expect.stringContaining("dev@lab is a managed ORCA server (v0.8.0)"),
    ]);
    expect(errs.join("\n")).toContain("SHA256:abc");
    // It issues no credential and prints none.
    expect([...lines, ...errs].join("\n")).not.toMatch(/orca1\./);
  });

  it("maps a refused, failed or unreported setup to its exit code", async () => {
    const refused = fakeTunnel({
      code: 2,
      serverLines: [],
      stdout: line({ step: "inventory", result: "refused", detail: "An unmanaged ORCA launcher is running." }),
    });
    let run = ctx(["add", "lab"]);
    expect(await remoteCommand(run.context, { tunnel: refused.make, scripts: scripts(), version: "0.8.0" })).toBe(2);
    expect(run.errs.at(-1)).toContain("Not set up");

    const failed = fakeTunnel({
      code: 1,
      serverLines: [],
      stdout: line({ step: "start", result: "failed", detail: "The unit did not start." }),
    });
    run = ctx(["add", "lab"]);
    expect(await remoteCommand(run.context, { tunnel: failed.make, scripts: scripts(), version: "0.8.0" })).toBe(1);
    expect(run.errs.at(-1)).toContain('Setup failed at "start"');

    const lost = fakeTunnel({ code: 255, serverLines: [], stdout: "" });
    run = ctx(["add", "lab"]);
    expect(await remoteCommand(run.context, { tunnel: lost.make, scripts: scripts(), version: "0.8.0" })).toBe(1);
    expect(run.errs.at(-1)).toContain("did not report how it ended");
  });

  it("refuses bad arguments before reaching any server", async () => {
    const { make, calls } = fakeTunnel({ code: 0, serverLines: [], stdout: "" });
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
    expect(calls.command).toBeUndefined();
  });
});
