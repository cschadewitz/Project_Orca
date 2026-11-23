/**
 * OpenCode over its own ACP server (`opencode acp`, #710).
 *
 * ORCA talks to OpenCode through the generic ACP session like any other agent. This module holds
 * only what is specific to OpenCode, and each check closes a route by which OpenCode would
 * otherwise run tools that ORCA's policy never sees, or run a build ORCA has not looked at.
 * The routes come from the source review in `docs/preparation/opencode-acp-710/` and the
 * installed-binary acceptance (`opencode-acceptance.yml`); `docs/agent-support.md` has the matrix.
 *
 * - **Exact build.** The configured executable is hashed before every session (cached by file
 *   identity) and must be the OpenCode 1.19.4 image published for this platform. Only the
 *   platforms the acceptance suite runs on are admitted. Another version, a wrapper script or a
 *   package runner is refused: OpenCode's permission behaviour is a property of one build.
 * - **Isolated profile.** OpenCode merges up to ten configuration layers, several of which
 *   (the user's `~/.opencode`, project `opencode.json`, plugins) can grant tools or run code
 *   without an ask. The launch must point `HOME`, `XDG_CONFIG_HOME` and `OPENCODE_CONFIG` at a
 *   profile of its own, turn off project config, plugins and auto-update, and pin the native
 *   permission set (`OPENCODE_PERMISSION`, the last layer) to the reviewed shape: nothing
 *   natively allowed, and subagents, web fetch and search and out-of-directory access denied.
 *   A machine-wide managed configuration, which ORCA cannot override, refuses the launch.
 * - **Subagents.** OpenCode reports a subagent launch as kind `think`, which ORCA's #140
 *   defaults would allow, and in 1.19.4 never forwards a subagent's own asks. The agent's ORCA
 *   policy must deny it too.
 * - **MCP.** OpenCode registers a client's MCP servers for every session in the process, so an
 *   agent that passes any is refused.
 * - **"Always" answers.** OpenCode's "Always allow" approves every edit, or every command with
 *   the same prefix, in the whole directory for the life of the process, and outranks a
 *   configured deny. ORCA answers with "Allow once" instead, so the next call is asked again
 *   and decided by ORCA's own policy, which keeps its own exact "always" rules.
 * - **Slash commands and modes.** A prompt whose text starts with `/` runs one of OpenCode's
 *   commands rather than a prompt; ORCA does not send one. Switching the session to another
 *   agent ("mode") changes the native permission set, so ORCA keeps the reviewed `build` agent.
 *
 * What stays outside, because OpenCode never asks or ORCA cannot see it: shell children (one ask
 * per parsed command, then unmediated), the duplicate native write behind an `fs/write_text_file`
 * mirror, the truncation directory OpenCode always appends as allowed, the unauthenticated
 * loopback HTTP server and the daemon environment every child inherits. See the matrix.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { OrcaError, effectivePermissionPolicy, literalEnv, type AgentSpec, type SessionConfigOption } from "@orca/core";
import type { OpenSessionOptions } from "../acp-session.js";
import { decidePermission } from "../permissions.js";
import type { AgentSession } from "../session.js";
import type { ProviderGuard } from "./guard.js";

/** The OpenCode release ORCA has reviewed and run its acceptance suite against. */
export const OPENCODE_VERIFIED_VERSION = "1.19.4";

/**
 * SHA-256 of `bin/opencode` in each platform package of OpenCode 1.19.4 (`opencode-<platform>`
 * on npm, tarball integrity in `docs/preparation/opencode-acp-710/source-pins.json`). Only the
 * platforms whose image the acceptance workflow runs are admitted; the others are recorded so
 * the matrix can say which build it means, and are refused.
 */
export const OPENCODE_IMAGES: Readonly<Record<string, { sha256: string; admitted: boolean }>> = {
  "linux-x64": { sha256: "538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7", admitted: true },
  "darwin-arm64": { sha256: "417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b", admitted: true },
  "linux-arm64": { sha256: "eba0da50d9cc22f2dd062c32e0e7e58d7ece301aa50aabdad1e9dba4ffbf25b4", admitted: false },
  "darwin-x64": { sha256: "6d6a980039553a6b4efe2221fdbd5e8945abf3c2365d97fcab097713a327228f", admitted: false },
};

/** Native permissions that must be `deny`: each one runs something ORCA cannot follow. */
export const OPENCODE_REQUIRED_DENIES = ["task", "webfetch", "websearch", "external_directory"] as const;

/** Launch flags ORCA knows the effect of. Anything else is refused. */
const VALUE_FLAGS = new Set(["--hostname", "--port", "--log-level"]);
const BARE_FLAGS = new Set(["--pure", "--print-logs"]);
/** Variables whose behaviour has not been reviewed and that can change what runs. */
const UNREVIEWED_VARIABLES = [
  "OPENCODE_EXPERIMENTAL",
  "OPENCODE_EXPERIMENTAL_WORKSPACES",
  "OPENCODE_EXPERIMENTAL_REFERENCES",
  "OPENCODE_PLUGIN_META_FILE",
  "OPENCODE_FAKE_VCS",
] as const;
/** Machine-wide configuration directories OpenCode reads after every layer ORCA controls. */
export const OPENCODE_MANAGED_DIRS: Readonly<Record<string, readonly string[]>> = {
  linux: ["/etc/opencode"],
  darwin: ["/Library/Application Support/opencode", "/Library/Managed Preferences/ai.opencode.managed.plist"],
};

const TRUE = new Set(["1", "true"]);
/** The reviewed native agent; another one brings its own permission set. */
const REVIEWED_MODE = "build";

/** OpenCode's executable is `opencode`, started with the `acp` subcommand first. */
export function isOpenCodeAgent(agent: Pick<AgentSpec, "command" | "args" | "type">): boolean {
  if (agent.type === "orca-daemon") return false;
  const name = win32
    .basename(agent.command)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (name === "opencode") return true;
  // A package runner that would fetch OpenCode at launch is OpenCode too, and is refused below.
  return (
    /^(npx|pnpx|bunx|npm|pnpm|bun)$/i.test(name) &&
    agent.args.some((a) => /^(opencode-ai|@opencode\/cli|opencode-[a-z]+-[a-z0-9]+)(@|$)/.test(a))
  );
}

function flagProblems(args: readonly string[]): string[] {
  const problems: string[] = [];
  if (args[0] !== "acp") problems.push("args: start with the acp subcommand (`opencode acp`)");
  const seen = new Map<string, string | true>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (BARE_FLAGS.has(name) && eq < 0) seen.set(name, true);
    else if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined) problems.push(`args: ${name} needs a value`);
      else seen.set(name, value);
    } else problems.push(`args: ${arg} is not supported`);
  }
  if (!seen.has("--pure")) problems.push("args: --pure is missing (it keeps external plugins out)");
  if (seen.get("--hostname") !== "127.0.0.1")
    problems.push("args: --hostname 127.0.0.1 is missing (OpenCode's internal server must stay on loopback)");
  if (seen.get("--port") !== "0") problems.push("args: --port 0 is missing (a random port for the internal server)");
  return problems;
}

/** One native rule as OpenCode 1.19.4 builds it from a `permission` block, in written order. */
export interface OpenCodeRule {
  permission: string;
  pattern: string;
  action: string;
}

/**
 * OpenCode's ruleset for one `permission` block: a string value is the rule for pattern `*`,
 * and a pattern map gives one rule per entry, both in written key order. Anything else is
 * reported, since OpenCode's schema would read it differently or refuse it.
 */
export function openCodeRules(block: unknown, where: string, problems: string[]): OpenCodeRule[] {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    problems.push(`OPENCODE_CONFIG: ${where} must be an object`);
    return [];
  }
  const rules: OpenCodeRule[] = [];
  for (const [permission, value] of Object.entries(block as Record<string, unknown>)) {
    if (typeof value === "string") rules.push({ permission, pattern: "*", action: value });
    else if (value && typeof value === "object" && !Array.isArray(value))
      for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
        if (typeof action === "string") rules.push({ permission, pattern, action });
        else problems.push(`OPENCODE_CONFIG: ${where}.${permission}.${pattern} must be "ask" or "deny"`);
      }
    else problems.push(`OPENCODE_CONFIG: ${where}.${permission} must be "ask", "deny" or a pattern map of them`);
  }
  for (const r of rules)
    if (r.action === "allow")
      problems.push(
        `OPENCODE_CONFIG: ${where}.${r.permission} allows something natively; use ask or deny and let ORCA decide`,
      );
    else if (r.action !== "ask" && r.action !== "deny")
      problems.push(`OPENCODE_CONFIG: ${where}.${r.permission} has the unreviewed action '${r.action}'`);
  return rules;
}

/** OpenCode's wildcard match: `*` is any run, `?` one character, the rest literal. */
function wildcard(text: string, glob: string): boolean {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "s").test(text);
}

/**
 * Which mandatory denials the effective ruleset does not keep. OpenCode decides an ask by the
 * last rule whose permission and pattern both match (`findLast`), over the built-in defaults,
 * then the top-level `permission`, then the agent's own. So a denial holds for every pattern
 * only if the last matching rule for pattern `*` is `deny` and no later matching rule, for any
 * pattern, says anything else. A later `"t*": "ask"` or an agent-level `"*": "ask"` breaks it.
 * The defaults come first and are outranked by the leading `"*"`, which is checked separately.
 */
export function openCodeDenialGaps(rules: readonly OpenCodeRule[]): string[] {
  const gaps: string[] = [];
  for (const required of OPENCODE_REQUIRED_DENIES) {
    const matching = rules.filter((r) => wildcard(required, r.permission));
    const last = matching.map((r) => r.pattern === "*").lastIndexOf(true);
    if (last < 0 || matching[last]!.action !== "deny" || matching.slice(last + 1).some((r) => r.action !== "deny"))
      gaps.push(required);
  }
  return gaps;
}

/** Top-level keys whose effect on OpenCode 1.19.4 has been reviewed. Anything else is refused. */
const REVIEWED_CONFIG_KEYS = new Set([
  "$schema",
  "autoupdate",
  "share",
  "enabled_providers",
  "disabled_providers",
  "provider",
  "model",
  "small_model",
  "plugin",
  "mcp",
  "lsp",
  "formatter",
  "instructions",
  "default_agent",
  "agent",
  "permission",
  "command",
]);
/** What an `agent.<name>` entry may set: on or off, and its own (checked) permission block. */
const REVIEWED_AGENT_KEYS = new Set(["disable", "permission"]);

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What is wrong with OpenCode's own configuration: the reviewed file `OPENCODE_CONFIG` names
 * and the `OPENCODE_PERMISSION` layer, which must say the same thing. The file must use only
 * reviewed keys, and the `build` agent's effective ordered ruleset (top-level `permission`,
 * then `agent.build.permission`) must keep every mandatory denial, not just spell it.
 */
export function openCodeConfigProblems(config: unknown, permissionEnv: string | undefined): string[] {
  const problems: string[] = [];
  if (!config || typeof config !== "object" || Array.isArray(config))
    return ["OPENCODE_CONFIG: the file is not a JSON object"];
  const c = config as Record<string, unknown>;
  for (const key of Object.keys(c))
    if (!REVIEWED_CONFIG_KEYS.has(key)) problems.push(`OPENCODE_CONFIG: ${key} is not a reviewed setting`);
  const permission = c.permission;
  const rules: OpenCodeRule[] = [];
  if (!permission || typeof permission !== "object" || Array.isArray(permission))
    problems.push("OPENCODE_CONFIG: set a `permission` object");
  else {
    const p = permission as Record<string, unknown>;
    if (Object.keys(p)[0] !== "*" || (p["*"] !== "ask" && p["*"] !== "deny"))
      problems.push('OPENCODE_CONFIG: permission must start with "*": "ask" (OpenCode applies the last matching key)');
    rules.push(...openCodeRules(p, "permission", problems));
  }
  const agents = c.agent;
  if (agents !== undefined && (!agents || typeof agents !== "object" || Array.isArray(agents)))
    problems.push("OPENCODE_CONFIG: agent must be an object");
  else if (agents)
    for (const [name, a] of Object.entries(agents as Record<string, unknown>)) {
      if (!a || typeof a !== "object" || Array.isArray(a)) {
        problems.push(`OPENCODE_CONFIG: agent.${name} must be an object`);
        continue;
      }
      const entry = a as Record<string, unknown>;
      for (const key of Object.keys(entry))
        if (!REVIEWED_AGENT_KEYS.has(key))
          problems.push(`OPENCODE_CONFIG: agent.${name}.${key} is not a reviewed setting`);
      if (entry.permission === undefined) continue;
      const own = openCodeRules(entry.permission, `agent.${name}.permission`, problems);
      if (name === REVIEWED_MODE) rules.push(...own);
    }
  for (const gap of openCodeDenialGaps(rules))
    problems.push(
      `OPENCODE_CONFIG: permission.${gap} must be "deny", and no later rule (a wildcard key, a pattern or agent.build.permission) may reopen it`,
    );
  let fromEnv: unknown;
  try {
    fromEnv = permissionEnv === undefined ? undefined : JSON.parse(permissionEnv);
  } catch {
    problems.push("env: OPENCODE_PERMISSION is not JSON");
  }
  if (permissionEnv === undefined) problems.push("env: set OPENCODE_PERMISSION to the config file's `permission`");
  else if (fromEnv !== undefined && !sameJson(fromEnv, permission))
    problems.push("env: OPENCODE_PERMISSION differs from the config file's `permission`");
  if (c.plugin !== undefined && !sameJson(c.plugin, [])) problems.push("OPENCODE_CONFIG: plugin must be []");
  if (c.mcp !== undefined && !sameJson(c.mcp, {})) problems.push("OPENCODE_CONFIG: mcp must be {}");
  if (c.formatter !== false) problems.push("OPENCODE_CONFIG: formatter must be false (formatters run without an ask)");
  if (c.lsp !== false) problems.push("OPENCODE_CONFIG: lsp must be false (language servers are downloaded and run)");
  if (c.share !== "disabled") problems.push('OPENCODE_CONFIG: share must be "disabled"');
  if (c.autoupdate !== false) problems.push("OPENCODE_CONFIG: autoupdate must be false");
  if (c.default_agent !== undefined && c.default_agent !== REVIEWED_MODE)
    problems.push('OPENCODE_CONFIG: default_agent must be "build"');
  if (c.command !== undefined && !sameJson(c.command, {}))
    problems.push("OPENCODE_CONFIG: command must be {} (custom commands can run shell text without an ask)");
  return problems;
}

/**
 * What is wrong with this launch profile, as the host would start it: the agent's `env` over
 * `ambient`, the daemon's own environment less what ORCA withholds for secrets. It says nothing
 * about the executable or the config file's contents, which are read separately.
 */
export function openCodeProfileProblems(
  agent: AgentSpec,
  ambient: Readonly<Record<string, string | undefined>>,
  hostType: "local" | "ssh" | undefined,
  platform: string = process.platform,
  arch: string = process.arch,
): string[] {
  const problems: string[] = [];
  const name = win32
    .basename(agent.command)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (name !== "opencode")
    problems.push(
      "command: start the verified opencode executable itself (an absolute path), not a package runner or wrapper",
    );
  else if (!isAbsolute(agent.command))
    problems.push("command: give the opencode executable as an absolute path, so PATH order cannot swap it");
  if (hostType !== "local")
    problems.push("host: OpenCode is supported on this computer only; its files on another host cannot be checked");
  const image = OPENCODE_IMAGES[`${platform}-${arch}`];
  if (!image?.admitted)
    problems.push(
      `platform: OpenCode is supported on ${Object.entries(OPENCODE_IMAGES)
        .filter(([, i]) => i.admitted)
        .map(([p]) => p)
        .join(" and ")} only, not ${platform}-${arch}`,
    );
  problems.push(...flagProblems(agent.args));
  if (agent.mcpServers.length > 0)
    problems.push("mcpServers: OpenCode shares a client's MCP servers with every session in the process; pass none");

  const literal = literalEnv(agent.env);
  const effective: Record<string, string | undefined> = { ...ambient, ...literal };
  for (const variable of ["OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_PURE", "OPENCODE_DISABLE_AUTOUPDATE"])
    if (!TRUE.has((effective[variable] ?? "").trim().toLowerCase())) problems.push(`env: set ${variable} to "1"`);
  for (const variable of ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"])
    if ((effective[variable] ?? "") !== "")
      problems.push(`env: ${variable} must be empty (it adds a configuration layer ORCA has not reviewed)`);
  for (const variable of UNREVIEWED_VARIABLES)
    if ((effective[variable] ?? "") !== "") problems.push(`env: ${variable} is not supported`);
  for (const variable of ["HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG"]) {
    const value = literal[variable];
    if (!value || !isAbsolute(value))
      problems.push(
        `env: set ${variable} in the agent's env to an absolute path of the OpenCode profile's own, so the person's own OpenCode settings are not read`,
      );
  }
  if (literal.OPENCODE_PERMISSION === undefined)
    problems.push("env: set OPENCODE_PERMISSION in the agent's env (the last configuration layer OpenCode applies)");
  return problems;
}

/** The ORCA policy must deny OpenCode's subagent launch, which the #140 defaults would allow. */
export function openCodePolicyProblems(agent: AgentSpec): string[] {
  const policy = effectivePermissionPolicy(agent.permissions);
  const ask: acp.RequestPermissionRequest = {
    sessionId: "preflight",
    toolCall: { toolCallId: "preflight", title: "task", kind: "think" },
    options: [],
  };
  return decidePermission(policy, ask) === "deny"
    ? []
    : [
        'permissions: deny OpenCode\'s subagent launch, for example `{ match: { kind: think, titlePattern: "^task$" }, decision: deny }`',
      ];
}

export type ImageDigest = (path: string) => Promise<string>;

export const openCodeImageDigest: ImageDigest = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });

/** Digests already taken, by real path and file identity (device, inode, size, times). */
const digestCache = new Map<string, string>();

async function checkImage(agent: AgentSpec, digest: ImageDigest, platform: string, arch: string): Promise<void> {
  const expected = OPENCODE_IMAGES[`${platform}-${arch}`]!.sha256;
  let path: string;
  let key: string;
  try {
    path = await realpath(agent.command);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    if (process.platform !== "win32" && (info.mode & 0o022) !== 0)
      throw new OrcaError(
        "CONFIG_INVALID",
        `OpenCode agent '${agent.id}': the executable is writable by other users; make it read-only to them.`,
        { agentId: agent.id },
      );
    key = `${path}\0${info.dev}\0${info.ino}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}`;
  } catch (error) {
    if (error instanceof OrcaError) throw error;
    throw new OrcaError("AGENT_TRANSPORT", `OpenCode agent '${agent.id}': the executable cannot be read.`, {
      agentId: agent.id,
    });
  }
  let actual = digestCache.get(key);
  if (!actual) {
    actual = await digest(path);
    digestCache.set(key, actual);
  }
  if (actual !== expected)
    throw new OrcaError(
      "NOT_SUPPORTED",
      `Agent '${agent.id}' is not the OpenCode ${OPENCODE_VERIFIED_VERSION} build ORCA verified for ${platform}-${arch}. Install that exact build (docs/agent-support.md) and keep auto-update off.`,
      { agentId: agent.id, verified: OPENCODE_VERIFIED_VERSION },
    );
}

async function checkConfigFile(agent: AgentSpec, permissionEnv: string | undefined): Promise<string[]> {
  const path = literalEnv(agent.env).OPENCODE_CONFIG;
  if (!path || !isAbsolute(path)) return [];
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return ["OPENCODE_CONFIG: the file cannot be read"];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ["OPENCODE_CONFIG: the file is not plain JSON (comments are not supported here)"];
  }
  return openCodeConfigProblems(parsed, permissionEnv);
}

/**
 * What OpenCode may find, and has written for itself, in a profile's own configuration
 * directory. Everything else is refused: a directory there can hold agents and modes with
 * their own permissions, commands that run shell text, tools and plugins, all loaded with no
 * ask, and `--pure` keeps out only plugins.
 */
const PROFILE_CONFIG_FILES = new Set(["config.json", "opencode.json", "opencode.jsonc"]);
const PROFILE_DEPENDENCY_ENTRIES = new Set([
  "package.json",
  "package-lock.json",
  "bun.lock",
  ".gitignore",
  "node_modules",
]);

/**
 * Deny by default over OpenCode's per-profile configuration directories (#710): the global one
 * (`$XDG_CONFIG_HOME/opencode`) and `~/.opencode`, which OpenCode always reads. Only the
 * schema-only file OpenCode seeds and the plugin-dependency install it runs in every config
 * directory may be there.
 */
export async function openCodeProfileDirProblems(env: Readonly<Record<string, string>>): Promise<string[]> {
  const problems: string[] = [];
  const dirs = [
    ...(env.XDG_CONFIG_HOME ? [join(env.XDG_CONFIG_HOME, "opencode")] : []),
    ...(env.HOME ? [join(env.HOME, ".opencode")] : []),
  ];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      problems.push(`profile: ${dir} cannot be read`);
      continue;
    }
    for (const entry of entries) {
      if (PROFILE_DEPENDENCY_ENTRIES.has(entry)) continue;
      if (!PROFILE_CONFIG_FILES.has(entry)) {
        problems.push(
          `profile: ${join(dir, entry)} is not allowed (agents, commands, modes, tools and plugins there run without an ask)`,
        );
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(dir, entry), "utf8"));
      } catch {
        problems.push(`profile: ${join(dir, entry)} is not plain JSON`);
        continue;
      }
      const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : ["?"];
      if (keys.some((k) => k !== "$schema"))
        problems.push(
          `profile: ${join(dir, entry)} sets ${keys.join(", ")}; keep OpenCode's settings in the OPENCODE_CONFIG file only`,
        );
    }
  }
  return problems;
}

async function managedConfigPresent(platform: string): Promise<string[]> {
  const found: string[] = [];
  for (const path of OPENCODE_MANAGED_DIRS[platform] ?? [])
    try {
      await access(path);
      found.push(path);
    } catch {
      /* absent, as required */
    }
  return found;
}

/** The joined text of a prompt, as OpenCode reads it to look for a command. */
export function openCodeSlashCommand(input: string | readonly acp.ContentBlock[]): boolean {
  const blocks: readonly acp.ContentBlock[] = typeof input === "string" ? [{ type: "text", text: input }] : input;
  const text = blocks
    .filter((b): b is Extract<acp.ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text.startsWith("/");
}

/**
 * Only one-time answers reach OpenCode. "Always allow" becomes "Allow once" and "Always
 * reject" becomes "Reject once"; when the one-time option is not offered, or the answer is
 * not one of the request's options, nothing is chosen and the ask is cancelled rather than
 * answered with a persistent response.
 */
export function openCodeBoundedAnswer(
  request: acp.RequestPermissionRequest,
  chosen: string | undefined,
): string | undefined {
  if (chosen === undefined) return undefined;
  const option = request.options.find((o) => o.optionId === chosen);
  if (!option) return undefined;
  if (option.kind === "allow_always") return request.options.find((o) => o.kind === "allow_once")?.optionId;
  if (option.kind === "reject_always") return request.options.find((o) => o.kind === "reject_once")?.optionId;
  return option.kind === "allow_once" || option.kind === "reject_once" ? chosen : undefined;
}

function modeOf(options: readonly SessionConfigOption[]): unknown {
  return (options.find((o) => o.id === "mode") as { currentValue?: unknown } | undefined)?.currentValue;
}

/** Enforce the session half: slash commands and the native agent ("mode"). */
export function guardOpenCodeSession(session: AgentSession): AgentSession {
  const offMode = () => {
    const mode = modeOf(session.configOptions);
    if (mode === undefined || mode === REVIEWED_MODE) return undefined;
    return typeof mode === "string" ? mode : JSON.stringify(mode);
  };
  const opened = offMode();
  if (opened !== undefined) {
    void session.close();
    throw new OrcaError(
      "NOT_SUPPORTED",
      `OpenCode session opened in mode '${opened}'; ORCA runs only the reviewed '${REVIEWED_MODE}' agent. Set default_agent to "build".`,
      { agentId: session.agentId, mode: opened },
    );
  }
  const guarded: AgentSession = Object.create(session) as AgentSession;
  // Writable, as a plain session's are: the hook path in the session factory wraps `close`.
  Object.defineProperties(guarded, {
    prompt: {
      writable: true,
      value: async (input: Parameters<AgentSession["prompt"]>[0], options?: Parameters<AgentSession["prompt"]>[1]) => {
        if (openCodeSlashCommand(input))
          throw new OrcaError(
            "NOT_SUPPORTED",
            "OpenCode runs a prompt that starts with '/' as one of its own commands; ORCA does not send one. Reword the prompt so it does not start with '/'.",
            { agentId: session.agentId },
          );
        const mode = offMode();
        if (mode !== undefined)
          throw new OrcaError("NOT_SUPPORTED", `OpenCode session is in mode '${mode}', not '${REVIEWED_MODE}'.`, {
            agentId: session.agentId,
            mode,
          });
        return session.prompt(input, options);
      },
    },
    setConfigOption: {
      writable: true,
      value: async (configId: string, value: string | boolean) => {
        if (configId === "mode" && value !== REVIEWED_MODE)
          throw new OrcaError(
            "NOT_SUPPORTED",
            `ORCA does not switch OpenCode to mode '${String(value)}': another agent brings its own native permissions.`,
            { agentId: session.agentId, configId },
          );
        return session.setConfigOption(configId, value);
      },
    },
  });
  return guarded;
}

export interface OpenCodeGuardOptions {
  digest?: ImageDigest;
  platform?: string;
  arch?: string;
  /** Machine-wide configuration found; the real check by default. */
  managedConfig?: (platform: string) => Promise<string[]>;
}

export function openCodeGuard(opts: OpenCodeGuardOptions = {}): ProviderGuard {
  const digest = opts.digest ?? openCodeImageDigest;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const managed = opts.managedConfig ?? managedConfigPresent;
  return {
    id: "opencode",
    matches: (agent) => isOpenCodeAgent(agent),
    async prepare(options: OpenSessionOptions): Promise<OpenSessionOptions> {
      const { agent, host } = options;
      const withheld = new Set(
        Object.values(options.secrets ?? {})
          .filter((d) => d.host === host.id && d.provider === "env")
          .map((d) => (d.provider === "env" ? d.name : "")),
      );
      const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => !withheld.has(k)));
      // The host lays the session's own env over the agent's, so both are checked as one.
      const launched: AgentSpec = { ...agent, env: { ...agent.env, ...(options.env ?? {}) } };
      const problems = [
        ...openCodeProfileProblems(launched, ambient, host.spec?.type, platform, arch),
        ...openCodePolicyProblems(agent),
      ];
      if (!problems.length)
        problems.push(...(await checkConfigFile(launched, literalEnv(launched.env).OPENCODE_PERMISSION)));
      if (!problems.length) problems.push(...(await openCodeProfileDirProblems(literalEnv(launched.env))));
      if (!problems.length)
        for (const path of await managed(platform))
          problems.push(`machine: ${path} holds a managed OpenCode configuration that ORCA cannot override`);
      if (problems.length)
        throw new OrcaError("CONFIG_INVALID", `OpenCode agent '${agent.id}' cannot start: ${problems.join("; ")}.`, {
          agentId: agent.id,
          problems,
        });
      await checkImage(agent, digest, platform, arch);
      const ask = options.askPermission;
      return ask
        ? {
            ...options,
            askPermission: async (request, invocation) =>
              openCodeBoundedAnswer(request, await ask(request, invocation)),
          }
        : options;
    },
    guard: guardOpenCodeSession,
  };
}
