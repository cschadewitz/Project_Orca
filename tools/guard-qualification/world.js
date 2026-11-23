/**
 * The world a #706 acceptance case runs in: a throwaway config directory and workspace laid
 * out the way the daemon lays them out, a workspace permission sidecar, ORCA's protected
 * paths, and the operations that change policy between two calls (an "always" answer, an
 * operator's edit, a timed grant running out, a damaged sidecar).
 *
 * Every change goes through the same functions the daemon uses (`recordAlwaysDecision`,
 * `replacePermissionPolicyFile`), never a hand-built shortcut, so a case that passes here
 * passes against what production writes. Only the deliberately damaged files are written
 * by hand.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeToolCall,
  permissionPolicyPath,
  readPermissionPolicyFile,
  recordAlwaysDecision,
  replacePermissionPolicyFile,
} from "@orca/agents";

export const AGENT_ID = "acceptance-agent";

/**
 * A tool call in provider-neutral terms. Each enforcement path turns it into what its agent
 * actually sends (a Claude `PreToolUse` frame, an ACP permission ask, …).
 *
 * @typedef {{ tool: "shell", command: string, cwd?: string }
 *   | { tool: "write", path: string, content?: string, cwd?: string }
 *   | { tool: "edit", path: string, cwd?: string }
 *   | { tool: "read", path: string, cwd?: string }
 *   | { tool: "mcp", server: string, name: string, input?: Record<string, unknown>, cwd?: string }
 *   | { tool: "unknown", name: string, input?: Record<string, unknown>, cwd?: string }} Action
 */

/** The Claude Code tool name and input for an action: the shape both Claude routes report. */
export function claudeShape(action) {
  switch (action.tool) {
    case "shell":
      return { toolName: "Bash", toolInput: { command: action.command } };
    case "write":
      return { toolName: "Write", toolInput: { file_path: action.path, content: action.content ?? "" } };
    case "edit":
      return { toolName: "Edit", toolInput: { file_path: action.path, old_string: "a", new_string: "b" } };
    case "read":
      return { toolName: "Read", toolInput: { file_path: action.path } };
    case "mcp":
      return { toolName: `mcp__${action.server}__${action.name}`, toolInput: action.input ?? {} };
    case "unknown":
      return { toolName: action.name, toolInput: action.input ?? {} };
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
}

/**
 * The ACP `session/request_permission` the Claude ACP adapter sends for an action, with the
 * three options it offers. `claudeToolCall` is the hook's copy of the adapter's reporters, so
 * one rule decides an action the same way on both routes.
 */
export function permissionRequest(world, action, options = DEFAULT_OPTIONS) {
  const { toolName, toolInput } = claudeShape(action);
  const toolCall = claudeToolCall({ toolName, toolInput, cwd: action.cwd ?? world.workspace });
  return {
    sessionId: "acceptance-session",
    toolCall: { toolCallId: `call-${++world.seq}`, ...toolCall },
    options: options.map((o) => ({ ...o })),
  };
}

export const DEFAULT_OPTIONS = Object.freeze([
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
]);

/**
 * @param {{ setNow?: (ms: number) => void, now?: () => number }} clock How a case moves time:
 *   the harness passes its fake clock so both routes, which read `Date.now`, see the move.
 */
export async function createWorld(clock = {}) {
  const root = await mkdtemp(join(tmpdir(), "orca-706-"));
  const configDir = join(root, "config");
  const workspace = join(root, "work");
  const outside = join(root, "elsewhere");
  await mkdir(join(configDir, "auth"), { recursive: true });
  await mkdir(join(configDir, ".orca"), { recursive: true });
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(configDir, "auth", "owner.token"), "owner-token-material\n");
  await writeFile(join(configDir, "orca.config.yaml"), "agents: []\n");

  const sidecar = permissionPolicyPath(configDir);
  const world = {
    root,
    configDir,
    workspace,
    outside,
    sidecar,
    seq: 0,
    agentId: AGENT_ID,
    /** The agent's configured `permissions:` block, as the session captured it at open. */
    configured: { rules: [] },
    protectedPaths: {
      readOnly: [join(configDir, "orca.config.yaml"), sidecar, join(configDir, ".orca")],
      noAccess: [join(configDir, "auth")],
    },
    /** Answers a person gave to asks that reached ORCA, in order; `undefined` cancels. */
    answers: [],
    /** Every ask that reached a person, for "who was asked" assertions. */
    asked: [],
    now: clock.now ?? Date.now,

    /** A person answers "Always allow" (or "Always reject") to this action's ask. */
    async answerAlways(action, decision = "allow", extra = {}) {
      return recordAlwaysDecision({
        file: sidecar,
        agentId: AGENT_ID,
        request: permissionRequest(world, action),
        decision,
        workspaceCwd: workspace,
        ...(extra.expiresAt ? { expiresAt: extra.expiresAt } : {}),
        now: () => new Date(world.now()),
      });
    },

    /** An operator removes every rule this agent has in the sidecar (`config.set`). */
    async revokeAll() {
      const doc = await readPermissionPolicyFile(sidecar);
      await replacePermissionPolicyFile(sidecar, { ...doc, agents: { ...doc.agents, [AGENT_ID]: { rules: [] } } });
    },

    /** An operator saves these sidecar rules for this agent, replacing what was there. */
    async setSidecarRules(rules) {
      const doc = await readPermissionPolicyFile(sidecar);
      await replacePermissionPolicyFile(sidecar, { ...doc, agents: { ...doc.agents, [AGENT_ID]: { rules } } });
    },

    /** Somebody, or something, wrote this text into the sidecar directly. */
    async writeSidecarRaw(text) {
      await writeFile(sidecar, text, "utf8");
    },

    async removeSidecar() {
      await rm(sidecar, { force: true });
    },

    /** Move the clock both routes judge rule lifetimes by. */
    advance(ms) {
      if (!clock.setNow) throw new Error("this world has no movable clock");
      clock.setNow(world.now() + ms);
    },

    /** A link inside the workspace that points at `target`. */
    async linkInWorkspace(name, target) {
      const at = join(workspace, name);
      await symlink(target, at);
      return at;
    },

    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
  return world;
}
