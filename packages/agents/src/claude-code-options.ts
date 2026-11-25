/**
 * Claude Code settings isolation and command sandbox on the ACP route (#1134).
 *
 * The Claude ACP adapter starts Claude Code with every filesystem settings source (`user`,
 * `project`, `local`), so a checkout's `.claude/settings.json` can add hooks, MCP servers,
 * environment and allow rules that ORCA did not choose. The adapter forwards the serializable
 * Agent SDK options it finds in `session/new`'s `_meta.claudeCode.options` and spreads them
 * after its own defaults (claude-agent-acp 0.109.1, `dist/v1/acp-agent.js`, the
 * `...userProvidedOptions` spread after `settingSources: ["user", "project", "local"]`), so an
 * agent's `claudeCode` config can narrow both without the SDK driver:
 *
 * - `settingSources` chooses which of the three Claude Code loads. Settings ORCA passes itself
 *   (its hook, the sandbox below) are in the `--settings` layer and apply regardless.
 * - `sandbox: on` runs Claude Code's Bash commands in its OS sandbox, refusing the session at
 *   startup when the sandbox cannot start, and never letting a command out of it. A sandboxed
 *   command is still asked about: `autoAllowBashIfSandboxed` stays off, so the sandbox adds a
 *   boundary and never takes a permission decision away from ORCA.
 *
 * The adapter's own settings reader still reads every source for the few decisions it makes
 * before starting Claude Code (the initial permission mode among them), so a narrowed
 * `settingSources` also turns off the bypass mode the checkout could otherwise start the
 * session in (`allowDangerouslySkipPermissions: false`).
 */
import { OrcaError } from "@orca/core";
import { CLAUDE_ADAPTER_NAMES } from "./native-tool-hook-session.js";
import type { ProtectedPaths } from "./permissions.js";
import type { OpenSessionOptions } from "./acp-session.js";

type SessionMeta = NonNullable<OpenSessionOptions["sessionMeta"]>;

export type ClaudeSettingSource = "user" | "project" | "local";

/** An agent's `claudeCode` config (`AgentSpecSchema`). */
export interface ClaudeCodeConfig {
  readonly settingSources?: readonly ClaudeSettingSource[] | undefined;
  readonly sandbox?: "on" | "off" | undefined;
}

/** Whether the config asks for anything; nothing asked sends nothing, as before #1134. */
export function claudeCodeOptionsRequested(config: ClaudeCodeConfig | undefined): boolean {
  return config?.settingSources !== undefined || config?.sandbox === "on";
}

/**
 * Claude Code's `sandbox` settings for `sandbox: on`. ORCA's no-access paths are kept from
 * sandboxed commands entirely and its read-only files from their writes; the sandbox already
 * keeps writes inside the session's directories.
 */
export function claudeSandboxSettings(protectedPaths: ProtectedPaths | undefined): Record<string, unknown> {
  const noAccess = [...(protectedPaths?.noAccess ?? [])];
  // A read-only directory that holds an area the agent may write (the store's `work/`) is left
  // to the policy, as the ACP session's own checks leave it.
  const readOnly = (protectedPaths?.readOnly ?? []).filter(
    (p) => !(protectedPaths?.agentAreas ?? []).some((area) => area.startsWith(`${p}/`) || area === p),
  );
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    ...(noAccess.length || readOnly.length
      ? {
          filesystem: {
            ...(noAccess.length ? { denyRead: noAccess } : {}),
            denyWrite: [...readOnly, ...noAccess],
          },
        }
      : {}),
  };
}

/**
 * The `_meta.claudeCode.options` for an agent's `claudeCode` config, or undefined when it asks
 * for nothing.
 */
export function claudeCodeOptions(
  config: ClaudeCodeConfig | undefined,
  protectedPaths: ProtectedPaths | undefined,
): Record<string, unknown> | undefined {
  if (!claudeCodeOptionsRequested(config)) return undefined;
  const sources = config?.settingSources;
  const narrowed = sources !== undefined && !(sources.includes("project") && sources.includes("local"));
  return {
    ...(sources !== undefined ? { settingSources: [...sources] } : {}),
    ...(narrowed ? { allowDangerouslySkipPermissions: false } : {}),
    ...(config?.sandbox === "on" ? { settings: { sandbox: claudeSandboxSettings(protectedPaths) } } : {}),
  };
}

/**
 * Adds `options` to a session `_meta` that may already carry ORCA's hook settings. Each
 * settings key is set once: a clash means two parts of ORCA disagree, and the session is
 * refused rather than one of them dropped.
 */
export function withClaudeCodeOptions(
  meta: Record<string, unknown> | undefined,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const claudeCode = (meta?.["claudeCode"] ?? {}) as Record<string, unknown>;
  const current = (claudeCode["options"] ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(options)) {
    if (key === "settings") continue;
    if (key in current) throw new Error(`claudeCode option ${key} is set twice`);
    merged[key] = value;
  }
  if (options["settings"] !== undefined) {
    const settings = { ...((current["settings"] ?? {}) as Record<string, unknown>) };
    for (const [key, value] of Object.entries(options["settings"] as Record<string, unknown>)) {
      if (key in settings) throw new Error(`claudeCode setting ${key} is set twice`);
      settings[key] = value;
    }
    merged["settings"] = settings;
  }
  return { ...(meta ?? {}), claudeCode: { ...claudeCode, options: merged } };
}

/**
 * Wraps a session's `sessionMeta` (or none) so an agent's `claudeCode` config reaches Claude
 * Code. Once the agent has said at `initialize` who it is, a config for an agent that is not
 * the Claude ACP adapter refuses the session: a sandbox ORCA was asked for and could not
 * install is not dropped silently.
 */
export function claudeCodeSessionMeta(
  agentId: string,
  config: ClaudeCodeConfig | undefined,
  protectedPaths: ProtectedPaths | undefined,
  inner?: SessionMeta,
): SessionMeta | undefined {
  const options = claudeCodeOptions(config, protectedPaths);
  if (options === undefined) return inner;
  return async (agentInfo, ext, agentPid, signal) => {
    if (!agentInfo || !CLAUDE_ADAPTER_NAMES.includes(agentInfo.name))
      throw new OrcaError(
        "NOT_SUPPORTED",
        `agent ${agentId} has claudeCode settings, which apply only to the Claude ACP adapter, and the agent ` +
          `${agentInfo ? `says it is ${agentInfo.name}` : "did not say at initialize which adapter it is"}. ` +
          `ORCA refuses the session rather than run it without them; remove claudeCode to run it as it is.`,
        { agentId, ...(agentInfo ? { adapter: agentInfo.name } : {}) },
      );
    const meta = inner ? await inner(agentInfo, ext, agentPid, signal) : undefined;
    return withClaudeCodeOptions(meta, options);
  };
}
