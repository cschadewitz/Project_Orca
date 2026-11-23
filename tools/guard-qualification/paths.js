/**
 * The enforcement paths the #706 suite runs its cases against. A path takes a provider-neutral
 * action (`world.js`), sends it through ORCA's real code exactly as that route receives it,
 * and reports one outcome:
 *
 * - `allow`: ORCA lets the call go on. On a hook route that means "no objection": the agent's
 *   own permission check and sandbox still run after it.
 * - `ask`: ORCA puts the call to a person (or, with nobody to ask, does not run it).
 * - `deny`: ORCA refuses it.
 * - `block`: ORCA could not decide and the call does not run.
 *
 * `mcp-grant-allows`: on this route an "always allow" for an MCP tool can allow that tool's
 * next call. Not on a route where ORCA cannot verify which server a call is for (Gemini,
 * #1021): there every MCP call is asked unless a rule denies it.
 *
 * `surfaces` are the strings the route's answer hands back to the agent, which the privacy cases
 * search for leaked input. Events, logs and stored records are not surfaces here and are not
 * checked by this suite.
 *
 * `capabilities` say which kinds of case a path can be asked about at all. A case that needs a
 * capability a path lacks must be excluded for that path in `support-matrix.json`, with the
 * reason: the matrix, not the suite, is where "not covered" is said out loud.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  claudePreToolHookSettings,
  loadEffectivePermissionPolicy,
  resolvePermission,
  runClaudePreToolHook,
} from "@orca/agents";
import { claudeShape, permissionRequest } from "./world.js";

/**
 * ORCA's own answer to an ACP permission ask, through `resolvePermission` (`acp-session.ts`).
 * Verifies the answer to an ask that reaches ORCA; not that the agent asks, or obeys.
 */
export const acpAsk = {
  id: "acp-ask",
  capabilities: ["answerer", "offered-options", "mcp-grant-allows"],

  async decide(world, action, opts = {}) {
    const request = permissionRequest(world, action, opts.options);
    // `openAcpSession` reads the policy fresh for every ask, a damaged sidecar reported, not thrown.
    const policy = await loadEffectivePermissionPolicy(
      { id: world.agentId, permissions: world.configured },
      [world.sidecar],
      () => {},
    );
    const answerer = opts.noAnswerer
      ? undefined
      : async (req) => {
          world.asked.push(req.toolCall.title);
          if (opts.onAsk) return opts.onAsk(req);
          return world.answers.shift();
        };
    const { response, decision } = await resolvePermission(policy, {
      request,
      scope: { workspaceCwd: world.workspace, protectedPaths: world.protectedPaths },
      ...(answerer ? { ask: answerer } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { outcome: acpOutcome(decision), detail: decision, response, surfaces: [decision] };
  },
};

function acpOutcome(decision) {
  if (decision === "allow") return "allow";
  if (decision.startsWith("deny")) return "deny";
  if (decision.startsWith("ask:")) return "ask";
  return "block";
}

/**
 * ORCA's Claude `PreToolUse` hook (#704), run as its process runs it (`runClaudePreToolHook`).
 * Verifies the hook program's answer to a frame; not that Claude runs it, obeys it, or sends
 * its `ask` on to ORCA for the same call.
 */
export const claudeNativeHook = {
  id: "claude-native-hook",
  capabilities: ["raw-input", "context-file", "cwd", "hook-settings", "mcp-grant-allows"],

  /** Where the session's hook context lives: inside ORCA's read-only `.orca` area. */
  contextFile(world) {
    return join(world.configDir, ".orca", "hook-context.json");
  },

  /** What ORCA writes when it opens the session; written once, like the session does. */
  async open(world) {
    if (world.hookContextWritten) return;
    await mkdir(join(world.configDir, ".orca"), { recursive: true });
    await writeFile(
      claudeNativeHook.contextFile(world),
      JSON.stringify({
        version: 1,
        agentId: world.agentId,
        permissions: world.configured,
        permissionFiles: [world.sidecar],
        workspaceCwd: world.workspace,
        protectedPaths: world.protectedPaths,
      }),
    );
    world.hookContextWritten = true;
  },

  frame(world, action) {
    const { toolName, toolInput } = claudeShape(action);
    return JSON.stringify({
      session_id: "acceptance-session",
      transcript_path: "/dev/null",
      cwd: action.cwd ?? world.workspace,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: `toolu_${++world.seq}`,
    });
  },

  async decide(world, action) {
    await claudeNativeHook.open(world);
    return claudeNativeHook.decideRaw(world, claudeNativeHook.frame(world, action));
  },

  /** Send the hook exactly these stdin bytes, with these arguments. */
  async decideRaw(world, input, args) {
    await claudeNativeHook.open(world);
    const result = await runClaudePreToolHook(args ?? [claudeNativeHook.contextFile(world)], input);
    return { outcome: hookOutcome(result), detail: result, surfaces: [result.stdout, result.stderr] };
  },

  settings() {
    return claudePreToolHookSettings({
      command: "/usr/bin/node",
      args: ["/opt/orca/claude-pre-tool-hook.js", "/var/orca/hook-context.json"],
    });
  },
};

function hookOutcome(result) {
  if (result.exitCode !== 0) return "block";
  if (result.stdout === "") return "allow";
  const decision = JSON.parse(result.stdout)?.hookSpecificOutput?.permissionDecision;
  // The hook never answers `allow` (it would skip Claude's own check): anything else is a defect
  // the case must see, not a block to be counted as safe.
  return decision === "ask" || decision === "deny" ? decision : `invalid:${String(decision)}`;
}

/* ------------------------------- Gemini CLI 0.70.0 (#705) ------------------------------- */

/** The options Gemini CLI 0.70.0 offers on an ask (`toPermissionOptions`), by the call's type. */
const GEMINI_ONCE = [
  { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
  { optionId: "cancel", name: "Reject", kind: "reject_once" },
];
const geminiOptions = (action) =>
  action.tool === "mcp"
    ? [
        { optionId: "proceed_always_server", name: "Allow all server tools for this session", kind: "allow_always" },
        { optionId: "proceed_always_tool", name: "Allow tool for this session", kind: "allow_always" },
        ...GEMINI_ONCE,
      ]
    : [{ optionId: "proceed_always", name: "Allow for this session", kind: "allow_always" }, ...GEMINI_ONCE];

/** Gemini's title for an MCP call at 0.70.0 (`formatToolDisplayTitle`, `formatToolDescription`). */
export function geminiMcpTitle(server, tool, input = {}) {
  if (typeof input.command === "string" && input.command.trim() !== "") return input.command;
  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return `${tool} (${server} MCP Server)`;
  const value = (v) => (typeof v === "string" ? v : JSON.stringify(v));
  return `${tool}(${entries.map(([k, v]) => `${k}: ${value(v)}`).join(", ")})`;
}

/**
 * The `session/request_permission` Gemini CLI 0.70.0 sends for an action, as its ACP session
 * builds it (read in its source at the pinned version, and matching the asks
 * `gemini-acp-acceptance-705.test.ts` records): no `rawInput`, the tool's display title, the
 * tool's own locations, and for MCP the server and tool only in `_meta`. Paths are resolved
 * against the workspace as text; Gemini may resolve links first, which only brings the
 * location closer to the file ORCA checks physically anyway.
 */
export function geminiPermissionRequest(world, action, options = geminiOptions(action)) {
  const at = (p) => resolve(world.workspace, p);
  const rel = (p) => relative(world.workspace, at(p)) || ".";
  let toolCall;
  switch (action.tool) {
    case "shell":
      toolCall = { title: action.command, kind: "execute", locations: [] };
      break;
    case "write":
      toolCall = { title: `Writing to ${rel(action.path)}`, kind: "edit", locations: [{ path: at(action.path) }] };
      break;
    case "edit":
      toolCall = { title: `${rel(action.path)}: a => b`, kind: "edit", locations: [{ path: at(action.path) }] };
      break;
    case "read":
      toolCall = { title: rel(action.path), kind: "read", locations: [{ path: at(action.path) }] };
      break;
    case "mcp":
      toolCall = {
        title: geminiMcpTitle(action.server, action.name, action.input),
        kind: "other",
        locations: [],
        _meta: { "gemini-cli": { mcp: { server_name: action.server, tool_name: action.name } } },
      };
      break;
    case "unknown":
      // Gemini asks only about tools in its registry; a name it does not know never reaches
      // ORCA. This is what ORCA would answer if one did, reported as Gemini reports "other".
      toolCall = { title: action.name, kind: "other", locations: [] };
      break;
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
  return {
    sessionId: "acceptance-session",
    toolCall: { toolCallId: `call-${++world.seq}`, status: "pending", ...toolCall },
    options: options.map((o) => ({ ...o })),
  };
}

/**
 * ORCA's answer, through `resolvePermission`, to an ask shaped as Gemini CLI 0.70.0 sends it.
 * ORCA installs no hook in Gemini, so this is the only route by which ORCA decides a Gemini
 * call. Verifies ORCA's answer to such an ask; not that Gemini asks (its read-only tools never
 * do, observed), nor that it obeys.
 */
export const geminiAcpAsk = {
  id: "gemini-acp-ask",
  capabilities: ["answerer"],
  /** How this route's agent asks, so `world.answerAlways` records from the same ask. */
  request: geminiPermissionRequest,

  async decide(world, action, opts = {}) {
    const request = geminiPermissionRequest(world, action, opts.options);
    const policy = await loadEffectivePermissionPolicy(
      { id: world.agentId, permissions: world.configured },
      [world.sidecar],
      () => {},
    );
    const answerer = opts.noAnswerer
      ? undefined
      : async (req) => {
          world.asked.push(req.toolCall.title);
          if (opts.onAsk) return opts.onAsk(req);
          return world.answers.shift();
        };
    const { response, decision } = await resolvePermission(policy, {
      request,
      scope: { workspaceCwd: world.workspace, protectedPaths: world.protectedPaths },
      ...(answerer ? { ask: answerer } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { outcome: acpOutcome(decision), detail: decision, response, surfaces: [decision] };
  },
};

/* --------------------------- Codex 0.171.0 through codex-acp (#705) --------------------------- */

/** A patch in Codex's `apply_patch` format that adds or updates one file. */
function codexPatch(op, path, content = "") {
  const body = op === "add" ? content.split("\n").map((l) => `+${l}`) : ["@@", "-a", "+b"];
  const header = `*** ${op === "add" ? "Add" : "Update"} File: ${path}`;
  return ["*** Begin Patch", header, ...body, "*** End Patch"].join("\n");
}

/** The tool name and input Codex 0.171.0 hands a `PreToolUse` hook for an action. */
function codexShape(action) {
  switch (action.tool) {
    case "shell":
      return { toolName: "Bash", toolInput: { command: action.command } };
    case "write":
      return { toolName: "apply_patch", toolInput: { command: codexPatch("add", action.path, action.content) } };
    case "edit":
      return { toolName: "apply_patch", toolInput: { command: codexPatch("update", action.path) } };
    case "read":
      // Codex reads files through its shell; the one read tool it hooks by name is `view_image`.
      return { toolName: "view_image", toolInput: { path: action.path } };
    case "mcp":
      return { toolName: `mcp__${action.server}__${action.name}`, toolInput: action.input ?? {} };
    case "unknown":
      return { toolName: action.name, toolInput: action.input ?? {} };
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
}

/**
 * ORCA's Codex `PreToolUse` hook (#705), run as its process runs it (`runClaudePreToolHook`
 * after `--codex`). Codex 0.171.0 blocks a call only on exit 2, so the hook answers every
 * decision but allow with exit 2 and a fixed reason whose first words say which decision it
 * was; an ask is blocked, since Codex cannot pause a call for a person. Verifies the hook
 * program's answer to a frame; not that Codex runs it, trusts it or blocks on it (Codex lets a
 * call through when its hook runner fails), and the session's startup probe is not run here.
 */
export const codexNativeHook = {
  id: "codex-native-hook",
  capabilities: ["raw-input", "context-file", "cwd", "mcp-grant-allows"],

  contextFile(world) {
    return claudeNativeHook.contextFile(world);
  },

  /** The same context file ORCA writes for either agent's hook. */
  async open(world) {
    return claudeNativeHook.open(world);
  },

  frame(world, action) {
    const { toolName, toolInput } = codexShape(action);
    return JSON.stringify({
      session_id: "acceptance-session",
      transcript_path: null,
      cwd: action.cwd ?? world.workspace,
      hook_event_name: "PreToolUse",
      model: "acceptance-model",
      permission_mode: "bypassPermissions",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: `call_${++world.seq}`,
    });
  },

  async decide(world, action) {
    await codexNativeHook.open(world);
    return codexNativeHook.decideRaw(world, codexNativeHook.frame(world, action));
  },

  /** Send the hook exactly these stdin bytes; `args` are the ones after `--codex`. */
  async decideRaw(world, input, args) {
    await codexNativeHook.open(world);
    const result = await runClaudePreToolHook(["--codex", ...(args ?? [codexNativeHook.contextFile(world)])], input);
    return { outcome: codexHookOutcome(result), detail: result, surfaces: [result.stdout, result.stderr] };
  },
};

function codexHookOutcome(result) {
  if (result.exitCode === 0)
    return result.stdout === "" && result.stderr === "" ? "allow" : "invalid:exit-0-with-output";
  // Codex blocks only on exit 2 with a reason on stderr; any other refusal would let it run.
  if (result.exitCode !== 2) return `invalid:exit-${String(result.exitCode)}`;
  if (result.stdout !== "") return "invalid:stdout";
  if (result.stderr.startsWith("Denied by ORCA: ")) return "deny";
  if (result.stderr.startsWith("Blocked by ORCA: its policy asks a person first")) return "ask";
  if (result.stderr.startsWith("Blocked by ORCA: ")) return "block";
  return "invalid:unrecognised-stderr";
}

export const PATHS = [acpAsk, claudeNativeHook, geminiAcpAsk, codexNativeHook];
