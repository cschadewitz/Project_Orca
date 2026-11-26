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
 * - **Credentials.** ORCA offers no login and never opens anything under Claude's config
 *   directory, keychain or token files. The child's environment is the daemon's with every
 *   Anthropic and Claude Code variable taken out (`claudeSdkEnvironment`), then the agent's own
 *   literal `env`: a credential reaches Claude only from the agent's config or from the login
 *   Claude keeps itself. Secret references wait for the session driver's secret delivery (#1126).
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
 * Inherited variables Claude reads its account, credential or provider from, or that mark the
 * process as running inside another Claude Code. None of them comes from the daemon's
 * environment: the agent's own `env` is the only place ORCA takes one from.
 */
export function isClaudeCredentialVariable(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === "CLAUDE_CONFIG_DIR") return false;
  return (
    upper.startsWith("ANTHROPIC_") ||
    upper.startsWith("CLAUDE_CODE_") ||
    upper === "CLAUDECODE" ||
    upper.startsWith("CLAUDE_SESSION_") ||
    upper === "AWS_BEARER_TOKEN_BEDROCK"
  );
}

/**
 * The environment the SDK's `claude` runs with: `base` (the daemon's) without any Claude or
 * Anthropic credential variable, then the agent's literal `env`. `orcaEnv`, what ORCA itself adds
 * to a session, is filtered the same way, so ORCA never sets a credential variable the agent's
 * config did not.
 */
export function claudeSdkEnvironment(
  agent: Pick<AgentSpec, "id" | "env">,
  base: Readonly<Record<string, string | undefined>>,
  orcaEnv: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const refs = Object.entries(agent.env)
    .filter(([, v]) => isSecretRef(v))
    .map(([k]) => k);
  if (refs.length > 0)
    throw new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agent.id} has driver: claude-agent-sdk and takes ${refs.join(", ")} from a secret reference; ` +
        `the Claude Agent SDK driver does not deliver secrets yet (#1126). Sign in with \`claude auth login\` instead, or use the ACP route.`,
      { agentId: agent.id, variables: refs },
    );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !isClaudeCredentialVariable(k)) env[k] = v;
  for (const [k, v] of Object.entries(orcaEnv)) if (!isClaudeCredentialVariable(k)) env[k] = v;
  return { ...env, ...literalEnv(agent.env) };
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
  /** Each of `claude --version` and `claude auth status` gets this long. Default 20 s. */
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  platform?: NodeJS.Platform | undefined;
}

export const CLAUDE_SDK_PREFLIGHT_TIMEOUT_MS = 20_000;

/** Output beyond this is not an answer `claude` gives to these two commands. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Resolve the person's `claude`, build its environment, and check it is signed in. Throws an
 * `OrcaError` naming what to do for every way that can fail.
 */
export async function claudeSdkPreflight(options: ClaudeSdkPreflightOptions): Promise<ClaudeSdkPreflight> {
  const { agent, cwd } = options;
  const env = claudeSdkEnvironment(agent, options.baseEnv ?? process.env, options.orcaEnv);
  const executable = await resolveClaudeExecutable(agent, env, cwd, options.platform);
  const timeoutMs = options.timeoutMs ?? CLAUDE_SDK_PREFLIGHT_TIMEOUT_MS;
  const run = (args: string[]) => runBounded(executable, args, { cwd, env, timeoutMs, signal: options.signal });

  const version = await run(["--version"]);
  // Only the version number is kept from what the CLI printed: `command` is configurable, so
  // its output is untrusted and none of its text reaches an error or a log.
  const versionNumber = completed(version) ? CLI_VERSION.exec(version.stdout.trim())?.[0] : undefined;
  if (versionNumber === undefined)
    throw new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agent.id}: ${executable} --version ${completed(version) ? "printed no Claude Code version" : describeFailure(version)}; ` +
        `it is not a Claude Code ORCA can run.`,
      { agentId: agent.id, executable, ...failureDetails(version) },
    );

  const status = await run(["auth", "status", "--json"]);
  // A probe that did not finish (timeout, cancellation, signal, output over the cap, no
  // start) says nothing, whatever it printed first.
  const answer = completed(status) ? parseAuthStatus(status.stdout) : undefined;
  if (answer === undefined)
    throw new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agent.id}: ${executable} auth status ${completed(status) ? "gave no answer ORCA can read" : describeFailure(status)}, ` +
        `so ORCA cannot tell whether it is signed in. Check \`claude auth status\` on this machine.`,
      { agentId: agent.id, executable, ...failureDetails(status) },
    );
  // The known signed-out answer, which the CLI may give with a nonzero exit.
  if (answer.loggedIn === false)
    throw new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agent.id}: Claude Code is not signed in on this machine. Run \`claude auth login\` here as the person whose ` +
        `account this agent uses (ORCA offers no login), or give the agent its own API key in env.`,
      { agentId: agent.id, executable, reason: "claude-not-logged-in" },
    );
  // Signed in counts only from a probe that finished and exited 0.
  if (status.code !== 0)
    throw new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agent.id}: ${executable} auth status said signed in but ${describeFailure(status)}, ` +
        `so ORCA does not take it as signed in. Check \`claude auth status\` on this machine.`,
      { agentId: agent.id, executable, ...failureDetails(status) },
    );
  return {
    executable,
    version: versionNumber,
    authMethod: token(answer.authMethod),
    apiProvider: token(answer.apiProvider),
    env,
  };
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

interface BoundedResult {
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
 * Run `file` with a deadline, a cancellation signal and an output cap, each of which kills it
 * and is reported by its own flag. Standard error goes nowhere: none of the CLI's text is kept.
 */
function runBounded(
  file: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<BoundedResult> {
  return new Promise((resolveResult) => {
    const flags = { timedOut: false, aborted: false, overLimit: false };
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const child = spawn(file, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      flags.timedOut = true;
      kill();
    }, o.timeoutMs);
    const onAbort = () => {
      flags.aborted = true;
      kill();
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: Omit<BoundedResult, "timedOut" | "aborted" | "overLimit" | "stdout">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      const clean = !flags.timedOut && !flags.aborted && !flags.overLimit && r.spawnError === undefined;
      resolveResult({ ...r, ...flags, stdout: clean ? Buffer.concat(chunks).toString("utf8") : "" });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        flags.overLimit = true;
        kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish({ code: null, signal: null, spawnError: /^[A-Z0-9_]{1,40}$/.test(e.code ?? "") ? e.code! : "UNKNOWN" });
    });
    child.on("close", (code, signal) => finish({ code, signal }));
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

/**
 * Open a session on the Claude Agent SDK driver. For now the launch checks run and then the
 * open is refused: the session itself is the next slice (#1120), and nothing half-built may run
 * a turn.
 */
export async function refuseClaudeSdkSessionUntilDriver(options: ClaudeSdkPreflightOptions): Promise<never> {
  const preflight = await claudeSdkPreflight(options);
  throw new OrcaError(
    "NOT_SUPPORTED",
    `agent ${options.agent.id} has driver: claude-agent-sdk. Its Claude Code (${preflight.version}, ${preflight.executable}) is ` +
      `signed in, but the Claude Agent SDK session driver is not built yet (#1120); remove driver to run it over ACP.`,
    { agentId: options.agent.id, executable: preflight.executable, version: preflight.version },
  );
}
