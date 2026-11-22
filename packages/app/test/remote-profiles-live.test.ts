/**
 * End to end over a real ssh (#874): a loopback-only daemon reached through a saved profile,
 * with the app's own tunnel and a keychain-sealed credential, no manual tunnel and no token
 * file. Runs when `ORCA_SSH_TUNNEL_TEST` names an sshd (see remote-access.test.ts); the
 * ssh-tunnel workflow sets one up on Linux and Windows runners.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAuthDirectory, startDaemon, type DaemonHandle } from "@orca/daemon";
import type { SecretCipher, SshTunnel, TunnelState } from "@orca/protocol/remote-access";
import { createServer } from "node:http";
import { DaemonClient } from "../src/client/daemon-client.js";
import { CredentialTransportUnavailable } from "../src/client/auth.js";
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

  it("connects, survives a tunnel loss on the same epoch, and stops the tunnel when it leaves", async () => {
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
        new DaemonClient(url, fetch, {
          ...(options.auth ? { auth: options.auth, requireAuthentication: true } : {}),
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
    expect((await workspace.client.hello("ssh-live")).orcaVersion).toBe("ssh-live");
    await vi.waitFor(() => expect(streams[0]!.state).toBe("live"), { timeout: 20_000 });

    // Tunnel loss: ssh dies. Before it restarts, an impostor takes the local port, as any
    // local process could. No credential may reach it: the tunnel is not verified.
    const epoch = target.epoch;
    const port = Number(new URL(target.url).port);
    (tunnels[0] as unknown as { generation: { children: ChildProcess[] } }).generation.children[0]!.kill();
    await vi.waitFor(() => expect(states.some((s) => s.phase === "reconnecting")).toBe(true), { timeout: 20_000 });
    const offered: (string | undefined)[] = [];
    const impostor = createServer((request, response) => {
      offered.push(request.headers.authorization ?? request.headers["sec-websocket-protocol"]);
      response.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      impostor.once("error", reject);
      impostor.listen(port, "127.0.0.1", resolve);
    });
    await expect(workspace.client.hello("during-loss")).rejects.toBeInstanceOf(CredentialTransportUnavailable);
    // Let the stream's reconnect attempts and ssh's restart attempts run against the impostor.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(offered.filter(Boolean)).toEqual([]);
    expect(subscriptionStates).not.toContain("auth-failed");
    await new Promise((resolve) => impostor.close(resolve));

    // The port is free again: ssh restarts on it and the stream comes back on the same
    // connection epoch (no switch, no reissue).
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe("open"), { timeout: 40_000 });
    await vi.waitFor(() => expect(subscriptionStates.filter((s) => s === "live").length).toBeGreaterThanOrEqual(2), {
      timeout: 30_000,
    });
    expect(workspace.connectionTarget.epoch).toBe(epoch);
    expect(workspace.connectionTarget.url).toBe(target.url);

    // Leaving the profile closes its tunnel.
    await workspace.close();
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe("closed"));
  }, 120_000);
});
