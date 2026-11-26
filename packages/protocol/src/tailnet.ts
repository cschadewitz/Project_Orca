/**
 * Reading the user's own tailnet (#1225), Node-only like `remote-access`: never exported from
 * the renderer protocol barrel, because it runs the Tailscale CLI and writes pin files.
 *
 * Tailscale finds and vouches; ORCA reaches and authorizes. This module only *reads* the
 * Tailscale client the user already signed in to, by its fixed install path (never `PATH`), with
 * `tailscale status --json`. It never runs `up`, `set`, `serve` or anything that changes the
 * client or the tailnet, holds no auth key, and has no coordination-server, admin-API or OAuth
 * code. The transport stays the app-owned SSH tunnel and every daemon call still needs an ORCA
 * credential: tailnet membership is never authorization.
 *
 * Three parts:
 *
 * - **Discovery (#1226)**: `readTailnet` and `parseTailnetStatus` turn the status JSON into a
 *   small, strictly checked snapshot of peers. Every field is untrusted display text; anything
 *   malformed is dropped, never repaired.
 * - **Binding (#1226)**: a profile picked from the list is bound to the peer's stable node ID.
 *   `resolveTailnetBinding` finds the address from that ID at connect time, so a renamed or
 *   reused MagicDNS name cannot redirect a saved profile, and a vanished node fails closed.
 * - **Advertised host keys (#1227)**: a peer running Tailscale SSH advertises its SSH host keys
 *   (`sshHostKeys`, the keys `tailscale ssh` itself pins with). `writeAdvertisedPin` seeds a
 *   profile's pin file with them before the first connect, so ssh checks the server against them
 *   with `StrictHostKeyChecking=yes` from the start. The keys are vouched for by the tailnet's
 *   coordination server, unsigned: Tailnet Lock signs node keys only, not these. That is a new
 *   trust root, so it is always shown as "advertised by your tailnet" and stays optional.
 *
 * Everything here sits behind the incubating `tailnet-hosts` flag: with it off, `readTailnet`
 * never starts the Tailscale CLI.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { featureEnabled, type FeatureContext } from "@orca/core";
import { markPinEnrolled, pinState, TunnelRefusal, type TailnetBinding } from "./remote-access.js";

export type { TailnetBinding } from "./remote-access.js";

/** The workstream's flag (packages/core/src/features.ts). */
export const TAILNET_FLAG = "tailnet-hosts";

/** Whether the `tailnet-hosts` flag is on here (off by default: incubating). */
export function tailnetEnabled(features?: FeatureContext): boolean {
  return featureEnabled(TAILNET_FLAG, features);
}

/**
 * Where the Tailscale CLI is installed, by platform. A fixed path, never a `PATH` lookup, so
 * nothing earlier on the user's `PATH` can stand in for it. Platforms without an entry have no
 * tailnet support yet (the list is hidden there).
 */
export const TAILSCALE_CLI: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  linux: "/usr/bin/tailscale",
  win32: "C:\\Program Files\\Tailscale\\tailscale.exe",
};

/** `status --json` on a large tailnet is tens of kilobytes; this bounds a hostile one. */
const STATUS_MAX_BYTES = 8 * 1024 * 1024;
const STATUS_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------

/** One machine on the tailnet, as ORCA shows and binds it. All text is untrusted display text. */
export interface TailnetPeer {
  /** The stable node ID (`ID` in the status JSON): what a profile is bound to. */
  nodeId: string;
  /** The MagicDNS name without the trailing dot, e.g. `build-1.example.ts.net`. */
  dnsName: string;
  /** The machine's own host name (not unique). */
  hostName: string;
  /** `linux`, `windows`, `macOS`, … as the client reports it; empty when unknown. */
  os: string;
  online: boolean;
  /** When the coordination server last saw it, ISO 8601; only set while offline. */
  lastSeen?: string | undefined;
  /** Tailscale addresses, IPv4 first. */
  addresses: string[];
  tags: string[];
  /** The owner's login name, when the status names one. */
  owner?: string | undefined;
  /** Shared into this tailnet from another one (`AltSharerUserID`): confirm its key by hand. */
  sharedIn: boolean;
  /** The SSH host keys it advertises, each `<type> <base64>`, checked; empty without Tailscale SSH. */
  sshHostKeys: string[];
  /** Runs the Tailscale SSH server: it advertises host keys (Tailscale's own signal for this). */
  tailscaleSsh: boolean;
  /** Whether ORCA can set up a daemon host there today: Linux only (#1238 for Windows). */
  hostSupported: boolean;
}

export interface TailnetSnapshot {
  /** The active tailnet's display name, when the client reports one. */
  tailnetName?: string | undefined;
  /** The MagicDNS suffix, when MagicDNS is on. Never assumed to be `ts.net` (Headscale). */
  magicDnsSuffix?: string | undefined;
  /** This machine's own node. */
  self?: { nodeId: string; dnsName: string } | undefined;
  /** The other machines, by MagicDNS name. Hidden peers (`ShareeNode`) are left out. */
  peers: TailnetPeer[];
}

/** Why there is no list. The list is hidden in every one of these, and nothing else changes. */
export type TailnetUnavailable =
  /** The `tailnet-hosts` flag is off: the CLI was not started. */
  | "off"
  /** No Tailscale CLI at the fixed install path, or no path for this platform. */
  | "absent"
  /** The client is installed but not connected: stopped, starting, or signed out. */
  | "stopped"
  | "signed-out"
  /** The CLI ran but its answer could not be read. */
  | "error";

export type TailnetRead =
  { state: "running"; snapshot: TailnetSnapshot } | { state: TailnetUnavailable; detail?: string | undefined };

const STABLE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DNS_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?)*$/;
/** Display text: printable, at most 200 characters, no control characters. */
const DISPLAY = { test: (value: string) => value.length <= 200 && !hasControl(value) };
const TAG = /^tag:[A-Za-z0-9-]{1,100}$/;
/** A login name: display text with no whitespace. */
const LOGIN = { test: (value: string) => value.length >= 1 && DISPLAY.test(value) && !/\s/.test(value) };
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** SSH host key types a Tailscale SSH server advertises (rsa, ecdsa P-256, ed25519), plus the other ECDSA curves. */
const HOST_KEY_TYPES = new Set([
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
]);

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown, pattern: { test(value: string): boolean }): string | undefined =>
  typeof value === "string" && pattern.test(value) ? value : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * One advertised host key, checked the way ssh would read it: a known type, then standard
 * base64 whose wire blob starts with that same type name. Returns `<type> <base64>`, or
 * `undefined` for anything else (a comment, extra fields, a newline, a mismatched blob).
 */
export function parseAdvertisedHostKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([a-z0-9-]{1,40}) ([A-Za-z0-9+/]{16,8192}={0,2})$/.exec(value.trim());
  if (!match || !HOST_KEY_TYPES.has(match[1]!)) return undefined;
  const blob = Buffer.from(match[2]!, "base64");
  if (blob.toString("base64") !== match[2] || blob.length < 4) return undefined;
  const length = blob.readUInt32BE(0);
  if (length !== match[1]!.length || blob.subarray(4, 4 + length).toString("latin1") !== match[1]) return undefined;
  return `${match[1]} ${match[2]}`;
}

/** The `SHA256:…` fingerprint ssh prints for a `<type> <base64>` key. */
export function hostKeyFingerprint(key: string): string {
  const base64 = key.split(" ")[1] ?? "";
  return `SHA256:${createHash("sha256").update(Buffer.from(base64, "base64")).digest("base64").replace(/=+$/, "")}`;
}

function addressesOf(value: unknown): string[] {
  const all = list(value).filter((ip): ip is string => typeof ip === "string" && isIP(ip) !== 0);
  return [...all.filter((ip) => isIP(ip) === 4), ...all.filter((ip) => isIP(ip) === 6)];
}

function nameOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.endsWith(".") ? value.slice(0, -1) : value;
  return DNS_NAME.test(name) ? name.toLowerCase() : undefined;
}

function peerOf(raw: unknown, users: Record<string, unknown> | undefined): TailnetPeer | undefined {
  const peer = record(raw);
  if (!peer || peer.ShareeNode === true) return undefined;
  const nodeId = text(peer.ID, STABLE_ID);
  const dnsName = nameOf(peer.DNSName);
  if (!nodeId || !dnsName) return undefined;
  const os = text(peer.OS, DISPLAY) ?? "";
  const keys = [
    ...new Set(
      list(peer.sshHostKeys)
        .map(parseAdvertisedHostKey)
        .filter((key) => key !== undefined),
    ),
  ];
  const online = peer.Online === true;
  const lastSeen = online ? undefined : text(peer.LastSeen, TIME);
  const userId = typeof peer.UserID === "number" ? String(peer.UserID) : undefined;
  const owner = userId ? text(record(users?.[userId])?.LoginName, LOGIN) : undefined;
  return {
    nodeId,
    dnsName,
    hostName: text(peer.HostName, DISPLAY) ?? "",
    os,
    online,
    // Go's zero time means "never".
    ...(lastSeen && !lastSeen.startsWith("0001-") ? { lastSeen } : {}),
    addresses: addressesOf(peer.TailscaleIPs),
    tags: list(peer.Tags).filter((tag): tag is string => typeof tag === "string" && TAG.test(tag)),
    ...(owner ? { owner } : {}),
    sharedIn: typeof peer.AltSharerUserID === "number" && peer.AltSharerUserID !== 0,
    sshHostKeys: keys,
    tailscaleSsh: keys.length > 0,
    hostSupported: os.toLowerCase() === "linux",
  };
}

/**
 * Read `tailscale status --json` output. Strict: the client must say it is running, and only
 * peers with a well-formed stable ID and MagicDNS name are listed; every other field is checked
 * and dropped when malformed. Unknown fields are ignored, since the format is the client's.
 */
export function parseTailnetStatus(json: string): TailnetRead {
  let status: Record<string, unknown> | undefined;
  try {
    status = record(JSON.parse(json));
  } catch {
    return { state: "error", detail: "Tailscale's status could not be read" };
  }
  if (!status) return { state: "error", detail: "Tailscale's status could not be read" };
  switch (status.BackendState) {
    case "Running":
      break;
    case "NeedsLogin":
    case "NeedsMachineAuth":
      return { state: "signed-out" };
    case "Stopped":
    case "Starting":
    case "NoState":
      return { state: "stopped" };
    default:
      return { state: "error", detail: "Tailscale reported an unknown state" };
  }
  const users = record(status.User);
  const peers = Object.values(record(status.Peer) ?? {})
    .map((peer) => peerOf(peer, users))
    .filter((peer) => peer !== undefined);
  // Two entries claiming one stable ID or one name are not trustworthy as either: drop both.
  const count = (key: (peer: TailnetPeer) => string) => {
    const seen = new Map<string, number>();
    for (const peer of peers) seen.set(key(peer), (seen.get(key(peer)) ?? 0) + 1);
    return seen;
  };
  const ids = count((peer) => peer.nodeId);
  const names = count((peer) => peer.dnsName);
  const tailnet = record(status.CurrentTailnet);
  const self = record(status.Self);
  const selfId = text(self?.ID, STABLE_ID);
  const selfName = nameOf(self?.DNSName);
  const suffix = nameOf(tailnet?.MagicDNSSuffix ?? status.MagicDNSSuffix);
  return {
    state: "running",
    snapshot: {
      ...(text(tailnet?.Name, DISPLAY) ? { tailnetName: tailnet!.Name as string } : {}),
      ...(suffix ? { magicDnsSuffix: suffix } : {}),
      ...(selfId && selfName ? { self: { nodeId: selfId, dnsName: selfName } } : {}),
      peers: peers
        .filter((peer) => ids.get(peer.nodeId) === 1 && names.get(peer.dnsName) === 1 && peer.nodeId !== selfId)
        .sort((a, b) => a.dnsName.localeCompare(b.dnsName)),
    },
  };
}

/**
 * How one run of the CLI ended. `exited`: it ran to its own exit, with that code and what it
 * printed. `failed`: it never ran (`missing` when there is no file), or was stopped (`timeout`,
 * `too-large` past the output cap, `killed` by a signal): its output is never read.
 */
export type TailscaleRun =
  | { kind: "exited"; code: number; stdout: string }
  | { kind: "failed"; reason: "missing" | "timeout" | "too-large" | "killed" | "spawn" };

/** Runs the CLI. Never rejects: every failure is a `failed` run. */
export type TailscaleRunner = (file: string, args: readonly string[]) => Promise<TailscaleRun>;

const execRunner: TailscaleRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: STATUS_TIMEOUT_MS, maxBuffer: STATUS_MAX_BYTES, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (!error) return resolve({ kind: "exited", code: 0, stdout });
        const code = (error as { code?: unknown }).code;
        if (code === "ENOENT") return resolve({ kind: "failed", reason: "missing" });
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ kind: "failed", reason: "too-large" });
        if (error.killed) return resolve({ kind: "failed", reason: "timeout" });
        if (error.signal) return resolve({ kind: "failed", reason: "killed" });
        if (typeof code === "number") return resolve({ kind: "exited", code, stdout });
        resolve({ kind: "failed", reason: "spawn" });
      },
    );
  });

export interface ReadTailnetOptions {
  platform?: NodeJS.Platform;
  /** Tests: another CLI path. The product always uses `TAILSCALE_CLI`. */
  cliPath?: string;
  run?: TailscaleRunner;
  /** Whether the CLI file exists; defaults to the file system. */
  exists?: (path: string) => boolean;
  /** The flag context; defaults to the process environment. */
  features?: FeatureContext;
}

/**
 * The local tailnet, read once. Never throws: every failure is an unavailable state, so a missing
 * or broken Tailscale client hides the list and changes nothing else.
 */
export async function readTailnet(options: ReadTailnetOptions = {}): Promise<TailnetRead> {
  if (!tailnetEnabled(options.features)) return { state: "off" };
  const cli = options.cliPath ?? TAILSCALE_CLI[options.platform ?? process.platform];
  if (!cli || !(options.exists ?? existsSync)(cli)) return { state: "absent" };
  let run: TailscaleRun;
  try {
    run = await (options.run ?? execRunner)(cli, ["status", "--json"]);
  } catch {
    return { state: "error", detail: "Tailscale did not answer" };
  }
  if (run.kind === "failed")
    return run.reason === "missing"
      ? { state: "absent" }
      : {
          state: "error",
          detail: run.reason === "too-large" ? "Tailscale's status is too large" : "Tailscale did not answer",
        };
  // `status --json` prints the state and exits 0 whatever it is, stopped and signed out included.
  // A non-zero exit means it could not reach its daemon (tailscaled not running): never a snapshot,
  // whatever it printed.
  if (run.code !== 0) return { state: "stopped" };
  if (Buffer.byteLength(run.stdout) > STATUS_MAX_BYTES)
    return { state: "error", detail: "Tailscale's status is too large" };
  return parseTailnetStatus(run.stdout);
}

// ---------------------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------------------

export type TailnetResolution =
  | {
      ok: true;
      peer: TailnetPeer;
      /** The host to hand ssh: the node's current Tailscale IPv4 address, or `[IPv6]`. */
      host: string;
      /** The node's MagicDNS name changed since the profile was saved (still the same node). */
      renamed: boolean;
    }
  | {
      ok: false;
      code: "node-gone" | "different-machine" | "offline" | "no-address";
      message: string;
    };

/**
 * Where a bound profile connects now. The address always comes from the stable node ID, never
 * from the name: a name now held by another node is a different machine, and a node that is no
 * longer on the tailnet fails closed instead of falling back to the typed host.
 */
export function resolveTailnetBinding(snapshot: TailnetSnapshot, binding: TailnetBinding): TailnetResolution {
  const peer = snapshot.peers.find((candidate) => candidate.nodeId === binding.node);
  if (!peer) {
    const holder = snapshot.peers.find((candidate) => candidate.dnsName === binding.name.toLowerCase());
    return holder
      ? {
          ok: false,
          code: "different-machine",
          message: `${binding.name} is now a different machine on your tailnet. Pick the machine again to connect.`,
        }
      : {
          ok: false,
          code: "node-gone",
          message: `${binding.name} is no longer on your tailnet.`,
        };
  }
  if (!peer.online) return { ok: false, code: "offline", message: `${peer.dnsName} is offline on your tailnet.` };
  const address = peer.addresses[0];
  if (!address) return { ok: false, code: "no-address", message: `${peer.dnsName} has no Tailscale address.` };
  return {
    ok: true,
    peer,
    host: isIP(address) === 6 ? `[${address}]` : address,
    renamed: peer.dnsName !== binding.name.toLowerCase(),
  };
}

/**
 * The tunnel's `resolveHost` for a profile bound to `binding`: reads the tailnet on every
 * connect and answers the node's current address, or refuses. A client that is off, absent or
 * signed out is `tailnet-unavailable`; a node that is gone or replaced is `tailnet-moved`, which
 * needs the person; an offline node is `tailnet-offline`.
 */
export function tailnetHostResolver(binding: TailnetBinding, options: ReadTailnetOptions = {}): () => Promise<string> {
  return async () => {
    const read = await readTailnet(options);
    if (read.state !== "running") throw new TunnelRefusal("tailnet-unavailable");
    const resolved = resolveTailnetBinding(read.snapshot, binding);
    if (resolved.ok) return resolved.host;
    switch (resolved.code) {
      case "node-gone":
      case "different-machine":
        throw new TunnelRefusal("tailnet-moved");
      case "offline":
        throw new TunnelRefusal("tailnet-offline");
      case "no-address":
        throw new TunnelRefusal("tailnet-unavailable");
    }
  };
}

/** The binding to save for a peer picked from the list. */
export function bindingFor(peer: TailnetPeer): TailnetBinding {
  return { node: peer.nodeId, name: peer.dnsName };
}

// ---------------------------------------------------------------------------------------
// Advertised host keys
// ---------------------------------------------------------------------------------------

/**
 * How a presented key compares with what the tailnet advertises for that node.
 * - `match`: the key ssh saw is one the node advertises.
 * - `mismatch`: the node advertises keys and this is none of them. Refuse, as for a changed pin.
 * - `none-advertised`: no Tailscale SSH (or a client that does not advertise): use the
 *   ordinary confirm-the-fingerprint flow, unchanged.
 */
export type AdvertisedKeyCheck = "match" | "mismatch" | "none-advertised";

/** Compare the `SHA256:…` fingerprint ssh reported with the peer's advertised keys. */
export function checkAdvertisedHostKey(peer: TailnetPeer, presentedFingerprint: string): AdvertisedKeyCheck {
  if (!peer.sshHostKeys.length) return "none-advertised";
  return peer.sshHostKeys.some((key) => hostKeyFingerprint(key) === presentedFingerprint) ? "match" : "mismatch";
}

/** Thrown when a pin file cannot be seeded from the tailnet. */
export class AdvertisedPinRefused extends Error {
  override readonly name = "AdvertisedPinRefused";
}

/**
 * Seed a profile's pin file with the node's advertised host keys, under the alias ssh checks it
 * by (`HostKeyAlias`, `orca-<profile id>`), and mark it enrolled. Only into a pin file that was
 * never enrolled (`pinState` `none`): an existing pin is never replaced from the tailnet, since a
 * changed key must stay a refusal the person resolves. From then on the tunnel runs with
 * `StrictHostKeyChecking=yes`, so a server that presents any other key is refused by ssh itself.
 */
export function writeAdvertisedPin(
  knownHostsFile: string,
  hostKeyAlias: string,
  peer: TailnetPeer,
  /**
   * The caller's explicit choice to take the tailnet's coordination server's word for this host's
   * keys (a person chose it, or a flow that shows "advertised by your tailnet" and has them
   * confirm). Anything else refuses, so manual confirmation stays the default.
   */
  trust: { source: "tailnet-advertised" },
): void {
  if (trust?.source !== "tailnet-advertised")
    throw new AdvertisedPinRefused("Pinning from the tailnet needs an explicit choice to trust it");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(hostKeyAlias)) throw new AdvertisedPinRefused("Unsupported host key alias");
  // Shared in from another tailnet: that tailnet's coordination server is not the user's own.
  if (peer.sharedIn)
    throw new AdvertisedPinRefused(`${peer.dnsName} is shared from another tailnet: confirm its fingerprint instead`);
  if (!Array.isArray(peer.sshHostKeys) || !peer.sshHostKeys.length)
    throw new AdvertisedPinRefused(`${peer.dnsName} advertises no SSH host keys: confirm its fingerprint instead`);
  // Checked again here, whoever built the peer: only canonical `<type> <base64>` keys are written.
  const keys = peer.sshHostKeys.map((key) => parseAdvertisedHostKey(key));
  if (keys.some((key, index) => key === undefined || key !== peer.sshHostKeys[index]))
    throw new AdvertisedPinRefused(
      `${peer.dnsName} advertises a host key ORCA cannot use: confirm its fingerprint instead`,
    );
  if (pinState(knownHostsFile) !== "none")
    throw new AdvertisedPinRefused(
      "This profile already has a pinned host key; reset it before pinning from the tailnet",
    );
  mkdirSync(dirname(knownHostsFile), { recursive: true });
  const lines = [...new Set(keys as string[])].map((key) => `${hostKeyAlias} ${key}\n`).join("");
  writeFileSync(knownHostsFile, lines, { mode: 0o600, flag: "wx" });
  markPinEnrolled(knownHostsFile);
}
