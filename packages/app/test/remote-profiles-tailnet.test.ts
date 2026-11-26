/**
 * Profiles picked from the user's own tailnet (#1226), with host keys pinned from what the
 * tailnet advertises (#1227) and Tailscale SSH approval links passed on (#1228). The tunnel is a
 * seam that records its options; the tailnet is a recorded `status --json`.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretCipher, SshTunnel, SshTunnelOptions } from "@orca/protocol/remote-access";
import type { ReadTailnetOptions } from "@orca/protocol/tailnet";

type FeatureContext = NonNullable<ReadTailnetOptions["features"]>;
import { RemoteProfiles } from "../src/main/remote-profiles.js";

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
  decryptString: (value) => Buffer.from(value.toString().replace(/^sealed:/, ""), "base64").toString(),
};

function ed25519Key(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const field = (bytes: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]).toString("base64")}`;
}
const hostKey = ed25519Key();

const ON = { env: { ORCA_INCUBATING: "tailnet-hosts" } };
const binding = { node: "nBuild1", name: "build-1.example-tailnet.ts.net" };

function tailnet(peers: Record<string, unknown>[], features: FeatureContext = ON): ReadTailnetOptions {
  return {
    features,
    cliPath: "/fake/tailscale",
    exists: () => true,
    run: () =>
      Promise.resolve({
        kind: "exited" as const,
        code: 0,
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { ID: "nSelf", DNSName: "laptop.example-tailnet.ts.net." },
          Peer: Object.fromEntries(
            peers.map((peer, index) => [
              `nodekey:${index}`,
              { OS: "linux", Online: true, TailscaleIPs: ["100.101.102.103"], ...peer },
            ]),
          ),
        }),
      }),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(options: ReadTailnetOptions, onLoginApproval?: (id: string, url: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "orca-tailnet-profiles-"));
  dirs.push(dir);
  const seen: SshTunnelOptions[] = [];
  const profiles = new RemoteProfiles({
    dir,
    cipher,
    hostname: "test",
    tailnet: options,
    ...(onLoginApproval ? { onLoginApproval } : {}),
    tunnel: (tunnelOptions) => {
      seen.push(tunnelOptions);
      return { state: { phase: "closed" }, close: async () => {} } as unknown as SshTunnel;
    },
  });
  return { dir, profiles, seen };
}

describe("tailnet profiles", () => {
  it("are refused while the tailnet-hosts flag is off", () => {
    const { profiles } = store(tailnet([], { env: {} }));
    expect(() =>
      profiles.save({ name: "Build 1", destination: "casey@build-1.example-tailnet.ts.net", tailnet: binding }),
    ).toThrow(/not available in this build/);
    expect(profiles.list()).toEqual([]);
  });

  it("save the binding, keep it on an edit that leaves it out, and never take a jump host", () => {
    const { profiles } = store(tailnet([]));
    const view = profiles.save({
      name: "Build 1",
      destination: "casey@build-1.example-tailnet.ts.net",
      tailnet: binding,
    });
    expect(view).toMatchObject({ id: "build-1", tailnet: binding, hostKeyPinned: false });
    expect(profiles.save({ id: "build-1", name: "Build one", destination: view.destination })).toMatchObject({
      tailnet: binding,
    });
    expect(() =>
      profiles.save({ id: "build-1", name: "Build 1", destination: view.destination, jump: { destination: "gw" } }),
    ).toThrow(/without a jump host/);
  });

  it("dial through the tailnet resolver and pass approval links on, by profile", async () => {
    const links: [string, string][] = [];
    const { profiles } = store(tailnet([{ ID: "nBuild1", DNSName: "build-1.example-tailnet.ts.net." }]), (id, url) =>
      links.push([id, url]),
    );
    profiles.save({ name: "Build 1", destination: "casey@build-1.example-tailnet.ts.net", tailnet: binding });
    const options = (profiles as unknown as { tunnelOptions(p: unknown): SshTunnelOptions }).tunnelOptions(
      profiles.get("build-1"),
    );
    await expect(options.resolveHost!()).resolves.toBe("100.101.102.103");
    options.onLoginApproval!("https://login.tailscale.com/a/x");
    expect(links).toEqual([["build-1", "https://login.tailscale.com/a/x"]]);
  });

  it("refuse to dial a node that is gone, or a name now held by another node", async () => {
    const { profiles } = store(tailnet([{ ID: "nOther", DNSName: "build-1.example-tailnet.ts.net." }]));
    profiles.save({ name: "Build 1", destination: "casey@build-1.example-tailnet.ts.net", tailnet: binding });
    const options = (profiles as unknown as { tunnelOptions(p: unknown): SshTunnelOptions }).tunnelOptions(
      profiles.get("build-1"),
    );
    await expect(options.resolveHost!()).rejects.toMatchObject({ code: "tailnet-moved" });
  });

  it("pin the host keys the node advertises, once, and fall back when it advertises none", async () => {
    const { dir, profiles } = store(
      tailnet([
        { ID: "nBuild1", DNSName: "build-1.example-tailnet.ts.net.", sshHostKeys: [hostKey] },
        { ID: "nPlain", DNSName: "plain.example-tailnet.ts.net." },
      ]),
    );
    profiles.save({ name: "Build 1", destination: "casey@build-1.example-tailnet.ts.net", tailnet: binding });
    profiles.save({
      name: "Plain",
      destination: "casey@plain.example-tailnet.ts.net",
      tailnet: { node: "nPlain", name: "plain.example-tailnet.ts.net" },
    });
    await expect(profiles.pinFromTailnet("build-1")).resolves.toBe(true);
    expect(readFileSync(join(dir, "known_hosts", "build-1"), "utf8")).toBe(`orca-build-1 ${hostKey}\n`);
    expect(profiles.describe("build-1")).toMatchObject({ hostKeyPinned: true });
    await expect(profiles.pinFromTailnet("build-1")).rejects.toThrow(/already has a pinned host key/);
    await expect(profiles.pinFromTailnet("plain")).resolves.toBe(false);
    expect(profiles.describe("plain")).toMatchObject({ hostKeyPinned: false });
  });

  it("treat binding to another node as another server: its pin is forgotten", async () => {
    const { profiles } = store(
      tailnet([{ ID: "nBuild1", DNSName: "build-1.example-tailnet.ts.net.", sshHostKeys: [hostKey] }]),
    );
    profiles.save({ name: "Build 1", destination: "casey@build-1.example-tailnet.ts.net", tailnet: binding });
    await profiles.pinFromTailnet("build-1");
    const view = profiles.save({
      id: "build-1",
      name: "Build 1",
      destination: "casey@build-1.example-tailnet.ts.net",
      tailnet: { node: "nBuild2", name: binding.name },
    });
    expect(view).toMatchObject({ hostKeyPinned: false, tailnet: { node: "nBuild2" } });
  });

  it("list nothing while the flag is off", async () => {
    const { profiles } = store(tailnet([{ ID: "nBuild1", DNSName: "build-1.example-tailnet.ts.net." }], { env: {} }));
    await expect(profiles.tailnetMachines()).resolves.toEqual({ state: "off" });
  });
});

describe("setting up a server from this computer's copy (#1234)", () => {
  it("is refused while the tailnet-hosts flag is off, before anything is fetched", async () => {
    const { profiles } = store(tailnet([], { env: {} }));
    profiles.save({ name: "Lab", destination: "casey@lab" });
    await expect(
      profiles.setUpServer("lab", { version: "0.9.0", scripts: "/nowhere", confirmation: "x", pushBundle: true }),
    ).rejects.toThrow(/not available in this build/);
  });
});
