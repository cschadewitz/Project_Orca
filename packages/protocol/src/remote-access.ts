/**
 * Node-only remote access to a daemon over SSH (#874). Never exported from the renderer
 * protocol barrel: it spawns `ssh` and touches the file system.
 *
 * Shared by the desktop app's main process and, later, by the daemon itself (#883 delegates
 * steps to another daemon over the same transport), so it depends on nothing but Node and
 * Zod and takes every platform facility (the cipher, the ssh binary, spawn) as an argument.
 *
 * Three parts:
 *
 * - **Connection profiles**: the nonsecret description of a remote daemon as typed fields
 *   only (`user@host`, ssh port, key file, one jump host, the daemon's port on the remote
 *   loopback). No free-form ssh options, and no ssh config file is read.
 * - **`SshTunnel`**: one `ssh -F none -W 127.0.0.1:<daemon port>` per connection, so every
 *   connection that carries a credential is its own authenticated ssh channel (behind a
 *   jump host, through a persistent app-owned ssh to it), with each server's host key pinned
 *   in an app-owned known-hosts file on first connect and that pin as the only trust source,
 *   and distinct refusals for the ways it fails.
 * - **`CredentialSlots`**: one encrypted credential per profile. The cipher is the caller's
 *   (Electron `safeStorage` in the app); there is no plaintext fallback.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { Duplex, type Readable, type Writable } from "node:stream";
import { dirname, join } from "node:path";
import { z } from "zod";

/** The daemon's default port (`orca serve`). */
export const DEFAULT_REMOTE_DAEMON_PORT = 6722;

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const USER = "[A-Za-z0-9._][A-Za-z0-9._-]{0,63}";
const HOST = "(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|\\[[0-9A-Fa-f:.]+\\])";
/** `[user@]host`: no option-looking leading dash, no whitespace, nothing a shell would read. */
const DESTINATION = new RegExp(`^(?:${USER}@)?${HOST}$`);
/** An absolute key path, as ssh's `-i` takes it. No `~` (ORCA does not expand it), no quotes or newlines. */
const KEY_PATH = /^(?:\/|[A-Za-z]:[\\/])[^"\r\n\0]{1,1023}$/;

/**
 * One word of a command ORCA runs on the server. OpenSSH joins the words with spaces into one
 * command text for the remote shell, so each is restricted to characters that mean the same
 * literal text to sh, cmd and PowerShell alike: no quoting, escaping or expansion applies, and
 * nothing can be injected. No backslash (an escape to sh): Windows paths use `/`.
 */
const REMOTE_WORD = /^[A-Za-z0-9._:/-]{1,1024}$/;
/** An absolute path on the server, as one remote word (`C:/…` on Windows). */
const SERVER_PATH = /^(?:\/|[A-Za-z]:\/)[A-Za-z0-9._/-]{0,1023}$/;
/** The server's ORCA CLI: a command name on its PATH, or an absolute path such as a managed wrapper. */
const SERVER_COMMAND = /^(?:[A-Za-z0-9._-]{1,64}|(?:\/|[A-Za-z]:\/)[A-Za-z0-9._/-]{0,1023})$/;

const Port = z.number().int().min(1).max(65535);
/**
 * One SSH hop, as typed fields only. There is no free-form ssh argument and no ssh config
 * file: everything else about the connection is ORCA's (see `hopArgs`).
 */
const HopShape = {
  /** `user@host` or `host` (the OS user name is the default user). */
  destination: z.string().regex(DESTINATION, "Enter user@host or a host name"),
  sshPort: Port.optional(),
  /** A private key file. Absent: the keys your SSH agent offers. */
  identityFile: z.string().regex(KEY_PATH, "Enter the key file's full path").optional(),
};

export const ConnectionProfileSchema = z
  .object({
    id: z.string().regex(PROFILE_ID),
    name: z.string().trim().min(1).max(80),
    ...HopShape,
    /** One jump host. The tunnel to it is ORCA's own, with its own pinned host key. */
    jump: z.object(HopShape).strict().optional(),
    /** The daemon's port on the remote loopback. */
    remotePort: Port.default(DEFAULT_REMOTE_DAEMON_PORT),
    /**
     * The server's ORCA CLI, which issues and renews this profile's credential (#875): a
     * command on the server's PATH or an absolute path, such as a managed install's wrapper.
     * Default `orca`.
     */
    serverCommand: z.string().regex(SERVER_COMMAND, "Enter a command name or a full path without spaces").optional(),
    /** The daemon's workspace config on the server, passed as `--config`. Absent: the CLI's own default. */
    serverConfig: z.string().regex(SERVER_PATH, "Enter the config file's full path, without spaces").optional(),
    /** Observe only: the profile's credential is issued with the read-only `viewer` preset. */
    readOnly: z.boolean().optional(),
  })
  .strict();
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;
export type ConnectionProfileInput = z.input<typeof ConnectionProfileSchema>;

/** A profile id from a display name: stable, file-name safe, unique within `taken`. */
export function profileIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "daemon";
  let id = /^[a-z0-9]/.test(base) ? base : `p-${base}`;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// ---------------------------------------------------------------------------------------
// Tunnel
// ---------------------------------------------------------------------------------------

/**
 * The distinct ways a tunnel fails. Each has one fixed message: ssh's own stderr can carry
 * user names, paths and banners, so it is classified here and never shown or logged.
 */
export type TunnelRefusalCode =
  | "ssh-missing"
  | "host-key-changed"
  | "host-key-missing"
  | "pin-write-failed"
  | "auth-failed"
  | "unreachable"
  | "forward-failed"
  | "timeout"
  | "closed"
  | "ssh-failed";

const REFUSAL_MESSAGES: Record<TunnelRefusalCode, string> = {
  "ssh-missing":
    "No ssh client was found. Install OpenSSH (on Windows: Settings > Optional features > OpenSSH Client) and try again.",
  "host-key-changed":
    "The server's SSH host key does not match the key pinned for this profile. If the server was reinstalled or its key rotated on purpose, forget the pinned key and connect again; otherwise do not connect.",
  "host-key-missing":
    "The SSH host key pinned for this profile is missing, empty or unreadable. ORCA will not trust whatever key the server presents now: if you expect this, forget the pinned key and connect again; otherwise do not connect.",
  "pin-write-failed":
    "ORCA could not record this server's pinned host key on this computer, so it did not use the connection. Check that the app's data folder is writable and has free space, then connect again.",
  "auth-failed":
    "SSH authentication failed. ORCA uses your existing SSH keys and agent without prompting: check that `ssh <destination>` works without a password prompt.",
  unreachable: "The SSH server could not be reached. Check the host name, port and network.",
  "forward-failed":
    "SSH connected but could not open the local tunnel port. Another program may be using it; try again.",
  timeout: "The SSH connection did not finish opening in time.",
  closed: "The tunnel was closed.",
  "ssh-failed": "ssh exited before the tunnel opened.",
};

export class TunnelRefusal extends Error {
  override readonly name = "TunnelRefusal";
  constructor(readonly code: TunnelRefusalCode) {
    super(REFUSAL_MESSAGES[code]);
  }
}

/**
 * Classify ssh's stderr into one refusal. Only ssh's own error lines count: `-v` debug lines
 * mention every option and address it tried. Order matters: a changed key also says
 * "verification failed", and a dropped forward logs "Connection refused" for its channel.
 */
export function classifySshFailure(stderr: string): TunnelRefusalCode {
  stderr = stderr
    .split(/\r?\n/)
    .filter((line) => !/^debug\d:/.test(line) && !/^channel \d+: open failed/.test(line))
    .join("\n");
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for .* has changed/i.test(stderr))
    return "host-key-changed";
  // Before auth: Windows reports a taken port as "bind [127.0.0.1]:N: Permission denied".
  if (/cannot listen to port|Could not request local forwarding|Address already in use|^bind .*:/im.test(stderr))
    return "forward-failed";
  if (
    /Permission denied \(|Too many authentication failures|no matching host key type|Authentication failed/i.test(
      stderr,
    )
  )
    return "auth-failed";
  if (
    /Could not resolve hostname|Name or service not known|No route to host|Connection refused|Connection timed out|Network is unreachable|Operation timed out|Connection closed by|kex_exchange_identification|Connection reset/i.test(
      stderr,
    )
  )
    return "unreachable";
  return "ssh-failed";
}

/** Escape a path for an ssh `-o` value: `%` tokens, whitespace-split lists, Windows separators. */
export function sshOptionPath(path: string): string {
  if (/["\r\n]/.test(path)) throw new Error("Unsupported character in an ssh option path");
  return `"${path.replace(/\\/g, "/").replace(/%/g, "%%")}"`;
}

export type TunnelState =
  | { phase: "starting" }
  | { phase: "open"; localPort: number }
  | { phase: "reconnecting"; attempt: number; refusal: TunnelRefusalCode }
  | { phase: "failed"; refusal: TunnelRefusalCode }
  | { phase: "closed" };

export interface SshTunnelOptions {
  profile: ConnectionProfile;
  /**
   * The per-profile pin file for the daemon's server. Missing or empty: the first connect
   * pins (accept-new). A jump host has its own beside it, `<file>.jump`.
   */
  knownHostsFile: string;
  /** Default `ssh` from PATH. */
  sshBinary?: string;
  /** Test seam. */
  spawn?: (command: string, args: readonly string[]) => ChildProcess;
  /** Test seam over `markPinEnrolled`. */
  markEnrolled?: (knownHostsFile: string) => void;
  /** Test seam: pick the local port. Default: an ephemeral loopback port from the OS. */
  pickPort?: () => Promise<number>;
  /** How long each ssh may take to authenticate and bind. Default 30 s. */
  readyTimeoutMs?: number;
  /** Restart backoff after the tunnel was open. Default 1 s doubling to 30 s. */
  backoff?: { initialMs: number; maxMs: number };
  onState?: (state: TunnelState) => void;
  /**
   * Never trust a key on first use: every hop must already be pinned, or the tunnel refuses
   * `host-key-missing` before that hop's ssh starts. For administrative connections, such as
   * revoking a credential, that must reach the server the credential came from or nothing.
   */
  pinnedOnly?: boolean;
}

/** A failure that a restart cannot fix: it needs the person. */
const PERMANENT: ReadonlySet<TunnelRefusalCode> = new Set([
  "ssh-missing",
  "host-key-changed",
  "host-key-missing",
  "pin-write-failed",
  "auth-failed",
]);
const STDERR_TAIL = 16 * 1024;
/** The most a remote command may print: ORCA's CLI prints one small JSON record. */
const REMOTE_OUTPUT_LIMIT = 64 * 1024;
/** How long a command's output may keep flowing after ssh exited. */
const REMOTE_DRAIN_MS = 2_000;

/** What a command run on the server returned (see `SshTunnel.run`). */
export interface RemoteResult {
  code: number;
  stdout: string;
  /** The command's own error lines, without ssh's: to classify, never to show or log. */
  serverLines: string[];
}

/**
 * Where a pin file stands. `none`: never enrolled, so the next connect may pin whatever the
 * server presents (accept-new). `pinned`: a readable key is on file. `broken`: the pin was
 * enrolled before (its marker `<file>.enrolled` exists) or the file exists, but it is now
 * missing, empty or unreadable. A broken pin fails closed until `forgetPin` resets it:
 * otherwise deleting or truncating the file would silently re-enroll a new key.
 */
export type PinState = "none" | "pinned" | "broken";

export function pinState(knownHostsFile: string): PinState {
  let text: string;
  try {
    text = readFileSync(knownHostsFile, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return missing && !existsSync(enrollmentMarker(knownHostsFile)) ? "none" : "broken";
  }
  // A known_hosts line: `<host pattern> <key type> <base64 key>`.
  const keyLine = /^[^#\s]\S*\s+\S+\s+[A-Za-z0-9+/]+=*(\s|$)/m;
  return keyLine.test(text) ? "pinned" : "broken";
}

/**
 * The key a pin file vouches for, as `<type> <base64>` (one per line, sorted), or `undefined`
 * when the file holds none. What a credential is bound to: a reset pin is another server.
 */
export function pinnedKeyIdentity(knownHostsFile: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(knownHostsFile, "utf8");
  } catch {
    return undefined;
  }
  const keys = [...text.matchAll(/^[^#\s]\S*\s+(\S+)\s+([A-Za-z0-9+/]+=*)(?:\s|$)/gm)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  return keys.length ? [...new Set(keys)].sort().join("\n") : undefined;
}

/** True only for a usable pin; `broken` is not pinned. */
export function pinnedHostKey(knownHostsFile: string): boolean {
  return pinState(knownHostsFile) === "pinned";
}

function enrollmentMarker(knownHostsFile: string): string {
  return `${knownHostsFile}.enrolled`;
}

/** Record that this pin file was enrolled, so a later loss of it fails closed. */
export function markPinEnrolled(knownHostsFile: string): void {
  if (pinState(knownHostsFile) !== "pinned" || existsSync(enrollmentMarker(knownHostsFile))) return;
  writeFileSync(enrollmentMarker(knownHostsFile), "enrolled\n", { mode: 0o600 });
}

/** The explicit reset: the next connect enrolls whatever key the server presents. */
export function forgetPin(knownHostsFile: string): void {
  rmSync(knownHostsFile, { force: true });
  rmSync(enrollmentMarker(knownHostsFile), { force: true });
}

/** One ssh process: who to reach, which pin and alias to check it against, what to forward. */
export interface HopSpec {
  /** `[user@]host` to hand ssh. For the hop behind a jump host, `[user@]127.0.0.1`. */
  target: string;
  port?: number | undefined;
  identityFile?: string | undefined;
  knownHostsFile: string;
  /** The name the pin is recorded under, independent of the address ssh dials. */
  hostKeyAlias: string;
  /** A persistent `-L` forward, `127.0.0.1:<local>:<host>:<port>` (the jump host). */
  forward?: string | undefined;
  /** Or one connection's `-W <host>:<port>`, carried on stdin/stdout (the daemon). */
  stdio?: string | undefined;
}

/** Thrown before ssh starts when a remote command word could be read by a shell. */
export class RemoteCommandRefused extends Error {
  override readonly name = "RemoteCommandRefused";
}

/** The argv for running `command` on the hop's server instead of forwarding (see `hopArgs`). */
export function commandArgs(hop: HopSpec, command: readonly string[]): string[] {
  if (!command.length) throw new RemoteCommandRefused("No remote command");
  for (const word of command)
    if (!REMOTE_WORD.test(word)) throw new RemoteCommandRefused("A remote command word has unsupported characters");
  const args = hopArgs({ ...hop, stdio: "-" });
  const w = args.indexOf("-W");
  return [...args.slice(0, w), ...args.slice(w + 2), ...command];
}

/** A profile's ssh processes: the optional persistent jump, and the per-connection daemon hop. */
export interface TunnelHops {
  jump?: HopSpec | undefined;
  daemon: HopSpec;
}

/**
 * The full argv for one hop. Nothing from an ssh config file applies (`-F none`: not the
 * user's, not the system's), so `Host *` blocks, `Include`, `Match exec`, `ProxyCommand`,
 * `LocalCommand`, extra forwards and other trust sources cannot change the tunnel. Every
 * option that matters is set here, and the pin file is both the user and the global
 * known-hosts source, so the pin is the only host trust.
 */
export function hopArgs(hop: HopSpec): string[] {
  const pins = sshOptionPath(hop.knownHostsFile);
  const options = [
    "BatchMode=yes",
    "ExitOnForwardFailure=yes",
    `StrictHostKeyChecking=${pinnedHostKey(hop.knownHostsFile) ? "yes" : "accept-new"}`,
    `UserKnownHostsFile=${pins}`,
    `GlobalKnownHostsFile=${pins}`,
    `HostKeyAlias=${hop.hostKeyAlias}`,
    "CheckHostIP=no",
    "UpdateHostKeys=no",
    "VerifyHostKeyDNS=no",
    "CanonicalizeHostname=no",
    "ProxyCommand=none",
    "ProxyJump=none",
    "ControlMaster=no",
    "ControlPath=none",
    "ForwardAgent=no",
    "ForwardX11=no",
    "PermitLocalCommand=no",
    "ClearAllForwardings=no",
    "Tunnel=no",
    "AddKeysToAgent=no",
    "ConnectTimeout=15",
    "ServerAliveInterval=15",
    "ServerAliveCountMax=3",
    ...(hop.identityFile ? ["IdentitiesOnly=yes"] : []),
  ];
  return [
    "-F",
    "none",
    ...(hop.stdio ? [] : ["-N"]),
    "-T",
    // `-v` is what tells ORCA the forward is bound ("Entering interactive session") and which
    // host key the server presented. Its output is parsed, never shown or logged.
    "-v",
    ...options.flatMap((option) => ["-o", option]),
    // `-i` goes through ssh's `%` token expansion; the path is absolute, so no `~`.
    ...(hop.identityFile ? ["-i", hop.identityFile.replace(/%/g, "%%")] : []),
    ...(hop.port ? ["-p", String(hop.port)] : []),
    ...(hop.stdio ? ["-W", hop.stdio] : ["-L", hop.forward ?? ""]),
    "--",
    hop.target,
  ];
}

function hostOf(destination: string): string {
  return destination.slice(destination.lastIndexOf("@") + 1);
}
function userOf(destination: string): string | undefined {
  const at = destination.lastIndexOf("@");
  return at < 0 ? undefined : destination.slice(0, at);
}

/**
 * The ssh processes for a profile. The daemon hop is one `ssh -W 127.0.0.1:<daemon port>`
 * per connection. Behind a jump host, a persistent ssh to the jump host forwards a private
 * loopback port to the server's sshd, and each daemon hop reaches the server through that
 * port; each server has its own pinned key. Exported for tests.
 */
export function tunnelHops(profile: ConnectionProfile, knownHostsFile: string, jumpPort?: number): TunnelHops {
  const server = {
    identityFile: profile.identityFile,
    knownHostsFile,
    hostKeyAlias: `orca-${profile.id}`,
    stdio: `127.0.0.1:${profile.remotePort}`,
  };
  if (!profile.jump) return { daemon: { ...server, target: profile.destination, port: profile.sshPort } };
  if (!jumpPort) throw new Error("A jump host needs a private loopback port");
  const user = userOf(profile.destination);
  return {
    jump: {
      target: profile.jump.destination,
      port: profile.jump.sshPort,
      identityFile: profile.jump.identityFile,
      knownHostsFile: `${knownHostsFile}.jump`,
      hostKeyAlias: `orca-${profile.id}-jump`,
      forward: `127.0.0.1:${jumpPort}:${hostOf(profile.destination)}:${profile.sshPort ?? 22}`,
    },
    daemon: { ...server, target: user ? `${user}@127.0.0.1` : "127.0.0.1", port: jumpPort },
  };
}

export async function ephemeralLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("No ephemeral port"))));
    });
  });
}

/** The jump host's ssh, one start of it: whether it is bound and still alive. */
interface Generation {
  children: ChildProcess[];
  ready: boolean;
  lost: boolean;
}

/** One `ssh -W` stream to the daemon: one TCP connection's worth of authenticated channel. */
interface Stream {
  child: ChildProcess;
  socket?: Duplex;
  authenticated: boolean;
  /** Refused after ssh authenticated (the pin could not be recorded): already reported. */
  refused?: boolean;
  /** Settles once ssh has authenticated the server against its pin (or failed to). */
  ready: Promise<void>;
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * The socket-like surface `http.Agent` and `ws` touch on a connection they did not dial.
 * A stdio stream has no TCP options; these are no-ops.
 */
function asSocket(stream: Duplex): Duplex {
  const socket = stream as Duplex & Record<string, unknown>;
  const self = () => socket;
  for (const method of ["setKeepAlive", "setNoDelay", "setTimeout", "ref", "unref"])
    if (typeof socket[method] !== "function") socket[method] = self;
  return socket;
}

/**
 * One app-owned ssh connection to a profile's daemon.
 *
 * **Credential-bearing traffic never crosses an unauthenticated hop.** Each connection to the
 * daemon is its own `ssh -W 127.0.0.1:<daemon port>` process: ssh authenticates the server
 * against its pin and the person's key, then carries that connection's bytes over its own
 * stdio. `connect()` returns that stream, so a client that sends through it is bound to the
 * exact authenticated channel, and the bytes go nowhere if ssh fails first. When the stream's
 * ssh ends, so does the connection; nothing is redialled under it. No local port forward
 * exists that another local process could take over while ssh is down.
 *
 * `url` is a loopback listener the tunnel holds for its whole life, so the address is unique
 * and anything that does dial it still goes over a fresh authenticated stream. The app's own
 * client never dials it: it uses `connect()`.
 *
 * Behind a jump host, a persistent app-owned ssh forwards a private loopback port to the
 * server's sshd (with its own pin), restarted with backoff while the tunnel lives. Each
 * daemon stream connects through that port and authenticates the *server* end to end, so a
 * process that took the private port could not impersonate it; a jump loss still ends every
 * stream at once.
 *
 * `open()` establishes it once (no retries: the caller is probing and the person is waiting
 * on the answer). A stream that cannot authenticate afterwards turns the state to
 * `reconnecting` (or `failed` for what only the person can fix: changed or missing host
 * key, failed auth, no ssh), and the next successful stream turns it back to `open`.
 */
export class SshTunnel {
  private jump: Generation | undefined;
  private hops: TunnelHops | undefined;
  private listener: Server | undefined;
  private readonly accepted = new Set<Socket>();
  private readonly streams = new Set<Stream>();
  /** Trust no key on first use (`SshTunnelOptions.pinnedOnly`, and every `runOnce`). */
  private pinnedOnly = false;
  /** Commands running on the server (`exec`), stopped with the tunnel. */
  private readonly commands = new Set<ChildProcess>();
  private port: number | undefined;
  private closed = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stateNow: TunnelState = { phase: "starting" };
  private fingerprint: string | undefined;
  private channelRefusedAt = 0;

  constructor(private readonly options: SshTunnelOptions) {
    this.pinnedOnly = options.pinnedOnly === true;
  }

  get state(): TunnelState {
    return this.stateNow;
  }
  get localPort(): number | undefined {
    return this.port;
  }
  get url(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}` : undefined;
  }
  /** The host key the server presented on the last successful connect, `SHA256:…`. */
  get hostKeyFingerprint(): string | undefined {
    return this.fingerprint;
  }
  /**
   * True while the tunnel is open and, behind a jump host, the jump's ssh is bound and
   * running. Advisory: the binding that matters is that credential-bearing bytes only ever
   * travel through `connect()`.
   */
  transportVerified(): boolean {
    return !this.closed && this.stateNow.phase === "open" && this.jumpUp();
  }
  /**
   * The remote end refused a forwarded connection within `withinMs`: ssh works, but nothing
   * listens on the daemon port. Lets a caller turn a failed probe into the right sentence.
   */
  remoteRefused(withinMs = 10_000): boolean {
    return this.channelRefusedAt > 0 && Date.now() - this.channelRefusedAt <= withinMs;
  }

  async open(): Promise<string> {
    if (this.closed) throw new TunnelRefusal("closed");
    if (this.listener) throw new Error("Tunnel already open");
    this.setState({ phase: "starting" });
    try {
      this.port = await this.listen();
      await this.prepare();
      await this.probe();
      this.attempt = 0;
      this.setState({ phase: "open", localPort: this.port });
    } catch (error) {
      const refusal = error instanceof TunnelRefusal ? error.code : "ssh-failed";
      await this.shutdown();
      this.setState({ phase: "failed", refusal });
      throw error instanceof TunnelRefusal ? error : new TunnelRefusal(refusal);
    }
    return this.url!;
  }

  /**
   * Run one command on the profile's server (behind its jump host, if any) and collect its
   * output: ORCA's own CLI there, for credential setup (#875). Opens nothing that outlives
   * the call. A command never trusts a key on first use: the server (and its jump host) must
   * already be pinned, from an earlier connect, or it refuses `host-key-missing` before ssh
   * starts. The command's words must pass `REMOTE_WORD`. ssh's own failures reject with a
   * `TunnelRefusal`; a command that ran resolves with its exit code, standard output, and
   * the server's error lines (to classify, never to show or log).
   */
  static run(options: SshTunnelOptions, command: readonly string[], timeoutMs = 60_000): Promise<RemoteResult> {
    return new SshTunnel({ ...options, pinnedOnly: true }).runOnce(command, timeoutMs);
  }

  /**
   * `run` on a tunnel that was never opened: it is closed when the command ends. Like `run`,
   * every hop must already be pinned, the jump host's too.
   */
  async runOnce(command: readonly string[], timeoutMs = 60_000): Promise<RemoteResult> {
    if (this.listener || this.hops) throw new Error("Tunnel already in use");
    this.pinnedOnly = true;
    try {
      await this.prepare();
      return await this.exec(command, timeoutMs);
    } finally {
      await this.close();
    }
  }

  /** Run a command on the server of an open tunnel (see `run`). */
  async exec(command: readonly string[], timeoutMs = 60_000): Promise<RemoteResult> {
    if (this.closed || !this.hops) throw new TunnelRefusal("closed");
    if (!this.jumpUp()) throw new TunnelRefusal("unreachable");
    const hop = this.hops.daemon;
    // Commands administer the server's credentials: only ever on a server, and behind a jump
    // host, that is already pinned. The pin is read once, into the arguments ssh gets.
    const args = commandArgs(hop, command);
    if (!args.includes("StrictHostKeyChecking=yes")) throw new TunnelRefusal("host-key-missing");
    if (this.hops.jump && pinState(this.hops.jump.knownHostsFile) !== "pinned")
      throw new TunnelRefusal("host-key-missing");
    let child: ChildProcess;
    try {
      child = (this.options.spawn ?? defaultSpawn)(this.options.sshBinary ?? "ssh", args);
    } catch {
      throw new TunnelRefusal("ssh-missing");
    }
    this.commands.add(child);
    child.once("exit", () => this.commands.delete(child));
    return new Promise<RemoteResult>((resolve, reject) => {
      let authenticated = false;
      let failed = false;
      let tail = "";
      const serverLines: string[] = [];
      const stdout: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        failed = true;
        reject(new TunnelRefusal("timeout"));
        child.kill();
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= REMOTE_OUTPUT_LIMIT) stdout.push(chunk);
      });
      watchLines(child, (line) => {
        tail = (tail + line + "\n").slice(-STDERR_TAIL);
        if (authenticated) {
          // After authentication, what is not ssh's own debug output is the command's.
          if (!/^debug\d:/.test(line) && serverLines.length < 64) serverLines.push(line.slice(0, 512));
          return;
        }
        if (/^debug1: Entering interactive session/.test(line)) authenticated = true;
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        reject(new TunnelRefusal(error.code === "ENOENT" ? "ssh-missing" : "ssh-failed"));
      });
      // A result is read only once ssh has exited and its output is drained (`close`), and
      // drainage is bounded: output that never ends is a failure, not a partial result.
      let exitCode: number | null = null;
      let drain: ReturnType<typeof setTimeout> | undefined;
      child.once("exit", (code) => {
        clearTimeout(timer);
        exitCode = code;
        if (failed) return;
        drain = setTimeout(() => {
          failed = true;
          reject(new TunnelRefusal("ssh-failed"));
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, REMOTE_DRAIN_MS);
      });
      child.once("close", () => {
        clearTimeout(timer);
        if (drain) clearTimeout(drain);
        if (failed) return;
        failed = true;
        if (!authenticated) {
          reject(new TunnelRefusal(classifySshFailure(tail)));
          return;
        }
        if (size > REMOTE_OUTPUT_LIMIT) {
          reject(new TunnelRefusal("ssh-failed"));
          return;
        }
        resolve({ code: exitCode ?? 255, stdout: Buffer.concat(stdout).toString("utf8"), serverLines });
      });
      child.stdin?.end();
    });
  }

  /**
   * A new connection to the daemon over its own authenticated ssh stream. Bytes written
   * before ssh has authenticated wait in ssh, and are discarded if it fails. Throws a
   * `TunnelRefusal` when the tunnel is closed, failed, or its jump host is down.
   */
  connect(): Duplex {
    if (this.closed || !this.hops) throw new TunnelRefusal("closed");
    if (this.stateNow.phase === "failed") throw new TunnelRefusal(this.stateNow.refusal);
    if (!this.jumpUp()) throw new TunnelRefusal("unreachable");
    const stream = this.spawnStream();
    const { stdin, stdout } = stream.child;
    if (!stdin || !stdout) {
      stream.child.kill();
      throw new TunnelRefusal("ssh-failed");
    }
    const socket = asSocket(stdioDuplex(stdin, stdout));
    // ssh never authenticated: there is no connection, and nothing was carried.
    stream.ready.catch((refusal: unknown) => socket.destroy(refusal as Error));
    socket.once("close", () => {
      if (alive(stream.child)) stream.child.kill();
    });
    stream.socket = socket;
    return socket;
  }

  async close(): Promise<void> {
    if (this.closed && !this.listener && !this.jump && this.streams.size === 0) return;
    this.closed = true;
    await this.shutdown();
    this.setState({ phase: "closed" });
  }

  /** Work out the hops and start the jump host, if any: what every stream and command needs. */
  private async prepare(): Promise<void> {
    if (this.closed) throw new TunnelRefusal("closed");
    const { profile, knownHostsFile } = this.options;
    mkdirSync(dirname(knownHostsFile), { recursive: true });
    this.hops = tunnelHops(profile, knownHostsFile, profile.jump ? await ephemeralLoopbackPort() : undefined);
    if (this.hops.jump) await this.launchJump();
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const streams = [...this.streams];
    this.streams.clear();
    for (const stream of streams) stream.socket?.destroy();
    const jump = this.jump;
    this.jump = undefined;
    if (jump) jump.lost = true;
    for (const socket of this.accepted) socket.destroy();
    this.accepted.clear();
    const listener = this.listener;
    this.listener = undefined;
    const commands = [...this.commands];
    this.commands.clear();
    await Promise.all([
      ...streams.map((stream) => stop(stream.child)),
      ...commands.map(stop),
      ...(jump ? jump.children.map(stop) : []),
      listener ? new Promise<void>((resolve) => listener.close(() => resolve())) : undefined,
    ]);
  }

  private setState(state: TunnelState): void {
    this.stateNow = state;
    this.options.onState?.(state);
  }

  /** Record a pin's enrollment; a failure to write it is a refusal, never a throw out of a handler. */
  private enroll(knownHostsFile: string): void {
    try {
      (this.options.markEnrolled ?? markPinEnrolled)(knownHostsFile);
    } catch {
      throw new TunnelRefusal("pin-write-failed");
    }
  }

  private jumpUp(): boolean {
    if (!this.hops?.jump) return true;
    const jump = this.jump;
    return jump !== undefined && jump.ready && !jump.lost && jump.children.every(alive);
  }

  /** Hold the tunnel's loopback address; each connection to it gets its own stream. */
  private async listen(): Promise<number> {
    const server = createServer((socket) => {
      this.accepted.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => this.accepted.delete(socket));
      let upstream: Duplex;
      try {
        upstream = this.connect();
      } catch {
        socket.destroy();
        return;
      }
      socket.pipe(upstream).pipe(socket);
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
    });
    this.listener = server;
    const port = this.options.pickPort ? await this.options.pickPort() : 0;
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) =>
        reject(error.code === "EADDRINUSE" || error.code === "EACCES" ? new TunnelRefusal("forward-failed") : error),
      );
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve());
    });
    const address = server.address();
    if (typeof address !== "object" || !address) throw new TunnelRefusal("forward-failed");
    return address.port;
  }

  /** The first stream: authenticates (and on first use pins) the server, then ends. */
  private async probe(): Promise<void> {
    const stream = this.spawnStream();
    // EOF at once: ssh opens the channel, the daemon sees an empty connection, and ssh
    // exits. A refused channel is still logged, which is what `remoteRefused` reads.
    stream.child.stdin?.end();
    try {
      await stream.ready;
    } catch (error) {
      if (alive(stream.child)) stream.child.kill();
      throw error;
    }
    const linger = setTimeout(() => alive(stream.child) && stream.child.kill(), 10_000);
    linger.unref?.();
    stream.child.once("exit", () => clearTimeout(linger));
  }

  /** Spawn one `ssh -W` to the daemon. Throws `host-key-missing` without spawning. */
  private spawnStream(): Stream {
    const hop = this.hops!.daemon;
    if (pinState(hop.knownHostsFile) === "broken") throw new TunnelRefusal("host-key-missing");
    let child: ChildProcess;
    try {
      child = (this.options.spawn ?? defaultSpawn)(this.options.sshBinary ?? "ssh", hopArgs(hop));
    } catch {
      throw new TunnelRefusal("ssh-missing");
    }
    let settle!: (error?: TunnelRefusal) => void;
    const stream: Stream = {
      child,
      authenticated: false,
      ready: new Promise<void>((resolve, reject) => {
        let settled = false;
        settle = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
      }),
    };
    const timer = setTimeout(() => {
      settle(new TunnelRefusal("timeout"));
      child.kill();
    }, this.options.readyTimeoutMs ?? 30_000);
    this.streams.add(stream);
    let tail = "";
    watchLines(child, (line) => {
      tail = (tail + line + "\n").slice(-STDERR_TAIL);
      const key = /Server host key: \S+ (SHA256:[A-Za-z0-9+/=]+)/.exec(line);
      if (key) this.fingerprint = key[1];
      if (/channel \d+: open failed:|^stdio forwarding failed/.test(line)) this.channelRefusedAt = Date.now();
      // Printed once the server is authenticated against its pin and the person's key accepted.
      if (/^debug1: Entering interactive session/.test(line) && !stream.authenticated && !stream.refused) {
        // The pin is recorded before the connection is used. If it cannot be, the stream
        // is refused here: never ready, closed, and reported like any other refusal.
        try {
          this.enroll(hop.knownHostsFile);
        } catch (error) {
          stream.refused = true;
          const refusal = error instanceof TunnelRefusal ? error.code : "pin-write-failed";
          settle(new TunnelRefusal(refusal));
          stream.socket?.destroy(new TunnelRefusal(refusal));
          child.kill();
          this.streamFailed(refusal);
          return;
        }
        stream.authenticated = true;
        settle();
        if (!this.closed && this.stateNow.phase === "reconnecting" && this.jumpUp()) {
          this.attempt = 0;
          this.setState({ phase: "open", localPort: this.port! });
        }
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      const refusal = error.code === "ENOENT" ? "ssh-missing" : "ssh-failed";
      tail = "";
      settle(new TunnelRefusal(refusal));
      this.streamFailed(refusal);
    });
    child.once("exit", () => {
      this.streams.delete(stream);
      if (stream.authenticated || stream.refused) return;
      const refusal = classifySshFailure(tail);
      settle(new TunnelRefusal(refusal));
      this.streamFailed(refusal);
    });
    return stream;
  }

  /** A stream after `open()` could not authenticate: show it, and stop for good if it must. */
  private streamFailed(refusal: TunnelRefusalCode): void {
    if (this.closed || this.stateNow.phase === "starting" || this.stateNow.phase === "failed") return;
    if (PERMANENT.has(refusal)) {
      this.fail(refusal);
      return;
    }
    if (this.stateNow.phase === "open") {
      this.attempt += 1;
      this.setState({ phase: "reconnecting", attempt: this.attempt, refusal });
    }
  }

  private fail(refusal: TunnelRefusalCode): void {
    this.setState({ phase: "failed", refusal });
    for (const stream of this.streams) stream.socket?.destroy();
    for (const stream of this.streams) if (alive(stream.child)) stream.child.kill();
  }

  /** Start the jump host's ssh; resolve once its forward is bound. */
  private async launchJump(): Promise<void> {
    const hop = this.hops!.jump!;
    const generation: Generation = { children: [], ready: false, lost: false };
    this.jump = generation;
    try {
      const state = pinState(hop.knownHostsFile);
      if (state === "broken" || (this.pinnedOnly && state !== "pinned")) throw new TunnelRefusal("host-key-missing");
      await this.startJump(generation, hop);
      if (generation.lost || this.jump !== generation) throw new TunnelRefusal("ssh-failed");
      this.enroll(hop.knownHostsFile);
      generation.ready = true;
    } catch (error) {
      generation.lost = true;
      await Promise.all(generation.children.map(stop));
      throw error;
    }
  }

  private startJump(generation: Generation, hop: HopSpec): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      const args = hopArgs(hop);
      if (this.pinnedOnly && !args.includes("StrictHostKeyChecking=yes")) {
        reject(new TunnelRefusal("host-key-missing"));
        return;
      }
      try {
        child = (this.options.spawn ?? defaultSpawn)(this.options.sshBinary ?? "ssh", args);
      } catch {
        reject(new TunnelRefusal("ssh-missing"));
        return;
      }
      generation.children.push(child);
      let tail = "";
      let settled = false;
      const settle = (error?: TunnelRefusal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        settle(new TunnelRefusal("timeout"));
        child.kill();
      }, this.options.readyTimeoutMs ?? 30_000);
      watchLines(child, (line) => {
        tail = (tail + line + "\n").slice(-STDERR_TAIL);
        // Printed once the forward is bound: with ExitOnForwardFailure a forward that could
        // not bind is fatal before this line (the "listening on" line comes before the bind).
        if (/^debug1: Entering interactive session/.test(line)) settle();
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        const refusal = error.code === "ENOENT" ? "ssh-missing" : "ssh-failed";
        settle(new TunnelRefusal(refusal));
        this.loseJump(generation, refusal);
      });
      child.once("exit", () => {
        const refusal = classifySshFailure(tail);
        settle(new TunnelRefusal(refusal));
        this.loseJump(generation, refusal);
      });
    });
  }

  /** The jump's ssh ended: every daemon stream through it ends now, then it restarts. */
  private loseJump(generation: Generation, refusal: TunnelRefusalCode): void {
    if (generation.lost) return;
    generation.lost = true;
    const wasReady = generation.ready;
    generation.ready = false;
    for (const child of generation.children) if (alive(child)) child.kill();
    for (const stream of this.streams) stream.socket?.destroy();
    for (const stream of this.streams) if (alive(stream.child)) stream.child.kill();
    if (wasReady && this.jump === generation && !this.closed) this.scheduleRestart(refusal);
  }

  private scheduleRestart(refusal: TunnelRefusalCode): void {
    if (this.closed) return;
    if (PERMANENT.has(refusal)) {
      this.fail(refusal);
      return;
    }
    this.attempt += 1;
    this.setState({ phase: "reconnecting", attempt: this.attempt, refusal });
    const { initialMs, maxMs } = this.options.backoff ?? { initialMs: 1_000, maxMs: 30_000 };
    const delay = Math.min(maxMs, initialMs * 2 ** Math.min(this.attempt - 1, 16));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closed) return;
      this.launchJump()
        .then(() => {
          if (this.closed) return;
          this.attempt = 0;
          this.setState({ phase: "open", localPort: this.port! });
        })
        .catch((error: unknown) => {
          if (this.closed) return;
          // `launchJump` failed before its forward was bound; nothing of it is left running.
          this.scheduleRestart(error instanceof TunnelRefusal ? error.code : "ssh-failed");
        });
    }, delay);
    this.restartTimer.unref?.();
  }
}

/** One connection over a child's stdin/stdout. Destroying it ends the child's stdio. */
function stdioDuplex(stdin: Writable, stdout: Readable): Duplex {
  const duplex = new Duplex({
    read: () => {
      stdout.resume();
    },
    write: (chunk: Buffer, _encoding, callback) => {
      stdin.write(chunk, (error) => callback(error ?? null));
    },
    final: (callback) => {
      stdin.end(() => callback());
    },
    destroy: (error, callback) => {
      stdin.destroy();
      stdout.destroy();
      callback(error);
    },
  });
  stdout.on("data", (chunk: Buffer) => {
    if (!duplex.push(chunk)) stdout.pause();
  });
  stdout.once("end", () => duplex.push(null));
  // The process is gone: the connection is over, whatever was still to be written.
  // Give a reader the last bytes first; a connection nobody reads still closes.
  stdout.once("close", () => {
    if (duplex.readableEnded) duplex.destroy();
    else {
      const timer = setTimeout(() => duplex.destroy(), 2_000);
      timer.unref?.();
      duplex.once("end", () => {
        clearTimeout(timer);
        duplex.destroy();
      });
    }
  });
  stdin.on("error", (error) => duplex.destroy(error));
  return duplex;
}

function watchLines(child: ChildProcess, onLine: (line: string) => void): void {
  let buffer = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
    }
    if (buffer.length > STDERR_TAIL) buffer = buffer.slice(-STDERR_TAIL);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (!alive(child)) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  await exited;
  clearTimeout(timer);
}

function defaultSpawn(command: string, args: readonly string[]): ChildProcess {
  // A `-W` stream carries the connection on stdin/stdout; a forwarding ssh reads nothing.
  const stdin = args.includes("-W") ? "pipe" : "ignore";
  return spawn(command, [...args], { stdio: [stdin, "pipe", "pipe"], windowsHide: true });
}

// ---------------------------------------------------------------------------------------
// Credential slots
// ---------------------------------------------------------------------------------------

/** The OS keychain-backed cipher: Electron `safeStorage` in the app. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class CredentialStorageUnavailable extends Error {
  override readonly name = "CredentialStorageUnavailable";
  constructor() {
    super(
      "The system keychain is not available, so ORCA cannot store this profile's credential. Unlock or set up your keychain, restart ORCA and try again.",
    );
  }
}

/** Header-safe bearer token, the same alphabet the daemon client accepts. */
const TOKEN = /^[A-Za-z0-9._~-]{16,4096}$/;

/**
 * One encrypted credential per profile id, as `<dir>/<id>.credential`. Written atomically
 * with owner-only permissions; read and decrypted on demand, never cached in plaintext here.
 */
export class CredentialSlots {
  constructor(
    private readonly dir: string,
    private readonly cipher: SecretCipher,
  ) {}

  private file(id: string): string {
    if (!PROFILE_ID.test(id)) throw new Error("Invalid profile id");
    return join(this.dir, `${id}.credential`);
  }

  private assertAvailable(): void {
    // Linux `basic_text` is a hard-coded key, not a keychain: never store a credential with it.
    if (!this.cipher.isEncryptionAvailable() || this.cipher.getSelectedStorageBackend?.() === "basic_text")
      throw new CredentialStorageUnavailable();
  }

  has(id: string): boolean {
    try {
      return statSync(this.file(id)).size > 0;
    } catch {
      return false;
    }
  }

  read(id: string): string | undefined {
    let sealed: Buffer;
    try {
      sealed = readFileSync(this.file(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Cannot read the profile credential", { cause: error });
    }
    this.assertAvailable();
    const token = this.cipher.decryptString(sealed).trim();
    if (!TOKEN.test(token)) throw new Error("Invalid stored profile credential");
    return token;
  }

  write(id: string, token: string): void {
    const value = token.trim();
    if (!TOKEN.test(value)) throw new Error("That is not an ORCA daemon credential.");
    this.assertAvailable();
    const sealed = this.cipher.encryptString(value);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(id);
    const tmp = `${target}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, sealed);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  }

  remove(id: string): void {
    rmSync(this.file(id), { force: true });
  }
}
