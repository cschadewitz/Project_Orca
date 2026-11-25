/**
 * Who a caller is once the transport has verified them, and what they may do.
 *
 * A principal is always made here, on the server, from a verified credential record or from
 * the explicit loopback compatibility mode. Nothing a caller sends - a params field, a header,
 * a subscription id - ever names one. Three things are kept apart on purpose:
 *
 * - **Authentication** (credentials.ts, transport.ts) decides *which* principal this is.
 * - **Operation authorization** (operations.ts) decides whether that principal may call a
 *   method at all: a permission name per operation, deny by default.
 * - **Resource authorization** (resources.ts, guard.ts) decides which runs, workflows and
 *   artifacts the call may see or touch: a scope per principal.
 */
import { z } from "zod";

/**
 * The operation grants. Each daemon method needs exactly one of these (operations.ts has the
 * inventory); a credential holds a list of them. They are deliberately coarser than methods
 * - a client is granted "read runs", not "call runs.events" - and deliberately finer than
 * "read" and "write": answering a gate, writing a standing permission rule, and editing the
 * configuration are each their own grant, because each is a different thing to trust a
 * client with.
 */
export const PERMISSIONS = [
  /** Explicit opt-in host aggregate telemetry; never included in a preset. */
  "host.telemetry.read",
  /** runs.list/get/events, inputs.list, claims.list, and run notifications on a socket. */
  "runs.read",
  /** artifacts.list/get: artifact metadata and bodies. */
  "artifacts.read",
  /** workflows.list/get and workflows.changed. */
  "workflows.read",
  /** runs.start, and the reserved workflows.validateInputs preflight. */
  "runs.start",
  /** runs.resume and runs.cancel. */
  "runs.control",
  /** inputs.answer for one gate or permission ask: a one-time answer. */
  "inputs.answer",
  /** inputs.answer with `always`: writing a standing permission rule to the sidecar. */
  "permissions.grant",
  /** claims.release. */
  "claims.release",
  /** The nine plan reads and plan.changed. */
  "plan.read",
  /** dependencies.waive, decisions.decide, decisions.reopen, risks.update. */
  "plan.write",
  /** agents.list and agent.changed. */
  "agents.read",
  /** agents.ping: spawns an agent to shake hands with it. */
  "agents.ping",
  /** config.get, which returns the configuration's unredacted bytes, and config.changed. */
  "config.read",
  /** config.set. */
  "config.write",
  /** The update coordinator's maintenance method. */
  "daemon.maintenance",
  /** secrets.list and secrets.check: secret reference metadata, never a value (#336). */
  "secrets.read",
  /** The principal's runs may receive values for the references its `secrets` grant names (#336). */
  "secrets.use",
  /** The principal's runs may be given the catalog MCP servers its `capabilities` grant names (#337). */
  "capabilities.use",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const PermissionSchema = z.enum(PERMISSIONS);

/**
 * Permissions over things that belong to the whole workspace rather than to a run: the
 * configuration, the plan (which links runs across every owner), the agent registry (whose
 * health view names what is claimed), standing permission rules and admission. A principal
 * whose resource scope is restricted cannot hold them - they would show it, or let it change,
 * what its scope hides - so a credential that asks for one is refused at issue and the check
 * refuses it again at call time.
 */
export const WORKSPACE_PERMISSIONS: readonly Permission[] = [
  "permissions.grant",
  "plan.read",
  "plan.write",
  "agents.read",
  "agents.ping",
  "config.read",
  "config.write",
  "daemon.maintenance",
  "secrets.read",
];

/**
 * Which resources a principal's grants apply to.
 *
 * `workflows` limits everything by the *root* workflow id: the workflows it may list, read
 * and launch, and the runs it may see (a run's access is its root run's, so a child running a
 * sub-workflow is reachable exactly when its parent is). `runs` says whether it sees every run
 * of those workflows (`all`) or only the runs it started itself, and their descendants
 * (`owned`). Runs that predate authentication have no owner, so only an `all` principal sees
 * them.
 */
export const ResourceScopeSchema = z.object({
  workflows: z.union([z.literal("*"), z.array(z.string().min(1))]),
  runs: z.enum(["all", "owned"]),
});
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;

export const UNRESTRICTED: ResourceScope = { workflows: "*", runs: "all" };

/**
 * The secret references a principal may use (#336): every one (`*`), or each id together
 * with its provider, the host it is bound to and that host's endpoint binding. A grant does
 * not follow an id the config rebinds to another host or provider, nor a host id pointed at
 * another endpoint. See docs/secret-use-authority.md.
 */
export const SecretGrantSchema = z.union([
  z.literal("*"),
  z.array(
    z
      .object({
        secret: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
        provider: z.enum(["env", "file"]),
        host: z.string().min(1),
        /** The host's endpoint binding when granted (`secretHostBinding`). */
        binding: z.string().regex(/^h1:[0-9a-f]{32}$/),
        /**
         * #701: a grant for a secret pinned to a destination is a review-judge grant for that
         * one destination. It never covers delivery to an agent, and an entry without these
         * (an agent grant) never covers a judge's use.
         */
        purpose: z.literal("review-judge").optional(),
        destination: z.string().min(1).optional(),
        /**
         * A review-judge grant's source binding (`secretSourceBinding`): the variable the value
         * is read from. Rotating the value there is covered; pointing the id elsewhere is not.
         */
        source: z
          .string()
          .regex(/^s1:[0-9a-f]{32}$/)
          .optional(),
      })
      .strict()
      .refine(
        (g) =>
          (g.purpose === undefined) === (g.destination === undefined) &&
          (g.purpose === undefined) === (g.source === undefined),
        { message: "a review-judge grant names its destination and source, and only such a grant does" },
      ),
  ),
]);
export type SecretGrant = z.infer<typeof SecretGrantSchema>;

/**
 * Whether `grant` covers one use: that secret, read by that provider, on that host, for that
 * purpose. An agent use carries no purpose; a review-judge use (#701) carries its destination,
 * and only an entry for the same purpose and destination covers it. `*` covers every use.
 */
export function grantCovers(
  grant: SecretGrant | undefined,
  use: {
    secret: string;
    provider: string;
    hostId: string;
    hostBinding: string;
    purpose?: "review-judge" | undefined;
    destination?: string | undefined;
    sourceBinding?: string | undefined;
  },
): boolean {
  if (grant === undefined) return false;
  return (
    grant === "*" ||
    grant.some(
      (g) =>
        g.secret === use.secret &&
        g.provider === use.provider &&
        g.host === use.hostId &&
        g.binding === use.hostBinding &&
        g.purpose === use.purpose &&
        g.destination === use.destination &&
        g.source === use.sourceBinding,
    )
  );
}

/**
 * What a principal's runs may send to a plain-rule review judge (#701): the owner's approval that
 * the evidence of an action may be disclosed to one destination, through one provider
 * configuration, in one wire format. Each entry is exactly the disclosure query a prepared judge
 * asks for (`plainRuleDisclosureQuery` in `@orca/agents`), so a changed destination, provider,
 * model, prompt or wire format is not covered until it is granted again. There is no wildcard.
 */
/** The request schemas a disclosure grant may name: `PLAIN_RULE_REQUEST_SCHEMAS` in `@orca/agents`. */
export const JUDGE_DISCLOSURE_REQUEST_SCHEMAS = [
  "orca-plain-rule-request/v1", // rename-keep: judge wire format named in issued disclosure grants and hashed into the provider version
  "orca-plain-rule-request/edit/v1", // rename-keep: judge wire format named in issued disclosure grants and hashed into the provider version
  "orca-plain-rule-request/mcp/v1", // rename-keep: judge wire format named in issued disclosure grants and hashed into the provider version
  "orca-plain-rule-request/command/v1", // rename-keep: judge wire format named in issued disclosure grants and hashed into the provider version
] as const;

export const DisclosureGrantSchema = z.array(
  z
    .object({
      purpose: z.literal("review-judge"),
      destination: z.string().min(1).max(2048),
      providerVersion: z.string().regex(/^plain-rule-provider\/v1:sha256:[0-9a-f]{64}$/),
      // One entry per class the owner lets a judge see (#701 per-kind switches): reads and searches,
      // and the experimental edit, MCP and command classes, each its own wire format and grant.
      requestSchema: z.enum(JUDGE_DISCLOSURE_REQUEST_SCHEMAS),
    })
    .strict(),
);
export type DisclosureGrant = z.infer<typeof DisclosureGrantSchema>;
export type DisclosureGrantEntry = DisclosureGrant[number];

/** Whether `grant` names exactly this disclosure: same purpose, destination, provider version and wire format. */
export function disclosureGrantEntry(
  grant: DisclosureGrant | undefined,
  query: { purpose: string; destination: string; providerVersion: string; requestSchema: string },
): DisclosureGrantEntry | undefined {
  return grant?.find(
    (g) =>
      g.purpose === query.purpose &&
      g.destination === query.destination &&
      g.providerVersion === query.providerVersion &&
      g.requestSchema === query.requestSchema,
  );
}

/**
 * The catalog capabilities a principal's runs may be given (#337). A list of entries, each of
 * one kind: an MCP server id together with the host it runs on, that host's endpoint binding
 * and the server's definition digest when granted; a skill id with its content digest; or
 * every entry of one kind (`{ kind, any: true }`). A grant does not follow an id the config
 * points at another command, nor a host id pointed at another endpoint, nor an edited skill.
 *
 * The bare `"*"` keeps the meaning `--mcp-server '*'` first gave it: every catalog **MCP
 * server**, and no skill. A wildcard never crosses kinds by itself: a credential is given
 * every skill only by an explicit `{ kind: "skill", any: true }` entry. See
 * docs/secret-use-authority.md.
 */
export const CapabilityGrantSchema = z.union([
  z.literal("*"),
  z.array(
    z.union([
      z.object({ kind: z.enum(["mcpServer", "skill"]), any: z.literal(true) }).strict(),
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("mcpServer"),
            id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
            host: z.string().min(1),
            binding: z.string().regex(/^h1:[0-9a-f]{32}$/),
            /** `mcpServerDefinitionDigest` of the definition when granted. */
            definition: z.string().regex(/^m1:[0-9a-f]{32}$/),
          })
          .strict(),
        z
          .object({
            kind: z.literal("skill"),
            id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
            /** The skill's content digest when granted: an edited skill is not covered. */
            digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          })
          .strict(),
      ]),
    ]),
  ),
]);
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

/** Every catalog MCP server and every catalog skill, each kind named explicitly. */
export const EVERY_CAPABILITY: CapabilityGrant = [
  { kind: "mcpServer", any: true },
  { kind: "skill", any: true },
];

/** Whether `grant` gives every entry of `kind`. The bare `"*"` gives every server only. */
export function grantsEvery(grant: CapabilityGrant | undefined, kind: "mcpServer" | "skill"): boolean {
  if (grant === undefined) return false;
  if (grant === "*") return kind === "mcpServer";
  return grant.some((g) => g.kind === kind && "any" in g);
}

/**
 * Whether `grant` covers one use. A server: that id, defined that way, on that host and
 * endpoint, and only when its command was checked on that host to be a trusted executable
 * (`TRUSTED_EXECUTABLE_POLICY` in `@orca/agents`: an absolute, canonical, administrator-owned
 * path), so the definition pinned names the program itself rather than whatever a `PATH`
 * search, a working directory, a symbolic link or a writable directory turns up. A skill:
 * that id with exactly that content digest.
 */
export function capabilityGrantCovers(
  grant: CapabilityGrant | undefined,
  use:
    | {
        kind: "mcpServer";
        id: string;
        hostId: string;
        hostBinding: string;
        definition: string;
        trustedExecutable: boolean;
      }
    | { kind: "skill"; id: string; digest: string },
): boolean {
  if (grant === undefined) return false;
  if (grantsEvery(grant, use.kind)) return true;
  if (grant === "*") return false;
  if (use.kind === "skill")
    return grant.some((g) => g.kind === "skill" && "digest" in g && g.id === use.id && g.digest === use.digest);
  return (
    use.trustedExecutable &&
    grant.some(
      (g) =>
        g.kind === "mcpServer" &&
        "definition" in g &&
        g.id === use.id &&
        g.host === use.hostId &&
        g.binding === use.hostBinding &&
        g.definition === use.definition,
    )
  );
}

export function isUnrestricted(scope: ResourceScope): boolean {
  return scope.workflows === "*" && scope.runs === "all";
}

export interface Principal {
  /** Stable across credential rotation: ownership and audit are recorded against this. */
  readonly id: string;
  readonly kind: "credential" | "local";
  /** The credential that authenticated this call, for audit and revocation. Never the secret. */
  readonly credentialId?: string | undefined;
  readonly permissions: ReadonlySet<Permission>;
  readonly scope: ResourceScope;
  /** The secret references this principal may use; none when absent (#336). */
  readonly secrets?: SecretGrant | undefined;
  /** The catalog capabilities this principal's runs may be given; none when absent (#337). */
  readonly capabilities?: CapabilityGrant | undefined;
  /** What this principal's runs may disclose to a plain-rule review judge; none when absent (#701). */
  readonly disclosures?: DisclosureGrant | undefined;
  /** When the credential behind this principal expires, if it does (ISO). */
  readonly expiresAt?: string | undefined;
}

/**
 * Whether the principal holds `permission`, with the workspace rule applied: a restricted
 * principal never holds a workspace-wide permission, whatever its record says.
 */
export function holds(principal: Principal, permission: Permission): boolean {
  if (!principal.permissions.has(permission)) return false;
  return !WORKSPACE_PERMISSIONS.includes(permission) || isUnrestricted(principal.scope);
}

/** The root of an inline graph id (`parent::node`) - what a workflow allowlist names. */
export function rootWorkflowId(workflowId: string): string {
  return workflowId.split("::")[0]!;
}

export function workflowAllowed(scope: ResourceScope, workflowId: string): boolean {
  return scope.workflows === "*" || scope.workflows.includes(rootWorkflowId(workflowId));
}

/**
 * Named grant sets, expanded when a credential is issued so a record always says exactly
 * what it grants. A later change to a preset changes no existing credential.
 */
export const PRESETS = {
  /** Existing operator authority, excluding explicit opt-in host telemetry. Local bootstrap credential. */
  owner: {
    permissions: PERMISSIONS.filter((p) => p !== "host.telemetry.read"),
    scope: UNRESTRICTED,
    secrets: "*",
    capabilities: EVERY_CAPABILITY,
  },
  /** Drive and watch every run, plan and agent; no configuration, standing rules or admission. */
  operator: {
    permissions: [
      "runs.read",
      "artifacts.read",
      "workflows.read",
      "runs.start",
      "runs.control",
      "inputs.answer",
      "claims.release",
      "plan.read",
      "plan.write",
      "agents.read",
      "agents.ping",
    ],
    scope: UNRESTRICTED,
  },
  /** Watch everything except the configuration's raw bytes; change nothing. */
  viewer: {
    permissions: ["runs.read", "artifacts.read", "workflows.read", "plan.read", "agents.read"],
    scope: UNRESTRICTED,
  },
  /**
   * A bounded client - an adapter or a bot: launch workflows and steer and answer the runs it
   * launched, and see nothing else. Narrow `workflows` at issue time to bound it further.
   */
  client: {
    permissions: ["runs.read", "artifacts.read", "workflows.read", "runs.start", "runs.control", "inputs.answer"],
    scope: { workflows: "*", runs: "owned" },
  },
} as const satisfies Record<
  string,
  { permissions: readonly Permission[]; scope: ResourceScope; secrets?: SecretGrant; capabilities?: CapabilityGrant }
>;
export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

/**
 * The principal the explicit loopback compatibility mode speaks for. It is the owner, because
 * that mode is exactly the pre-authentication daemon - every local process could do
 * everything - kept available for a supervisor that has not been migrated yet, and only on
 * loopback (transport.ts refuses it anywhere else).
 */
export const LOCAL_PRINCIPAL: Principal = {
  id: "local-unauthenticated",
  kind: "local",
  permissions: new Set(PRESETS.owner.permissions),
  scope: UNRESTRICTED,
  secrets: "*",
  capabilities: EVERY_CAPABILITY,
};
