/**
 * App-managed SSH tunnels and per-profile credential slots (#874). The unit half drives a
 * fake ssh; the live half runs against a real sshd when `ORCA_SSH_TUNNEL_TEST` names one
 * (`{"destination":"user@127.0.0.1","sshPort":2222,"identity":"/path/key"}`), which the
 * ssh-tunnel workflow sets up on Linux and Windows runners.
 */
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifySshFailure,
  ConnectionProfileSchema,
  CredentialSlots,
  CredentialStorageUnavailable,
  ephemeralLoopbackPort,
  forgetPin,
  markPinEnrolled,
  pinState,
  pinnedKeyIdentity,
  profileIdFor,
  sshOptionPath,
  SshTunnel,
  TunnelRefusal,
  loginApprovalUrl,
  tunnelHops,
  tunnelKeyIdentity,
  hopArgs,
  commandArgs,
  RemoteCommandRefused,
  runRemote,
  type RemoteCommandExit,
  type SecretCipher,
  type TunnelState,
} from "@orca/protocol/remote-access";

const dir = () => mkdtempSync(join(tmpdir(), "orca-remote-"));
const profile = (extra: Record<string, unknown> = {}) =>
  ConnectionProfileSchema.parse({ id: "lab", name: "Lab", destination: "casey@lab.example", ...extra });

describe("connection profiles", () => {
  it("accepts user@host and defaults the daemon port", () => {
    expect(profile()).toMatchObject({ destination: "casey@lab.example", remotePort: 6722 });
    expect(
      profile({
        destination: "[::1]",
        sshPort: 2222,
        identityFile: "C:\\Users\\casey\\.ssh\\id_ed25519",
        jump: { destination: "jump@bastion", sshPort: 22, identityFile: "/home/casey/.ssh/id" },
      }),
    ).toBeTruthy();
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
  it("has only typed fields: no free-form ssh options, config files or multi-hop strings", () => {
    for (const extra of [
      { sshArgs: ["-o", "StrictHostKeyChecking=no"] },
      { options: { ProxyCommand: "x" } },
      { configFile: "/tmp/x" },
      { proxyJump: "a,b" },
      { identityFile: "~/.ssh/id" },
      { identityFile: "relative/key" },
      { identityFile: '/a"b' },
      { jump: { destination: "j", proxyCommand: "x" } },
      { jump: { destination: "-oProxyCommand=x" } },
    ])
      expect(
        ConnectionProfileSchema.safeParse({ id: "x", name: "X", destination: "h", ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
  });
  it("derives unique file-safe ids", () => {
    expect(profileIdFor("Build Box #2", new Set())).toBe("build-box-2");
    expect(profileIdFor("Lab", new Set(["lab"]))).toBe("lab-2");
    expect(profileIdFor("***", new Set())).toBe("daemon");
  });
});

describe("tunnel arguments", () => {
  const options = (args: string[]) => args.flatMap((arg, i) => (args[i - 1] === "-o" ? [arg] : []));
  it("reads no ssh config, makes the pin the only trust source, and pins accept-new until a key is known", () => {
    const pins = join(dir(), "lab.known_hosts");
    const hops = tunnelHops(profile({ sshPort: 2200, identityFile: "/k/100%" }), pins);
    expect(hops.jump).toBeUndefined();
    const args = hopArgs(hops.daemon);
    expect(args.slice(0, 2)).toEqual(["-F", "none"]);
    const quoted = `"${pins.replace(/\\/g, "/")}"`;
    expect(options(args)).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "ExitOnForwardFailure=yes",
        "StrictHostKeyChecking=accept-new",
        `UserKnownHostsFile=${quoted}`,
        `GlobalKnownHostsFile=${quoted}`,
        "HostKeyAlias=orca-lab",
        "CheckHostIP=no",
        "UpdateHostKeys=no",
        "ProxyCommand=none",
        "ProxyJump=none",
        "ControlPath=none",
        "ForwardAgent=no",
        "PermitLocalCommand=no",
        "IdentitiesOnly=yes",
      ]),
    );
    // One connection per process over stdio: no local port forward, no -N.
    expect(args).not.toContain("-L");
    expect(args).not.toContain("-N");
    expect(args.filter((arg) => arg === "-W")).toHaveLength(1);
    expect(args[args.indexOf("-W") + 1]).toBe("127.0.0.1:6722");
    expect(args[args.indexOf("-i") + 1]).toBe("/k/100%%");
    expect(args.slice(-2)).toEqual(["--", "casey@lab.example"]);
    writeFileSync(pins, "orca-lab ssh-ed25519 AAAA\n");
    expect(options(hopArgs(tunnelHops(profile(), pins).daemon))).toContain("StrictHostKeyChecking=yes");
  });
  it("chains a jump host as its own pinned ssh, then reaches the server through a private port", () => {
    const pins = join(dir(), "lab.known_hosts");
    const hops = tunnelHops(profile({ sshPort: 2200, jump: { destination: "j@bastion", sshPort: 2022 } }), pins, 41999);
    expect(hops).toEqual({
      jump: expect.objectContaining({
        target: "j@bastion",
        port: 2022,
        knownHostsFile: `${pins}.jump`,
        hostKeyAlias: "orca-lab-jump",
        forward: "127.0.0.1:41999:lab.example:2200",
      }),
      daemon: expect.objectContaining({
        target: "casey@127.0.0.1",
        port: 41999,
        knownHostsFile: pins,
        hostKeyAlias: "orca-lab",
        stdio: "127.0.0.1:6722",
      }),
    });
    expect(hopArgs(hops.jump!)).toEqual(expect.arrayContaining(["-N", "-L", "127.0.0.1:41999:lab.example:2200"]));
    for (const hop of [hops.jump!, hops.daemon]) expect(hopArgs(hop).slice(0, 2)).toEqual(["-F", "none"]);
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
    // Windows reports a taken local port as a denied bind, which is not an auth failure.
    ["bind [127.0.0.1]:41000: Permission denied\r\nCould not request local forwarding.\r\n", "forward-failed"],
    ["something else", "ssh-failed"],
    // Debug and dropped-channel lines never decide the class.
    [
      "debug1: Connection refused\ndebug1: Permission denied\nchannel 2: open failed: connect failed: Connection refused",
      "ssh-failed",
    ],
  ])("%j -> %s", (stderr, code) => expect(classifySshFailure(stderr)).toBe(code));
});

class FakeSsh extends EventEmitter {
  stdin = new PassThrough();
  stderr = new PassThrough();
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  /** Every byte a client handed this ssh to carry. */
  received = "";
  /** Output that keeps flowing after exit: `close` never comes. */
  holdOutput = false;
  /** What the real spawn would have given ssh as its standard input. */
  stdinMode: "pipe" | "ignore" | undefined;
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => (this.received += chunk.toString()));
  }
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
    this.stdout.end();
    this.stdin.destroy();
    setImmediate(() => {
      this.emit("exit", code, signal);
      // Real children close once stdio has drained; `holdOutput` keeps it open.
      if (!this.holdOutput) setImmediate(() => this.emit("close", code, signal));
    });
  }
}

function fakeTunnel(script: (ssh: FakeSsh, n: number, args: readonly string[]) => void, extra = {}) {
  const spawned: FakeSsh[] = [];
  const states: TunnelState[] = [];
  const tunnel = new SshTunnel({
    profile: profile(),
    knownHostsFile: join(dir(), "lab.known_hosts"),
    backoff: { initialMs: 5, maxMs: 20 },
    readyTimeoutMs: 1_000,
    onState: (state) => states.push(state),
    spawn: (_command, args, stdin) => {
      const ssh = new FakeSsh();
      ssh.stdinMode = stdin;
      spawned.push(ssh);
      setImmediate(() => script(ssh, spawned.length, args));
      return ssh as unknown as ChildProcess;
    },
    ...extra,
  });
  return { tunnel, spawned, states };
}

/** What ssh prints once the server is authenticated against its pin. */
const authed = "debug1: Server host key: ssh-ed25519 SHA256:abcDEF123+/=\ndebug1: Entering interactive session.";
/** A jump host's ssh once its forward is bound. */
const listening = "debug1: Local forwarding listening on 127.0.0.1 port 41999.\ndebug1: Entering interactive session.";
const until = async (check: () => boolean, timeoutMs = 1_000) => {
  for (let i = 0; i < timeoutMs / 5 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};
const closed = (stream: NodeJS.EventEmitter & { destroyed: boolean }) =>
  stream.destroyed ? Promise.resolve() : new Promise<void>((resolve) => stream.once("close", () => resolve()));

describe("SshTunnel with a fake ssh", () => {
  it("opens once a probe stream authenticates, records the host key, and holds its address", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh) => ssh.say(authed));
    const url = await tunnel.open();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(tunnel.hostKeyFingerprint).toBe("SHA256:abcDEF123+/=");
    expect(tunnel.state).toEqual({ phase: "open", localPort: tunnel.localPort });
    // The probe carried nothing: its stdin was closed at once.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.received).toBe("");
    expect(spawned[0]!.stdin.writableEnded || spawned[0]!.stdin.destroyed).toBe(true);
    // The address is the tunnel's while it lives: nothing else can listen on it.
    const port = tunnel.localPort!;
    const squatter = createServer();
    await expect(
      new Promise((resolve, reject) => {
        squatter.once("error", reject);
        squatter.listen(port, "127.0.0.1", () => resolve(undefined));
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/EADDRINUSE|EACCES/) });
    await tunnel.close();
    expect(tunnel.state.phase).toBe("closed");
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", () => squatter.close(() => resolve())));
  });

  it.each([
    ["Host key verification failed.", "host-key-changed"],
    ["root@h: Permission denied (publickey).", "auth-failed"],
    ["ssh: connect to host lab port 22: Connection refused", "unreachable"],
  ])("refuses %j as %s without retrying", async (line, code) => {
    const { tunnel, spawned } = fakeTunnel((ssh) => {
      ssh.say(line);
      ssh.exit(255);
    });
    await expect(tunnel.open()).rejects.toMatchObject({ code });
    expect(spawned).toHaveLength(1);
    expect(tunnel.state).toEqual({ phase: "failed", refusal: code });
  });

  it("refuses an address it cannot hold, without starting ssh", async () => {
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const address = busy.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const { tunnel, spawned } = fakeTunnel((ssh) => ssh.say(authed), { pickPort: () => Promise.resolve(port) });
      await expect(tunnel.open()).rejects.toMatchObject({ code: "forward-failed" });
      expect(spawned).toHaveLength(0);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  it("reports a missing ssh binary", async () => {
    const { tunnel } = fakeTunnel((ssh) =>
      ssh.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })),
    );
    await expect(tunnel.open()).rejects.toMatchObject({ code: "ssh-missing" });
  });

  it("times out an ssh that never authenticates", async () => {
    const { tunnel, spawned } = fakeTunnel(() => undefined, { readyTimeoutMs: 20 });
    await expect(tunnel.open()).rejects.toMatchObject({ code: "timeout" });
    expect(spawned[0]!.killed).toBe(true);
  });

  it("binds each connection to its own authenticated ssh, and nothing else ever sees its bytes", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh, _n, args) => {
      expect(args).toContain("-W");
      ssh.say(authed);
    });
    await tunnel.open();
    const a = tunnel.connect();
    const b = tunnel.connect();
    expect(spawned).toHaveLength(3);
    a.write("Authorization: Bearer A\r\n");
    b.write("Authorization: Bearer B\r\n");
    await until(() => spawned[1]!.received !== "" && spawned[2]!.received !== "");
    expect(spawned.map((ssh) => ssh.received)).toEqual([
      "",
      "Authorization: Bearer A\r\n",
      "Authorization: Bearer B\r\n",
    ]);
    // What the daemon sends back over a stream comes out of that connection only.
    const read: string[] = [];
    a.on("data", (chunk: Buffer) => read.push(chunk.toString()));
    spawned[1]!.stdout.write("HTTP/1.1 200 OK\r\n");
    await until(() => read.length === 1);
    expect(read).toEqual(["HTTP/1.1 200 OK\r\n"]);
    a.destroy();
    await until(() => spawned[1]!.killed);
    expect(spawned[2]!.killed).toBe(false);
    await tunnel.close();
    expect(b.destroyed).toBe(true);
    expect(spawned[2]!.killed).toBe(true);
  });

  it("ends a connection with its ssh: later writes reach no process, and nothing is redialled", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh) => ssh.say(authed));
    await tunnel.open();
    const socket = tunnel.connect();
    socket.on("data", () => {});
    socket.write("first\n");
    await until(() => spawned[1]!.received === "first\n");
    spawned[1]!.exit(255);
    await closed(socket);
    socket.write("after loss\n", () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(spawned).toHaveLength(2);
    expect(spawned.map((ssh) => ssh.received).join("")).toBe("first\n");
    await tunnel.close();
  });

  it("refuses connections after close, and closing ends every open one", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh) => ssh.say(authed));
    await tunnel.open();
    const socket = tunnel.connect();
    await tunnel.close();
    expect(socket.destroyed).toBe(true);
    expect(spawned[1]!.killed).toBe(true);
    expect(() => tunnel.connect()).toThrow(TunnelRefusal);
    expect(spawned).toHaveLength(2);
    expect(tunnel.transportVerified()).toBe(false);
  });

  it("carries a connection to its held address over a fresh authenticated stream", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh) => ssh.say(authed));
    await tunnel.open();
    const client = connect(tunnel.localPort!, "127.0.0.1");
    client.on("error", () => {});
    client.write("GET / HTTP/1.1\r\n\r\n");
    await until(() => spawned.length === 2 && spawned[1]!.received === "GET / HTTP/1.1\r\n\r\n");
    client.destroy();
    await until(() => spawned[1]!.killed);
    await tunnel.close();
  });

  it("shows a stream that cannot authenticate, recovers on the next, and stops for a changed key", async () => {
    let next = "ok";
    const { tunnel, spawned, states } = fakeTunnel((ssh) => {
      if (next === "ok") ssh.say(authed);
      else {
        ssh.say(next);
        ssh.exit(255);
      }
    });
    await tunnel.open();
    const kept = tunnel.connect();
    await until(() => spawned.length === 2 && spawned[1]!.stderr.readableLength === 0);
    await new Promise((r) => setTimeout(r, 10));
    next = "ssh: connect to host lab port 22: Connection timed out";
    tunnel.connect().on("error", () => {});
    await until(() => tunnel.state.phase === "reconnecting");
    expect(tunnel.transportVerified()).toBe(false);
    next = "ok";
    tunnel.connect();
    await until(() => tunnel.state.phase === "open");
    next = "Host key verification failed.";
    tunnel.connect().on("error", () => {});
    await until(() => tunnel.state.phase === "failed");
    expect(tunnel.state).toEqual({ phase: "failed", refusal: "host-key-changed" });
    // Everything still open ends, and nothing new starts.
    expect(kept.destroyed).toBe(true);
    const count = spawned.length;
    expect(() => tunnel.connect()).toThrow(TunnelRefusal);
    expect(spawned).toHaveLength(count);
    expect(states.map((s) => s.phase)).toEqual(["starting", "open", "reconnecting", "open", "failed"]);
    await tunnel.close();
  });

  it("enrolls a pin once, then fails closed when it goes missing, empty or unreadable", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh, n, args) => {
      if (n === 1) {
        expect(args).toContain("StrictHostKeyChecking=accept-new");
        // ssh's accept-new writes the key; the tunnel records the enrollment once authenticated.
        writeFileSync(pins, "orca-lab ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6\n");
      } else expect(args).toContain("StrictHostKeyChecking=yes");
      ssh.say(authed);
    });
    const pins = (tunnel as unknown as { options: { knownHostsFile: string } }).options.knownHostsFile;
    expect(pinState(pins)).toBe("none");
    await tunnel.open();
    expect(pinState(pins)).toBe("pinned");
    expect(existsSync(`${pins}.enrolled`)).toBe(true);
    tunnel.connect();
    await until(() => spawned.length === 2);

    // Deleted after enrollment: the open tunnel still checks every stream against the pin it
    // sealed, never accepting a new key, and a new tunnel starts no ssh at all.
    rmSync(pins);
    expect(pinState(pins)).toBe("broken");
    tunnel.connect();
    await until(() => spawned.length === 3);
    expect(tunnel.pinnedKeys).toBe(JSON.stringify(["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6", null]));
    const fresh = fakeTunnel(() => {}, { knownHostsFile: pins });
    await expect(fresh.tunnel.open()).rejects.toMatchObject({ code: "host-key-missing" });
    expect(fresh.spawned).toHaveLength(0);
    await tunnel.close();

    for (const damage of [
      () => writeFileSync(pins, ""),
      () => writeFileSync(pins, "# nothing here\n"),
      // A directory where the file was: unreadable.
      () => mkdirSync(pins),
    ]) {
      forgetPin(pins);
      writeFileSync(pins, "orca-lab ssh-ed25519 AAAA\n");
      markPinEnrolled(pins);
      rmSync(pins, { recursive: true, force: true });
      damage();
      expect(pinState(pins)).toBe("broken");
      const again = fakeTunnel((ssh) => ssh.say(authed), { knownHostsFile: pins });
      await expect(again.tunnel.open()).rejects.toMatchObject({ code: "host-key-missing" });
      expect(again.spawned).toHaveLength(0);
      rmSync(pins, { recursive: true, force: true });
    }

    // An existing pin file with no key is broken even without a marker: nothing to trust.
    forgetPin(pins);
    writeFileSync(pins, "");
    expect(pinState(pins)).toBe("broken");

    // Only the explicit reset re-enables first-connect enrollment.
    forgetPin(pins);
    expect(pinState(pins)).toBe("none");
    expect(existsSync(`${pins}.enrolled`)).toBe(false);
  });

  it("refuses a stream whose pin enrollment cannot be written, without throwing out of ssh's handlers", async () => {
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => unhandled.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      // At open: the probe is never reported ready, and nothing is left running.
      const broken = () => {
        throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      };
      const first = fakeTunnel((ssh) => ssh.say(authed), { markEnrolled: broken });
      await expect(first.tunnel.open()).rejects.toMatchObject({ code: "pin-write-failed" });
      expect(first.tunnel.state).toEqual({ phase: "failed", refusal: "pin-write-failed" });
      expect(first.spawned[0]!.killed).toBe(true);

      // After open: that connection is closed with the refusal, and the tunnel stops.
      let fail = false;
      const later = fakeTunnel((ssh) => ssh.say(authed), {
        markEnrolled: () => {
          if (fail) broken();
        },
      });
      await later.tunnel.open();
      fail = true;
      const socket = later.tunnel.connect();
      const errors: unknown[] = [];
      socket.on("error", (error) => errors.push(error));
      await closed(socket);
      expect(errors).toEqual([expect.objectContaining({ code: "pin-write-failed" })]);
      expect(later.spawned[1]!.killed).toBe(true);
      expect(later.tunnel.state).toEqual({ phase: "failed", refusal: "pin-write-failed" });
      expect(() => later.tunnel.connect()).toThrow(TunnelRefusal);
      await later.tunnel.close();

      // Behind a jump host, the jump's own enrollment failing refuses the open too.
      const jump = fakeTunnel((ssh, _n, args) => ssh.say(args.includes("-W") ? authed : listening), {
        profile: profile({ jump: { destination: "j@bastion" } }),
        markEnrolled: broken,
      });
      await expect(jump.tunnel.open()).rejects.toMatchObject({ code: "pin-write-failed" });
      expect(jump.spawned[0]!.killed).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("notices a daemon port that refuses the channel", async () => {
    const { tunnel } = fakeTunnel((ssh) => {
      ssh.say(authed);
      ssh.say("channel 0: open failed: connect failed: Connection refused");
      ssh.say("stdio forwarding failed");
      ssh.exit(255);
    });
    await tunnel.open();
    await until(() => tunnel.remoteRefused());
    // ssh itself works: that is not a tunnel failure.
    expect(tunnel.state.phase).toBe("open");
    await tunnel.close();
  });

  it("starts a jump host first, ends every stream when it drops, and restarts it", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh, _n, args) => ssh.say(args.includes("-W") ? authed : listening), {
      profile: profile({ jump: { destination: "j@bastion" } }),
    });
    await tunnel.open();
    expect(spawned).toHaveLength(2);
    expect(tunnel.transportVerified()).toBe(true);
    const socket = tunnel.connect();
    expect(spawned).toHaveLength(3);
    // Loss of the jump is visible synchronously, before its exit is even delivered.
    spawned[0]!.exitCode = 255;
    expect(tunnel.transportVerified()).toBe(false);
    expect(() => tunnel.connect()).toThrow(TunnelRefusal);
    spawned[0]!.exitCode = null;
    spawned[0]!.exit(255);
    await closed(socket);
    expect(spawned[2]!.killed).toBe(true);
    await until(() => spawned.length === 4 && tunnel.state.phase === "open");
    expect(tunnel.transportVerified()).toBe(true);
    await tunnel.close();
  });

  it("leaves nothing running when the server hop fails behind a working jump host", async () => {
    const { tunnel, spawned } = fakeTunnel(
      (ssh, n) => {
        if (n === 1) ssh.say(listening);
        else {
          ssh.say("Host key verification failed.");
          ssh.exit(255);
        }
      },
      { profile: profile({ jump: { destination: "j@bastion" } }) },
    );
    await expect(tunnel.open()).rejects.toMatchObject({ code: "host-key-changed" });
    expect(spawned[0]!.killed).toBe(true);
    // The jump host's ssh only forwards: it reads nothing. The server hop carries a stream.
    expect(spawned.map((ssh) => ssh.stdinMode)).toEqual(["ignore", "pipe"]);
  });

  it("is single-use once closed", async () => {
    const { tunnel } = fakeTunnel((ssh) => ssh.say(authed));
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

describe("commands on the server (#875)", () => {
  /** A pin file holding a key, as an earlier connect left it. */
  const pinned = (name = "lab.known_hosts") => {
    const pins = join(dir(), name);
    writeFileSync(pins, "orca-lab ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6\n");
    return pins;
  };

  it("runs a command instead of forwarding, with the same pinned, config-free ssh", () => {
    const hops = tunnelHops(profile(), join(dir(), "lab.known_hosts"));
    const args = commandArgs(hops.daemon, [
      "orca",
      "auth",
      "issue",
      "desktop-pc",
      "--expires-at",
      "2027-01-01T00:00:00.000Z",
    ]);
    expect(args.slice(0, 2)).toEqual(["-F", "none"]);
    expect(args).not.toContain("-W");
    expect(args).toContain("HostKeyAlias=orca-lab");
    expect(args.slice(-8)).toEqual([
      "--",
      "casey@lab.example",
      "orca",
      "auth",
      "issue",
      "desktop-pc",
      "--expires-at",
      "2027-01-01T00:00:00.000Z",
    ]);
    // Windows paths (written with `/`) and credential ids pass as they are.
    expect(commandArgs(hops.daemon, ["C:/Orca/orca.cmd", "auth", "revoke", "AbC_dEf-1234"]).at(-1)).toBe(
      "AbC_dEf-1234",
    );
  });

  it("seals its pins: streams and commands check the tunnel's own copy, and only the keys expected (#875 review 4)", async () => {
    const pins = pinned();
    const keys = tunnelKeyIdentity(pins, false);
    expect(keys).toBe(JSON.stringify(["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6", null]));
    const { tunnel, spawned } = fakeTunnel(
      (ssh, _n, args) => {
        // Never the live pin file: the tunnel's sealed copy, strictly.
        expect(args).toContain("StrictHostKeyChecking=yes");
        expect(args.some((arg) => arg.startsWith("UserKnownHostsFile=") && arg.includes(".session-"))).toBe(true);
        ssh.say(authed);
        if (args.includes("-W")) return;
        ssh.exit(0);
      },
      { knownHostsFile: pins, expectKeys: keys },
    );
    await tunnel.open();
    expect(tunnel.pinnedKeys).toBe(keys);
    // The live pin now vouches for another key: what the tunnel carries does not change.
    writeFileSync(pins, "orca-lab ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5\n");
    tunnel.connect();
    await until(() => spawned.length === 2);
    await expect(tunnel.exec(["orca", "auth", "list"])).resolves.toMatchObject({ code: 0 });
    expect(tunnel.pinnedKeys).toBe(keys);
    const sessions = () => readdirSync(dirname(pins)).filter((name) => name.includes(".session-"));
    expect(sessions()).toHaveLength(1);
    await tunnel.close();
    expect(sessions()).toEqual([]);

    // A tunnel, or a one-off command, expecting other keys refuses before any ssh starts.
    const other = fakeTunnel(() => {}, { knownHostsFile: pins, expectKeys: keys });
    await expect(other.tunnel.open()).rejects.toMatchObject({ code: "host-key-changed" });
    const once = fakeTunnel(() => {}, { knownHostsFile: pins, expectKeys: keys });
    await expect(once.tunnel.runOnce(["orca", "auth", "list"])).rejects.toMatchObject({ code: "host-key-changed" });
    expect([...other.spawned, ...once.spawned]).toEqual([]);
    expect(sessions()).toEqual([]);
  });

  it("uploads a file as cp /dev/stdin <path>, fed from the file, and refuses a failed copy (#1234)", async () => {
    const pins = pinned();
    const source = join(dir(), "bundle.tar.xz");
    writeFileSync(source, Buffer.alloc(200_000, 7));
    let code = 0;
    const commands: (readonly string[])[] = [];
    const { tunnel, spawned } = fakeTunnel(
      (ssh, _n, args) => {
        ssh.say(authed);
        if (args.includes("-W")) return;
        commands.push(args.slice(args.indexOf("--") + 2));
        const done = () => setImmediate(() => ssh.exit(code));
        if (ssh.stdin.writableFinished) done();
        else ssh.stdin.on("finish", done);
      },
      { knownHostsFile: pins },
    );
    await tunnel.open();
    await tunnel.upload(source, "/tmp/tmp.Ab12Cd/bundle.tar.xz", 5_000);
    expect(commands[0]).toEqual(["cp", "/dev/stdin", "/tmp/tmp.Ab12Cd/bundle.tar.xz"]);
    expect(spawned[1]!.received.length).toBe(200_000);
    code = 1;
    await expect(tunnel.upload(source, "/tmp/tmp.Ab12Cd/again", 5_000)).rejects.toMatchObject({ code: "ssh-failed" });
    await expect(tunnel.upload(source, "/tmp/a b", 5_000)).rejects.toThrow();
    await tunnel.close();
  });

  it("hands a command its standard input when given one, and an empty one otherwise (#881)", async () => {
    const pins = pinned();
    const { tunnel, spawned } = fakeTunnel(
      (ssh) => {
        ssh.say(authed);
        if (ssh.stdin.writableFinished) setImmediate(() => ssh.exit(0));
        else ssh.stdin.on("finish", () => setImmediate(() => ssh.exit(0)));
      },
      { knownHostsFile: pins },
    );
    await tunnel.open();
    await expect(tunnel.exec(["python3", "-", "--version", "0.8.0"], 1_000, "print('setup')\n")).resolves.toMatchObject(
      {
        code: 0,
      },
    );
    await expect(tunnel.exec(["orca", "auth", "list"], 1_000)).resolves.toMatchObject({ code: 0 });
    expect(spawned.slice(1).map((ssh) => ssh.received)).toEqual(["print('setup')\n", ""]);
    // Every one of them on a real pipe that ORCA closes, never on "nothing": on Windows that
    // is an input that never ends, so `python3 -` waited for its program forever.
    expect(spawned.map((ssh) => ssh.stdinMode)).toEqual(["pipe", "pipe", "pipe"]);
    await tunnel.close();
  });

  it.each([
    [[]],
    [["orca", "a b"]],
    [["orca;id"]],
    [["$(id)"]],
    [["orca", "'x'"]],
    [["orca", "a&b"]],
    [["orca", "%PATH%"]],
    // A backslash escapes in sh and is literal in cmd: the same word, two meanings.
    [["C:\\Orca\\orca.cmd"]],
    [["orca", "a\\nb"]],
    [["orca", ""]],
  ])("refuses %j before ssh starts", (command) => {
    const hops = tunnelHops(profile(), join(dir(), "lab.known_hosts"));
    expect(() => commandArgs(hops.daemon, command)).toThrow(RemoteCommandRefused);
  });

  it("collects the command's output and its own error lines, over a strictly pinned ssh", async () => {
    const pins = pinned();
    const { tunnel, spawned } = fakeTunnel(
      (ssh, _n, args) => {
        expect(args.at(-1)).toBe("--json");
        expect(args).toContain("StrictHostKeyChecking=yes");
        expect(args).not.toContain("StrictHostKeyChecking=accept-new");
        ssh.say(authed);
        ssh.say("debug1: client_input_channel_req: channel 0 rtype exit-status reply 0");
        ssh.say("warning: something from orca");
        ssh.stdout.write('{"ok":');
        ssh.stdout.write("true}");
        ssh.exit(3);
      },
      { knownHostsFile: pins },
    );
    const result = await tunnel.runOnce(["orca", "auth", "list", "--json"]);
    expect(result).toEqual({ code: 3, stdout: '{"ok":true}', serverLines: ["warning: something from orca"] });
    expect(pinState(pins)).toBe("pinned");
    expect(spawned).toHaveLength(1);
    expect(tunnel.state.phase).toBe("closed");
    await expect(tunnel.runOnce(["orca"])).rejects.toThrow();
  });

  it("names the key a pin vouches for, so a reset pin reads as another server", () => {
    const pins = pinned();
    expect(pinnedKeyIdentity(pins)).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6");
    writeFileSync(pins, "# none\n");
    expect(pinnedKeyIdentity(pins)).toBeUndefined();
    expect(pinnedKeyIdentity(join(dir(), "missing"))).toBeUndefined();
  });

  it("reads a result only once the output has drained, and output that never ends is a failure", async () => {
    const late = fakeTunnel(
      (ssh) => {
        ssh.say(authed);
        ssh.stdout.write("{");
        ssh.exitCode = 0;
        ssh.emit("exit", 0, null);
        // Output still arriving after exit: part of the result.
        setImmediate(() => {
          ssh.stdout.end("}");
          ssh.emit("close", 0, null);
        });
      },
      { knownHostsFile: pinned() },
    );
    await expect(late.tunnel.runOnce(["orca"])).resolves.toMatchObject({ code: 0, stdout: "{}" });

    const endless = fakeTunnel(
      (ssh) => {
        ssh.holdOutput = true;
        ssh.say(authed);
        ssh.exit(0);
      },
      { knownHostsFile: pinned() },
    );
    await expect(endless.tunnel.runOnce(["orca"])).rejects.toMatchObject({ code: "ssh-failed" });
  });

  it("never trusts a key on first use: an unpinned server or jump host is refused before ssh starts", async () => {
    const fresh = fakeTunnel((ssh) => ssh.say(authed));
    await expect(fresh.tunnel.runOnce(["orca"])).rejects.toMatchObject({ code: "host-key-missing" });
    expect(fresh.spawned).toHaveLength(0);

    // Pinned server, unpinned jump host: the jump never starts with accept-new either.
    const pins = pinned();
    const jumped = fakeTunnel((ssh) => ssh.say(listening), {
      knownHostsFile: pins,
      profile: profile({ jump: { destination: "casey@jump.example" } }),
    });
    await expect(jumped.tunnel.runOnce(["orca"])).rejects.toMatchObject({ code: "host-key-missing" });
    expect(jumped.spawned).toHaveLength(0);
    // The static form is the same, whatever options it is given.
    await expect(
      SshTunnel.run(
        {
          profile: profile(),
          knownHostsFile: join(dir(), "none.known_hosts"),
          spawn: () => {
            throw new Error("ssh must not start");
          },
        },
        ["orca"],
      ),
    ).rejects.toMatchObject({ code: "host-key-missing" });
  });

  it("refuses like a stream when ssh fails, times out, prints too much, or the pin is gone", async () => {
    const denied = fakeTunnel(
      (ssh) => {
        ssh.say("casey@lab: Permission denied (publickey).");
        ssh.exit(255);
      },
      { knownHostsFile: pinned() },
    );
    await expect(denied.tunnel.runOnce(["orca"])).rejects.toMatchObject({ code: "auth-failed" });

    const stuck = fakeTunnel((ssh) => ssh.say(authed), { knownHostsFile: pinned() });
    await expect(stuck.tunnel.runOnce(["orca"], 30)).rejects.toMatchObject({ code: "timeout" });
    expect(stuck.spawned[0]!.killed).toBe(true);

    const loud = fakeTunnel(
      (ssh) => {
        ssh.say(authed);
        ssh.stdout.write(Buffer.alloc(70 * 1024, "x"));
        ssh.exit(0);
      },
      { knownHostsFile: pinned() },
    );
    await expect(loud.tunnel.runOnce(["orca"])).rejects.toMatchObject({ code: "ssh-failed" });

    const pins = join(dir(), "gone.known_hosts");
    writeFileSync(pins, "");
    const broken = fakeTunnel((ssh) => ssh.say(authed), { knownHostsFile: pins });
    await expect(broken.tunnel.runOnce(["orca"])).rejects.toMatchObject({ code: "host-key-missing" });
    expect(broken.spawned).toHaveLength(0);

    const missing = fakeTunnel(
      (ssh) => ssh.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })),
      { knownHostsFile: pinned() },
    );
    await expect(missing.tunnel.runOnce(["orca"])).rejects.toMatchObject({ code: "ssh-missing" });
  });

  it("runs on an open tunnel's server, and closing the tunnel stops a running command", async () => {
    const { tunnel, spawned } = fakeTunnel(
      (ssh, n) => {
        ssh.say(authed);
        if (n === 2) ssh.stdout.write("partial");
      },
      { knownHostsFile: pinned() },
    );
    await tunnel.open();
    const running = tunnel.exec(["orca", "auth", "list"]);
    await until(() => spawned.length === 2);
    await tunnel.close();
    expect(spawned[1]!.killed).toBe(true);
    await expect(running).resolves.toMatchObject({ code: 255 });
    await expect(tunnel.exec(["orca"])).rejects.toMatchObject({ code: "closed" });
  });
});

describe("following one command on the server (#879)", () => {
  /** A child whose stdio and exit the test drives, closing like a real one. */
  function child() {
    const ssh = new FakeSsh();
    const end = (code: number | null, signal: string | null = null) => {
      ssh.stdout.end();
      ssh.stderr.end();
      setImmediate(() => ssh.emit("close", code, signal));
    };
    return { ssh, end };
  }
  const lines = () => {
    const seen: string[] = [];
    return { seen, onLine: (stream: "stdout" | "stderr", line: string) => seen.push(`${stream}:${line}`) };
  };
  const follow = (ssh: FakeSsh, onLine: (stream: "stdout" | "stderr", line: string) => void) =>
    runRemote(ssh as unknown as ChildProcess, onLine);

  it("streams the command's lines, never ssh's, and returns its exit", async () => {
    const { ssh, end } = child();
    const out = lines();
    const run = follow(ssh, out.onLine);
    ssh.say(
      "debug1: Connecting to lab.example port 22.\nAuthenticated to lab.example ([10.0.0.5]:22) using publickey.",
    );
    ssh.say("debug1: Entering interactive session.\ndebug1: pledge: filesystem");
    ssh.stdout.write("staging v0.8.0\nhalf");
    await until(() => out.seen.length === 1);
    ssh.say("orca-release: Busy: update.lock; another update");
    ssh.stdout.write(" a line\r\n");
    ssh.say("debug1: client_input_channel_req: channel 0 rtype exit-status reply 0");
    ssh.say("Transferred: sent 2612, received 2588 bytes, in 0.1 seconds\nBytes per second: sent 33.9, received 33.6");
    end(1);
    expect(await run.exit).toEqual<RemoteCommandExit>({ kind: "exited", code: 1 });
    expect(out.seen).toEqual([
      "stdout:staging v0.8.0",
      "stderr:orca-release: Busy: update.lock; another update",
      "stdout:half a line",
    ]);
  });

  it("classifies ssh that never started the session, and reads a later 255 as not known", async () => {
    const refused = child();
    const out = lines();
    const run = follow(refused.ssh, out.onLine);
    refused.ssh.say("casey@lab.example: Permission denied (publickey).");
    refused.end(255);
    expect(await run.exit).toEqual({ kind: "refused", refusal: "auth-failed" });
    expect(out.seen).toEqual([]);

    // Exit 0 without a session is still ssh's failure, not the command's success.
    const odd = child();
    const none = follow(odd.ssh, () => {});
    odd.end(0);
    expect((await none.exit).kind).toBe("refused");

    const lost = child();
    const after = follow(lost.ssh, () => {});
    lost.ssh.say("debug1: Entering interactive session.");
    lost.ssh.say("Connection to lab.example closed by remote host.");
    lost.end(255);
    expect(await after.exit).toEqual({ kind: "refused", refusal: "ssh-failed" });
  });

  it("reports a signal, a missing ssh, and a kill", async () => {
    const signalled = child();
    const run = follow(signalled.ssh, () => {});
    signalled.ssh.say("debug1: Entering interactive session.");
    signalled.end(null, "SIGHUP");
    expect(await run.exit).toEqual({ kind: "signalled", signal: "SIGHUP" });

    const missing = child();
    const none = follow(missing.ssh, () => {});
    missing.ssh.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }));
    missing.end(null);
    expect(await none.exit).toEqual({ kind: "refused", refusal: "ssh-missing" });

    const killed = child();
    const stopped = follow(killed.ssh, () => {});
    killed.ssh.say("debug1: Entering interactive session.");
    stopped.kill();
    expect(killed.ssh.killed).toBe(true);
    killed.end(null, "SIGTERM");
    expect(await stopped.exit).toEqual({ kind: "signalled", signal: "SIGTERM" });
  });

  it("runs only through the pins an open tunnel sealed, as its own ssh, stopped with the tunnel", async () => {
    const { tunnel, spawned } = fakeTunnel((ssh, n, args) => {
      if (n === 1) {
        writeFileSync(pins, "orca-lab ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6\n");
        ssh.say(authed);
        return;
      }
      expect(args).toContain("StrictHostKeyChecking=yes");
      expect(args).not.toContain("-W");
      expect(args.slice(-2)).toEqual(["orca", "version"]);
      ssh.say("debug1: Entering interactive session.");
      ssh.stdout.write("done\n");
      if (n === 2) {
        ssh.stdout.end();
        ssh.stderr.end();
        setImmediate(() => ssh.emit("close", 0, null));
      }
    });
    const pins = (tunnel as unknown as { options: { knownHostsFile: string } }).options.knownHostsFile;
    expect(() => tunnel.execStreaming(["true"], () => {})).toThrow(expect.objectContaining({ code: "closed" }));
    await tunnel.open();
    expect(tunnel.pinnedKeys).toBeDefined();
    // The pin file changing afterwards changes nothing the tunnel carries.
    rmSync(pins);
    const seen: string[] = [];
    const run = tunnel.execStreaming(["orca", "version"], (_stream, line) => seen.push(line));
    expect(await run.exit).toEqual({ kind: "exited", code: 0 });
    expect(seen).toEqual(["done"]);
    expect(() => tunnel.execStreaming(["it's"], () => {})).toThrow(RemoteCommandRefused);
    tunnel.execStreaming(["orca", "version"], () => {});
    await until(() => spawned.length === 3);
    await tunnel.close();
    expect(spawned[2]!.killed).toBe(true);
    expect(() => tunnel.execStreaming(["true"], () => {})).toThrow(expect.objectContaining({ code: "closed" }));
  });

  it("refuses on a tunnel that is open but never sealed its pins", async () => {
    const { tunnel } = fakeTunnel((ssh) => ssh.say(authed));
    await tunnel.open();
    expect(tunnel.pinnedKeys).toBeUndefined();
    expect(() => tunnel.execStreaming(["orca", "version"], () => {})).toThrow(
      expect.objectContaining({ code: "host-key-missing" }),
    );
    await tunnel.close();
  });
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
      // Windows resets loopback sockets the tunnel tears down; that is not a test failure.
      socket.on("error", () => {});
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
        identityFile: live!.identity,
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

  it("pins on first connect, carries each connection on its own ssh, and refuses a changed key", async () => {
    const remote = await daemon();
    const pins = join(dir(), "live.known_hosts");
    const first = open(remote, pins);
    const url = await first.open();
    expect(await (await fetch(url)).text()).toBe("orca");
    expect(first.hostKeyFingerprint).toMatch(/^SHA256:/);
    expect(statSync(pins).size).toBeGreaterThan(0);

    // The client's own path: a request over a stream `connect()` returns, no port dialled.
    const { request } = await import("node:http");
    const viaStream = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: remote, path: "/", createConnection: () => first.connect() },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => (text += chunk.toString()));
          res.on("end", () => resolve(text));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(viaStream).toBe("orca");

    // Killing one connection's ssh ends that connection only; the next is a fresh stream.
    const streams = (first as unknown as { streams: Set<{ child: { kill(): void }; authenticated: boolean }> }).streams;
    const doomed = first.connect();
    doomed.on("error", () => {});
    doomed.resume();
    await until(() => streams.size > 0 && [...streams].every((stream) => stream.authenticated), 15_000);
    for (const stream of streams) stream.child.kill();
    await new Promise<void>((resolve) => (doomed.destroyed ? resolve() : doomed.once("close", () => resolve())));
    expect(first.state.phase).toBe("open");
    expect(await (await fetch(url)).text()).toBe("orca");
    await first.close();

    // The pinned key is now enforced: swap in a different key for the same host entry.
    const pinned = readFileSync(pins, "utf8").trim().split(/\s+/);
    writeFileSync(
      pins,
      `${pinned[0]} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n`,
    );
    await expect(open(remote, pins).open()).rejects.toMatchObject({ code: "host-key-changed" });

    // An enrolled pin that is emptied or deleted fails closed; only forgetting it re-pins.
    writeFileSync(pins, "");
    await expect(open(remote, pins).open()).rejects.toMatchObject({ code: "host-key-missing" });
    rmSync(pins);
    await expect(open(remote, pins).open()).rejects.toMatchObject({ code: "host-key-missing" });
    forgetPin(pins);
    expect(await (await fetch(await open(remote, pins).open())).text()).toBe("orca");
  }, 60_000);

  it("hands a command its whole standard input through the real ssh (#881)", async () => {
    // Server setup sends its program to `python3 -` this way: well over 100 KB. ssh must get
    // a pipe that ends, not "nothing", which never ends on Windows (the program never arrived).
    const tunnel = open(await daemon(), join(dir(), "live.known_hosts"));
    await tunnel.open();
    const program = `// ${"x".repeat(200_000)}\nprocess.stdout.write("whole program ran");\n`;
    const result = await tunnel.exec(["node", "-"], 60_000, program);
    expect(result).toMatchObject({ code: 0, stdout: "whole program ran" });
  }, 90_000);

  it("refuses failed auth, a missing ssh, and a forward that cannot bind", async () => {
    const remote = await daemon();
    const pins = join(dir(), "live.known_hosts");
    const wrongKey = join(dir(), "none");
    await expect(open(remote, pins, { identityFile: wrongKey }).open()).rejects.toMatchObject({ code: "auth-failed" });
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
        identityFile: live!.identity,
        remotePort: remote,
      }),
      knownHostsFile: pins,
      pickPort: () => Promise.resolve(busy),
    });
    tunnels.push(tunnel);
    await expect(tunnel.open()).rejects.toMatchObject({ code: "forward-failed" });
  }, 60_000);

  it("ignores every ssh config: the effective settings are ORCA's", async () => {
    const pins = join(dir(), "live.known_hosts");
    const hop = tunnelHops(
      ConnectionProfileSchema.parse({
        id: "live",
        name: "Live",
        destination: live!.destination,
        sshPort: live!.sshPort,
      }),
      pins,
    ).daemon;
    // `ssh -G` prints the configuration ssh would use for exactly this argv, then exits.
    const { execFileSync } = await import("node:child_process");
    const args = hopArgs(hop).filter((arg, i, all) => arg !== "-v" && arg !== "-W" && all[i - 1] !== "-W");
    const printed = execFileSync("ssh", ["-G", ...args], { encoding: "utf8" });
    const settings = new Map<string, string[]>();
    for (const line of printed.split(/\r?\n/)) {
      const [key, ...value] = line.split(" ");
      if (key) settings.set(key, [...(settings.get(key) ?? []), value.join(" ")]);
    }
    expect(settings.get("stricthostkeychecking")).toEqual(["accept-new"]);
    expect(settings.get("batchmode")).toEqual(["yes"]);
    expect(settings.get("exitonforwardfailure")).toEqual(["yes"]);
    expect(settings.get("hostkeyalias")).toEqual(["orca-live"]);
    expect(settings.get("forwardagent")).toEqual(["no"]);
    expect(settings.get("permitlocalcommand")).toEqual(["no"]);
    // A user config's LocalForward would show here: none applies.
    expect(settings.get("localforward")).toBeUndefined();
    expect(settings.get("remoteforward")).toBeUndefined();
    expect(settings.get("dynamicforward")).toBeUndefined();
    expect(settings.get("proxycommand")).toBeUndefined();
    expect(settings.get("localcommand")).toBeUndefined();
    // Both known-hosts sources are the pin file and nothing else.
    for (const key of ["userknownhostsfile", "globalknownhostsfile"])
      expect(settings.get(key)?.join(" ").replace(/\\/g, "/")).toBe(pins.replace(/\\/g, "/"));
  }, 60_000);

  it("reaches the server through an app-owned jump host with its own pin", async () => {
    const remote = await daemon();
    const pins = join(dir(), "live.known_hosts");
    const tunnel = open(remote, pins, {
      jump: {
        destination: live!.destination,
        ...(live!.sshPort ? { sshPort: live!.sshPort } : {}),
        identityFile: live!.identity,
      },
    });
    const url = await tunnel.open();
    expect(await (await fetch(url)).text()).toBe("orca");
    expect(statSync(pins).size).toBeGreaterThan(0);
    expect(statSync(`${pins}.jump`).size).toBeGreaterThan(0);
    expect(readFileSync(pins, "utf8")).toMatch(/^orca-live /);
    expect(readFileSync(`${pins}.jump`, "utf8")).toMatch(/^orca-live-jump /);
  }, 60_000);

  it("tells a missing remote daemon apart from a broken tunnel", async () => {
    const nothing = await ephemeralLoopbackPort();
    // ssh's own lines (not its debug output), to say what the server did if this fails.
    const said: string[] = [];
    const { spawn } = await import("node:child_process");
    const tunnel = new SshTunnel({
      profile: ConnectionProfileSchema.parse({
        id: "live",
        name: "Live",
        destination: live!.destination,
        ...(live!.sshPort ? { sshPort: live!.sshPort } : {}),
        identityFile: live!.identity,
        remotePort: nothing,
      }),
      knownHostsFile: join(dir(), "live.known_hosts"),
      spawn: (command, args) => {
        const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        child.stderr.on("data", (chunk: Buffer) =>
          said.push(
            ...chunk
              .toString()
              .split(/\r?\n/)
              .filter((line) => line && !/^debug[23]:/.test(line)),
          ),
        );
        return child;
      },
    });
    tunnels.push(tunnel);
    const url = await tunnel.open();
    // Either way nothing answers, and the tunnel itself is not at fault.
    await expect(fetch(url, { signal: AbortSignal.timeout(10_000) })).rejects.toThrow();
    expect(tunnel.state.phase).toBe("open");
    // The Windows OpenSSH server never refuses the channel to a closed port (its stdio
    // forward stays open with nothing behind it), so there is no refusal to tell apart
    // there; a request simply times out. OpenSSH elsewhere refuses at once.
    if (process.platform === "win32") return;
    for (let i = 0; i < 2_000 && !tunnel.remoteRefused(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(
      tunnel.remoteRefused(),
      said
        .filter(
          (line) =>
            !/^debug1: (Reading|Connecting|identity|Local version|Remote protocol|compat|kex|SSH2|expecting|Server host|load_hosts|Host |Will attempt|Offering|Server accepts|Authentications|Next authentication|Sending|pledge|client_input|Remote: )/.test(
              line,
            ),
        )
        .join("\n"),
    ).toBe(true);
  }, 60_000);
});

describe("tailnet profiles and login approval (#1226, #1228)", () => {
  const tailnet = { node: "nBuild1", name: "build-1.example-tailnet.ts.net" };

  it("binds a profile to a node by stable ID, never with junk", () => {
    expect(profile({ tailnet }).tailnet).toEqual(tailnet);
    expect(() => profile({ tailnet: { node: "a b", name: tailnet.name } })).toThrow();
    expect(() => profile({ tailnet: { node: "n1", name: "Build-1.example" } })).toThrow();
    expect(() => profile({ tailnet: { ...tailnet, extra: 1 } })).toThrow();
  });

  it("dials the node's current address, under the profile's own alias", async () => {
    const seen: (readonly string[])[] = [];
    let lookups = 0;
    const { tunnel } = fakeTunnel(
      (ssh, _n, args) => {
        seen.push(args);
        ssh.say(authed);
      },
      {
        profile: profile({ destination: "casey@build-1.example-tailnet.ts.net", tailnet }),
        resolveHost: () => {
          lookups += 1;
          return Promise.resolve("100.101.102.103");
        },
      },
    );
    await tunnel.open();
    expect(lookups).toBe(1);
    expect(seen[0]!.at(-1)).toBe("casey@100.101.102.103");
    expect(seen[0]).toContain("HostKeyAlias=orca-lab");
    await tunnel.close();
  });

  it("refuses a tailnet profile without a resolver, or when the node moved, before ssh starts", async () => {
    const bare = fakeTunnel((ssh) => ssh.say(authed), { profile: profile({ tailnet }) });
    await expect(bare.tunnel.open()).rejects.toMatchObject({ code: "tailnet-unavailable" });
    const moved = fakeTunnel((ssh) => ssh.say(authed), {
      profile: profile({ tailnet }),
      resolveHost: () => Promise.reject(new TunnelRefusal("tailnet-moved")),
    });
    await expect(moved.tunnel.open()).rejects.toMatchObject({ code: "tailnet-moved" });
    const odd = fakeTunnel((ssh) => ssh.say(authed), {
      profile: profile({ tailnet }),
      resolveHost: () => Promise.resolve("100.64.0.1 -oProxyCommand=x"),
    });
    await expect(odd.tunnel.open()).rejects.toMatchObject({ code: "tailnet-unavailable" });
    const broken = fakeTunnel((ssh) => ssh.say(authed), {
      profile: profile({ tailnet }),
      resolveHost: () => Promise.reject(new Error("boom")),
    });
    await expect(broken.tunnel.open()).rejects.toMatchObject({ code: "tailnet-unavailable" });
    expect([...bare.spawned, ...moved.spawned, ...odd.spawned, ...broken.spawned]).toEqual([]);
  });

  it.each([
    ["# To authenticate, visit: https://login.tailscale.com/a/l1a2b3c4", "https://login.tailscale.com/a/l1a2b3c4"],
    ["To authenticate, visit: https://headscale.example.org/check/abc\r", "https://headscale.example.org/check/abc"],
    ["# To authenticate, visit: http://login.tailscale.com/a/x", undefined],
    ["# To authenticate, visit: https://user:pw@login.tailscale.com/a/x", undefined],
    ["# To authenticate, visit: javascript:alert(1)", undefined],
    ["debug1: To authenticate, visit: https://login.tailscale.com/a/x", undefined],
    ["# Tailscale SSH requires an additional check.", undefined],
  ])("reads the approval link in %j", (line, url) => {
    expect(loginApprovalUrl(line.replace(/\r$/, ""))).toBe(url);
  });

  it("shows a check-mode approval link and waits for it past the ordinary timeout", async () => {
    const links: string[] = [];
    const { tunnel } = fakeTunnel(
      (ssh) => {
        ssh.say("# Tailscale SSH requires an additional check.");
        ssh.say("# To authenticate, visit: https://login.tailscale.com/a/l1a2b3c4");
        setTimeout(() => ssh.say(authed), 80);
      },
      { readyTimeoutMs: 30, approvalTimeoutMs: 1_000, onLoginApproval: (url: string) => links.push(url) },
    );
    await tunnel.open();
    expect(links).toEqual(["https://login.tailscale.com/a/l1a2b3c4"]);
    await tunnel.close();
  });

  it("refuses an approval nobody gave as approval-timeout, and ignores links nobody asked to see", async () => {
    const waiting = fakeTunnel((ssh) => ssh.say("# To authenticate, visit: https://login.tailscale.com/a/l1a2b3c4"), {
      readyTimeoutMs: 1_000,
      approvalTimeoutMs: 20,
      onLoginApproval: () => {},
    });
    await expect(waiting.tunnel.open()).rejects.toMatchObject({ code: "approval-timeout" });
    const unasked = fakeTunnel((ssh) => ssh.say("# To authenticate, visit: https://login.tailscale.com/a/l1a2b3c4"), {
      readyTimeoutMs: 20,
    });
    await expect(unasked.tunnel.open()).rejects.toMatchObject({ code: "timeout" });
  });
});
