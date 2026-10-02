/**
 * The three writes, in one place: answering an ask, cancelling a run, resuming one.
 *
 * This is the first hook in the app that calls a control method, so the shape it sets is
 * worth stating:
 *
 * - **Ask whether you can write; do not find out by failing.** The caller passes
 *   `useWritability()`'s answer down to the controls, which disable themselves with its
 *   sentence. Nothing here retries, queues or hopes: a daemon that cannot take a command
 *   says so before the button is pressed.
 * - **One call in flight per object.** A second `Enter` on a card whose answer is still with
 *   the daemon is a person being fast, not a person asking twice — and `inputs.answer` with
 *   `resume` left at its default does not come back until the run has parked again, which
 *   can be a while.
 * - **The result is read, not assumed.** An "always" answer reports what the sidecar
 *   actually took — `added`, `alreadyPresent`, `refused` — because a button that says "ORCA
 *   will not ask again" must have read all three (`alwaysOutcome`).
 * - **Failure is a sentence on the card, not a lost keystroke.** A refused write (no lease,
 *   a run someone else is driving) leaves the ask where it is and says why.
 */
import { useCallback, useState } from "react";
import type { OpenInputView } from "@orca/protocol";
import type { AnswerRequest } from "./answer-card.js";
import { alwaysOutcome } from "./card-model.js";

/** What the last write said, against the object it was about. */
export interface ControlReport {
  /** The input id, or the run id for a cancel or a resume. */
  subject: string;
  message: string;
  failed: boolean;
}

export interface Controls {
  /** Ids with a call in flight: an input id, or a run id. */
  pending: ReadonlySet<string>;
  report: ControlReport | undefined;
  answer: (input: OpenInputView, request: AnswerRequest) => void;
  cancel: (runId: string) => void;
  resume: (runId: string) => void;
}

export interface ControlsOptions {
  /**
   * Called with the request id the moment the daemon takes an answer, so the list can drop
   * the card and move to the next one without waiting for `input.answered` to come round.
   */
  onAnswered: (requestId: string) => void;
}

export function useControls({ onAnswered }: ControlsOptions): Controls {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [report, setReport] = useState<ControlReport | undefined>(undefined);

  /** Run one call with `subject` marked in flight for its duration, whatever it answers. */
  const run = useCallback((subject: string, call: () => Promise<ControlReport | undefined>) => {
    setPending((current) => {
      if (current.has(subject)) return current;
      return new Set([...current, subject]);
    });
    void call()
      .then((result) => setReport(result))
      .finally(() =>
        setPending((current) => {
          const next = new Set(current);
          next.delete(subject);
          return next;
        }),
      );
  }, []);

  const answer = useCallback(
    (input: OpenInputView, request: AnswerRequest) => {
      if (input.revision?.capability.actionId === request.optionId) {
        setReport({
          subject: input.id,
          failed: true,
          message: "Use Request changes to record a correction for this revision branch.",
        });
        return;
      }
      if (pending.has(input.id)) return;
      run(input.id, async () => {
        const result = await window.orca.inputs.answer({
          requestId: input.id,
          ...(input.live ? { live: input.live.target } : {}),
          runId: input.runId,
          optionId: request.optionId,
          ...(request.note ? { note: request.note } : {}),
          ...(request.always ? { always: request.always } : {}),
        });
        if (!result.ok) {
          return { subject: input.id, failed: true, message: `${result.error.code}: ${result.error.message}` };
        }
        onAnswered(input.id);
        const wrote = alwaysOutcome(result.result.permission);
        return {
          subject: input.id,
          failed: false,
          message: wrote ?? `Answered ${input.runName}: ${result.result.answer}.`,
        };
      });
    },
    [onAnswered, pending, run],
  );

  const cancel = useCallback(
    (runId: string) => {
      if (pending.has(runId)) return;
      run(runId, async () => {
        // No reason field on the card: the reason a person would type is the note on the
        // answer, and a cancel from here is "stop this", which `runs.cancel` records as
        // cancelled by the app. A reason box with nothing to say in it is furniture.
        const result = await window.orca.runs.cancel({ runId, reason: "cancelled from the Attention surface" });
        return result.ok
          ? { subject: runId, failed: false, message: `${result.result.run.name} is cancelled.` }
          : { subject: runId, failed: true, message: `${result.error.code}: ${result.error.message}` };
      });
    },
    [pending, run],
  );

  const resume = useCallback(
    (runId: string) => {
      if (pending.has(runId)) return;
      run(runId, async () => {
        // `runs.resume` answers when the run parks again or finishes, not when it starts
        // moving — so this is a settled status and the sentence can say it plainly.
        const result = await window.orca.runs.resume({ runId });
        return result.ok
          ? { subject: runId, failed: false, message: `${result.result.run.name} is ${result.result.run.status}.` }
          : { subject: runId, failed: true, message: `${result.error.code}: ${result.error.message}` };
      });
    },
    [pending, run],
  );

  return { pending, report, answer, cancel, resume };
}
