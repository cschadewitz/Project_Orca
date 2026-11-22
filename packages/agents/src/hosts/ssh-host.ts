/**
 * SshHost - runs ACP agents on another machine over SSH.
 *
 * No daemon is needed on the remote side: `ssh -T user@host -- bash -lc 'cd
 * <cwd> && exec <agent>'` gives us the agent's stdin/stdout, which *is* the ACP
 * stdio transport. File access for artifact pickup and ACP `fs/*` goes over
 * one persistent SFTP session per host (`ssh -s <host> sftp`, see sftp.ts):
 * requests are pipelined on that one connection instead of paying an ssh
 * process per call. A session that drops is re-established once before the
 * call fails. If the remote refuses the SFTP subsystem (ssh reports
 * "subsystem request failed": no `sftp-server` configured), calls fall back to
 * short-lived `ssh` commands (`cat`, `test -e`, `mkdir -p`) and SFTP is tried
 * again after `SFTP_RETRY_MS`. Any other failure to open the session (ssh
 * cannot connect or authenticate, the handshake times out or does not
 * validate) fails the call with `AGENT_TRANSPORT` instead.
 *
 * Requirements: key-based auth (BatchMode=yes, no password prompts), the agent
 * binary on the remote PATH for a login shell, and the workspace already
 * present on the remote (see docs/INTEGRATIONS.md for syncing strategies).
 */
import { spawn } from "node:child_process";
import { posix } from "node:path";
import { OrcaError, type AgentSpec, type SshHost as SshHostSpec } from "@orca/core";
import {
  collectChildProcess,
  killIfRunning,
  StderrTail,
  type PipedChildProcess,
  shellQuote,
  wrapAgentProcess,
  type AgentHost,
  type AgentProcessHandle,
  type ExecResult,
  type HostFileSystem,
  type SpawnAgentOptions,
} from "../host.js";

import {
  isDirectory,
  readAll,
  SftpClient,
  SftpClosedError,
  SftpConnectionError,
  SftpStatusError,
  SftpUnavailableError,
  SSH_FX_NO_SUCH_FILE,
  SSH_FXF_CREAT,
  SSH_FXF_TRUNC,
  SSH_FXF_WRITE,
  writeAll,
} from "./sftp.js";

/** How long to stay on the per-command path after the SFTP subsystem could not be started. */
export const SFTP_RETRY_MS = 60_000;
/** An SFTP session with nothing in flight for this long is closed (its ssh process exits). */
export const SFTP_IDLE_MS = 30_000;

export interface SshHostOptions {
  /**
   * Starts the process that carries the SFTP session. Defaults to
   * `ssh <baseArgs> -s <host> sftp`; tests inject a local SFTP server.
   */
  openSftpChannel?: () => PipedChildProcess;
  /** `false` keeps every file call on the per-command path. Default `true`. */
  sftp?: boolean;
  idleMs?: number;
  retryMs?: number;
  /** Deadline for each SFTP request; a miss drops the session (then one retry). Default 60 s. */
  requestTimeoutMs?: number;
  /** Largest file `readFile` buffers over SFTP. Default: V8's string limit, as on the per-command path. */
  maxReadBytes?: number;
}

export class SshHost implements AgentHost {
  readonly fs: HostFileSystem;
  /** The per-command file system: the fallback, and the baseline for benchmarks. */
  readonly execFs: HostFileSystem;
  private readonly sftpFs: SftpFileSystem | undefined;
  constructor(
    readonly spec: SshHostSpec,
    options: SshHostOptions = {},
  ) {
    this.execFs = new SshFileSystem(this);
    this.sftpFs = options.sftp === false ? undefined : new SftpFileSystem(this, this.execFs, options);
    this.fs = this.sftpFs ?? this.execFs;
  }

  /** Close the SFTP session, if one is open. The next file call opens a new one. */
  close(): void {
    this.sftpFs?.close();
  }
  get id(): string {
    return this.spec.id;
  }
  joinPath(...parts: string[]): string {
    return posix.join(...parts);
  }

  /** ssh CLI arguments up to (not including) the remote command. */
  baseArgs(): string[] {
    const s = this.spec;
    const args = [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${Math.ceil(s.connectTimeoutMs / 1000)}`,
      ...s.sshArgs,
    ];
    if (s.port) args.push("-p", String(s.port));
    if (s.identityFile) args.push("-i", s.identityFile);
    args.push(s.user ? `${s.user}@${s.host}` : s.host);
    return args;
  }

  /** ssh CLI arguments that start the remote `sftp` subsystem instead of a shell command. */
  sftpArgs(): string[] {
    const args = this.baseArgs();
    const destination = args.pop()!;
    return [...args, "-s", destination, "--", "sftp"];
  }

  /** Wrap a shell snippet for the remote login shell. */
  remoteCommand(script: string): string[] {
    const [shell, ...shellArgs] = this.spec.remoteShell.split(/\s+/);
    return [shell!, ...shellArgs, shellQuote(script)];
  }

  spawnAgent(agent: AgentSpec, options: SpawnAgentOptions): Promise<AgentProcessHandle> {
    const env = { ...agent.env, ...(options.env ?? {}) };
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ");
    const script =
      `cd ${shellQuote(options.cwd)} && exec ${envPrefix ? `env ${envPrefix} ` : ""}${shellQuote(agent.command)} ${agent.args.map(shellQuote).join(" ")}`.trim();
    return wrapAgentProcess(this.spawnSsh(script), {
      onSpawnError: (e) =>
        new OrcaError(
          "AGENT_TRANSPORT",
          `cannot start ssh for host '${this.id}': ${e.message}`,
          { hostId: this.id },
          { cause: e },
        ),
    });
  }

  exec(command: string, options: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const script = options.cwd ? `cd ${shellQuote(options.cwd)} && ${command}` : command;
    return collectChildProcess(this.spawnSsh(script), options);
  }

  /** Run `script` through the remote login shell; stdin/stdout carry the payload. */
  private spawnSsh(script: string) {
    const args = [...this.baseArgs(), "--", ...this.remoteCommand(script)];
    return spawn(this.spec.sshBinary, args, { stdio: ["pipe", "pipe", "pipe"] });
  }
}

class SshFileSystem implements HostFileSystem {
  constructor(private readonly host: SshHost) {}
  async readFile(path: string): Promise<string> {
    const r = await this.host.exec(`cat ${shellQuote(path)}`);
    if (r.code !== 0)
      throw new OrcaError("AGENT_TRANSPORT", `ssh read failed for ${path}: ${r.stderr.trim()}`, {
        hostId: this.host.id,
        path,
      });
    return r.stdout;
  }
  async writeFile(path: string, content: string): Promise<void> {
    const dir = posix.dirname(path);
    const r = await this.host.exec(`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`, { stdin: content });
    if (r.code !== 0)
      throw new OrcaError("AGENT_TRANSPORT", `ssh write failed for ${path}: ${r.stderr.trim()}`, {
        hostId: this.host.id,
        path,
      });
  }
  async exists(path: string): Promise<boolean> {
    const r = await this.host.exec(`test -e ${shellQuote(path)}`);
    return r.code === 0;
  }
  /**
   * One ssh process for the whole set: the remote shell prints `1`/`0` per path,
   * in order. A malformed reply (truncated output, a shell that failed to start)
   * is reported as "nothing exists yet" rather than as a spurious hit, so a
   * poller keeps waiting instead of concluding an artifact has landed.
   */
  async existsMany(paths: string[]): Promise<boolean[]> {
    if (paths.length === 0) return [];
    const script = `for p in ${paths.map(shellQuote).join(" ")}; do if test -e "$p"; then echo 1; else echo 0; fi; done`;
    const r = await this.host.exec(script);
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    if (lines.length !== paths.length) return paths.map(() => false);
    return lines.map((l) => l.trim() === "1");
  }
  async mkdirp(path: string): Promise<void> {
    const r = await this.host.exec(`mkdir -p ${shellQuote(path)}`);
    if (r.code !== 0)
      throw new OrcaError("AGENT_TRANSPORT", `ssh mkdir failed for ${path}: ${r.stderr.trim()}`, {
        hostId: this.host.id,
        path,
      });
  }
}

/** The message of whatever went wrong, for the "ssh <op> failed for <path>: …" errors. */
function reason(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).trim();
}

/**
 * `HostFileSystem` over one persistent SFTP session per host.
 *
 * Errors keep the per-command path's shape: `AGENT_TRANSPORT` with
 * `{ hostId, path }` and "ssh <op> failed for <path>: <reason>", and
 * `exists`/`existsMany` answer `false` rather than throw.
 */
class SftpFileSystem implements HostFileSystem {
  private session: { client: SftpClient | undefined; ready: Promise<SftpClient> } | undefined;
  private unavailableUntil = 0;
  private active = 0;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly host: SshHost,
    private readonly fallback: HostFileSystem,
    private readonly options: SshHostOptions,
  ) {}

  /** Close the session. Calls in flight on it are cancelled with the typed error, not retried. */
  close(): void {
    this.session?.client?.fail(new SftpClosedError());
    this.session = undefined;
  }

  async readFile(path: string): Promise<string> {
    try {
      return await this.run(
        async (c) => (await readAll(c, path, this.options.maxReadBytes)).toString("utf8"),
        () => this.fallback.readFile(path),
      );
    } catch (e) {
      throw this.transportError("read", path, e);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const data = Buffer.from(content, "utf8");
    try {
      await this.run(
        async (c) => {
          const flags = SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_TRUNC;
          // Open first: the parent usually exists, so the common case is one round trip.
          const handle = await c.open(path, flags).catch(async (e: unknown) => {
            if (!(e instanceof SftpStatusError) || e.status !== SSH_FX_NO_SUCH_FILE) throw e;
            await this.mkdirpWith(c, posix.dirname(path));
            return c.open(path, flags);
          });
          try {
            await writeAll(c, handle, data);
          } catch (e) {
            c.close(handle).catch(() => {});
            throw e;
          }
          // Awaited: a server may only report a failed flush (a full disk) on close.
          await c.close(handle);
        },
        () => this.fallback.writeFile(path, content),
      );
    } catch (e) {
      throw this.transportError("write", path, e);
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.existsMany([path]))[0]!;
  }

  /** Every stat in flight at once on the one session; a lost session answers "nothing exists yet". */
  async existsMany(paths: string[]): Promise<boolean[]> {
    if (paths.length === 0) return [];
    try {
      return await this.run(
        (c) =>
          Promise.all(
            paths.map((p) =>
              c.stat(p).then(
                () => true,
                (e: unknown) => {
                  if (e instanceof SftpConnectionError) throw e;
                  return false;
                },
              ),
            ),
          ),
        () => (paths.length === 1 ? this.fallback.exists(paths[0]!).then((x) => [x]) : this.fallback.existsMany(paths)),
      );
    } catch {
      return paths.map(() => false);
    }
  }

  async mkdirp(path: string): Promise<void> {
    try {
      await this.run(
        (c) => this.mkdirpWith(c, path),
        () => this.fallback.mkdirp(path),
      );
    } catch (e) {
      throw this.transportError("mkdir", path, e);
    }
  }

  /** `mkdir -p`: try the leaf first (one round trip when only it is missing), then recurse upward. */
  private async mkdirpWith(c: SftpClient, path: string): Promise<void> {
    try {
      await c.mkdir(path);
      return;
    } catch (e) {
      if (e instanceof SftpConnectionError) throw e;
    }
    const attrs = await c.stat(path).catch((e: unknown) => {
      if (e instanceof SftpConnectionError) throw e;
      return undefined;
    });
    if (attrs) {
      if (isDirectory(attrs)) return;
      throw new SftpStatusError(SSH_FX_NO_SUCH_FILE, `${path} exists and is not a directory`);
    }
    const parent = posix.dirname(path);
    if (parent === path) throw new SftpStatusError(SSH_FX_NO_SUCH_FILE, `cannot create ${path}`);
    await this.mkdirpWith(c, parent);
    await c.mkdir(path).catch(async (e: unknown) => {
      if (e instanceof SftpConnectionError) throw e;
      const again = await c.stat(path).catch(() => undefined);
      if (!again || !isDirectory(again)) throw e;
    });
  }

  private transportError(op: string, path: string, e: unknown): OrcaError {
    if (e instanceof OrcaError) return e;
    return new OrcaError(
      "AGENT_TRANSPORT",
      `ssh ${op} failed for ${path}: ${reason(e)}`,
      { hostId: this.host.id, path },
      { cause: e },
    );
  }

  /**
   * Run `op` on the session. A remote that refuses the SFTP subsystem sends
   * this call (and the next ones, for `retryMs`) down the per-command path;
   * any other failure to start the session is this call's error. A session
   * that drops under `op` is re-established once and `op` retried; a second
   * loss propagates as the error the caller turns into `AGENT_TRANSPORT`.
   *
   * Only a lost session (`SftpConnectionError`: the channel closed, a request
   * passed its deadline, a malformed reply) is retried; a status from the
   * server (no such file, permission denied, disk full) is final. A lost
   * session leaves the op's outcome ambiguous - a write may have landed in
   * part - so every op here is one that is safe to repeat from the start:
   * reads, stats, mkdir -p, and whole-file writes that reopen with TRUNC and
   * rewrite from offset 0. If the retry is lost too, the caller gets
   * `AGENT_TRANSPORT` and a written file's content is unspecified, as it is
   * when `cat > file` dies mid-stream on the per-command path.
   */
  private async run<T>(op: (c: SftpClient) => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (Date.now() < this.unavailableUntil) return fallback();
    this.active++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    try {
      let client: SftpClient;
      try {
        client = await this.client();
      } catch (e) {
        // Only a positive "no sftp subsystem here" falls back. A timeout, a
        // refused or failed ssh, or a handshake that does not validate is a
        // transport failure, reported as one.
        if (!(e instanceof SftpUnavailableError)) throw e;
        this.unavailableUntil = Date.now() + (this.options.retryMs ?? SFTP_RETRY_MS);
        return await fallback();
      }
      try {
        return await op(client);
      } catch (e) {
        if (!(e instanceof SftpConnectionError) || e instanceof SftpClosedError) throw e;
        return await op(await this.client());
      }
    } finally {
      if (--this.active === 0) this.armIdle();
    }
  }

  private armIdle(): void {
    if (!this.session) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.active === 0) this.close();
    }, this.options.idleMs ?? SFTP_IDLE_MS);
    this.idleTimer.unref();
  }

  /** The live session, or a new one. */
  private client(): Promise<SftpClient> {
    const s = this.session;
    if (s && !s.client?.isClosed) return s.ready;
    const session: NonNullable<typeof this.session> = { client: undefined, ready: undefined as never };
    session.ready = this.connect((c) => (session.client = c)).catch((e: unknown) => {
      if (this.session === session) this.session = undefined;
      throw e;
    });
    this.session = session;
    return session.ready;
  }

  private async connect(onClient: (c: SftpClient) => void): Promise<SftpClient> {
    const child =
      this.options.openSftpChannel?.() ??
      spawn(this.host.spec.sshBinary, this.host.sftpArgs(), { stdio: ["pipe", "pipe", "pipe"] });
    const tail = new StderrTail(10);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => tail.push(d));
    const client = new SftpClient(
      child.stdout,
      child.stdin,
      this.options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.options.requestTimeoutMs },
    );
    onClient(client);
    const lost = (what: string): SftpConnectionError => {
      const diag = tail.text();
      return new SftpConnectionError(diag ? `${what}: ${diag}` : what);
    };
    let handshaken = false;
    child.once("error", (e) => client.fail(lost(`cannot start ssh for host '${this.host.id}': ${e.message}`)));
    // `close`, not `exit`: by then stderr has been read, so the reason makes it into the error.
    child.once("close", (code, signal) => {
      const e = lost(`sftp session ended (${signal ?? `exit ${code}`})`);
      // OpenSSH's own words when the server has no (or refuses the) sftp subsystem.
      const refused = !handshaken && /subsystem request failed/i.test(tail.text());
      client.fail(refused ? new SftpUnavailableError(e.message) : e);
    });
    void client.closed.then(() => {
      killIfRunning(child);
      child.stdin.destroy();
    });
    // ssh's own connect timeout, then one request deadline (at most 5 s) for VERSION.
    const handshakeMs = this.host.spec.connectTimeoutMs + Math.min(this.options.requestTimeoutMs ?? 5_000, 5_000);
    const timer = setTimeout(() => client.fail(lost(`sftp handshake timed out after ${handshakeMs} ms`)), handshakeMs);
    try {
      await client.init();
      handshaken = true;
    } finally {
      clearTimeout(timer);
    }
    return client;
  }
}
