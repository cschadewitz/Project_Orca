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
import type { CapabilityUse, CapabilityUseCheck, SecretUse } from "@orca/agents";
import type { AuditSink } from "./audit.js";
import type { CredentialStore } from "./credentials.js";
import type { OwnershipStore } from "./ownership.js";
import {
  capabilityGrantCovers,
  grantsEvery,
  grantCovers,
  holds,
  workflowAllowed,
  isUnrestricted,
  type Principal,
} from "./principal.js";
import { RunAccess, type ResourceResolver, type RunRoot } from "./resources.js";

export type SecretUseCheck = (request: { runId: string; uses: SecretUse[] }) => Promise<void>;
export type { CapabilityUseCheck };

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

function refuseCapability(use: CapabilityUse | undefined): OrcaError {
  if (use?.kind === "skill")
    return new OrcaError("CONFIG_INVALID", `skill '${use.id}' is not granted to this run`, {
      kind: use.kind,
      id: use.id,
      reason: "unauthorized",
    });
  return new OrcaError(
    "CONFIG_INVALID",
    use
      ? `MCP server '${use.id}' on host '${use.hostId}' is not granted to this run${
          use.trustedExecutable
            ? ""
            : ": a grant naming one server covers it only when its command is an absolute, canonical path to an executable that only root or the agent's account can change (see docs/secret-use-authority.md)"
        }`
      : "catalog capabilities are not granted to this run",
    { ...(use ? { kind: use.kind, id: use.id, hostId: use.hostId } : {}), reason: "unauthorized" },
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

/**
 * The same for a catalog capability: `capabilities.use`, the workflow, and a grant naming it
 * (a narrow one only for a server whose command is a trusted executable on that host).
 */
function coversCapability(principal: Principal, root: RunRoot, use: CapabilityUse): boolean {
  return (
    holds(principal, "capabilities.use") &&
    workflowAllowed(principal.scope, root.workflowId) &&
    capabilityGrantCovers(principal.capabilities, use)
  );
}

/**
 * The decision both checks share: the run's root, its durable owner, and that owner's current
 * authorities, one of which must cover every use. Audited once per decision.
 */
function useDecision<U>(
  opts: SecretUseAuthorityOptions,
  kind: {
    event: "secret.use" | "capability.use";
    names: (uses: U[]) => Record<string, string>;
    covers: (principal: Principal, root: RunRoot, use: U) => boolean;
    refuse: (use: U | undefined) => OrcaError;
    missing: (use: U) => string;
    /**
     * One credential must cover every use together, not each use on its own. Catalog
     * servers are a session's selected set, granted as one; secret uses keep their
     * documented per-use rule.
     */
    together?: boolean;
  },
) {
  return async ({ runId, uses }: { runId: string; uses: U[] }) => {
    const audit = (outcome: "succeeded" | "denied", principal: string | undefined, reason?: string) =>
      opts.audit?.record({
        at: new Date().toISOString(),
        event: kind.event,
        transport: "engine",
        ...(principal ? { actor: { principal, kind: "credential" as const } } : {}),
        target: { runId: runId.slice(0, 200), ...kind.names(uses) },
        outcome,
        ...(outcome === "denied" ? { code: "CONFIG_INVALID" } : {}),
        ...(reason ? { reason } : {}),
      });
    const root = await opts.root(runId);
    const owner = root === undefined ? undefined : opts.owner(root.rootRunId);
    if (!root || !owner) {
      audit("denied", undefined, root === undefined ? "run root unavailable" : "run has no recorded owner");
      throw kind.refuse(uses[0]);
    }
    try {
      await opts.verifyOwner(root.rootRunId, owner);
    } catch {
      audit("denied", owner, "run ownership is not durable");
      throw kind.refuse(uses[0]);
    }
    const principals = opts.principals(owner).filter((p) => p.id === owner);
    if (kind.together) {
      if (!principals.some((p) => uses.every((use) => kind.covers(p, root, use)))) {
        // Name the first use no single credential covers alongside the rest, if any.
        const first = uses.find((use) => !principals.some((p) => kind.covers(p, root, use))) ?? uses[0];
        audit(
          "denied",
          owner,
          !principals.length
            ? "no current grant"
            : first && !principals.some((p) => kind.covers(p, root, first))
              ? kind.missing(first)
              : "no single credential grants the whole set",
        );
        throw kind.refuse(first);
      }
      audit("succeeded", owner);
      return;
    }
    for (const use of uses) {
      if (!principals.some((p) => kind.covers(p, root, use))) {
        audit("denied", owner, principals.length ? kind.missing(use) : "no current grant");
        throw kind.refuse(use);
      }
    }
    audit("succeeded", owner);
  };
}

const joined = (ids: string[]) => [...new Set(ids)].sort().join(",").slice(0, 200);

export function secretUseAuthority(opts: SecretUseAuthorityOptions): SecretUseCheck {
  return useDecision<SecretUse>(opts, {
    event: "secret.use",
    names: (uses) => ({ secrets: joined(uses.map((u) => u.secret)) }),
    covers,
    refuse,
    missing: (use) => `secret '${use.secret}' not granted`,
  });
}

/**
 * The use decision for catalog MCP servers (#337), asked at every session open that would
 * give an agent one. Same root, owner and current-credential rules as secrets.
 */
export function capabilityUseAuthority(opts: SecretUseAuthorityOptions): CapabilityUseCheck {
  return useDecision<CapabilityUse>(opts, {
    event: "capability.use",
    names: (uses) => {
      const servers = uses.filter((u) => u.kind === "mcpServer").map((u) => u.id);
      const skills = uses.filter((u) => u.kind === "skill").map((u) => u.id);
      return {
        ...(servers.length || !skills.length ? { mcpServers: joined(servers) } : {}),
        ...(skills.length ? { skills: joined(skills) } : {}),
      };
    },
    covers: coversCapability,
    refuse: refuseCapability,
    missing: (use) => `${use.kind === "skill" ? "skill" : "MCP server"} '${use.id}' not granted`,
    together: true,
  });
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

/** Loopback compatibility mode for catalog capabilities (#337): every run may be given every one. */
export function loopbackCapabilityUse(principal: Principal, audit?: AuditSink): CapabilityUseCheck {
  if (
    !grantsEvery(principal.capabilities, "mcpServer") ||
    !grantsEvery(principal.capabilities, "skill") ||
    !isUnrestricted(principal.scope)
  )
    throw new Error("loopback capability use needs an unrestricted principal granted every capability");
  return capabilityUseAuthority({
    root: async (runId) => ({ rootRunId: runId, workflowId: "*" }),
    owner: () => principal.id,
    verifyOwner: async () => {},
    principals: () => [principal],
    audit,
  });
}

/** Token mode for catalog capabilities (#337): the run's root owner's current credentials decide. */
export function credentialCapabilityUse(opts: {
  resolver: ResourceResolver;
  ownership: OwnershipStore;
  credentials: Pick<CredentialStore, "currentForPrincipal">;
  audit?: AuditSink | undefined;
}): CapabilityUseCheck {
  const access = new RunAccess(opts.resolver, opts.ownership);
  return capabilityUseAuthority({
    root: (runId) => access.root(runId),
    owner: (root) => opts.ownership.owner(root),
    verifyOwner: (root, principalId) => opts.ownership.verify(root, principalId),
    principals: (id) => opts.credentials.currentForPrincipal(id),
    audit: opts.audit,
  });
}
