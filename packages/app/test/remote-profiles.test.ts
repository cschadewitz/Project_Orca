/**
 * SSH connection profiles (#874): the profile store, and profile connections through the
 * Workspace and ConnectionTarget transaction. Tunnels are fakes here; the protocol package's
 * remote-access tests run the real ssh against a real sshd.
 */
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import type { SecretCipher, SshTunnel, SshTunnelOptions, TunnelState } from "@orca/protocol/remote-access";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { DaemonClient } from "../src/client/daemon-client.js";
import { CredentialTransportUnavailable, type DaemonTokenSource } from "../src/client/auth.js";
import { DaemonSubscription } from "../src/client/subscription.js";
import { ConnectionTarget, connectionFailure } from "../src/main/connection-target.js";
import { RemoteProfiles, type ProfileLease } from "../src/main/remote-profiles.js";
import { Workspace, type WorkspaceDeps } from "../src/main/workspace.js";
import { PreferencesFile } from "../src/preferences/preferences-file.js";

const TOKEN = "orca_live_0123456789abcdefghij";
const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
  decryptString: (value) => Buffer.from(value.toString().replace(/^sealed:/, ""), "base64").toString(),
};

class FakeTunnel {
  closed = 0;
  refused = false;
  verified = true;
  stateNow: TunnelState = { phase: "starting" };
  constructor(
    readonly options: SshTunnelOptions,
    private readonly outcome: Promise<string>,
  ) {}
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
  transportVerified(): boolean {
    return this.verified && this.stateNow.phase === "open";
  }
  async close(): Promise<void> {
    this.closed += 1;
    this.stateNow = { phase: "closed" };
  }
}

function store(outcome: () => Promise<string> = () => Promise.resolve("http://127.0.0.1:41000")) {
  const dir = mkdtempSync(join(tmpdir(), "orca-profiles-"));
  const tunnels: FakeTunnel[] = [];
  const profiles = new RemoteProfiles({
    dir,
    cipher,
    tunnel: (options) => {
      const tunnel = new FakeTunnel(options, outcome());
      tunnels.push(tunnel);
      return tunnel as unknown as SshTunnel;
    },
  });
  return { dir, profiles, tunnels };
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
    expect(readFileSync(join(dir, "credentials", "build-box.credential"), "utf8")).not.toContain(TOKEN);
    expect(() => profiles.importCredential("build-box", "not a token")).toThrow("not an ORCA daemon credential");
  });

  it("removing a profile removes its keychain entry and pinned key", () => {
    const { dir, profiles } = store();
    profiles.save({ name: "Lab", destination: "lab" });
    profiles.importCredential("lab", TOKEN);
    mkdirSync(join(dir, "known_hosts"), { recursive: true });
    writeFileSync(join(dir, "known_hosts", "lab"), "lab ssh-ed25519 AAAA\n");
    expect(profiles.list()[0]?.hostKeyPinned).toBe(true);
    profiles.remove("lab");
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
    await expect(profiles.open("lab")).rejects.toThrow("No credential");
    profiles.importCredential("lab", TOKEN);
    const a = await profiles.open("lab");
    const b = await profiles.open("lab");
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0]!.options.knownHostsFile).toMatch(/known_hosts[\\/]lab$/);
    expect(a.url).toBe("http://127.0.0.1:41000");
    expect(a.auth.read()).toBe(TOKEN);
    expect(() => profiles.remove("lab")).toThrow("Connect to another daemon");
    expect(() => profiles.save({ id: "lab", name: "Lab", destination: "x" })).toThrow("Connect to another daemon");
    await a.release();
    await a.release();
    expect(tunnels[0]!.closed).toBe(0);
    await b.release();
    expect(tunnels[0]!.closed).toBe(1);
    profiles.remove("lab");
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
  it("writes a picked credential only into the profile the picker was opened for", () => {
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
    profiles.remove("lab");
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

describe("credentials follow the verified tunnel, not the loopback URL", () => {
  it("offers no credential over HTTP or the WebSocket while the tunnel cannot be verified", async () => {
    // An impostor on the tunnel's local port: what any local process could do while ssh is down.
    const seen: (string | undefined)[] = [];
    const impostor = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.end("{}");
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    const address = impostor.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const { profiles, tunnels } = store(() => Promise.resolve(url));
      profiles.save({ name: "Lab", destination: "lab" });
      profiles.importCredential("lab", TOKEN);
      const lease = await profiles.open("lab");
      tunnels[0]!.verified = false;
      expect(() => lease.auth.read()).toThrow(CredentialTransportUnavailable);

      const onAuthFailure = vi.fn();
      const client = new DaemonClient(lease.url, fetch, {
        auth: lease.auth,
        requireAuthentication: true,
        onAuthFailure,
      });
      await expect(client.hello("probe")).rejects.toBeInstanceOf(CredentialTransportUnavailable);
      expect(onAuthFailure).not.toHaveBeenCalled();

      const offered: (string[] | undefined)[] = [];
      const states: string[] = [];
      const stream = new DaemonSubscription({
        url: client.socketUrl,
        params: {},
        onNotification: () => {},
        onState: (state) => states.push(state),
        backoffMs: [60_000],
        auth: { tokens: lease.auth },
        socket: (_url, _handlers, protocols) => {
          offered.push(protocols);
          return { send: () => {}, close: () => {} };
        },
      });
      expect(offered).toEqual([]);
      expect(states).toContain("reconnecting");
      expect(states).not.toContain("auth-failed");
      stream.close();
      expect(seen).toEqual([]);

      // Once verified again, the same lease sends the credential.
      tunnels[0]!.verified = true;
      expect(lease.auth.read()).toBe(TOKEN);
      await lease.release();
    } finally {
      await new Promise((resolve) => impostor.close(resolve));
    }
  });
});

const hello = {
  protocol: PROTOCOL_VERSION,
  orcaVersion: "test",
  capabilities: ["runs.read", "runs.subscribe"] as HelloResult["capabilities"],
  identity: { workspaceId: "2c7bf988-cf11-4f6d-9b36-77a4a7bf714f", instanceId: "44112345-b16c-44ba-831d-a66f44488f66" },
};
const reply = (result: unknown) => new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result }));

function lease(id: string, url: string, released: string[], refused = false): ProfileLease {
  const auth: DaemonTokenSource = { read: () => TOKEN, refresh: () => true };
  return {
    profile: { id, name: id.toUpperCase(), destination: `casey@${id}`, remotePort: 6722 },
    url,
    auth,
    remoteRefused: () => refused,
    transportVerified: () => true,
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
    file.saveDaemonProfile("lab");
    expect(file.read()).toMatchObject({ daemonProfile: "lab" });
    expect(file.read().daemonUrl).toBeUndefined();
    file.write({ theme: "dark" });
    expect(file.read().daemonProfile).toBe("lab");
    file.saveDaemonUrl(null);
    expect(file.read().daemonProfile).toBeUndefined();
  });
});
