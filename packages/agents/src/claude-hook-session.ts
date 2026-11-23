/**
 * Installing ORCA's Claude `PreToolUse` hook (`claude-pre-tool-hook.ts`) in a session (#704).
 *
 * The hook goes in through the Claude ACP adapter's programmatic settings tier:
 * `session/new`'s `_meta.claudeCode.options.settings`, as an object. ORCA decides whether to
 * send it once the agent has answered `initialize`, because only then does it know which
 * adapter it is talking to and at what version:
 *
 * - **Not the Claude adapter, or an agent that does not say who it is**: refused. The agent
 *   opted in to the hook, and no other agent here takes it, so the session would run without
 *   the check it asked for.
 * - **The Claude adapter at a version the acceptance test has not covered**: refused. Each
 *   version in `CLAUDE_HOOK_VERIFIED_ADAPTERS` is one `claude-hook-acceptance.yml` installs and
 *   runs against the real Claude Code it bundles: the hook runs on remembered calls, `ask`
 *   reaches ORCA, and a hook that cannot start, crashes, times out or answers JSON Claude
 *   cannot read blocks the call. Another version may behave differently (an older Claude Code
 *   may ignore `onFailure: "block"`), so a session there would only look guarded.
 * - **A platform the acceptance test does not run on**: refused, for the same reason
 *   (`CLAUDE_HOOK_VERIFIED_PLATFORMS`).
 * - **A covered adapter**: ORCA writes the session's context file (the rules, sidecars,
 *   workspace and protected paths the hook decides with) with owner-only permissions into a
 *   private directory ORCA protects from agents, and sends the settings that run the hook
 *   with that file. `cleanup` removes the file when the session ends.
 *
 * The hook runs on the agent's machine, so this applies to agents on the daemon's own host.
 * The factory refuses an opted-in agent on an SSH host before anything starts.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OrcaError, type ConfiguredPermissionPolicy } from "@orca/core";
import { claudePreToolHookSettings, type ClaudeHookContext } from "./claude-pre-tool-hook.js";
import type { ProtectedPaths } from "./permissions.js";

/** The names the Claude ACP adapter reports in `initialize`'s `agentInfo`. */
export const CLAUDE_ADAPTER_NAMES: readonly string[] = [
  "@agentclientprotocol/claude-agent-acp",
  "@zed-industries/claude-code-acp",
];

/**
 * The adapter versions whose installed hook behaviour `claude-hook-acceptance.yml` observes,
 * each one installed and run there. Adding a version is a reviewed change to both.
 */
export const CLAUDE_HOOK_VERIFIED_ADAPTERS: readonly string[] = ["0.109.1"];

/** The platforms (`process.platform`) that workflow runs the acceptance test on. */
export const CLAUDE_HOOK_VERIFIED_PLATFORMS: readonly NodeJS.Platform[] = ["linux"];

/**
 * Where the hook program is, as built: `bin/claude-pre-tool-hook.js` beside this module in
 * the package's `dist`, or `claude-pre-tool-hook.mjs` beside the bundled daemon
 * (`packages/app/scripts/build-daemon.js`). Undefined when neither exists, which is the case
 * when this runs from source.
 */
export function claudePreToolHookScript(): string | undefined {
  for (const rel of ["./bin/claude-pre-tool-hook.js", "./claude-pre-tool-hook.mjs"]) {
    const file = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(file)) return file;
  }
  return undefined;
}

export interface ClaudeHookSessionOptions {
  agentId: string;
  permissions: ConfiguredPermissionPolicy;
  permissionFiles: readonly string[];
  workspaceCwd: string;
  additionalDirectories?: readonly string[] | undefined;
  protectedPaths?: ProtectedPaths | undefined;
  /** A directory only ORCA uses, protected from agents; the context file is written here. */
  contextDir: string;
  /** The runtime and the hook program, both absolute. No program: a Claude session is refused. */
  runtime: string;
  script: string | undefined;
  /** The platform the agent runs on; `process.platform` unless a test says otherwise. */
  platform?: NodeJS.Platform | undefined;
}

export type ClaudeHookStatus = "pending" | "installed";

export interface ClaudeHookSession {
  /** For `OpenSessionOptions.sessionMeta`. */
  sessionMeta: (
    agentInfo: { name: string; version: string } | undefined,
  ) => Promise<Record<string, unknown> | undefined>;
  /** What happened at `initialize`. */
  status: () => ClaudeHookStatus;
  /** Remove the context file, if one was written. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/** The hook, ready to be installed in one session if the agent turns out to be Claude. */
export function claudeHookSession(opts: ClaudeHookSessionOptions): ClaudeHookSession {
  let status: ClaudeHookStatus = "pending";
  let file: string | undefined;
  return {
    status: () => status,
    cleanup: async () => {
      if (file === undefined) return;
      const f = file;
      file = undefined;
      await rm(f, { force: true });
    },
    sessionMeta: async (agentInfo) => {
      const refuse = (why: string, details: Record<string, unknown> = {}) =>
        new OrcaError(
          "NOT_SUPPORTED",
          `agent ${opts.agentId} has nativeToolHook: on, but ${why}, so ORCA cannot check its tool calls. ` +
            `ORCA refuses the session rather than run it unguarded; remove nativeToolHook: on to run it without the hook.`,
          { agentId: opts.agentId, ...details },
        );
      if (!agentInfo) throw refuse("the agent did not say at initialize which adapter it is");
      if (!CLAUDE_ADAPTER_NAMES.includes(agentInfo.name))
        throw refuse(`it runs ${agentInfo.name}, which does not take ORCA's hook`, { adapter: agentInfo.name });
      if (!CLAUDE_HOOK_VERIFIED_ADAPTERS.includes(agentInfo.version))
        throw refuse(
          `it runs ${agentInfo.name} ${agentInfo.version}, and ORCA has verified the hook only with ${CLAUDE_HOOK_VERIFIED_ADAPTERS.join(", ")}`,
          { adapter: agentInfo.name, version: agentInfo.version, verified: [...CLAUDE_HOOK_VERIFIED_ADAPTERS] },
        );
      const platform = opts.platform ?? process.platform;
      if (!CLAUDE_HOOK_VERIFIED_PLATFORMS.includes(platform))
        throw refuse(
          `ORCA has verified the hook only on ${CLAUDE_HOOK_VERIFIED_PLATFORMS.join(", ")}, not ${platform}`,
          {
            platform,
          },
        );
      if (opts.script === undefined) throw refuse("ORCA's hook program is missing from this build");
      const context: ClaudeHookContext = {
        version: 1,
        agentId: opts.agentId,
        permissions: opts.permissions,
        permissionFiles: [...opts.permissionFiles],
        workspaceCwd: opts.workspaceCwd,
        ...(opts.additionalDirectories?.length ? { additionalDirectories: [...opts.additionalDirectories] } : {}),
        // The hook program is read-only to the agent's native tools too, beside ORCA's own files.
        protectedPaths: {
          readOnly: [...(opts.protectedPaths?.readOnly ?? []), opts.script],
          noAccess: [...(opts.protectedPaths?.noAccess ?? [])],
          ...(opts.protectedPaths?.agentAreas ? { agentAreas: [...opts.protectedPaths.agentAreas] } : {}),
        },
      };
      await mkdir(opts.contextDir, { recursive: true, mode: 0o700 });
      file = join(opts.contextDir, `${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(context), { encoding: "utf8", mode: 0o600, flag: "wx" });
      status = "installed";
      return {
        claudeCode: {
          options: { settings: claudePreToolHookSettings({ command: opts.runtime, args: [opts.script, file] }) },
        },
      };
    },
  };
}
