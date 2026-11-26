/**
 * Agents on a profile's managed server from the app (#1236). The tunnel is a seam whose "server"
 * is a temporary home on this machine, where each command runs as its words, so the shipped
 * `orca-host-agents.py` really reports there. Installing real agents is covered in
 * `packages/protocol/test/server-agents.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

interface Rig {
  features?: { env: Record<string, string> };
  fetch?: (url: string) => Promise<Buffer>;
  exec?: (command: readonly string[]) => Promise<{ code: number; stdout: string; serverLines: string[] }>;
  closed?: () => void;
}

const BYTES = Buffer.from("not really a tarball");
const PACKAGES = {
  codex: [
    {
      path: "node_modules/@openai/codex",
      version: "0.171.0",
      tarball: "https://registry.example/codex.tgz",
      integrity: `sha512-${createHash("sha512").update(BYTES).digest("base64")}`,
    },
  ],
};

function store(features: { env: Record<string, string> } = ON, rig: Rig = {}) {
  const dir = temp();
  const home = temp();
  mkdirSync(join(home, ".local/share/orca-server"), { recursive: true });
  const opened: SshTunnelOptions[] = [];
  const profiles = new RemoteProfiles({
    dir,
    cipher,
    hostname: "test",
    tailnet: { features },
    hostAgentPackages: PACKAGES,
    ...(rig.fetch ? { courierFetch: rig.fetch } : {}),
    tunnel: (options) => {
      opened.push(options);
      return {
        open: async () => "http://127.0.0.1:1",
        exec: async (command: readonly string[], _timeout?: number, input?: string) => {
          if (rig.exec) return rig.exec(command);
          const result = spawnSync(command[0]!, command.slice(1), {
            cwd: home,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
            encoding: "utf8",
            input,
          });
          return { code: result.status ?? 255, stdout: result.stdout ?? "", serverLines: [] };
        },
        close: async () => rig.closed?.(),
      } as unknown as SshTunnel;
    },
  });
  profiles.save({ name: "Lab", destination: "casey@lab" });
  const pin = () => {
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "lab ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAA\n");
  };
  return { profiles, opened, pin, dir };
}

describe("agents on a profile's server", () => {
  // The agents' program runs on a Linux server (the bundle is linux-x64 only): a Windows runner
  // has no POSIX home to stand in for one.
  it.skipIf(process.platform === "win32")(
    "lists each pinned agent's state there over a pinned-only connection",
    async () => {
      const { profiles, opened, pin } = store();
      pin();
      await expect(profiles.hostAgents("lab", scripts)).resolves.toEqual([
        { agent: "codex", name: "Codex", version: "0.171.0", installed: false, signedIn: "no" },
        { agent: "copilot", name: "GitHub Copilot CLI", version: "1.0.114", installed: false, signedIn: "no" },
      ]);
      expect(opened[0]).toMatchObject({ pinnedOnly: true });
    },
  );

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

describe("agent work on a profile", () => {
  /** A fetch that waits until the test lets it go. */
  function heldFetch() {
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => {};
    const begun = new Promise<void>((resolve) => (started = resolve));
    const fetch = async (url: string) => {
      calls.push(url);
      started();
      await gate;
      return BYTES;
    };
    return { calls, fetch, release, begun };
  }

  it("fetches and caches nothing for an install that is refused", async () => {
    const held = heldFetch();
    const off = store({ env: {} }, { fetch: held.fetch });
    off.pin();
    await expect(off.profiles.installHostAgent("lab", "codex", scripts)).rejects.toThrow(/not available/);
    const unpinned = store(ON, { fetch: held.fetch });
    await expect(unpinned.profiles.installHostAgent("lab", "codex", scripts)).rejects.toThrow(/Set up the ORCA server/);
    await expect(unpinned.profiles.installHostAgent("gone", "codex", scripts)).rejects.toThrow(/no longer exists/);
    expect(held.calls).toEqual([]);
    for (const { dir } of [off, unpinned]) expect(existsSync(join(dir, "courier"))).toBe(false);
    expect([...off.opened, ...unpinned.opened]).toEqual([]);
  });

  it("holds the profile while it works, and installs nothing once its host keys changed", async () => {
    const held = heldFetch();
    const rig = store(ON, { fetch: held.fetch });
    rig.pin();
    const install = rig.profiles.installHostAgent("lab", "codex", scripts);
    await held.begun;
    // While the agent is prepared, nothing else may act on the profile.
    await expect(rig.profiles.hostAgents("lab", scripts)).rejects.toThrow(/Another agent action/);
    expect(() => rig.profiles.save({ id: "lab", name: "Lab", destination: "casey@other" })).toThrow(
      /agent action is running/,
    );
    expect(() => rig.profiles.forgetHostKey("lab")).toThrow(/agent action is running/);
    await expect(rig.profiles.remove("lab")).rejects.toThrow(/agent action is running/);
    // The pins file changed on disk underneath it: another server now.
    writeFileSync(join(rig.dir, "known_hosts", "lab"), "lab ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBB\n");
    held.release();
    await expect(install).rejects.toThrow(/profile changed while the agent was being prepared/);
    expect(rig.opened).toEqual([]);
    // The lease is gone with the work.
    expect(() => rig.profiles.forgetHostKey("lab")).not.toThrow();
  });

  it("closes an agent's connection when the app closes", async () => {
    let closes = 0;
    let started: () => void = () => {};
    const begun = new Promise<void>((resolve) => (started = resolve));
    const rig = store(ON, {
      exec: () => {
        started();
        return new Promise(() => {});
      },
      closed: () => {
        closes += 1;
      },
    });
    rig.pin();
    void rig.profiles.hostAgents("lab", scripts).catch(() => undefined);
    await begun;
    await rig.profiles.close();
    expect(closes).toBe(1);
  });
});
