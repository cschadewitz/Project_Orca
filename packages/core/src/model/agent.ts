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
export const ToolKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const PermissionDecisionSchema = z.enum(["allow", "deny", "ask"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionRuleSchema = z.object({
  match: z.object({
    kind: ToolKindSchema.optional(),
    /** Regular expression tested against the tool call title. */
    titlePattern: z.string().optional(),
    /**
     * One exact tool call location path. A relative path is resolved against the run's
     * workspace, which is what makes a rule survive a fresh git worktree at a new absolute
     * path. This is the only path form ORCA writes itself: a request to touch one file
     * justifies a grant for that file and for nothing beside it.
     */
    path: z.string().optional(),
    /** Glob-ish prefix tested against any tool call location path. Hand-written only. */
    pathPrefix: z.string().optional(),
    /**
     * Where the tool call's locations are, relative to the run's workspace — the one match
     * that needs no path written down, because the path it is about is the run's own.
     *
     * - `workspace`: the call has at least one location and *every* location resolves
     *   inside `Run.workspace.cwd`. A move out of the workspace is therefore not "in" it.
     * - `outside-workspace`: at least one location does not. An absolute path when the
     *   workspace is unknown counts as outside — the safe reading of "cannot tell".
     *
     * A call with no locations at all (`execute`, mostly: its command text is the title and
     * its location is only the directory it runs in) matches neither, and falls through to
     * the policy `default`. That is deliberate: a shell command is not a place.
     */
    scope: z.enum(["workspace", "outside-workspace"]).optional(),
  }),
  decision: PermissionDecisionSchema,
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

/**
 * What an agent may do when nobody said — the policy for an agent with no `permissions:`
 * block, or one that leaves `default:` unset (#140).
 *
 * It is `ask` for everything except reading, searching and changing files inside the run's
 * own workspace. In particular `execute` is `ask`: ORCA sees a shell command only as the
 * permission title (the agents that matter run commands in their own process rather than
 * through ACP's `terminal`), so there is nothing to scope it by, and an unattended agent
 * that may run any command may do anything at all. Reads outside the workspace are `ask`
 * for the reason #140 was filed: a planning agent handed a thin work item went looking in a
 * sibling checkout and found one, and nothing in a `default: allow` policy could tell that
 * read from a read of a file it was sent to edit.
 *
 * **This applies to every agent that declares no policy, not only to unattended runs.** A
 * policy that depended on how the run was launched would mean the same config behaved two
 * ways, and the interesting cases (what may this agent touch) would be the ones you could
 * not reason about from the config alone. The opt-out is one line and it is explicit:
 * `permissions: { default: allow }` in `orca.config.yaml` restores the old behaviour for
 * that agent, and is the right thing for a sandbox.
 *
 * These are *rules*, not a special case in the evaluator, so ADR 0009's layering is
 * untouched: configured rules are still matched first, these sit behind them, and the
 * `orca.permissions.json` sidecar still comes last. A configured `deny` therefore beats
 * this, and so does a configured `allow`.
 */
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  default: "ask",
  rules: [
    { match: { kind: "read", scope: "workspace" }, decision: "allow" },
    { match: { kind: "search", scope: "workspace" }, decision: "allow" },
    { match: { kind: "edit", scope: "workspace" }, decision: "allow" },
    { match: { kind: "delete", scope: "workspace" }, decision: "allow" },
    { match: { kind: "move", scope: "workspace" }, decision: "allow" },
    // Thinking touches nothing and asking about it teaches people to click through prompts.
    { match: { kind: "think" }, decision: "allow" },
  ],
};

/**
 * Governs `session/request_permission` calls from an agent. "ask" is routed to
 * the HumanInputPort (or, in ACP-facade mode, forwarded to the upstream client).
 *
 * Leaving `default:` out opts in to `DEFAULT_PERMISSION_POLICY`: the default decision
 * becomes `ask` and its rules are appended *after* whatever rules were configured, so a
 * hand-written rule still wins the first match. Writing `default:` — including
 * `default: allow` — says the author has thought about it, and nothing is appended.
 */
export const PermissionPolicySchema = z
  .object({
    default: PermissionDecisionSchema.optional(),
    rules: z.array(PermissionRuleSchema).default([]),
  })
  .transform(({ default: decision, rules }) =>
    decision === undefined
      ? { default: DEFAULT_PERMISSION_POLICY.default, rules: [...rules, ...DEFAULT_PERMISSION_POLICY.rules] }
      : { default: decision, rules },
  );
export type PermissionPolicy = { default: PermissionDecision; rules: PermissionRule[] };

/* -------------------------------------------------------------------------- *
 * The written half of a permission policy
 *
 * `PermissionPolicySchema` above is loaded configuration: a person writes it into the Nth
 * element of the hand-curated `agents:` array in `orca.config.yaml`. Answering a permission
 * prompt with "always" has to put a rule somewhere, and it cannot be there - a machine
 * appending to a hand-curated array collides with the human edits around it.
 *
 * So it goes in a sidecar file beside the config, layered over the configured rules. The
 * file is plain, readable and diffable on purpose: a standing permission grant that
 * teammates and code review can see is the safer default for something security-relevant.
 * `@orca/agents`' `permissions.ts` reads and writes it; the schema lives here because this
 * barrel is node-free (see `schemas.ts`) and everything below is pure.
 * -------------------------------------------------------------------------- */

/**
 * The sidecar's filename, beside `orca.config.yaml`. JSON rather than YAML because
 * `@orca/agents`, which owns the reading and writing, depends on `@orca/core` and the ACP
 * SDK and nothing else; a format is not worth a dependency edge. See ADR 0009.
 */
export const PERMISSION_POLICY_FILENAME = "orca.permissions.json";

/**
 * A rule ORCA wrote itself, in answer to one permission request. The two extra fields are
 * provenance for whoever reads the diff; `decidePermission` ignores them.
 */
export const RecordedPermissionRuleSchema = PermissionRuleSchema.extend({
  /** ISO-8601 instant the rule was written. */
  addedAt: z.string().optional(),
  /** The tool call title that was answered "always", verbatim. */
  grantedFor: z.string().optional(),
});
export type RecordedPermissionRule = z.infer<typeof RecordedPermissionRuleSchema>;

/**
 * The sidecar document, keyed by agent id.
 *
 * There is deliberately no `default` here. A layer can only ever add rules: answering one
 * prompt with "always" never changes what happens to every *other* request, and leaving the
 * field out means the configured `default` is unambiguously the one that applies. The same
 * document shape is therefore valid at any scope, which is how a user-scoped file can later
 * layer *under* the workspace one without this schema changing.
 */
export const PermissionPolicyFileSchema = z.object({
  version: z.literal(1).default(1),
  agents: z.record(z.string(), z.object({ rules: z.array(RecordedPermissionRuleSchema).default([]) })).default({}),
});
export type PermissionPolicyFile = z.infer<typeof PermissionPolicyFileSchema>;

/**
 * The same document, for a writer rather than a reader: it *refuses* a `default` instead of
 * ignoring one.
 *
 * `PermissionPolicyFileSchema` above has no `default` field, and zod strips keys it does not
 * know, so reading a sidecar that somehow grew one is silently tolerant - which is the right
 * reading behaviour, because a stripped key changes nothing about how the policy evaluates.
 * Writing is the other case. `config.set` on the `permissions` document (#266) takes a whole
 * document from a client, and a client that sent a `default` meant it: accepting the write
 * and dropping the field would report success for an edit that did nothing. Naming the key
 * and rejecting it says what ADR 0009 decided, at the moment somebody tries the opposite.
 */
export const WritablePermissionPolicyFileSchema = PermissionPolicyFileSchema.extend({
  default: z
    .undefined({
      error:
        "the permission sidecar carries no `default`: answering one prompt must not change the answer to every other one (ADR 0009). Set the default in `agents[].permissions` in the config instead.",
    })
    .optional(),
});

/**
 * The policy `decidePermission` should be handed: the agent's configured rules first, then
 * each overlay in the order given. First match wins, so "first" is the precedence the
 * milestone settled on — configuration outranks anything a machine wrote, and a later
 * user-scoped overlay is simply one more argument.
 *
 * Provenance fields are dropped: the result is a plain `PermissionPolicy`.
 */
export function layerPermissionPolicies(
  configured: PermissionPolicy,
  ...overlays: readonly (readonly PermissionRule[] | undefined)[]
): PermissionPolicy {
  const rules: PermissionRule[] = [];
  const push = (r: PermissionRule) => rules.push({ match: { ...r.match }, decision: r.decision });
  for (const rule of configured.rules) push(rule);
  for (const overlay of overlays) for (const rule of overlay ?? []) push(rule);
  return { default: configured.default, rules };
}

/** Two rules are the same grant when they match the same thing and decide the same way. */
export function samePermissionRule(a: PermissionRule, b: PermissionRule): boolean {
  return (
    a.decision === b.decision &&
    a.match.kind === b.match.kind &&
    a.match.titlePattern === b.match.titlePattern &&
    a.match.path === b.match.path &&
    a.match.pathPrefix === b.match.pathPrefix &&
    a.match.scope === b.match.scope
  );
}

/* ----------------------------- path handling ------------------------------ */

/**
 * POSIX path normalisation, without `node:path` — this module is in the node-free barrel.
 * Agents run on POSIX hosts (local or over `ssh … bash -lc`), so `/` is the separator.
 */
export function normalizePermissionPath(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (absolute ? "/" : "") + out.join("/");
}

/**
 * The path as the workspace sees it, or `undefined` when it is not in the workspace at all.
 *
 * An absolute path inside `workspaceCwd` comes back relative to it; a path that is already
 * relative is taken to be workspace-relative already; anything that escapes (`/etc/hosts`,
 * `../../secrets`) comes back `undefined`, and the caller must refuse rather than guess.
 * The workspace root itself normalises to `""`.
 */
export function workspaceRelativePath(path: string, workspaceCwd: string | undefined): string | undefined {
  const p = normalizePermissionPath(path);
  if (!p.startsWith("/")) return p.startsWith("..") ? undefined : p;
  if (!workspaceCwd) return undefined;
  const root = normalizePermissionPath(workspaceCwd);
  if (!root.startsWith("/")) return undefined;
  if (p === root) return "";
  const prefix = root === "/" ? "/" : `${root}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : undefined;
}

/**
 * The forms a rule may be written against: the path as given, plus its workspace-relative
 * form when it has one. Matching against both is what lets a rule written as
 * `packages/core/src/a.ts` fire for `/home/x/worktrees/feature/packages/core/src/a.ts`.
 */
export function permissionPathForms(path: string, workspaceCwd: string | undefined): string[] {
  const forms = [normalizePermissionPath(path)];
  const rel = workspaceRelativePath(path, workspaceCwd);
  if (rel !== undefined && !forms.includes(rel)) forms.push(rel);
  return forms;
}

/* --------------------------- rule derivation ------------------------------ */

/** What deriving a rule needs to know about the request being answered. */
export interface PermissionRequestFacts {
  /** ACP tool kind; anything unrecognised is treated as "other". */
  kind?: string | null | undefined;
  /** The tool call's human-readable title. */
  title?: string | null | undefined;
  /** The tool call's location paths, in order. */
  paths?: readonly string[] | undefined;
  /** Absolute path of the run's workspace. Without it no path rule can be scoped. */
  workspaceCwd?: string | undefined;
}

/**
 * Why no rule could be derived. Each one is a case where writing *something* would be worse
 * than writing nothing: the caller falls back to allowing this one call.
 */
export type PermissionDeriveRefusal =
  "outside-workspace" | "whole-workspace" | "volatile" | "unscopable" | "not-recordable";

export type PermissionDeriveResult =
  { ok: true; rules: PermissionRule[] } | { ok: false; reason: PermissionDeriveRefusal; detail: string };

/**
 * Strings that will not be there next time. A rule built around one is not a security
 * problem - it is narrower than the request, not broader - but it can never match again, so
 * the person is asked the same question forever and learns that "always" does nothing.
 */
const VOLATILE: readonly { re: RegExp; what: string }[] = [
  {
    re: /\b(?:run|step|art|evt|sess|orc|req|wi|wf|hi|plan|dep|risk|dec|pev|tpl|host)_[0-9A-HJKMNP-TV-Z]{26}\b/,
    what: "an ORCA id",
  },
  { re: /\b[0-9A-HJKMNP-TV-Z]{26}\b/, what: "a ULID" },
  { re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/, what: "a UUID" },
  { re: /\b[0-9a-f]{12,}\b/, what: "a hex digest" },
  { re: /\d{4}-\d{2}-\d{2}T\d{2}[:.\-_]?\d{2}/, what: "a timestamp" },
  { re: /\b\d{10,}\b/, what: "an epoch or a pid" },
  { re: /(?:^|[\s"'`(=])\/(?:tmp|private\/tmp|private\/var\/folders|var\/folders)\//, what: "a temporary directory" },
  { re: /(?:^|\/)\.orca\/runs\//, what: "a per-run store path" },
];

function volatileIn(text: string): string | undefined {
  for (const v of VOLATILE) if (v.re.test(text)) return v.what;
  return undefined;
}

/** A regular expression that matches exactly one literal string, and nothing else. */
export function exactTitlePattern(title: string): string {
  return `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/**
 * Turn one answered permission request into the rules that would have answered it, and no
 * more than that.
 *
 * The shape of the answer, in words:
 *
 * - **The tool kind is always carried and never dropped.** Dropping it would turn "may edit
 *   this file" into "may do anything to this file".
 * - **An `execute` call is scoped to its command, never to a path.** A tool call's locations
 *   for `execute` are the directory it runs in, and `{kind: execute, path: packages/core}`
 *   grants every command in that tree — including the one nobody would have allowed. The
 *   title is the command, so the title is what gets anchored.
 * - **Every other kind with locations is scoped to those exact paths**, one rule per
 *   location, written workspace-relative. A move with a source and a destination needs both,
 *   and answering "always" for the pair plainly means each.
 * - **A kind with no locations is scoped to its exact title**, anchored `^…$` with every
 *   regex metacharacter escaped. This is the only device left, and it is exact.
 *
 * And what it refuses rather than generalise:
 *
 * - A parent directory. One file is one file; `pathPrefix` is a hand-written form only.
 * - Anything outside the workspace — `/etc/hosts`, `~/.ssh/id_ed25519`, a sibling checkout.
 *   "Always" is scoped to the workspace because that is what the sidecar's location says,
 *   and a grant that reaches past it cannot honestly be written there.
 * - The workspace root itself, which is every path in the workspace wearing a disguise.
 * - Anything carrying a run id, a ULID, a digest, a timestamp or a temp directory — see
 *   `VOLATILE`. Not unsafe, but useless, and a permission prompt that keeps coming back
 *   after you said "always" is how people learn to stop reading them.
 * - A bare kind, when there is neither a location nor a title to pin it to.
 */
export function derivePermissionRules(
  facts: PermissionRequestFacts,
  decision: PermissionDecision = "allow",
): PermissionDeriveResult {
  if (decision === "ask") return { ok: false, reason: "not-recordable", detail: `nothing to record for "ask"` };

  const parsedKind = ToolKindSchema.safeParse(facts.kind ?? "other");
  const kind: ToolKind = parsedKind.success ? parsedKind.data : "other";
  const title = (facts.title ?? "").trim();
  const paths = (facts.paths ?? []).filter((p) => p.trim() !== "");

  const byTitle = (): PermissionDeriveResult => {
    if (title === "")
      return { ok: false, reason: "unscopable", detail: `a ${kind} call with no location and no title` };
    const v = volatileIn(title);
    if (v) return { ok: false, reason: "volatile", detail: `the title contains ${v}: ${title}` };
    return { ok: true, rules: [{ match: { kind, titlePattern: exactTitlePattern(title) }, decision }] };
  };

  // `execute` is a command, not a place. Scope it to the command.
  if (kind === "execute") return byTitle();
  if (paths.length === 0) return byTitle();

  const rules: PermissionRule[] = [];
  for (const raw of paths) {
    const rel = workspaceRelativePath(raw, facts.workspaceCwd);
    if (rel === undefined)
      return {
        ok: false,
        reason: "outside-workspace",
        detail: `${raw} is not inside the workspace, so the grant cannot be scoped to it`,
      };
    if (rel === "")
      return { ok: false, reason: "whole-workspace", detail: `${raw} is the workspace root, not a file in it` };
    const v = volatileIn(rel);
    if (v) return { ok: false, reason: "volatile", detail: `${rel} contains ${v}` };
    const rule: PermissionRule = { match: { kind, path: rel }, decision };
    if (!rules.some((r) => samePermissionRule(r, rule))) rules.push(rule);
  }
  return { ok: true, rules };
}

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
  /** Absent means `DEFAULT_PERMISSION_POLICY`: ask for `execute` and for anything outside the workspace. */
  permissions: PermissionPolicySchema.default(() => ({
    default: DEFAULT_PERMISSION_POLICY.default,
    rules: DEFAULT_PERMISSION_POLICY.rules.map((r) => ({ match: { ...r.match }, decision: r.decision })),
  })),
  /** MCP servers passed in `session/new`. */
  mcpServers: z.array(McpServerConfigSchema).default([]),
  /** Reuse one ACP session for a whole run, or open a fresh one per step. */
  sessionMode: z.enum(["per-step", "per-run"]).default("per-step"),
  /** Per-turn wall clock limit. */
  turnTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  /**
   * How long a turn may keep running after `session/cancel` (turn timeout, run
   * cancellation, artifact-present completion) before the agent is treated as
   * wedged and its process killed.
   */
  cancelGraceMs: z.number().int().positive().default(10_000),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** How a workflow node picks an agent: by id, or by role (resolved from config). */
export const AgentSelectorSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }),
  z.object({ role: z.string().min(1) }),
]);
export type AgentSelector = z.infer<typeof AgentSelectorSchema>;
