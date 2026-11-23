/**
 * Installing ORCA's Claude `PreToolUse` hook (`claude-pre-tool-hook.ts`) in a session (#704).
 *
 * The hook goes in through the Claude ACP adapter's programmatic settings tier:
 * `session/new`'s `_meta.claudeCode.options.settings`, as an object. ORCA decides whether to
 * send it once the agent has answered `initialize`, because only then does it know which
 * adapter it is talking to and at what version:
 *
 * - **Not the Claude adapter**: nothing is sent. Another agent would not know the key and the
 *   hook would not run.
 * - **The Claude adapter, older than `CLAUDE_HOOK_MIN_ADAPTER`**: refused. The minimum is the
 *   version whose installed behaviour the acceptance test (`claude-hook-acceptance.yml`)
 *   observes against the real Claude Code: the hook runs on remembered calls, `ask` reaches
 *   ORCA, and a hook that cannot start, crashes, times out or prints garbage blocks the call.
 *   Older adapters bundle an older Claude Code, where `onFailure: "block"` may be ignored,
 *   so a session there would only look guarded. An agent can opt out (`nativeToolHook: off`).
 * - **A qualifying adapter**: ORCA writes the session's context file (the rules, sidecars,
 *   workspace and protected paths the hook decides with) with owner-only permissions into a
 *   private directory ORCA protects from agents, and sends the settings that run the hook
 *   with that file. `cleanup` removes the file when the session ends.
 *
 * The hook runs on the agent's machine, so this applies to agents on the daemon's own host.
 * An agent on an SSH host gets no hook; the factory says so in the log.
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

/** The oldest adapter whose installed hook behaviour is observed by the acceptance test. */
export const CLAUDE_HOOK_MIN_ADAPTER = "0.109.1";

/** Whether `version` (`x.y.z`, any suffix ignored) is at least `min`. Unparseable is not. */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1, 4).map(Number);
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  return true;
}

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
}

export type ClaudeHookStatus = "pending" | "installed" | "not-claude";

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
      if (!agentInfo || !CLAUDE_ADAPTER_NAMES.includes(agentInfo.name)) {
        status = "not-claude";
        return undefined;
      }
      if (!versionAtLeast(agentInfo.version, CLAUDE_HOOK_MIN_ADAPTER))
        throw new OrcaError(
          "NOT_SUPPORTED",
          `agent ${opts.agentId} runs ${agentInfo.name} ${agentInfo.version}; ORCA's tool-call hook needs ${CLAUDE_HOOK_MIN_ADAPTER} or later. ` +
            `Upgrade the adapter, or set nativeToolHook: off for this agent to run it without ORCA checking every call.`,
          {
            agentId: opts.agentId,
            adapter: agentInfo.name,
            version: agentInfo.version,
            minimum: CLAUDE_HOOK_MIN_ADAPTER,
          },
        );
      if (opts.script === undefined)
        throw new OrcaError(
          "NOT_SUPPORTED",
          `ORCA's tool-call hook program is missing from this build, so agent ${opts.agentId} cannot be guarded; set nativeToolHook: off to run it without the hook`,
          { agentId: opts.agentId },
        );
      const context: ClaudeHookContext = {
        version: 1,
        agentId: opts.agentId,
        permissions: opts.permissions,
        permissionFiles: [...opts.permissionFiles],
        workspaceCwd: opts.workspaceCwd,
        ...(opts.additionalDirectories?.length ? { additionalDirectories: [...opts.additionalDirectories] } : {}),
        ...(opts.protectedPaths ? { protectedPaths: opts.protectedPaths } : {}),
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
