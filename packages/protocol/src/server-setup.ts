/**
 * Add a machine as a managed ORCA server in one step (#881): the client's side, shared by the
 * desktop app ("Add a machine") and `orca remote add`.
 *
 * The work happens on the server, in `tools/deploy/orca-server-setup.py`, which the app sends
 * over the profile's own pinned ssh as `python3 - ARGS` with the managed adapter
 * (`orca-release.py`) embedded ahead of it: nothing is copied by hand, and nothing but this
 * app's own two files ever runs. The setup installs exactly the documented bootstrap
 * (docs/UPDATING.md), staging the signed server bundle with the adapter's `stage --bundle`,
 * and reports each step as one `orca-setup: {json}` line. This module builds that program and
 * reads those lines; nothing else the server prints is shown or kept.
 *
 * Nothing is installed on a key nobody confirmed (#881 review): `discoverServer` connects
 * read-only, with a first-seen key held in a scratch pin file rather than enrolled, and runs
 * the setup's `--inspect`, which changes nothing. The person then confirms exactly what it
 * found: the server's (and jump host's) key fingerprints, the account, the version and what
 * will be done (`confirmationCode` binds them). Only then are those keys enrolled
 * (`enrollDiscovered`), and the setup runs over a pinned-only connection that carries nothing
 * unless its pins vouch for exactly the confirmed keys, as exactly the confirmed account.
 */
import { createHash } from "node:crypto";
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  markPinEnrolled,
  pinState,
  TunnelRefusal,
  type ConnectionProfile,
  type RemoteResult,
  type SshTunnelOptions,
} from "./remote-access.js";
import { parseAdvertisedHostKey } from "./tailnet.js";

/** The two files, as shipped: `server-setup/` in a packaged app, `tools/deploy/` in a checkout. */
export const SETUP_SCRIPT = "orca-server-setup.py";
export const SETUP_ADAPTER = "orca-release.py";

/** Setup downloads and verifies a bundle and runs its checks: minutes, not seconds. */
export const SETUP_TIMEOUT_MS = 30 * 60_000;

const VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?$/;

/** The program `python3 -` runs: the adapter embedded, then the setup itself. */
export function setupProgram(dir: string): string {
  const adapter = readFileSync(join(dir, SETUP_ADAPTER));
  const setup = readFileSync(join(dir, SETUP_SCRIPT), "utf8");
  return `EMBEDDED_ADAPTER = "${adapter.toString("base64")}"\n${setup}`;
}

/** A server account name, as one remote word. */
const ACCOUNT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/** A canonical absolute directory on the server, as one remote word. */
const SERVER_DIR = /^\/[A-Za-z0-9._/-]{0,1023}$/;

/** What the person confirmed about the server, which the setup rechecks there before any change. */
export interface ConfirmedServer {
  /** The effective account. */
  account: string;
  /** The canonical setup directory. */
  root: string;
  /** The version a repair expects selected, or `null` for a first install. */
  current: string | null;
}

/**
 * The server version to install: the app's own, so client and server are one release. Only
 * as confirmed: the setup refuses, before it changes anything, unless it runs as that
 * effective account, in that canonical directory, as that kind of run (install or repair).
 */
export function setupCommand(
  version: string,
  port: number,
  confirmed: ConfirmedServer,
  /**
   * A directory on the server holding the bundle the client carried (#1234), with the pinned
   * cosign and trusted root, for a host with no internet access: an offline stage.
   */
  bundleDir?: string,
): string[] {
  if (bundleDir !== undefined && (!SERVER_DIR.test(bundleDir) || bundleDir.split("/").includes("..")))
    throw new Error(`Not a bundle directory: ${bundleDir}`);
  if (!VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  if (!ACCOUNT.test(confirmed.account)) throw new Error(`Not an account name: ${confirmed.account}`);
  if (!SERVER_DIR.test(confirmed.root) || confirmed.root.split("/").includes(".."))
    throw new Error(`Not a setup directory: ${confirmed.root}`);
  if (confirmed.current !== null && !VERSION.test(confirmed.current))
    throw new Error(`Not a release version: ${confirmed.current}`);
  return [
    "python3",
    "-",
    "--version",
    version,
    "--port",
    String(port),
    "--expect-account",
    confirmed.account,
    "--expect-root",
    confirmed.root,
    "--expect-current",
    confirmed.current ?? "none",
    // Only the courier passes a directory, and it carries cosign and the pinned trusted root too.
    ...(bundleDir !== undefined ? ["--bundle", bundleDir, "--offline-bundle"] : []),
  ];
}

/** The read-only check the person's confirmation is based on. */
export function inspectCommand(version: string, port: number): string[] {
  if (!VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  return ["python3", "-", "--version", version, "--port", String(port), "--inspect"];
}

/** Inspection reads the server and the release directory: a minute or two at most. */
export const INSPECT_TIMEOUT_MS = 2 * 60_000;

export const SETUP_RESULTS = ["ok", "changed", "repaired", "warning", "refused", "failed"] as const;
const StepSchema = z.object({
  step: z.string().max(40),
  result: z.enum(SETUP_RESULTS),
  detail: z.string().max(4000).default(""),
});
export type SetupStep = z.infer<typeof StepSchema>;
const DoneSchema = z.object({
  done: z.literal(true),
  root: z.string().max(1024),
  command: z.string().max(1024),
  account: z.string().max(64),
  version: z.string().regex(VERSION),
  port: z.number().int().min(1024).max(65535),
});

/** What one run of the setup made of the server. */
export type SetupOutcome =
  | {
      kind: "ready";
      steps: SetupStep[];
      command: string;
      version: string;
      port: number;
      account: string;
      root: string;
    }
  /**
   * The server reported something other than what was confirmed (another version, port,
   * account, directory or launcher): nothing is saved from it, and nothing signs in.
   */
  | { kind: "mismatch"; steps: SetupStep[]; detail: string }
  /** Something only the person can resolve (an unmanaged installation, say): nothing changed for it. */
  | { kind: "refused"; steps: SetupStep[]; step: string; detail: string }
  /** A step failed; what this run created was taken back. */
  | { kind: "failed"; steps: SetupStep[]; step: string; detail: string }
  /** No Python 3 on the server. */
  | { kind: "no-python"; steps: SetupStep[] }
  /**
   * The setup did not report how it ended (the session was lost, say), or could not confirm
   * that a failed run put everything back (`detail`): run it again, which finishes that first.
   */
  | { kind: "unknown"; steps: SetupStep[]; detail?: string };

const InspectedSchema = z.object({
  inspected: z.literal(true),
  account: z.string().regex(ACCOUNT),
  root: z.string().regex(SERVER_DIR),
  current: z.string().regex(VERSION).nullable(),
});
export type Inspected = z.infer<typeof InspectedSchema>;

/** What a read-only inspection found: ready to confirm, or why not. */
export type InspectOutcome =
  | { kind: "inspected"; steps: SetupStep[]; inspected: Inspected }
  | Exclude<SetupOutcome, { kind: "ready" } | { kind: "mismatch" }>;

function readLines(result: RemoteResult): { steps: SetupStep[]; values: unknown[] } {
  const steps: SetupStep[] = [];
  const values: unknown[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("orca-setup: ")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice("orca-setup: ".length));
    } catch {
      continue;
    }
    const step = StepSchema.safeParse(value);
    if (step.success) steps.push(step.data);
    else values.push(value);
  }
  return { steps, values };
}

function notReady(
  result: RemoteResult,
  steps: SetupStep[],
): Exclude<SetupOutcome, { kind: "ready" } | { kind: "mismatch" }> {
  // After a failure the setup puts back what it changed and says whether that is confirmed.
  const cleanup = steps.at(-1)?.step === "cleanup" ? steps.at(-1) : undefined;
  const last = cleanup ? steps.at(-2) : steps.at(-1);
  if (cleanup && cleanup.result !== "ok") return { kind: "unknown", steps, detail: cleanup.detail };
  if (last?.result === "refused") return { kind: "refused", steps, step: last.step, detail: last.detail };
  // Failed is only failed once the put-back is confirmed; otherwise nobody knows the state.
  if (last?.result === "failed")
    return cleanup
      ? { kind: "failed", steps, step: last.step, detail: last.detail }
      : { kind: "unknown", steps, detail: last.detail };
  // `python3` not found by the remote shell: 127, and nothing of ours was printed.
  if (!steps.length && result.code === 127) return { kind: "no-python", steps };
  return { kind: "unknown", steps };
}

const ended = (steps: SetupStep[]) => steps.some((s) => s.result === "refused" || s.result === "failed");

/** Read the setup's own lines; anything else on its output is ignored. */
export function readSetup(result: RemoteResult): SetupOutcome {
  const { steps, values } = readLines(result);
  const done = values.map((value) => DoneSchema.safeParse(value)).findLast((parsed) => parsed.success)?.data;
  if (result.code === 0 && done && !ended(steps))
    return {
      kind: "ready",
      steps,
      command: done.command,
      version: done.version,
      port: done.port,
      account: done.account,
      root: done.root,
    };
  return notReady(result, steps);
}

/** The managed launcher a setup in `root` installs: derived here, never taken from the server. */
export function managedLauncher(root: string): string {
  return `${root.replace(/\/+$/, "")}/orca`;
}

/**
 * A ready result counts only as the setup that was confirmed: exactly the version, daemon
 * port, account and directory, and the launcher derived from that directory here. Anything
 * else is a `mismatch`, from which nothing may be saved or signed in to.
 */
export function confirmedResult(
  outcome: SetupOutcome,
  expected: { version: string; port: number; account: string; root: string },
): SetupOutcome {
  if (outcome.kind !== "ready") return outcome;
  const differs = [
    outcome.version !== expected.version && `version ${outcome.version}, not ${expected.version}`,
    outcome.port !== expected.port && `port ${outcome.port}, not ${expected.port}`,
    outcome.account !== expected.account && `account ${outcome.account}, not ${expected.account}`,
    outcome.root !== expected.root && `directory ${outcome.root}, not ${expected.root}`,
    outcome.command !== managedLauncher(expected.root) &&
      `launcher ${outcome.command}, not ${managedLauncher(expected.root)}`,
  ].filter((item): item is string => typeof item === "string");
  return differs.length
    ? {
        kind: "mismatch",
        steps: outcome.steps,
        detail: `The server reported a setup other than the one confirmed (${differs.join("; ")}).`,
      }
    : outcome;
}

/** Read an `--inspect` run's lines. */
export function readInspection(result: RemoteResult): InspectOutcome {
  const { steps, values } = readLines(result);
  const inspected = values.map((value) => InspectedSchema.safeParse(value)).findLast((p) => p.success)?.data;
  if (result.code === 0 && inspected && !ended(steps)) return { kind: "inspected", steps, inspected };
  return notReady(result, steps);
}

/** The SHA-256 fingerprints (as `ssh-keygen -l` prints them) of one hop's pinned keys. */
function fingerprintsOf(keys: string | null): string[] {
  if (!keys) return [];
  return keys.split("\n").map((line) => {
    const [type, blob] = line.split(" ");
    const digest = createHash("sha256")
      .update(Buffer.from(blob ?? "", "base64"))
      .digest("base64");
    return `${type} SHA256:${digest.replace(/=+$/, "")}`;
  });
}

/** The fingerprints a tunnel's key identity (`SshTunnel.pinnedKeys`) vouches for. */
export function keyFingerprints(keys: string): { server: string[]; jump?: string[] } {
  const [server, jump] = JSON.parse(keys) as [string | null, string | null];
  return { server: fingerprintsOf(server), ...(jump !== null ? { jump: fingerprintsOf(jump) } : {}) };
}

/** What a confirmed setup may do: install the server, and (in the app) then sign in to it. */
export type SetupScope = "install" | "install-and-sign-in";

export interface Confirmation {
  /** The connection: destination, ports, identity file and jump host, as the profile names them. */
  profile: ConnectionProfile;
  /** The profile's revision when inspected, in the app: a changed profile needs a new confirmation. */
  revision?: number;
  /** The keys the person saw (`SshTunnel.pinnedKeys` of the inspecting connection). */
  keys: string;
  /** The effective account, canonical directory and install-or-repair the inspection found. */
  account: string;
  root: string;
  current: string | null;
  version: string;
  scope: SetupScope;
}

/**
 * A short code bound to everything the person confirms. The CLI prints it and takes it back
 * (`--confirm`), checked against a fresh inspection; the app holds the confirmation itself.
 */
export function confirmationCode(confirmation: Confirmation): string {
  const { profile } = confirmation;
  const bound = JSON.stringify([
    profile.id,
    profile.destination,
    profile.sshPort ?? null,
    profile.identityFile ?? null,
    profile.jump ?? null,
    profile.remotePort,
    confirmation.revision ?? null,
    confirmation.keys,
    confirmation.account,
    confirmation.root,
    confirmation.current,
    confirmation.version,
    confirmation.scope,
  ]);
  const hex = createHash("sha256").update(bound).digest("hex").slice(0, 12);
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8)}`;
}

/** What `tunnel` needs to be for discovery and setup: the parts of `SshTunnel` they use. */
export interface SetupTunnel {
  open(): Promise<string>;
  exec(command: readonly string[], timeoutMs?: number, input?: string): Promise<RemoteResult>;
  /** Copy a local file to the server (`SshTunnel.upload`, #1234); needed only to push a bundle. */
  upload?(localPath: string, remotePath: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  readonly pinnedKeys: string | undefined;
}

export interface Discovery {
  outcome: InspectOutcome;
  /** The keys the inspecting connection was sealed with. */
  keys: string;
  /** Not pinned yet: the keys wait in a scratch pin file until the person confirms them. */
  firstUse: boolean;
  /** The scratch pin file, when `firstUse`: enrolled by `enrollDiscovered`, or dropped. */
  scratch?: string;
  /**
   * The server's keys were the ones its tailnet advertises (#1227): the scratch pin held exactly
   * those before ssh connected, so ssh refused any other key. Still confirmed by the person.
   */
  advertised?: true;
}

/**
 * Connect without enrolling anything, and inspect. A server (and jump host) already pinned is
 * reached pinned-only. One not pinned yet is reached through a scratch copy of its pins, so a
 * first-seen key is learned, shown and confirmed before it is ever trusted for the profile. A
 * pin that went missing after enrollment refuses, as everywhere else.
 */
export async function discoverServer(options: {
  base: SshTunnelOptions;
  tunnel: (options: SshTunnelOptions) => SetupTunnel;
  version: string;
  program: string;
  /**
   * Host keys the server's tailnet advertises (#1227), each `<type> <base64>`, with the alias the
   * tunnel checks them under (`orca-<profile id>`). For a server not pinned yet they are written
   * into the scratch pin before ssh connects, so ssh checks the server against them strictly
   * instead of learning a first-seen key. Ignored for a server already pinned.
   */
  advertised?: { alias: string; keys: readonly string[] };
}): Promise<Discovery> {
  const { base } = options;
  const real = base.knownHostsFile;
  const hops = base.profile.jump ? [real, `${real}.jump`] : [real];
  const states = hops.map((file) => pinState(file));
  if (states.includes("broken")) throw new TunnelRefusal("host-key-missing");
  const firstUse = states.includes("none");
  let scratch: string | undefined;
  let knownHostsFile = real;
  if (firstUse) {
    scratch = mkdtempSync(join(tmpdir(), "orca-discover-"));
    knownHostsFile = join(scratch, "pin");
    // A hop already pinned stays checked against its pin.
    hops.forEach((file, i) => {
      if (states[i] === "pinned") copyFileSync(file, i === 0 ? knownHostsFile : `${knownHostsFile}.jump`);
    });
  }
  const advertised =
    firstUse && states[0] === "none" && options.advertised?.keys.length ? options.advertised : undefined;
  if (advertised) {
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(advertised.alias) ||
      advertised.keys.some((key) => parseAdvertisedHostKey(key) !== key)
    ) {
      rmSync(scratch!, { recursive: true, force: true });
      throw new Error("Unusable advertised host keys");
    }
    writeFileSync(knownHostsFile, advertised.keys.map((key) => `${advertised.alias} ${key}\n`).join(""), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const tunnel = options.tunnel({
    ...base,
    knownHostsFile,
    ...(firstUse ? {} : { pinnedOnly: true }),
    markEnrolled: () => {},
  });
  try {
    await tunnel.open();
    const keys = tunnel.pinnedKeys;
    if (keys === undefined) throw new TunnelRefusal("host-key-missing");
    const outcome = readInspection(
      await tunnel.exec(inspectCommand(options.version, base.profile.remotePort), INSPECT_TIMEOUT_MS, options.program),
    );
    return {
      outcome,
      keys,
      firstUse,
      ...(knownHostsFile !== real ? { scratch: knownHostsFile } : {}),
      ...(advertised ? { advertised: true as const } : {}),
    };
  } catch (error) {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    throw error;
  } finally {
    await tunnel.close();
  }
}

/** Drop a discovery's scratch pins without enrolling them. */
export function dropDiscovery(discovery: Pick<Discovery, "scratch">): void {
  if (discovery.scratch) rmSync(join(discovery.scratch, ".."), { recursive: true, force: true });
}

/**
 * The person confirmed: enroll the discovered keys where the profile has no pin yet. A pin
 * that appeared meanwhile is left as it is; the setup's connection, sealed against exactly
 * the confirmed keys (`expectKeys`), refuses if it vouches for others.
 */
export function enrollDiscovered(discovery: Pick<Discovery, "scratch">, knownHostsFile: string, jump: boolean): void {
  if (!discovery.scratch) return;
  try {
    const pairs: [string, string][] = [[discovery.scratch, knownHostsFile]];
    if (jump) pairs.push([`${discovery.scratch}.jump`, `${knownHostsFile}.jump`]);
    for (const [from, to] of pairs) {
      if (pinState(to) !== "none") continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      markPinEnrolled(to);
    }
  } finally {
    dropDiscovery(discovery);
  }
}
