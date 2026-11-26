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
 * - `hooks/list`: any enabled hook (user, project, plugin or managed) is refused. ORCA's own
 *   hook is not offered on this driver, and another hook would run in Codex's own runner.
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
import { isAbsolute, relative, resolve } from "node:path";
import { OrcaError } from "@orca/core";

/** The policy ORCA runs a Codex thread with. */
export interface CodexThreadPolicy {
  approvalPolicy: "untrusted" | "on-request";
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
  switch (name.type) {
    case "user":
      return `the user config.toml (${String(name.file)})`;
    case "project":
      return `the project config in ${String(name.dotCodexFolder)}`;
    case "system":
      return `the system config.toml (${String(name.file)})`;
    case "legacyManagedConfigTomlFromFile":
      return `the managed config (${String(name.file)})`;
    case "enterpriseManaged":
      return `the enterprise-managed config "${String(name.name)}"`;
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
 * Check what Codex reports it will run with against ORCA's policy. `config` is `config/read`
 * `{includeLayers: true, cwd}`, `requirements` is `configRequirements/read`, `hooks` is
 * `hooks/list`. Returns what was verified; throws `NOT_SUPPORTED` naming the setting when
 * Codex would run with anything else, `AGENT_PROTOCOL` when an answer is malformed.
 */
export function codexConfigCheck(
  agentId: string,
  policy: CodexThreadPolicy,
  answers: { config: unknown; requirements: unknown; hooks: unknown },
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
        `Codex would run with ${key} = ${JSON.stringify(value ?? null)}` +
          (from ? ` from ${describeLayer(from)}` : "") +
          `, not ORCA's ${JSON.stringify(want)}`,
        { setting: key, value: value ?? null, layer: from?.type ?? null },
      );
    origins[key] = from.type as CodexConfigLayerType;
    // A setting in force below the session flags that says otherwise is the user's choice:
    // ORCA names it rather than run over it.
    for (const layer of layers) {
      if (!layer.enabled || layer.type === "sessionFlags" || !(key in layer.config)) continue;
      if (!same(layer.config[key], want))
        throw refuse(
          `${describeLayer(layer.name)} sets ${key} = ${JSON.stringify(layer.config[key])}, not ORCA's ${JSON.stringify(want)}; remove it or set it to ${JSON.stringify(want)}`,
          { setting: key, value: layer.config[key] ?? null, layer: layer.type },
        );
    }
  }

  const mcp = read.config.mcp_servers;
  if (mcp !== undefined && mcp !== null) {
    if (!isObject(mcp)) throw malformed("config/read");
    const running = Object.entries(mcp)
      .filter(([, server]) => !(isObject(server) && server.enabled === false))
      .map(([name]) => name);
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
          `Codex's managed requirements allow ${field} ${JSON.stringify(allowed)}, without ORCA's ${JSON.stringify(want)}`,
          {
            setting: field,
            allowed,
          },
        );
    };
    allows("allowedApprovalPolicies", policy.approvalPolicy);
    allows("allowedSandboxModes", policy.sandbox);
  }

  // hooks/list
  const listed = answers.hooks;
  if (!isObject(listed) || !Array.isArray(listed.data)) throw malformed("hooks/list");
  const hooks: string[] = [];
  for (const entry of listed.data) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) throw malformed("hooks/list");
    for (const hook of entry.hooks) {
      if (!isObject(hook) || typeof hook.enabled !== "boolean") throw malformed("hooks/list");
      if (hook.enabled) hooks.push(`${String(hook.eventName)} (${String(hook.source)})`);
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

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
/** Whether `inner` is `outer` or inside it. */
const within = (inner: string, outer: string) => {
  const rel = relative(real(outer), real(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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

/** A writable root that overlaps a protected path, described; `undefined` when none does. */
export function codexWritableRootsProblem(
  roots: readonly string[],
  protectedPaths: readonly string[],
): string | undefined {
  for (const root of roots)
    for (const p of protectedPaths)
      if (within(p, root) || within(root, p))
        return `the thread could write ${root}, which overlaps ORCA's protected ${p}`;
  return undefined;
}
