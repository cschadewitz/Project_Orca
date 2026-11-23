/**
 * The daemon's wiring for the plain-rule review judge (#701, activation item 3a). It prepares one
 * judge per agent session from four owner-controlled pieces and hands it to the session as
 * `judgePermission`:
 *
 * - the judge config, `review.plainRules.judge`, read at each session open;
 * - the key, through the #336 secret lease bound to the run (`secretJudgeCredentials`, with the
 *   run owner's use decision and its synchronous form `bindSecretUse` at the hand-off);
 * - the owner's disclosure grant for that run (`credentialJudgeDisclosure`, #1038);
 * - the daemon's qualified durable budget (`qualifiedJudgeBudget`, #1035).
 *
 * Fail closed. Any missing piece leaves the session without a judge, so its plain-language rules
 * are not consulted and the typed rules decide alone, as before. A judge is prepared only for a
 * run in token mode (loopback keeps no grants), on a local host, and only when the budget is
 * durable.
 *
 * Inactive. `PLAIN_RULE_JUDGE_ACTIVE` is `false`, and `withPlainRuleJudge` passes sessions
 * through untouched while it is. Turning it on is its own reviewed change; nothing here, and no
 * setting, can.
 */
import type { OrcaConfig } from "@orca/core";
import {
  preparePlainRuleJudge,
  secretJudgeCredentials,
  type PlainRuleConnectionRefusal,
  type PreparedPlainRuleJudge,
} from "@orca/agents/review-judge";
import type { AgentHost, SecretUse } from "@orca/agents";
import type { SessionFactory } from "@orca/engine";
import type { AuditSink } from "./auth/audit.js";
import type { CredentialStore } from "./auth/credentials.js";
import { credentialJudgeDisclosure } from "./auth/judge-disclosure.js";
import type { OwnershipStore } from "./auth/ownership.js";
import { RunAccess, type ResourceResolver } from "./auth/resources.js";
import { bindSecretUse, secretUseAuthority, type SecretUseAuthorityOptions } from "./auth/secret-use.js";
import type { QualifiedJudgeBudget } from "./judge-budget.js";

/** Whether sessions are given a plain-rule judge at all. Changed only by the reviewed activation change. */
export const PLAIN_RULE_JUDGE_ACTIVE = false as const;

/** Why a session got no judge: a fixed code, never a value or a provider's words. */
export type PlainRuleJudgeUnavailable =
  | "not-configured"
  | "not-local"
  | "budget-unavailable"
  | "budget-not-durable"
  | "run-not-authorized"
  | PlainRuleConnectionRefusal;

export type PlainRuleJudgeForSession =
  | Extract<PreparedPlainRuleJudge, { status: "prepared" }>
  | { readonly status: "unavailable"; readonly reason: PlainRuleJudgeUnavailable };

export interface PlainRuleJudgeSourceOptions {
  /** The workspace config as it is now; only `review.plainRules.judge` is read. */
  readonly config: () => Pick<OrcaConfig, "review"> | undefined;
  /** The daemon's qualified budget (`qualifiedJudgeBudget({ storeDir, workspaceId })`). */
  readonly budget: () => Promise<QualifiedJudgeBudget>;
  readonly resolver: ResourceResolver;
  readonly ownership: OwnershipStore;
  readonly credentials: Pick<CredentialStore, "currentForPrincipal">;
  readonly audit?: AuditSink | undefined;
}

export interface PlainRuleJudgeSource {
  /** Prepares the judge for one session of one run. Never throws. */
  readonly prepare: (
    session: {
      readonly runId: string;
      readonly agentId: string;
      readonly host: Pick<AgentHost, "id" | "spec">;
      readonly secrets: OrcaConfig["secrets"];
    },
    signal: AbortSignal,
  ) => Promise<PlainRuleJudgeForSession>;
}

const unavailable = (reason: PlainRuleJudgeUnavailable): PlainRuleJudgeForSession =>
  Object.freeze({ status: "unavailable", reason });

/** Token mode only: the run owner's current credentials decide the key's use and the disclosure. */
export function plainRuleJudgeSource(opts: PlainRuleJudgeSourceOptions): PlainRuleJudgeSource {
  const access = new RunAccess(opts.resolver, opts.ownership);
  const authority: SecretUseAuthorityOptions = {
    root: (runId) => access.root(runId),
    owner: (root) => opts.ownership.owner(root),
    verifyOwner: (root, principalId) => opts.ownership.verify(root, principalId),
    principals: (id) => opts.credentials.currentForPrincipal(id),
    audit: opts.audit,
  };
  const secretUse = secretUseAuthority(authority);
  const disclosureFor = credentialJudgeDisclosure({
    resolver: opts.resolver,
    ownership: opts.ownership,
    credentials: opts.credentials,
    audit: opts.audit,
  });
  const prepare: PlainRuleJudgeSource["prepare"] = async (session, signal) => {
    try {
      const judgeConfig = opts.config()?.review?.plainRules?.judge;
      if (judgeConfig === undefined) return unavailable("not-configured");
      // The judge's key is read, and its request sent, from the daemon's own machine.
      if (session.host.spec.type !== "local") return unavailable("not-local");
      const qualified = await opts.budget();
      if (qualified.status !== "durable") return unavailable("budget-unavailable");
      let disclosure, authorizedNow;
      try {
        disclosure = await disclosureFor(session.runId);
        authorizedNow = await bindSecretUse(authority, session.runId);
      } catch {
        return unavailable("run-not-authorized");
      }
      const credentials = secretJudgeCredentials({
        secrets: () => session.secrets,
        host: session.host,
        authorize: (uses: SecretUse[]) => secretUse({ runId: session.runId, uses }),
        authorizedNow,
        agentId: session.agentId,
      });
      const prepared = await preparePlainRuleJudge(
        judgeConfig,
        { credentials, disclosure, budget: qualified.budget },
        signal,
      );
      if (prepared.status !== "prepared") return prepared;
      if (prepared.durableBudget !== true) return unavailable("budget-not-durable");
      return prepared;
    } catch {
      return unavailable("run-not-authorized");
    }
  };
  return Object.freeze({ prepare });
}

/**
 * The session factory with the plain-rule judge bound to each session that can have one. While
 * `PLAIN_RULE_JUDGE_ACTIVE` is false it returns `open` unchanged in behaviour: nothing is prepared,
 * read or sent. `onUnavailable` hears why a session got no judge (for the log), never a value.
 */
export function withPlainRuleJudge(
  open: SessionFactory,
  source: PlainRuleJudgeSource,
  onUnavailable?: (info: { runId: string; agentId: string; reason: PlainRuleJudgeUnavailable }) => void,
): SessionFactory {
  // Read once, here: there is no parameter or setting that turns it on.
  if (!PLAIN_RULE_JUDGE_ACTIVE) return open;
  return async (options) => {
    const runId = options.origin?.runId;
    if (runId === undefined) return open(options);
    const prepared = await source.prepare(
      { runId, agentId: options.agent.id, host: options.host, secrets: options.secrets },
      new AbortController().signal,
    );
    if (prepared.status !== "prepared") {
      if (prepared.reason !== "not-configured")
        onUnavailable?.({ runId, agentId: options.agent.id, reason: prepared.reason });
      return open(options);
    }
    return open({ ...options, judgePermission: prepared.judge });
  };
}
