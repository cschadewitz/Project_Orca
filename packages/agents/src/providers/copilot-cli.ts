/**
 * GitHub Copilot CLI over its own ACP server (`copilot --acp`, #709).
 *
 * ORCA talks to Copilot through the generic ACP session like any other agent. This module holds
 * only what is specific to Copilot, and every part of it closes a route by which Copilot would
 * otherwise run tools without ORCA's policy seeing them. Each was observed on the real Copilot
 * CLI (`copilot-cli-acceptance.yml`, docs/agent-support.md):
 *
 * - **Launch profile.** Flags and variables that grant approval up front (`--allow-all`,
 *   `--yolo`, `COPILOT_ALLOW_ALL`, autopilot, …) are refused, as is a GitHub token written into
 *   ORCA's config or inherited from the daemon's environment (it silently replaces the login
 *   the person chose). Copilot's own state directory must be named (`COPILOT_HOME`), and auto-update must
 *   be off so the build ORCA checked is the build that runs.
 * - **Executable.** The SHA-256 of the executable must be a pinned build for this platform
 *   (`COPILOT_CLI_VERIFIED_BUILDS`), checked before every session.
 * - **Copilot's profile.** `COPILOT_HOME` is inspected before every session, deny by default:
 *   saved approvals, trusted folders, non-cosmetic settings, hooks, MCP servers, plugins and
 *   anything unrecognised are refused (`copilotHomeProblems`).
 * - **Slash commands.** Copilot runs a prompt that starts with `/` as one of its own commands,
 *   over ACP too, and `/allow-all on`, `/yolo`, `/permissions allow-all` and `/autopilot on`
 *   turn its permission asks off for the rest of the session without any notice to the client.
 *   A prompt that starts with a slash command is refused before it is sent.
 * - **Session options.** Copilot advertises an `allow_all` option and an autopilot mode. ORCA
 *   refuses to set either, refuses a session that opens with either on, and ends a session that
 *   reports either turned on.
 * - **"Always" answers.** Copilot's "Always allow" approves the whole command name (`touch`,
 *   whatever its arguments) for the rest of the session, without asking again. ORCA answers an
 *   ask with "Allow once" instead, whatever was chosen, so every later call is asked about
 *   again and decided by ORCA's own policy, which keeps its own "always" rules.
 *
 * What stays outside, because Copilot never asks: commands Copilot classifies as read-only, file
 * reads inside the workspace, and text typed into a shell it already started. See the matrix.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath, win32 } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { OrcaError, isSecretRef, literalEnv, type AgentSpec, type SessionConfigOption } from "@orca/core";
import type { OpenSessionOptions } from "../acp-session.js";
import type { AgentHost, SpawnAgentOptions } from "../host.js";
import { planSessionSecrets, withoutWithheld } from "../secrets.js";
import type { AgentSession } from "../session.js";
import type { ProviderGuard } from "./guard.js";

/**
 * The Copilot CLI builds ORCA has run its acceptance suite against, by platform, as the SHA-256
 * of the executable npm installs from `@github/copilot-<platform>`. Any other executable,
 * version or platform is refused: the routes this module closes are behaviour of one build,
 * and another can add one. Moving the pin is a reviewed change here and in
 * `copilot-cli-acceptance.yml` together.
 */
export const COPILOT_CLI_VERIFIED_BUILDS: readonly { version: string; platform: string; sha256: string }[] = [
  {
    version: "1.0.114",
    platform: "linux-x64",
    sha256: "990cc6cf4e171ef88b6e3c873f7b62c0dc044b223a7ace518ac284baf2578fc6",
  },
  {
    version: "1.0.114",
    platform: "darwin-arm64",
    sha256: "be83aa2f10d85e76063c33995382a33c5fa6893d48343a8a6c897a9e825f15c6",
  },
];
/** The versions in `COPILOT_CLI_VERIFIED_BUILDS`. */
export const COPILOT_CLI_VERIFIED_VERSIONS: readonly string[] = [
  ...new Set(COPILOT_CLI_VERIFIED_BUILDS.map((b) => b.version)),
];

/** Launch options that grant, widen or bypass Copilot's own permission asks. */
const GRANTING_FLAGS = [
  "--allow-all",
  "--allow-all-tools",
  "--allow-all-paths",
  "--allow-all-urls",
  "--yolo",
  "--allow-tool",
  "--allow-url",
  "--autopilot",
  "--assisted-approval",
  "--no-sandbox",
  "--trust-folder",
  "--add-dir",
] as const;
/** Options that change what ORCA is talking to, or resume somebody else's session. */
const TRANSPORT_FLAGS = ["--port", "--resume", "--continue", "--prompt", "-p"] as const;
/** Variables that carry a credential. A literal in ORCA's config is refused; a secret reference is fine. */
export const COPILOT_TOKEN_VARIABLES = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COPILOT_PROVIDER_API_KEY",
] as const;
/** Variables that would turn permission asks off, by their documented truthy spellings. */
const GRANTING_VARIABLES = ["COPILOT_ALLOW_ALL", "COPILOT_PLAN_THEN_AUTOPILOT", "COPILOT_ASSISTED_APPROVAL"] as const;
/** The documented false spellings of a boolean variable; absence counts as false too. */
const FALSEY = new Set(["false", "0", "no", "off", "n", ""]);

const flagName = (arg: string) => arg.split("=", 1)[0]!;

/** Copilot's executable name: `copilot` (Linux, macOS) or `copilot.exe` (Windows). */
export function isCopilotCliAgent(agent: Pick<AgentSpec, "command" | "args" | "type">): boolean {
  if (agent.type === "orca-daemon") return false;
  const name = win32
    .basename(agent.command)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (name === "copilot") return true;
  // A package runner that would fetch Copilot at launch is Copilot too, and is refused below.
  return /^(npx|pnpx|bunx|npm|pnpm)$/i.test(name) && agent.args.some((a) => a.startsWith("@github/copilot"));
}

/**
 * What is wrong with this launch profile, as the host would start it: the agent's `env` over
 * `ambient`, the daemon's own environment, less what ORCA withholds for secrets. Empty when
 * none of the known hazards is present; it says nothing about the version, which is checked
 * against the executable itself.
 */
export function copilotCliProfileProblems(
  agent: AgentSpec,
  ambient: Readonly<Record<string, string | undefined>>,
  hostType: "local" | "ssh" | undefined,
  /** The session's own overrides (`OpenSessionOptions.env`), laid over the agent's env as the host does. */
  sessionEnv: Readonly<Record<string, string>> = {},
  /**
   * The variables a secret fills. The host sets these last, over the session's overrides, so
   * their values are never known here. By default, the names the agent's env refers to a
   * secret for; a start passes its actual deliveries (`SpawnAgentOptions.secrets`).
   */
  fromSecrets: ReadonlySet<string> = new Set(
    Object.entries(agent.env).flatMap(([k, v]) => (isSecretRef(v) ? [k] : [])),
  ),
): string[] {
  const problems: string[] = [];
  const name = win32
    .basename(agent.command)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (name !== "copilot")
    problems.push(
      "command: start the copilot executable itself (an absolute path), not a package runner that fetches a version at launch",
    );
  else if (!isAbsolute(agent.command) && !win32.isAbsolute(agent.command))
    problems.push("command: give the copilot executable as an absolute path, so PATH order cannot swap it");
  if (hostType !== "local")
    problems.push(
      "host: Copilot is supported on this computer only; its environment on another host cannot be checked",
    );

  const flags = agent.args.map(flagName);
  if (!flags.includes("--acp")) problems.push("args: --acp is missing");
  if (!flags.includes("--no-auto-update")) problems.push("args: --no-auto-update is missing");
  for (const flag of GRANTING_FLAGS)
    if (flags.includes(flag)) problems.push(`args: ${flag} approves tools without asking ORCA`);
  for (const flag of TRANSPORT_FLAGS) if (flags.includes(flag)) problems.push(`args: ${flag} is not supported`);
  const mode = agent.args.findIndex((a) => flagName(a) === "--mode");
  if (mode >= 0) {
    const arg = agent.args[mode]!;
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : agent.args[mode + 1];
    if (value !== "interactive") problems.push(`args: --mode ${value ?? ""} is not supported`.trim());
  }

  // What the host gives the process: the daemon's environment (less what is withheld), the
  // agent's literal env, the session's overrides, and last the secrets, whose values are not
  // known here. A variable a secret fills is opaque whatever was written before it.
  const configured: Record<string, string> = { ...literalEnv(agent.env), ...sessionEnv };
  const effective: Record<string, string | undefined> = { ...ambient, ...configured };
  const hidden = (variable: string) => fromSecrets.has(variable);
  for (const variable of ["COPILOT_HOME", "COPILOT_AUTO_UPDATE", ...GRANTING_VARIABLES])
    if (hidden(variable)) problems.push(`env: ${variable} comes from a secret, so ORCA cannot check it; write it out`);
  for (const variable of GRANTING_VARIABLES) {
    const value = effective[variable];
    if (value !== undefined && !hidden(variable) && !FALSEY.has(value.trim().toLowerCase()))
      problems.push(
        `env: ${variable} approves tools without asking ORCA${configured[variable] === undefined ? " (inherited from the daemon's environment)" : ""}`,
      );
  }
  if (!hidden("COPILOT_AUTO_UPDATE") && !FALSEY.has((effective.COPILOT_AUTO_UPDATE ?? "unset").trim().toLowerCase()))
    problems.push('env: set COPILOT_AUTO_UPDATE to "false"');
  const home = configured.COPILOT_HOME;
  if (!hidden("COPILOT_HOME") && (!home || !(isAbsolute(home) || win32.isAbsolute(home))))
    problems.push("env: set COPILOT_HOME to an absolute directory that only this agent's Copilot uses");
  else if (home && home !== resolvePath(home))
    // The spelling Copilot gets must be the path ORCA inspects: no `.`, `..`, doubled or trailing separators.
    problems.push(`env: write COPILOT_HOME as ${resolvePath(home)}, the path ORCA checks and Copilot opens`);
  for (const variable of [...COPILOT_TOKEN_VARIABLES, "COPILOT_PROVIDER_API_KEY_COMMAND"]) {
    const fromConfig = agent.env[variable];
    if (sessionEnv[variable] !== undefined || (fromConfig !== undefined && !isSecretRef(fromConfig)))
      problems.push(`env: ${variable} is written into ORCA's config; refer to it as a secret instead`);
    else if (!fromSecrets.has(variable) && (ambient[variable] ?? "") !== "")
      problems.push(
        `env: ${variable} is inherited from the daemon's environment and would replace the Copilot sign-in; define it as a secret (which withholds it) or start ORCA without it`,
      );
  }
  return problems;
}

/** `copilot --version` prints "GitHub Copilot CLI 1.0.114." */
export function parseCopilotCliVersion(output: string): string | undefined {
  return /GitHub Copilot CLI (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

export type FileDigest = (path: string) => Promise<string>;

/** SHA-256 of a file, streamed. */
export const sha256File: FileDigest = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/** Digests already taken, by resolved path, inode, size and change times. */
const digestCache = new Map<string, string>();

/**
 * The executable the command names, resolved through links, must be a regular file whose
 * SHA-256 is a verified build for this platform. This identifies the bytes at the path when
 * ORCA checks; a file swapped between the check and the spawn, or a verified build started
 * through a wrapper, is not caught (docs/agent-support.md, "Executable identity").
 */
async function checkExecutable(agent: AgentSpec, digest: FileDigest, platform: string): Promise<string> {
  const builds = COPILOT_CLI_VERIFIED_BUILDS.filter((b) => b.platform === platform);
  if (!builds.length)
    throw new OrcaError(
      "NOT_SUPPORTED",
      `Copilot CLI is verified on ${[...new Set(COPILOT_CLI_VERIFIED_BUILDS.map((b) => b.platform))].join(", ")}, not on ${platform}; agent '${agent.id}' was not started.`,
      { agentId: agent.id, platform },
    );
  let path: string;
  let key: string;
  try {
    path = await realpath(agent.command);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a regular file");
    key = `${path}\0${info.dev}\0${info.ino}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}`;
  } catch (error) {
    throw new OrcaError(
      "AGENT_TRANSPORT",
      `Copilot CLI executable for agent '${agent.id}' cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      { agentId: agent.id },
    );
  }
  let sum = digestCache.get(key);
  if (!sum) {
    sum = await digest(path);
    digestCache.set(key, sum);
  }
  const build = builds.find((b) => b.sha256 === sum);
  if (!build)
    throw new OrcaError(
      "NOT_SUPPORTED",
      `Agent '${agent.id}' is not a verified Copilot CLI build (SHA-256 ${sum.slice(0, 12)}…). ORCA opens only Copilot CLI ${builds.map((b) => b.version).join(", ")} for ${platform}, as npm installs it; keep auto-update off.`,
      { agentId: agent.id, sha256: sum, platform },
    );
  return build.version;
}

/* ------------------------------ Copilot's own profile ------------------------------ */

/** What may be at the top of `COPILOT_HOME`. Anything else is refused by name. */
const PROFILE_ENTRIES = new Map<string, "file" | "directory">([
  ["config.json", "file"],
  ["settings.json", "file"],
  ["settings.json.lock", "file"],
  ["permissions-config.json", "file"],
  ["logs", "directory"],
  ["session-state", "directory"],
  ["session-store.db", "file"],
  ["session-store.db-wal", "file"],
  ["session-store.db-shm", "file"],
  ["session-store.db-journal", "file"],
  ["installed-plugins", "directory"],
  ["command-history-state.json", "file"],
]);
/**
 * `config.json` is managed by Copilot: the first-launch time, and the sign-in when the person
 * ran `copilot login` (the account list, and the token itself when no keychain is available).
 * Any other key, including `trustedFolders`, is refused by name.
 */
const CONFIG_KEYS = new Set(["firstLaunchAt", "loggedInUsers", "lastLoggedInUser", "copilot_tokens", "copilotTokens"]);
/** `settings.json` keys that change only how Copilot looks or sounds. Any other is refused. */
const SETTINGS_KEYS = new Set([
  "banner",
  "bannerStyle",
  "beep",
  "beepOnSchedule",
  "notifications",
  "terminalNotifications",
  "compactPaste",
  "copyOnSelect",
  "commandHistoryMaxSize",
  "keepAlive",
  "logLevel",
  "model",
  "autoUpdate",
]);

/** Copilot writes JSON with `//` comment lines at the top. */
function parseCommentedJson(text: string): unknown {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

/** True when anything in the value would grant: a non-empty list or a true flag, anywhere. */
function holdsGrant(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === true) return true;
  if (value && typeof value === "object") return Object.values(value).some(holdsGrant);
  return false;
}

/**
 * Problems with `COPILOT_HOME` as Copilot would start from it. Deny by default: the directory
 * must be ORCA's or the person's alone, and hold only what a fresh or signed-in profile holds,
 * with no saved approvals, trusted folders, hooks, MCP servers, plugins, agents, skills or
 * settings beyond the cosmetic ones. Anything ORCA does not recognise is refused by name,
 * because it cannot tell whether it grants anything.
 */
export async function copilotHomeProblems(home: string): Promise<string[]> {
  // Every read below uses `home` as given, the same spelling Copilot receives, so it must
  // already be canonical: resolving it here would inspect one path and launch another.
  if (home !== resolvePath(home))
    return [`COPILOT_HOME ${home} is not a canonical path; write it as ${resolvePath(home)}`];
  let info;
  try {
    info = await lstat(home);
  } catch (error) {
    // Only a confirmed absence is empty, and only where no one else can put a profile in its
    // place before Copilot creates it on first launch.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return enclosingCustodyProblems(home);
    return [`COPILOT_HOME ${home} cannot be inspected (${(error as NodeJS.ErrnoException).code ?? "error"})`];
  }
  const problems = ownership(`COPILOT_HOME ${home}`, info, "directory");
  if (!problems.length) problems.push(...(await pathCustodyProblems(dirname(home), home)));
  if (problems.length) return problems;
  let names: string[];
  try {
    names = await readdir(home);
  } catch (error) {
    return [`COPILOT_HOME ${home} cannot be listed (${(error as NodeJS.ErrnoException).code ?? "error"})`];
  }
  for (const name of names.sort()) {
    const kind = PROFILE_ENTRIES.get(name);
    if (!kind) {
      problems.push(`COPILOT_HOME holds ${name}, which ORCA cannot tell is harmless`);
      continue;
    }
    const path = join(home, name);
    try {
      const entry = ownership(`COPILOT_HOME ${name}`, await lstat(path), kind);
      if (entry.length) {
        problems.push(...entry);
        continue;
      }
      if (name === "installed-plugins") {
        if ((await readdir(path)).length) problems.push("COPILOT_HOME has installed plugins");
      } else if (name === "config.json") {
        for (const key of Object.keys(await jsonObject(path)))
          if (!CONFIG_KEYS.has(key)) problems.push(`COPILOT_HOME config.json sets ${key}`);
      } else if (name === "settings.json") {
        for (const key of Object.keys(await jsonObject(path)))
          if (!SETTINGS_KEYS.has(key)) problems.push(`COPILOT_HOME settings.json sets ${key}`);
      } else if (name === "permissions-config.json") {
        if (holdsGrant(await jsonObject(path)))
          problems.push("COPILOT_HOME permissions-config.json holds saved approvals");
      }
    } catch {
      problems.push(`COPILOT_HOME ${name} cannot be read`);
    }
  }
  return problems;
}

/** Not a link, the expected type, the user's own and not writable by anybody else. */
function ownership(what: string, info: Stats, kind: "file" | "directory"): string[] {
  if (info.isSymbolicLink()) return [`${what} is a symbolic link`];
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) return [`${what} is not a ${kind}`];
  const problems: string[] = [];
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
      problems.push(`${what} belongs to another user`);
    if (info.mode & 0o022) problems.push(`${what} can be written by other users`);
  }
  return problems;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "error";

/**
 * Problems with the path to `COPILOT_HOME`: it must be canonical, with no link anywhere on it,
 * so the path checked is the path opened, and no one but the user or root may be able to
 * replace a directory on it and so swap the profile Copilot opens for another. Every directory
 * from the root down to `dir` must belong to the user or to root and be closed to other
 * writers; a root-owned sticky directory such as /tmp counts as closed, because no one else can
 * replace an entry in it. `dir` is the directory that holds the profile, or would hold it, and
 * must exist.
 */
async function pathCustodyProblems(dir: string, home: string): Promise<string[]> {
  if (process.platform === "win32") return [];
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const on = `on the path to COPILOT_HOME ${home}`;
  for (let path = dir; ; path = dirname(path)) {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      return [`${path}, ${on}, cannot be inspected (${errorCode(error)})`];
    }
    if (info.isSymbolicLink()) return [`${path}, ${on}, is a symbolic link; give COPILOT_HOME as a path without links`];
    if (!info.isDirectory()) return [`${path}, ${on}, is not a directory`];
    if (info.uid !== 0 && info.uid !== uid) return [`${path}, ${on}, belongs to another user`];
    if (info.mode & 0o022 && !(info.uid === 0 && info.mode & 0o1000))
      return [`${path}, ${on}, can be changed by other users`];
    if (path === dirname(path)) return [];
  }
}

/**
 * Problems with where a missing `COPILOT_HOME` would be created. Each missing component must be
 * genuinely absent (a dangling link is refused, since Copilot would follow it), the nearest
 * existing ancestor must be a directory of the current user's that no one else can write to,
 * and the path to it must pass `pathCustodyProblems`. Otherwise another user could create the
 * profile, or swap the path, between this check and Copilot's first launch.
 */
async function enclosingCustodyProblems(home: string): Promise<string[]> {
  let parent = dirname(home);
  let info;
  for (;;) {
    try {
      info = await lstat(parent);
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || parent === dirname(parent))
        return [
          `COPILOT_HOME ${home} does not exist, and ${parent}, where it would be created, cannot be inspected (${errorCode(error)})`,
        ];
      parent = dirname(parent);
    }
  }
  const problems = ownership(`${parent}, where COPILOT_HOME ${home} would be created,`, info, "directory");
  return problems.length ? problems : pathCustodyProblems(parent, home);
}

/** A Copilot JSON file whose top level is an object; anything else is refused as unreadable. */
async function jsonObject(path: string): Promise<Record<string, unknown>> {
  const value = parseCommentedJson(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a JSON object");
  return value as Record<string, unknown>;
}

/** A prompt Copilot would run as one of its own commands: text whose first character is `/`. */
export function startsWithSlashCommand(input: string | readonly acp.ContentBlock[]): boolean {
  const blocks: readonly acp.ContentBlock[] = typeof input === "string" ? [{ type: "text", text: input }] : input;
  return blocks.some((b) => b.type === "text" && /^\s*\//.test(b.text));
}

/** Copilot's session options that turn its permission asks off. */
export function grantingOption(configId: string, value: unknown): boolean {
  if (configId === "allow_all") return value === true || value === "on";
  if (configId === "mode") return typeof value === "string" && /autopilot/i.test(value);
  return false;
}

function grantingOptionsIn(options: readonly SessionConfigOption[]): string[] {
  return options.filter((o) => grantingOption(o.id, (o as { currentValue?: unknown }).currentValue)).map((o) => o.id);
}

/** "Always allow" becomes "Allow once"; with no once option offered, nothing is chosen. */
export function boundedOptionId(request: acp.RequestPermissionRequest, chosen: string | undefined): string | undefined {
  if (chosen === undefined) return undefined;
  const option = request.options.find((o) => o.optionId === chosen);
  if (!option) return chosen;
  if (option.kind === "allow_always") return request.options.find((o) => o.kind === "allow_once")?.optionId;
  if (option.kind === "reject_always") return request.options.find((o) => o.kind === "reject_once")?.optionId ?? chosen;
  return chosen;
}

/** Enforce the session half: slash prompts, allow-all and autopilot. */
export function guardCopilotSession(session: AgentSession): AgentSession {
  let tripped: string[] = grantingOptionsIn(session.configOptions);
  const refuseOpen = tripped.length > 0;
  const fail = (what: string) =>
    new OrcaError(
      "NOT_SUPPORTED",
      `Copilot session ${what}: ${tripped.join(", ")} approves tools without asking ORCA, so the session was ended.`,
      { agentId: session.agentId, options: [...tripped] },
    );
  const stop = session.onUpdate((e) => {
    if (e.raw.sessionUpdate !== "config_option_update") return;
    const on = grantingOptionsIn(session.configOptions);
    if (!on.length) return;
    tripped = on;
    void session.cancel().finally(() => session.close());
  });
  const guarded: AgentSession = Object.create(session) as AgentSession;
  Object.defineProperties(guarded, {
    prompt: {
      writable: true,
      value: async (input: Parameters<AgentSession["prompt"]>[0], options?: Parameters<AgentSession["prompt"]>[1]) => {
        if (tripped.length) throw fail("turned on");
        if (startsWithSlashCommand(input))
          throw new OrcaError(
            "NOT_SUPPORTED",
            "Copilot runs a prompt that starts with '/' as one of its own commands, some of which turn its permission asks off; ORCA does not send one. Reword the prompt so it does not start with '/'.",
            { agentId: session.agentId },
          );
        const result = await session.prompt(input, options);
        if (tripped.length) throw fail("turned on");
        return result;
      },
    },
    setConfigOption: {
      writable: true,
      value: async (configId: string, value: string | boolean) => {
        if (grantingOption(configId, value))
          throw new OrcaError(
            "NOT_SUPPORTED",
            `ORCA does not set Copilot's '${configId}' to '${String(value)}': it approves tools without asking ORCA.`,
            { agentId: session.agentId, configId },
          );
        return session.setConfigOption(configId, value);
      },
    },
    close: {
      writable: true,
      value: async () => {
        stop();
        return session.close();
      },
    },
  });
  if (refuseOpen) {
    void session.close();
    throw fail("opened with");
  }
  return guarded;
}

export interface CopilotCliGuardOptions {
  /** Hashes the executable; `sha256File` by default. */
  digest?: FileDigest;
  /** `<process.platform>-<process.arch>` by default. */
  platform?: string;
  /** The daemon's environment, which a local agent inherits; `process.env` by default. */
  environment?: () => Readonly<Record<string, string | undefined>>;
}

function refusal(agentId: string, problems: string[]): OrcaError {
  return new OrcaError("CONFIG_INVALID", `Copilot agent '${agentId}' cannot start: ${problems.join("; ")}.`, {
    agentId,
    problems,
  });
}

export function copilotCliGuard(guardOptions: CopilotCliGuardOptions = {}): ProviderGuard {
  const digest = guardOptions.digest ?? sha256File;
  const platform = guardOptions.platform ?? `${process.platform}-${process.arch}`;
  const environment = guardOptions.environment ?? (() => process.env);
  /**
   * The checks on one start, as `LocalHost.spawnAgent` builds its environment: the daemon's
   * own less what is withheld, the agent's literal env, the session's overrides, then secrets.
   */
  const launchProblems = async (
    agent: AgentSpec,
    hostType: "local" | "ssh" | undefined,
    spawn: Pick<SpawnAgentOptions, "env" | "secrets" | "withheldEnv">,
  ): Promise<{ problems: string[]; home: string | undefined }> => {
    const ambient = withoutWithheld(environment(), spawn.withheldEnv);
    const sessionEnv = spawn.env ?? {};
    const fromSecrets = new Set((spawn.secrets ?? []).flatMap((d) => d.env));
    // A secret reference the plan did not deliver would reach the process unset; count it as
    // secret-filled too, so it is refused rather than read as absent.
    for (const [k, v] of Object.entries(agent.env)) if (isSecretRef(v)) fromSecrets.add(k);
    const problems = copilotCliProfileProblems(agent, ambient, hostType, sessionEnv, fromSecrets);
    const home = fromSecrets.has("COPILOT_HOME") ? undefined : { ...literalEnv(agent.env), ...sessionEnv }.COPILOT_HOME;
    if (!problems.length && home) problems.push(...(await copilotHomeProblems(home)));
    return { problems, home };
  };
  return {
    id: "copilot-cli",
    matches: (agent) => isCopilotCliAgent(agent),
    async prepare(options: OpenSessionOptions): Promise<OpenSessionOptions> {
      const { agent, host } = options;
      // Exactly what the host will withhold from the process and fill from secrets (#336), so
      // the check sees what it gets.
      const plan = planSessionSecrets(host, agent, options.secrets);
      const prepared = await launchProblems(agent, host.spec?.type, {
        ...(options.env ? { env: options.env } : {}),
        secrets: plan.deliveries,
        withheldEnv: plan.withheldEnv,
      });
      if (prepared.problems.length) throw refusal(agent.id, prepared.problems);
      await checkExecutable(agent, digest, platform);
      // The check again on the start itself, with the arguments the host is given, so a change
      // between this check and the spawn (another override, another secret) is refused too.
      const spawning = Object.create(host) as AgentHost;
      Object.defineProperty(spawning, "spawnAgent", {
        value: async (...args: Parameters<AgentHost["spawnAgent"]>) => {
          const [started, spawn] = args;
          const check = await launchProblems(started, host.spec?.type, spawn);
          if (check.home !== prepared.home)
            check.problems.push("env: COPILOT_HOME changed between ORCA's check and the start");
          if (started.command !== agent.command)
            check.problems.push("command: the executable changed between ORCA's check and the start");
          if (check.problems.length) throw refusal(agent.id, check.problems);
          await checkExecutable(started, digest, platform);
          return host.spawnAgent(...args);
        },
      });
      const ask = options.askPermission;
      return {
        ...options,
        host: spawning,
        ...(ask
          ? { askPermission: async (request, invocation) => boundedOptionId(request, await ask(request, invocation)) }
          : {}),
      };
    },
    guard: guardCopilotSession,
  };
}
