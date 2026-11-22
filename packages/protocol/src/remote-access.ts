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
 * - **`SshTunnel`**: `ssh -F none -N -L 127.0.0.1:<local>:127.0.0.1:<remote>` per profile in
 *   use (two chained processes behind a jump host), with each server's host key pinned in
 *   an app-owned known-hosts file on first connect and that pin as the only trust source,
 *   distinct refusals for the ways it fails, restarts with backoff on the same local port,
 *   and `transportVerified()` to gate credentials on the live, verified tunnel.
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
import { createServer } from "node:net";
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
  /** Test seam: pick the local port. Default: an ephemeral loopback port from the OS. */
  pickPort?: () => Promise<number>;
  /** How long each ssh may take to authenticate and bind. Default 30 s. */
  readyTimeoutMs?: number;
  /** Restart backoff after the tunnel was open. Default 1 s doubling to 30 s. */
  backoff?: { initialMs: number; maxMs: number };
  onState?: (state: TunnelState) => void;
}

/** A failure that a restart cannot fix: it needs the person. */
const PERMANENT: ReadonlySet<TunnelRefusalCode> = new Set([
  "ssh-missing",
  "host-key-changed",
  "host-key-missing",
  "auth-failed",
]);
const STDERR_TAIL = 16 * 1024;

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
  /** The one `-L` forward, `127.0.0.1:<local>:<host>:<port>`. */
  forward: string;
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
    "-N",
    "-T",
    // `-v` is what tells ORCA the forward is bound ("Entering interactive session") and which
    // host key the server presented. Its output is parsed, never shown or logged.
    "-v",
    ...options.flatMap((option) => ["-o", option]),
    // `-i` goes through ssh's `%` token expansion; the path is absolute, so no `~`.
    ...(hop.identityFile ? ["-i", hop.identityFile.replace(/%/g, "%%")] : []),
    ...(hop.port ? ["-p", String(hop.port)] : []),
    "-L",
    hop.forward,
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
 * The hops for a profile, in start order. Without a jump host: one ssh to the server. With
 * one: an ssh to the jump host forwarding a private loopback port to the server's sshd, then
 * the ssh to the server through that port, each with its own pinned key. Exported for tests.
 */
export function tunnelHops(
  profile: ConnectionProfile,
  localPort: number,
  knownHostsFile: string,
  jumpPort?: number,
): HopSpec[] {
  const daemon = `127.0.0.1:${localPort}:127.0.0.1:${profile.remotePort}`;
  const server = {
    identityFile: profile.identityFile,
    knownHostsFile,
    hostKeyAlias: `orca-${profile.id}`,
    forward: daemon,
  };
  if (!profile.jump) return [{ ...server, target: profile.destination, port: profile.sshPort }];
  if (!jumpPort) throw new Error("A jump host needs a private loopback port");
  const user = userOf(profile.destination);
  return [
    {
      target: profile.jump.destination,
      port: profile.jump.sshPort,
      identityFile: profile.jump.identityFile,
      knownHostsFile: `${knownHostsFile}.jump`,
      hostKeyAlias: `orca-${profile.id}-jump`,
      forward: `127.0.0.1:${jumpPort}:${hostOf(profile.destination)}:${profile.sshPort ?? 22}`,
    },
    { ...server, target: user ? `${user}@127.0.0.1` : "127.0.0.1", port: jumpPort },
  ];
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

/** One start of the tunnel: its ssh processes, and whether all of them are bound and alive. */
interface Generation {
  children: ChildProcess[];
  ready: boolean;
  lost: boolean;
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * One app-owned ssh tunnel. `open()` establishes it once (no retries: the caller is
 * probing and the person is waiting on the answer). After that, an unexpected exit restarts
 * ssh with backoff on the same local port until `close()`, except for failures only the
 * person can fix (changed host key, failed auth, no ssh), which stop it in `failed`.
 *
 * **Credentials follow `transportVerified()`, not the URL.** The local port is only a
 * number: while ssh is down, any local process could listen on it. A caller hands a
 * credential to a request only while every ssh process of the current start has proved its
 * forward bound (after authenticating the server against its pin) and is still running, so
 * the port is that ssh's. Loss turns it false synchronously, before any restart.
 */
export class SshTunnel {
  private generation: Generation | undefined;
  private port: number | undefined;
  private closed = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stateNow: TunnelState = { phase: "starting" };
  private fingerprint: string | undefined;
  private channelRefusedAt = 0;

  constructor(private readonly options: SshTunnelOptions) {}

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
   * True only while the current start's ssh processes have all bound their forwards and are
   * still running: the local port is then provably ssh's, behind a pinned, authenticated
   * server. False before the first open, while reconnecting, after failure and after close.
   */
  transportVerified(): boolean {
    const generation = this.generation;
    return (
      !this.closed &&
      this.stateNow.phase === "open" &&
      generation !== undefined &&
      generation.ready &&
      !generation.lost &&
      generation.children.every(alive)
    );
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
    if (this.generation) throw new Error("Tunnel already open");
    this.port = await (this.options.pickPort ?? ephemeralLoopbackPort)();
    this.setState({ phase: "starting" });
    try {
      await this.launch();
    } catch (error) {
      this.closed = true;
      this.setState({ phase: "failed", refusal: error instanceof TunnelRefusal ? error.code : "ssh-failed" });
      throw error;
    }
    return this.url!;
  }

  async close(): Promise<void> {
    if (this.closed && !this.generation) return;
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const generation = this.generation;
    this.generation = undefined;
    if (generation) {
      generation.lost = true;
      await Promise.all(generation.children.map(stop));
    }
    this.setState({ phase: "closed" });
  }

  private setState(state: TunnelState): void {
    this.stateNow = state;
    this.options.onState?.(state);
  }

  /** Start every hop in order; resolve once all forward. On failure nothing is left running. */
  private async launch(): Promise<void> {
    const generation: Generation = { children: [], ready: false, lost: false };
    this.generation = generation;
    const { profile, knownHostsFile } = this.options;
    try {
      mkdirSync(dirname(knownHostsFile), { recursive: true });
      const jumpPort = profile.jump ? await (this.options.pickPort ?? ephemeralLoopbackPort)() : undefined;
      // A test seam's fixed port would collide with itself; the jump port is private anyway.
      const hops = tunnelHops(
        profile,
        this.port!,
        knownHostsFile,
        jumpPort === this.port ? await ephemeralLoopbackPort() : jumpPort,
      );
      // A pin that was enrolled and is now gone must not be re-enrolled by accept-new.
      if (hops.some((hop) => pinState(hop.knownHostsFile) === "broken")) throw new TunnelRefusal("host-key-missing");
      for (const [index, hop] of hops.entries()) await this.startHop(generation, hop, index === hops.length - 1);
      if (generation.lost || this.generation !== generation) throw new TunnelRefusal("ssh-failed");
      for (const hop of hops) markPinEnrolled(hop.knownHostsFile);
      generation.ready = true;
      this.attempt = 0;
      this.setState({ phase: "open", localPort: this.port! });
    } catch (error) {
      generation.lost = true;
      await Promise.all(generation.children.map(stop));
      throw error;
    }
  }

  /** Start one ssh; resolve once its forward is bound, reject with a classified refusal. */
  private startHop(generation: Generation, hop: HopSpec, daemonHop: boolean): Promise<void> {
    const args = hopArgs(hop);
    const binary = this.options.sshBinary ?? "ssh";
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = (this.options.spawn ?? defaultSpawn)(binary, args);
      } catch {
        reject(new TunnelRefusal("ssh-missing"));
        return;
      }
      generation.children.push(child);
      let tail = "";
      let lineBuffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settle(new TunnelRefusal("timeout"));
        child.kill();
      }, this.options.readyTimeoutMs ?? 30_000);
      const settle = (error?: TunnelRefusal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-STDERR_TAIL);
        lineBuffer += chunk;
        let newline: number;
        while ((newline = lineBuffer.indexOf("\n")) >= 0) {
          const line = lineBuffer.slice(0, newline);
          lineBuffer = lineBuffer.slice(newline + 1);
          if (daemonHop) {
            const key = /Server host key: \S+ (SHA256:[A-Za-z0-9+/=]+)/.exec(line);
            if (key) this.fingerprint = key[1];
            if (/channel \d+: open failed: (connect failed|administratively prohibited)/.test(line))
              this.channelRefusedAt = Date.now();
          }
          // Printed once every forward is bound: with ExitOnForwardFailure a forward that
          // could not bind is fatal before this line (the "listening on" line comes earlier,
          // before the bind is attempted).
          if (/^debug1: Entering interactive session/.test(line)) settle();
        }
        if (lineBuffer.length > STDERR_TAIL) lineBuffer = lineBuffer.slice(-STDERR_TAIL);
      });
      child.stdout?.resume();
      child.once("error", (error: NodeJS.ErrnoException) => {
        settle(new TunnelRefusal(error.code === "ENOENT" ? "ssh-missing" : "ssh-failed"));
        this.lose(generation, error.code === "ENOENT" ? "ssh-missing" : "ssh-failed");
      });
      child.once("exit", () => {
        const refusal = classifySshFailure(tail);
        settle(new TunnelRefusal(refusal));
        this.lose(generation, refusal);
      });
    });
  }

  /**
   * A process of `generation` ended. Credentials stop at once (`lost`); the rest of the
   * start is stopped; a start that had been open restarts unless the cause needs the person.
   */
  private lose(generation: Generation, refusal: TunnelRefusalCode): void {
    if (generation.lost) return;
    generation.lost = true;
    const wasReady = generation.ready;
    generation.ready = false;
    for (const child of generation.children) if (alive(child)) child.kill();
    if (wasReady && this.generation === generation && !this.closed) this.scheduleRestart(refusal);
  }

  private scheduleRestart(refusal: TunnelRefusalCode): void {
    if (this.closed) return;
    if (PERMANENT.has(refusal)) {
      this.setState({ phase: "failed", refusal });
      return;
    }
    this.attempt += 1;
    this.setState({ phase: "reconnecting", attempt: this.attempt, refusal });
    const { initialMs, maxMs } = this.options.backoff ?? { initialMs: 1_000, maxMs: 30_000 };
    const delay = Math.min(maxMs, initialMs * 2 ** Math.min(this.attempt - 1, 16));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closed) return;
      this.launch().catch((error: unknown) => {
        if (this.closed) return;
        // `launch` failed before every forward was bound; nothing of it is left running.
        this.scheduleRestart(error instanceof TunnelRefusal ? error.code : "ssh-failed");
      });
    }, delay);
    this.restartTimer.unref?.();
  }
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
  return spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
