/**
 * The Claude `PreToolUse` hook that puts ORCA's permission policy in front of every tool call
 * (#704), not only in front of the ones Claude decides to ask about.
 *
 * ORCA decides a tool call when the agent sends ACP `session/request_permission`
 * (`resolvePermission` in `permissions.ts`). Claude Code sends that only when its own
 * permission check has no answer. Once somebody has answered "always allow" natively, Claude
 * remembers the grant and the next identical call never reaches ORCA, so a grant that ORCA
 * revoked, or a policy that changed since, does not apply to it. `PreToolUse` runs before
 * Claude's permission check on every call, remembered grant or not, which is the one place
 * ORCA can see a cached repeat.
 *
 * The hook is a command Claude Code runs per tool call. It reads the call from stdin, decides
 * it against the same layered policy the ACP ask uses (`loadEffectivePermissionPolicy`, read
 * fresh per call, so a revoked grant decides the very next call) and answers:
 *
 * - **allow**: exit 0 with no output. That is Claude's "no decision": the call goes on to
 *   Claude's own permission check, so an ORCA allow never widens what Claude would allow on
 *   its own. A call Claude would ask about still asks, and that ask still reaches ORCA.
 * - **ask**: `permissionDecision: "ask"`. Claude asks even when it remembers a grant, and the
 *   ask arrives at ORCA as `session/request_permission`, where a person or the run's answerer
 *   decides it. This is what a revoked grant turns into.
 * - **deny**: `permissionDecision: "deny"`. Nothing runs.
 * - **anything going wrong** (a frame it cannot read, a context file it cannot read, a frame
 *   over the size limit, an exception): exit 2, which Claude treats as a block. The hook
 *   never fails open on its own errors. A hook that cannot start at all is the settings'
 *   `onFailure: "block"`'s to handle (`claudePreToolHookSettings`).
 *
 * The hook is never the one that says `allow`. A `permissionDecision: "allow"` would skip
 * Claude's own permission check, and an ORCA rule must not grant more than the native policy
 * and sandbox already would.
 *
 * What the hook knows about the session comes from a context file ORCA writes when it opens
 * the session (`ClaudeHookContext`): the agent's configured rules, the sidecar files, the
 * workspace and ORCA's protected paths. The context lives with ORCA's private files and the
 * hook refuses native tool calls that touch protected paths, so the agent cannot rewrite what
 * the hook checks against through the tools the hook guards.
 *
 * Limits, said plainly: a hook is not an operating-system boundary. It sees one tool call's
 * input, not every file a shell command goes on to touch, and a command's title is matched
 * as text. The native sandbox and ORCA's protected-path rules for its own file handlers stay
 * in force beside it.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { PermissionPolicySchema, type ConfiguredPermissionPolicy, type PermissionDecision } from "@orca/core";
import {
  decidePermission,
  loadEffectivePermissionPolicy,
  protectedPathFor,
  type ProtectedPaths,
} from "./permissions.js";

/** The largest frame the hook reads. A `Write` carries the whole file, so this is generous. */
export const CLAUDE_PRE_TOOL_FRAME_LIMIT = 4 * 1024 * 1024;

/** The largest context file the hook reads. */
const CONTEXT_LIMIT = 1024 * 1024;

/** How long Claude Code gives the hook, in seconds, before `onFailure` blocks the call. */
export const CLAUDE_PRE_TOOL_TIMEOUT_SECONDS = 10;

/** What ORCA tells the hook about the session it guards. Written once, when the session opens. */
export interface ClaudeHookContext {
  version: 1;
  /** The agent whose sidecar rules apply (`agents[].id`). */
  agentId: string;
  /** The agent's configured rules, exactly as `agents[].permissions` parsed. */
  permissions: ConfiguredPermissionPolicy;
  /** The sidecar files, in layering order; read fresh on every call. */
  permissionFiles: string[];
  /** Absolute path of the run's workspace, which rules are relative to. */
  workspaceCwd: string;
  /** Other directories the session may work in. A call whose cwd is in none of these asks. */
  additionalDirectories?: string[] | undefined;
  /** ORCA's own files, which no rule opens to an agent (C4-01). */
  protectedPaths?: ProtectedPaths | undefined;
}

/** The part of Claude's `PreToolUse` input the hook decides on. */
export interface ClaudePreToolFrame {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** The directory the tool call runs in, as Claude reports it. */
  cwd: string;
  toolUseId?: string | undefined;
  sessionId?: string | undefined;
}

export type ClaudePreToolReason =
  "policy" | "protected" | "cwd-outside-workspace" | "sidecar-unreadable" | "hook-error";

export interface ClaudePreToolVerdict {
  /** The policy's answer for this call, after the hook's own checks. */
  decision: PermissionDecision;
  reason: ClaudePreToolReason;
  /** The ACP-shaped tool call the policy decided, for logging and tests. */
  toolCall: { title: string; kind: acp.ToolKind; locations: { path: string }[] };
}

/** What the hook process writes and how it exits. */
export interface ClaudePreToolHookResult {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

class HookInputError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const stringArray = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || !v.every((s): s is string => typeof s === "string"))
    throw new HookInputError(`${what} must be a list of strings`);
  return v;
};

/** Read and check a context file's JSON. Anything missing or mistyped is an error, never a default. */
export function parseClaudeHookContext(raw: unknown): ClaudeHookContext {
  if (!isRecord(raw)) throw new HookInputError("hook context must be a JSON object");
  if (raw["version"] !== 1) throw new HookInputError("hook context version is not supported");
  const agentId = raw["agentId"];
  if (typeof agentId !== "string" || agentId === "") throw new HookInputError("hook context has no agentId");
  const workspaceCwd = raw["workspaceCwd"];
  if (typeof workspaceCwd !== "string" || !isAbsolute(workspaceCwd))
    throw new HookInputError("hook context workspaceCwd must be an absolute path");
  const policy = PermissionPolicySchema.safeParse(raw["permissions"]);
  if (!policy.success) throw new HookInputError("hook context permissions are invalid");
  const permissionFiles = stringArray(raw["permissionFiles"], "permissionFiles");
  if (!permissionFiles.every((f) => isAbsolute(f)))
    throw new HookInputError("hook context permissionFiles must be absolute");
  const context: ClaudeHookContext = {
    version: 1,
    agentId,
    permissions: { rules: policy.data.rules, ...(policy.data.default ? { default: policy.data.default } : {}) },
    permissionFiles,
    workspaceCwd,
  };
  if (raw["additionalDirectories"] !== undefined)
    context.additionalDirectories = stringArray(raw["additionalDirectories"], "additionalDirectories");
  const pp = raw["protectedPaths"];
  if (pp !== undefined) {
    if (!isRecord(pp)) throw new HookInputError("hook context protectedPaths must be an object");
    context.protectedPaths = {
      readOnly: stringArray(pp["readOnly"], "protectedPaths.readOnly"),
      noAccess: stringArray(pp["noAccess"], "protectedPaths.noAccess"),
      ...(pp["agentAreas"] !== undefined
        ? { agentAreas: stringArray(pp["agentAreas"], "protectedPaths.agentAreas") }
        : {}),
    };
  }
  return context;
}

/** Read Claude's `PreToolUse` stdin. Only a well-formed `PreToolUse` frame is accepted. */
export function parseClaudePreToolFrame(text: string): ClaudePreToolFrame {
  if (Buffer.byteLength(text, "utf8") > CLAUDE_PRE_TOOL_FRAME_LIMIT)
    throw new HookInputError("tool call is too large to check");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HookInputError("tool call input is not JSON");
  }
  if (!isRecord(raw)) throw new HookInputError("tool call input is not a JSON object");
  if (raw["hook_event_name"] !== "PreToolUse") throw new HookInputError("not a PreToolUse event");
  const toolName = raw["tool_name"];
  if (typeof toolName !== "string" || toolName === "") throw new HookInputError("tool call has no tool_name");
  const toolInput = raw["tool_input"];
  if (!isRecord(toolInput)) throw new HookInputError("tool call has no tool_input object");
  const cwd = raw["cwd"];
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new HookInputError("tool call has no absolute cwd");
  const frame: ClaudePreToolFrame = { toolName, toolInput, cwd };
  if (typeof raw["tool_use_id"] === "string") frame.toolUseId = raw["tool_use_id"];
  if (typeof raw["session_id"] === "string") frame.sessionId = raw["session_id"];
  return frame;
}

const str = (input: Record<string, unknown>, key: string): string | undefined => {
  const v = input[key];
  return typeof v === "string" && v !== "" ? v : undefined;
};

/** `mcp__<server>__<tool>`, split the way the Claude ACP adapter splits it. */
function mcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return undefined;
  const tool = rest.slice(sep + 2);
  return tool ? { server: rest.slice(0, sep), tool } : undefined;
}

/**
 * The tool call as an ACP `session/request_permission` would describe it, so that one rule
 * decides a call the same way whether it arrives as an ask or through the hook.
 *
 * The kinds, the titles a rule can match (`execute`'s command, a fetch's URL, an MCP tool's
 * `server: tool`) and the locations follow the Claude ACP adapter's tool reporters. Titles
 * the adapter only shows to people (a read's line range, a search's flags) are kept close,
 * but no ORCA-written rule matches them: ORCA scopes those grants by path. A tool this does
 * not know is `other`, which the default policy asks about.
 */
export function claudeToolCall(frame: ClaudePreToolFrame): ClaudePreToolVerdict["toolCall"] {
  const input = frame.toolInput;
  const at = (p: string | undefined) => (p === undefined ? [] : [{ path: isAbsolute(p) ? p : resolve(frame.cwd, p) }]);
  switch (frame.toolName) {
    case "Bash":
    case "PowerShell":
      return { title: str(input, "command") ?? "Terminal", kind: "execute", locations: [] };
    case "Read": {
      const p = str(input, "file_path");
      return { title: p ? `Read ${p}` : "Read File", kind: "read", locations: at(p) };
    }
    case "Write": {
      const p = str(input, "file_path");
      return { title: p ? `Write ${p}` : "Write", kind: "edit", locations: at(p) };
    }
    case "Edit":
    case "MultiEdit": {
      const p = str(input, "file_path");
      return { title: p ? `Edit ${p}` : "Edit", kind: "edit", locations: at(p) };
    }
    case "NotebookEdit": {
      const p = str(input, "notebook_path");
      return { title: p ? `Edit notebook ${p}` : "Edit notebook", kind: "edit", locations: at(p) };
    }
    case "Glob": {
      const p = str(input, "path");
      const pattern = str(input, "pattern");
      return {
        title: ["Find", p, pattern].filter((s) => s !== undefined).join(" "),
        kind: "search",
        locations: at(p ?? frame.cwd),
      };
    }
    case "Grep": {
      const p = str(input, "path");
      const pattern = str(input, "pattern");
      return {
        title: ["grep", pattern === undefined ? undefined : `"${pattern}"`, p].filter((s) => s !== undefined).join(" "),
        kind: "search",
        locations: at(p ?? frame.cwd),
      };
    }
    case "WebFetch": {
      const url = str(input, "url");
      return { title: url ? `Fetch ${url}` : "Fetch", kind: "fetch", locations: [] };
    }
    case "WebSearch": {
      const q = str(input, "query");
      return { title: q ? `Search "${q}"` : "Web search", kind: "fetch", locations: [] };
    }
    case "Agent":
    case "Task":
      return { title: str(input, "description") ?? "Task", kind: "think", locations: [] };
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return { title: frame.toolName, kind: "think", locations: [] };
    default: {
      const mcp = mcpToolName(frame.toolName);
      return { title: mcp ? `${mcp.server}: ${mcp.tool}` : frame.toolName, kind: "other", locations: [] };
    }
  }
}

/** Whether `dir` is `root` or below it, compared as the file system resolves both. */
function inside(dir: string, root: string): boolean {
  // `protectedPathFor` already compares physically and segment by segment; reuse it.
  return protectedPathFor(dir, "read", { readOnly: [], noAccess: [root] }) !== undefined;
}

/**
 * Decide one tool call. Never throws for a policy reason; it throws only when the context or
 * the files it names cannot be read in a way that leaves no safe answer, and the hook turns
 * that into a block.
 */
export async function checkClaudePreTool(
  context: ClaudeHookContext,
  frame: ClaudePreToolFrame,
): Promise<ClaudePreToolVerdict> {
  const toolCall = claudeToolCall(frame);
  const request: acp.RequestPermissionRequest = {
    sessionId: frame.sessionId ?? "",
    toolCall: { toolCallId: frame.toolUseId ?? "", ...toolCall },
    options: [],
  };
  const scope = {
    workspaceCwd: context.workspaceCwd,
    ...(context.protectedPaths ? { protectedPaths: context.protectedPaths } : {}),
  };

  // ORCA's own files first: nothing below reaches them, the same order `resolvePermission` uses.
  const access =
    toolCall.kind === "read" || toolCall.kind === "search"
      ? "read"
      : toolCall.kind === "delete" || toolCall.kind === "move"
        ? "remove"
        : "write";
  if (toolCall.locations.some((l) => protectedPathFor(l.path, access, context.protectedPaths, context.workspaceCwd)))
    return { decision: "deny", reason: "protected", toolCall };

  let unreadable = false;
  const policy = await loadEffectivePermissionPolicy(
    { id: context.agentId, permissions: context.permissions },
    context.permissionFiles,
    () => {
      unreadable = true;
    },
  );
  const decision = decidePermission(policy, request, scope);
  if (decision !== "allow") return { decision, reason: unreadable ? "sidecar-unreadable" : "policy", toolCall };

  // A rule is relative to the workspace; a call running somewhere else is not the call it granted.
  const roots = [context.workspaceCwd, ...(context.additionalDirectories ?? [])];
  if (!roots.some((root) => inside(frame.cwd, root)))
    return { decision: "ask", reason: "cwd-outside-workspace", toolCall };
  return { decision, reason: "policy", toolCall };
}

const REASON_TEXT: Record<ClaudePreToolReason, string> = {
  policy: "ORCA's permission policy",
  protected: "the call touches ORCA's own files, which no rule opens to an agent",
  "cwd-outside-workspace": "the call runs outside the run's workspace, so no workspace grant covers it",
  "sidecar-unreadable": "ORCA's permission sidecar could not be read, so its grants are not assumed",
  "hook-error": "ORCA could not check this call",
};

/** How the hook answers Claude Code for a verdict. */
export function claudePreToolHookOutput(verdict: ClaudePreToolVerdict): ClaudePreToolHookResult {
  if (verdict.decision === "allow") return { exitCode: 0, stdout: "", stderr: "" };
  const reason =
    verdict.decision === "deny"
      ? `Denied by ORCA: ${REASON_TEXT[verdict.reason]}.`
      : `ORCA asks first: ${REASON_TEXT[verdict.reason]}.`;
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.decision,
        permissionDecisionReason: reason,
      },
    })}\n`,
    stderr: "",
  };
}

/** The answer for a hook that could not decide: exit 2, which Claude Code treats as a block. */
export function claudePreToolHookFailure(error: unknown): ClaudePreToolHookResult {
  const detail = error instanceof HookInputError ? error.message : "internal error";
  return { exitCode: 2, stdout: "", stderr: `Blocked by ORCA: ${REASON_TEXT["hook-error"]} (${detail}).\n` };
}

/**
 * Run the hook once: `args` is `[contextFile]`, `input` is Claude's stdin. Every failure is a
 * block. This is the whole of the hook process (`bin/claude-pre-tool-hook.ts`), kept here so
 * it is tested without spawning anything.
 */
export async function runClaudePreToolHook(args: readonly string[], input: string): Promise<ClaudePreToolHookResult> {
  try {
    const file = args[0];
    if (args.length !== 1 || file === undefined || !isAbsolute(file))
      throw new HookInputError("the hook takes one argument, the absolute path of its context file");
    const text = await readFile(file, "utf8").catch(() => {
      throw new HookInputError("hook context file cannot be read");
    });
    if (Buffer.byteLength(text, "utf8") > CONTEXT_LIMIT) throw new HookInputError("hook context file is too large");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HookInputError("hook context file is not JSON");
    }
    const context = parseClaudeHookContext(raw);
    const frame = parseClaudePreToolFrame(input);
    return claudePreToolHookOutput(await checkClaudePreTool(context, frame));
  } catch (error) {
    return claudePreToolHookFailure(error);
  }
}

/** How Claude Code should run the hook: an executable and its arguments, never a shell line. */
export interface ClaudePreToolHookCommand {
  /** Absolute path of the executable, normally the Node binary. */
  command: string;
  /** Its arguments, normally the hook script and the context file, both absolute. */
  args: string[];
  timeoutSeconds?: number | undefined;
}

/**
 * The Claude settings that install the hook: one `PreToolUse` matcher for every tool, run in
 * exec form (`command` + `args`, no shell), and `onFailure: "block"` so that a hook that
 * cannot start, times out or answers garbage blocks the call instead of letting it through.
 *
 * It goes in the programmatic settings tier of the session (the Claude ACP adapter's
 * `_meta.claudeCode.options.settings`), as an object: a string there is read as a file
 * relative to the session's cwd, which the agent can write.
 */
export function claudePreToolHookSettings(hook: ClaudePreToolHookCommand): Record<string, unknown> {
  if (!isAbsolute(hook.command) || !hook.args.every((a) => a !== ""))
    throw new Error("the hook command must be an absolute path");
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: hook.command,
              args: [...hook.args],
              timeout: hook.timeoutSeconds ?? CLAUDE_PRE_TOOL_TIMEOUT_SECONDS,
              onFailure: "block",
            },
          ],
        },
      ],
    },
  };
}
