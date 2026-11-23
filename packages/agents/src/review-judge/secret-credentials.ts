/**
 * Bring-your-own-key for review judges (#701) on #336 secret references. This is the judge connection's
 * `JudgeCredentialService` (connection.ts), backed by the `secrets:` catalog, the run-bound #336 use check and the
 * daemon's own machine:
 *
 *   secrets:
 *     judge-key: { host: local, provider: env, name: JUDGE_API_KEY, destination: "https://judge.example" }
 *
 * - Only `provider: env` for now. A file path names a file only lexically, and this version cannot bind delivery
 *   to the file a read actually opens, so a file-backed judge key is refused (config check and use).
 * - Only a secret **pinned** to the judge's destination can be used, and a pinned secret is never delivered to an
 *   agent or MCP server (core `validateSecretReferences`, agents `planSessionSecrets`). Neither use falls back to
 *   the other.
 * - The value is read on the host the judge connection runs on, which must be a local host (the daemon's machine).
 *   A reference bound to any other host is unavailable; there is no fallback to a value found elsewhere.
 * - Every use is asked of the run-bound use check, with the purpose `review-judge` and the pinned destination: only a
 *   grant for that purpose and destination covers it (or `*`), never a grant for delivery to an agent. The full,
 *   awaited check runs before the value is read. Then, after every awaited step including the caller's last one
 *   (`beforeHandoff`, the disclosure grant), the dispatch boundary runs synchronously in the turn that calls the
 *   sender: cancellation, the catalog unchanged since the read, and the grant re-decided from current credentials.
 * - A secret read from the same source as a secret with another pin (or none) is refused, so declaring the same
 *   variable or file twice cannot side-step a pin.
 * - Nothing is cached. The catalog is read again at every describe and every use, and the value at every use, so a
 *   rotated value is picked up and a re-pinned or re-bound reference stops working.
 * - The value reaches only the sender, inside the one `consume` call, as a handle that does not serialize or print
 *   it and stops revealing it once that call settles or the use is cancelled, whichever is first. This makes no
 *   sender trusted: a real network sender is separate work with its own review, and nothing here activates one. Every refusal is a fixed code, never a value or provider text.
 */
import { inspect } from "node:util";
import type { SecretDefinition, SecretSource, SecretsConfig } from "@orca/core";
import { secretSource, sharesPinnedSource } from "@orca/core";
import type { AgentHost } from "../host.js";
import { readLocalSecret } from "../hosts/local-host.js";
import { secretHostBinding, type AuthorizeSecretUse, type SecretUse } from "../secrets.js";
import {
  JUDGE_DISCLOSURE_PURPOSE,
  type JudgeCredential,
  type JudgeCredentialBinding,
  type JudgeCredentialService,
  type JudgeCredentialUse,
  type OpaqueCredentialRef,
} from "./connection.js";

/** The prefix of a credential reference id that names a #336 secret. */
export const JUDGE_SECRET_REF_PREFIX = "secret:";
export const JUDGE_SECRET_CREDENTIAL_KIND = "judge-secret/v1";

/** The opaque reference a judge connection descriptor carries for secret `id`. It holds no value. */
export function judgeSecretRef(id: string): OpaqueCredentialRef {
  return Object.freeze({ kind: "credential-ref/v0" as const, id: `${JUDGE_SECRET_REF_PREFIX}${id}` });
}

/** What the sender receives: a handle that reveals the value only while its one use lasts. */
export interface JudgeSecretCredential {
  readonly kind: typeof JUDGE_SECRET_CREDENTIAL_KIND;
  /** The destination this value is pinned to. A sender for any other destination must refuse it. */
  readonly destination: string;
  /** The value, during the `consume` call it was handed to. Throws after that call settles. */
  readonly reveal: () => string;
}

/** Fixed reasons a use is refused. Never a value, a path's contents or a provider's own words. */
export type JudgeSecretRefusal =
  | "cancelled"
  | "not-a-secret-ref"
  | "undefined"
  | "not-pinned"
  | "wrong-destination"
  | "wrong-purpose"
  | "wrong-host"
  | "unsupported-host"
  | "aliased-source"
  | "reconfigured"
  | "file-unsupported"
  | "unauthorized"
  | "missing";

export class JudgeSecretRefused extends Error {
  constructor(readonly code: JudgeSecretRefusal) {
    super(`judge credential refused: ${code}`);
    this.name = "JudgeSecretRefused";
  }
}

export interface SecretJudgeCredentialOptions {
  /** The secrets catalog as configured now. Read again at every describe and every use. */
  readonly secrets: () => SecretsConfig | undefined;
  /** The host the judge connection runs on: a local host, the daemon's own machine. */
  readonly host: Pick<AgentHost, "id" | "spec">;
  /** The #336 use check bound to the run whose action is judged. Asked before every read. */
  readonly authorize: AuthorizeSecretUse;
  /**
   * The same decision, answered synchronously from the run owner's credentials as they are at that moment (the
   * daemon's `bindSecretUse`). Asked at the hand-off itself, after every awaited check, in the turn that calls
   * the sender: a grant revoked while anything was awaited stops the dispatch.
   */
  readonly authorizedNow: (uses: SecretUse[]) => boolean;
  /** The agent whose action is judged, recorded in the use as a session open records it. */
  readonly agentId: string;
  /** Reads one value on `host`. Defaults to the local host's reader; tests inject a fake. */
  readonly read?: (id: string, source: SecretSource, hostId: string) => Promise<string>;
}

/** The secret id an opaque reference names, or undefined when it is not a #336 secret reference. */
function secretId(ref: OpaqueCredentialRef): string | undefined {
  if (ref === null || typeof ref !== "object" || ref.kind !== "credential-ref/v0" || typeof ref.id !== "string")
    return undefined;
  if (!ref.id.startsWith(JUDGE_SECRET_REF_PREFIX)) return undefined;
  const id = ref.id.slice(JUDGE_SECRET_REF_PREFIX.length);
  return id.length > 0 ? id : undefined;
}

/** A handle for one use. Its value is cleared when the use ends; it never appears in JSON, inspect or a string. */
function leasedCredential(destination: string, value: string) {
  let held: string | undefined = value;
  const credential: JudgeSecretCredential = Object.freeze({
    kind: JUDGE_SECRET_CREDENTIAL_KIND,
    destination,
    reveal: () => {
      if (held === undefined) throw new JudgeSecretRefused("cancelled");
      return held;
    },
    toJSON: () => ({ kind: JUDGE_SECRET_CREDENTIAL_KIND, destination }),
    toString: () => `[${JUDGE_SECRET_CREDENTIAL_KIND}]`,
    [inspect.custom]: () => `[${JUDGE_SECRET_CREDENTIAL_KIND} ${destination}]`,
  });
  return {
    credential,
    end: () => {
      held = undefined;
    },
  };
}

/**
 * The credential service a judge connection resolves its key through. Construct one per run (the use check is
 * bound to it), and pass it to `prepareJudgeConnection` as `credentials`.
 */
export function secretJudgeCredentials(opts: SecretJudgeCredentialOptions): JudgeCredentialService {
  const { host, authorize, agentId } = opts;
  const read = opts.read ?? readLocalSecret;
  const catalog = (): SecretsConfig => opts.secrets() ?? {};
  const lookup = (secrets: SecretsConfig, id: string): SecretDefinition | undefined =>
    Object.hasOwn(secrets, id) ? secrets[id] : undefined;
  const readable = (def: SecretDefinition) => def.host === host.id && host.spec.type === "local";
  /** Exactly where and for what a value is read; any difference between two reads of the catalog is a refusal. */
  const identity = (def: SecretDefinition) => JSON.stringify([def.host, secretSource(def), def.destination ?? null]);

  const describe = async (ref: OpaqueCredentialRef, signal: AbortSignal): Promise<JudgeCredentialBinding | null> => {
    signal.throwIfAborted();
    const id = secretId(ref);
    const secrets = catalog();
    const def = id === undefined ? undefined : lookup(secrets, id);
    if (id === undefined || def === undefined) return null;
    // An unpinned secret has no destination, so the connection refuses it as a destination mismatch.
    return Object.freeze({
      refId: ref.id,
      destination: def.destination ?? "",
      available:
        def.destination !== undefined && def.provider === "env" && readable(def) && !sharesPinnedSource(secrets, id),
    });
  };

  const withCredential = async <T>(
    ref: OpaqueCredentialRef,
    use: JudgeCredentialUse,
    signal: AbortSignal,
    consume: (credential: JudgeCredential) => Promise<T>,
    beforeHandoff?: () => Promise<void>,
  ): Promise<T> => {
    const refuse = (code: JudgeSecretRefusal) => new JudgeSecretRefused(signal.aborted ? "cancelled" : code);

    /** Every check on the catalog as configured now, for this use. Synchronous. */
    const current = (id: string): SecretDefinition & { provider: "env"; destination: string } => {
      const secrets = catalog();
      const def = lookup(secrets, id);
      if (def === undefined) throw refuse("undefined");
      if (def.destination === undefined) throw refuse("not-pinned");
      if (def.provider !== "env") throw refuse("file-unsupported");
      if (sharesPinnedSource(secrets, id)) throw refuse("aliased-source");
      if (use === null || typeof use !== "object" || use.purpose !== JUDGE_DISCLOSURE_PURPOSE)
        throw refuse("wrong-purpose");
      if (typeof use.grantRef !== "string" || use.grantRef.length === 0) throw refuse("wrong-purpose");
      if (use.destination !== def.destination) throw refuse("wrong-destination");
      if (def.host !== host.id) throw refuse("wrong-host");
      if (host.spec.type !== "local") throw refuse("unsupported-host");
      return def as SecretDefinition & { provider: "env"; destination: string };
    };
    /** The use the grant must cover: this purpose and the pinned destination, never agent delivery. */
    const secretUse = (id: string, def: { provider: "env"; destination: string }): SecretUse => ({
      secret: id,
      provider: def.provider,
      hostId: host.id,
      hostBinding: secretHostBinding(host.spec),
      agentId,
      purpose: JUDGE_DISCLOSURE_PURPOSE,
      destination: def.destination,
    });

    if (signal.aborted) throw refuse("cancelled");
    const id = secretId(ref);
    if (id === undefined) throw refuse("not-a-secret-ref");
    const before = current(id);
    // The full check (run root, durable owner, current grant), before the read: an unauthorized use reads nothing.
    try {
      await authorize([secretUse(id, before)]);
    } catch {
      throw refuse("unauthorized");
    }
    if (signal.aborted) throw refuse("cancelled");
    let value: string;
    try {
      value = await read(id, secretSource(before), host.id);
    } catch {
      throw refuse("missing");
    }
    if (signal.aborted) throw refuse("cancelled");
    // The caller's last awaited check (the disclosure grant). Nothing is awaited after it.
    if (beforeHandoff) await beforeHandoff();

    // The dispatch boundary, all synchronous and in the turn that calls `consume`: the catalog is the one the value
    // was read for, the grant covers this use now, and the use is not cancelled.
    if (signal.aborted) throw refuse("cancelled");
    const after = current(id);
    if (identity(after) !== identity(before)) throw refuse("reconfigured");
    if (opts.authorizedNow([secretUse(id, after)]) !== true) throw refuse("unauthorized");
    const lease = leasedCredential(after.destination, value);
    // Cancellation ends the lease at once, even while the sender still holds the handle.
    const end = () => lease.end();
    signal.addEventListener("abort", end, { once: true });
    try {
      return await consume(lease.credential);
    } finally {
      signal.removeEventListener("abort", end);
      lease.end();
    }
  };

  return Object.freeze({ describe, withCredential });
}
