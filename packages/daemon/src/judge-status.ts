/**
 * `judge.status` (#701): where the plain-language rule judge's setup stands, for the app's
 * setup checklist. Read-only: it creates no budget, takes no lock, reads no key and sends
 * nothing. It answers from the active generation's configuration (as the judge itself checks a
 * run's pinned settings against), the caller's own current credentials, and a read-only
 * inspection of the budget.
 *
 * A grant row says whether one of the caller's current credentials holds the disclosure entry
 * the judge would ask for that kind, as configured now. It does not look at a credential's
 * workflow scope: a run whose workflow a grant does not cover still gets no judge.
 */
import {
  judgeSecretRef,
  plainRuleDisclosureQuery,
  secretJudgeCredentials,
  type PlainRuleActionClass,
} from "@orca/agents/review-judge";
import type { HostSpec, OrcaConfig } from "@orca/core";
import type { JudgeBudgetStatus, JudgeGrantStatus, JudgeKeyState, JudgeKind, JudgeStatusResult } from "@orca/protocol";
import { disclosureGrantEntry, type Principal } from "./auth/principal.js";
import type { JudgeBudgetInspection } from "./judge-budget.js";
import { PLAIN_RULE_JUDGE_ACTIVE } from "./plain-rule-judge.js";

/** Each kind, its action class, and the config switch that turns it on (`reads` needs none). */
const KINDS: readonly {
  kind: JudgeKind;
  actionClass: PlainRuleActionClass;
  flag?: "edits" | "mcpCalls" | "commands";
}[] = [
  { kind: "reads", actionClass: "read" },
  { kind: "edits", actionClass: "edit", flag: "edits" },
  { kind: "mcpCalls", actionClass: "mcp", flag: "mcpCalls" },
  { kind: "commands", actionClass: "command", flag: "commands" },
];

export interface JudgeStatusInputs {
  /** The active generation's configuration. */
  readonly config: Pick<OrcaConfig, "review"> | undefined;
  /**
   * Whether the configured key could be used and is there now (`judgeKeyStatus`), or `withheld`
   * when the caller may not see that secret reference (`secrets.read` and its grant).
   */
  readonly key: JudgeKeyState;
  /** `token`: the caller's current credentials (`currentForPrincipal`); loopback keeps none. */
  readonly auth:
    | { readonly mode: "token"; readonly principal: string; readonly principals: readonly Principal[] }
    | { readonly mode: "loopback" };
  readonly budget: JudgeBudgetInspection;
}

export function judgeStatus(inputs: JudgeStatusInputs): JudgeStatusResult {
  const plainRules = inputs.config?.review?.plainRules;
  const judge = plainRules?.judge;
  const base = {
    active: PLAIN_RULE_JUDGE_ACTIVE as boolean,
    auth: inputs.auth.mode,
    ...(inputs.auth.mode === "token" ? { principal: inputs.auth.principal } : {}),
    budget: budgetStatus(inputs.budget),
  };
  if (judge === undefined) return { ...base, config: { state: "none" }, grants: [] };
  const read = plainRuleDisclosureQuery(judge, "read");
  const fields = judge as { provider?: { kind?: unknown }; credential?: unknown };
  if (read === undefined || typeof fields.provider?.kind !== "string" || typeof fields.credential !== "string")
    return { ...base, config: { state: "invalid" }, grants: [] };
  const held = inputs.auth.mode === "token" ? inputs.auth.principals.filter((p) => p.kind === "credential") : [];
  const switches = plainRules?.experimental?.kinds ?? {};
  const grants: JudgeGrantStatus[] = KINDS.map(({ kind, actionClass, flag }) => {
    const query = plainRuleDisclosureQuery(judge, actionClass);
    return {
      kind,
      enabled: flag === undefined || switches[flag] === true,
      granted: query !== undefined && held.some((p) => disclosureGrantEntry(p.disclosures, query) !== undefined),
    };
  });
  return {
    ...base,
    config: {
      state: "configured",
      provider: fields.provider.kind,
      destination: read.destination,
      credential: fields.credential,
      key: inputs.key,
    },
    grants,
  };
}

function budgetStatus(inspection: JudgeBudgetInspection): JudgeBudgetStatus {
  if (inspection.status === "unavailable") return { state: "unsupported", reason: inspection.reason };
  const budget = inspection.budget;
  if (budget.state === "uninitialized") return { state: "uninitialized" };
  if (budget.state === "ready") return { state: "ready", firstDaySpent: budget.firstDaySpent };
  return { state: "refused" };
}

export type JudgeKeyStatus = JudgeKeyState;

/**
 * Whether the judge's key could be used, and whether it is there now, without reading or keeping
 * it and without contacting the provider. Usability is the runtime's own metadata check
 * (`secretJudgeCredentials(...).describe`, as preparation runs it): the reference exists, is
 * pinned to this judge's destination, is an environment variable read on a local host, and
 * shares its source with no other pinned reference. Only a usable reference is then checked for
 * presence (set and non-empty). Never called for a caller who may not see the reference.
 */
export async function judgeKeyStatus(
  config: Pick<OrcaConfig, "review" | "secrets" | "hosts"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JudgeKeyState> {
  const judge = config?.review?.plainRules?.judge;
  const credential = (judge as { credential?: unknown } | undefined)?.credential;
  const query = plainRuleDisclosureQuery(judge);
  if (typeof credential !== "string" || query === undefined) return "not-found";
  const secrets = config?.secrets ?? {};
  const def = Object.hasOwn(secrets, credential) ? secrets[credential] : undefined;
  if (def === undefined) return "not-found";
  // The judge reads its key on a local host; a reference bound elsewhere is unusable, not probed.
  const spec = config?.hosts.find((h) => h.id === def.host) ?? { id: def.host, type: "ssh" as const, host: "" };
  const refuse = () => Promise.reject(new Error("judge.status never authorizes a use"));
  const binding = await secretJudgeCredentials({
    secrets: () => secrets,
    host: { id: def.host, spec: spec as HostSpec },
    authorize: refuse,
    authorizedNow: () => false,
    agentId: "judge-status",
  }).describe(judgeSecretRef(credential), new AbortController().signal);
  if (binding === null) return "not-found";
  if (binding.destination !== query.destination) return "destination-mismatch";
  if (binding.available !== true || def.provider !== "env") return "unusable";
  const value = env[def.name];
  return value !== undefined && value !== "" ? "present" : "missing";
}
