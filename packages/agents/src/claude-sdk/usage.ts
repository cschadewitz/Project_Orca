/**
 * What a Claude Agent SDK session reports about usage and limits (#1127), from what Claude Code
 * itself sends: each turn's token use and estimated cost, the subscription limit status it
 * reports for a claude.ai sign-in, and a limit that ended a turn. ORCA calls no usage endpoint
 * and reads no credentials for any of it (#1118), and keeps no CLI text: only numbers, known
 * limit names and times.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { OrcaError } from "@orca/core";

type ResultMessage = Extract<SDKMessage, { type: "result" }>;

/** A main-loop API call's usage, as an assistant message carries it. */
export interface CallUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
};

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

/** A limit's name for people: `the 5-hour limit`, or `the usage limit` when Claude Code named none. */
export function limitName(info: SDKRateLimitInfo | undefined): string {
  const name = info?.rateLimitType ? LIMIT_NAMES[info.rateLimitType] : undefined;
  return name ? `the ${name} limit` : "the usage limit";
}

/** When a limit resets, as an ISO time, from Claude Code's seconds (or milliseconds) since the epoch. */
export function resetTime(at: number | undefined): string | undefined {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return undefined;
  const ms = at < 1e12 ? at * 1000 : at;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The turn's usage as an ACP `usage_update`: the context the last main-loop call used against
 * the model's window, the session's estimated cost so far, and its token totals per kind.
 * Undefined when Claude Code reported no window to measure against.
 */
export function usageUpdate(
  m: ResultMessage,
  last: CallUsage | undefined,
  model: string | undefined,
): acp.SessionUpdate | undefined {
  const models = Object.entries(m.modelUsage ?? {});
  const window =
    (model !== undefined ? count(m.modelUsage?.[model]?.contextWindow) : 0) ||
    Math.max(0, ...models.map(([, u]) => count(u.contextWindow)));
  if (window === 0) return undefined;
  const used = last
    ? count(last.input_tokens) +
      count(last.cache_read_input_tokens) +
      count(last.cache_creation_input_tokens) +
      count(last.output_tokens)
    : 0;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const [, u] of models) {
    totals.input += count(u.inputTokens);
    totals.output += count(u.outputTokens);
    totals.cacheRead += count(u.cacheReadInputTokens);
    totals.cacheCreation += count(u.cacheCreationInputTokens);
  }
  const cost = typeof m.total_cost_usd === "number" && Number.isFinite(m.total_cost_usd) && m.total_cost_usd >= 0;
  return {
    sessionUpdate: "usage_update",
    used,
    size: window,
    ...(cost ? { cost: { amount: m.total_cost_usd, currency: "USD" } } : {}),
    _meta: { orca: { tokens: totals, costIsEstimate: true } },
  };
}

/**
 * A notice for a limit Claude Code says is close or reached (`allowed_warning`, `rejected`);
 * nothing for `allowed`. Only for a claude.ai sign-in: API keys and cloud providers report none.
 */
export function rateLimitNotice(info: SDKRateLimitInfo): acp.SessionUpdate | undefined {
  if (info.status !== "allowed_warning" && info.status !== "rejected") return undefined;
  const resets = resetTime(info.resetsAt);
  const used =
    typeof info.utilization === "number" && Number.isFinite(info.utilization)
      ? ` (${Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization)}% used)`
      : "";
  const title =
    info.status === "rejected"
      ? `Claude reached ${limitName(info)} of its subscription`
      : `Claude is close to ${limitName(info)} of its subscription${used}`;
  return {
    sessionUpdate: "notice",
    severity: info.status === "rejected" ? "error" : "warning",
    title,
    description: resets ? `It resets at ${resets}.` : "Claude Code did not say when it resets.",
    _meta: {
      orca: {
        rateLimit: {
          status: info.status,
          ...(info.rateLimitType ? { type: info.rateLimitType } : {}),
          ...(resets ? { resetsAt: resets } : {}),
        },
      },
    },
  };
}

/**
 * The step failure for a turn a limit ended: a subscription limit Claude Code reported as
 * reached (with when it resets), or an API rate limit (HTTP 429, an API key's). Undefined when
 * the turn did not end on a limit.
 */
export function usageLimitFailure(
  agentId: string,
  m: ResultMessage,
  o: { rateLimit: SDKRateLimitInfo | undefined; rateLimitedCall: boolean; now: number },
): OrcaError | undefined {
  const failed = m.is_error || m.subtype !== "success";
  if (!failed) return undefined;
  const status = "api_error_status" in m ? m.api_error_status : undefined;
  // The last limit status Claude Code reported stands until it reports another, or its reset passes.
  const resets = resetTime(o.rateLimit?.resetsAt);
  const reached = o.rateLimit?.status === "rejected" && (resets === undefined || Date.parse(resets) > o.now);
  if (!o.rateLimitedCall && status !== 429 && !reached) return undefined;
  if (reached && o.rateLimit) {
    const resetsAt = resetTime(o.rateLimit.resetsAt);
    return new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${agentId}: Claude reached ${limitName(o.rateLimit)} of its subscription, so the step ended. ` +
        (resetsAt
          ? `It resets at ${resetsAt}; run the step again after that.`
          : "Claude Code did not say when it resets; check `/usage` in Claude Code."),
      {
        agentId,
        reason: "usage-limit",
        ...(o.rateLimit.rateLimitType ? { limit: o.rateLimit.rateLimitType } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      },
    );
  }
  return new OrcaError(
    "AGENT_TRANSPORT",
    `agent ${agentId}: Claude's API rate limit was hit (HTTP 429) and Claude Code stopped retrying, so the step ended. ` +
      `Wait a little and run it again.`,
    { agentId, reason: "rate-limit" },
  );
}
