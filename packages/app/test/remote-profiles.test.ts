/**
 * SSH connection profiles (#874): the profile store, and profile connections through the
 * Workspace and ConnectionTarget transaction. Tunnels are fakes here; the protocol package's
 * remote-access tests run the real ssh against a real sshd.
 */
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import {
  CredentialSlots,
  pinState,
  tunnelKeyIdentity,
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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { DaemonClient } from "../src/client/daemon-client.js";
import { CredentialTransportUnavailable, type DaemonTokenSource } from "../src/client/auth.js";
import { DaemonSubscription } from "../src/client/subscription.js";
import { ConnectionTarget, connectionFailure } from "../src/main/connection-target.js";
import { installationId, principalFor, revokeCommand, type CredentialRecord } from "../src/main/remote-credentials.js";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
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
  /** Standard input each command was given (the server setup's program, #881). */
  readonly inputs: string[] = [];
  /** What `python3 -` (the server setup, #881) prints and exits with. */
  setup: RemoteResult = {
    code: 0,
    stdout: [
      "Staging v0.8.0 (noise the app never reads)",
      'orca-setup: {"detail": "", "result": "ok", "step": "platform"}',
      'orca-setup: {"detail": "v0.8.0 staged from the signed bundle", "result": "changed", "step": "stage"}',
      'orca-setup: {"detail": "could not enable lingering", "result": "warning", "step": "linger"}',
      'orca-setup: {"account": "casey", "command": "/home/casey/.local/share/orca-server/orca", "done": true, "port": 6722, "root": "/home/casey/.local/share/orca-server", "version": "0.8.0"}',
    ].join("\n"),
    serverLines: [],
  };
  /** What `python3 - --inspect` (the read-only check before a setup, #881) prints. */
  inspect: RemoteResult = {
    code: 0,
    stdout: [
      'orca-setup: {"detail": "", "result": "ok", "step": "platform"}',
      'orca-setup: {"account": "casey", "current": null, "inspected": true, "root": "/home/casey/.local/share/orca-server"}',
    ].join("\n"),
    serverLines: [],
  };
  run(command: readonly string[]): RemoteResult {
    this.commands.push([...command]);
    if (command[0] === "python3") return command.includes("--inspect") ? this.inspect : this.setup;
    if (this.fail) return { code: this.fail.code, stdout: "", serverLines: this.fail.lines };
    const words = [...command];
    const flag = (name: string) => {
      const at = words.indexOf(name);
      return at < 0 ? undefined : words[at + 1];
    };
    const [, , sub] = words;
    // The subject: after `--` when there is one (a revoke), else the word after the subcommand.
    const subject = words.includes("--") ? words[words.indexOf("--") + 1] : words[3];
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
  hostKeyFingerprint = "SHA256:fakeHostKey";
  readonly ran: (readonly string[])[] = [];
  execStreaming(command: readonly string[]): { exit: Promise<{ kind: "exited"; code: number }>; kill(): void } {
    this.ran.push(command);
    return { exit: Promise.resolve({ kind: "exited", code: 0 }), kill: () => undefined };
  }
  refused = false;
  connects = 0;
  onStream?: (stream: Socket) => void;
  stateNow: TunnelState = { phase: "starting" };
  /** Like the real one: the keys of the pins it sealed once open (or for one command). */
  pinnedKeys: string | undefined;
  constructor(
    readonly options: SshTunnelOptions,
    private readonly outcome: Promise<string>,
    /** Where an authenticated stream ends up: the stand-in daemon's port. */
    private readonly daemonPort?: number,
    private readonly server = new FakeServer(),
  ) {}
  async exec(command: readonly string[], _timeoutMs?: number, input?: string): Promise<RemoteResult> {
    await Promise.resolve();
    await this.server.gate;
    if (input !== undefined) this.server.inputs.push(input);
    return this.server.run(command);
  }
  async runOnce(command: readonly string[]): Promise<RemoteResult> {
    // Like the real one: an administrative connection never trusts a key on first use, and
    // carries nothing unless its pins vouch for the keys expected.
    if (pinState(this.options.knownHostsFile) !== "pinned") throw new TunnelRefusal("host-key-missing");
    this.seal();
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
        // ssh's accept-new on first use: the probe pins the server's key.
        const pins = this.options.knownHostsFile;
        if (pinState(pins) === "none") {
          if (this.options.pinnedOnly) throw new TunnelRefusal("host-key-missing");
          mkdirSync(dirname(pins), { recursive: true });
          writeFileSync(pins, "orca-lab ssh-ed25519 AAAAFIRSTUSE\n");
        }
        this.seal();
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
  private seal(): void {
    const keys = tunnelKeyIdentity(this.options.knownHostsFile, this.options.profile.jump !== undefined);
    if (this.options.expectKeys !== undefined && keys !== this.options.expectKeys)
      throw new TunnelRefusal("host-key-changed");
    this.pinnedKeys = keys;
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

  it("keeps an approved server updater per profile until it points elsewhere, its key is reset or it is removed (#879)", async () => {
    const { dir, profiles } = store();
    const updater = {
      adapter: "/opt/orca/orca-release.py",
      manifest: "/etc/orca/deployment.json",
      hostKey: "SHA256:abc",
      workspaceId: "9b2b3c5e-3c0e-4f6a-9a59-6c1b8e6f0a11",
    };
    expect(() => profiles.approveServerUpdater("lab", updater)).toThrow("no longer exists");
    profiles.save({ name: "Lab", destination: "lab" });
    expect(profiles.serverUpdater("lab")).toBeUndefined();
    expect(() => profiles.approveServerUpdater("lab", { ...updater, adapter: "relative.py" })).toThrow();
    expect(() => profiles.approveServerUpdater("lab", { ...updater, hostKey: "abc" })).toThrow();
    profiles.approveServerUpdater("lab", updater);
    expect(profiles.serverUpdater("lab")).toEqual(updater);
    // Not part of the profile the renderer sees or edits.
    expect(JSON.stringify(profiles.list())).not.toContain("orca-release");
    profiles.save({ id: "lab", name: "Lab 2", destination: "lab" });
    expect(profiles.serverUpdater("lab")).toEqual(updater);
    profiles.forgetHostKey("lab");
    expect(profiles.serverUpdater("lab")).toBeUndefined();
    profiles.approveServerUpdater("lab", updater);
    profiles.save({ id: "lab", name: "Lab 2", destination: "other" });
    expect(profiles.serverUpdater("lab")).toBeUndefined();
    profiles.approveServerUpdater("lab", updater);
    await profiles.remove("lab");
    profiles.save({ name: "Lab", destination: "lab" });
    expect(profiles.serverUpdater("lab")).toBeUndefined();
    // An unreadable approvals file approves nothing.
    writeFileSync(join(dir, "server-updaters.json"), "{not json");
    expect(profiles.serverUpdater("lab")).toBeUndefined();
  });

  it("keeps a lease's sealed pins across host-key observations, and a pin replacement changes them", async () => {
    const { dir, profiles, tunnels } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    profiles.importCredential("lab", TOKEN);
    const a = await profiles.open("lab");
    const sealed = a.pinnedKeys();
    expect(sealed).toBe(tunnels[0]!.pinnedKeys);
    expect(sealed).toBeDefined();
    // Another stream's ssh output updates the last-observed key; the sealed pins do not move.
    tunnels[0]!.hostKeyFingerprint = "SHA256:observedOnAnotherStream";
    expect(a.hostKey()).toBe("SHA256:observedOnAnotherStream");
    expect(a.pinnedKeys()).toBe(sealed);
    // A tunnel resealed under other pins no longer vouches for this lease.
    tunnels[0]!.pinnedKeys = "resealed";
    expect(a.pinnedKeys()).toBeUndefined();
    tunnels[0]!.pinnedKeys = sealed;
    await a.release();
    expect(a.pinnedKeys()).toBeUndefined();

    // A real pin replacement: forget the key and pin the one the server presents now.
    profiles.forgetHostKey("lab");
    writeFileSync(join(dir, "known_hosts", "lab"), "orca-lab ssh-ed25519 AAAAREPLACEDKEY\n");
    profiles.importCredential("lab", TOKEN);
    const b = await profiles.open("lab");
    expect(b.pinnedKeys()).toBeDefined();
    expect(b.pinnedKeys()).not.toBe(sealed);
    await b.release();
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
    expect(a.hostKey()).toBe("SHA256:fakeHostKey");
    a.exec(["true"], () => {});
    expect(tunnels[0]!.ran).toEqual([["true"]]);
    await expect(profiles.remove("lab")).rejects.toThrow("Connect to another daemon");
    expect(() => profiles.save({ id: "lab", name: "Lab", destination: "x" })).toThrow("Connect to another daemon");
    await a.release();
    await a.release();
    // A released lease runs nothing, even while the shared tunnel stays open for `b`.
    expect(() => a.exec(["true"], () => {})).toThrow(expect.objectContaining({ code: "closed" }));
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

  it("raises the revision a watcher keys on for every change, a credential import included (#882)", () => {
    const { profiles } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    const seen = [profiles.revisionOf("lab")];
    for (const change of [
      () => profiles.importCredential("lab", TOKEN),
      () => profiles.save({ id: "lab", name: "Lab", destination: "lab" }),
      () => profiles.forgetHostKey("lab"),
      () => profiles.importCredential("lab", TOKEN),
      () => profiles.useAutomaticSignIn("lab"),
    ]) {
      change();
      seen.push(profiles.revisionOf("lab"));
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!);
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
  async function daemonRig(
    stall = false,
    accept: (authorization: string | undefined) => boolean = () => true,
    /** Who the daemon authenticated: answers `operator.discover` for that principal. */
    principalOf: (authorization: string | undefined) => string | undefined = () => undefined,
  ) {
    const rpc: (string | undefined)[] = [];
    const sockets: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      rpc.push(request.headers.authorization);
      const body: Buffer[] = [];
      request.on("data", (chunk: Buffer) => body.push(chunk));
      request.on("end", () => {
        if (stall) return;
        if (!accept(request.headers.authorization)) {
          response.writeHead(401);
          response.end(
            JSON.stringify({ kind: "response", id: 1, ok: false, error: { code: "AUTH_INVALID", message: "no" } }),
          );
          return;
        }
        let method: string | undefined;
        try {
          method = (JSON.parse(Buffer.concat(body).toString()) as { method?: string }).method;
        } catch {
          method = undefined;
        }
        const principal = principalOf(request.headers.authorization);
        if (method === "operator.discover" && principal) {
          response.end(
            JSON.stringify({
              kind: "response",
              id: 1,
              ok: true,
              result: {
                target: hello.identity,
                protocol: PROTOCOL_VERSION,
                orcaVersion: "test",
                principalId: principal,
                authentication: "credential",
                scope: { runs: "owned", workflows: "*", permissions: [] },
                operations: [],
                collections: [],
                asOf: new Date().toISOString(),
              },
            }),
          );
          return;
        }
        const methods = principal ? ["hello", "operator.discover"] : ["hello"];
        response.end(JSON.stringify({ kind: "response", id: 1, ok: true, result: { ...hello, methods } }));
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
    let issuedTo: (token: string) => string | undefined = () => undefined;
    const daemon = await daemonRig(
      false,
      (authorization) => authorization === `Bearer ${known}`,
      (authorization) => (authorization === `Bearer ${known}` && known ? issuedTo(known) : undefined),
    );
    try {
      // The daemon's own check (hello, then credential-authenticated discovery), not the seam.
      const { profiles, server } = store(() => Promise.resolve(daemon.url), daemon.port, { verify: helloVerdict });
      issuedTo = (token) => [...server.credentials.values()].find((c) => c.token === token)?.principal;
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

  it("never confirms a credential on a daemon that ignores it (open loopback), and takes it back (#875 review 4)", async () => {
    // Answers hello, naming its workspace, whatever the token: no credential-authenticated discovery.
    const daemon = await daemonRig();
    try {
      const { profiles, server } = store(() => Promise.resolve(daemon.url), daemon.port, { verify: helloVerdict });
      profiles.save({ name: "Lab", destination: "lab" });
      await expect(profiles.open("lab")).rejects.toMatchObject({ code: "unverified" });
      expect(daemon.rpc.length).toBeGreaterThan(0);
      expect(server.live()).toEqual([]);
      expect(profiles.list()[0]!.hasCredential).toBe(false);
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

/** What a fake lease's tunnel reports: the last-observed host key and the pins it sealed. */
interface LeaseKeys {
  observed?: string;
  pins?: string;
}

function lease(id: string, url: string, released: string[], refused = false, keys: LeaseKeys = {}): ProfileLease {
  const auth: DaemonTokenSource = { read: () => TOKEN, refresh: () => true };
  return {
    profile: { id, name: id.toUpperCase(), destination: `casey@${id}`, remotePort: 6722 },
    url,
    auth,
    remoteRefused: () => refused,
    exec: () => {
      throw new Error("workspace tests run nothing on the server");
    },
    hostKey: () => keys.observed,
    pinnedKeys: () => keys.pins,
    transport: streamTransport(() => {
      throw new Error("workspace tests use their own fetch");
    }),
    release: vi.fn(async () => {
      released.push(id);
    }),
  };
}

function workspaceRig(
  options: { savedProfile?: string; fetcher?: typeof fetch; refused?: boolean; keys?: LeaseKeys } = {},
) {
  const released: string[] = [];
  const opened: string[] = [];
  const auths: (DaemonTokenSource | undefined)[] = [];
  const stop = vi.fn(async () => {});
  const deps: WorkspaceDeps = {
    savedProfile: options.savedProfile,
    openProfile: async (id) => {
      if (id === "missing") throw new Error("That profile no longer exists.");
      opened.push(id);
      return lease(id, `http://127.0.0.1:${41000 + opened.length}`, released, options.refused, options.keys);
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

  it("names a profile connection's recovery endpoint by its sealed pins, not the last-observed key (#357)", async () => {
    const keys: LeaseKeys = { observed: "SHA256:first", pins: "pins-v1" };
    const r = workspaceRig({ savedProfile: "lab", keys });
    await r.workspace.connect();
    const endpoint = r.workspace.profileEndpoint;
    expect(endpoint).toMatchObject({ id: "lab", remotePort: 6722, pins: "pins-v1" });
    // Another stream observing a key changes nothing the journal looks up by.
    keys.observed = "SHA256:observedLater";
    expect(r.workspace.profileEndpoint).toEqual(endpoint);
    // A real pin replacement does, and a lease whose pins no longer hold has no endpoint.
    keys.pins = "pins-v2";
    expect(r.workspace.profileEndpoint).toEqual({ ...endpoint, pins: "pins-v2" });
    delete keys.pins;
    expect(r.workspace.profileEndpoint).toBeUndefined();
    await r.workspace.close();
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

describe("watched profiles preference (#882)", () => {
  it("is main-only, survives a renderer patch and a focus change, and refuses junk", () => {
    const file = new PreferencesFile(join(mkdtempSync(join(tmpdir(), "orca-prefs-")), "preferences.json"));
    file.saveWatchedProfiles(["lab", "build-box", "lab"]);
    expect(file.read().watchedProfiles).toEqual(["lab", "build-box"]);
    // A renderer patch cannot name it, and writing anything else keeps it.
    file.write({ theme: "dark", watchedProfiles: ["evil"] });
    expect(file.read().watchedProfiles).toEqual(["lab", "build-box"]);
    // Focusing a profile is a separate choice from watching one.
    file.saveDaemonProfile("lab");
    expect(file.read().watchedProfiles).toEqual(["lab", "build-box"]);
    expect(() => file.saveWatchedProfiles(["../etc"])).toThrow();
    file.saveWatchedProfiles([]);
    expect(file.read()).not.toHaveProperty("watchedProfiles");
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
    expect(command!.slice(0, 3)).toEqual(["orca-cli", "auth", "issue"]);
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
      [127, ["bash: line 1: orca-cli: command not found"], "cli-missing", "Install ORCA there"],
      [1, ["'orca-cli' is not recognized as an internal or external command"], "cli-missing", "full path"],
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
    expect(server.commands.at(-1)!.slice(0, 3)).toEqual(["orca-cli", "auth", "revoke"]);
    expect(existsSync(join(dir, "credentials", "lab.json"))).toBe(false);

    profiles.save({ name: "Lab", destination: "lab" });
    pin(dir);
    await (await profiles.open("lab")).release();
    server.fail = { code: 255, lines: [] };
    await expect(profiles.remove("lab")).resolves.toBe("not-reached");
    expect(profiles.list()).toEqual([]);

    // Never revoke through a server whose pins now vouch for another key than the one the
    // credential was issued through: that is not the server it was issued by.
    server.fail = undefined;
    profiles.save({ name: "Lab", destination: "lab" });
    await (await profiles.open("lab")).release();
    writeFileSync(join(dir, "known_hosts", "lab"), "orca-lab ssh-ed25519 AAAAANOTHERKEY\n");
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
    expect(revoke.at(-1)).toBe(old);
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

describe("credentials travel only through verified keys, and no slot is swept on doubt (#875 review 4)", () => {
  const recordFile = (dir: string) => join(dir, "credentials", "lab.json");

  it("a lease sends its credential only on streams sealed with the keys the credential is bound to", async () => {
    const { dir, profiles, tunnels } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    const lease = await profiles.open("lab");
    const tunnel = tunnels.at(-1)!;
    expect(lease.auth.read()).toMatch(/^orca1\./);
    const record = JSON.parse(readFileSync(recordFile(dir), "utf8")) as CredentialRecord;
    expect(record.current!.target.hostKeys).toBe(tunnel.pinnedKeys);

    // The record now binds the credential to other keys than this tunnel sealed: not sent.
    writeFileSync(
      recordFile(dir),
      JSON.stringify({
        ...record,
        current: { ...record.current!, target: { ...record.current!.target, hostKeys: "[]" } },
      }),
    );
    lease.auth.refresh();
    expect(() => lease.auth.read()).toThrow(CredentialTransportUnavailable);
    writeFileSync(recordFile(dir), JSON.stringify(record));
    lease.auth.refresh();
    expect(lease.auth.read()).toMatch(/^orca1\./);

    // A stream that would not be verified against the keys the lease was set up through: none.
    tunnel.pinnedKeys = JSON.stringify(["ssh-ed25519 AAAAOTHER", null]);
    const connect = vi.spyOn(tunnel, "connect");
    await expect(lease.transport.fetch("http://127.0.0.1:41000/rpc", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    await lease.release();
  });

  it("promotes a staged credential only while the pins still vouch for the keys it was confirmed through", async () => {
    let swap = false;
    const made = store(undefined, undefined, {
      verify: async (_connect, _url, token) => {
        // The pin is replaced while the daemon is being asked.
        if (swap) writeFileSync(join(made.dir, "known_hosts", "lab"), "orca-lab ssh-ed25519 AAAASWAPPED\n");
        return made.server.answer(token);
      },
    });
    const { dir, profiles, server } = made;
    profiles.save({ name: "Lab", destination: "lab" });
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "orca-lab ssh-ed25519 AAAA\n");
    swap = true;
    const lease = await profiles.open("lab");
    // Confirmed, but not promoted: still staged, nothing current, nothing sent.
    expect(lease.auth.read()).toBeUndefined();
    const record = JSON.parse(readFileSync(recordFile(dir), "utf8")) as CredentialRecord;
    expect(record.current).toBeUndefined();
    expect(record.next).toBeDefined();
    expect(server.live()).toHaveLength(1);
    await lease.release();
  });

  it("never sweeps a slot while any record cannot be read or is not valid", async () => {
    const { dir, profiles } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    await (await profiles.open("lab")).release();
    const vault = join(dir, "credentials", "vault");
    const stray = join(vault, "abcdefghij0123456789.credential");
    const restart = () =>
      new RemoteProfiles({ dir, cipher, hostname: "Casey's PC", tunnel: () => ({}) as unknown as SshTunnel });

    for (const doubt of [
      () => writeFileSync(join(dir, "credentials", "other.json"), "{ not json"),
      () => writeFileSync(join(dir, "credentials", "other.json"), JSON.stringify({ version: 99 })),
      () => mkdirSync(join(dir, "credentials", "other.json")),
      () => writeFileSync(join(dir, "credentials", "Not A Profile.json"), "{}"),
    ]) {
      writeFileSync(stray, "sealed");
      doubt();
      restart();
      expect(existsSync(stray)).toBe(true);
      rmSync(join(dir, "credentials", "other.json"), { recursive: true, force: true });
      rmSync(join(dir, "credentials", "Not A Profile.json"), { force: true });
    }
    // Every record readable: the stray slot goes, the profile's own stays.
    const own = readdirSync(vault).filter((name) => name !== "abcdefghij0123456789.credential");
    restart();
    expect(existsSync(stray)).toBe(false);
    expect(readdirSync(vault)).toEqual(own);
  });
});

describe("server commands (#875)", () => {
  it("revokes a credential whose id starts with a dash: never read as an option", () => {
    const command = revokeCommand(
      { server: "lab", hostKeys: "[]", serverConfig: "/srv/orca.config.yaml" },
      "-7S0Qb1r7CC7",
    );
    // As the CLI parses its arguments (node's parseArgs, strict).
    const { positionals, values } = parseArgs({
      args: command.slice(1),
      options: { json: { type: "boolean" }, config: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    expect(positionals).toEqual(["auth", "revoke", "-7S0Qb1r7CC7"]);
    expect(values).toMatchObject({ json: true, config: "/srv/orca.config.yaml" });
  });
});

describe("setting a machine up as a managed server (#881)", () => {
  const scripts = fileURLToPath(new URL("../../../tools/deploy/", import.meta.url));
  const managed = "/home/casey/.local/share/orca-server/orca";
  const inspectAndSetUp = async (profiles: RemoteProfiles, version = "0.8.0") => {
    const { inspection } = await profiles.inspectServer("lab", { version, scripts });
    return profiles.setUpServer("lab", { version, scripts, confirmation: inspection!.confirmation });
  };

  it("first inspects read only: shows keys and account, and pins and installs nothing", async () => {
    const { profiles, server, dir } = store();
    profiles.save({ name: "Lab", destination: "casey@lab" });
    const { inspection, outcome } = await profiles.inspectServer("lab", { version: "0.8.0", scripts });
    expect(outcome.kind).toBe("inspected");
    expect(inspection).toMatchObject({
      destination: "casey@lab",
      account: "casey",
      firstUse: true,
      version: "0.8.0",
      current: null,
      scope: "install-and-sign-in",
      fingerprints: { server: [expect.stringMatching(/^ssh-ed25519 SHA256:/)] },
    });
    expect(inspection!.fingerprints).not.toHaveProperty("jump");
    expect(server.commands).toEqual([["python3", "-", "--version", "0.8.0", "--port", "6722", "--inspect"]]);
    // The first-seen key was not pinned for the profile.
    expect(pinState(join(dir, "known_hosts", "lab"))).toBe("none");
    expect(profiles.list()[0]).toMatchObject({ hostKeyPinned: false });
  });

  it("then, confirmed, pins exactly those keys and sets up pinned-only as that account, then signs in", async () => {
    const { profiles, server, tunnels, dir } = store();
    profiles.save({ name: "Lab", destination: "casey@lab", serverConfig: "/srv/old/orca.config.yaml" });
    const result = await inspectAndSetUp(profiles);
    expect(result.setup).toMatchObject({ kind: "ready", version: "0.8.0", command: managed, port: 6722 });
    expect(result.setup.steps.map((step) => [step.step, step.result])).toEqual([
      ["platform", "ok"],
      ["stage", "changed"],
      ["linger", "warning"],
    ]);
    expect(result.signIn).toEqual({ ok: true });
    expect(pinState(join(dir, "known_hosts", "lab"))).toBe("pinned");
    // Exactly `python3 -` with the version, port and confirmed account, and this build's own
    // two files on its input; over a pinned-only tunnel sealed to the inspected keys.
    expect(server.commands[1]).toEqual([
      "python3",
      "-",
      "--version",
      "0.8.0",
      "--port",
      "6722",
      "--expect-account",
      "casey",
      "--expect-root",
      "/home/casey/.local/share/orca-server",
      "--expect-current",
      "none",
    ]);
    expect(tunnels[1]!.options).toMatchObject({
      knownHostsFile: join(dir, "known_hosts", "lab"),
      pinnedOnly: true,
      expectKeys: tunnels[0]!.pinnedKeys,
    });
    const adapter = readFileSync(join(scripts, "orca-release.py")).toString("base64");
    expect(server.inputs[1]).toBe(
      `EMBEDDED_ADAPTER = "${adapter}"\n${readFileSync(join(scripts, "orca-server-setup.py"), "utf8")}`,
    );
    // Its own tunnels, closed again; then the sign-in through the managed launcher, which passes
    // the server's config itself.
    expect(tunnels[0]!.closed).toBe(1);
    expect(tunnels[1]!.closed).toBe(1);
    expect(profiles.list()[0]).toMatchObject({ serverCommand: managed, hasCredential: true });
    expect(profiles.list()[0]).not.toHaveProperty("serverConfig");
    const issue = server.commands.find((command) => command[2] === "issue")!;
    expect(issue[0]).toBe(managed);
    expect(issue).not.toContain("--config");
  });

  it("a confirmation is used once, for that profile revision and version only, and expires", async () => {
    const { profiles, server, dir } = store();
    profiles.save({ name: "Lab", destination: "casey@lab" });
    const { inspection } = await profiles.inspectServer("lab", { version: "0.8.0", scripts });
    const confirmation = inspection!.confirmation;
    const setUp = (version = "0.8.0", code = confirmation) =>
      profiles.setUpServer("lab", { version, scripts, confirmation: code });
    await expect(setUp("0.8.0", "0000-0000-0000")).rejects.toThrow("not current");
    // A failed attempt used it up: inspect again.
    await expect(setUp()).rejects.toThrow("not current");

    // Edited after the inspection: what was confirmed is not this profile any more.
    await profiles.inspectServer("lab", { version: "0.8.0", scripts });
    profiles.save({ id: "lab", name: "Lab", destination: "casey@lab", sshPort: 2222 });
    const again = (await profiles.inspectServer("lab", { version: "0.8.0", scripts })).inspection!;
    profiles.save({ id: "lab", name: "Lab", destination: "casey@lab", sshPort: 2200 });
    await expect(setUp("0.8.0", again.confirmation)).rejects.toThrow("not current");

    // Another version than the one confirmed.
    const third = (await profiles.inspectServer("lab", { version: "0.8.0", scripts })).inspection!;
    await expect(setUp("0.8.1", third.confirmation)).rejects.toThrow("not current");

    // Expired.
    const fourth = (await profiles.inspectServer("lab", { version: "0.8.0", scripts })).inspection!;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
    try {
      await expect(setUp("0.8.0", fourth.confirmation)).rejects.toThrow("not current");
    } finally {
      clock.mockRestore();
    }
    expect(server.commands.filter((command) => !command.includes("--inspect"))).toEqual([]);
    expect(pinState(join(dir, "known_hosts", "lab"))).toBe("none");
  });

  it("refuses to set up through a key other than the one confirmed", async () => {
    const { profiles, server, dir } = store();
    profiles.save({ name: "Lab", destination: "casey@lab" });
    const { inspection } = await profiles.inspectServer("lab", { version: "0.8.0", scripts });
    // A pin for another key appeared meanwhile: it is kept, and the setup refuses through it.
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "orca-lab ssh-ed25519 AAAAANOTHERKEY\n");
    await expect(
      profiles.setUpServer("lab", { version: "0.8.0", scripts, confirmation: inspection!.confirmation }),
    ).rejects.toThrow(TunnelRefusal);
    expect(server.commands.filter((command) => !command.includes("--inspect"))).toEqual([]);
  });

  it("reports a server the inspection refuses, with nothing to confirm", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "casey@lab" });
    server.inspect = {
      code: 2,
      stdout:
        'orca-setup: {"detail": "Found an ORCA installation this setup did not make: launcher /usr/local/bin/orca.", "result": "refused", "step": "inventory"}',
      serverLines: [],
    };
    const result = await profiles.inspectServer("lab", { version: "0.8.0", scripts });
    expect(result.outcome).toMatchObject({ kind: "refused", step: "inventory" });
    expect(result).not.toHaveProperty("inspection");
  });

  it("changes nothing on the profile when the setup refuses, fails or cannot say", async () => {
    for (const [setup, kind] of [
      [
        {
          code: 2,
          stdout: 'orca-setup: {"detail": "current is v0.7.9, not v0.8.0.", "result": "refused", "step": "existing"}',
          serverLines: [],
        },
        "refused",
      ],
      [
        {
          code: 1,
          stdout: [
            'orca-setup: {"detail": "no complete server bundle yet; retry later", "result": "failed", "step": "stage"}',
            'orca-setup: {"detail": "everything this run changed is back as it was", "result": "ok", "step": "cleanup"}',
          ].join("\n"),
          serverLines: [],
        },
        "failed",
      ],
      [
        {
          code: 1,
          stdout: [
            'orca-setup: {"detail": "health failed", "result": "failed", "step": "start"}',
            'orca-setup: {"detail": "Could not confirm everything is back: active is not back as it was", "result": "failed", "step": "cleanup"}',
          ].join("\n"),
          serverLines: [],
        },
        "unknown",
      ],
      [
        // Failed, and then the session ended before the put-back was reported.
        {
          code: 255,
          stdout: 'orca-setup: {"detail": "health failed", "result": "failed", "step": "start"}',
          serverLines: [],
        },
        "unknown",
      ],
      [{ code: 127, stdout: "", serverLines: ["sh: python3: not found"] }, "no-python"],
      [
        { code: 255, stdout: 'orca-setup: {"detail": "", "result": "ok", "step": "platform"}', serverLines: [] },
        "unknown",
      ],
    ] as const) {
      const { profiles, server } = store();
      profiles.save({ name: "Lab", destination: "casey@lab" });
      server.setup = { ...setup, serverLines: [...setup.serverLines] };
      const result = await inspectAndSetUp(profiles);
      expect(result.setup.kind).toBe(kind);
      expect(result).not.toHaveProperty("signIn");
      expect(profiles.list()[0]).toMatchObject({ serverCommand: "orca-cli" });
      expect(server.commands.filter((command) => command[2] === "issue")).toEqual([]);
    }
  });

  it("saves nothing and signs in nowhere when the server reports other than what was confirmed", async () => {
    const done = (fields: Record<string, unknown>) =>
      `orca-setup: ${JSON.stringify({
        done: true,
        account: "casey",
        command: managed,
        root: "/home/casey/.local/share/orca-server",
        version: "0.8.0",
        port: 6722,
        ...fields,
      })}`;
    for (const [fields, words] of [
      [{ port: 7000 }, "port 7000, not 6722"],
      [{ version: "0.8.1" }, "version 0.8.1, not 0.8.0"],
      [{ account: "root" }, "account root, not casey"],
      [{ command: "/tmp/evil" }, "launcher /tmp/evil"],
      [{ root: "/srv/other", command: "/srv/other/orca" }, "directory /srv/other"],
    ] as const) {
      const { profiles, server, dir } = store();
      profiles.save({ name: "Lab", destination: "casey@lab", serverConfig: "/srv/old/orca.config.yaml" });
      server.setup = { code: 0, stdout: done(fields), serverLines: [] };
      const result = await inspectAndSetUp(profiles);
      expect(result.setup).toMatchObject({ kind: "mismatch", detail: expect.stringContaining(words) });
      expect(result).not.toHaveProperty("signIn");
      expect(profiles.list()[0]).toMatchObject({ remotePort: 6722, serverConfig: "/srv/old/orca.config.yaml" });
      expect(profiles.list()[0]).toMatchObject({ serverCommand: "orca-cli" });
      expect(pinState(join(dir, "known_hosts", "lab"))).toBe("pinned");
      expect(server.commands.filter((command) => command[2] === "issue")).toEqual([]);
    }
  });

  it("holds the profile while its server is set up: no connect, edit, removal or second setup", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "casey@lab" });
    const { inspection } = await profiles.inspectServer("lab", { version: "0.8.0", scripts });
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    const running = profiles.setUpServer("lab", { version: "0.8.0", scripts, confirmation: inspection!.confirmation });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(profiles.open("lab")).rejects.toThrow("being set up");
    expect(() => profiles.save({ id: "lab", name: "Lab", destination: "casey@other" })).toThrow("being set up");
    await expect(profiles.remove("lab")).rejects.toThrow("being set up");
    expect(() => profiles.forgetHostKey("lab")).toThrow();
    await expect(profiles.inspectServer("lab", { version: "0.8.0", scripts })).rejects.toThrow("being set up");
    release();
    server.gate = undefined;
    await expect(running).resolves.toMatchObject({ setup: { kind: "ready" }, signIn: { ok: true } });
  });

  it("installs only a release version", async () => {
    const { profiles, server } = store();
    profiles.save({ name: "Lab", destination: "casey@lab" });
    await expect(profiles.inspectServer("lab", { version: "0.8.0-dryrun.1", scripts })).rejects.toThrow(
      "release version",
    );
    expect(server.commands).toEqual([]);
  });
});

describe("watching only (#882)", () => {
  const snapshot = (dir: string) =>
    existsSync(join(dir, "credentials"))
      ? readdirSync(join(dir, "credentials"), { recursive: true })
          .map(String)
          .sort()
          .map((name) => {
            const path = join(dir, "credentials", name);
            try {
              return `${name}:${readFileSync(path, "utf8")}`;
            } catch {
              return `${name}/`;
            }
          })
      : [];

  it("never pins a key, signs in or writes a record for a profile it cannot already use", async () => {
    const writes: string[] = [];
    const { dir, profiles, server } = store(undefined, undefined, { beforeRecordWrite: (id) => writes.push(id) });
    profiles.save({ name: "Lab", destination: "lab" });
    // No pinned key: refused, and no key is trusted on first use.
    await expect(profiles.observe("lab")).rejects.toThrow();
    expect(existsSync(join(dir, "known_hosts", "lab"))).toBe(false);
    // Pinned, but never signed in: refused rather than issued.
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "orca-lab ssh-ed25519 AAAA\n");
    await expect(profiles.observe("lab")).rejects.toThrow("Focus this machine once to sign in");
    expect(server.commands).toEqual([]);
    expect(writes).toEqual([]);
    expect(snapshot(dir)).toEqual([]);
  });

  it("uses the credential it has and never renews it, even past due", async () => {
    let now = Date.now();
    const writes: string[] = [];
    const { dir, profiles, server } = store(undefined, undefined, {
      credentialPolicy: { ttlMs: 10_000, renewBeforeMs: 4_000, checkEveryMs: 20 },
      now: () => now,
      beforeRecordWrite: (id) => writes.push(id),
    });
    profiles.save({ name: "Lab", destination: "lab" });
    // Signed in once by focusing it.
    const focused = await profiles.open("lab");
    const token = focused.auth.read();
    await focused.release();
    const commands = server.commands.length;
    const before = snapshot(dir);
    const issued = writes.length;
    const revision = profiles.revisionOf("lab");

    const watched = await profiles.observe("lab");
    expect(watched.auth.read()).toBe(token);
    // Due for renewal while only watched: nothing is asked of the server or written.
    now += 7_000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.commands).toHaveLength(commands);
    expect(writes).toHaveLength(issued);
    expect(snapshot(dir)).toEqual(before);
    expect(profiles.revisionOf("lab")).toBe(revision);
    await watched.release();
  });

  it("stops renewing a shared tunnel once only a watcher holds it", async () => {
    let now = Date.now();
    const { profiles, server } = store(undefined, undefined, {
      credentialPolicy: { ttlMs: 10_000, renewBeforeMs: 4_000, checkEveryMs: 20 },
      now: () => now,
    });
    profiles.save({ name: "Lab", destination: "lab" });
    const focused = await profiles.open("lab");
    const watched = await profiles.observe("lab");
    await focused.release();
    const commands = server.commands.length;
    now += 7_000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.commands).toHaveLength(commands);
    await watched.release();
  });
});

describe("the server command across the orca-cli default (#1207)", () => {
  const pin = (dir: string, id = "lab") => {
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", id), `orca-${id} ssh-ed25519 AAAA\n`);
  };
  // A profiles file as 0.8.0 wrote it: the server command left out, meaning `orca`.
  const legacy = (dir: string) =>
    writeFileSync(
      join(dir, "profiles.json"),
      `${JSON.stringify({ version: 1, profiles: [{ id: "lab", name: "Lab", destination: "casey@lab", remotePort: 6722 }] })}\n`,
    );
  const verbs = (commands: string[][]) => commands.map((command) => command.slice(0, 3).join(" "));

  it("saves orca-cli explicitly on a new profile, and on an edit that clears an explicit command", () => {
    const { dir, profiles } = store();
    profiles.save({ name: "Lab", destination: "casey@lab" });
    const saved = () => JSON.parse(readFileSync(join(dir, "profiles.json"), "utf8")).profiles[0];
    expect(saved().serverCommand).toBe("orca-cli");
    profiles.save({ id: "lab", name: "Lab", destination: "casey@lab", serverCommand: "/opt/orca/bin/orca" });
    profiles.save({ id: "lab", name: "Lab", destination: "casey@lab" });
    expect(saved().serverCommand).toBe("orca-cli");
  });

  it("keeps a profile saved before 0.8.1 on orca: issue, renew and revoke, through an edit", async () => {
    const { dir, profiles, server } = store();
    legacy(dir);
    pin(dir);
    await (await profiles.open("lab")).release();
    // An edit that leaves the command empty keeps the old meaning and the issued credential.
    profiles.save({ id: "lab", name: "Lab renamed", destination: "casey@lab" });
    expect(JSON.parse(readFileSync(join(dir, "profiles.json"), "utf8")).profiles[0]).not.toHaveProperty(
      "serverCommand",
    );
    expect(profiles.list()[0]!.hasCredential).toBe(true);
    await expect(profiles.remove("lab")).resolves.toBe("revoked");
    expect(verbs(server.commands)).toEqual(["orca auth issue", "orca auth revoke"]);
    expect(server.live()).toEqual([]);
  });

  it("records the issuing command on the credential, and revokes through it after the profile changes", async () => {
    const { dir, profiles, server } = store();
    legacy(dir);
    pin(dir);
    await (await profiles.open("lab")).release();
    const record = JSON.parse(readFileSync(join(dir, "credentials", "lab.json"), "utf8"));
    expect(record.current.target.serverCommand).toBe("orca");
    // Pointing the profile at another CLI retires the credential, revoked where it was issued.
    profiles.save({ id: "lab", name: "Lab", destination: "casey@lab", serverCommand: "orca-cli" });
    await (await profiles.open("lab")).release();
    expect(verbs(server.commands)).toEqual(["orca auth issue", "orca-cli auth issue", "orca auth revoke"]);
  });

  it("revokes a credential recorded before 0.8.1, which named no command, through orca", async () => {
    const { dir, profiles, server } = store();
    profiles.save({ name: "Lab", destination: "casey@lab" });
    pin(dir);
    await (await profiles.open("lab")).release();
    const file = join(dir, "credentials", "lab.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    delete record.current.target.serverCommand;
    writeFileSync(file, JSON.stringify(record));
    await expect(profiles.remove("lab")).resolves.toBe("revoked");
    expect(verbs(server.commands)).toEqual(["orca-cli auth issue", "orca auth revoke"]);
  });
});
