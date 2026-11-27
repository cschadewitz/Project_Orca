/**
 * The launch boundary of the Claude Agent SDK driver (#1118, tracking #1153).
 *
 * A `driver: claude-agent-sdk` agent runs Claude through the Claude Agent SDK against the
 * person's own installed, unmodified `claude`, signed in with their own `claude auth login`,
 * the way T3 Code does it. Everything here runs before a session is given work, on ORCA's own
 * machine, and refuses rather than guesses:
 *
 * - **Executable.** `command` (or `claude` on PATH) is resolved to the file that would run, by
 *   its real path. One inside an `@anthropic-ai/claude-agent-sdk*` package is the SDK's bundled
 *   CLI, not the person's install, and is refused.
 * - **Credentials and overrides.** ORCA offers no login and never opens anything under Claude's
 *   config directory, keychain or token files. The child's environment is the daemon's with
 *   every Anthropic and Claude variable taken out but `CLAUDE_CONFIG_DIR` (the person's choice
 *   of login), and every variable a secret is read from withheld (`claudeSdkEnvironment`); then
 *   the agent's own literal `env`, then the values its secret references were delivered
 *   (`claude-sdk/secrets.ts`, #1126). A credential or a Claude override reaches Claude only
 *   from the agent's config or from the login Claude keeps itself.
 * - **Login.** `claude auth status --json`, under a deadline, must say `loggedIn: true`. Not
 *   signed in is a session-open error that says to run `claude auth login` on that machine; no
 *   answer, a timeout or an answer ORCA cannot read is a failure too, never a pass.
 *
 * Nothing here reads, stores or forwards a token. What it learns (version, auth method and
 * provider) is what `claude` printed about itself.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { CLAUDE_SDK_DEFAULT_COMMAND, OrcaError, isSecretRef, literalEnv, type AgentSpec } from "@orca/core";

/** True for an agent ORCA drives through the Claude Agent SDK rather than ACP. */
export function claudeSdkRequested(agent: Pick<AgentSpec, "type" | "driver">): boolean {
  return agent.type === "acp" && agent.driver === "claude-agent-sdk";
}

/** The refusal for a `driver: claude-agent-sdk` agent that reached the ACP session opener. */
export function claudeSdkNotAcp(agentId: string): OrcaError {
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agentId} has driver: claude-agent-sdk, which ORCA drives through the Claude Agent SDK, not ACP; ` +
      `only the daemon's session factory opens it.`,
    { agentId },
  );
}

/**
 * Inherited variables that choose Claude's account, credential or provider, change what Claude
 * runs or loads (`CLAUDE_*` overrides such as an env file or a second config), or mark the
 * process as running inside another Claude Code (#1126). None of them comes from the daemon's
 * environment: the agent's own `env` is the only place ORCA takes one from. `CLAUDE_CONFIG_DIR`
 * is kept: it is where the person's own login and settings live, and ORCA writes nothing there.
 */
export function isClaudeCredentialVariable(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === "CLAUDE_CONFIG_DIR") return false;
  return (
    upper.startsWith("ANTHROPIC_") ||
    upper.startsWith("CLAUDE_") ||
    upper === "CLAUDECODE" ||
    upper === "AWS_BEARER_TOKEN_BEDROCK"
  );
}

/** What the agent's secret references were delivered, from `claudeSdkSecrets`. */
export interface ClaudeSdkDeliveredSecrets {
  env: Readonly<Record<string, string>>;
  withheld: readonly string[];
}

/**
 * The environment the SDK's `claude` runs with: `base` (the daemon's) without any Claude or
 * Anthropic variable and without what `delivered` withholds, then `orcaEnv` (what ORCA itself
 * adds to a session, filtered the same way and withheld the same way, so ORCA never sets a
 * variable the agent's config did not), the agent's literal `env`, and last the variables its secret references fill. A secret
 * reference that was not delivered is refused: it never falls back to anything inherited.
 */
export function claudeSdkEnvironment(
  agent: Pick<AgentSpec, "id" | "env">,
  base: Readonly<Record<string, string | undefined>>,
  orcaEnv: Readonly<Record<string, string>> = {},
  delivered: ClaudeSdkDeliveredSecrets = { env: {}, withheld: [] },
): Record<string, string> {
  const missing = Object.entries(agent.env)
    .filter(([k, v]) => isSecretRef(v) && delivered.env[k] === undefined)
    .map(([k]) => k);
  if (missing.length > 0)
    throw new OrcaError(
      "INTERNAL",
      `agent ${agent.id} takes ${missing.join(", ")} from a secret reference that was not delivered to this session.`,
      { agentId: agent.id, variables: missing },
    );
  const withheld = new Set(delivered.withheld.map((k) => k.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base))
    if (v !== undefined && !isClaudeCredentialVariable(k) && !withheld.has(k.toUpperCase())) env[k] = v;
  for (const [k, v] of Object.entries(orcaEnv))
    if (!isClaudeCredentialVariable(k) && !withheld.has(k.toUpperCase())) env[k] = v;
  const filled: Record<string, string> = {};
  for (const [k, v] of Object.entries(agent.env)) if (isSecretRef(v)) filled[k] = delivered.env[k]!;
  return { ...env, ...literalEnv(agent.env), ...filled };
}

/** A path segment that marks the SDK's own packages, the bundled per-platform CLI among them. */
const SDK_PACKAGE_SEGMENT = /[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk[^\\/]*[\\/]/i;

/**
 * The file `command` runs, by real path: an absolute or relative path as given, a bare name
 * through `PATH` (and `PATHEXT` on Windows). Refuses a missing or non-executable file and the
 * SDK's bundled CLI.
 */
export async function resolveClaudeExecutable(
  agent: Pick<AgentSpec, "id" | "command">,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const command = agent.command.length > 0 ? agent.command : CLAUDE_SDK_DEFAULT_COMMAND;
  const candidates = commandCandidates(command, env, cwd, platform);
  for (const candidate of candidates) {
    const real = await executableFile(candidate, platform);
    if (real === undefined) continue;
    if (SDK_PACKAGE_SEGMENT.test(real + sep))
      throw new OrcaError(
        "NOT_SUPPORTED",
        `agent ${agent.id} would run ${real}, the Claude Agent SDK's bundled CLI. driver: claude-agent-sdk runs only your own installed, ` +
          `unmodified \`claude\`: install Claude Code and point command at it.`,
        { agentId: agent.id, executable: real },
      );
    return real;
  }
  throw new OrcaError(
    "AGENT_TRANSPORT",
    `agent ${agent.id} has driver: claude-agent-sdk, but ${command} is not an executable ${isPathLike(command) ? "file" : "on PATH"}. ` +
      `Install Claude Code on this machine and sign in with \`claude auth login\`, or set command to its path.`,
    { agentId: agent.id, command },
  );
}

function isPathLike(command: string): boolean {
  return isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function commandCandidates(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  platform: NodeJS.Platform,
): string[] {
  if (isPathLike(command)) return [resolvePath(cwd, command)];
  const exts =
    platform === "win32"
      ? ["", ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e.length > 0)]
      : [""];
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(platform === "win32" ? ";" : delimiter);
  // An empty PATH entry means the current directory to a shell; ORCA does not search it.
  return dirs.filter((d) => d.length > 0 && isAbsolute(d)).flatMap((d) => exts.map((e) => join(d, command + e)));
}

async function executableFile(path: string, platform: NodeJS.Platform): Promise<string | undefined> {
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isFile()) return undefined;
    if (platform !== "win32") await access(real, fsConstants.X_OK);
  } catch {
    return undefined;
  }
  return real;
}

/** What `claude` said about itself before the session. */
export interface ClaudeSdkPreflight {
  /** The real path of the `claude` that runs. */
  executable: string;
  /** `claude --version`, as printed (first line). */
  version: string;
  /** `authMethod` from `claude auth status --json` (`oauth_token`, `api_key`, …). */
  authMethod: string;
  /** `apiProvider` from the same answer (`firstParty`, `bedrock`, …). */
  apiProvider: string;
  /** The environment the session's `claude` runs with (`claudeSdkEnvironment`). */
  env: Record<string, string>;
}

export interface ClaudeSdkPreflightOptions {
  agent: AgentSpec;
  cwd: string;
  /** The daemon's environment; `process.env` unless given. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** What ORCA adds to the session's environment (filtered like `baseEnv`). */
  orcaEnv?: Readonly<Record<string, string>>;
  /** What the agent's secret references were delivered (`claudeSdkSecrets`). */
  secrets?: ClaudeSdkDeliveredSecrets | undefined;
  /** Each of `claude --version` and `claude auth status` gets this long. Default 20 s. */
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  platform?: NodeJS.Platform | undefined;
  /**
   * Checked on the resolved `claude` before ORCA runs it at all, even for `--version` (#1124):
   * throws to refuse it. A returned `claudeCode` is the version it must then report, and a
   * returned `executable` is the file ORCA runs instead of the resolved one (its own copy of
   * the verified bytes). It gets `verifyTimeoutMs` and the preflight's cancellation through
   * `signal`; once either ends it, the preflight fails and no probe is started, whenever the
   * check itself returns.
   */
  verifyInstall?:
    | ((executable: string, signal: AbortSignal) => Promise<{ claudeCode: string; executable?: string } | undefined>)
    | undefined;
  /** How long `verifyInstall` gets, a first copy of the image included. Default 120 s. */
  verifyTimeoutMs?: number | undefined;
}

export const CLAUDE_SDK_PREFLIGHT_TIMEOUT_MS = 20_000;
export const CLAUDE_SDK_VERIFY_TIMEOUT_MS = 120_000;

/** Output beyond this is not an answer `claude` gives to these two commands. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Resolve the person's `claude`, build its environment, and check it is signed in. Throws an
 * `OrcaError` naming what to do for every way that can fail.
 */
export async function claudeSdkPreflight(options: ClaudeSdkPreflightOptions): Promise<ClaudeSdkPreflight> {
  const { agent, cwd } = options;
  const env = claudeSdkEnvironment(agent, options.baseEnv ?? process.env, options.orcaEnv, options.secrets);
  const resolved = await resolveClaudeExecutable(agent, env, cwd, options.platform);
  // Before it is run with the session's environment, credentials included.
  const expected = options.verifyInstall
    ? await verifyBounded(agent.id, resolved, options.verifyInstall, options.verifyTimeoutMs, options.signal)
    : undefined;
  const executable = expected?.executable ?? resolved;
  const timeoutMs = options.timeoutMs ?? CLAUDE_SDK_PREFLIGHT_TIMEOUT_MS;
  const run = (args: string[]) => runBounded(executable, args, { cwd, env, timeoutMs, signal: options.signal });
  return { executable, env, ...(await probeClaude(agent.id, executable, run, THIS_MACHINE, expected?.claudeCode)) };
}

/** Where a probed `claude` runs, as its errors name it. */
export interface ClaudeProbePlace {
  /** "on this machine", "on host build-box". */
  where: string;
  /** Where the person runs a command to fix it: "here", "on build-box". */
  there: string;
}

const THIS_MACHINE: ClaudeProbePlace = { where: "on this machine", there: "here" };

/**
 * Ask `claude` (through `run`) for its version and whether it is signed in, and refuse it for
 * every way that can fail. `expectedVersion`: the version a verified image must report.
 * Only the version number and two short identifiers are kept from what it printed.
 */
export async function probeClaude(
  agentId: string,
  executable: string,
  run: (args: string[]) => Promise<BoundedResult>,
  place: ClaudeProbePlace,
  expectedVersion?: string,
): Promise<Omit<ClaudeSdkPreflight, "executable" | "env">> {
  const agent = { id: agentId };
  /** Where the probe ran, named in a failure only when it is not this machine. */
  const at = place === THIS_MACHINE ? "" : ` ${place.where}`;

  const version = await run(["--version"]);
  // Only the version number is kept from what the CLI printed: `command` is configurable, so
  // its output is untrusted and none of its text reaches an error or a log.
  const versionOk = completed(version) && version.code === 0;
  const versionNumber = versionOk ? CLI_VERSION.exec(version.stdout.trim())?.[0] : undefined;
  if (versionNumber === undefined)
    throw new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agent.id}: ${executable} --version${at} ${versionOk ? "printed no Claude Code version" : describeFailure(version)}; ` +
        `it is not a Claude Code ORCA can run.`,
      { agentId: agent.id, executable, ...failureDetails(version) },
    );
  if (expectedVersion !== undefined && versionNumber !== expectedVersion)
    throw new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agent.id}: ${executable} is the image ORCA verified for Claude Code ${expectedVersion}, but it reports ${versionNumber}; ORCA refuses it.`,
      { agentId: agent.id, executable, expected: expectedVersion, reported: versionNumber },
    );

  const status = await run(["auth", "status", "--json"]);
  // A probe that did not finish (timeout, cancellation, signal, output over the cap, no
  // start) says nothing, whatever it printed first.
  const answer = completed(status) ? parseAuthStatus(status.stdout) : undefined;
  if (answer === undefined)
    throw new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agent.id}: ${executable} auth status ${completed(status) ? "gave no answer ORCA can read" : describeFailure(status)}, ` +
        `so ORCA cannot tell whether it is signed in. Check \`claude auth status\` ${place.where}.`,
      { agentId: agent.id, executable, ...failureDetails(status) },
    );
  // The known signed-out answer, which the CLI may give with a nonzero exit.
  if (answer.loggedIn === false)
    throw new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agent.id}: Claude Code is not signed in ${place.where}. Run \`claude auth login\` ${place.there} as the person whose ` +
        `account this agent uses (ORCA offers no login)${at ? "." : ", or give the agent its own API key in env."}`,
      { agentId: agent.id, executable, reason: "claude-not-logged-in" },
    );
  // Signed in counts only from a probe that finished and exited 0.
  if (status.code !== 0)
    throw new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agent.id}: ${executable} auth status said signed in but ${describeFailure(status)}, ` +
        `so ORCA does not take it as signed in. Check \`claude auth status\` ${place.where}.`,
      { agentId: agent.id, executable, ...failureDetails(status) },
    );
  return {
    version: versionNumber,
    authMethod: token(answer.authMethod),
    apiProvider: token(answer.apiProvider),
  };
}

/**
 * `verify(resolved)` with a deadline and the preflight's cancellation, both of which end it
 * through its signal and fail the preflight at once, even while the check is stuck in a call
 * the signal cannot reach (an open on a slow file system). Its later answer is then ignored:
 * the caller has already thrown, so no probe is started from it.
 */
async function verifyBounded(
  agentId: string,
  resolved: string,
  verify: NonNullable<ClaudeSdkPreflightOptions["verifyInstall"]>,
  timeoutMs: number = CLAUDE_SDK_VERIFY_TIMEOUT_MS,
  outer: AbortSignal | undefined,
): Promise<{ claudeCode: string; executable?: string } | undefined> {
  const cancelled = () =>
    new OrcaError("CANCELLED", `checking ${resolved} for agent ${agentId} was cancelled`, {
      agentId,
      executable: resolved,
    });
  if (outer?.aborted) throw cancelled();
  const controller = new AbortController();
  let ended: OrcaError | undefined;
  let fail: (error: OrcaError) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => (fail = reject));
  const end = (error: OrcaError) => {
    if (ended) return;
    ended = error;
    controller.abort();
    fail(error);
  };
  const timer = setTimeout(
    () =>
      end(
        new OrcaError(
          "AGENT_TRANSPORT",
          `agent ${agentId}: checking ${resolved} against ORCA's verified Claude Code took longer than ${Math.round(timeoutMs / 1000)} s; ORCA does not run it.`,
          { agentId, executable: resolved, reason: "verify-timeout" },
        ),
      ),
    timeoutMs,
  );
  const onAbort = () => end(cancelled());
  outer?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await Promise.race([verify(resolved, controller.signal), stopped]);
    if (ended) throw ended;
    return result;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
    stopped.catch(() => undefined);
  }
}

/** A Claude Code version number at the start of `claude --version`. */
const CLI_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?(?=\s|$)/;

/** A short identifier the CLI reported, or `unknown`: no other CLI text is kept. */
function token(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : "unknown";
}

/** The process ran to its own exit: not timed out, cancelled, signalled, over the cap or unstarted. */
function completed(r: BoundedResult): boolean {
  return (
    !r.timedOut && !r.aborted && !r.overLimit && r.signal === null && r.spawnError === undefined && r.code !== null
  );
}

interface AuthStatus {
  loggedIn?: unknown;
  authMethod?: unknown;
  apiProvider?: unknown;
}

/** The JSON object `claude auth status --json` prints, or undefined for anything else. */
export function parseAuthStatus(stdout: string): AuthStatus | undefined {
  const text = stdout.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    if (typeof (parsed as AuthStatus).loggedIn !== "boolean") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export interface BoundedResult {
  /** The exit code, when the process exited on its own; null otherwise. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Standard output, only when the process completed within the cap. Standard error is never read. */
  stdout: string;
  timedOut: boolean;
  aborted: boolean;
  /** Standard output went over `MAX_OUTPUT_BYTES`; the process was killed. */
  overLimit: boolean;
  /** The process could not be started: the system error code (`ENOENT`, `EACCES`, …). */
  spawnError?: string;
}

/**
 * After ORCA kills a probe, how long it waits for the pipe to close before settling anyway. A
 * descendant that inherited standard output can hold the pipe open after the probe is gone.
 */
export const PROBE_KILL_SETTLE_MS = 1_000;

/**
 * Run `file` with a deadline, a cancellation signal and an output cap, each of which kills it
 * and is reported by its own flag. Standard error goes nowhere: none of the CLI's text is kept.
 *
 * Bounded whatever the probe does: an already-cancelled signal spawns nothing; on POSIX the
 * probe gets its own process group and a kill is sent to the whole group; once killed, the
 * promise settles when the pipe closes or `PROBE_KILL_SETTLE_MS` later, whichever is first, with
 * the pipe destroyed. It owns only the processes it started; nothing here is a session.
 */
export function runBounded(
  file: string,
  args: string[],
  o: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    /** Written to the program's stdin, which is then closed; without it stdin is not opened. */
    input?: string | undefined;
  },
): Promise<BoundedResult> {
  if (o.signal?.aborted)
    return Promise.resolve({
      code: null,
      signal: null,
      stdout: "",
      timedOut: false,
      aborted: true,
      overLimit: false,
    });
  return new Promise((resolveResult) => {
    const flags = { timedOut: false, aborted: false, overLimit: false };
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let killed = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    const group = process.platform !== "win32";
    const child = spawn(file, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      windowsHide: true,
      detached: group,
    });
    // stdout is always piped.
    const out = child.stdout!;
    if (o.input !== undefined && child.stdin) {
      // A program that exits without reading it closes the pipe; that is its answer, not an error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(o.input);
    }
    const finish = (r: Omit<BoundedResult, "timedOut" | "aborted" | "overLimit" | "stdout">) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(settleTimer);
      o.signal?.removeEventListener("abort", onAbort);
      out.destroy();
      const clean = !killed && r.spawnError === undefined;
      resolveResult({ ...r, ...flags, stdout: clean ? Buffer.concat(chunks).toString("utf8") : "" });
    };
    const kill = () => {
      if (killed) return;
      killed = true;
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      out.destroy();
      settleTimer = setTimeout(() => finish(exit ?? { code: null, signal: null }), PROBE_KILL_SETTLE_MS);
    };
    const deadline = setTimeout(() => {
      flags.timedOut = true;
      kill();
    }, o.timeoutMs);
    const onAbort = () => {
      flags.aborted = true;
      kill();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    out.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        flags.overLimit = true;
        kill();
        return;
      }
      chunks.push(chunk);
    });
    // A destroyed pipe may report an error; the flags already say why.
    out.on("error", () => undefined);
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish({ code: null, signal: null, spawnError: /^[A-Z0-9_]{1,40}$/.test(e.code ?? "") ? e.code! : "UNKNOWN" });
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // Killed: the pipe may never close (a descendant holds it); do not wait on it.
      if (killed) finish(exit);
    });
    child.on("close", (code, signal) => finish(exit ?? { code, signal }));
  });
}

function describeFailure(r: BoundedResult): string {
  if (r.aborted) return "was cancelled";
  if (r.timedOut) return "did not answer in time";
  if (r.overLimit) return "printed more than ORCA reads";
  if (r.spawnError) return `could not start (${r.spawnError})`;
  if (r.signal) return `was ended by ${r.signal}`;
  return `exited with ${r.code ?? "no code"}`;
}

function failureDetails(r: BoundedResult): Record<string, unknown> {
  return {
    exitCode: r.code,
    ...(r.signal ? { signal: r.signal } : {}),
    ...(r.timedOut ? { timedOut: true } : {}),
    ...(r.aborted ? { aborted: true } : {}),
    ...(r.overLimit ? { overLimit: true } : {}),
    ...(r.spawnError ? { spawnError: r.spawnError } : {}),
    // Nothing the CLI printed: its output is untrusted and may carry anything.
  };
}
