/**
 * End to end over a real ssh (#874): a loopback-only daemon reached through a saved profile,
 * with the app's own ssh streams and a keychain-sealed credential, no manual tunnel and no
 * token file. Runs when `ORCA_SSH_TUNNEL_TEST` names an sshd (see remote-access.test.ts); the
 * ssh-tunnel workflow sets one up on Linux and Windows runners.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAuthDirectory, startDaemon, type DaemonHandle } from "@orca/daemon";
import type { SecretCipher, SshTunnel, TunnelState } from "@orca/protocol/remote-access";
import { createServer, type Server } from "node:net";
import { DaemonClient } from "../src/client/daemon-client.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import { ConnectionTarget } from "../src/main/connection-target.js";
import { RemoteProfiles } from "../src/main/remote-profiles.js";
import { Workspace } from "../src/main/workspace.js";

const live = process.env.ORCA_SSH_TUNNEL_TEST
  ? (JSON.parse(process.env.ORCA_SSH_TUNNEL_TEST) as { destination: string; sshPort?: number; identity: string })
  : undefined;

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value.split("").reverse().join("")),
  decryptString: (value) => value.toString().split("").reverse().join(""),
};

describe.skipIf(!live)("profile connection over a real ssh", () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  it("connects, carries every connection on an authenticated stream, survives their loss, and stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-ssh-live-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const auth = openAuthDirectory(join(dir, "server-auth"));
    const daemon: DaemonHandle = await startDaemon({
      orcaVersion: "ssh-live",
      capabilities: ["runs.read", "runs.subscribe"],
      source: { subscribe: () => () => {}, eventsRange: async () => [] },
      auth: {
        mode: "token",
        credentials: auth.credentials,
        ownership: auth.ownership,
        resolver: {
          run: async () => undefined,
          inputRun: async () => undefined,
          artifactRun: async () => undefined,
          claimRun: async () => undefined,
          workflowExists: () => false,
        },
      },
    });
    cleanup.push(() => daemon.close());
    const remotePort = Number(new URL(daemon.url).port);
    const { token } = await auth.credentials.issue({ principal: "desktop-live", preset: "client", label: "live" });

    const states: TunnelState[] = [];
    const tunnels: SshTunnel[] = [];
    const profiles = new RemoteProfiles({
      dir: join(dir, "app"),
      cipher,
      onTunnelState: (_id, state) => states.push(state),
    });
    cleanup.push(() => profiles.close());
    const view = profiles.save({
      name: "Live",
      destination: live!.destination,
      ...(live!.sshPort ? { sshPort: live!.sshPort } : {}),
      identityFile: live!.identity,
      remotePort,
    });
    profiles.importCredential(view.id, token);

    const streams: DaemonSubscription[] = [];
    const subscriptionStates: string[] = [];
    const workspace = new Workspace({
      openProfile: async (id) => {
        const lease = await profiles.open(id);
        tunnels.push((profiles as unknown as { tunnels: Map<string, { tunnel: SshTunnel }> }).tunnels.get(id)!.tunnel);
        return lease;
      },
      defaultPath: () => undefined,
      defaultUrl: "http://127.0.0.1:1",
      findEntry: () => undefined,
      start: () => Promise.reject(new Error("no bundled daemon in this test")),
      client: (url, options) =>
        new DaemonClient(url, options.transport?.fetch ?? fetch, {
          ...(options.auth ? { auth: options.auth, requireAuthentication: true } : {}),
          ...(options.transport ? { socket: options.transport.socket } : {}),
        }),
      subscribe: (client) => {
        const stream = client.subscribe({
          params: {},
          onNotification: () => {},
          onState: (state) => subscriptionStates.push(state),
        });
        streams.push(stream);
        return stream;
      },
      onSwitch: () => {},
      onSnapshot: () => {},
      onDaemonGone: () => {},
    });
    cleanup.push(() => workspace.close());
    const targets = new ConnectionTarget({
      prepare: (request, source) => workspace.prepareConnection(request, source),
      save: () => {},
      guard: async () => true,
      release: () => {},
    });

    await targets.connect({ profile: view.id });
    const target = workspace.connectionTarget;
    expect(target).toMatchObject({ source: "saved", profile: { id: view.id } });
    expect(target.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(target.url).not.toBe(daemon.url);
    expect(profiles.list()[0]).toMatchObject({ hasCredential: true, hostKeyPinned: true });
    const tunnel = tunnels[0] as unknown as {
      listener: Server;
      streams: Set<{ child: ChildProcess; authenticated: boolean }>;
    };
    // The client never dials the tunnel's address: every request is its own ssh stream.
    let dialled = 0;
    tunnel.listener.on("connection", () => (dialled += 1));
    expect((await workspace.client.hello("ssh-live")).orcaVersion).toBe("ssh-live");
    await vi.waitFor(() => expect(streams[0]!.state).toBe("live"), { timeout: 20_000 });

    // The address is held for the tunnel's whole life: no other process can take it.
    const port = Number(new URL(target.url).port);
    const impostor = createServer();
    await expect(
      new Promise<void>((resolve, reject) => {
        impostor.once("error", reject);
        impostor.listen(port, "127.0.0.1", resolve);
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/EADDRINUSE|EACCES/) });

    // Loss: every ssh carrying a connection dies. Those connections end with them; the
    // stream comes back over new authenticated streams on the same connection epoch.
    const epoch = target.epoch;
    await vi.waitFor(() => expect(tunnel.streams.size).toBeGreaterThan(0), { timeout: 20_000 });
    for (const stream of tunnel.streams) stream.child.kill();
    await vi.waitFor(() => expect(subscriptionStates).toContain("reconnecting"), { timeout: 20_000 });
    await vi.waitFor(() => expect(subscriptionStates.filter((s) => s === "live").length).toBeGreaterThanOrEqual(2), {
      timeout: 30_000,
    });
    expect(subscriptionStates).not.toContain("auth-failed");
    expect(workspace.connectionTarget.epoch).toBe(epoch);
    expect(workspace.connectionTarget.url).toBe(target.url);
    expect((await workspace.client.hello("after-loss")).orcaVersion).toBe("ssh-live");
    expect(dialled).toBe(0);

    // Leaving the profile closes its tunnel.
    await workspace.close();
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe("closed"));
  }, 120_000);

  it("signs in on the first connect with the server's own CLI, renews, re-issues, and revokes on removal (#875)", async () => {
    // No spaces or `~` in server paths: the long form of the temp directory.
    const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "orca-ssh-signin-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const server = join(dir, "server");
    mkdirSync(server);
    const config = join(server, "orca.config.yaml");
    writeFileSync(config, "{}\n");
    // The server's managed CLI wrapper: this checkout's CLI under this node.
    const main = resolve(fileURLToPath(import.meta.url), "../../../cli/dist/main.js");
    const command = process.platform === "win32" ? join(dir, "orca.cmd") : join(dir, "orca");
    writeFileSync(
      command,
      process.platform === "win32"
        ? `@"${process.execPath}" "${main}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`,
    );
    chmodSync(command, 0o755);
    const auth = openAuthDirectory(join(server, "auth"));
    const daemon: DaemonHandle = await startDaemon({
      orcaVersion: "ssh-live",
      capabilities: ["runs.read", "runs.subscribe"],
      source: { subscribe: () => () => {}, eventsRange: async () => [] },
      auth: {
        mode: "token",
        credentials: auth.credentials,
        ownership: auth.ownership,
        resolver: {
          run: async () => undefined,
          inputRun: async () => undefined,
          artifactRun: async () => undefined,
          claimRun: async () => undefined,
          workflowExists: () => false,
        },
      },
    });
    cleanup.push(() => daemon.close());
    const remotePort = Number(new URL(daemon.url).port);

    let now = Date.now();
    const profiles = new RemoteProfiles({
      dir: join(dir, "app"),
      cipher,
      hostname: "live-desktop",
      // Long enough to issue, short enough to come due in the test.
      credentialPolicy: { ttlMs: 60 * 60_000, renewBeforeMs: 30 * 60_000, checkEveryMs: 100 },
      now: () => now,
    });
    cleanup.push(() => profiles.close());
    const view = profiles.save({
      name: "Live",
      destination: live!.destination,
      ...(live!.sshPort ? { sshPort: live!.sshPort } : {}),
      identityFile: live!.identity,
      remotePort,
      serverCommand: command,
      serverConfig: config,
    });
    const liveCredentials = () => auth.credentials.list().filter((c) => !c.revokedAt);

    // First connect: issued on the server, stored in the slot, accepted by the daemon.
    const lease = await profiles.open(view.id);
    const issued = liveCredentials();
    expect(issued).toMatchObject([{ principal: "desktop-live-desktop", label: `orca-app-${view.id}` }]);
    const client = new DaemonClient(lease.url, lease.transport.fetch, {
      auth: lease.auth,
      requireAuthentication: true,
    });
    expect((await client.hello("ssh-live")).orcaVersion).toBe("ssh-live");
    const first = lease.auth.read();

    // Due while connected: a new credential on the server, and the lease moves to it.
    now += 45 * 60_000;
    await vi.waitFor(() => expect(lease.auth.read()).not.toBe(first), { timeout: 30_000 });
    // Switched in once the daemon accepted it; the old one is revoked right after.
    await vi.waitFor(() => expect(liveCredentials()).toHaveLength(1), { timeout: 30_000 });
    expect(liveCredentials()[0]!.id).not.toBe(issued[0]!.id);
    expect((await client.hello("after-renewal")).orcaVersion).toBe("ssh-live");
    await lease.release();

    // Revoked on the server: the next connect issues a new one, once.
    await auth.credentials.revoke(liveCredentials()[0]!.id);
    const again = await profiles.open(view.id);
    expect(liveCredentials()).toHaveLength(1);
    await again.release();

    // Removing the profile revokes it: `orca auth list` shows nothing live.
    await expect(profiles.remove(view.id)).resolves.toBe("revoked");
    expect(liveCredentials()).toEqual([]);
  }, 120_000);
});
