/**
 * Agent and host configuration.
 *
 * A Host is *where* an agent process runs (this machine, or another machine
 * reached over SSH). An Agent is *what* runs there: any ACP-speaking binary
 * such as `claude-code-acp`, `codex acp`, `gemini --acp`, `opencode acp`.
 */
import { z } from "zod";
import { AuthorityCapabilityScopeSchema } from "./capabilities.js";

// Scoped capabilities (#335) belong with the agent model they select for.
export * from "./capabilities.js";

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
  /**
   * At most this many agent sessions open on this host at once (#873). Absent means
   * unlimited, which is the default: nothing is derived from the machine.
   */
  maxSessions: z.number().int().positive().optional(),
});
export type SshHost = z.infer<typeof SshHostSchema>;

export const LocalHostSchema = z.object({
  id: z.string().min(1),
  type: z.literal("local"),
  workspaceRoot: z.string().optional(),
  /**
   * At most this many agent sessions open on this host at once (#873). Absent means
   * unlimited, which is the default: nothing is derived from the machine.
   */
  maxSessions: z.number().int().positive().optional(),
});
export type LocalHost = z.infer<typeof LocalHostSchema>;

export const HostSpecSchema = z.discriminatedUnion("type", [LocalHostSchema, SshHostSchema]);
export type HostSpec = z.infer<typeof HostSpecSchema>;

/**
 * Another ORCA daemon this one may delegate steps to (#883), as the config's `remotes[]`. The
 * connection fields are the desktop app's SSH profile fields (#874): typed fields only, no
 * free-form ssh options and no ssh config file. They are checked against the shared
 * `ConnectionProfileSchema` (`@orca/protocol/remote-access`) when the daemon loads the config,
 * which stays their one definition; here they are only typed.
 */
const RemoteHopSchema = z
  .object({
    /** `user@host` or `host`. */
    destination: z.string().min(1),
    sshPort: z.number().int().min(1).max(65535).optional(),
    /** A private key file, as an absolute path. Absent: the keys the SSH agent offers. */
    identityFile: z.string().min(1).optional(),
  })
  .strict();
export const RemoteDaemonSpecSchema = RemoteHopSchema.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use lowercase letters, digits and dashes"),
  name: z.string().min(1).optional(),
  jump: RemoteHopSchema.optional(),
  /** The daemon's port on the remote loopback. Default 6722. */
  remotePort: z.number().int().min(1).max(65535).optional(),
  /** The server's ORCA CLI, a command name or an absolute path. Default `orca`. */
  serverCommand: z.string().min(1).optional(),
  /** The remote daemon's workspace config, as an absolute path on the server. */
  serverConfig: z.string().min(1).optional(),
  /**
   * The file holding the bearer credential the remote daemon issued for this daemon
   * (`orca auth issue … --json` there), relative to the config file. Default
   * `auth/remotes/<id>.token` beside the config. It is read at each session open, never logged,
   * and must not be readable by other users.
   */
  credentialFile: z.string().min(1).optional(),
}).strict();
export type RemoteDaemonSpec = z.infer<typeof RemoteDaemonSpecSchema>;

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
 * These are *rules*, not a special case in the evaluator, and they are the **last** layer:
 * `effectivePermissionPolicy` appends them after the configured rules *and* after the
 * `orca.permissions.json` sidecar, which is what ADR 0009's "configuration first, then the
 * sidecar" requires. A configured `deny` beats them; so does a sidecar `deny`, which is the
 * point — until #140 these were folded into the parsed config by `PermissionPolicySchema`, so
 * a default `allow` on an in-workspace edit was matched before the sidecar ever got a turn
 * and a written `reject_always` could not take effect.
 *
 * **They apply only when the config left `default:` unset.** Writing `default:` at all — and
 * `default: ask` just as much as `default: allow` — is somebody saying what this agent's
 * fallthrough is, and these rules are the *answer to a question nobody asked*. Somebody who
 * wrote `permissions: { default: ask }` with no rules asked for everything to be asked, and
 * quietly allowing in-workspace edits on top of that would be this file deciding it knew
 * better. So an explicit `default` opts out of the whole of it, `permissions:` present with
 * no `default:` does not, and `defaultRulesApply` is the one place that is decided.
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
 * This is the *configured* half and nothing else: `rules` is exactly what the file says, in
 * the order the file says it. `DEFAULT_PERMISSION_POLICY`'s rules are **not** folded in here
 * (#140) — they are the last layer, appended by `effectivePermissionPolicy`, so that a
 * sidecar `deny` still outranks a default `allow`. Injecting them here also meant anything
 * that re-serialises a parsed `AgentSpec` (`orca demo`'s generated config, `config.get`'s
 * per-rule provenance) reported rules nobody had written as if they had been.
 *
 * **`default` stays optional through parsing, and that absence is load-bearing.** It is the
 * difference between "nobody said" and "somebody said `ask`", which decides whether the
 * default rules apply at all. Resolving it to `"ask"` here would erase the distinction at
 * the only moment it is still knowable, so it is resolved at evaluation instead, by
 * `effectivePermissionPolicy`.
 */
export const PermissionPolicySchema = z.object({
  default: PermissionDecisionSchema.optional(),
  rules: z.array(PermissionRuleSchema).default([]),
});

/**
 * A policy as written: `default` may be absent, meaning nobody chose a fallthrough. This is
 * what `agents[].permissions` parses to and what `config.set` round-trips.
 */
export type ConfiguredPermissionPolicy = { default?: PermissionDecision | undefined; rules: PermissionRule[] };

/**
 * A policy as *evaluated*: every layer concatenated and the fallthrough decided.
 * `decidePermission` takes one of these, never a `ConfiguredPermissionPolicy`.
 */
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
 * Concatenate rule lists: the agent's configured rules first, then each overlay in the order
 * given. First match wins, so "first" is the precedence the milestone settled on —
 * configuration outranks anything a machine wrote, and a later user-scoped overlay is simply
 * one more argument.
 *
 * It is deliberately dumb about *which* overlays there should be: `effectivePermissionPolicy`
 * is what knows that, and this is what it is built out of. An unset `default` resolves to
 * `DEFAULT_PERMISSION_POLICY`'s, which is `ask`.
 *
 * Provenance fields are dropped: the result is a plain `PermissionPolicy`.
 */
export function layerPermissionPolicies(
  configured: ConfiguredPermissionPolicy,
  ...overlays: readonly (readonly PermissionRule[] | undefined)[]
): PermissionPolicy {
  const rules: PermissionRule[] = [];
  const push = (r: PermissionRule) => rules.push({ match: { ...r.match }, decision: r.decision });
  for (const rule of configured.rules) push(rule);
  for (const overlay of overlays) for (const rule of overlay ?? []) push(rule);
  return { default: configured.default ?? DEFAULT_PERMISSION_POLICY.default, rules };
}

/**
 * Whether `DEFAULT_PERMISSION_POLICY`'s rules are part of this agent's evaluation (#140).
 *
 * Only when the config left `default:` unset. An explicit `default` — `ask` as much as
 * `allow` — is an author saying what happens when no rule matched, and appending rules that
 * match things on their behalf would be answering a different question from the one they
 * asked. See `DEFAULT_PERMISSION_POLICY`'s comment.
 *
 * One predicate, exported, because three callers have to agree about it: the ACP session
 * that evaluates a permission, the loader that layers in the sidecar, and `config.get`, which
 * has to label each effective rule with the layer it came from.
 */
export function defaultRulesApply(configured: ConfiguredPermissionPolicy): boolean {
  return configured.default === undefined;
}

/**
 * The policy `decidePermission` should be handed: configured rules, then each sidecar overlay
 * in the order given, then the default rules when they apply — ADR 0009's layering, in one
 * place so that nothing has to re-derive it and get it subtly different.
 */
export function effectivePermissionPolicy(
  configured: ConfiguredPermissionPolicy,
  ...overlays: readonly (readonly PermissionRule[] | undefined)[]
): PermissionPolicy {
  return layerPermissionPolicies(
    configured,
    ...overlays,
    defaultRulesApply(configured) ? DEFAULT_PERMISSION_POLICY.rules : [],
  );
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

/**
 * Whether a sidecar rule is a wildcard: an `allow` that does not say what it allows (C4-01).
 *
 * Every rule ORCA writes into the sidecar is derived from one answered request and scoped to
 * it — a kind, and that file or that exact command (`derivePermissionRules`). A person editing
 * the sidecar on the Config surface narrows a kind by a path, a prefix, the workspace or a
 * title. Neither writes an `allow` that names no kind (`{}`), or names one and nothing that
 * narrows it: `{kind: execute}`, `{kind: read, scope: outside-workspace}`, a title pattern that
 * matches any title, a path or prefix that normalises to nothing — the workspace root, which
 * `derivePermissionRules` refuses for the same reason. And an `execute` is a command, not a
 * place, so only its title narrows it — a path or a scope on one is the directory it ran in,
 * and grants every command run there.
 *
 * In the sidecar such a rule is far likelier to be something an agent wrote than something a
 * person meant, and it is the shape that turns one written file into "approve everything". So
 * the loader ignores it (`permissionOverlayFor` in `@orca/agents`), and a wildcard belongs in
 * `orca.config.yaml`, where a person wrote it on purpose. A `deny` or an `ask` is never a
 * wildcard here: ignoring one could only widen what an agent may do.
 */
export function isWildcardPermissionRule(rule: PermissionRule): boolean {
  if (rule.decision !== "allow") return false;
  const m = rule.match;
  if (m.kind === undefined) return true;
  const byTitle = m.titlePattern !== undefined && !matchesEveryTitle(m.titlePattern);
  if (m.kind === "execute") return !byTitle;
  const byPath = [m.path, m.pathPrefix].some((p) => p !== undefined && normalizePermissionPath(p) !== "");
  return !byTitle && !byPath && m.scope !== "workspace";
}

/**
 * A pattern that matches an empty title and a title of one meaningless character matches by
 * position rather than by content (`""`, `.*`, `^`, `$`), so it matches every title. An
 * invalid pattern is not a wildcard; whether it should load at all is a separate question.
 */
function matchesEveryTitle(pattern: string): boolean {
  try {
    const re = new RegExp(pattern);
    return re.test("") && re.test("\u0000");
  } catch {
    return false;
  }
}

/* ----------------------------- path handling ------------------------------ */

/**
 * Portable path normalisation without `node:path`, including Windows local agents.
 * Drive and UNC roots stay absolute; separators normalise to slash for policy storage.
 */
export function normalizePermissionPath(p: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")) p = p.replaceAll("\\", "/");
  const drive = /^[A-Za-z]:\//.test(p) ? p.slice(0, 2).toUpperCase() : "";
  if (drive) p = p.slice(2);
  const unc = p.startsWith("//");
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
  return drive + (unc ? "//" : absolute ? "/" : "") + out.join("/");
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
  if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p)) return p.startsWith("..") || /^[A-Za-z]:/.test(p) ? undefined : p;
  if (!workspaceCwd) return undefined;
  const root = normalizePermissionPath(workspaceCwd);
  if (!root.startsWith("/") && !/^[A-Za-z]:\//.test(root)) return undefined;
  if (p === root) return "";
  const prefix = root.endsWith("/") ? root : `${root}/`;
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

/**
 * What runs a step for an agent. `acp` (the default) spawns `command` on the agent's host and
 * speaks ACP to it. `orca-daemon` (#883) delegates the step to another ORCA daemon instead: it
 * reaches the daemon named by `profile` (one of the config's `remotes`) over that profile's SSH
 * tunnel and runs `workflow` there, so the work is the remote daemon's own run, in its own run
 * list. `command`, `args`, `env` and `mcpServers` do not apply to it.
 */
export const AgentTypeSchema = z.enum(["acp", "orca-daemon"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const AgentSpecSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    type: AgentTypeSchema.default("acp"),
    /**
     * Executable (resolved on the host). Required for an `acp` agent; an `orca-daemon` agent has
     * no process of its own and leaves it out.
     */
    command: z.string().default(""),
    /** `orca-daemon` only: the `remotes[].id` whose daemon runs this agent's steps. */
    profile: z.string().min(1).optional(),
    /** `orca-daemon` only: the workflow the remote daemon runs for each step. */
    workflow: z.string().min(1).optional(),
    /**
     * `orca-daemon` only: the remote workflow variable the step's task text is passed in.
     * Default `prompt`.
     */
    promptVar: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    hostId: z.string().default(LOCAL_HOST_ID),
    /** Roles this agent can fill (e.g. "planner", "builder", "reviewer"). */
    roles: z.array(z.string()).default([]),
    /**
     * Absent means no configured rules and no chosen fallthrough, which is what opts the agent
     * in to `DEFAULT_PERMISSION_POLICY`: reads, searches and file changes inside the run's own
     * workspace, and `ask` for everything else. The default is `{ rules: [] }` and *not*
     * `{ default: "ask", rules: [] }` — those two are different policies now, and the second
     * one opts out. It is all layered at evaluation time, not here; see
     * `effectivePermissionPolicy`.
     */
    permissions: PermissionPolicySchema.default(() => ({ rules: [] })),
    /**
     * MCP servers passed in `session/new`. The legacy inline form: each one is on for this
     * agent, as if it were in the catalog and enabled here. `capabilities` below selects from
     * the shared catalog instead (#335).
     */
    mcpServers: z.array(McpServerConfigSchema).default([]),
    /**
     * This agent's scope over the `capabilities` catalog (#335): what it gets by default, and
     * (`available`) what workflows and nodes may turn on for it. See `capabilities.ts`.
     */
    capabilities: AuthorityCapabilityScopeSchema.optional(),
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
    /** Models this agent offers, as declared in config (#186); applied per run in #187. */
    models: z
      .array(z.object({ id: z.string().min(1), name: z.string(), description: z.string().optional() }))
      .optional(),
    /** The model used when a run selects none; one of `models[].id`. */
    defaultModel: z.string().optional(),
    /**
     * At most this many sessions of this agent open at once, across every run (#873), for a
     * provider or account that limits concurrent use. Absent means unlimited, the default.
     */
    maxSessions: z.number().int().positive().optional(),
  })
  .superRefine((agent, ctx) => {
    if (agent.type === "acp") {
      if (agent.command.length === 0)
        ctx.addIssue({ code: "custom", path: ["command"], message: "an ACP agent needs the command that starts it" });
      for (const key of ["profile", "workflow", "promptVar"] as const)
        if (agent[key] !== undefined)
          ctx.addIssue({ code: "custom", path: [key], message: `${key} applies only to type: orca-daemon` });
      return;
    }
    if (agent.profile === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["profile"],
        message: "an orca-daemon agent needs the remote profile it delegates to",
      });
    if (agent.workflow === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["workflow"],
        message: "an orca-daemon agent needs the remote workflow it runs",
      });
    if (agent.mcpServers.length > 0 || agent.capabilities !== undefined)
      ctx.addIssue({
        code: "custom",
        path: [agent.mcpServers.length > 0 ? "mcpServers" : "capabilities"],
        message: "an orca-daemon agent runs the remote daemon's own agents; give capabilities to those",
      });
  });
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** How a workflow node picks an agent: by id, or by role (resolved from config). */
export const AgentSelectorSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }),
  z.object({ role: z.string().min(1) }),
]);
export type AgentSelector = z.infer<typeof AgentSelectorSchema>;

/**
 * A session configuration option an agent advertises (ACP "Session Config Options"): a model
 * list, a mode, a reasoning level. ORCA's own shape, so the engine does not depend on the SDK's
 * — `normalizeConfigOption` in `@orca/agents` converts. An agent's legacy `modes` arrive here as
 * one select with `category: "mode"`.
 */
export const SessionConfigSelectOptionSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type SessionConfigSelectOption = z.infer<typeof SessionConfigSelectOptionSchema>;

export const SessionConfigSelectGroupSchema = z.object({
  group: z.string(),
  name: z.string(),
  options: z.array(SessionConfigSelectOptionSchema),
});
export type SessionConfigSelectGroup = z.infer<typeof SessionConfigSelectGroupSchema>;

const sessionConfigOptionBase = {
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  /** "mode" | "model" | "model_config" | "thought_level", or an agent's own. */
  category: z.string().optional(),
};

export const SessionConfigOptionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("select"),
    ...sessionConfigOptionBase,
    currentValue: z.string(),
    options: z.union([z.array(SessionConfigSelectOptionSchema), z.array(SessionConfigSelectGroupSchema)]),
  }),
  z.object({ type: z.literal("boolean"), ...sessionConfigOptionBase, currentValue: z.boolean() }),
]);
export type SessionConfigOption = z.infer<typeof SessionConfigOptionSchema>;

/** Every value a select offers, flattening groups. Empty for a boolean. */
export function configOptionValues(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((o) => ("group" in o ? o.options : [o]));
}
