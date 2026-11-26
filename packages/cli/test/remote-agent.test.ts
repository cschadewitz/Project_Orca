/**
 * `orca remote agent` (#1236): agents on a server `remote add` set up, only through the host key
 * it pinned. The tunnel is a fake whose "server" is a temporary home on this machine, where each
 * remote command runs as its words, so `orca-host-agents.py` really runs there.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SshTunnelOptions } from "@orca/protocol/remote-access";
import { remoteCommand } from "../src/commands/remote.js";
import type { CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
const saved = process.env.XDG_CONFIG_HOME;
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-remote-agent-"));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  process.env.XDG_CONFIG_HOME = temp();
});
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ON = { features: { env: { ORCA_INCUBATING: "tailnet-hosts" } } };

function ctx(positionals: string[], flags: CommandContext["flags"] = {}) {
  const lines: string[] = [];
  const errs: string[] = [];
  const context: CommandContext = {
    cwd: temp(),
    flags,
    positionals,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
  };
  return { context, lines, errs };
}

function setup() {
  const home = temp();
  mkdirSync(join(home, ".local/share/orca-server"), { recursive: true });
  const opened: SshTunnelOptions[] = [];
  const tunnel = (options: SshTunnelOptions) => ({
    pinnedKeys: "k",
    open: async () => {
      opened.push(options);
      return "http://127.0.0.1:1";
    },
    exec: async (command: readonly string[], _timeout?: number, input?: string) => {
      const result = spawnSync(command[0]!, command.slice(1), {
        cwd: home,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        encoding: "utf8",
        input,
      });
      return { code: result.status ?? 255, stdout: result.stdout ?? "", serverLines: [] };
    },
    close: async () => {},
  });
  return { home, tunnel, opened };
}

describe("orca remote agent", () => {
  it("reports each agent over a pinned-only connection", async () => {
    const { tunnel, opened } = setup();
    const { context, lines } = ctx(["agent", "status", "casey@lab"]);
    await expect(remoteCommand(context, { tunnel, tailnet: ON })).resolves.toBe(0);
    expect(opened[0]).toMatchObject({ pinnedOnly: true });
    expect(opened[0]!.knownHostsFile).toMatch(/known_hosts\/casey-lab$/);
    expect(lines).toEqual(["Codex: not installed; signed in: no", "GitHub Copilot CLI: not installed; signed in: no"]);
  });

  it("is not available with the flag off, and needs one named agent to install or sign in", async () => {
    const { tunnel, opened } = setup();
    await expect(remoteCommand(ctx(["agent", "status", "casey@lab"]).context, { tunnel })).rejects.toThrow(
      /not available in this build/,
    );
    await expect(remoteCommand(ctx(["agent", "login", "casey@lab"]).context, { tunnel, tailnet: ON })).rejects.toThrow(
      /--agent names the agent/,
    );
    await expect(
      remoteCommand(ctx(["agent", "install", "casey@lab"], { agent: ["claude"] }).context, { tunnel, tailnet: ON }),
    ).rejects.toThrow(/No agent called claude/);
    expect(opened).toHaveLength(0);
  });
});
