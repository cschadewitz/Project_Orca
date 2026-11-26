/**
 * Agents on a profile's managed server from the app (#1236). The tunnel is a seam whose "server"
 * is a temporary home on this machine, where each command runs as its words, so the shipped
 * `orca-host-agents.py` really reports there. Installing real agents is covered in
 * `packages/protocol/test/server-agents.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretCipher, SshTunnel, SshTunnelOptions } from "@orca/protocol/remote-access";
import { RemoteProfiles } from "../src/main/remote-profiles.js";

const scripts = fileURLToPath(new URL("../../../tools/deploy/", import.meta.url));
const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};
const ON = { env: { ORCA_INCUBATING: "tailnet-hosts" } };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-app-host-agents-"));
  dirs.push(dir);
  return dir;
};

function store(features: { env: Record<string, string> } = ON) {
  const dir = temp();
  const home = temp();
  mkdirSync(join(home, ".local/share/orca-server"), { recursive: true });
  const opened: SshTunnelOptions[] = [];
  const profiles = new RemoteProfiles({
    dir,
    cipher,
    hostname: "test",
    tailnet: { features },
    tunnel: (options) => {
      opened.push(options);
      return {
        open: async () => "http://127.0.0.1:1",
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
      } as unknown as SshTunnel;
    },
  });
  profiles.save({ name: "Lab", destination: "casey@lab" });
  const pin = () => {
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "lab ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAA\n");
  };
  return { profiles, opened, pin };
}

describe("agents on a profile's server", () => {
  it("lists each pinned agent's state there over a pinned-only connection", async () => {
    const { profiles, opened, pin } = store();
    pin();
    await expect(profiles.hostAgents("lab", scripts)).resolves.toEqual([
      { agent: "codex", name: "Codex", version: "0.171.0", installed: false, signedIn: "no" },
      { agent: "copilot", name: "GitHub Copilot CLI", version: "1.0.114", installed: false, signedIn: "no" },
    ]);
    expect(opened[0]).toMatchObject({ pinnedOnly: true });
  });

  it("is refused with the flag off, before the server is set up, and for an unknown agent", async () => {
    const off = store({ env: {} });
    off.pin();
    await expect(off.profiles.hostAgents("lab", scripts)).rejects.toThrow(/not available in this build/);
    const unpinned = store();
    await expect(unpinned.profiles.hostAgents("lab", scripts)).rejects.toThrow(/Set up the ORCA server/);
    await expect(unpinned.profiles.installHostAgent("lab", "claude", scripts)).rejects.toThrow(
      /No agent called claude/,
    );
    expect([...off.opened, ...unpinned.opened]).toEqual([]);
  });
});
