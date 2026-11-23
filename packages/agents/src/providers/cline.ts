/**
 * Cline CLI over its own ACP server (`cline --acp`, #711).
 *
 * ORCA talks to Cline through the generic ACP session like any other agent. This module holds
 * only what is specific to Cline. Cline runs every tool itself, in its own process, after it
 * asks the client with `session/request_permission`; it never uses ACP's `fs/*` or `terminal/*`
 * methods. So the ask is the only place ORCA can stop a Cline tool, and each part below closes
 * a way that ask would be skipped, widened or decided on less than ORCA needs. Evidence for
 * each is in docs/agent-support.md: source read at the pinned version, and the unattended
 * acceptance run against the real binary (`cline-acp-acceptance.yml`).
 *
 * - **Launch profile.** Only `--acp` and `--config <absolute dir>` (plus the reasoning flags)
 *   are accepted: `--yolo` and `--auto-approve true` approve every tool without asking, and
 *   the other options change what runs. Cline's state must live in a directory ORCA was told
 *   about, so another profile's credentials, hooks, plugins and MCP servers do not come along.
 *   `CLINE_SESSION_BACKEND_MODE=local` is required: by default Cline runs sessions in a
 *   detached background "hub" process, which keeps running tools after ORCA has stopped the
 *   agent it started. `CLINE_NO_AUTO_UPDATE=1` is required so the version ORCA checked is the
 *   version that runs. Every other `CLINE_*` variable is refused, from the config or from the
 *   daemon's environment, because they move Cline's state, settings or MCP servers elsewhere.
 *   An API key is accepted only as a secret reference.
 * - **Code that runs without asking.** Cline loads hook scripts and plugin modules from the
 *   workspace (`.cline/hooks`, `.clinerules/hooks`, `.cline/plugins`), its config directory
 *   and the person's home (`Documents/Cline/Hooks`, `Documents/Cline/Plugins`,
 *   `.agents/plugins`), and its own MCP servers from its settings file. They run with no ask,
 *   and a plugin can approve tools for Cline. A launch where any of them is present is
 *   refused, and the session's protected paths gain those directories, so a Cline edit cannot
 *   plant one for the next session without the policy refusing it.
 * - **MCP servers from ORCA.** Cline accepts `mcpServers` in `session/new` and never uses
 *   them. A session that would hand it any is refused rather than reported as delivered.
 * - **Version.** The executable's SHA-256 must be a verified build for this platform
 *   (`CLINE_CLI_VERIFIED_IMAGES`), checked before every start, and the `initialize` reply must
 *   name Cline at a version in `CLINE_CLI_VERIFIED_VERSIONS`.
 * - **What an ask says.** Cline's permission request carries no `locations` and its command
 *   in `rawInput.commands`, so ORCA's path rules, protected paths and command rules could not
 *   see what a call touches. Each request is rewritten, before ORCA's policy reads it, with the
 *   paths and command Cline's own tool will use (`normalizeClinePermissionRequest`). A call
 *   whose target cannot be read, and `spawn_agent` (which Cline reports as `think`), are
 *   reported as kind `other`, which no default rule allows.
 * - **Auto-approve.** Cline advertises an `auto_approve` session option that approves every
 *   tool without asking. ORCA refuses to set it, refuses a session that opens with it on, and
 *   ends a session that reports it turned on.
 * - **"Always" answers.** Cline treats "Allow always" as "Allow once" in this version; ORCA
 *   still answers "Allow once", so a later Cline that remembers grants cannot widen one.
 *
 * What stays outside: a shell command Cline was allowed to run can do anything the account
 * can, and its effects are not ORCA's to see. See the matrix.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath, win32 } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { OrcaError, isSecretRef, literalEnv, quoteWord, type AgentSpec, type SessionConfigOption } from "@orca/core";
import type { OpenSessionOptions } from "../acp-session.js";
import type { AgentHost } from "../host.js";
import type { ProtectedPaths } from "../permissions.js";
import type { AgentSession } from "../session.js";
import type { ProviderGuard } from "./guard.js";

/**
 * The Cline CLI versions ORCA has run its acceptance suite against. Another version is refused
 * at `initialize`: the routes above are behaviour of one version, and a later one can add
 * another. Moving the pin is a reviewed change here and in `cline-acp-acceptance.yml` together.
 */
export const CLINE_CLI_VERIFIED_VERSIONS: readonly string[] = ["3.0.75"];

/**
 * SHA-256 of each verified version's executable, per platform (`<os>-<arch>`, as npm's
 * `@cline/cli-<os>-<arch>` packages name them). ORCA hashes the configured executable before
 * every start and opens only one of these, so a binary swapped in place under a verified
 * version's path is refused. Linux x64 runs in CI; the others are the published artifacts.
 */
export const CLINE_CLI_VERIFIED_IMAGES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "3.0.75": {
    "linux-x64": "f63e3073dcd3b5d045cca6a78a65250b9baecf7d599a1206276255a5fc4f58fe",
    "linux-arm64": "7ac941243bc464ce6f0ff5ad220124f512bca0115ae83c983eb411c9d20243f6",
    "darwin-arm64": "4180d55d6062ee3c1713979350f1b6503db5762f7d302584ecc1be41d92ca67c",
    "darwin-x64": "d73b23bd0fbd5edea8c8464e837a4fe6c242eb1b5b5855d4db9136f4f58b968a",
    "windows-x64": "ddaf924aed244a67f9d286ed8ef2e7603f0160780bdbbe0c6d0737cdd93205c7",
    "windows-arm64": "1ba98adabb1b6ca4f87466a4b1101241ec39765f4080078bb1e229ac46b06bf1",
  },
};

/** This computer, as the pins above name platforms. */
export function clinePlatform(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

export type ImageDigest = (path: string) => Promise<string>;

/** SHA-256 of a file, read whole. */
export const sha256File: ImageDigest = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/** SHA-256 digests already taken, by path, size and modification time. */
const digestCache = new Map<string, string>();

/** What is wrong with the executable itself: empty when it is a verified Cline for this platform. */
export async function clineImageProblems(
  command: string,
  platform: string = clinePlatform(),
  digest: ImageDigest = sha256File,
): Promise<string[]> {
  const verified = Object.entries(CLINE_CLI_VERIFIED_IMAGES).filter(([, images]) => images[platform] !== undefined);
  if (verified.length === 0) return [`platform: ORCA has verified no Cline CLI build for ${platform}`];
  let sha: string;
  try {
    const info = statSync(command);
    const key = `${command}\0${info.size}\0${info.mtimeMs}`;
    const cached = digest === sha256File ? digestCache.get(key) : undefined;
    sha = cached ?? (await digest(command));
    if (digest === sha256File) digestCache.set(key, sha);
  } catch (error) {
    return [`command: ${command} cannot be read (${error instanceof Error ? error.message : String(error)})`];
  }
  if (verified.some(([, images]) => images[platform] === sha)) return [];
  return [
    `command: ${command} is not a Cline CLI build ORCA has verified (SHA-256 ${sha}); install ${verified.map(([v]) => v).join(", ")} from @cline/cli-${platform}`,
  ];
}

/** The `agentInfo.name` Cline's ACP server reports. */
export const CLINE_AGENT_NAME = "cline";

/** Launch options ORCA accepts. Anything else is refused. Values are the number of arguments each takes. */
const ACCEPTED_FLAGS: Readonly<Record<string, number>> = {
  "--acp": 0,
  "--config": 1,
  "--thinking": 0,
  "--reasoning-effort": 1,
};
/** Named in the refusal, because each one approves tools without asking ORCA. */
const GRANTING_FLAGS = new Set(["--yolo", "-y", "--auto-approve"]);

/** `CLINE_*` variables ORCA accepts, and what each must hold. Every other `CLINE_*` is refused. */
const REQUIRED_VARIABLES: Readonly<Record<string, string>> = {
  CLINE_SESSION_BACKEND_MODE: "local",
  CLINE_NO_AUTO_UPDATE: "1",
};
/** Variables that only choose a provider or model. */
const CHOICE_VARIABLES = new Set(["CLINE_PROVIDER", "CLINE_MODEL"]);
/** The credential variable. Accepted only as a secret reference. */
export const CLINE_KEY_VARIABLE = "CLINE_API_KEY";

const flagName = (arg: string) => arg.split("=", 1)[0]!;
const baseName = (command: string) =>
  win32
    .basename(command)
    .replace(/\.(exe|cmd)$/i, "")
    .toLowerCase();
const absolute = (p: string) => isAbsolute(p) || win32.isAbsolute(p);

/** Cline's executable name: `cline` (Linux, macOS) or `cline.exe`/`cline.cmd` (Windows). */
export function isClineAgent(agent: Pick<AgentSpec, "command" | "args" | "type">): boolean {
  if (agent.type === "orca-daemon") return false;
  const name = baseName(agent.command);
  if (name === "cline") return true;
  // A package runner that would fetch Cline at launch is Cline too, and is refused below.
  return /^(npx|pnpx|bunx|npm|pnpm)$/i.test(name) && agent.args.some((a) => a === "cline" || a.startsWith("cline@"));
}

/** The value of `--config` as the agent is launched, or undefined. */
export function clineConfigDir(agent: Pick<AgentSpec, "args">): string | undefined {
  for (let i = 0; i < agent.args.length; i++) {
    const arg = agent.args[i]!;
    if (arg === "--config") return agent.args[i + 1];
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
  }
  return undefined;
}

/**
 * What is wrong with this launch profile, as the host would start it: the agent's `env` over
 * `ambient`, the daemon's own environment, less what ORCA withholds for secrets. Empty when
 * none of the known hazards is present. It says nothing about files on disk (see
 * `clineFileProblems`) or the version, which Cline reports at `initialize`.
 */
export function clineProfileProblems(
  agent: AgentSpec,
  ambient: Readonly<Record<string, string | undefined>>,
  hostType: "local" | "ssh" | undefined,
): string[] {
  const problems: string[] = [];
  if (baseName(agent.command) !== "cline")
    problems.push(
      "command: start the cline executable itself (an absolute path), not a package runner that fetches a version at launch",
    );
  else if (!absolute(agent.command))
    problems.push("command: give the cline executable as an absolute path, so PATH order cannot swap it");
  if (hostType !== "local")
    problems.push("host: Cline is supported on this computer only; its files on another host cannot be checked");

  let sawAcp = false;
  for (let i = 0; i < agent.args.length; i++) {
    const arg = agent.args[i]!;
    const name = flagName(arg);
    if (GRANTING_FLAGS.has(name)) {
      problems.push(`args: ${name} approves tools without asking ORCA`);
      continue;
    }
    const takes = ACCEPTED_FLAGS[name];
    if (takes === undefined) {
      problems.push(`args: ${arg} is not supported`);
      continue;
    }
    if (name === "--acp") sawAcp = true;
    if (takes > 0 && !arg.includes("=")) i += takes;
  }
  if (!sawAcp) problems.push("args: --acp is missing");
  const config = clineConfigDir(agent);
  if (!config || !absolute(config))
    problems.push(
      "args: add --config with an absolute directory of Cline's own, so another Cline profile's sign-in, hooks, plugins and MCP servers do not apply",
    );

  if (agent.mcpServers.length > 0)
    problems.push(
      "mcpServers: Cline ignores MCP servers handed to it over ACP, so ORCA does not hand it any; remove them from this agent",
    );

  const literal = literalEnv(agent.env);
  const effective: Record<string, string | undefined> = { ...ambient, ...literal };
  for (const [variable, wanted] of Object.entries(REQUIRED_VARIABLES))
    if ((effective[variable] ?? "").trim() !== wanted) problems.push(`env: set ${variable} to "${wanted}"`);
  const names = new Set([...Object.keys(agent.env), ...Object.keys(ambient).filter((k) => (ambient[k] ?? "") !== "")]);
  for (const variable of [...names].sort()) {
    if (!/^CLINE_/i.test(variable) || variable in REQUIRED_VARIABLES || CHOICE_VARIABLES.has(variable)) continue;
    const configured = agent.env[variable];
    if (variable === CLINE_KEY_VARIABLE) {
      if (configured !== undefined && !isSecretRef(configured))
        problems.push(`env: ${variable} is written into ORCA's config; refer to it as a secret instead`);
      else if (configured === undefined)
        problems.push(
          `env: ${variable} is inherited from the daemon's environment and would replace the Cline sign-in; define it as a secret (which withholds it) or start ORCA without it`,
        );
      continue;
    }
    problems.push(
      `env: ${variable} is not supported${configured === undefined ? " (inherited from the daemon's environment)" : ""}; it moves Cline's state, settings or servers outside what ORCA checked`,
    );
  }
  return problems;
}

/** Directories and files Cline loads code or servers from, for this launch. */
export function clineLoadPaths(configDir: string, cwd: string, home: string) {
  const workspaces = workspaceChain(cwd);
  return {
    hookDirs: [
      join(home, "Documents", "Cline", "Hooks"),
      join(configDir, "hooks"),
      ...workspaces.flatMap((w) => [join(w, ".clinerules", "hooks"), join(w, ".cline", "hooks")]),
    ],
    pluginDirs: [
      join(home, "Documents", "Cline", "Plugins"),
      join(home, ".agents", "plugins"),
      join(configDir, "plugins"),
      ...workspaces.map((w) => join(w, ".cline", "plugins")),
    ],
    mcpSettings: join(configDir, "data", "settings", "cline_mcp_settings.json"),
    /** Directories a Cline edit must not write into, so it cannot plant code for a later session. */
    readOnly: [
      join(home, "Documents", "Cline"),
      join(home, ".agents"),
      ...workspaces.flatMap((w) => [join(w, ".cline"), join(w, ".clinerules")]),
    ],
    /** Cline keeps provider keys and OAuth tokens here in plain files. */
    noAccess: [configDir],
  };
}

/** `cwd` and each parent up to the nearest one holding `.git` (Cline's workspace root), inclusive. */
function workspaceChain(cwd: string): string[] {
  const chain: string[] = [];
  for (let dir = resolvePath(cwd); ; dir = dirname(dir)) {
    chain.push(dir);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  // Without a `.git` above, Cline's workspace is `cwd` itself.
  return existsSync(join(chain.at(-1)!, ".git")) ? chain : [chain[0]!];
}

function nonEmptyDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/** Hooks, plugins and Cline-configured MCP servers present for this launch. */
export function clineFileProblems(configDir: string, cwd: string, home: string): string[] {
  const paths = clineLoadPaths(configDir, cwd, home);
  const problems: string[] = [...clineConfigDirProblems(configDir)];
  for (const dir of paths.hookDirs)
    if (nonEmptyDir(dir)) problems.push(`files: ${dir} holds Cline hooks, which run without asking ORCA`);
  for (const dir of paths.pluginDirs)
    if (nonEmptyDir(dir)) problems.push(`files: ${dir} holds Cline plugins, which run without asking ORCA`);
  if (existsSync(paths.mcpSettings)) {
    let servers = 1;
    try {
      const parsed = JSON.parse(readFileSync(paths.mcpSettings, "utf8")) as { mcpServers?: unknown };
      servers = parsed.mcpServers && typeof parsed.mcpServers === "object" ? Object.keys(parsed.mcpServers).length : 0;
    } catch {
      /* Unreadable is treated as configured. */
    }
    if (servers > 0)
      problems.push(
        `files: ${paths.mcpSettings} configures MCP servers for Cline, which ORCA does not see; remove them`,
      );
  }
  return problems;
}

/** What Cline's config directory may hold: its state under `data`, and nothing else. */
const CONFIG_DIR_ENTRIES = new Set(["data"]);
/** The settings files ORCA reads before a start. Any other file there is refused. */
const SETTINGS_FILES = new Set(["providers.json", "global-settings.json", "cline_mcp_settings.json"]);

/**
 * Cline's config directory, deny by default. Cline reads rules, skills, workflows, agent
 * definitions, hooks, plugins, cron and task specs from beside `data`; ORCA accepts only `data`
 * there, only the settings files it knows inside `data/settings`, and refuses a global
 * `toolAutoApprove`.
 */
export function clineConfigDirProblems(configDir: string): string[] {
  const problems: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(configDir);
  } catch {
    return [
      `files: Cline's config directory ${configDir} cannot be read; create it and sign in with cline auth --config`,
    ];
  }
  for (const entry of entries.sort())
    if (!CONFIG_DIR_ENTRIES.has(entry))
      problems.push(`files: ${join(configDir, entry)} is not something ORCA lets Cline load; remove it`);
  const settings = join(configDir, "data", "settings");
  let files: string[] = [];
  try {
    files = readdirSync(settings);
  } catch {
    /* No settings yet. */
  }
  for (const file of files.sort())
    if (!SETTINGS_FILES.has(file))
      problems.push(`files: ${join(settings, file)} is a Cline setting ORCA does not check; remove it`);
  if (files.includes("global-settings.json")) {
    let autoApprove = true;
    try {
      const parsed = JSON.parse(readFileSync(join(settings, "global-settings.json"), "utf8")) as Json;
      autoApprove = parsed.toolAutoApprove === true;
    } catch {
      /* Unreadable is treated as on. */
    }
    if (autoApprove)
      problems.push(`files: ${join(settings, "global-settings.json")} turns toolAutoApprove on; turn it off`);
  }
  return problems;
}

/* -------------------------------------------------------------------------- *
 * What an ask says
 * -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The tool name Cline put in front of the title (`buildToolTitle`: `name` or `name: summary`). */
export function clineToolName(title: string | null | undefined): string {
  const t = title ?? "";
  const i = t.indexOf(": ");
  return (i < 0 ? t : t.slice(0, i)).trim();
}

/** Every path a `read_files` input names, in any of the shapes Cline's tool accepts. */
function readFilesPaths(input: unknown): string[] | undefined {
  const entry = (e: unknown): string | undefined => {
    if (str(e)) return e;
    if (isObject(e)) for (const k of ["path", "file_path", "filePath"]) if (str(e[k])) return e[k];
    return undefined;
  };
  const many = (v: unknown): string[] | undefined => {
    const list = Array.isArray(v) ? v : [v];
    const paths = list.map(entry);
    return paths.length > 0 && paths.every((p): p is string => p !== undefined) ? paths : undefined;
  };
  if (str(input) || Array.isArray(input)) return many(input);
  if (!isObject(input)) return undefined;
  for (const k of ["files", "file_paths", "paths"]) if (k in input) return many(input[k]);
  return many(input);
}

/** The commands a `run_commands` input runs, each as shell text. */
function runCommandsText(input: unknown): string[] | undefined {
  const entry = (e: unknown): string | undefined => {
    if (str(e)) return e;
    if (isObject(e) && str(e.command)) {
      const args = e.args;
      if (args === undefined) return quoteWord(e.command);
      if (Array.isArray(args) && args.every((a) => typeof a === "string"))
        return [e.command, ...args].map(quoteWord).join(" ");
    }
    return undefined;
  };
  const many = (v: unknown): string[] | undefined => {
    const list = Array.isArray(v) ? v : [v];
    const out = list.map(entry);
    return out.length > 0 && out.every((c): c is string => c !== undefined) ? out : undefined;
  };
  if (str(input) || Array.isArray(input)) return many(input);
  if (!isObject(input)) return undefined;
  if ("commands" in input) return many(input.commands);
  if (str(input.cmd)) return [input.cmd];
  if (str(input.command)) return [entry(input)!];
  return undefined;
}

/** The files an `apply_patch` payload adds, updates, deletes or moves to. */
function patchPaths(input: unknown): { paths: string[]; deletesOnly: boolean } | undefined {
  const text = str(input) ? input : isObject(input) && str(input.input) ? input.input : undefined;
  if (text === undefined) return undefined;
  const paths: string[] = [];
  let deletesOnly = true;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
    if (!m) continue;
    paths.push(m[2]!.trim());
    if (m[1] !== "Delete File") deletesOnly = false;
  }
  return paths.length > 0 ? { paths, deletesOnly } : undefined;
}

/**
 * The permission request with what ORCA's policy needs to decide it: the paths a file tool
 * touches as `locations`, resolved against the session's directory as Cline resolves them, and
 * a `run_commands` call's commands as `rawInput.command`. A call whose target cannot be read
 * from its input, and `spawn_agent`, become kind `other`. Nothing is removed from the request,
 * and a request Cline already gave locations to is left as it is.
 */
export function normalizeClinePermissionRequest(
  request: acp.RequestPermissionRequest,
  cwd: string,
): acp.RequestPermissionRequest {
  const tc = request.toolCall;
  if (tc.locations && tc.locations.length > 0) return request;
  const tool = clineToolName(tc.title);
  const input = tc.rawInput;
  const at = (paths: string[]) => paths.map((p) => ({ path: resolvePath(cwd, p) }));
  const unreadable: acp.ToolCallUpdate = { ...tc, kind: "other" };
  let toolCall: acp.ToolCallUpdate;
  switch (tool) {
    case "editor":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const p = isObject(input)
        ? [input.path, input.file_path, input.filePath, input.notebook_path].find(str)
        : undefined;
      toolCall = p ? { ...tc, kind: "edit", locations: at([p]) } : unreadable;
      break;
    }
    case "read_files":
    case "Read": {
      const paths = readFilesPaths(input);
      toolCall = paths ? { ...tc, kind: "read", locations: at(paths) } : unreadable;
      break;
    }
    case "apply_patch": {
      const patch = patchPaths(input);
      toolCall = patch
        ? { ...tc, kind: patch.deletesOnly ? "delete" : "edit", locations: at(patch.paths) }
        : unreadable;
      break;
    }
    case "run_commands":
    case "Bash": {
      const commands = runCommandsText(input);
      toolCall = commands
        ? {
            ...tc,
            kind: "execute",
            rawInput: { ...(isObject(input) ? input : { input }), command: commands.join(" ; ") },
          }
        : unreadable;
      break;
    }
    case "spawn_agent":
    case "Agent":
      // A sub-agent is a new run of tools, not a thought: no default rule allows it.
      toolCall = unreadable;
      break;
    default:
      // `search_codebase`, `fetch_web_content`, `skills`, `ask_question`, MCP tools: as Cline
      // reports them. None carries a path, so no path or workspace rule matches them.
      return request;
  }
  return { ...request, toolCall };
}

/* -------------------------------------------------------------------------- *
 * The wire
 * -------------------------------------------------------------------------- */

type Wire = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown };

/** The `initialize` reply's agent, when `message` is one. */
function initializeAgentInfo(message: Wire): { name?: unknown; version?: unknown } | null | undefined {
  if (message.method !== undefined || !isObject(message.result)) return undefined;
  const r = message.result;
  if (!("protocolVersion" in r) || !("agentCapabilities" in r)) return undefined;
  return isObject(r.agentInfo) ? r.agentInfo : null;
}

/**
 * The agent's side of the stream as ORCA should read it: `initialize` must name a verified
 * Cline, and each permission request is normalized for ORCA's policy.
 */
export function clineReadable(
  readable: ReadableStream<acp.AnyMessage>,
  cwd: string,
  agentId: string,
): ReadableStream<acp.AnyMessage> {
  return readable.pipeThrough(
    new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      transform(message, controller) {
        const m = message as Wire;
        const info = initializeAgentInfo(m);
        if (info !== undefined) {
          const name = info?.name;
          const version = info?.version;
          if (
            name !== CLINE_AGENT_NAME ||
            typeof version !== "string" ||
            !CLINE_CLI_VERIFIED_VERSIONS.includes(version)
          ) {
            const said = `${typeof name === "string" ? name : "an unnamed agent"} ${typeof version === "string" ? version : "(no version)"}`;
            controller.enqueue({
              jsonrpc: "2.0",
              id: m.id ?? null,
              error: {
                code: -32603,
                message: `Agent '${agentId}' reported ${said} at initialize; ORCA opens only Cline CLI ${CLINE_CLI_VERIFIED_VERSIONS.join(", ")}. Install that version with auto-update off.`,
              },
            });
            return;
          }
        }
        if (m.method === "session/request_permission" && isObject(m.params)) {
          controller.enqueue({
            ...m,
            params: normalizeClinePermissionRequest(m.params as unknown as acp.RequestPermissionRequest, cwd),
          } as acp.AnyMessage);
          return;
        }
        controller.enqueue(message);
      },
    }),
  );
}

/** `host`, starting the agent with its readable side passed through `clineReadable`. */
export function clineHost(host: AgentHost, cwd: string): AgentHost {
  const wrapped = Object.create(host) as AgentHost;
  Object.defineProperty(wrapped, "spawnAgent", {
    value: async (...args: Parameters<AgentHost["spawnAgent"]>) => {
      const handle = await host.spawnAgent(...args);
      return {
        ...handle,
        stream: { readable: clineReadable(handle.stream.readable, cwd, args[0].id), writable: handle.stream.writable },
        // Keep the methods bound to the original handle.
        stderrTail: () => handle.stderrTail(),
        kill: (signal?: NodeJS.Signals) => handle.kill(signal),
      };
    },
  });
  return wrapped;
}

/* -------------------------------------------------------------------------- *
 * The session
 * -------------------------------------------------------------------------- */

/** Cline's session option that approves every tool without asking. */
export const CLINE_AUTO_APPROVE_OPTION = "auto_approve";

/** True for a value Cline would read as "auto-approve on" (it takes booleans and their strings). */
export function clineGrantingOption(configId: string, value: unknown): boolean {
  return configId === CLINE_AUTO_APPROVE_OPTION && value !== false && value !== "false";
}

function clineGrantingOptionsIn(options: readonly SessionConfigOption[]): string[] {
  return options
    .filter((o) => clineGrantingOption(o.id, (o as { currentValue?: unknown }).currentValue))
    .map((o) => o.id);
}

/** "Always allow" becomes "Allow once"; with no once option offered, nothing is chosen. */
export function clineBoundedOptionId(
  request: acp.RequestPermissionRequest,
  chosen: string | undefined,
): string | undefined {
  if (chosen === undefined) return undefined;
  const option = request.options.find((o) => o.optionId === chosen);
  if (!option) return chosen;
  if (option.kind === "allow_always") return request.options.find((o) => o.kind === "allow_once")?.optionId;
  if (option.kind === "reject_always") return request.options.find((o) => o.kind === "reject_once")?.optionId ?? chosen;
  return chosen;
}

/** Enforce the session half: Cline's auto-approve option stays off. */
export function guardClineSession(session: AgentSession): AgentSession {
  let tripped: string[] = clineGrantingOptionsIn(session.configOptions);
  const refuseOpen = tripped.length > 0;
  const fail = (what: string) =>
    new OrcaError(
      "NOT_SUPPORTED",
      `Cline session ${what}: ${tripped.join(", ")} approves tools without asking ORCA, so the session was ended.`,
      { agentId: session.agentId, options: [...tripped] },
    );
  const stop = session.onUpdate((e) => {
    if (e.raw.sessionUpdate !== "config_option_update") return;
    const on = clineGrantingOptionsIn(session.configOptions);
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
        const result = await session.prompt(input, options);
        if (tripped.length) throw fail("turned on");
        return result;
      },
    },
    setConfigOption: {
      writable: true,
      value: async (configId: string, value: string | boolean) => {
        if (clineGrantingOption(configId, value))
          throw new OrcaError(
            "NOT_SUPPORTED",
            `ORCA does not set Cline's '${configId}' to '${String(value)}': it approves tools without asking ORCA.`,
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

function mergeProtected(base: ProtectedPaths | undefined, readOnly: string[], noAccess: string[]): ProtectedPaths {
  return {
    ...base,
    readOnly: [...(base?.readOnly ?? []), ...readOnly],
    noAccess: [...(base?.noAccess ?? []), ...noAccess],
  };
}

export function clineGuard(
  home: () => string = homedir,
  image: { platform?: string; digest?: ImageDigest } = {},
): ProviderGuard {
  return {
    id: "cline",
    matches: (agent) => isClineAgent(agent),
    async prepare(options: OpenSessionOptions): Promise<OpenSessionOptions> {
      const { agent, host } = options;
      const withheld = new Set(
        Object.values(options.secrets ?? {})
          .filter((d) => d.host === host.id && d.provider === "env")
          .map((d) => (d.provider === "env" ? d.name : "")),
      );
      const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => !withheld.has(k)));
      const problems = clineProfileProblems(agent, ambient, host.spec?.type);
      const configDir = clineConfigDir(agent);
      const effectiveHome = literalEnv(agent.env).HOME ?? ambient.HOME ?? home();
      if (problems.length === 0 && configDir)
        problems.push(
          ...clineFileProblems(configDir, options.cwd, effectiveHome),
          ...(await clineImageProblems(agent.command, image.platform, image.digest)),
        );
      if (problems.length)
        throw new OrcaError("CONFIG_INVALID", `Cline agent '${agent.id}' cannot start: ${problems.join("; ")}.`, {
          agentId: agent.id,
          problems,
        });
      const paths = clineLoadPaths(configDir!, options.cwd, effectiveHome);
      const ask = options.askPermission;
      return {
        ...options,
        host: clineHost(host, options.cwd),
        protectedPaths: mergeProtected(options.protectedPaths, paths.readOnly, paths.noAccess),
        ...(ask
          ? {
              askPermission: async (request, invocation) =>
                clineBoundedOptionId(request, await ask(request, invocation)),
            }
          : {}),
      };
    },
    guard: guardClineSession,
  };
}
