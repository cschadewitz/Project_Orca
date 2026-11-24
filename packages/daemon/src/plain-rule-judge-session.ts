/**
 * The active half of `withPlainRuleJudge` (#701): what a session factory does once the judge is
 * switched on. Kept in its own module, which the package index does not export, so the only way
 * to reach it outside tests is `withPlainRuleJudge`, behind the build switch `PLAIN_RULE_JUDGE_ACTIVE`.
 *
 * - Bounded: preparation gets the run's cancellation and `PLAIN_RULE_JUDGE_PREPARE_MS`, and the
 *   factory stops waiting at either, whether or not the source does. A cancelled run opens no
 *   session on any path; past the deadline the session opens without a judge, and a judge
 *   prepared after it is dropped.
 * - Pinned: the judge settings are the run's own generation's (`origin.review`), and preparation
 *   refuses them when the active generation now says otherwise.
 * - Floors kept: without a judge the session opens with exactly the options it was asked for,
 *   and a session that already carries a judge is never given another.
 */
import { sessionCancelledBeforeOpen, type SessionFactory } from "@orca/engine";
import type {
  PlainRuleJudgeForSession,
  PlainRuleJudgeSource,
  PlainRuleJudgeUnavailableListener,
} from "./plain-rule-judge.js";

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
    const run = origin?.signal ?? new AbortController().signal;
    // A cancelled run opens nothing, on every path below.
    // Not a failed open: the agent was never started, so its health is not marked down.
    const cancelled = () => sessionCancelledBeforeOpen("the run was cancelled while its session was being prepared");
    if (run.aborted) throw cancelled();
    // Never substitute: a session that already carries a judge keeps it.
    if (options.judgePermission !== undefined || options.judgeKinds !== undefined) return open(options);
    const deadline = AbortSignal.timeout(prepareMs);
    const stop = AbortSignal.any([run, deadline]);
    // The wait is bounded here, whether or not the source honours `stop`.
    const prepared = await settledBefore(
      (async () =>
        source.prepare(
          {
            runId,
            agentId: options.agent.id,
            host: options.host,
            secrets: options.secrets,
            pinned: origin?.generationId !== undefined ? { review: origin.review } : undefined,
          },
          stop,
        ))()
        // `prepare` never throws; if one did, it gave no judge.
        .catch((): PlainRuleJudgeForSession => ({ status: "unavailable", reason: "run-not-authorized" })),
      stop,
    );
    if (run.aborted) throw cancelled();
    // Past the deadline, or no answer in time: a judge that turns up late is not used. Without a
    // judge the session is the one the caller asked for, unchanged: every typed rule and the
    // human ask stand.
    if (deadline.aborted || prepared === undefined) {
      onUnavailable?.({ runId, agentId: options.agent.id, reason: "prepare-deadline" });
      return open(options);
    }
    if (prepared.status !== "prepared") {
      if (prepared.reason !== "not-configured")
        onUnavailable?.({ runId, agentId: options.agent.id, reason: prepared.reason });
      return open(options);
    }
    for (const { kind, reason: why } of prepared.kindsUnavailable)
      onUnavailable?.({ runId, agentId: options.agent.id, reason: why, kind });
    return open({ ...options, judgePermission: prepared.judge, judgeKinds: prepared.kinds });
  };
}

/** `work`'s result, or `undefined` once `stop` aborts first; `work` (which must not reject) is left to settle alone. */
async function settledBefore<T>(work: Promise<T>, stop: AbortSignal): Promise<T | undefined> {
  if (stop.aborted) return undefined;
  let onStop!: () => void;
  const stopped = new Promise<undefined>((resolve) => {
    onStop = () => resolve(undefined);
    stop.addEventListener("abort", onStop, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    stop.removeEventListener("abort", onStop);
  }
}
