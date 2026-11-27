/**
 * The session factory's route for `driver: claude-agent-sdk` (#1118, #1120): the launch checks
 * run, then a Claude Agent SDK session opens, and the ACP opener is never called.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSpecSchema, HostSpecSchema } from "@orca/core";
import { LocalHost, SshHost, type AgentHost, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import { makeSessionFactory } from "../src/bootstrap.js";

const STAND_IN = fileURLToPath(new URL("../../agents/test/fixtures/claude-sdk-stand-in.mjs", import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-factory-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function factoryWithSpy() {
  const open = vi.fn<(o: OpenSessionOptions) => Promise<AgentSession>>(() => Promise.reject(new Error("ACP opened")));
  return { open, factory: makeSessionFactory({ configDir: dir, storeDir: ".orca" }, open) };
}

describe.runIf(process.platform !== "win32")("session factory, driver: claude-agent-sdk (#1118)", () => {
  it("checks the person's claude and opens a Claude Agent SDK session, without opening ACP", async () => {
    const claude = join(dir, "claude");
    await writeFile(
      claude,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}'; exit 0; fi
exec "${process.execPath}" "${STAND_IN}" "$@"
`,
    );
    await chmod(claude, 0o755);
    const { open, factory } = factoryWithSpy();
    const agent = AgentSpecSchema.parse({ id: "claude", driver: "claude-agent-sdk", command: claude });
    const session = await factory({ host: new LocalHost({ id: "local", type: "local" }), agent, cwd: dir });
    try {
      expect(session.agentId).toBe("claude");
      expect((await session.prompt("hello")).stopReason).toBe("end_turn");
    } finally {
      await session.close();
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses nativeToolHook: on before anything runs, and with experimental an unverified Claude Code before it runs at all (#1123, #1124)", async () => {
    const claude = join(dir, "claude");
    const marker = join(dir, "ran");
    const log = join(dir, "stand-in.log");
    await writeFile(
      claude,
      `#!/bin/sh
touch "${marker}"
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}'; exit 0; fi
STAND_IN_LOG="${log}" exec "${process.execPath}" "${STAND_IN}" "$@"
`,
    );
    await chmod(claude, 0o755);
    const { factory } = factoryWithSpy();
    const host = new LocalHost({ id: "local", type: "local" });
    const on = AgentSpecSchema.parse({
      id: "claude",
      driver: "claude-agent-sdk",
      command: claude,
      nativeToolHook: "on",
    });
    await expect(factory({ host, agent: on, cwd: dir })).rejects.toThrow(/nativeToolHook: on/);
    expect(existsSync(marker)).toBe(false);
    // The version it would print is the pinned one, but the file is not a pinned image: it is
    // refused before it is run at all, so it never sees the session's environment.
    const experimental = AgentSpecSchema.parse({
      ...on,
      nativeToolHook: "experimental",
      env: { ANTHROPIC_API_KEY: "sk-orca-1124-credential" },
    });
    await expect(factory({ host, agent: experimental, cwd: dir })).rejects.toThrow(
      /its Claude Code is not one ORCA verified: .* is not a Claude Code ORCA verified .* ORCA refuses to run it at all/,
    );
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it("refuses the session when claude is not signed in, before starting it", async () => {
    const claude = join(dir, "claude");
    await writeFile(
      claude,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
echo '{"loggedIn":false}'; exit 1
`,
    );
    await chmod(claude, 0o755);
    const { open, factory } = factoryWithSpy();
    const agent = AgentSpecSchema.parse({ id: "claude", driver: "claude-agent-sdk", command: claude });
    await expect(factory({ host: new LocalHost({ id: "local", type: "local" }), agent, cwd: dir })).rejects.toThrow(
      /claude auth login/,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses Windows before running even the launch checks", async () => {
    const marker = join(dir, "ran");
    const claude = join(dir, "claude");
    await writeFile(claude, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    await chmod(claude, 0o755);
    const { open, factory } = factoryWithSpy();
    const agent = AgentSpecSchema.parse({ id: "claude", driver: "claude-agent-sdk", command: claude });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(factory({ host: new LocalHost({ id: "local", type: "local" }), agent, cwd: dir })).rejects.toThrow(
        /only on Linux and macOS for now/,
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(existsSync(marker)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a host that is neither ORCA's own machine nor an SSH host before running anything there", async () => {
    const { open, factory } = factoryWithSpy();
    const agent = AgentSpecSchema.parse({ id: "claude", driver: "claude-agent-sdk", hostId: "box" });
    const host = { id: "box", spec: { id: "box", type: "other" } } as unknown as AgentHost;
    await expect(factory({ host, agent, cwd: dir })).rejects.toThrow(/runs on ORCA's own machine or an SSH host/);
    expect(open).not.toHaveBeenCalled();
  });

  describe("on an SSH host (#1130)", () => {
    /** An `ssh` that logs its arguments and runs the remote command line with the local shell. */
    async function sshHost(): Promise<{ host: SshHost; log: string; remoteClaude: string }> {
      const log = join(dir, "ssh.log");
      const ssh = join(dir, "ssh");
      await writeFile(
        ssh,
        `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "${log}"; echo >> "${log}"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec env -i PATH="/usr/bin:/bin" HOME="${dir}" bash -c "$*"
`,
      );
      await chmod(ssh, 0o755);
      const remoteClaude = join(dir, "remote-claude");
      await writeFile(
        remoteClaude,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}'; exit 0; fi
exec "${process.execPath}" "${STAND_IN}" "$@"
`,
      );
      await chmod(remoteClaude, 0o755);
      const host = new SshHost(
        HostSpecSchema.parse({
          id: "box",
          type: "ssh",
          host: "box.invalid",
          sshBinary: ssh,
          remoteShell: "bash -c",
        }) as never,
      );
      return { host, log, remoteClaude };
    }

    it("checks claude there and runs the session's claude there, without opening ACP", async () => {
      const { host, log, remoteClaude } = await sshHost();
      const { open, factory } = factoryWithSpy();
      const agent = AgentSpecSchema.parse({
        id: "claude",
        driver: "claude-agent-sdk",
        hostId: "box",
        command: remoteClaude,
      });
      const session = await factory({ host, agent, cwd: dir });
      try {
        expect((await session.prompt("hello")).stopReason).toBe("end_turn");
      } finally {
        await session.close();
      }
      // `--version`, `auth status`, the session's own claude, then its stop there: each over ssh.
      const lines = (await readFile(log, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(4);
      expect(lines[2]).toContain("--permission-mode=default");
      expect(lines[3]).toMatch(/orca_set stopped/);
      expect(open).not.toHaveBeenCalled();
    });

    it("refuses nativeToolHook: experimental there before running anything", async () => {
      const { host, log, remoteClaude } = await sshHost();
      const { open, factory } = factoryWithSpy();
      const agent = AgentSpecSchema.parse({
        id: "claude",
        driver: "claude-agent-sdk",
        hostId: "box",
        command: remoteClaude,
        nativeToolHook: "experimental",
      });
      await expect(factory({ host, agent, cwd: dir })).rejects.toThrow(
        /nativeToolHook: experimental, which ORCA applies only to agents on its own machine; it runs on ssh host box/,
      );
      expect(existsSync(log)).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });
  });

  it("opens an agent without the driver exactly as before", async () => {
    const { open, factory } = factoryWithSpy();
    const agent = AgentSpecSchema.parse({ id: "claude", command: "claude-agent-acp" });
    await expect(factory({ host: new LocalHost({ id: "local", type: "local" }), agent, cwd: dir })).rejects.toThrow(
      "ACP opened",
    );
    expect(open).toHaveBeenCalledTimes(1);
  });
});
