/**
 * `orca remote add <machine> --tailnet` (#1225): the machine comes from this computer's own
 * tailnet, ssh is checked against the host keys the tailnet advertises (#1227), and the profile
 * is bound to the node. The transport is a fake that behaves like the real one about pins.
 */
import { generateKeyPairSync } from "node:crypto";
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
import type { ReadTailnetOptions } from "@orca/protocol/tailnet";
import { remoteCommand } from "../src/commands/remote.js";
import type { CommandContext } from "../src/commands/index.js";

function ed25519Key(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const field = (bytes: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]).toString("base64")}`;
}
const KEY = ed25519Key();
const OTHER = ed25519Key();

const dirs: string[] = [];
let config: string;
const saved = process.env.XDG_CONFIG_HOME;
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-remote-tailnet-"));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  config = temp();
  process.env.XDG_CONFIG_HOME = config;
});
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
const INSPECTED: RemoteResult = {
  code: 0,
  serverLines: [],
  stdout: line({ inspected: true, account: "dev", root: "/home/dev/.local/share/orca-server", current: null }),
};

function tailnet(peer: Record<string, unknown>, env: Record<string, string> = { ORCA_INCUBATING: "tailnet-hosts" }) {
  const options: ReadTailnetOptions = {
    features: { env },
    cliPath: "/fake/tailscale",
    exists: () => true,
    run: () =>
      Promise.resolve({
        kind: "exited" as const,
        code: 0,
        stdout: JSON.stringify({
          BackendState: "Running",
          Peer: {
            "nodekey:1": {
              ID: "nBuild1",
              DNSName: "build-1.example-tailnet.ts.net.",
              OS: "linux",
              Online: true,
              TailscaleIPs: ["100.101.102.103"],
              sshHostKeys: [KEY],
              ...peer,
            },
          },
        }),
      }),
  };
  return options;
}

/** A server presenting `key`: it checks a seeded pin strictly, and learns one only when none is there. */
function fakeServer(key = KEY) {
  const opened: SshTunnelOptions[] = [];
  const make = (options: SshTunnelOptions) => {
    let sealed: string | undefined;
    return {
      get pinnedKeys() {
        return sealed;
      },
      open: async () => {
        opened.push(options);
        const pins = options.knownHostsFile;
        if (pinState(pins) === "none") {
          if (options.pinnedOnly) throw new TunnelRefusal("host-key-missing");
          mkdirSync(dirname(pins), { recursive: true });
          writeFileSync(pins, `orca-build-1 ${key}\n`);
        }
        if (!readFileSync(pins, "utf8").includes(key)) throw new TunnelRefusal("host-key-changed");
        sealed = tunnelKeyIdentity(pins, false);
        return "http://127.0.0.1:1";
      },
      exec: async () => INSPECTED,
      close: async () => {},
    };
  };
  return { make, opened };
}

describe("orca remote add --tailnet", () => {
  it("is refused while the tailnet-hosts flag is off", async () => {
    const { make } = fakeServer();
    const { context } = ctx(["add", "build-1"], { tailnet: true });
    await expect(
      remoteCommand(context, { tunnel: make, scripts: scripts(), version: "0.9.0", tailnet: tailnet({}, {}) }),
    ).rejects.toThrow(/not available in this build/);
  });

  it("binds the profile to the node and checks the server against the advertised keys", async () => {
    const { make, opened } = fakeServer();
    const { context, lines, errs } = ctx(["add", "dev@build-1"], { tailnet: true });
    const code = await remoteCommand(context, {
      tunnel: make,
      scripts: scripts(),
      version: "0.9.0",
      tailnet: tailnet({}),
    });
    expect(code).toBe(3);
    expect(opened[0]!.profile).toMatchObject({
      id: "build-1",
      destination: "dev@build-1.example-tailnet.ts.net",
      tailnet: { node: "nBuild1", name: "build-1.example-tailnet.ts.net" },
    });
    await expect(opened[0]!.resolveHost!()).resolves.toBe("100.101.102.103");
    expect(opened[0]!.approvalOrigins).toEqual(["https://login.tailscale.com"]);
    // The scratch pin held the advertised key before ssh connected.
    expect(lines.join("\n")).toMatch(
      /Host key: ssh-ed25519 SHA256:\S+ \(advertised by your tailnet's coordination server\)/,
    );
    expect(errs.at(-1)).not.toContain("ssh-keygen");
    expect(existsSync(join(config, "orca", "known_hosts", "build-1"))).toBe(false);
  });

  it("refuses a server that presents a key its tailnet does not advertise", async () => {
    const { make } = fakeServer(OTHER);
    const { context } = ctx(["add", "build-1"], { tailnet: true });
    await expect(
      remoteCommand(context, { tunnel: make, scripts: scripts(), version: "0.9.0", tailnet: tailnet({}) }),
    ).rejects.toMatchObject({ code: "host-key-changed" });
  });

  it("falls back to the ordinary first-seen key, with the command to enable Tailscale SSH", async () => {
    const { make } = fakeServer();
    const { context, lines, errs } = ctx(["add", "build-1"], { tailnet: true });
    await remoteCommand(context, {
      tunnel: make,
      scripts: scripts(),
      version: "0.9.0",
      tailnet: tailnet({ sshHostKeys: undefined }),
    });
    expect(errs.join("\n")).toContain("sudo tailscale set --ssh");
    expect(lines.join("\n")).toMatch(/\(not pinned yet\)/);
  });

  it("never takes another tailnet's word for a shared-in machine's key", async () => {
    const { make } = fakeServer();
    const { context, lines, errs } = ctx(["add", "build-1"], { tailnet: true });
    await remoteCommand(context, {
      tunnel: make,
      scripts: scripts(),
      version: "0.9.0",
      tailnet: tailnet({ AltSharerUserID: 9 }),
    });
    expect(errs.join("\n")).toContain("shared from another tailnet");
    expect(lines.join("\n")).toMatch(/\(not pinned yet\)/);
    expect(lines.join("\n")).not.toContain("advertised");
  });

  it("offers no approval page for an ordinary SSH host", async () => {
    const { make, opened } = fakeServer();
    const { context } = ctx(["add", "dev@lab"], {});
    await remoteCommand(context, { tunnel: make, scripts: scripts(), version: "0.9.0", tailnet: tailnet({}) });
    expect(opened[0]!.onLoginApproval).toBeUndefined();
  });

  it.each([
    ["an unknown machine", "nope", {}, /No single machine named nope/],
    ["a Windows machine", "build-1", { OS: "windows" }, /not a Linux machine/],
    ["an offline machine", "build-1", { Online: false }, /offline on your tailnet/],
  ])("refuses %s", async (_, name, peer, message) => {
    const { make } = fakeServer();
    const { context } = ctx(["add", name], { tailnet: true });
    await expect(
      remoteCommand(context, { tunnel: make, scripts: scripts(), version: "0.9.0", tailnet: tailnet(peer) }),
    ).rejects.toThrow(message);
  });
});
