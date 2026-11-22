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
 * - **Connection profiles**: the nonsecret description of a remote daemon (`user@host`, ssh
 *   port, ProxyJump, a few extra ssh options, the daemon's port on the remote loopback).
 * - **`SshTunnel`**: one `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>` process per
 *   profile in use, with the server's host key pinned in a per-profile known-hosts file on
 *   first connect, distinct refusals for the ways it fails, and restarts with backoff on the
 *   same local port after it was open, so a client's URL stays valid across a tunnel loss.
 * - **`CredentialSlots`**: one encrypted credential per profile. The cipher is the caller's
 *   (Electron `safeStorage` in the app); there is no plaintext fallback.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { z } from "zod";

/** The daemon's default port (`orca serve`). */
export const DEFAULT_REMOTE_DAEMON_PORT = 6722;

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** `[user@]host`: no option-looking leading dash, no whitespace, nothing a shell would read. */
const DESTINATION = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|\[[0-9A-Fa-f:.]+\])$/;
/** One or more `[user@]host[:port]` hops for `-J`. */
const JUMP =
  /^(?:(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?)(?:,(?:(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?))*$/;

/**
 * `-o` keys a profile may not set, because the tunnel's safety depends on ORCA's value: the
 * host-key pin, no prompts, failing on a forward that did not bind, and nothing but the one
 * forward. ssh keeps the first value it sees for an option and ORCA's come first, so this
 * list is about a clear refusal rather than the only line of defence.
 */
const RESERVED_OPTIONS = new Set(
  [
    "BatchMode",
    "StrictHostKeyChecking",
    "UserKnownHostsFile",
    "GlobalKnownHostsFile",
    "KnownHostsCommand",
    "UpdateHostKeys",
    "ExitOnForwardFailure",
    "LocalForward",
    "RemoteForward",
    "DynamicForward",
    "ClearAllForwardings",
    "PermitLocalCommand",
    "LocalCommand",
    "RemoteCommand",
    "RequestTTY",
    "SessionType",
    "StdinNull",
    "ForkAfterAuthentication",
    "ControlMaster",
    "ControlPath",
    "ControlPersist",
    "Tunnel",
    "TunnelDevice",
    "LogLevel",
  ].map((key) => key.toLowerCase()),
);

/** Why a profile's extra ssh arguments are refused, or undefined when they are fine. */
export function sshArgsProblem(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-4" || arg === "-6" || arg === "-C") continue;
    if (arg === "-i" || arg === "-F" || arg === "-o") {
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) return `${arg} needs a value`;
      if (arg === "-o") {
        const problem = optionProblem(value);
        if (problem) return problem;
      }
      continue;
    }
    if (arg.startsWith("-o") && arg.length > 2) {
      const problem = optionProblem(arg.slice(2));
      if (problem) return problem;
      continue;
    }
    return `Unsupported ssh argument ${JSON.stringify(arg)}. Use -o Key=Value, -i, -F, -4, -6 or -C.`;
  }
  return undefined;
}

function optionProblem(option: string): string | undefined {
  const key = /^\s*([A-Za-z]+)\s*[= ]/.exec(option)?.[1];
  if (!key) return `Write ssh options as Key=Value (got ${JSON.stringify(option)}).`;
  if (RESERVED_OPTIONS.has(key.toLowerCase())) return `ORCA manages the ssh option ${key} for its tunnels.`;
  return undefined;
}

export const ConnectionProfileSchema = z
  .object({
    id: z.string().regex(PROFILE_ID),
    name: z.string().trim().min(1).max(80),
    /** `user@host` or `host`; the user's ssh config may supply the rest. */
    destination: z.string().regex(DESTINATION, "Enter user@host or a host name"),
    sshPort: z.number().int().min(1).max(65535).optional(),
    proxyJump: z.string().regex(JUMP, "Enter ProxyJump hops as [user@]host[:port], comma separated").optional(),
    sshArgs: z
      .array(z.string().min(1).max(512))
      .max(16)
      .superRefine((args, ctx) => {
        const problem = sshArgsProblem(args);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      })
      .optional(),
    /** The daemon's port on the remote loopback. */
    remotePort: z.number().int().min(1).max(65535).default(DEFAULT_REMOTE_DAEMON_PORT),
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
  if (
    /Permission denied|Too many authentication failures|no matching host key type|Authentication failed/i.test(stderr)
  )
    return "auth-failed";
  if (/cannot listen to port|Could not request local forwarding|Address already in use/i.test(stderr))
    return "forward-failed";
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
  /** The per-profile pin file. Missing or empty: the first connect pins (accept-new). */
  knownHostsFile: string;
  /** Default `ssh` from PATH. */
  sshBinary?: string;
  /** Test seam. */
  spawn?: (command: string, args: readonly string[]) => ChildProcess;
  /** Test seam: pick the local port. Default: an ephemeral loopback port from the OS. */
  pickPort?: () => Promise<number>;
  /** How long ssh may take to authenticate and bind. Default 30 s. */
  readyTimeoutMs?: number;
  /** Restart backoff after the tunnel was open. Default 1 s doubling to 30 s. */
  backoff?: { initialMs: number; maxMs: number };
  onState?: (state: TunnelState) => void;
}

/** A failure that a restart cannot fix: it needs the person. */
const PERMANENT: ReadonlySet<TunnelRefusalCode> = new Set(["ssh-missing", "host-key-changed", "auth-failed"]);
const STDERR_TAIL = 16 * 1024;

export function pinnedHostKey(knownHostsFile: string): boolean {
  try {
    return statSync(knownHostsFile).size > 0;
  } catch {
    return false;
  }
}

/** The ssh argv for one tunnel. Exported for tests and for the docs; ORCA's options come first. */
export function tunnelArgs(profile: ConnectionProfile, localPort: number, knownHostsFile: string): string[] {
  const args = [
    "-N",
    "-T",
    // `-v` is what tells ORCA the forward is bound ("Entering interactive session")
    // and which host key the server presented. Its output is parsed, never shown or logged.
    "-v",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `StrictHostKeyChecking=${pinnedHostKey(knownHostsFile) ? "yes" : "accept-new"}`,
    "-o",
    `UserKnownHostsFile=${sshOptionPath(knownHostsFile)}`,
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ClearAllForwardings=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${profile.remotePort}`,
  ];
  if (profile.sshPort) args.push("-p", String(profile.sshPort));
  if (profile.proxyJump) args.push("-J", profile.proxyJump);
  args.push(...(profile.sshArgs ?? []));
  args.push("--", profile.destination);
  return args;
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

/**
 * One app-owned ssh tunnel. `open()` establishes it once (no retries: the caller is
 * probing and the person is waiting on the answer). After that, an unexpected exit restarts
 * ssh with backoff on the same local port until `close()`, except for failures only the
 * person can fix (changed host key, failed auth, no ssh), which stop it in `failed`.
 */
export class SshTunnel {
  private child: ChildProcess | undefined;
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
   * The remote end refused a forwarded connection within `withinMs`: ssh works, but nothing
   * listens on the daemon port. Lets a caller turn a failed probe into the right sentence.
   */
  remoteRefused(withinMs = 10_000): boolean {
    return this.channelRefusedAt > 0 && Date.now() - this.channelRefusedAt <= withinMs;
  }

  async open(): Promise<string> {
    if (this.closed) throw new TunnelRefusal("closed");
    if (this.child) throw new Error("Tunnel already open");
    this.port = await (this.options.pickPort ?? ephemeralLoopbackPort)();
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
    if (this.closed && !this.child) return;
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(timer);
    }
    this.setState({ phase: "closed" });
  }

  private setState(state: TunnelState): void {
    this.stateNow = state;
    this.options.onState?.(state);
  }

  /** Start ssh and resolve once the forward listens; reject with a classified refusal. */
  private launch(): Promise<void> {
    const port = this.port!;
    const { profile, knownHostsFile } = this.options;
    mkdirSync(dirname(knownHostsFile), { recursive: true });
    const args = tunnelArgs(profile, port, knownHostsFile);
    const binary = this.options.sshBinary ?? "ssh";
    if (this.attempt === 0) this.setState({ phase: "starting" });
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = (this.options.spawn ?? defaultSpawn)(binary, args);
      } catch {
        reject(new TunnelRefusal("ssh-missing"));
        return;
      }
      this.child = child;
      let tail = "";
      let lineBuffer = "";
      let ready = false;
      const timer = setTimeout(() => {
        if (ready) return;
        settle(new TunnelRefusal("timeout"));
        child.kill();
      }, this.options.readyTimeoutMs ?? 30_000);
      const settle = (error?: TunnelRefusal) => {
        if (ready) return;
        ready = true;
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
          const key = /Server host key: \S+ (SHA256:[A-Za-z0-9+/=]+)/.exec(line);
          if (key) this.fingerprint = key[1];
          if (/channel \d+: open failed: (connect failed|administratively prohibited)/.test(line))
            this.channelRefusedAt = Date.now();
          // Printed once every forward is bound: with ExitOnForwardFailure a forward that
          // could not bind is fatal before this line (the "listening on" line comes earlier,
          // before the bind is attempted).
          if (!ready && /^debug1: Entering interactive session/.test(line)) {
            this.attempt = 0;
            this.setState({ phase: "open", localPort: port });
            settle();
          }
        }
        if (lineBuffer.length > STDERR_TAIL) lineBuffer = lineBuffer.slice(-STDERR_TAIL);
      });
      child.stdout?.resume();
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (this.child === child) this.child = undefined;
        settle(new TunnelRefusal(error.code === "ENOENT" ? "ssh-missing" : "ssh-failed"));
      });
      child.once("exit", () => {
        const wasReady = ready;
        if (this.child === child) this.child = undefined;
        const refusal = classifySshFailure(tail);
        settle(new TunnelRefusal(refusal));
        if (wasReady && !this.closed) this.scheduleRestart(refusal);
      });
    });
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
        // `launch` rejected before the forward listened; its exit handler did not restart.
        const code = error instanceof TunnelRefusal ? error.code : "ssh-failed";
        this.scheduleRestart(code);
      });
    }, delay);
    this.restartTimer.unref?.();
  }
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
