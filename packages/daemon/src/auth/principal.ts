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
      })
      .strict(),
  ),
]);
export type SecretGrant = z.infer<typeof SecretGrantSchema>;

/** Whether `grant` covers one use: that secret, read by that provider, on that host. */
export function grantCovers(
  grant: SecretGrant | undefined,
  use: { secret: string; provider: string; hostId: string; hostBinding: string },
): boolean {
  if (grant === undefined) return false;
  return (
    grant === "*" ||
    grant.some(
      (g) =>
        g.secret === use.secret &&
        g.provider === use.provider &&
        g.host === use.hostId &&
        g.binding === use.hostBinding,
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
  { permissions: readonly Permission[]; scope: ResourceScope; secrets?: SecretGrant }
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
};
