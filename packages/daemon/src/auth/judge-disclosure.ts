/**
 * The owner-authoritative source of plain-rule judge disclosure grants (#701). A judge prepared for
 * a run may send that run's action evidence to a hosted judge only under a grant the run's root
 * owner holds now: an entry in the `disclosures` of one of that principal's current credentials,
 * naming exactly the destination, provider version and wire format the judge asks for, on a
 * credential whose workflow scope includes the run's root workflow.
 *
 * - Owner-authoritative: grants are written only when an owner issues a credential (`orca auth
 *   issue --judge-disclosure`, which derives the entry from the workspace's judge config). Nothing
 *   here can create or widen one, and no preset includes one.
 * - Current: `find`, `current` and `currentNow` all read the owner's credentials as they are at
 *   that moment (the store re-reads its file), so revoking or expiring the credential, or
 *   reissuing it without the entry, stops the next send. `currentNow` is synchronous, for the
 *   check at the dispatch itself.
 * - Bound: the run's root and its durable owner are resolved once, when the service is bound, and
 *   refused like a secret use when either fails. Loopback compatibility mode keeps no credential
 *   records, so it has no grants and a judge there is always unavailable.
 *
 * A grant reference names the credential and the entry; the revision also covers the credential's
 * expiry. Neither names a value. `find` is audited (`judge.disclosure`); the per-call rechecks
 * are not, as the decision they repeat is already recorded.
 */
import { createHash } from "node:crypto";
import { OrcaError } from "@orca/core";
import type { PlainRuleDisclosureGrant, PlainRuleDisclosureQuery, PlainRuleDisclosureService } from "@orca/agents";
import type { AuditSink } from "./audit.js";
import type { CredentialStore } from "./credentials.js";
import type { OwnershipStore } from "./ownership.js";
import { disclosureGrantEntry, workflowAllowed, type DisclosureGrantEntry, type Principal } from "./principal.js";
import { RunAccess, type ResourceResolver, type RunRoot } from "./resources.js";
import type { SecretUseAuthorityOptions } from "./secret-use.js";

/** A credential without an expiry: its grant lasts until it is revoked. */
export const NO_EXPIRY = "9999-12-31T23:59:59.999Z";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const grantRefOf = (credentialId: string, entry: DisclosureGrantEntry) =>
  `disclosure:${digest(["ref", credentialId, entry]).slice(0, 32)}`;
const revisionOf = (credentialId: string, entry: DisclosureGrantEntry, expiresAt: string) =>
  `r1:${digest(["revision", credentialId, entry, expiresAt]).slice(0, 32)}`;

function refuse(): OrcaError {
  return new OrcaError("CONFIG_INVALID", "judge disclosure is not granted to this run", { reason: "unauthorized" });
}

const isQuery = (q: unknown): q is PlainRuleDisclosureQuery => {
  if (q === null || typeof q !== "object") return false;
  const v = q as Record<string, unknown>;
  return (
    v.purpose === "review-judge" &&
    typeof v.destination === "string" &&
    typeof v.providerVersion === "string" &&
    v.requestSchema === "orca-plain-rule-request/v1"
  );
};

interface Held {
  readonly grantRef: string;
  readonly revision: string;
  readonly expiresAt: string;
  readonly entry: DisclosureGrantEntry;
}

/** Every grant the owner holds now that applies to this run, in a stable order. */
function held(principals: readonly Principal[], owner: string, root: RunRoot): Held[] {
  const out: Held[] = [];
  for (const p of principals) {
    if (p.id !== owner || p.kind !== "credential" || !p.credentialId) continue;
    if (!workflowAllowed(p.scope, root.workflowId)) continue;
    const expiresAt = p.expiresAt ?? NO_EXPIRY;
    for (const entry of p.disclosures ?? [])
      out.push({
        grantRef: grantRefOf(p.credentialId, entry),
        revision: revisionOf(p.credentialId, entry, expiresAt),
        expiresAt,
        entry,
      });
  }
  return out.sort((a, b) => a.grantRef.localeCompare(b.grantRef));
}

/**
 * The disclosure service for one run's judge. Throws (refused, like a secret use) when the run's
 * root or its durable owner cannot be established.
 */
export async function bindJudgeDisclosure(
  opts: Pick<SecretUseAuthorityOptions, "root" | "owner" | "verifyOwner" | "principals" | "audit">,
  runId: string,
): Promise<PlainRuleDisclosureService> {
  const root = await opts.root(runId);
  const owner = root === undefined ? undefined : opts.owner(root.rootRunId);
  if (!root || !owner) throw refuse();
  try {
    await opts.verifyOwner(root.rootRunId, owner);
  } catch {
    throw refuse();
  }
  const principals = opts.principals;
  const now = () => held(principals(owner), owner, root);
  const lookup = (grantRef: unknown) => {
    if (typeof grantRef !== "string") return null;
    const found = now().find((h) => h.grantRef === grantRef);
    return found ? Object.freeze({ revision: found.revision, expiresAt: found.expiresAt }) : null;
  };
  const audit = (outcome: "succeeded" | "denied", destination: string, reason?: string) =>
    opts.audit?.record({
      at: new Date().toISOString(),
      event: "judge.disclosure",
      transport: "engine",
      actor: { principal: owner, kind: "credential" },
      target: { runId: runId.slice(0, 200), destination: destination.slice(0, 200) },
      outcome,
      ...(outcome === "denied" ? { code: "CONFIG_INVALID" } : {}),
      ...(reason ? { reason } : {}),
    });
  return Object.freeze({
    find: async (query: PlainRuleDisclosureQuery): Promise<PlainRuleDisclosureGrant | null> => {
      if (!isQuery(query)) return null;
      const match = now().find((h) => disclosureGrantEntry([h.entry], query) !== undefined);
      if (!match) {
        audit("denied", query.destination, "no current disclosure grant for this destination and provider");
        return null;
      }
      audit("succeeded", query.destination);
      return Object.freeze({
        purpose: query.purpose,
        destination: match.entry.destination,
        providerVersion: match.entry.providerVersion,
        requestSchema: query.requestSchema,
        grantRef: match.grantRef,
        revision: match.revision,
        expiresAt: match.expiresAt,
      });
    },
    current: async (grantRef: string) => lookup(grantRef),
    currentNow: (grantRef: string) => lookup(grantRef),
  });
}

/** Token mode: the run's root owner's current credentials decide, as for secret use. */
export function credentialJudgeDisclosure(opts: {
  resolver: ResourceResolver;
  ownership: OwnershipStore;
  credentials: Pick<CredentialStore, "currentForPrincipal">;
  audit?: AuditSink | undefined;
}): (runId: string) => Promise<PlainRuleDisclosureService> {
  const access = new RunAccess(opts.resolver, opts.ownership);
  return (runId) =>
    bindJudgeDisclosure(
      {
        root: (id) => access.root(id),
        owner: (root) => opts.ownership.owner(root),
        verifyOwner: (root, principalId) => opts.ownership.verify(root, principalId),
        principals: (id) => opts.credentials.currentForPrincipal(id),
        audit: opts.audit,
      },
      runId,
    );
}
