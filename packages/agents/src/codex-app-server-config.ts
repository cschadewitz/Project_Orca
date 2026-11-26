/**
 * Setting and checking the configuration a Codex app-server thread runs with (#1160).
 *
 * ORCA hands Codex its approval policy, reviewer and sandbox twice: as session flags on the
 * command line (`-c key=value`, `codexSessionFlags`), which win over the user's, the project's
 * and the system's `config.toml`, and again as `thread/start` / `thread/resume` parameters. It
 * then reads back what Codex will actually run with, and refuses the session when that is not
 * what ORCA set (`codexConfigCheck`):
 *
 * - `config/read` (with the session's cwd, so project layers count): the effective
 *   `approval_policy`, `approvals_reviewer` and `sandbox_mode` must be ORCA's. A layer above the
 *   session flags (a managed `config.toml`) that overrides one is refused, and so is any other
 *   layer in force (user, project, system) that sets one of them to anything else: ORCA names
 *   the setting and the file rather than run over the user's choice silently.
 *   Any MCP server in force is refused too: ORCA hands this driver none, and one from a config
 *   file would run outside ORCA's view.
 * - `configRequirements/read`: managed requirements that do not allow ORCA's approval policy or
 *   sandbox are refused.
 * - `hooks/list`: any enabled hook (user, project, plugin or managed) is refused: it would run
 *   in Codex's own runner, outside ORCA's view. With ORCA's own hook (#1161), every directory
 *   listed must show exactly that hook, from ORCA's session flags, trusted and enabled
 *   (`codexHookListProblem`), and the effective `web_search` must be `disabled`.
 *
 * The check reads only the keys above. The raw config, which can carry an MCP server's
 * environment and its secrets, is never logged, returned or put in an error.
 *
 * Writable roots: a workspace-write thread may write its cwd, the roots Codex reports, `/tmp`
 * and `$TMPDIR` unless excluded. None of them may overlap a path ORCA protects (its config
 * directory and sidecars), checked against the sandbox the thread came back with
 * (`codexWritableRootsProblem`).
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { OrcaError } from "@orca/core";
import { CODEX_HOOK_KEY, codexHookListProblem } from "./native-tool-hook-session.js";

/** The policy ORCA runs a Codex thread with. */
export interface CodexThreadPolicy {
  /** The only policy Codex 0.171.0 still supports that asks before acting outside the sandbox. */
  approvalPolicy: "on-request";
  sandbox: "read-only" | "workspace-write";
}

/** The config keys ORCA sets, with the value each must have. */
const policyKeys = (policy: CodexThreadPolicy) =>
  [
    ["approval_policy", policy.approvalPolicy],
    ["approvals_reviewer", "user"],
    ["sandbox_mode", policy.sandbox],
  ] as const;

/**
 * The `-c` session flags that set ORCA's policy, placed before the `app-server` subcommand.
 * Each value is a TOML basic string.
 */
export function codexSessionFlags(policy: CodexThreadPolicy): string[] {
  return policyKeys(policy).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}

/** Where a config value came from, as Codex names its layers. */
export type CodexConfigLayerType =
  | "mdm"
  | "system"
  | "enterpriseManaged"
  | "user"
  | "project"
  | "sessionFlags"
  | "legacyManagedConfigTomlFromFile"
  | "legacyManagedConfigTomlFromMdm"
  | "packagedDefaults";

const LAYER_TYPES: readonly string[] = [
  "mdm",
  "system",
  "enterpriseManaged",
  "user",
  "project",
  "sessionFlags",
  "legacyManagedConfigTomlFromFile",
  "legacyManagedConfigTomlFromMdm",
  "packagedDefaults",
];

/** What ORCA checked and found, kept with the session for diagnostics. No config values beyond these. */
export interface CodexVerifiedConfig {
  approvalPolicy: CodexThreadPolicy["approvalPolicy"];
  approvalsReviewer: "user";
  sandbox: CodexThreadPolicy["sandbox"];
  /** The layer each of ORCA's settings came from: the session flags, or a managed layer that sets the same. */
  origins: Record<"approval_policy" | "approvals_reviewer" | "sandbox_mode", CodexConfigLayerType>;
  /** Codex's config layers, highest first, and whether each was in force. */
  layers: { type: CodexConfigLayerType; enabled: boolean }[];
  /** Whether managed requirements were present (and allowed ORCA's policy). */
  requirements: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A layer as a person would find it: its type and, for a file, its path. Never its contents. */
function describeLayer(name: Record<string, unknown>): string {
  const at = (path: unknown) => (typeof path === "string" ? ` (${path})` : "");
  switch (name.type) {
    case "user":
      return `the user config.toml${at(name.file)}`;
    case "project":
      return `the project config${typeof name.dotCodexFolder === "string" ? ` in ${name.dotCodexFolder}` : ""}`;
    case "system":
      return `the system config.toml${at(name.file)}`;
    case "legacyManagedConfigTomlFromFile":
      return `the managed config${at(name.file)}`;
    case "enterpriseManaged":
      return "the enterprise-managed config";
    case "mdm":
    case "legacyManagedConfigTomlFromMdm":
      return "the managed config from device management";
    case "sessionFlags":
      return "the session flags";
    default:
      return `the ${String(name.type)} config`;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The values Codex 0.171.0 defines for each setting ORCA checks. Only these are ever repeated
 * in an error or its details; anything else (a granular policy object, a value from a newer
 * Codex, a stray string) is summarized, so no raw config value leaves the check.
 */
const KNOWN_VALUES: Record<string, readonly string[]> = {
  approval_policy: ["untrusted", "on-request", "never"],
  approvals_reviewer: ["user", "auto_review", "guardian_subagent"],
  sandbox_mode: ["read-only", "workspace-write", "danger-full-access"],
  allowedApprovalPolicies: ["untrusted", "on-request", "never"],
  allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
  web_search: ["disabled", "cached", "live"],
};
/** `value` as it may appear in an error: a known enum value quoted, otherwise a summary. */
function shown(setting: string, value: unknown): string {
  if (value === null || value === undefined) return "nothing";
  if (typeof value === "string" && KNOWN_VALUES[setting]?.includes(value)) return JSON.stringify(value);
  return "a value ORCA does not know";
}
/** `value` as it may appear in an error's details: a known enum value, otherwise null. */
const detail = (setting: string, value: unknown) =>
  typeof value === "string" && KNOWN_VALUES[setting]?.includes(value) ? value : null;
const HOOK_EVENTS = [
  "preModelRequest",
  "postModelRequest",
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "preCompact",
  "postCompact",
  "sessionStart",
  "sessionEnd",
  "userPromptSubmit",
  "subagentStart",
  "subagentStop",
  "stop",
  "interrupt",
];
const HOOK_SOURCES = [
  "system",
  "user",
  "project",
  "mdm",
  "sessionFlags",
  "plugin",
  "cloudRequirements",
  "cloudManagedConfig",
  "legacyManagedConfigFile",
  "legacyManagedConfigMdm",
  "unknown",
];
/** An MCP server's name, when it is a plain identifier; never anything else from its entry. */
const SERVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Check what Codex reports it will run with against ORCA's policy. `config` is `config/read`
 * `{includeLayers: true, cwd}`, `requirements` is `configRequirements/read`, `hooks` is
 * `hooks/list`. Returns what was verified; throws `NOT_SUPPORTED` naming the setting when
 * Codex would run with anything else, `AGENT_PROTOCOL` when an answer is malformed.
 */
export function codexConfigCheck(
  agentId: string,
  policy: CodexThreadPolicy,
  answers: { config: unknown; requirements: unknown; hooks: unknown },
  /** ORCA's own hook's command, when the session installs it (#1161). */
  ownHook?: string,
): CodexVerifiedConfig {
  const malformed = (method: string) =>
    new OrcaError(
      "AGENT_PROTOCOL",
      `agent ${agentId}: codex app-server answered ${method} with a shape ORCA does not know`,
      {
        agentId,
      },
    );
  const refuse = (what: string, details: Record<string, unknown>) =>
    new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agentId}: ${what}. ORCA runs Codex only with the approval policy, reviewer and sandbox it sets, and refuses the session.`,
      { agentId, ...details },
    );

  // config/read
  const read = answers.config;
  if (!isObject(read) || !isObject(read.config) || !isObject(read.origins) || !Array.isArray(read.layers))
    throw malformed("config/read");
  const layers = read.layers.map((l: unknown) => {
    if (
      !isObject(l) ||
      !isObject(l.name) ||
      typeof l.name.type !== "string" ||
      !LAYER_TYPES.includes(l.name.type) ||
      // Codex 0.171.0 leaves `disabledReason` out for a layer in force, though its type says null.
      !(l.disabledReason === null || l.disabledReason === undefined || typeof l.disabledReason === "string") ||
      !(l.config === null || l.config === undefined || isObject(l.config))
    )
      throw malformed("config/read");
    return {
      name: l.name,
      type: l.name.type as CodexConfigLayerType,
      enabled: typeof l.disabledReason !== "string",
      config: isObject(l.config) ? l.config : {},
    };
  });

  const origins = {} as CodexVerifiedConfig["origins"];
  for (const [key, want] of policyKeys(policy)) {
    const value = read.config[key];
    const origin = read.origins[key];
    if (origin !== undefined && (!isObject(origin) || !isObject(origin.name) || typeof origin.name.type !== "string"))
      throw malformed("config/read");
    const from = origin?.name as Record<string, unknown> | undefined;
    if (!same(value, want) || typeof from?.type !== "string" || !LAYER_TYPES.includes(from.type))
      throw refuse(
        `Codex would run with ${key} = ${shown(key, value)}` +
          (from && typeof from.type === "string" && LAYER_TYPES.includes(from.type)
            ? ` from ${describeLayer(from)}`
            : "") +
          `, not ORCA's ${JSON.stringify(want)}`,
        {
          setting: key,
          value: detail(key, value),
          layer: typeof from?.type === "string" && LAYER_TYPES.includes(from.type) ? from.type : null,
        },
      );
    origins[key] = from.type as CodexConfigLayerType;
    // A setting in force below the session flags that says otherwise is the user's choice:
    // ORCA names it rather than run over it.
    for (const layer of layers) {
      if (!layer.enabled || layer.type === "sessionFlags" || !(key in layer.config)) continue;
      if (!same(layer.config[key], want))
        throw refuse(
          `${describeLayer(layer.name)} sets ${key} = ${shown(key, layer.config[key])}, not ORCA's ${JSON.stringify(want)}; remove it or set it to ${JSON.stringify(want)}`,
          { setting: key, value: detail(key, layer.config[key]), layer: layer.type },
        );
    }
  }

  // Hosted web search runs at the model provider, where no hook sees it (#1161).
  if (ownHook !== undefined && read.config.web_search !== "disabled")
    throw refuse(
      `Codex would run with web_search = ${shown("web_search", read.config.web_search)}, not "disabled", which ORCA's hook needs`,
      { setting: "web_search", value: detail("web_search", read.config.web_search) },
    );

  const mcp = read.config.mcp_servers;
  if (mcp !== undefined && mcp !== null) {
    if (!isObject(mcp)) throw malformed("config/read");
    const running = Object.entries(mcp)
      .filter(([, server]) => !(isObject(server) && server.enabled === false))
      .map(([name]) => (SERVER_NAME.test(name) ? name : "(a server whose name ORCA does not repeat)"));
    if (running.length > 0)
      throw refuse(`Codex's config adds the MCP server${running.length > 1 ? "s" : ""} ${running.join(", ")}`, {
        setting: "mcp_servers",
        servers: running,
      });
  }

  // configRequirements/read
  const req = answers.requirements;
  if (!isObject(req) || !(req.requirements === null || isObject(req.requirements)))
    throw malformed("configRequirements/read");
  const requirements = req.requirements;
  if (requirements) {
    const allows = (field: string, want: string) => {
      const allowed = requirements[field];
      if (allowed === null || allowed === undefined) return;
      if (!Array.isArray(allowed)) throw malformed("configRequirements/read");
      if (!allowed.some((a) => same(a, want)))
        throw refuse(
          `Codex's managed requirements allow ${field} ${allowed.map((a) => shown(field, a)).join(", ") || "nothing"}, without ORCA's ${JSON.stringify(want)}`,
          { setting: field, allowed: allowed.map((a) => detail(field, a)) },
        );
    };
    allows("allowedApprovalPolicies", policy.approvalPolicy);
    allows("allowedSandboxModes", policy.sandbox);
  }

  // hooks/list
  const listed = answers.hooks;
  if (!isObject(listed) || !Array.isArray(listed.data)) throw malformed("hooks/list");
  const hooks: string[] = [];
  if (ownHook !== undefined && listed.data.length === 0)
    throw refuse("Codex listed no hooks, so ORCA's hook is not in force", { setting: "hooks" });
  for (const entry of listed.data) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) throw malformed("hooks/list");
    if (ownHook !== undefined) {
      const problem = codexHookListProblem({ hooks: entry.hooks }, ownHook);
      if (problem !== undefined) throw refuse(problem, { setting: "hooks" });
    }
    for (const hook of entry.hooks) {
      if (!isObject(hook) || typeof hook.enabled !== "boolean") throw malformed("hooks/list");
      const ours = ownHook !== undefined && hook.key === CODEX_HOOK_KEY && hook.source === "sessionFlags";
      if (hook.enabled && !ours) {
        const event =
          typeof hook.eventName === "string" && HOOK_EVENTS.includes(hook.eventName) ? hook.eventName : "a hook";
        const source =
          typeof hook.source === "string" && HOOK_SOURCES.includes(hook.source) ? hook.source : "unknown source";
        hooks.push(`${event} (${source})`);
      }
    }
  }
  if (hooks.length > 0)
    throw refuse(`Codex would run the hook${hooks.length > 1 ? "s" : ""} ${hooks.join(", ")}`, {
      setting: "hooks",
      hooks,
    });

  return {
    approvalPolicy: policy.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: policy.sandbox,
    origins,
    layers: layers.map((l) => ({ type: l.type, enabled: l.enabled })),
    requirements: requirements !== null,
  };
}

/**
 * `p` with every link it goes through resolved: the deepest ancestor that exists is resolved by
 * the host, and the missing rest appended, so a sidecar not yet created under a linked
 * directory resolves where it will be. `undefined` when that cannot be known: a relative path, a
 * `..` segment (which a link before it would change), or an ancestor that cannot be resolved for
 * any reason but not existing.
 */
function resolvedPath(p: string): string | undefined {
  if (!isAbsolute(p) || p.split(/[\\/]/).includes("..")) return undefined;
  const missing: string[] = [];
  let at = resolve(p);
  for (;;) {
    try {
      return join(realpathSync(at), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = dirname(at);
      if (parent === at) return undefined;
      missing.push(basename(at));
      at = parent;
    }
  }
}
/** Whether `inner` is `outer` or inside it, compared segment by segment. */
const within = (inner: string, outer: string) => {
  const a = inner.split(sep).filter(Boolean);
  const b = outer.split(sep).filter(Boolean);
  return b.length <= a.length && b.every((segment, i) => segment === a[i]);
};

/**
 * The roots a thread's sandbox lets Codex write, as `thread/start` / `thread/resume` reported
 * it: none for `readOnly`; for `workspaceWrite` the cwd, its `writableRoots`, `/tmp` and
 * `$TMPDIR` unless excluded. `undefined` for a sandbox ORCA does not know.
 */
export function codexWritableRoots(sandbox: unknown, cwd: string, tmpdir: string | undefined): string[] | undefined {
  if (!isObject(sandbox)) return undefined;
  if (sandbox.type === "readOnly") return [];
  if (sandbox.type !== "workspaceWrite") return undefined;
  const roots = sandbox.writableRoots;
  if (!Array.isArray(roots) || !roots.every((r) => typeof r === "string")) return undefined;
  if (typeof sandbox.excludeSlashTmp !== "boolean" || typeof sandbox.excludeTmpdirEnvVar !== "boolean")
    return undefined;
  return [
    cwd,
    ...roots,
    ...(sandbox.excludeSlashTmp ? [] : ["/tmp"]),
    ...(sandbox.excludeTmpdirEnvVar || !tmpdir ? [] : [tmpdir]),
  ];
}

/**
 * A writable root that overlaps a protected path, described; `undefined` when none does. Fails
 * closed: a root or protected path whose real location cannot be resolved is a problem too.
 */
export function codexWritableRootsProblem(
  roots: readonly string[],
  protectedPaths: readonly string[],
): string | undefined {
  if (protectedPaths.length === 0) return undefined;
  const guarded: [string, string][] = [];
  for (const p of protectedPaths) {
    const real = resolvedPath(p);
    if (real === undefined) return `ORCA could not resolve where its protected ${p} is`;
    guarded.push([p, real]);
  }
  for (const root of roots) {
    const real = resolvedPath(root);
    if (real === undefined) return `ORCA could not resolve where the writable root ${root} is`;
    for (const [p, realP] of guarded)
      if (within(realP, real) || within(real, realP))
        return `the thread could write ${root}, which overlaps ORCA's protected ${p}`;
  }
  return undefined;
}
