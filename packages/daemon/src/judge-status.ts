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
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { plainRuleDisclosureQuery, type PlainRuleActionClass } from "@orca/agents/review-judge";
import type { OrcaConfig } from "@orca/core";
import type { JudgeBudgetStatus, JudgeGrantStatus, JudgeKind, JudgeStatusResult } from "@orca/protocol";
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
  /** Whether the configured key is there now (`judgeKeyStatus`); only read when a judge is configured. */
  readonly key: JudgeKeyStatus;
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

export type JudgeKeyStatus = "present" | "missing" | "not-found" | "not-local";

/**
 * Whether the judge's key is there now, on the daemon's own machine, without reading or keeping
 * it: an environment variable is checked for being set and non-empty, a file for being a
 * readable, non-empty regular file. A reference bound to a host that is not local is not probed.
 */
export async function judgeKeyStatus(
  config: Pick<OrcaConfig, "review" | "secrets" | "hosts"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JudgeKeyStatus> {
  const credential = (config?.review?.plainRules?.judge as { credential?: unknown } | undefined)?.credential;
  const ref = typeof credential === "string" ? config?.secrets?.[credential] : undefined;
  if (ref === undefined) return "not-found";
  if (config?.hosts.find((host) => host.id === ref.host)?.type !== "local") return "not-local";
  if (ref.provider === "env") {
    const value = env[ref.name];
    return value !== undefined && value !== "" ? "present" : "missing";
  }
  try {
    await access(ref.path, constants.R_OK);
    const info = await stat(ref.path);
    return info.isFile() && info.size > 0 ? "present" : "missing";
  } catch {
    return "missing";
  }
}
