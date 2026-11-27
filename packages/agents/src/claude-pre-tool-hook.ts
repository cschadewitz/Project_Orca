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
import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, sep } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  HOOK_TELEMETRY_LINE_VERSION,
  PermissionPolicySchema,
  type ConfiguredPermissionPolicy,
  type HookTelemetryLine,
  type PermissionDecision,
  type PermissionPolicy,
} from "@orca/core";
import type { PolicyCall } from "./policy-call.js";
import { fitHookTelemetryLine, type HookTelemetryTarget } from "./hook-telemetry.js";
import {
  decidePermission,
  existingDirectoryWithin,
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
  /**
   * The key the hook signs its startup-probe receipt with (#705), 32 random bytes as hex. It
   * lives only here, in a file no agent may read, so a receipt that verifies shows ORCA that
   * whatever answered the probe could read this context and blocked the probe's call. It does
   * not tell ORCA's hook apart from another process under the same OS account.
   */
  probeKey?: string | undefined;
  /**
   * Where the hook records what it decided (#1000), when the agent keeps tool-call telemetry
   * (`diagnostics.toolCalls: keep`): the spool ORCA made beside this context file, and the
   * device and inode it made it with. Absent, the hook records nothing.
   */
  telemetry?: HookTelemetryTarget | undefined;
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
  /**
   * The telemetry line to record once the answer is out (#1000), and where. Only a
   * `runClaudePreToolHook` whose context carries `telemetry` sets it; the hook program writes
   * it after answering and ignores whether that worked.
   */
  telemetry?: { target: HookTelemetryTarget; line: HookTelemetryLine } | undefined;
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
  const probeKey = raw["probeKey"];
  if (probeKey !== undefined) {
    if (typeof probeKey !== "string" || !/^[0-9a-f]{64}$/.test(probeKey))
      throw new HookInputError("hook context probeKey must be 64 hex digits");
    context.probeKey = probeKey;
  }
  const telemetry = raw["telemetry"];
  if (telemetry !== undefined) {
    const file = isRecord(telemetry) ? telemetry["file"] : undefined;
    const dev = isRecord(telemetry) ? telemetry["dev"] : undefined;
    const ino = isRecord(telemetry) ? telemetry["ino"] : undefined;
    if (
      typeof file !== "string" ||
      !isAbsolute(file) ||
      typeof dev !== "string" ||
      !/^\d{1,40}$/.test(dev) ||
      typeof ino !== "string" ||
      !/^\d{1,40}$/.test(ino)
    )
      throw new HookInputError("hook context telemetry must name an absolute file, its device and its inode");
    context.telemetry = { file, dev, ino };
  }
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

/** Unicode White_Space, the set Rust's `str::trim` strips (unlike JS `trim`: NEL in, BOM out). */
const RUST_WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/**
 * Rust's `str::trim`, which Codex's patch parser uses. Index scans from both ends, so the time
 * is linear in the line however much whitespace it holds (a patch is agent-written input).
 */
function rustTrim(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && RUST_WHITE_SPACE.has(line.charCodeAt(start))) start++;
  while (end > start && RUST_WHITE_SPACE.has(line.charCodeAt(end - 1))) end--;
  return line.slice(start, end);
}

/**
 * The files a Codex `apply_patch` touches (#705), read from its file headers the way Codex
 * 0.171's parser (`codex-rs/apply-patch`) reads them: each line trimmed, then matched by
 * prefix. Any line that could be a header counts, so a context line that happens to look
 * like one adds a location rather than hiding one. A patch that picks another environment
 * (`*** Environment ID:`) runs somewhere the call's cwd says nothing about, so it is not
 * decided here at all: the hook blocks it.
 */
export function codexPatchFiles(patch: string): { op: "add" | "update" | "delete" | "move"; path: string }[] {
  const headers = [
    ["*** Add File: ", "add"],
    ["*** Update File: ", "update"],
    ["*** Delete File: ", "delete"],
    ["*** Move to: ", "move"],
  ] as const;
  const ops: { op: "add" | "update" | "delete" | "move"; path: string }[] = [];
  for (const raw of patch.split("\n")) {
    const line = rustTrim(raw);
    if (line.startsWith("*** Environment ID:"))
      throw new HookInputError("the patch names another environment, which the hook cannot check");
    for (const [prefix, op] of headers)
      if (line.startsWith(prefix) && line.length > prefix.length) ops.push({ op, path: line.slice(prefix.length) });
  }
  return ops;
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
  // A relative path is joined to the call's cwd as text, never folded with `resolve`: folding
  // `link/..` before the link is followed names a different file from the one the tool opens,
  // and `protectedPathFor` resolves the components physically, in order, as the open would.
  const at = (p: string | undefined) =>
    p === undefined ? [] : [{ path: isAbsolute(p) ? p : `${frame.cwd}${sep}${p}` }];
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
    // Codex (#705) reports its shell as `Bash` above, and these two by their own names.
    case "apply_patch": {
      const ops = codexPatchFiles(str(input, "command") ?? "");
      const kind: acp.ToolKind = ops.some((o) => o.op === "delete")
        ? "delete"
        : ops.some((o) => o.op === "move")
          ? "move"
          : "edit";
      const paths = [...new Set(ops.map((o) => o.path))];
      return { title: paths.length ? `Edit ${paths.join(", ")}` : "Edit", kind, locations: paths.flatMap(at) };
    }
    case "view_image": {
      const p = str(input, "path");
      return { title: p ? `Read ${p}` : "Read File", kind: "read", locations: at(p) };
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

/**
 * A Claude tool call as the policy reads it (#1119), from the tool's name and input the way
 * the Claude Agent SDK hands them to `canUseTool` or a hook: `claudeToolCall`'s kind, title and
 * locations, with the input and the tool's own name kept as an ACP ask's `rawInput` would keep
 * them. One rule then decides a call the same way on the ACP route and the SDK route.
 */
export function claudeToolPolicyCall(frame: ClaudePreToolFrame): PolicyCall {
  const toolCall = claudeToolCall(frame);
  return {
    title: toolCall.title,
    kind: toolCall.kind,
    input: frame.toolInput,
    locations: toolCall.locations.map((l) => l.path),
    toolName: frame.toolName,
  };
}

/** Whether `dir` is `root` or below it, compared as the file system resolves both. */
function inside(dir: string, root: string): boolean {
  // Not `protectedPathFor`: there a path it cannot resolve counts as protected, which here would
  // mean "inside" (#706 review). This check proves both are existing directories, or says no.
  return existingDirectoryWithin(dir, root);
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
  return checkPreToolCall(context, claudeToolCall(frame), frame);
}

/** Where a call that is already in ACP shape runs, and the ids it is recorded under. */
export interface PreToolCallSite {
  /** The directory the call runs in. A relative location is read against it. */
  cwd: string;
  toolUseId?: string | undefined;
  sessionId?: string | undefined;
}

/**
 * Decide a call that is already in ACP shape: `checkClaudePreTool` without the reading of a
 * hook frame. ORCA's gate in Codex's executor path (#1026, `codex-exec-gate-policy.ts`) builds
 * its calls from the executor request itself and decides them here, so one rule answers a call
 * the same way whether it arrives as an ask, through the hook or at the gate.
 *
 * `narrow` sees the policy as loaded, before it decides, and returns the policy to decide by.
 * It may only take grants away.
 */
export async function checkPreToolCall(
  context: ClaudeHookContext,
  toolCall: ClaudePreToolVerdict["toolCall"],
  site: PreToolCallSite,
  narrow?: (policy: PermissionPolicy) => PermissionPolicy,
): Promise<ClaudePreToolVerdict> {
  // The neutral call the policy decides (#1119): what an ACP ask for this call would carry.
  const call: PolicyCall = {
    title: toolCall.title,
    kind: toolCall.kind,
    locations: toolCall.locations.map((l) => l.path),
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
  if (toolCall.locations.some((l) => protectedPathFor(l.path, access, context.protectedPaths, site.cwd)))
    return { decision: "deny", reason: "protected", toolCall };

  let unreadable = false;
  const loaded = await loadEffectivePermissionPolicy(
    { id: context.agentId, permissions: context.permissions },
    context.permissionFiles,
    () => {
      unreadable = true;
    },
  );
  const policy = narrow ? narrow(loaded) : loaded;
  const decision = decidePermission(policy, call, scope);
  if (decision !== "allow") return { decision, reason: unreadable ? "sidecar-unreadable" : "policy", toolCall };

  // A rule is relative to the workspace; a call running somewhere else is not the call it granted.
  const roots = [context.workspaceCwd, ...(context.additionalDirectories ?? [])];
  if (!roots.some((root) => inside(site.cwd, root)))
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

/**
 * How the hook answers Codex for a verdict (#705). Codex 0.171 blocks a call only on a
 * `deny` or on exit 2; an `ask`, an `allow`, exit 1 and output it cannot read all let the
 * call run. So every answer but allow is exit 2 with the reason on stderr, which Codex blocks
 * on whatever else is on stdout (a login shell's profile can print there), and an `ask`
 * blocks too: Codex cannot pause a call for a person from a hook, and an ask that runs the
 * call would be an allow. Allow is exit 0 and nothing else, as for Claude: Codex's own
 * approval and sandbox still apply to the call.
 */
export function codexPreToolHookOutput(verdict: ClaudePreToolVerdict): ClaudePreToolHookResult {
  if (verdict.decision === "allow") return { exitCode: 0, stdout: "", stderr: "" };
  const reason =
    verdict.decision === "deny"
      ? `Denied by ORCA: ${REASON_TEXT[verdict.reason]}.`
      : `Blocked by ORCA: its policy asks a person first (${REASON_TEXT[verdict.reason]}), and Codex cannot pause a call for that, so it does not run. A rule in ORCA can allow it.`;
  return { exitCode: 2, stdout: "", stderr: `${reason}\n` };
}

/**
 * ORCA's startup probe of the Codex hook (#705) sends a frame with this tool-use id: a fixed
 * prefix and a fresh nonce. Codex makes its own ids; this one only matters with a `probeKey`.
 */
export const CODEX_PROBE_TOOL_USE_ID = /^orca-hook-probe:([0-9a-f]{32})$/;

/**
 * The receipt line the hook adds to its stderr when it blocks the probe's call: an HMAC, under
 * the context's `probeKey`, of the block and the probe's nonce: evidence that the answer came
 * from something holding this session's context and that it blocked that very frame, not
 * proof of which program it was (the OS account is the boundary). The hook adds it only to a
 * decided block: a hook that fails, or allows, writes none.
 */
export function codexProbeReceipt(probeKey: string, nonce: string): string {
  const mac = createHmac("sha256", Buffer.from(probeKey, "hex")).update(`orca-hook-probe-block:${nonce}`).digest("hex");
  return `orca-hook-receipt: ${mac}`;
}

/** Which agent the hook answers, as its command line says (`--codex` before the context file). */
export type PreToolHookDialect = "claude" | "codex";

/** The answer for a hook that could not decide: exit 2, which Claude Code treats as a block. */
export function claudePreToolHookFailure(error: unknown): ClaudePreToolHookResult {
  const detail = error instanceof HookInputError ? error.message : "internal error";
  return { exitCode: 2, stdout: "", stderr: `Blocked by ORCA: ${REASON_TEXT["hook-error"]} (${detail}).\n` };
}

/**
 * Run the hook once: `args` is `[contextFile]` for Claude or `["--codex", contextFile]` for
 * Codex (#705), `input` is the agent's stdin. Every failure is a block (exit 2, which both
 * agents block on). This is the whole of the hook process (`bin/claude-pre-tool-hook.ts`),
 * kept here so it is tested without spawning anything.
 */
export async function runClaudePreToolHook(
  args: readonly string[],
  input: string,
  /** For tests only: how the telemetry line is built. */
  testing: { telemetryLine?: typeof preToolTelemetryLine } = {},
): Promise<ClaudePreToolHookResult> {
  const started = performance.now();
  const at = new Date().toISOString();
  const seen: { target?: HookTelemetryTarget; frame?: ClaudePreToolFrame } = {};
  let out: ClaudePreToolHookResult;
  /** What the line records; undefined for ORCA's own Codex probe, which records nothing. */
  let decided: { verdict: ClaudePreToolVerdict } | { error: unknown } | undefined;
  try {
    const result = await decideClaudePreTool(args, input, seen);
    out = result.out;
    decided = result.verdict === undefined ? undefined : { verdict: result.verdict };
  } catch (error) {
    out = claudePreToolHookFailure(error);
    decided = { error };
  }
  // The answer is settled. Recording is added beside it and can never replace it: anything
  // that goes wrong while building the line drops the line, never the answer.
  if (seen.target === undefined || decided === undefined) return out;
  try {
    const line = fitHookTelemetryLine(
      (testing.telemetryLine ?? preToolTelemetryLine)(
        seen.frame,
        decided,
        at,
        Math.max(0, performance.now() - started),
      ),
    );
    return line === undefined ? out : { ...out, telemetry: { target: seen.target, line } };
  } catch {
    return out;
  }
}

/**
 * Decide one call; `seen` collects the spool target and the frame as they are read, for the
 * telemetry line. `verdict` is undefined for ORCA's own Codex startup probe, which is not one
 * of the agent's calls and is not recorded.
 */
async function decideClaudePreTool(
  args: readonly string[],
  input: string,
  seen: { target?: HookTelemetryTarget; frame?: ClaudePreToolFrame },
): Promise<{ out: ClaudePreToolHookResult; verdict: ClaudePreToolVerdict | undefined }> {
  const dialect: PreToolHookDialect = args.length === 2 && args[0] === "--codex" ? "codex" : "claude";
  const file = dialect === "codex" ? args[1] : args[0];
  if (args.length !== (dialect === "codex" ? 2 : 1) || file === undefined || !isAbsolute(file))
    throw new HookInputError("the hook takes the absolute path of its context file, after --codex for Codex");
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
  // The spool must be the one ORCA made beside this context; any other path records nothing.
  if (context.telemetry !== undefined && dirname(context.telemetry.file) === dirname(file))
    seen.target = context.telemetry;
  const frame = parseClaudePreToolFrame(input);
  seen.frame = frame;
  const probe = frame.toolUseId !== undefined && CODEX_PROBE_TOOL_USE_ID.test(frame.toolUseId);
  const verdict = await checkClaudePreTool(context, frame);
  if (dialect === "claude") return { out: claudePreToolHookOutput(verdict), verdict: probe ? undefined : verdict };
  const out = codexPreToolHookOutput(verdict);
  const nonce = frame.toolUseId === undefined ? undefined : CODEX_PROBE_TOOL_USE_ID.exec(frame.toolUseId)?.[1];
  if (out.exitCode === 2 && context.probeKey !== undefined && nonce !== undefined)
    return {
      out: { ...out, stderr: `${out.stderr}${codexProbeReceipt(context.probeKey, nonce)}\n` },
      verdict: undefined,
    };
  return { out, verdict: probe ? undefined : verdict };
}

/**
 * The telemetry line for one answered call (#1000). `decision` is the policy's answer
 * (`allow`, `ask`, `deny`), as for Claude, also for Codex, where the hook blocks an `ask`
 * because Codex cannot pause for it; `block` is the hook's own failure. `rule` is the reason
 * the hook decided for. A frame the hook could not read is recorded as `(unreadable)`.
 */
export function preToolTelemetryLine(
  frame: ClaudePreToolFrame | undefined,
  decided: { verdict: ClaudePreToolVerdict } | { error: unknown },
  at: string,
  latencyMs: number,
): HookTelemetryLine {
  const base = {
    v: HOOK_TELEMETRY_LINE_VERSION,
    at,
    tool: frame?.toolName ?? "(unreadable)",
    ...(frame?.toolUseId !== undefined ? { toolUseId: frame.toolUseId } : {}),
    ...(frame ? { input: frame.toolInput } : {}),
    latencyMs,
  } as const;
  if ("error" in decided)
    return {
      ...base,
      decision: "block",
      rule: "hook-error",
      hookError: decided.error instanceof HookInputError ? decided.error.message : "internal error",
    };
  return {
    ...base,
    kind: decided.verdict.toolCall.kind,
    title: decided.verdict.toolCall.title,
    decision: decided.verdict.decision,
    rule: decided.verdict.reason,
  };
}

/** Where the session-start hook records the runtime it ran under, beside the context file. */
export const claudeRuntimeAttestationFile = (contextFile: string): string => `${contextFile}.runtime.json`;

/**
 * What the session-start hook records: the process id of the program that ran it, which is
 * meant to be Claude Code itself. It is only a pointer. ORCA never runs or trusts anything
 * the record names: it checks from its own side that the process is one the agent it started
 * runs, and that the image that process actually runs is a pinned one.
 */
export interface ClaudeRuntimeAttestation {
  version: 1;
  pid: number;
}

/**
 * The session-start half of the hook (`--attest <context file>`): Claude Code runs it when the
 * session starts, before `session/new` returns. It records its parent's process id. Every
 * failure records nothing, which ORCA reads as an unverified runtime.
 */
export async function runClaudeRuntimeAttestation(
  args: readonly string[],
  input: string,
  parent: { pid: number },
): Promise<ClaudePreToolHookResult> {
  try {
    const file = args[1];
    if (args.length !== 2 || args[0] !== "--attest" || file === undefined || !isAbsolute(file))
      throw new HookInputError("the attestation takes --attest and the absolute path of the context file");
    let frame: unknown;
    try {
      frame = JSON.parse(input);
    } catch {
      throw new HookInputError("session start input is not JSON");
    }
    if (!isRecord(frame) || frame["hook_event_name"] !== "SessionStart")
      throw new HookInputError("not a SessionStart event");
    const attestation: ClaudeRuntimeAttestation = { version: 1, pid: parent.pid };
    const target = claudeRuntimeAttestationFile(file);
    try {
      await writeFile(target, JSON.stringify(attestation), { mode: 0o600, flag: "wx" });
    } catch (error) {
      // A session that resumes or compacts starts again in the process it was checked in;
      // the first record stands, and another process is reported, never recorded.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const first = JSON.parse(await readFile(target, "utf8")) as Partial<ClaudeRuntimeAttestation>;
      if (first.pid !== attestation.pid)
        throw new HookInputError("the session restarted in another process than the one it was checked in");
    }
    return { exitCode: 0, stdout: "", stderr: "" };
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
  /**
   * The arguments for the session-start attestation (`[script, "--attest", contextFile]`).
   * Given, the settings also run it when the session starts.
   */
  attestArgs?: string[] | undefined;
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
  const timeout = hook.timeoutSeconds ?? CLAUDE_PRE_TOOL_TIMEOUT_SECONDS;
  return {
    hooks: {
      ...(hook.attestArgs
        ? {
            SessionStart: [
              { hooks: [{ type: "command", command: hook.command, args: [...hook.attestArgs], timeout }] },
            ],
          }
        : {}),
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: hook.command,
              args: [...hook.args],
              timeout,
              onFailure: "block",
            },
          ],
        },
      ],
    },
  };
}
