/**
 * The active half of `withPlainRuleJudge` (#701): what a session factory does once the judge is
 * switched on. Kept in its own module, which the package index does not export, so the only way
 * to reach it outside tests is `withPlainRuleJudge`, behind `PLAIN_RULE_JUDGE_ACTIVE`.
 *
 * - Bounded: preparation gets the run's cancellation and `PLAIN_RULE_JUDGE_PREPARE_MS`. A
 *   cancelled run opens no session; a preparation past the deadline opens it without a judge.
 * - Pinned: the judge settings are the run's own generation's (`origin.review`), and preparation
 *   refuses them when the active generation now says otherwise.
 * - Floors kept: without a judge the session opens with exactly the options it was asked for,
 *   and a session that already carries a judge is never given another.
 */
import { OrcaError } from "@orca/core";
import type { SessionFactory } from "@orca/engine";
import type { PlainRuleJudgeSource, PlainRuleJudgeUnavailableListener } from "./plain-rule-judge.js";

/** How long preparing one session's judge may take before the session opens without one. */
export const PLAIN_RULE_JUDGE_PREPARE_MS = 10_000;

export function judgedSessionFactory(
  open: SessionFactory,
  source: PlainRuleJudgeSource,
  onUnavailable?: PlainRuleJudgeUnavailableListener,
  prepareMs: number = PLAIN_RULE_JUDGE_PREPARE_MS,
): SessionFactory {
  return async (options) => {
    const origin = options.origin;
    const runId = origin?.runId;
    if (runId === undefined) return open(options);
    // Never substitute: a session that already carries a judge keeps it.
    if (options.judgePermission !== undefined || options.judgeKinds !== undefined) return open(options);
    const run = origin?.signal ?? new AbortController().signal;
    const deadline = AbortSignal.timeout(prepareMs);
    const prepared = await source.prepare(
      {
        runId,
        agentId: options.agent.id,
        host: options.host,
        secrets: options.secrets,
        pinned: origin?.generationId !== undefined ? { review: origin.review } : undefined,
      },
      AbortSignal.any([run, deadline]),
    );
    // A cancelled run opens nothing, with or without a judge.
    if (run.aborted) throw new OrcaError("CANCELLED", "the run was cancelled while its session was being prepared");
    if (prepared.status !== "prepared") {
      const reason = prepared.reason === "cancelled" && deadline.aborted ? "prepare-deadline" : prepared.reason;
      if (reason !== "not-configured") onUnavailable?.({ runId, agentId: options.agent.id, reason });
      // The session the caller asked for, unchanged: every typed rule and the human ask stand.
      return open(options);
    }
    for (const { kind, reason } of prepared.kindsUnavailable)
      onUnavailable?.({ runId, agentId: options.agent.id, reason, kind });
    return open({ ...options, judgePermission: prepared.judge, judgeKinds: prepared.kinds });
  };
}
