/**
 * App-managed SSH tunnels and per-profile credential slots (#874). The unit half drives a
 * fake ssh; the live half runs against a real sshd when `ORCA_SSH_TUNNEL_TEST` names one
 * (`{"destination":"user@127.0.0.1","sshPort":2222,"identity":"/path/key"}`), which the
 * ssh-tunnel workflow sets up on Linux and Windows runners.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifySshFailure,
  ConnectionProfileSchema,
  CredentialSlots,
  CredentialStorageUnavailable,
  ephemeralLoopbackPort,
  profileIdFor,
  sshArgsProblem,
  sshOptionPath,
  SshTunnel,
  TunnelRefusal,
  tunnelArgs,
  type SecretCipher,
  type TunnelState,
} from "@orca/protocol/remote-access";

const dir = () => mkdtempSync(join(tmpdir(), "orca-remote-"));
const profile = (extra: Record<string, unknown> = {}) =>
  ConnectionProfileSchema.parse({ id: "lab", name: "Lab", destination: "casey@lab.example", ...extra });

describe("connection profiles", () => {
  it("accepts user@host and defaults the daemon port", () => {
    expect(profile()).toMatchObject({ destination: "casey@lab.example", remotePort: 6722 });
    expect(profile({ destination: "[::1]", sshPort: 2222, proxyJump: "jump@bastion:22,edge" })).toBeTruthy();
  });
  it.each(["-oProxyCommand=x", "a b", "host;rm", "user@-host", "", "a@b@c"])(
    "refuses destination %j",
    (destination) => {
      expect(ConnectionProfileSchema.safeParse({ id: "x", name: "X", destination }).success).toBe(false);
    },
  );
  it("refuses unknown fields and secrets in preferences", () => {
    expect(ConnectionProfileSchema.safeParse({ id: "x", name: "X", destination: "h", token: "secret" }).success).toBe(
      false,
    );
  });
  it("allows ordinary ssh options and refuses ones the tunnel's safety depends on", () => {
    expect(sshArgsProblem(["-o", "IdentitiesOnly=yes", "-i", "/k", "-4", "-oCompression=yes"])).toBeUndefined();
    for (const args of [
      ["-o", "StrictHostKeyChecking=no"],
      ["-oUserKnownHostsFile=/dev/null"],
      ["-o", "localcommand=x"],
      ["-L", "1:2:3"],
      ["-R", "1"],
      ["-o"],
      ["-o", "NoEquals"],
      ["host"],
    ])
      expect(sshArgsProblem(args), args.join(" ")).toBeTruthy();
  });
  it("derives unique file-safe ids", () => {
    expect(profileIdFor("Build Box #2", new Set())).toBe("build-box-2");
    expect(profileIdFor("Lab", new Set(["lab"]))).toBe("lab-2");
    expect(profileIdFor("***", new Set())).toBe("daemon");
  });
});

describe("tunnel arguments", () => {
  it("puts ORCA's options before the profile's and pins accept-new until a key is known", () => {
    const pins = join(dir(), "lab.known_hosts");
    const args = tunnelArgs(profile({ sshArgs: ["-o", "IdentitiesOnly=yes"], sshPort: 2200 }), 41000, pins);
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args).toContain("-L");
    expect(args[args.indexOf("-L") + 1]).toBe("127.0.0.1:41000:127.0.0.1:6722");
    expect(args.indexOf("BatchMode=yes")).toBeLessThan(args.indexOf("IdentitiesOnly=yes"));
    expect(args.slice(-2)).toEqual(["--", "casey@lab.example"]);
    writeFileSync(pins, "[lab.example]:2200 ssh-ed25519 AAAA\n");
    expect(tunnelArgs(profile(), 41000, pins)).toContain("StrictHostKeyChecking=yes");
  });
  it("quotes option paths for Windows and ssh tokens", () => {
    expect(sshOptionPath("C:\\Users\\A B\\100%\\k")).toBe('"C:/Users/A B/100%%/k"');
    expect(() => sshOptionPath('a"b')).toThrow();
  });
});

describe("ssh failure classification", () => {
  it.each([
    ["@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.", "host-key-changed"],
    ["Host key verification failed.", "host-key-changed"],
    ["casey@lab: Permission denied (publickey).", "auth-failed"],
    ["ssh: Could not resolve hostname nope: Name or service not known", "unreachable"],
    ["ssh: connect to host 10.0.0.1 port 22: Connection refused", "unreachable"],
    [
      "bind [127.0.0.1]:41000: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 41000\nCould not request local forwarding.",
      "forward-failed",
    ],
    ["something else", "ssh-failed"],
    // Debug and dropped-channel lines never decide the class.
    [
      "debug1: Connection refused\ndebug1: Permission denied\nchannel 2: open failed: connect failed: Connection refused",
      "ssh-failed",
    ],
  ])("%j -> %s", (stderr, code) => expect(classifySshFailure(stderr)).toBe(code));
});

class FakeSsh extends EventEmitter {
  stderr = new PassThrough();
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.exit(null, "SIGTERM");
    return true;
  }
  say(text: string): void {
    this.stderr.write(`${text}\n`);
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    setImmediate(() => this.emit("exit", code, signal));
  }
}

function fakeTunnel(script: (ssh: FakeSsh, n: number, args: readonly string[]) => void, extra = {}) {
  const spawned: FakeSsh[] = [];
  const states: TunnelState[] = [];
  const tunnel = new SshTunnel({
    profile: profile(),
    knownHostsFile: join(dir(), "lab.known_hosts"),
    pickPort: () => Promise.resolve(41234),
    backoff: { initialMs: 5, maxMs: 20 },
    readyTimeoutMs: 1_000,
    onState: (state) => states.push(state),
    spawn: (_command, args) => {
      const ssh = new FakeSsh();
      spawned.push(ssh);
      setImmediate(() => script(ssh, spawned.length, args));
      return ssh as unknown as ChildProcess;
    },
    ...extra,
  });
  return { tunnel, spawned, states };
}

const listening = "debug1: Local forwarding listening on 127.0.0.1 port 41234.\ndebug1: Entering interactive session.";
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("SshTunnel with a fake ssh", () => {
  it("opens when the forward listens and records the presented host key", async () => {
    const { tunnel } = fakeTunnel((ssh) => {
      ssh.say("debug1: Server host key: ssh-ed25519 SHA256:abcDEF123+/=");
      ssh.say(listening);
    });
    await expect(tunnel.open()).resolves.toBe("http://127.0.0.1:41234");
    expect(tunnel.hostKeyFingerprint).toBe("SHA256:abcDEF123+/=");
    expect(tunnel.state).toEqual({ phase: "open", localPort: 41234 });
    await tunnel.close();
    expect(tunnel.state.phase).toBe("closed");
  });

  it.each([
    ["Host key verification failed.", "host-key-changed"],
    ["root@h: Permission denied (publickey).", "auth-failed"],
    ["Could not request local forwarding.", "forward-failed"],
  ])("refuses %j as %s without retrying", async (line, code) => {
    const { tunnel, spawned } = fakeTunnel((ssh) => {
      ssh.say(line);
      ssh.exit(255);
    });
    await expect(tunnel.open()).rejects.toMatchObject({ code });
    expect(spawned).toHaveLength(1);
  });

  it("reports a missing ssh binary", async () => {
    const { tunnel } = fakeTunnel((ssh) =>
      ssh.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })),
    );
    await expect(tunnel.open()).rejects.toMatchObject({ code: "ssh-missing" });
  });

  it("times out an ssh that never binds", async () => {
    const { tunnel, spawned } = fakeTunnel(() => undefined, { readyTimeoutMs: 20 });
    await expect(tunnel.open()).rejects.toMatchObject({ code: "timeout" });
    expect(spawned[0]!.killed).toBe(true);
  });

  it("restarts on the same port after a drop, with backoff, until closed", async () => {
    const { tunnel, spawned, states } = fakeTunnel((ssh, n) => {
      if (n === 2) {
        ssh.say("ssh: connect to host lab port 22: Connection refused");
        ssh.exit(255);
      } else ssh.say(listening);
    });
    await tunnel.open();
    spawned[0]!.say("Connection reset by peer");
    spawned[0]!.exit(255);
    await until(() => spawned.length === 3 && tunnel.state.phase === "open");
    expect(states.map((s) => s.phase)).toEqual(["starting", "open", "reconnecting", "reconnecting", "open"]);
    expect(tunnel.url).toBe("http://127.0.0.1:41234");
    await tunnel.close();
    expect(spawned[2]!.killed).toBe(true);
  });

  it("stops restarting when the host key changes mid-session", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh, n) => {
      if (n === 1) ssh.say(listening);
      else {
        ssh.say("Host key verification failed.");
        ssh.exit(255);
      }
    });
    await tunnel.open();
    spawned[0]!.exit(255);
    await until(() => tunnel.state.phase === "failed");
    expect(tunnel.state).toEqual({ phase: "failed", refusal: "host-key-changed" });
    await new Promise((r) => setTimeout(r, 50));
    expect(spawned).toHaveLength(2);
  });

  it("notices a forward the remote refused", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh) => ssh.say(listening));
    await tunnel.open();
    expect(tunnel.remoteRefused()).toBe(false);
    spawned[0]!.say("channel 3: open failed: connect failed: Connection refused");
    await until(() => tunnel.remoteRefused());
    await tunnel.close();
  });

  it("is single-use once closed", async () => {
    const { tunnel } = fakeTunnel((ssh) => ssh.say(listening));
    await tunnel.close();
    await expect(tunnel.open()).rejects.toBeInstanceOf(TunnelRefusal);
  });
});

const cipher = (over: Partial<SecretCipher> = {}): SecretCipher => ({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
  decryptString: (value) => Buffer.from(value.toString().replace(/^sealed:/, ""), "base64").toString(),
  ...over,
});

describe("CredentialSlots", () => {
  const token = "orca_abcdefghijklmnop.0123456789";
  it("stores sealed, owner-only, and removes", () => {
    const d = dir();
    const slots = new CredentialSlots(d, cipher());
    expect(slots.has("lab")).toBe(false);
    expect(slots.read("lab")).toBeUndefined();
    slots.write("lab", `${token}\n`);
    expect(slots.has("lab")).toBe(true);
    expect(slots.read("lab")).toBe(token);
    expect(readFileSync(join(d, "lab.credential"), "utf8")).not.toContain(token);
    if (process.platform !== "win32") expect(statSync(join(d, "lab.credential")).mode & 0o077).toBe(0);
    slots.remove("lab");
    expect(existsSync(join(d, "lab.credential"))).toBe(false);
  });
  it("refuses without a real keychain and never writes plaintext", () => {
    const d = dir();
    for (const c of [
      cipher({ isEncryptionAvailable: () => false }),
      cipher({ getSelectedStorageBackend: () => "basic_text" }),
    ]) {
      expect(() => new CredentialSlots(d, c).write("lab", token)).toThrow(CredentialStorageUnavailable);
      expect(existsSync(join(d, "lab.credential"))).toBe(false);
    }
  });
  it("refuses malformed tokens and ids", () => {
    const slots = new CredentialSlots(dir(), cipher());
    expect(() => slots.write("lab", "short")).toThrow();
    expect(() => slots.write("lab", "has space in it 0123456789")).toThrow();
    expect(() => slots.write("../x", token)).toThrow();
  });
});

const live = process.env.ORCA_SSH_TUNNEL_TEST
  ? (JSON.parse(process.env.ORCA_SSH_TUNNEL_TEST) as { destination: string; sshPort?: number; identity: string })
  : undefined;

describe.skipIf(!live)("SshTunnel against a real sshd", () => {
  const servers: Server[] = [];
  const tunnels: SshTunnel[] = [];
  const sockets: Socket[] = [];
  afterEach(async () => {
    await Promise.all(tunnels.splice(0).map((t) => t.close()));
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  /** A stand-in daemon on the remote loopback (same machine as the test sshd). */
  async function daemon(): Promise<number> {
    const port = await ephemeralLoopbackPort();
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\norca");
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    servers.push(server);
    return port;
  }
  function open(remotePort: number, pins: string, extra: Record<string, unknown> = {}, sshBinary?: string) {
    const tunnel = new SshTunnel({
      profile: ConnectionProfileSchema.parse({
        id: "live",
        name: "Live",
        destination: live!.destination,
        ...(live!.sshPort ? { sshPort: live!.sshPort } : {}),
        sshArgs: ["-i", live!.identity, "-o", "IdentitiesOnly=yes"],
        remotePort,
        ...extra,
      }),
      knownHostsFile: pins,
      backoff: { initialMs: 100, maxMs: 500 },
      ...(sshBinary ? { sshBinary } : {}),
    });
    tunnels.push(tunnel);
    return tunnel;
  }

  it("pins on first connect, forwards, restarts on the same port, and refuses a changed key", async () => {
    const remote = await daemon();
    const pins = join(dir(), "live.known_hosts");
    const first = open(remote, pins);
    const url = await first.open();
    expect(await (await fetch(url)).text()).toBe("orca");
    expect(first.hostKeyFingerprint).toMatch(/^SHA256:/);
    expect(statSync(pins).size).toBeGreaterThan(0);

    // A dropped ssh comes back on the same local port.
    const port = first.localPort;
    const states: string[] = [];
    (first as unknown as { options: { onState?: (s: TunnelState) => void } }).options.onState = (s) =>
      states.push(s.phase);
    (first as unknown as { child: ChildProcess }).child.kill();
    await until(() => states.includes("open"));
    expect(first.localPort).toBe(port);
    expect(await (await fetch(url)).text()).toBe("orca");
    await first.close();

    // The pinned key is now enforced: swap in a different key for the same host entry.
    const pinned = readFileSync(pins, "utf8").trim().split(/\s+/);
    writeFileSync(
      pins,
      `${pinned[0]} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n`,
    );
    await expect(open(remote, pins).open()).rejects.toMatchObject({ code: "host-key-changed" });
  }, 60_000);

  it("refuses failed auth, a missing ssh, and a forward that cannot bind", async () => {
    const remote = await daemon();
    const pins = join(dir(), "live.known_hosts");
    const wrongKey = join(dir(), "none");
    await expect(
      open(remote, pins, { sshArgs: ["-i", wrongKey, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none"] }).open(),
    ).rejects.toMatchObject({ code: "auth-failed" });
    await expect(open(remote, pins, {}, join(dir(), "no-ssh-here")).open()).rejects.toMatchObject({
      code: "ssh-missing",
    });
    const busy = await ephemeralLoopbackPort();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(busy, "127.0.0.1", r));
    servers.push(blocker);
    const tunnel = new SshTunnel({
      profile: ConnectionProfileSchema.parse({
        id: "live",
        name: "Live",
        destination: live!.destination,
        ...(live!.sshPort ? { sshPort: live!.sshPort } : {}),
        sshArgs: ["-i", live!.identity, "-o", "IdentitiesOnly=yes"],
        remotePort: remote,
      }),
      knownHostsFile: pins,
      pickPort: () => Promise.resolve(busy),
    });
    tunnels.push(tunnel);
    await expect(tunnel.open()).rejects.toMatchObject({ code: "forward-failed" });
  }, 60_000);

  it("tells a missing remote daemon apart from a broken tunnel", async () => {
    const nothing = await ephemeralLoopbackPort();
    const tunnel = open(nothing, join(dir(), "live.known_hosts"));
    const url = await tunnel.open();
    await expect(fetch(url)).rejects.toThrow();
    await until(() => tunnel.remoteRefused());
  }, 60_000);
});
