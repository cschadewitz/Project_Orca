/**
 * Reading the user's own tailnet (#1225): discovery and binding (#1226), advertised host keys
 * (#1227). The status documents are shaped like `tailscale status --json` from a current client
 * (and a Headscale-served one), with invented names and addresses.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pinState, pinnedKeyIdentity } from "../src/remote-access.js";
import {
  AdvertisedPinRefused,
  checkAdvertisedHostKey,
  hostKeyFingerprint,
  parseAdvertisedHostKey,
  parseTailnetStatus,
  readTailnet,
  resolveTailnetBinding,
  TAILSCALE_CLI,
  writeAdvertisedPin,
  type TailnetPeer,
  type TailnetSnapshot,
} from "../src/tailnet.js";

const ON = { env: { ORCA_INCUBATING: "tailnet-hosts" } };

/** A real ed25519 public key in authorized_keys form: `ssh-ed25519 <base64 wire blob>`. */
function ed25519Key(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]).toString("base64")}`;
}

const buildKey = ed25519Key();
const otherKey = ed25519Key();

function peer(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ID: "nAbC123CNTRL",
    PublicKey: "nodekey:00",
    HostName: "build-1",
    DNSName: "build-1.example-tailnet.ts.net.",
    OS: "linux",
    UserID: 101,
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
    Online: true,
    LastSeen: "0001-01-01T00:00:00Z",
    ...overrides,
  };
}

function status(peers: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Version: "1.92.0",
    BackendState: "Running",
    Self: { ID: "nSELF1CNTRL", DNSName: "laptop.example-tailnet.ts.net.", OS: "windows" },
    MagicDNSSuffix: "example-tailnet.ts.net",
    CurrentTailnet: { Name: "someone@example.com", MagicDNSSuffix: "example-tailnet.ts.net", MagicDNSEnabled: true },
    User: { "101": { ID: 101, LoginName: "someone@example.com", DisplayName: "Someone" } },
    Peer: Object.fromEntries(peers.map((entry, index) => [`nodekey:${index}`, entry])),
    ...extra,
  });
}

function running(json: string): TailnetSnapshot {
  const read = parseTailnetStatus(json);
  if (read.state !== "running") throw new Error(`not running: ${read.state}`);
  return read.snapshot;
}

describe("advertised host keys", () => {
  it("accepts a well-formed key and fingerprints it as ssh does", () => {
    expect(parseAdvertisedHostKey(buildKey)).toBe(buildKey);
    expect(parseAdvertisedHostKey(`  ${buildKey}\n`)).toBe(buildKey);
    expect(hostKeyFingerprint(buildKey)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(hostKeyFingerprint(buildKey)).not.toBe(hostKeyFingerprint(otherKey));
  });

  it.each([
    ["a comment", `${buildKey} root@host`],
    ["a known_hosts line", `build-1 ${buildKey}`],
    ["an unknown type", buildKey.replace("ssh-ed25519 ", "ssh-dss ")],
    ["a type that does not match the blob", buildKey.replace("ssh-ed25519 ", "ssh-rsa ")],
    ["a newline inside", buildKey.replace(" ", "\n")],
    ["non-canonical base64", `${buildKey}=`],
    ["a non-string", 42],
  ])("drops %s", (_, value) => {
    expect(parseAdvertisedHostKey(value)).toBeUndefined();
  });
});

describe("parseTailnetStatus", () => {
  it("lists peers by stable node ID and MagicDNS name, without the trailing dot", () => {
    const snapshot = running(status([peer({ sshHostKeys: [buildKey] })]));
    expect(snapshot.tailnetName).toBe("someone@example.com");
    expect(snapshot.magicDnsSuffix).toBe("example-tailnet.ts.net");
    expect(snapshot.self).toEqual({ nodeId: "nSELF1CNTRL", dnsName: "laptop.example-tailnet.ts.net" });
    expect(snapshot.peers).toEqual([
      {
        nodeId: "nAbC123CNTRL",
        dnsName: "build-1.example-tailnet.ts.net",
        hostName: "build-1",
        os: "linux",
        online: true,
        addresses: ["100.101.102.103", "fd7a:115c:a1e0::1"],
        tags: [],
        owner: "someone@example.com",
        sharedIn: false,
        sshHostKeys: [buildKey],
        tailscaleSsh: true,
        hostSupported: true,
      },
    ]);
  });

  it("marks shared-in nodes, keeps tags, hides sharee nodes and marks Windows as not a host yet", () => {
    const snapshot = running(
      status([
        peer({ ID: "nShared1", DNSName: "gpu.other-tailnet.ts.net.", AltSharerUserID: 202, UserID: 202 }),
        peer({ ID: "nTagged1", DNSName: "ci.example-tailnet.ts.net.", Tags: ["tag:orca-server", "not a tag"] }),
        peer({ ID: "nSharee1", DNSName: "visitor.example-tailnet.ts.net.", ShareeNode: true }),
        peer({ ID: "nWin1", DNSName: "desk.example-tailnet.ts.net.", OS: "windows" }),
      ]),
    );
    expect(snapshot.peers.map((entry) => entry.nodeId)).toEqual(["nTagged1", "nWin1", "nShared1"]);
    const [tagged, windows, shared] = snapshot.peers;
    expect(tagged!.tags).toEqual(["tag:orca-server"]);
    expect(shared!.sharedIn).toBe(true);
    expect(shared!.owner).toBeUndefined();
    expect(windows!.hostSupported).toBe(false);
    expect(windows!.tailscaleSsh).toBe(false);
  });

  it("reads a Headscale-served status without assuming ts.net", () => {
    const snapshot = running(
      status([peer({ ID: "17", DNSName: "build-1.tail.example.org." })], {
        MagicDNSSuffix: "tail.example.org",
        CurrentTailnet: null,
      }),
    );
    expect(snapshot.magicDnsSuffix).toBe("tail.example.org");
    expect(snapshot.tailnetName).toBeUndefined();
    expect(snapshot.peers[0]!.dnsName).toBe("build-1.tail.example.org");
  });

  it("drops malformed peers and fields, and both entries of a duplicated ID or name", () => {
    const snapshot = running(
      status([
        peer({ ID: "bad id;rm", DNSName: "x.example-tailnet.ts.net." }),
        peer({ ID: "nNoName1", DNSName: "" }),
        peer({ ID: "nDup", DNSName: "a.example-tailnet.ts.net." }),
        peer({ ID: "nDup", DNSName: "b.example-tailnet.ts.net." }),
        peer({ ID: "nSame1", DNSName: "same.example-tailnet.ts.net." }),
        peer({ ID: "nSame2", DNSName: "SAME.example-tailnet.ts.net." }),
        peer({
          ID: "nOk1",
          DNSName: "ok.example-tailnet.ts.net.",
          HostName: "bell\u0007",
          TailscaleIPs: ["100.64.0.9", "not-an-ip", 7],
          sshHostKeys: [buildKey, buildKey, "garbage", `${otherKey} comment`],
          Online: false,
          LastSeen: "2026-11-20T10:00:00Z",
        }),
      ]),
    );
    expect(snapshot.peers).toHaveLength(1);
    expect(snapshot.peers[0]).toMatchObject({
      nodeId: "nOk1",
      hostName: "",
      addresses: ["100.64.0.9"],
      sshHostKeys: [buildKey],
      online: false,
      lastSeen: "2026-11-20T10:00:00Z",
    });
  });

  it("never lists this machine as a peer", () => {
    const snapshot = running(status([peer({ ID: "nSELF1CNTRL" })]));
    expect(snapshot.peers).toEqual([]);
  });

  it.each([
    ["NeedsLogin", "signed-out"],
    ["NeedsMachineAuth", "signed-out"],
    ["Stopped", "stopped"],
    ["Starting", "stopped"],
    ["NoState", "stopped"],
    ["Something", "error"],
  ])("reports %s as %s", (backend, state) => {
    expect(parseTailnetStatus(JSON.stringify({ BackendState: backend })).state).toBe(state);
  });

  it("reports unreadable output as an error", () => {
    expect(parseTailnetStatus("not json").state).toBe("error");
    expect(parseTailnetStatus("[]").state).toBe("error");
  });
});

describe("readTailnet", () => {
  it("never starts the CLI while the flag is off", async () => {
    let ran = false;
    const read = await readTailnet({
      features: { env: {} },
      exists: () => true,
      run: async () => {
        ran = true;
        return status([]);
      },
    });
    expect(read).toEqual({ state: "off" });
    expect(ran).toBe(false);
  });

  it("runs only the fixed install path with status --json", async () => {
    const calls: [string, readonly string[]][] = [];
    const read = await readTailnet({
      features: ON,
      platform: "win32",
      exists: (path) => path === TAILSCALE_CLI.win32,
      run: async (file, args) => {
        calls.push([file, args]);
        return status([peer({})]);
      },
    });
    expect(calls).toEqual([["C:\\Program Files\\Tailscale\\tailscale.exe", ["status", "--json"]]]);
    expect(read.state).toBe("running");
  });

  it("is absent with no CLI file, no path for the platform, or ENOENT", async () => {
    const run = async () => status([]);
    expect(await readTailnet({ features: ON, platform: "linux", exists: () => false, run })).toEqual({
      state: "absent",
    });
    expect(await readTailnet({ features: ON, platform: "darwin", exists: () => true, run })).toEqual({
      state: "absent",
    });
    const missing = Object.assign(new Error("spawn"), { code: "ENOENT" });
    expect(
      await readTailnet({
        features: ON,
        platform: "linux",
        exists: () => true,
        run: async () => {
          throw missing;
        },
      }),
    ).toEqual({ state: "absent" });
  });

  it("turns a CLI failure into an error state instead of throwing", async () => {
    const read = await readTailnet({
      features: ON,
      platform: "linux",
      exists: () => true,
      run: async () => {
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      },
    });
    expect(read.state).toBe("error");
  });
});

describe("resolveTailnetBinding", () => {
  const snapshot = running(
    status([
      peer({ ID: "nBuild1", DNSName: "build-1.example-tailnet.ts.net." }),
      peer({ ID: "nOff1", DNSName: "off.example-tailnet.ts.net.", Online: false }),
      peer({ ID: "nV6only", DNSName: "v6.example-tailnet.ts.net.", TailscaleIPs: ["fd7a:115c:a1e0::7"] }),
      peer({ ID: "nNoIp", DNSName: "noip.example-tailnet.ts.net.", TailscaleIPs: [] }),
    ]),
  );

  it("connects by the node's current address", () => {
    const result = resolveTailnetBinding(snapshot, { node: "nBuild1", name: "build-1.example-tailnet.ts.net" });
    expect(result).toMatchObject({ ok: true, host: "100.101.102.103", renamed: false });
  });

  it("follows a renamed node, since the stable ID is what was confirmed", () => {
    const result = resolveTailnetBinding(snapshot, { node: "nBuild1", name: "old-name.example-tailnet.ts.net" });
    expect(result).toMatchObject({ ok: true, renamed: true });
  });

  it("fails closed when the name now belongs to another node", () => {
    const result = resolveTailnetBinding(snapshot, { node: "nGone", name: "build-1.example-tailnet.ts.net" });
    expect(result).toMatchObject({ ok: false, code: "different-machine" });
  });

  it("fails closed when the node is gone, offline or has no address", () => {
    expect(resolveTailnetBinding(snapshot, { node: "nGone", name: "gone.example-tailnet.ts.net" })).toMatchObject({
      ok: false,
      code: "node-gone",
    });
    expect(resolveTailnetBinding(snapshot, { node: "nOff1", name: "off.example-tailnet.ts.net" })).toMatchObject({
      ok: false,
      code: "offline",
    });
    expect(resolveTailnetBinding(snapshot, { node: "nNoIp", name: "noip.example-tailnet.ts.net" })).toMatchObject({
      ok: false,
      code: "no-address",
    });
  });

  it("brackets an IPv6-only address for ssh", () => {
    expect(resolveTailnetBinding(snapshot, { node: "nV6only", name: "v6.example-tailnet.ts.net" })).toMatchObject({
      ok: true,
      host: "[fd7a:115c:a1e0::7]",
    });
  });
});

describe("pinning advertised host keys", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const pinFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-tailnet-"));
    dirs.push(dir);
    return join(dir, "pins", "build-1.known_hosts");
  };
  const withKeys = (keys: string[]): TailnetPeer => running(status([peer({ sshHostKeys: keys })])).peers[0]!;

  it("compares the presented fingerprint with the advertised keys", () => {
    const build = withKeys([buildKey]);
    expect(checkAdvertisedHostKey(build, hostKeyFingerprint(buildKey))).toBe("match");
    expect(checkAdvertisedHostKey(build, hostKeyFingerprint(otherKey))).toBe("mismatch");
    expect(checkAdvertisedHostKey(withKeys([]), hostKeyFingerprint(buildKey))).toBe("none-advertised");
  });

  it("seeds an unenrolled pin file under the profile's alias and marks it enrolled", () => {
    const file = pinFile();
    writeAdvertisedPin(file, "orca-build-1", withKeys([buildKey, otherKey]));
    expect(readFileSync(file, "utf8")).toBe(`orca-build-1 ${buildKey}\norca-build-1 ${otherKey}\n`);
    expect(pinState(file)).toBe("pinned");
    expect(existsSync(`${file}.enrolled`)).toBe(true);
    expect(pinnedKeyIdentity(file)).toBe([buildKey, otherKey].sort().join("\n"));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("never replaces an existing or broken pin, and refuses a node with no advertised keys", () => {
    const file = pinFile();
    expect(() => writeAdvertisedPin(file, "orca-build-1", withKeys([]))).toThrow(AdvertisedPinRefused);
    writeAdvertisedPin(file, "orca-build-1", withKeys([buildKey]));
    expect(() => writeAdvertisedPin(file, "orca-build-1", withKeys([otherKey]))).toThrow(
      /already has a pinned host key/,
    );
    writeFileSync(file, "");
    expect(pinState(file)).toBe("broken");
    expect(() => writeAdvertisedPin(file, "orca-build-1", withKeys([otherKey]))).toThrow(AdvertisedPinRefused);
    expect(() => writeAdvertisedPin(pinFile(), "bad alias", withKeys([buildKey]))).toThrow(/alias/);
  });
});
