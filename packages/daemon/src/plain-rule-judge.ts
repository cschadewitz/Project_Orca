/**
 * The daemon's wiring for the plain-rule review judge (#701, activation item 3a). It prepares one
 * judge per agent session from four owner-controlled pieces and hands it to the session as
 * `judgePermission`:
 *
 * - the judge config, `review.plainRules`, from the configuration generation the run is bound to
 *   (#883 pins a run to one), and only while the active generation still says the same: a run
 *   started under other judge settings gets no judge rather than either set silently;
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
 * Bounded. Preparation stops when the run is cancelled (and the session is then not opened at
 * all) or when `PLAIN_RULE_JUDGE_PREPARE_MS` passes (the session opens without a judge).
 *
 * The fallback keeps every floor. A session that gets no judge opens with exactly the options it
 * was asked for: the typed deny and ask rules, the default policy and the human ask all stand, and
 * nothing the judge would only have added is replaced by an allow. A session already carrying a
 * judge (`judgePermission` or `judgeKinds`) is passed through untouched; this never substitutes one.
 *
 * Inactive. `PLAIN_RULE_JUDGE_ACTIVE` is `false`, and `withPlainRuleJudge` passes sessions
 * through untouched while it is. Turning it on is its own reviewed change; nothing here, and no
 * setting, can.
 */
import { isDeepStrictEqual } from "node:util";
import type { OrcaConfig } from "@orca/core";
import {
  preparePlainRuleJudge,
  secretJudgeCredentials,
  type JudgePermission,
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
import { judgedSessionFactory } from "./plain-rule-judge-session.js";

/** Whether sessions are given a plain-rule judge at all. Changed only by the reviewed activation change. */
export const PLAIN_RULE_JUDGE_ACTIVE = false as const;
export { PLAIN_RULE_JUDGE_PREPARE_MS } from "./plain-rule-judge-session.js";

/** Why a session got no judge: a fixed code, never a value or a provider's words. */
export type PlainRuleJudgeUnavailable =
  | "not-configured"
  | "not-local"
  | "budget-unavailable"
  | "budget-not-durable"
  | "run-not-authorized"
  /** The run is bound to no configuration generation, so there are no pinned judge settings. */
  | "config-not-pinned"
  /** The run's pinned judge settings differ from the active generation's. */
  | "config-changed"
  /** Preparation ran past `PLAIN_RULE_JUDGE_PREPARE_MS`. */
  | "prepare-deadline"
  | PlainRuleConnectionRefusal;

export type PlainRuleJudgeForSession =
  | (Extract<PreparedPlainRuleJudge, { status: "prepared" }> & {
      /**
       * The experimental classes the config turns on (#701 per-kind switches), each prepared with its own
       * disclosure grant. A class whose preparation failed is absent, and its calls take the existing path.
       */
      readonly kinds: {
        readonly edit?: JudgePermission;
        readonly mcp?: JudgePermission;
        readonly command?: JudgePermission;
      };
      /** Each class that was turned on but could not be prepared, and why. */
      readonly kindsUnavailable: readonly { readonly kind: KindSwitch; readonly reason: PlainRuleJudgeUnavailable }[];
    })
  | { readonly status: "unavailable"; readonly reason: PlainRuleJudgeUnavailable };

/** The config's names for the experimental classes, and the class each one is. */
const KIND_SWITCHES = { edits: "edit", mcpCalls: "mcp", commands: "command" } as const;
export type KindSwitch = keyof typeof KIND_SWITCHES;

export interface PlainRuleJudgeSourceOptions {
  /**
   * The active generation's config (`generations.effectiveConfig()`), never the boot config. Only
   * `review.plainRules` is read, and only to check the run's pinned settings still match it.
   */
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
      /** Whether the run is bound to a configuration generation, and that generation's `review`. */
      readonly pinned: { readonly review: OrcaConfig["review"] } | undefined;
    },
    /** The run's cancellation combined with the preparation deadline. */
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
      if (signal.aborted) return unavailable("cancelled");
      if (session.pinned === undefined) {
        // Nothing pinned to read: say so only when a judge is configured at all.
        return opts.config()?.review?.plainRules?.judge === undefined
          ? unavailable("not-configured")
          : unavailable("config-not-pinned");
      }
      const plainRules = session.pinned.review?.plainRules;
      const judgeConfig = plainRules?.judge;
      if (judgeConfig === undefined) return unavailable("not-configured");
      // The run's own settings, and only while the active generation still has the same ones.
      if (!isDeepStrictEqual(plainRules, opts.config()?.review?.plainRules)) return unavailable("config-changed");
      // The judge's key is read, and its request sent, from the daemon's own machine.
      if (session.host.spec.type !== "local") return unavailable("not-local");
      const qualified = await untilAborted(opts.budget(), signal);
      if (qualified === aborted) return unavailable("cancelled");
      if (qualified.status !== "durable") return unavailable("budget-unavailable");
      let disclosure, authorizedNow;
      try {
        disclosure = await untilAborted(disclosureFor(session.runId), signal);
        if (disclosure === aborted) return unavailable("cancelled");
        authorizedNow = await untilAborted(bindSecretUse(authority, session.runId), signal);
        if (authorizedNow === aborted) return unavailable("cancelled");
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
      // The experimental classes, each off unless the config turns it on, and each its own grant.
      const switches = plainRules?.experimental?.kinds ?? {};
      const kinds: { edit?: JudgePermission; mcp?: JudgePermission; command?: JudgePermission } = {};
      const kindsUnavailable: { kind: KindSwitch; reason: PlainRuleJudgeUnavailable }[] = [];
      for (const [name, actionClass] of Object.entries(KIND_SWITCHES) as [KindSwitch, keyof typeof kinds][]) {
        if (switches[name] !== true) continue;
        const one = await preparePlainRuleJudge(
          judgeConfig,
          { credentials, disclosure, budget: qualified.budget },
          signal,
          actionClass,
        );
        if (one.status !== "prepared") kindsUnavailable.push({ kind: name, reason: one.reason });
        else if (one.durableBudget !== true) kindsUnavailable.push({ kind: name, reason: "budget-not-durable" });
        else kinds[actionClass] = one.judge;
      }
      if (signal.aborted) return unavailable("cancelled");
      return Object.freeze({
        ...prepared,
        kinds: Object.freeze(kinds),
        kindsUnavailable: Object.freeze(kindsUnavailable),
      });
    } catch {
      return unavailable(signal.aborted ? "cancelled" : "run-not-authorized");
    }
  };
  return Object.freeze({ prepare });
}

const aborted: unique symbol = Symbol("aborted");

/** Settles with `work`, or with `aborted` as soon as `signal` aborts; `work` is left to settle alone. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof aborted> {
  work.catch(() => undefined);
  if (signal.aborted) return Promise.resolve(aborted);
  let onAbort!: () => void;
  const stopped = new Promise<typeof aborted>((resolve) => {
    onAbort = () => resolve(aborted);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, stopped]).finally(() => signal.removeEventListener("abort", onAbort));
}

export type PlainRuleJudgeUnavailableListener = (info: {
  runId: string;
  agentId: string;
  reason: PlainRuleJudgeUnavailable;
  /** Set when one experimental class could not be prepared; the read judge was. */
  kind?: KindSwitch;
}) => void;

/**
 * The session factory with the plain-rule judge bound to each session that can have one. While
 * `PLAIN_RULE_JUDGE_ACTIVE` is false it returns `open` unchanged in behaviour: nothing is prepared,
 * read or sent. `onUnavailable` hears why a session got no judge (for the log), never a value.
 */
export function withPlainRuleJudge(
  open: SessionFactory,
  source: PlainRuleJudgeSource,
  onUnavailable?: PlainRuleJudgeUnavailableListener,
): SessionFactory {
  // Read once, here: there is no parameter or setting that turns it on.
  if (!PLAIN_RULE_JUDGE_ACTIVE) return open;
  return judgedSessionFactory(open, source, onUnavailable);
}
