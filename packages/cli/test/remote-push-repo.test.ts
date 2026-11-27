/**
 * `orca remote push-repo` (#1235): this repository's branch goes to a server `remote add` set up,
 * only through the host key it pinned. The tunnel is a fake whose "server" is a temporary home on
 * this machine, where each remote command runs as its words, so real git runs on both sides.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SshTunnelOptions } from "@orca/protocol/remote-access";
import { remoteCommand } from "../src/commands/remote.js";
import type { CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
const saved = process.env.XDG_CONFIG_HOME;
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-push-repo-"));
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

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const ON = { features: { env: { ORCA_INCUBATING: "tailnet-hosts" } } };

function ctx(positionals: string[], flags: CommandContext["flags"], cwd: string) {
  const lines: string[] = [];
  const errs: string[] = [];
  const context: CommandContext = { cwd, flags, positionals, out: (l) => lines.push(l), err: (l) => errs.push(l) };
  return { context, lines, errs };
}

function setup() {
  const local = temp();
  git(local, "init", "-q", "-b", "main");
  writeFileSync(join(local, "README.md"), "hello\n");
  git(local, "add", ".");
  git(local, "commit", "-q", "-m", "one");
  const home = temp();
  mkdirSync(join(home, ".local/share/orca-server"), { recursive: true });
  const opened: SshTunnelOptions[] = [];
  const tunnel = (options: SshTunnelOptions) => ({
    pinnedKeys: "k",
    open: async () => {
      opened.push(options);
      return "http://127.0.0.1:1";
    },
    exec: async (command: readonly string[]) => {
      const result = spawnSync(command[0]!, command.slice(1), { cwd: home, env, encoding: "utf8" });
      return { code: result.status ?? 255, stdout: result.stdout ?? "", serverLines: [] };
    },
    upload: async (path: string, remote: string) =>
      copyFileSync(path, remote.startsWith("/") ? remote : join(home, remote)),
    close: async () => {},
  });
  return { local, home, tunnel, opened };
}

describe("orca remote push-repo", () => {
  it("pushes the current branch over a pinned-only connection and prints the workspace settings", async () => {
    const { local, home, tunnel, opened } = setup();
    const { context, lines } = ctx(["push-repo", "casey@lab"], { name: "app" }, local);
    await expect(remoteCommand(context, { tunnel, tailnet: ON })).resolves.toBe(0);
    // The same profile id as `remote add casey@lab`, so the same pin file.
    expect(opened[0]).toMatchObject({ pinnedOnly: true, profile: { destination: "casey@lab" } });
    expect(opened[0]!.knownHostsFile).toBe(
      join(process.env.XDG_CONFIG_HOME!, "orca", "known_hosts", opened[0]!.profile.id),
    );
    const checkout = join(home, ".local/share/orca-server/checkouts/app");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(git(local, "rev-parse", "HEAD"));
    expect(lines.join("\n")).toContain(`repo: ${checkout}`);
    expect(lines.join("\n")).toContain("- refs/heads/main");
  });

  it("is refused while the tailnet-hosts flag is off", async () => {
    const { local, tunnel, opened } = setup();
    const { context } = ctx(["push-repo", "casey@lab"], {}, local);
    await expect(remoteCommand(context, { tunnel, tailnet: { features: { env: {} } } })).rejects.toThrow(
      /not available in this build/,
    );
    expect(opened).toEqual([]);
  });

  it("refuses a ref that is not a full branch or tag, before connecting", async () => {
    const { local, tunnel, opened } = setup();
    const { context } = ctx(["push-repo", "casey@lab"], { ref: ["main"] }, local);
    await expect(remoteCommand(context, { tunnel, tailnet: ON })).rejects.toThrow(/not a full branch or tag name/);
    expect(opened).toEqual([]);
  });
});
