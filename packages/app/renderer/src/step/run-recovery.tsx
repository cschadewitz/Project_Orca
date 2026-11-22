/**
 * `RunRecovery` — how a stopped run could be recovered, and the two writes that do it (#357).
 *
 * It sits in the run summary (no step selected), below the run's error, and draws exactly what
 * `runs.recovery` answers: the three options with why each is or is not available, the steps
 * whose effect outside ORCA nobody can confirm, and the checkpoints a new attempt could start
 * after. Nothing here guesses: a sentence about a blocker is the daemon's own, from
 * `RECOVERY_BLOCKER_TEXT`, and an option the daemon calls blocked has no button.
 *
 * The two writes:
 *
 * - **Review an uncertain step.** `Mark to run again` says the person checked what the step did
 *   and it may repeat; `Abandon the run` ends the run there. Abandoning cannot be taken back, so
 *   its button arms first and names the step in its confirmation.
 * - **Start a checkpoint attempt.** One idempotency key per person's intent, per checkpoint,
 *   kept until the daemon gives a definite answer. A lost answer (the transport failed, or the
 *   daemon was still creating the attempt) is asked again with the same key, which can only
 *   return the same attempt. A receipt that says the attempt was reserved and not created is
 *   finished by reconciling that receipt, never by starting another.
 *
 * Every control asks `hello.methods` for its own method, with no coarse fallback: a daemon
 * before protocol 2.5 has none of them, and a `--read-only` one has only the read.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  RECOVERY_BLOCKER_TEXT,
  RECOVERY_UNVERIFIED_TEXT,
  RUNS_RECOVER_METHOD,
  RUNS_RECOVERY_METHOD,
  RUNS_REVIEW_EFFECT_METHOD,
  type ProtocolError,
  type RecoveryAssessment,
  type RecoveryCheckpoint,
  type RecoveryOption,
  type RecoveryStep,
  type RunsGetResult,
  type RunsRecoverResult,
} from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import { useConnection, useWritability } from "../chrome/use-connection.js";
import { Button, Text } from "../ui/index.js";

export interface RunRecoveryProps {
  detail: RunsGetResult;
  /** Select a run: the attempt a checkpoint start created. */
  onOpenRun?: ((runId: string) => void) | undefined;
}

/** A run that is moving, or that finished well, has nothing to recover. */
const QUIET = new Set(["running", "waiting", "succeeded"]);

const KIND_LABEL: Record<RecoveryOption["kind"], string> = {
  resume: "Resume",
  "new-run": "New run",
  "checkpoint-attempt": "Checkpoint attempt",
};

const READINESS_LABEL: Record<RecoveryOption["readiness"], string> = {
  available: "available",
  unverified: "available, not fully checked",
  blocked: "not available",
};

/** Codes for an answer that may have been lost on the way back: ask again with the same key. */
const UNCERTAIN_CODES = new Set(["AGENT_TRANSPORT", "PROTOCOL_MESSAGE"]);

type Load =
  { phase: "loading" } | { phase: "error"; error: ProtocolError } | { phase: "ready"; assessment: RecoveryAssessment };

interface Report {
  message: string;
  failed: boolean;
}

export function RunRecovery({ detail, onOpenRun }: RunRecoveryProps): JSX.Element | null {
  const connection = useConnection();
  const writability = useWritability();
  const announce = useAnnounce();
  // Why a write control is disabled, in the words every control in the app uses.
  const why = writability.can ? {} : { disabledReason: writability.reason };
  const runId = detail.run.id;
  const status = detail.run.status;

  const bridge = window.orca.runs;
  const readable = connection.methods.includes(RUNS_RECOVERY_METHOD) && bridge.recovery !== undefined;
  const reviewable = connection.methods.includes(RUNS_REVIEW_EFFECT_METHOD) && bridge.reviewEffect !== undefined;
  const recoverable =
    connection.methods.includes(RUNS_RECOVER_METHOD) &&
    bridge.recover !== undefined &&
    bridge.reconcileRecover !== undefined;
  const shown = readable && !QUIET.has(status);

  // What the assessment depends on that the run view can see: refetched when it moves.
  const reviews = detail.steps.filter((step) => step.effectReview !== undefined).length;
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const [load, setLoad] = useState<Load>({ phase: "loading" });

  useEffect(() => {
    if (!shown || !bridge.recovery) return;
    let live = true;
    setLoad({ phase: "loading" });
    void bridge.recovery({ runId }).then((result) => {
      if (!live) return;
      setLoad(
        result.ok ? { phase: "ready", assessment: result.result.assessment } : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [shown, bridge, runId, status, reviews, detail.steps.length, version]);

  const [pending, setPending] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<Report | undefined>(undefined);
  const [armed, setArmed] = useState<string | undefined>(undefined);
  // Per checkpoint: the key of the intent in flight, and a receipt that still needs reconciling.
  const keys = useRef(new Map<string, string>());
  const receipts = useRef(new Map<string, string>());
  useEffect(() => {
    keys.current.clear();
    receipts.current.clear();
    setReport(undefined);
    setArmed(undefined);
  }, [runId]);

  const say = useCallback(
    (next: Report) => {
      setReport(next);
      announce(next.message);
    },
    [announce],
  );

  const review = useCallback(
    (step: RecoveryStep, decision: "run-again" | "abandon") => {
      if (pending || !bridge.reviewEffect) return;
      const subject = `review:${step.stepRunId}`;
      setPending(subject);
      setArmed(undefined);
      void bridge
        .reviewEffect({ runId: step.runId, stepRunId: step.stepRunId, decision })
        .then((result) => {
          if (!result.ok) {
            say({ message: `${result.error.code}: ${result.error.message}`, failed: true });
            return;
          }
          say({
            message:
              decision === "run-again"
                ? `${step.nodeId} is marked to run again.`
                : `${step.nodeId} is abandoned; the run ends there.`,
            failed: false,
          });
          refresh();
        })
        .finally(() => setPending(undefined));
    },
    [pending, bridge, say, refresh],
  );

  const settle = useCallback(
    (checkpoint: RecoveryCheckpoint, result: RunsRecoverResult): Report => {
      const id = checkpoint.stepRunId;
      if (result.state === "in-progress") {
        return {
          message: `The daemon is still creating the attempt from ${checkpoint.nodeId}. Start it again to check; it cannot start a second one.`,
          failed: true,
        };
      }
      if (result.state === "recoverable-failure") {
        receipts.current.set(id, result.operationId);
        return {
          message: `The attempt from ${checkpoint.nodeId} was reserved but not created (${result.failure.message}). Finish it to create it.`,
          failed: true,
        };
      }
      keys.current.delete(id);
      receipts.current.delete(id);
      onOpenRun?.(result.runId);
      return { message: `Started a checkpoint attempt from ${checkpoint.nodeId}.`, failed: false };
    },
    [onOpenRun],
  );

  const start = useCallback(
    (checkpoint: RecoveryCheckpoint) => {
      if (pending || !bridge.recover || !bridge.reconcileRecover) return;
      const id = checkpoint.stepRunId;
      const subject = `recover:${id}`;
      setPending(subject);
      const operationId = receipts.current.get(id);
      let key = keys.current.get(id);
      if (key === undefined) {
        key = globalThis.crypto.randomUUID();
        keys.current.set(id, key);
      }
      const call =
        operationId !== undefined
          ? bridge.reconcileRecover({ operationId })
          : bridge.recover({ runId, checkpoint: id, idempotencyKey: key });
      void call
        .then((result) => {
          if (result.ok) {
            say(settle(checkpoint, result.result));
            refresh();
            return;
          }
          // The daemon answered with a refusal: this intent is over, and the next is a new one.
          if (!UNCERTAIN_CODES.has(result.error.code)) {
            keys.current.delete(id);
            receipts.current.delete(id);
          }
          say({ message: `${result.error.code}: ${result.error.message}`, failed: true });
        })
        .finally(() => setPending(undefined));
    },
    [pending, bridge, runId, say, settle, refresh],
  );

  const options = load.phase === "ready" ? load.assessment.options : [];
  const checkpoints = useMemo(() => (load.phase === "ready" ? [...load.assessment.checkpoints].reverse() : []), [load]);

  if (!shown) return null;

  return (
    <section className="orca-recovery" aria-label="Recovery">
      <Text style="eyebrow" as="div" className="orca-inspector__group">
        Recovery
      </Text>

      {load.phase === "loading" && (
        <Text style="caption" className="orca-faint" as="div">
          Reading how this run could be recovered…
        </Text>
      )}
      {load.phase === "error" && (
        <div className="orca-recovery__row">
          <Text style="label" as="div" className="orca-step__error">
            {`${load.error.code}: ${load.error.message}`}
          </Text>
          <Button size="sm" tone="ghost" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}

      {load.phase === "ready" && (
        <>
          <ul className="orca-recovery__list" aria-label="Recovery options">
            {options.map((option) => (
              <li key={option.kind} className="orca-recovery__item">
                <Text style="label" as="div">
                  {`${KIND_LABEL[option.kind]}: ${READINESS_LABEL[option.readiness]}`}
                </Text>
                <Reasons blockers={option.blockers} unverified={option.unverified} />
              </li>
            ))}
          </ul>

          {load.assessment.drift && (
            <Text style="caption" className="orca-faint" as="div">
              {driftSentence(load.assessment)}
            </Text>
          )}

          {load.assessment.uncertain.length > 0 && (
            <>
              <Text style="eyebrow" as="div" className="orca-inspector__group">
                {`Needs review (${load.assessment.uncertain.length})`}
              </Text>
              <Text style="caption" className="orca-faint" as="div">
                These steps may have changed the workspace or systems outside ORCA and did not finish. Check what each
                did before anything runs it again.
              </Text>
              <ul className="orca-recovery__list" aria-label="Steps that need review">
                {load.assessment.uncertain.map((step) => {
                  const subject = `abandon:${step.stepRunId}`;
                  return (
                    <li key={step.stepRunId} className="orca-recovery__item">
                      <Text style="mono-id" as="div">{`${step.nodeId} · attempt ${step.attempt}`}</Text>
                      {step.review !== undefined ? (
                        <Text style="caption" className="orca-faint" as="div">
                          {step.review === "run-again" ? "Marked to run again." : "Abandoned."}
                        </Text>
                      ) : reviewable ? (
                        <div className="orca-recovery__actions">
                          <Button
                            size="sm"
                            disabled={!writability.can || pending !== undefined}
                            {...why}
                            onClick={() => review(step, "run-again")}
                          >
                            Mark to run again
                          </Button>
                          <Button
                            size="sm"
                            tone="danger"
                            disabled={!writability.can || pending !== undefined}
                            {...why}
                            onClick={() => (armed === subject ? review(step, "abandon") : setArmed(subject))}
                          >
                            {armed === subject ? `Abandon the run at ${step.nodeId} — confirm` : "Abandon the run"}
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {checkpoints.length > 0 && (
            <>
              <Text style="eyebrow" as="div" className="orca-inspector__group">
                {`Checkpoints (${checkpoints.length})`}
              </Text>
              <ul className="orca-recovery__list" aria-label="Checkpoints">
                {checkpoints.map((checkpoint) => {
                  const reserved = receipts.current.has(checkpoint.stepRunId);
                  const blocked = checkpoint.readiness === "blocked" && !reserved;
                  return (
                    <li key={checkpoint.stepRunId} className="orca-recovery__item">
                      <Text style="mono-id" as="div">{`${checkpoint.nodeId} · attempt ${checkpoint.attempt}`}</Text>
                      <Text style="caption" className="orca-faint" as="div">
                        {`${READINESS_LABEL[checkpoint.readiness]} · reuses ${checkpoint.reused.length}, ${checkpoint.ranAfter.length} ran after it last time`}
                      </Text>
                      <Reasons blockers={checkpoint.blockers} unverified={checkpoint.unverified} />
                      {recoverable && !blocked && (
                        <div className="orca-recovery__actions">
                          <Button
                            size="sm"
                            tone="primary"
                            disabled={!writability.can || pending !== undefined}
                            {...why}
                            onClick={() => start(checkpoint)}
                          >
                            {reserved ? "Finish the attempt" : "Start an attempt from here"}
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}

      {report && (
        <Text
          style="caption"
          as="div"
          role="status"
          className={report.failed ? "orca-recovery__report orca-recovery__report--failed" : "orca-recovery__report"}
        >
          {report.message}
        </Text>
      )}
    </section>
  );
}

function Reasons({
  blockers,
  unverified,
}: {
  blockers: readonly RecoveryOption["blockers"][number][];
  unverified: readonly RecoveryOption["unverified"][number][];
}): JSX.Element | null {
  if (blockers.length === 0 && unverified.length === 0) return null;
  return (
    <ul className="orca-recovery__reasons">
      {blockers.map((blocker) => (
        <li key={blocker}>
          <Text style="caption">{RECOVERY_BLOCKER_TEXT[blocker]}</Text>
        </li>
      ))}
      {unverified.map((point) => (
        <li key={point}>
          <Text style="caption" className="orca-faint">
            {RECOVERY_UNVERIFIED_TEXT[point]}
          </Text>
        </li>
      ))}
    </ul>
  );
}

function driftSentence(assessment: RecoveryAssessment): string {
  const drift = assessment.drift ?? {};
  const parts: string[] = [];
  if (drift.currentWorkflowVersion !== undefined && drift.currentWorkflowVersion !== assessment.workflowVersion)
    parts.push(
      `the workflow is now version ${drift.currentWorkflowVersion} (this run used ${assessment.workflowVersion})`,
    );
  if (drift.currentConfigGeneration !== undefined && drift.currentConfigGeneration !== drift.recordedConfigGeneration)
    parts.push("the configuration has changed since this run started");
  return parts.length
    ? `Since this run: ${parts.join("; ")}. Resume and checkpoint attempts keep what the run used; a new run uses what is current.`
    : "The current workflow or configuration differs from what this run used.";
}
