/**
 * Claude's permission mode, pinned to Manual.
 *
 * The Claude ACP adapter (claude-agent-acp 0.109.1, `resolveInitialPermissionMode`) starts a
 * session in Claude Code's `auto` mode whenever no `permissions.defaultMode` is set, and a
 * checkout or user settings file can start it in `acceptEdits` or `bypassPermissions`. In
 * those modes Claude Code settles calls itself, so they never reach ORCA's permission policy
 * as a `session/request_permission`: an agent without ORCA's pre-tool hook ran a Bash command
 * that ORCA's policy denied, and ORCA was never asked. ORCA's model is that Claude asks and
 * ORCA decides, so every Claude session runs in `default` (Manual, "always ask"):
 *
 * - at open, the session is switched to `default` when it starts in another mode, and refused
 *   when the adapter does not offer it or does not take it;
 * - ORCA never switches it to another mode (`setConfigOption("mode", …)` is refused);
 * - before each prompt, a session found in another mode (the agent changed it itself) is
 *   switched back, or the prompt is refused.
 *
 * The adapter is recognised by what it says at `initialize`, not by the configured command.
 */
import { OrcaError } from "@orca/core";
import type { OpenSessionOptions } from "./acp-session.js";
import { CLAUDE_ADAPTER_NAMES } from "./native-tool-hook-session.js";
import type { AgentSession } from "./session.js";
import type { SessionConfigOption } from "@orca/core";

export const CLAUDE_PINNED_MODE = "default";

type SessionMeta = NonNullable<OpenSessionOptions["sessionMeta"]>;

function modeOf(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find((o) => o.id === "mode" || o.category === "mode");
}

function offered(option: SessionConfigOption, value: string): boolean {
  if (option.type !== "select") return false;
  return option.options.some((o) =>
    "group" in o ? o.options.some((g) => g.value === value) : (o as { value: string }).value === value,
  );
}

/**
 * Notes, through the session's `sessionMeta` (wrapping the one it already has, if any),
 * whether the agent said at `initialize` that it is the Claude adapter; `guard` then pins the
 * opened session's mode.
 */
export function claudeModePin(): {
  sessionMeta(inner?: SessionMeta): SessionMeta;
  guard(session: AgentSession): Promise<AgentSession>;
} {
  let claude = false;
  return {
    sessionMeta: (inner) => async (agentInfo, ext, agentPid, signal) => {
      claude = agentInfo !== undefined && CLAUDE_ADAPTER_NAMES.includes(agentInfo.name);
      return inner ? inner(agentInfo, ext, agentPid, signal) : undefined;
    },
    guard: async (session) => {
      if (!claude) return session;
      try {
        await pinClaudeMode(session);
      } catch (error) {
        await session.close().catch(() => undefined);
        throw error;
      }
      return guardClaudeSession(session);
    },
  };
}

/** Switch the session to Manual when it is in another mode; throws when that cannot be done. */
export async function pinClaudeMode(session: AgentSession): Promise<void> {
  const mode = modeOf(session.configOptions);
  if (mode?.currentValue === CLAUDE_PINNED_MODE) return;
  const refuse = (why: string, details: Record<string, unknown> = {}) =>
    new OrcaError(
      "NOT_SUPPORTED",
      `Claude session ${why}; ORCA runs Claude only in mode '${CLAUDE_PINNED_MODE}' (Manual), where every call ` +
        `Claude Code does not settle by a rule is asked through ORCA's permission policy.`,
      { agentId: session.agentId, ...details },
    );
  if (mode === undefined) throw refuse("reports no permission mode");
  if (!offered(mode, CLAUDE_PINNED_MODE))
    throw refuse(`does not offer mode '${CLAUDE_PINNED_MODE}'`, { mode: mode.currentValue });
  const updated = modeOf(await session.setConfigOption(mode.id, CLAUDE_PINNED_MODE));
  if (updated?.currentValue !== CLAUDE_PINNED_MODE)
    throw refuse(`stayed in mode '${String(updated?.currentValue)}' when ORCA set '${CLAUDE_PINNED_MODE}'`, {
      mode: updated?.currentValue,
    });
}

/** The session with mode changes refused and the mode checked again before each prompt. */
export function guardClaudeSession(session: AgentSession): AgentSession {
  const guarded: AgentSession = Object.create(session) as AgentSession;
  // Writable, as a plain session's are: the hook path in the session factory wraps `close`.
  Object.defineProperties(guarded, {
    prompt: {
      writable: true,
      value: async (input: Parameters<AgentSession["prompt"]>[0], options?: Parameters<AgentSession["prompt"]>[1]) => {
        await pinClaudeMode(session);
        return session.prompt(input, options);
      },
    },
    setConfigOption: {
      writable: true,
      value: async (configId: string, value: string | boolean) => {
        const mode = modeOf(session.configOptions);
        if ((configId === "mode" || configId === mode?.id) && value !== CLAUDE_PINNED_MODE)
          throw new OrcaError(
            "NOT_SUPPORTED",
            `ORCA does not switch Claude to mode '${String(value)}': in it Claude Code settles calls itself, ` +
              `without ORCA's permission policy.`,
            { agentId: session.agentId, configId },
          );
        return session.setConfigOption(configId, value);
      },
    },
  });
  return guarded;
}
