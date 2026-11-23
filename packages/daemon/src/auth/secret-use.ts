/**
 * The server-verified use decision for secret references (#336, part B). The engine asks it
 * at every session open, after the catalog and host checks and before the host reads
 * anything. See docs/secret-use-authority.md.
 *
 * The decision is about the run's *root* and the principal that durably owns it, and it is
 * made from that principal's credentials as they are now: a revoked or expired credential
 * stops the next open. It never says which credentials exist, and it never sees a value.
 */
import { OrcaError } from "@orca/core";
import type { SecretUse } from "@orca/agents";
import type { AuditSink } from "./audit.js";
import type { CredentialStore } from "./credentials.js";
import type { OwnershipStore } from "./ownership.js";
import { grantCovers, holds, workflowAllowed, isUnrestricted, type Principal } from "./principal.js";
import { RunAccess, type ResourceResolver, type RunRoot } from "./resources.js";

export type SecretUseCheck = (request: { runId: string; uses: SecretUse[] }) => Promise<void>;

export interface SecretUseAuthorityOptions {
  /** The run's root run and its workflow, or `undefined` when its parent chain cannot be read. */
  root(runId: string): Promise<RunRoot | undefined>;
  /** The principal recorded as owning a root run (possibly still pending). */
  owner(rootRunId: string): string | undefined;
  /** Throws unless `principalId` is the root's *durable* owner. Pending attribution is not. */
  verifyOwner(rootRunId: string, principalId: string): Promise<void>;
  /** That principal's current authorities: unrevoked, unexpired, read now. */
  principals(principalId: string): readonly Principal[];
  audit?: AuditSink | undefined;
}

function refuse(use: SecretUse | undefined): OrcaError {
  return new OrcaError(
    "CONFIG_INVALID",
    use
      ? `use of secret '${use.secret}' on host '${use.hostId}' is not granted to this run`
      : "use of secret references is not granted to this run",
    { ...(use ? { secret: use.secret, hostId: use.hostId } : {}), reason: "unauthorized" },
  );
}

/**
 * Whether one authority covers one use: it holds `secrets.use`, its workflow scope includes
 * the run's root workflow, and its grant names the reference with the exact provider and the
 * host it is bound to now.
 */
function covers(principal: Principal, root: RunRoot, use: SecretUse): boolean {
  return (
    holds(principal, "secrets.use") &&
    workflowAllowed(principal.scope, root.workflowId) &&
    grantCovers(principal.secrets, use)
  );
}

export function secretUseAuthority(opts: SecretUseAuthorityOptions): SecretUseCheck {
  return async ({ runId, uses }) => {
    const audit = (outcome: "succeeded" | "denied", principal: string | undefined, reason?: string) =>
      opts.audit?.record({
        at: new Date().toISOString(),
        event: "secret.use",
        transport: "engine",
        ...(principal ? { actor: { principal, kind: "credential" as const } } : {}),
        target: {
          runId: runId.slice(0, 200),
          secrets: [...new Set(uses.map((u) => u.secret))].sort().join(",").slice(0, 200),
        },
        outcome,
        ...(outcome === "denied" ? { code: "CONFIG_INVALID" } : {}),
        ...(reason ? { reason } : {}),
      });
    const root = await opts.root(runId);
    const owner = root === undefined ? undefined : opts.owner(root.rootRunId);
    if (!root || !owner) {
      audit("denied", undefined, root === undefined ? "run root unavailable" : "run has no recorded owner");
      throw refuse(uses[0]);
    }
    try {
      await opts.verifyOwner(root.rootRunId, owner);
    } catch {
      audit("denied", owner, "run ownership is not durable");
      throw refuse(uses[0]);
    }
    const principals = opts.principals(owner).filter((p) => p.id === owner);
    for (const use of uses) {
      if (!principals.some((p) => covers(p, root, use))) {
        audit("denied", owner, principals.length ? `secret '${use.secret}' not granted` : "no current grant");
        throw refuse(use);
      }
    }
    audit("succeeded", owner);
  };
}

/**
 * A synchronous use decision for one run (#701), for a check that must sit in the same turn as
 * the act it guards (a review judge's dispatch). Binding resolves the run's root and verifies its
 * durable owner, which never change for a run, and refuses like `secretUseAuthority` when either
 * fails. The returned check then reads that owner's credentials as they are at each call, so a
 * revoked or expired credential is refused at the next call. It records no audit entry: the
 * awaited `secretUseAuthority` decision made before the read records the use.
 */
export type BoundSecretUseCheck = (uses: SecretUse[]) => boolean;

export async function bindSecretUse(opts: SecretUseAuthorityOptions, runId: string): Promise<BoundSecretUseCheck> {
  const root = await opts.root(runId);
  const owner = root === undefined ? undefined : opts.owner(root.rootRunId);
  if (!root || !owner) throw refuse(undefined);
  try {
    await opts.verifyOwner(root.rootRunId, owner);
  } catch {
    throw refuse(undefined);
  }
  return (uses) => {
    const principals = opts.principals(owner).filter((p) => p.id === owner);
    return uses.every((use) => principals.some((p) => covers(p, root, use)));
  };
}

/**
 * Loopback compatibility mode: every caller is `LOCAL_PRINCIPAL`, which holds every owner
 * permission, so every run may use every reference while the daemon runs in that mode. That
 * mode keeps no ownership records, so there is nothing to verify, and no audit log.
 */
export function loopbackSecretUse(principal: Principal, audit?: AuditSink): SecretUseCheck {
  if (principal.secrets !== "*" || !isUnrestricted(principal.scope))
    throw new Error("loopback secret use needs an unrestricted principal granted every reference");
  return secretUseAuthority({
    root: async (runId) => ({ rootRunId: runId, workflowId: "*" }),
    owner: () => principal.id,
    verifyOwner: async () => {},
    principals: () => [principal],
    audit,
  });
}

/**
 * Token mode: the run's root owner's current credentials decide. A credential counts only
 * while it is unrevoked and unexpired, and the file is read again at every decision.
 */
export function credentialSecretUse(opts: {
  resolver: ResourceResolver;
  ownership: OwnershipStore;
  credentials: Pick<CredentialStore, "currentForPrincipal">;
  audit?: AuditSink | undefined;
}): SecretUseCheck {
  const access = new RunAccess(opts.resolver, opts.ownership);
  return secretUseAuthority({
    root: (runId) => access.root(runId),
    owner: (root) => opts.ownership.owner(root),
    verifyOwner: (root, principalId) => opts.ownership.verify(root, principalId),
    principals: (id) => opts.credentials.currentForPrincipal(id),
    audit: opts.audit,
  });
}
