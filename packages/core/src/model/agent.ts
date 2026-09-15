/**
 * Agent and host configuration.
 *
 * A Host is *where* an agent process runs (this machine, or another machine
 * reached over SSH). An Agent is *what* runs there: any ACP-speaking binary
 * such as `claude-code-acp`, `codex acp`, `gemini --acp`, `opencode acp`.
 */
import { z } from "zod";

export const LOCAL_HOST_ID = "local";

export const SshHostSchema = z.object({
  id: z.string().min(1),
  type: z.literal("ssh"),
  host: z.string().min(1),
  user: z.string().optional(),
  port: z.number().int().positive().optional(),
  identityFile: z.string().optional(),
  /** Extra `ssh` CLI arguments, e.g. ["-o", "ProxyJump=bastion"]. */
  sshArgs: z.array(z.string()).default([]),
  /** Path to the ssh binary. */
  sshBinary: z.string().default("ssh"),
  /** Shell used to run the remote agent command (login shell so PATH/nvm etc. resolve). */
  remoteShell: z.string().default("bash -lc"),
  /** Root directory on the remote machine under which workspaces live. */
  workspaceRoot: z.string().optional(),
  connectTimeoutMs: z.number().int().positive().default(20_000),
});
export type SshHost = z.infer<typeof SshHostSchema>;

export const LocalHostSchema = z.object({
  id: z.string().min(1),
  type: z.literal("local"),
  workspaceRoot: z.string().optional(),
});
export type LocalHost = z.infer<typeof LocalHostSchema>;

export const HostSpecSchema = z.discriminatedUnion("type", [LocalHostSchema, SshHostSchema]);
export type HostSpec = z.infer<typeof HostSpecSchema>;

/** ACP tool kinds, mirrored here so policies do not depend on the SDK types. */
export const ToolKindSchema = z.enum(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const PermissionDecisionSchema = z.enum(["allow", "deny", "ask"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionRuleSchema = z.object({
  match: z.object({
    kind: ToolKindSchema.optional(),
    /** Regular expression tested against the tool call title. */
    titlePattern: z.string().optional(),
    /** Glob-ish prefix tested against any tool call location path. */
    pathPrefix: z.string().optional(),
  }),
  decision: PermissionDecisionSchema,
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

/**
 * Governs `session/request_permission` calls from an agent. "ask" is routed to
 * the HumanInputPort (or, in ACP-facade mode, forwarded to the upstream client).
 */
export const PermissionPolicySchema = z.object({
  default: PermissionDecisionSchema.default("allow"),
  rules: z.array(PermissionRuleSchema).default([]),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

export const McpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const AgentSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  /** Executable (resolved on the host). */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  hostId: z.string().default(LOCAL_HOST_ID),
  /** Roles this agent can fill (e.g. "planner", "builder", "reviewer"). */
  roles: z.array(z.string()).default([]),
  permissions: PermissionPolicySchema.default({ default: "allow", rules: [] }),
  /** MCP servers passed in `session/new`. */
  mcpServers: z.array(McpServerConfigSchema).default([]),
  /** Reuse one ACP session for a whole run, or open a fresh one per step. */
  sessionMode: z.enum(["per-step", "per-run"]).default("per-step"),
  /** Per-turn wall clock limit. */
  turnTimeoutMs: z.number().int().positive().default(30 * 60_000),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** How a workflow node picks an agent: by id, or by role (resolved from config). */
export const AgentSelectorSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }),
  z.object({ role: z.string().min(1) }),
]);
export type AgentSelector = z.infer<typeof AgentSelectorSchema>;
