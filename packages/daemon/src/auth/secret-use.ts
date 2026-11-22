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
import { grantCovers, holds, type Principal } from "./principal.js";
import { RunAccess, type ResourceResolver } from "./resources.js";

export type SecretUseCheck = (request: { runId: string; uses: SecretUse[] }) => Promise<void>;

export interface SecretUseAuthorityOptions {
  /** The run's root run id, or `undefined` when its parent chain cannot be read. */
  root(runId: string): Promise<string | undefined>;
  /** The principal that durably owns a root run. */
  owner(rootRunId: string): string | undefined;
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
    const owner = root === undefined ? undefined : opts.owner(root);
    if (!owner) {
      audit("denied", undefined, root === undefined ? "run root unavailable" : "run has no recorded owner");
      throw refuse(uses[0]);
    }
    const principals = opts.principals(owner).filter((p) => p.id === owner && holds(p, "secrets.use"));
    for (const use of uses) {
      if (!principals.some((p) => grantCovers(p.secrets, use.secret, use.hostId))) {
        audit("denied", owner, principals.length ? `secret '${use.secret}' not granted` : "no current grant");
        throw refuse(use);
      }
    }
    audit("succeeded", owner);
  };
}

/**
 * Loopback compatibility mode: every caller is `LOCAL_PRINCIPAL`, which holds every owner
 * permission, so every run may use every reference while the daemon runs in that mode.
 */
export function loopbackSecretUse(principal: Principal, audit?: AuditSink): SecretUseCheck {
  return secretUseAuthority({
    root: async (runId) => runId,
    owner: () => principal.id,
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
    root: async (runId) => (await access.root(runId))?.rootRunId,
    owner: (root) => opts.ownership.owner(root),
    principals: (id) => opts.credentials.currentForPrincipal(id),
    audit: opts.audit,
  });
}
