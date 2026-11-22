/**
 * SSH connection profiles (#874): the profile store, and profile connections through the
 * Workspace and ConnectionTarget transaction. Tunnels are fakes here; the protocol package's
 * remote-access tests run the real ssh against a real sshd.
 */
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import {
  CredentialSlots,
  pinState,
  TunnelRefusal,
  type SecretCipher,
  type SshTunnel,
  type RemoteResult,
  type SshTunnelOptions,
  type TunnelState,
} from "@orca/protocol/remote-access";
import { connect as netConnect, type Socket } from "node:net";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { streamTransport } from "../src/client/stream-transport.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { DaemonClient } from "../src/client/daemon-client.js";
import { CredentialTransportUnavailable, type DaemonTokenSource } from "../src/client/auth.js";
import { DaemonSubscription } from "../src/client/subscription.js";
import { ConnectionTarget, connectionFailure } from "../src/main/connection-target.js";
import { installationId, principalFor, type CredentialRecord } from "../src/main/remote-credentials.js";
import {
  helloVerdict,
  RemoteProfiles,
  type CredentialVerdict,
  type HelloAnswer,
  type ProfileLease,
  type RemoteProfilesDeps,
} from "../src/main/remote-profiles.js";
import { Workspace, type WorkspaceDeps } from "../src/main/workspace.js";
import { PreferencesFile } from "../src/preferences/preferences-file.js";

const TOKEN = "orca_live_0123456789abcdefghij";
const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
  decryptString: (value) => Buffer.from(value.toString().replace(/^sealed:/, ""), "base64").toString(),
};

/**
 * ORCA's command line on the server, as `orca auth issue|rotate|revoke --json` answers over
 * ssh. `fail` makes the next commands exit as a broken install would.
 */
class FakeServer {
  readonly commands: string[][] = [];
  readonly credentials = new Map<
    string,
    { token: string; principal: string; expiresAt: string; revoked: boolean; label?: string }
  >();
  /** Tokens the daemon accepts besides live issued ones (an imported credential). */
  readonly accepted = new Set<string>([TOKEN]);
  fail?: { code: number; lines: string[] } | undefined;
  /** The daemon answers from another workspace: it knows none of the issued credentials. */
  otherWorkspace = false;
  /** The daemon cannot be asked: every check comes back `unknown`. */
  silent = false;
  readonly workspaceId = "2c7bf988-cf11-4f6d-9b36-77a4a7bf714f";
  /** Holds every command until released, to look at what happens meanwhile. */
  gate?: Promise<void> | undefined;
  private next = 0;
  run(command: readonly string[]): RemoteResult {
    this.commands.push([...command]);
    if (this.fail) return { code: this.fail.code, stdout: "", serverLines: this.fail.lines };
    const words = [...command];
    const flag = (name: string) => {
      const at = words.indexOf(name);
      return at < 0 ? undefined : words[at + 1];
    };
    const [, , sub, subject] = words;
    const gone = { code: 1, stdout: "", serverLines: [`error: no live credential ${subject}`] };
    if (sub === "issue" || sub === "rotate") {
      let principal = subject!;
      let label = flag("--label");
      if (sub === "rotate") {
        const old = this.credentials.get(subject!);
        if (!old || old.revoked) return gone;
        old.revoked = true;
        principal = old.principal;
        label = old.label;
      }
      const id = `cred${String(++this.next).padStart(8, "0")}`;
      const token = `orca1.${id}.secretsecretsecret${this.next}`;
      const expiresAt = flag("--expires-at")!;
      this.credentials.set(id, { token, principal, expiresAt, revoked: false, ...(label ? { label } : {}) });
      return {
        code: 0,
        stdout: JSON.stringify({ token, credential: { id, principal, expiresAt } }, null, 2),
        serverLines: [],
      };
    }
    if (sub === "revoke") {
      const old = this.credentials.get(subject!);
      if (!old || old.revoked)
        return { code: 1, stdout: "", serverLines: ["error [CONFIG_INVALID]: no live credential has that id"] };
      old.revoked = true;
      return { code: 0, stdout: JSON.stringify({ id: subject, revoked: true }), serverLines: [] };
    }
    return { code: 1, stdout: "", serverLines: ["error [CONFIG_INVALID]: auth expects issue, list, rotate or revoke"] };
  }
  live(): string[] {
    return [...this.credentials].filter(([, c]) => !c.revoked).map(([id]) => id);
  }
  verdict(token: string): CredentialVerdict {
    if (this.silent) return "unknown";
    if (this.accepted.has(token)) return "accepted";
    const known = [...this.credentials.values()].find((c) => c.token === token);
    return known && !known.revoked && !this.otherWorkspace ? "accepted" : "refused";
  }
  /** The daemon does not say which workspace it serves. */
  anonymous = false;
  answer(token: string): HelloAnswer {
    const verdict = this.verdict(token);
    return verdict === "accepted" && !this.anonymous ? { verdict, workspaceId: this.workspaceId } : { verdict };
  }
}

class FakeTunnel {
  closed = 0;
  refused = false;
  connects = 0;
  onStream?: (stream: Socket) => void;
  stateNow: TunnelState = { phase: "starting" };
  constructor(
    readonly options: SshTunnelOptions,
    private readonly outcome: Promise<string>,
    /** Where an authenticated stream ends up: the stand-in daemon's port. */
    private readonly daemonPort?: number,
    private readonly server = new FakeServer(),
  ) {}
  async exec(command: readonly string[]): Promise<RemoteResult> {
    await Promise.resolve();
    await this.server.gate;
    return this.server.run(command);
  }
  async runOnce(command: readonly string[]): Promise<RemoteResult> {
    // Like the real one: an administrative connection never trusts a key on first use.
    if (pinState(this.options.knownHostsFile) !== "pinned") throw new TunnelRefusal("host-key-missing");
    try {
      return await this.exec(command);
    } finally {
      await this.close();
    }
  }
  connect(): Socket {
    if (this.stateNow.phase !== "open" || !this.daemonPort) throw new TunnelRefusal("closed");
    this.connects += 1;
    const stream = netConnect(this.daemonPort, "127.0.0.1");
    this.onStream?.(stream);
    return stream;
  }
  get state(): TunnelState {
    return this.stateNow;
  }
  open(): Promise<string> {
    return this.outcome.then(
      (url) => {
        this.stateNow = { phase: "open", localPort: Number(new URL(url).port) };
        return url;
      },
      (error: unknown) => {
        this.stateNow = { phase: "failed", refusal: "auth-failed" };
        throw error;
      },
    );
  }
  remoteRefused(): boolean {
    return this.refused;
  }
  async close(): Promise<void> {
    this.closed += 1;
    this.stateNow = { phase: "closed" };
  }
}

function store(
  outcome: () => Promise<string> = () => Promise.resolve("http://127.0.0.1:41000"),
  daemonPort?: number,
  extra: Partial<RemoteProfilesDeps> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "orca-profiles-"));
  const tunnels: FakeTunnel[] = [];
  const server = new FakeServer();
  const profiles = new RemoteProfiles({
    dir,
    cipher,
    hostname: "Casey's PC",
    tunnel: (options) => {
      const tunnel = new FakeTunnel(options, outcome(), daemonPort, server);
      tunnels.push(tunnel);
      return tunnel as unknown as SshTunnel;
    },
    // The daemon's verdict on a credential, without a request of its own on the streams.
    verify: async (_connect, _url, token) => server.answer(token),
    ...extra,
  });
  return { dir, profiles, tunnels, server };
}

describe("RemoteProfiles", () => {
  it("saves nonsecret profiles, seals credentials, and never returns them", () => {
    const { dir, profiles } = store();
    const view = profiles.save({ name: "Build box", destination: "casey@build", sshPort: 2222 });
    expect(view).toMatchObject({ id: "build-box", remotePort: 6722, hasCredential: false, hostKeyPinned: false });
    expect(() => profiles.save({ name: "x", destination: "casey@build", token: TOKEN })).toThrow();
    const imported = profiles.importCredential("build-box", `${TOKEN}\n`);
    expect(imported.hasCredential).toBe(true);
    expect(JSON.stringify(profiles.list())).not.toContain(TOKEN);
    expect(readFileSync(join(dir, "profiles.json"), "utf8")).not.toContain(TOKEN);
    const vault = join(dir, "credentials", "vault");
    expect(readdirSync(vault)).toHaveLength(1);
    expect(readFileSync(join(vault, readdirSync(vault)[0]!), "utf8")).not.toContain(TOKEN);
    expect(() => profiles.importCredential("build-box", "not a token")).toThrow("not an ORCA daemon credential");
  });

  it("removing a profile removes its keychain entry and pinned key", async () => {
    const { dir, profiles } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    profiles.importCredential("lab", TOKEN);
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "lab ssh-ed25519 AAAA\n");
    expect(profiles.list()[0]?.hostKeyPinned).toBe(true);
    // Imported by hand: ORCA never issued it, so there is nothing for it to revoke.
    await expect(profiles.remove("lab")).resolves.toBe("none");
    expect(profiles.list()).toEqual([]);
    expect(existsSync(join(dir, "credentials", "lab.credential"))).toBe(false);
    expect(existsSync(join(dir, "known_hosts", "lab"))).toBe(false);
  });

  it("pointing a profile at another server forgets its key and credential", () => {
    const { dir, profiles } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    profiles.importCredential("lab", TOKEN);
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "lab ssh-ed25519 AAAA\n");
    expect(profiles.save({ id: "lab", name: "Lab 2", destination: "lab" })).toMatchObject({
      hasCredential: true,
      hostKeyPinned: true,
    });
    expect(profiles.save({ id: "lab", name: "Lab 2", destination: "other" })).toMatchObject({
      hasCredential: false,
      hostKeyPinned: false,
    });
  });

  it("shares one tunnel per profile, closes it with its last user, and refuses edits while in use", async () => {
    const { profiles, tunnels } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    profiles.importCredential("lab", TOKEN);
    const a = await profiles.open("lab");
    const b = await profiles.open("lab");
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0]!.options.knownHostsFile).toMatch(/known_hosts[\\/]lab$/);
    expect(a.url).toBe("http://127.0.0.1:41000");
    expect(a.auth.read()).toBe(TOKEN);
    await expect(profiles.remove("lab")).rejects.toThrow("Connect to another daemon");
    expect(() => profiles.save({ id: "lab", name: "Lab", destination: "x" })).toThrow("Connect to another daemon");
    await a.release();
    await a.release();
    expect(tunnels[0]!.closed).toBe(0);
    await b.release();
    expect(tunnels[0]!.closed).toBe(1);
    await profiles.remove("lab");
  });

  it("a failed tunnel is released and the next open starts a new one", async () => {
    let fail = true;
    const { profiles, tunnels } = store(() =>
      fail ? Promise.reject(new Error("refused")) : Promise.resolve("http://127.0.0.1:41001"),
    );
    profiles.save({ name: "Lab", destination: "lab" });
    profiles.importCredential("lab", TOKEN);
    await expect(profiles.open("lab")).rejects.toThrow("refused");
    expect(tunnels[0]!.closed).toBe(1);
    fail = false;
    await expect(profiles.open("lab")).resolves.toMatchObject({ url: "http://127.0.0.1:41001" });
    expect(tunnels).toHaveLength(2);
    await profiles.close();
  });
});

describe("pending work does not outlive a profile change", () => {
  it("writes a picked credential only into the profile the picker was opened for", async () => {
    const { profiles } = store();
    profiles.save({ name: "Lab", destination: "lab" });

    // Unchanged while the picker was open: stored.
    expect(profiles.importCredential("lab", TOKEN, profiles.ticket("lab")).hasCredential).toBe(true);

    for (const change of [
      () => profiles.save({ id: "lab", name: "Lab", destination: "other" }),
      () => profiles.save({ id: "lab", name: "Renamed", destination: "lab" }),
      () => profiles.forgetHostKey("lab"),
    ]) {
      profiles.save({ id: "lab", name: "Lab", destination: "lab" });
      const ticket = profiles.ticket("lab");
      change();
      expect(() => profiles.importCredential("lab", TOKEN, ticket)).toThrow("profile changed");
    }

    // Removed, then recreated under the same id: still not the profile the picker was for.
    const ticket = profiles.ticket("lab");
    await profiles.remove("lab");
    expect(() => profiles.importCredential("lab", TOKEN, ticket)).toThrow("no longer exists");
    profiles.save({ name: "Lab", destination: "lab" });
    expect(() => profiles.importCredential("lab", TOKEN, ticket)).toThrow("profile changed");
    expect(profiles.list()[0]?.hasCredential).toBe(false);
  });

  it("refuses a pin reset while a connect is in flight or open, and allows it after a failure", async () => {
    let finish!: (url: string) => void;
    const { profiles, tunnels } = store(() => new Promise<string>((resolve) => (finish = resolve)));
    profiles.save({ name: "Lab", destination: "lab" });
    profiles.importCredential("lab", TOKEN);
    const pending = profiles.open("lab");
    await vi.waitFor(() => expect(tunnels).toHaveLength(1));
    expect(() => profiles.forgetHostKey("lab")).toThrow("Connect to another daemon");
    finish("http://127.0.0.1:41000");
    const lease = await pending;
    expect(() => profiles.forgetHostKey("lab")).toThrow("Connect to another daemon");
    tunnels[0]!.stateNow = { phase: "failed", refusal: "host-key-changed" };
    profiles.forgetHostKey("lab");
    // The lease that predates the reset never yields the credential again.
    tunnels[0]!.stateNow = { phase: "open", localPort: 41000 };
    expect(() => lease.auth.read()).toThrow(CredentialTransportUnavailable);
    await lease.release();
  });

  it("shows an enrolled pin that went missing, and forgetting it is the only reset", () => {
    const { dir, profiles } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "orca-lab ssh-ed25519 AAAA\n");
    writeFileSync(join(dir, "known_hosts", "lab.enrolled"), "enrolled\n");
    expect(profiles.list()[0]).toMatchObject({ hostKeyPinned: true });
    expect(profiles.list()[0]).not.toHaveProperty("hostKeyMissing");
    writeFileSync(join(dir, "known_hosts", "lab"), "");
    expect(profiles.list()[0]).toMatchObject({ hostKeyPinned: false, hostKeyMissing: true });
    profiles.forgetHostKey("lab");
    expect(profiles.list()[0]).toMatchObject({ hostKeyPinned: false });
    expect(profiles.list()[0]).not.toHaveProperty("hostKeyMissing");
    expect(existsSync(join(dir, "known_hosts", "lab.enrolled"))).toBe(false);
  });
});

const hello = {
  protocol: PROTOCOL_VERSION,
  orcaVersion: "test",
  capabilities: ["runs.read", "runs.subscribe"] as HelloResult["capabilities"],
  identity: { workspaceId: "2c7bf988-cf11-4f6d-9b36-77a4a7bf714f", instanceId: "44112345-b16c-44ba-831d-a66f44488f66" },
};
const reply = (result: unknown) => new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result }));

describe("credentials travel only on the tunnel's authenticated streams", () => {
  /** A stand-in daemon: what the far end of an authenticated ssh stream reaches. */
  async function daemonRig(stall = false, accept: (authorization: string | undefined) => boolean = () => true) {
    const rpc: (string | undefined)[] = [];
    const sockets: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      rpc.push(request.headers.authorization);
      request.resume();
      request.on("end", () => {
        if (stall) return;
        if (!accept(request.headers.authorization)) {
          response.writeHead(401);
          response.end(
            JSON.stringify({ kind: "response", id: 1, ok: false, error: { code: "AUTH_INVALID", message: "no" } }),
          );
          return;
        }
        response.end(JSON.stringify({ kind: "response", id: 1, ok: true, result: hello }));
      });
    });
    const wss = new WebSocketServer({ server, handleProtocols: () => "orca.v1" });
    wss.on("connection", (socket, request) => {
      sockets.push(request.headers["sec-websocket-protocol"]);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // An impostor where the tunnel's URL points: it must never hear from the client.
    const offered: (string | undefined)[] = [];
    const impostor = createServer((request, response) => {
      offered.push(request.headers.authorization ?? request.headers["sec-websocket-protocol"]?.toString());
      response.end("{}");
    });
    impostor.on("upgrade", (request, socket) => {
      offered.push(request.headers["sec-websocket-protocol"]);
      socket.destroy();
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    const impostorAddress = impostor.address();
    const url = `http://127.0.0.1:${typeof impostorAddress === "object" && impostorAddress ? impostorAddress.port : 0}`;
    const close = async () => {
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections();
      impostor.closeAllConnections();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => impostor.close(resolve));
    };
    return { port, rpc, sockets, offered, url, close };
  }

  it("checks a credential with the daemon over the tunnel's own streams (#875)", async () => {
    let known: string | undefined;
    const daemon = await daemonRig(false, (authorization) => authorization === `Bearer ${known}`);
    try {
      // The daemon's own hello check, not the seam.
      const { profiles, server } = store(() => Promise.resolve(daemon.url), daemon.port, { verify: helloVerdict });
      profiles.save({ name: "Lab", destination: "lab" });
      // The daemon knows none of what the server's CLI issues: another workspace.
      await expect(profiles.open("lab")).rejects.toMatchObject({ code: "wrong-workspace" });
      expect(daemon.rpc).toHaveLength(1);
      expect(daemon.rpc[0]).toMatch(/^Bearer orca1\.cred/);
      expect(server.live()).toEqual([]);
      // It knows the next one: accepted, and the sign-in check went only to the daemon.
      known = "orca1.cred00000002.secretsecretsecret2";
      const lease = await profiles.open("lab");
      expect(lease.auth.read()).toBe(known);
      expect(daemon.rpc.at(-1)).toBe(`Bearer ${known}`);
      expect(daemon.offered).toEqual([]);
      await lease.release();
    } finally {
      await daemon.close();
    }
  });

  it("never switches to a credential no daemon has confirmed, and the probe still says why", async () => {
    const { profiles, server } = store(undefined, undefined, { verify: helloVerdict });
    profiles.save({ name: "Lab", destination: "lab" });
    const lease = await profiles.open("lab");
    // Issued and staged, not used: nothing answered to accept it.
    expect(lease.auth.read()).toBeUndefined();
    expect(profiles.list()[0]!.hasCredential).toBe(false);
    await lease.release();
    // The next connect asks about the staged one again rather than issuing another.
    await (await profiles.open("lab")).release();
    expect(server.commands.map((c) => c[2])).toEqual(["issue"]);
  });

  it("sends RPCs and the socket's credential over connect() streams, never to the URL", async () => {
    const daemon = await daemonRig();
    try {
      const { profiles, tunnels } = store(() => Promise.resolve(daemon.url), daemon.port);
      profiles.save({ name: "Lab", destination: "lab" });
      profiles.importCredential("lab", TOKEN);
      const lease = await profiles.open("lab");
      const client = new DaemonClient(lease.url, lease.transport.fetch, {
        auth: lease.auth,
        requireAuthentication: true,
        socket: lease.transport.socket,
      });
      expect((await client.hello("probe")).orcaVersion).toBe("test");
      expect(daemon.rpc).toEqual([`Bearer ${TOKEN}`]);

      const opened = vi.fn();
      const handle = lease.transport.socket(
        client.socketUrl,
        { onOpen: opened, onMessage: () => {}, onClose: () => {} },
        ["orca.v1", `orca.bearer.${TOKEN}`],
      );
      await vi.waitFor(() => expect(opened).toHaveBeenCalled());
      expect(daemon.sockets.map((header) => header?.split(/,\s*/))).toEqual([["orca.v1", `orca.bearer.${TOKEN}`]]);
      handle.close();

      expect(tunnels[0]!.connects).toBeGreaterThanOrEqual(2);
      expect(daemon.offered).toEqual([]);
      await lease.release();
    } finally {
      await daemon.close();
    }
  });

  it("fails a request whose stream is lost mid-flight, without redialling or reissuing it", async () => {
    const daemon = await daemonRig(true);
    try {
      const { profiles, tunnels } = store(() => Promise.resolve(daemon.url), daemon.port);
      profiles.save({ name: "Lab", destination: "lab" });
      profiles.importCredential("lab", TOKEN);
      const lease = await profiles.open("lab");
      const streams: Socket[] = [];
      tunnels[0]!.onStream = (stream) => streams.push(stream);
      const client = new DaemonClient(lease.url, lease.transport.fetch, {
        auth: lease.auth,
        requireAuthentication: true,
      });
      const call = client.call("runs.list", {}, z.unknown());
      // ssh dies once the request is on the wire, before any answer: the connection ends with it.
      await vi.waitFor(() => expect(daemon.rpc).toHaveLength(1));
      streams[0]!.destroy();
      await expect(call).rejects.toThrow();
      expect(tunnels[0]!.connects).toBe(1);
      expect(daemon.offered).toEqual([]);
      await lease.release();
    } finally {
      await daemon.close();
    }
  });

  it("refuses every connection after release, a profile change, or a tunnel failure, and reads stop", async () => {
    const daemon = await daemonRig();
    try {
      const { profiles, tunnels } = store(() => Promise.resolve(daemon.url), daemon.port);
      profiles.save({ name: "Lab", destination: "lab" });
      profiles.importCredential("lab", TOKEN);

      // Released: the transport has nothing to connect through.
      const first = await profiles.open("lab");
      const client = new DaemonClient(first.url, first.transport.fetch, { auth: first.auth });
      await first.release();
      expect(() => first.auth.read()).toThrow(CredentialTransportUnavailable);
      await expect(first.transport.fetch(`${first.url}/rpc`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
        CredentialTransportUnavailable,
      );
      await expect(client.hello("after-release")).rejects.toBeInstanceOf(CredentialTransportUnavailable);
      const closes = vi.fn();
      first.transport.socket(client.socketUrl, { onOpen: () => {}, onMessage: () => {}, onClose: closes }, ["orca.v1"]);
      await vi.waitFor(() => expect(closes).toHaveBeenCalled());
      expect(tunnels[0]!.connects).toBe(0);

      // Failed for good (say the host key changed): no reads, no connections.
      const second = await profiles.open("lab");
      tunnels[1]!.stateNow = { phase: "failed", refusal: "host-key-changed" };
      expect(() => second.auth.read()).toThrow(CredentialTransportUnavailable);
      await expect(second.transport.fetch(`${second.url}/rpc`, { method: "POST", body: "{}" })).rejects.toThrow();
      expect(tunnels[1]!.connects).toBe(0);

      // The pin reset that failure allows also ends the lease that predates it.
      profiles.forgetHostKey("lab");
      tunnels[1]!.stateNow = { phase: "open", localPort: 41000 };
      await expect(second.transport.fetch(`${second.url}/rpc`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
        CredentialTransportUnavailable,
      );
      expect(tunnels[1]!.connects).toBe(0);
      await second.release();
      expect(daemon.rpc).toEqual([]);
      expect(daemon.offered).toEqual([]);
    } finally {
      await daemon.close();
    }
  });
});

function lease(id: string, url: string, released: string[], refused = false): ProfileLease {
  const auth: DaemonTokenSource = { read: () => TOKEN, refresh: () => true };
  return {
    profile: { id, name: id.toUpperCase(), destination: `casey@${id}`, remotePort: 6722 },
    url,
    auth,
    remoteRefused: () => refused,
    transport: streamTransport(() => {
      throw new Error("workspace tests use their own fetch");
    }),
    release: vi.fn(async () => {
      released.push(id);
    }),
  };
}

function workspaceRig(options: { savedProfile?: string; fetcher?: typeof fetch; refused?: boolean } = {}) {
  const released: string[] = [];
  const opened: string[] = [];
  const auths: (DaemonTokenSource | undefined)[] = [];
  const stop = vi.fn(async () => {});
  const deps: WorkspaceDeps = {
    savedProfile: options.savedProfile,
    openProfile: async (id) => {
      if (id === "missing") throw new Error("That profile no longer exists.");
      opened.push(id);
      return lease(id, `http://127.0.0.1:${41000 + opened.length}`, released, options.refused);
    },
    defaultPath: () => "/workspace",
    defaultUrl: "http://localhost:6722",
    findEntry: () => "daemon.mjs",
    start: async () => ({ url: "http://localhost:8888", pid: 1, stop }),
    client: (url, clientOptions) => {
      auths.push(clientOptions.auth);
      return new DaemonClient(url, options.fetcher ?? (async () => reply(hello)));
    },
    subscribe: () =>
      new DaemonSubscription({
        url: "ws://localhost",
        params: {},
        onNotification: () => {},
        socket: () => ({ send: () => {}, close: () => {} }),
      }),
    onSwitch: vi.fn(),
    onSnapshot: vi.fn(),
    onDaemonGone: vi.fn(),
    onTarget: vi.fn(),
  };
  return { workspace: new Workspace(deps), deps, released, opened, auths, stop };
}

describe("profile connections", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts a saved profile's tunnel at launch, without a bundled daemon", async () => {
    const r = workspaceRig({ savedProfile: "lab" });
    await r.workspace.connect();
    expect(r.opened).toEqual(["lab"]);
    expect(r.stop).not.toHaveBeenCalled();
    expect(r.workspace.connectionTarget).toMatchObject({
      source: "saved",
      url: "http://127.0.0.1:41001",
      profile: { id: "lab", name: "LAB", destination: "casey@lab" },
    });
    expect(r.auths.at(-1)?.read()).toBe(TOKEN);
    await r.workspace.close();
    expect(r.released).toEqual(["lab"]);
  });

  it("a saved profile that cannot connect leaves the app disconnected with the reason, not on another daemon", async () => {
    const r = workspaceRig({ savedProfile: "missing" });
    await r.workspace.connect();
    expect(r.deps.onDaemonGone).toHaveBeenCalledWith(expect.stringContaining("no longer exists"));
    expect(r.workspace.connectionTarget).toMatchObject({ source: "saved", url: "" });
    expect(r.stop).not.toHaveBeenCalled();
    await r.workspace.close();
  });

  it("switches to a profile through the probe, then back to a URL, releasing each tunnel when it stops being current", async () => {
    const r = workspaceRig();
    await r.workspace.connect();
    const saved: unknown[] = [];
    const targets = new ConnectionTarget({
      prepare: (request, source) => r.workspace.prepareConnection(request, source),
      save: (request) => saved.push(request),
      guard: async () => true,
      release: () => {},
    });
    await targets.connect({ profile: "lab" });
    expect(saved).toEqual([{ profile: "lab" }]);
    expect(r.workspace.connectionTarget.profile?.id).toBe("lab");
    // Reconnecting to the same profile takes a new lease before the old one goes.
    await targets.connect({ profile: "lab" });
    expect(r.released).toEqual(["lab"]);
    await targets.connect("http://localhost:7000");
    expect(r.released).toEqual(["lab", "lab"]);
    expect(r.workspace.connectionTarget.profile).toBeUndefined();
    expect(saved.at(-1)).toBe("http://localhost:7000");
    await r.workspace.close();
  });

  it("keeps the current connection and closes the candidate tunnel when the probe fails", async () => {
    const r = workspaceRig({
      fetcher: async () =>
        new Response(
          JSON.stringify({ kind: "response", id: 1, ok: false, error: { code: "AUTH_INVALID", message: "x" } }),
        ),
    });
    await r.workspace.connect();
    const before = r.workspace.connectionTarget;
    const targets = new ConnectionTarget({
      prepare: (request, source) => r.workspace.prepareConnection(request, source),
      save: () => {
        throw new Error("must not save");
      },
      guard: async () => true,
      release: () => {},
    });
    const failure = await targets.connect({ profile: "lab" }).catch((error: unknown) => error);
    expect(connectionFailure(failure)).toContain("Import a new credential");
    expect(r.released).toEqual(["lab"]);
    expect(r.workspace.connectionTarget).toEqual(before);
    await r.workspace.close();
  });

  it("says when ssh works but no daemon listens on the server", async () => {
    const r = workspaceRig({ refused: true, fetcher: async () => Promise.reject(new TypeError("fetch failed")) });
    const targets = new ConnectionTarget({
      prepare: (request, source) => r.workspace.prepareConnection(request, source),
      save: () => {},
      guard: async () => true,
      release: () => {},
    });
    const failure = await targets.connect({ profile: "lab" }).catch((error: unknown) => error);
    expect(connectionFailure(failure)).toContain("no ORCA daemon is listening on its port 6722");
    expect(r.released).toEqual(["lab"]);
  });

  it("environment overrides still win over profiles", async () => {
    const targets = new ConnectionTarget({
      explicitUrl: "http://localhost:9",
      prepare: vi.fn(),
      save: vi.fn(),
      guard: async () => true,
      release: () => {},
    });
    await expect(targets.connect({ profile: "lab" })).rejects.toThrow("ORCA_DAEMON_URL");
  });
});

describe("saved profile preference", () => {
  it("is exclusive with a saved URL and survives a restart", () => {
    const file = new PreferencesFile(join(mkdtempSync(join(tmpdir(), "orca-prefs-")), "preferences.json"));
    file.saveDaemonUrl("http://localhost:2");
    file.saveDaemonProfile("other");
    file.saveDaemonProfile(null);
    expect(file.read()).not.toHaveProperty("daemonProfile");
    file.saveDaemonProfile("lab");
    expect(file.read()).toMatchObject({ daemonProfile: "lab" });
    expect(file.read().daemonUrl).toBeUndefined();
    file.write({ theme: "dark" });
    expect(file.read().daemonProfile).toBe("lab");
    file.saveDaemonUrl(null);
    expect(file.read().daemonProfile).toBeUndefined();
  });
});

describe("automatic sign-in (#875)", () => {
  const pin = (dir: string, id = "lab") => {
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", id), `orca-${id} ssh-ed25519 AAAA\n`);
  };

  it("issues a credential on the first connect, straight into the keychain slot", async () => {
    const { dir, profiles, server, tunnels } = store();
    profiles.save({ name: "Lab", destination: "casey@lab" });
    const lease = await profiles.open("lab");
    expect(server.commands).toHaveLength(1);
    const [command] = server.commands;
    expect(command!.slice(0, 3)).toEqual(["orca", "auth", "issue"]);
    expect(command![3]).toMatch(/^desktop-casey-s-pc-[a-z2-7]{16}$/);
    expect(command![4]).toBe("--preset");
    expect(command).toContain("client");
    expect(command!.slice(-3)).toEqual(["--label", "orca-app-lab", "--json"]);
    const expiresAt = command![command!.indexOf("--expires-at") + 1]!;
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(89 * 24 * 3600_000);
    const [id] = server.live();
    const token = server.credentials.get(id!)!.token;
    expect(lease.auth.read()).toBe(token);
    // The token is in the sealed slot only: not in the profile, the record or the view.
    const vault = join(dir, "credentials", "vault");
    for (const file of [
      "profiles.json",
      join("credentials", "lab.json"),
      ...readdirSync(vault).map((f) => join(vault, f)),
    ])
      expect(readFileSync(join(file.startsWith(dir) ? "" : dir, file), "utf8")).not.toContain(token);
    expect(JSON.parse(readFileSync(join(dir, "credentials", "lab.json"), "utf8"))).toMatchObject({
      current: { credentialId: id, workspaceId: server.workspaceId },
    });
    expect(profiles.list()[0]).toMatchObject({ hasCredential: true, credentialExpiresAt: expiresAt });
    expect(JSON.stringify(profiles.list())).not.toContain(token);
    await lease.release();
    // The next connect reuses it.
    await (await profiles.open("lab")).release();
    expect(server.commands).toHaveLength(1);
    expect(tunnels).toHaveLength(2);
  });

  it("uses the profile's server command, workspace config and read-only preset", async () => {
    const { profiles, server } = store();
    profiles.save({
      name: "Lab",
      destination: "lab",
      serverCommand: "/opt/orca/bin/orca",
      serverConfig: "/srv/orca/orca.config.yaml",
      readOnly: true,
    });
    expect(() => profiles.save({ name: "Bad", destination: "lab", serverCommand: "orca; rm -rf /" })).toThrow();
    expect(() => profiles.save({ name: "Bad", destination: "lab", serverConfig: "relative.yaml" })).toThrow();
    await (await profiles.open("lab")).release();
    const [command] = server.commands;
    expect(command![0]).toBe("/opt/orca/bin/orca");
    expect(command![command!.indexOf("--preset") + 1]).toBe("viewer");
    expect(command![command!.indexOf("--config") + 1]).toBe("/srv/orca/orca.config.yaml");
    expect(profiles.list()[0]).toMatchObject({ readOnly: true, serverCommand: "/opt/orca/bin/orca" });
  });

  it("issues one credential for concurrent first connects", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    const [a, b] = await Promise.all([profiles.open("lab"), profiles.open("lab")]);
    expect(server.commands.filter((c) => c[2] === "issue")).toHaveLength(1);
    expect(a.auth.read()).toBe(b.auth.read());
    await a.release();
    await b.release();
  });

  it("renews before expiry while connected, and leases move to the new credential", async () => {
    let now = Date.now();
    const { profiles, server } = store(undefined, undefined, {
      credentialPolicy: { ttlMs: 10_000, renewBeforeMs: 4_000, checkEveryMs: 20 },
      now: () => now,
    });
    profiles.save({ name: "Lab", destination: "lab" });
    const lease = await profiles.open("lab");
    const first = lease.auth.read();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.commands).toHaveLength(1);
    now += 7_000;
    // A new credential first, switched in once the daemon accepted it; then the old one revoked.
    await vi.waitFor(() => expect(server.commands.map((c) => c[2])).toEqual(["issue", "issue", "revoke"]));
    await vi.waitFor(() => expect(lease.auth.read()).not.toBe(first));
    expect(server.live()).toHaveLength(1);
    expect(server.credentials.get(server.live()[0]!)!.token).toBe(lease.auth.read());
    await lease.release();
    // Not connected: renewal waits for the next connect, which does it first.
    now += 7_000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.commands).toHaveLength(3);
    await (await profiles.open("lab")).release();
    expect(server.commands.map((c) => c[2])).toEqual(["issue", "issue", "revoke", "issue", "revoke"]);
    expect(server.live()).toHaveLength(1);
  });

  it("replaces a credential the daemon refuses once, then refuses clearly", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    await (await profiles.open("lab")).release();
    // Revoked on the server by hand: the next connect issues a new one.
    server.credentials.get(server.live()[0]!)!.revoked = true;
    const lease = await profiles.open("lab");
    // The refused one is revoked too, in case it was only expired: nothing stale stays live.
    expect(server.commands.map((c) => c[2])).toEqual(["issue", "issue", "revoke"]);
    expect(server.verdict(lease.auth.read()!)).toBe("accepted");
    await lease.release();

    // Refused again and no new one can be issued: one attempt, then a refusal with the remedy.
    server.credentials.get(server.live()[0]!)!.revoked = true;
    server.fail = { code: 1, lines: ["error: the credentials file cannot be read"] };
    await expect(profiles.open("lab")).rejects.toMatchObject({ code: "credential-refused" });
    expect(server.commands.filter((c) => c[2] === "issue")).toHaveLength(3);
  });

  it("takes back a credential the daemon on the port does not know: another workspace", async () => {
    const { profiles, server, tunnels } = store();
    server.otherWorkspace = true;
    profiles.save({ name: "Lab", destination: "lab" });
    await expect(profiles.open("lab")).rejects.toMatchObject({
      code: "wrong-workspace",
      message: expect.stringContaining("workspace config"),
    });
    expect(server.commands.map((c) => c[2])).toEqual(["issue", "revoke"]);
    expect(server.live()).toEqual([]);
    expect(profiles.list()[0]!.hasCredential).toBe(false);
    expect(tunnels[0]!.closed).toBe(1);
  });

  it("names what is wrong on the server, with the remedy, and never its output", async () => {
    const { profiles, server, tunnels } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    const cases: [number, string[], string, string][] = [
      [127, ["bash: line 1: orca: command not found"], "cli-missing", "Install ORCA there"],
      [1, ["'orca' is not recognized as an internal or external command"], "cli-missing", "full path"],
      [126, ["bash: line 1: /opt/orca: Permission denied"], "cli-permission", "may run"],
      [1, ["error [CONFIG_INVALID]: /srv/x.yaml: bad"], "server-not-set-up", "workspace config"],
      [1, ["error: ENOENT: no such file or directory, open '/srv/x.yaml'"], "server-not-set-up", "Set up the daemon"],
      [1, ["error: EACCES: permission denied, open '/srv/auth/credentials.json'"], "cli-permission", "SSH user"],
      [1, ["something else secret-ish"], "cli-failed", "auth list"],
    ];
    for (const [code, lines, refusal, remedy] of cases) {
      server.fail = { code, lines };
      const error = await profiles.open("lab").catch((e: unknown) => e as Error & { code: string });
      expect(error).toMatchObject({ code: refusal, message: expect.stringContaining(remedy) });
      expect((error as Error).message).not.toContain(lines[0]!);
    }
    // Output that is not ORCA's JSON is a failure too, never a stored token.
    server.fail = undefined;
    vi.spyOn(server, "run").mockReturnValueOnce({ code: 0, stdout: "orca_live_x", serverLines: [] });
    await expect(profiles.open("lab")).rejects.toMatchObject({ code: "cli-failed" });
    expect(profiles.list()[0]!.hasCredential).toBe(false);
    expect(tunnels.every((tunnel) => tunnel.closed === 1)).toBe(true);
  });

  it("revokes the server's credential when the profile is removed, and says when it could not", async () => {
    const { dir, profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    // Pinned when the credential is issued: it is bound to that key.
    pin(dir);
    await (await profiles.open("lab")).release();
    await expect(profiles.remove("lab")).resolves.toBe("revoked");
    expect(server.live()).toEqual([]);
    expect(server.commands.at(-1)!.slice(0, 3)).toEqual(["orca", "auth", "revoke"]);
    expect(existsSync(join(dir, "credentials", "lab.json"))).toBe(false);

    profiles.save({ name: "Lab", destination: "lab" });
    pin(dir);
    await (await profiles.open("lab")).release();
    server.fail = { code: 255, lines: [] };
    await expect(profiles.remove("lab")).resolves.toBe("not-reached");
    expect(profiles.list()).toEqual([]);

    // Never revoke through a server whose key is not pinned: that is not the server it was issued by.
    server.fail = undefined;
    profiles.save({ name: "Lab", destination: "lab" });
    await (await profiles.open("lab")).release();
    const before = server.commands.length;
    await expect(profiles.remove("lab")).resolves.toBe("not-reached");
    expect(server.commands).toHaveLength(before);
  });

  it("issues a new credential when the preset changes, and revokes the old one", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    await (await profiles.open("lab")).release();
    const [old] = server.live();
    expect(profiles.save({ id: "lab", name: "Lab", destination: "lab", readOnly: true }).hasCredential).toBe(false);
    await (await profiles.open("lab")).release();
    expect(server.commands.map((c) => c[2])).toEqual(["issue", "issue", "revoke"]);
    expect(server.commands[1]).toContain("viewer");
    expect(server.live()).not.toContain(old);
    expect(server.live()).toHaveLength(1);
  });

  it("keeps an imported credential the daemon accepts, and never renews it", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    profiles.importCredential("lab", TOKEN);
    expect(profiles.list()[0]).toMatchObject({ credentialImported: true });
    await (await profiles.open("lab")).release();
    expect(server.commands).toEqual([]);
  });
});

describe("automatic sign-in keeps every credential accounted for (#875 review)", () => {
  const pin = (dir: string) => {
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "orca-lab ssh-ed25519 AAAA\n");
  };
  const subs = (server: FakeServer) => server.commands.map((c) => c[2]);

  it("stages a credential until the daemon confirms it, then switches without issuing again", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    server.silent = true;
    await (await profiles.open("lab")).release();
    expect(profiles.list()[0]!.hasCredential).toBe(false);
    server.silent = false;
    const lease = await profiles.open("lab");
    expect(subs(server)).toEqual(["issue"]);
    expect(server.verdict(lease.auth.read()!)).toBe("accepted");
    await lease.release();

    // A renewal the daemon cannot confirm keeps the current credential in use.
    let now = Date.now() + 80 * 24 * 3600_000;
    const later = store(undefined, undefined, { now: () => now });
    later.profiles.save({ name: "Lab", destination: "lab" });
    now = Date.now();
    const first = await later.profiles.open("lab");
    const token = first.auth.read();
    await first.release();
    now += 80 * 24 * 3600_000;
    later.server.silent = true;
    const renewing = await later.profiles.open("lab");
    expect(renewing.auth.read()).toBe(token);
    await renewing.release();
    expect(subs(later.server)).toEqual(["issue", "issue"]);
    later.server.silent = false;
    const settled = await later.profiles.open("lab");
    expect(settled.auth.read()).not.toBe(token);
    expect(subs(later.server)).toEqual(["issue", "issue", "revoke"]);
    await settled.release();
  });

  it("never uses or loses a credential the keychain could not keep", async () => {
    let broken = false;
    const failing: SecretCipher = {
      ...cipher,
      encryptString: (value) => {
        if (broken) throw new Error("keychain locked");
        return cipher.encryptString(value);
      },
    };
    const { profiles, server } = store(undefined, undefined, { cipher: failing });
    profiles.save({ name: "Lab", destination: "lab" });
    broken = true;
    await expect(profiles.open("lab")).rejects.toMatchObject({ code: "store-failed" });
    // Taken back on the server at once: nothing live that nobody holds.
    expect(subs(server)).toEqual(["issue", "revoke"]);
    expect(server.live()).toEqual([]);
    broken = false;
    await (await profiles.open("lab")).release();
    expect(server.live()).toHaveLength(1);
  });

  it("revokes a credential where it was issued after the workspace config changes", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab", serverConfig: "/srv/a/orca.config.yaml" });
    await (await profiles.open("lab")).release();
    const [old] = server.live();
    expect(
      profiles.save({ id: "lab", name: "Lab", destination: "lab", serverConfig: "/srv/b/orca.config.yaml" }),
    ).toMatchObject({ hasCredential: false, pendingRevocations: 1 });
    await (await profiles.open("lab")).release();
    const revoke = server.commands.find((c) => c[2] === "revoke")!;
    expect(revoke[3]).toBe(old);
    expect(revoke[revoke.indexOf("--config") + 1]).toBe("/srv/a/orca.config.yaml");
    expect(server.commands[1]![server.commands[1]!.indexOf("--config") + 1]).toBe("/srv/b/orca.config.yaml");
    expect(profiles.list()[0]).not.toHaveProperty("pendingRevocations");
  });

  it("keeps a credential from another server on the list, and says so on removal", async () => {
    const { dir, profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    await (await profiles.open("lab")).release();
    profiles.save({ id: "lab", name: "Lab", destination: "other" });
    expect(profiles.list()[0]).toMatchObject({ hasCredential: false, pendingRevocations: 1 });
    await (await profiles.open("lab")).release();
    // Never sent to the new server: it was not issued there.
    expect(subs(server)).toEqual(["issue", "issue"]);
    expect(profiles.list()[0]).toMatchObject({ pendingRevocations: 1 });
    pin(dir);
    await expect(profiles.remove("lab")).resolves.toBe("not-reached");
  });

  it("never replaces an imported credential, and keeps revoking what ORCA issued before it", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    await (await profiles.open("lab")).release();
    const [issued] = server.live();
    profiles.importCredential("lab", TOKEN);
    expect(profiles.list()[0]).toMatchObject({ credentialImported: true, pendingRevocations: 1 });
    const lease = await profiles.open("lab");
    expect(lease.auth.read()).toBe(TOKEN);
    await lease.release();
    expect(server.credentials.get(issued!)!.revoked).toBe(true);

    server.accepted.clear();
    await expect(profiles.open("lab")).rejects.toMatchObject({
      code: "imported-refused",
      message: expect.stringContaining("Use automatic sign-in"),
    });
    expect(subs(server)).toEqual(["issue", "revoke"]);
    profiles.useAutomaticSignIn("lab");
    await (await profiles.open("lab")).release();
    expect(subs(server)).toEqual(["issue", "revoke", "issue"]);
    expect(profiles.list()[0]).not.toHaveProperty("credentialImported");
  });

  it("refuses edits, imports, resets and connects while a removal is revoking", async () => {
    const { dir, profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    pin(dir);
    await (await profiles.open("lab")).release();
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    const removing = profiles.remove("lab");
    expect(() => profiles.save({ id: "lab", name: "Lab", destination: "elsewhere" })).toThrow("being removed");
    expect(() => profiles.importCredential("lab", TOKEN)).toThrow("being removed");
    expect(() => profiles.forgetHostKey("lab")).toThrow("being removed");
    expect(() => profiles.useAutomaticSignIn("lab")).toThrow("being removed");
    await expect(profiles.open("lab")).rejects.toThrow("being removed");
    await expect(profiles.remove("lab")).rejects.toThrow("being removed");
    release();
    await expect(removing).resolves.toBe("revoked");
    expect(server.live()).toEqual([]);
  });

  it("takes back a credential issued for another principal, and never stores it", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    const real = server.run.bind(server);
    vi.spyOn(server, "run").mockImplementation((command) => {
      const result = real(command);
      if (command[2] !== "issue") return result;
      const parsed = JSON.parse(result.stdout) as { token: string; credential: { id: string; principal: string } };
      return {
        ...result,
        stdout: JSON.stringify({ ...parsed, credential: { ...parsed.credential, principal: "root" } }),
      };
    });
    await expect(profiles.open("lab")).rejects.toMatchObject({ code: "cli-failed" });
    expect(subs(server)).toEqual(["issue", "revoke"]);
    expect(server.live()).toEqual([]);
    expect(profiles.list()[0]!.hasCredential).toBe(false);
  });
});

describe("credentials are bound to the server's keys and this installation (#875 review 2)", () => {
  const pinKey = (dir: string, key: string) => {
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), `orca-lab ssh-ed25519 ${key}\n`);
  };
  const subs = (server: FakeServer) => server.commands.map((c) => c[2]);

  it("quarantines credentials on a pin reset: never sent under the new key, revoked only under the old", async () => {
    const { dir, profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    pinKey(dir, "AAAAoldkey");
    const lease = await profiles.open("lab");
    const old = lease.auth.read()!;
    await lease.release();

    profiles.forgetHostKey("lab");
    expect(profiles.list()[0]).toMatchObject({ hasCredential: false, pendingRevocations: 1 });
    // Another key answers now: a new credential, and the old token goes nowhere near it.
    pinKey(dir, "AAAAnewkey");
    const fresh = await profiles.open("lab");
    expect(fresh.auth.read()).not.toBe(old);
    await fresh.release();
    expect(subs(server)).toEqual(["issue", "issue"]);
    expect(profiles.list()[0]).toMatchObject({ pendingRevocations: 1 });

    // A pin that changed underneath (not through a reset) quarantines just the same.
    pinKey(dir, "AAAAthirdkey");
    await (await profiles.open("lab")).release();
    expect(subs(server)).toEqual(["issue", "issue", "issue"]);
    expect(profiles.list()[0]).toMatchObject({ pendingRevocations: 2 });
  });

  it("asks for an imported credential again after its server's key was reset", async () => {
    const { dir, profiles } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    pinKey(dir, "AAAAoldkey");
    profiles.importCredential("lab", TOKEN);
    await (await profiles.open("lab")).release();
    profiles.forgetHostKey("lab");
    expect(profiles.list()[0]).toMatchObject({ hasCredential: true, credentialImported: true });
    pinKey(dir, "AAAAnewkey");
    await expect(profiles.open("lab")).rejects.toMatchObject({ code: "imported-reauthorize" });
    // Importing it again is the person's authorization for the new key.
    profiles.importCredential("lab", TOKEN);
    const lease = await profiles.open("lab");
    expect(lease.auth.read()).toBe(TOKEN);
    await lease.release();
    // And a key that changes under the import without a reset is refused too.
    pinKey(dir, "AAAAthirdkey");
    await expect(profiles.open("lab")).rejects.toMatchObject({ code: "imported-reauthorize" });
  });

  it("switches in a credential only when the daemon names its workspace", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    server.anonymous = true;
    await expect(profiles.open("lab")).rejects.toMatchObject({ code: "unverified" });
    // Taken back, nothing in the slot.
    expect(subs(server)).toEqual(["issue", "revoke"]);
    expect(server.live()).toEqual([]);
    expect(profiles.list()[0]!.hasCredential).toBe(false);

    // Bound to a workspace, a credential is refused by a daemon that no longer names one.
    server.anonymous = false;
    await (await profiles.open("lab")).release();
    server.anonymous = true;
    await expect(profiles.open("lab")).rejects.toMatchObject({ code: "unverified" });
  });

  it("names each installation in its principal, even on machines with the same name", async () => {
    const a = store();
    const b = store();
    for (const { profiles } of [a, b]) {
      profiles.save({ name: "Lab", destination: "lab" });
      await (await profiles.open("lab")).release();
    }
    const principal = (server: FakeServer) => server.commands[0]![3]!;
    expect(principal(a.server)).toMatch(/^desktop-casey-s-pc-[a-z2-7]{16}$/);
    expect(principal(b.server)).toMatch(/^desktop-casey-s-pc-[a-z2-7]{16}$/);
    expect(principal(a.server)).not.toBe(principal(b.server));
    // Durable: the same installation keeps its id across restarts.
    expect(installationId(a.dir)).toBe(principal(a.server).slice(-16));
    expect(installationId(a.dir)).toBe(installationId(a.dir));
    // Within the daemon's principal rules, whatever the host name.
    const long = principalFor("A".repeat(200) + ".example.com", installationId(a.dir));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/);
    expect(principalFor("---", installationId(a.dir))).toMatch(/^desktop-computer-/);
    expect(() => principalFor("pc", "short")).toThrow();
  });
});

describe("a credential changes role only in one record commit (#875 review 3)", () => {
  /** A store whose record writes can be interrupted, and a restart of it on the same files. */
  function interruptible() {
    let interrupt: ((record: CredentialRecord) => boolean) | undefined;
    const made = store(undefined, undefined, {
      beforeRecordWrite: (_id, record) => {
        if (interrupt?.(record)) throw new Error("interrupted");
      },
    });
    const restart = () =>
      new RemoteProfiles({
        dir: made.dir,
        cipher,
        hostname: "Casey's PC",
        tunnel: (options) =>
          new FakeTunnel(
            options,
            Promise.resolve("http://127.0.0.1:41000"),
            undefined,
            made.server,
          ) as unknown as SshTunnel,
        verify: async (_connect, _url, token) => made.server.answer(token),
      });
    return { ...made, restart, interruptWhen: (when?: (record: CredentialRecord) => boolean) => (interrupt = when) };
  }
  const vaultFiles = (dir: string) => readdirSync(join(dir, "credentials", "vault")).sort();

  it("an interrupted import leaves the managed credential as it was, and a manual one is never managed", async () => {
    const { dir, profiles, server, restart, interruptWhen } = interruptible();
    profiles.save({ name: "Lab", destination: "lab" });
    const lease = await profiles.open("lab");
    const managed = lease.auth.read();
    await lease.release();
    const before = vaultFiles(dir);

    interruptWhen((record) => record.imported !== undefined);
    expect(() => profiles.importCredential("lab", TOKEN)).toThrow("could not be stored");
    interruptWhen(undefined);
    // After a restart: the same managed credential, its record, and no stray slot.
    const again = restart();
    expect(again.list()[0]).toMatchObject({ hasCredential: true });
    expect(again.list()[0]).not.toHaveProperty("credentialImported");
    expect(vaultFiles(dir)).toEqual(before);
    const kept = await again.open("lab");
    expect(kept.auth.read()).toBe(managed);
    await kept.release();

    // Committed: the import is the person's, after any restart, and ORCA never manages it.
    again.importCredential("lab", TOKEN);
    const third = restart();
    expect(third.list()[0]).toMatchObject({ credentialImported: true, pendingRevocations: 1 });
    const imported = await third.open("lab");
    expect(imported.auth.read()).toBe(TOKEN);
    await imported.release();
    expect(server.commands.filter((c) => c[2] === "issue")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "credentials", "lab.json"), "utf8"))).not.toHaveProperty("current");
  });

  it("an interrupted promotion keeps the previous credential current and the new one only staged", async () => {
    let now = Date.now();
    const { dir, profiles, server, restart, interruptWhen } = interruptible();
    profiles.save({ name: "Lab", destination: "lab" });
    const opened = await profiles.open("lab");
    const first = opened.auth.read();
    await opened.release();
    const firstId = server.live()[0]!;

    // Renewal due; the commit that would make the new one current is interrupted.
    (profiles as unknown as { deps: { now: () => number } }).deps.now = () => now;
    now += 80 * 24 * 3600_000;
    interruptWhen((record) => record.current !== undefined && record.current.credentialId !== firstId);
    const during = await profiles.open("lab");
    expect(during.auth.read()).toBe(first);
    await during.release();
    interruptWhen(undefined);
    // The old one is still live on the server and current; the new one staged, never used.
    expect(server.live()).toContain(firstId);
    const record = JSON.parse(readFileSync(join(dir, "credentials", "lab.json"), "utf8")) as CredentialRecord;
    expect(record.current?.credentialId).toBe(firstId);
    expect(record.next).toBeDefined();
    expect(vaultFiles(dir)).toHaveLength(2);

    // After a restart the staged one is settled: switched in, then the old one revoked.
    const again = restart();
    const settled = await again.open("lab");
    expect(settled.auth.read()).not.toBe(first);
    await settled.release();
    expect(server.live()).not.toContain(firstId);
    expect(server.commands.filter((c) => c[2] === "issue")).toHaveLength(2);
    expect(vaultFiles(dir)).toHaveLength(1);
  });

  it("an interrupted first sign-in leaves nothing current, and the next connect finishes it", async () => {
    const { profiles, server, restart, interruptWhen } = interruptible();
    profiles.save({ name: "Lab", destination: "lab" });
    interruptWhen((record) => record.current !== undefined);
    await expect(profiles.open("lab")).rejects.toMatchObject({ code: "store-failed" });
    interruptWhen(undefined);
    const again = restart();
    expect(again.list()[0]!.hasCredential).toBe(false);
    await (await again.open("lab")).release();
    expect(server.commands.map((c) => c[2])).toEqual(["issue"]);
    expect(again.list()[0]!.hasCredential).toBe(true);
  });

  it("moves a credential imported before automatic sign-in into its own slot, as an import", () => {
    const { dir, profiles } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    new CredentialSlots(join(dir, "credentials"), cipher).write("lab", TOKEN);
    expect(profiles.list()[0]).toMatchObject({ hasCredential: true, credentialImported: true });
    expect(existsSync(join(dir, "credentials", "lab.credential"))).toBe(false);
    expect(readdirSync(join(dir, "credentials", "vault"))).toHaveLength(1);
  });
});
