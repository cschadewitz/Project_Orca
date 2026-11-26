/**
 * The Attention surface's data: one `inputs.list` and two `runs.list` for the page — the
 * failures and the runs in flight — then the push stream for everything after them.
 *
 * The rule every list in this app keeps — updates without refetching — has one exception
 * here, and it is the same exception `use-runs.ts` makes. `input.opened` carries the
 * question and the options but not the run's name, not how long it has waited and not the
 * artifacts the decision is about, and the design forbids offering an answer the app cannot
 * show the basis for. So an ask the list has never seen is resolved with a single
 * `inputs.list({ runId })`, scoped to one run. The request is published before its step
 * becomes waiting, so an early empty read is retried only on that step's readiness or the
 * run pausing. Readiness during a read is coalesced into one follow-on read, never a poll.
 * Transport reattachment reconciles the snapshots once.
 *
 * **The count is the daemon's.** `InputsListResult.waiting` is sent so that a client never
 * recounts, and this hook does not: it holds that number and moves it by the same delta it
 * applies to the list. Recounting would be a second opinion about the one number in the
 * app, and the two would disagree the moment a push arrived for a run this surface has
 * filtered or has not resolved yet.
 *
 * **And it is reconciled (#1213).** A fold can miss: a scoped read that came back empty
 * before its ask was readable and no readiness event after it, or a run that ended with an
 * ask open and no `input.answered`. Then this surface and the Machines surface, which
 * re-reads `inputs.list` after every change, showed different counts for one store (8 and
 * 9). So once a change that can move the list has arrived, one full `inputs.list` follows
 * `RECONCILE_MS` later (never more than one in flight or pending, and never on a timer of
 * its own), and its answer replaces the list and the count. Both surfaces then show the
 * daemon's number from the same read, a moment after the same push.
 *
 * Failures are the tier table's third row and are read from `runs.list({ status: failed })`.
 * They are deliberately best-effort: a store whose run list will not answer still has gates
 * in it, and hiding the gates behind that failure would be the app withholding the thing a
 * person came for.
 *
 * The running runs are read the same way and with the same best-effort rule (#256). They
 * are **not** a tier: nothing about a running run is asking for a person, and it is only
 * ever drawn where the empty state would otherwise be. It is one more read on the page and
 * not one more subscription — the `run.changed` listener below already hears every status
 * change, so the same frame that drops a run out of the failures can put it into the
 * running list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenInputView, ProtocolError, RunSummaryView, RunChangedParams } from "@orca/protocol";
import { useAuthority, useSubscriptionGeneration } from "../chrome/use-connection.js";
import { useNotifications } from "../notifications-context.js";
import { applyRunChanged, mergeRun, orderRuns } from "../runs/run-rows.js";
import { useRevisions, type RevisionsFeed } from "./use-revisions.js";
import { alertItems, invalidateLiveInput, liveInputKey, mergeInput, orderWaits } from "./items.js";

/** How long after a change that can move the list the full `inputs.list` reconcile runs. */
export const RECONCILE_MS = 750;

export type AttentionState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | {
      phase: "ready";
      /** Tier 1 then tier 2, each longest-waiting first. */
      waits: readonly OpenInputView[];
      /** The daemon's own count of tiers 1 and 2, moved by what this hook has folded in. */
      waiting: number;
      /** Tier 3, below the waits and out of the count. */
      failures: readonly RunSummaryView[];
      /**
       * What is moving. Not a tier and never beside the waits: this is what the surface
       * shows instead of "nothing needs you" when nothing is waiting and nothing has
       * failed (#256).
       */
      running: readonly RunSummaryView[];
      /** When the daemon answered the read the page was drawn from. */
      asOf: string;
      /**
       * The grant every read behind this state ran under (#882). The alert report carries
       * it, and the main process drops a report from a grant that is no longer current.
       */
      authority?: number | undefined;
    };

export interface AttentionFeed {
  state: AttentionState;
  /** Correction metadata/content is separate from unanswered inputs and alerts. */
  revisions?: RevisionsFeed;
  /** Re-read both lists: the error state's retry, and what a person reaches for after a blip. */
  reload: () => void;
  /**
   * Drop an ask this window has just answered, without waiting for `input.answered` to come
   * back round. Answering from the list has to advance to the next item in the same frame —
   * five gates in five keystrokes — and a round trip through the daemon is not a frame.
   * The push is idempotent with this, so nothing double-counts.
   */
  answered: (requestId: string) => void;
}

export function useAttention(): AttentionFeed {
  const stream = useNotifications();
  const generation = useSubscriptionGeneration();
  const authority = useAuthority();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AttentionState>({ phase: "loading" });
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const pendingAnswers = useRef(new Set<string>());
  const answered = useCallback((requestId: string) => {
    pendingAnswers.current.add(requestId);
    setState((prev) => {
      if (prev.phase !== "ready" || !prev.waits.some((i) => i.id === requestId)) return prev;
      return { ...prev, waits: prev.waits.filter((i) => i.id !== requestId), waiting: Math.max(0, prev.waiting - 1) };
    });
  }, []);

  const revisions = useRevisions(answered);
  const observeRevisions = revisions.observeInputs;

  useEffect(() => {
    let live = true;
    let snapshot: Extract<AttentionState, { phase: "ready" }> | undefined;
    const changes = new Map<string, RunChangedParams>();
    const runs = new Map<string, RunSummaryView>();
    const cursors = new Map<string, number>();
    const inputs = new Map<string, OpenInputView>();
    const resolvingInputs = new Set<string>();
    const resolvingRuns = new Set<string>();
    const opened = new Map<string, Map<string, string>>();
    const inputVersions = new Map<string, number>();
    const waitingCursors = new Map<string, number>();
    // Connection-generation tombstones win over stale reads but never match a new turn.
    const invalidated = new Set<string>();
    pendingAnswers.current.clear();
    setState({ phase: "loading" });

    const publish = () => {
      if (!live || !snapshot) return;
      let next = snapshot;
      for (const [id, params] of changes) {
        const run = runs.get(id) ?? next.failures.find((r) => r.id === id) ?? next.running.find((r) => r.id === id);
        next = forget(next, id);
        if (run) {
          const current = params.seq > (cursors.get(id) ?? -1) ? applyRunChanged(run, params) : run;
          if (current.status === "failed" || current.status === "running") next = file(next, current, current.status);
        }
      }
      let waits = next.waits;
      let waiting = next.waiting;
      for (const input of inputs.values()) {
        if (!waits.some((i) => i.id === input.id)) waiting += 1;
        waits = mergeInput(waits, input);
      }
      const remaining = waits.filter((i) => !pendingAnswers.current.has(i.id));
      waiting -= waits.length - remaining.length;
      setState({
        ...next,
        waits: orderWaits(remaining.map((input) => invalidateLiveInput(input, invalidated))),
        waiting: Math.max(0, waiting),
      });
    };
    /* The reconcile (#1213). `inputs` entries resolved before the full read began are
       superseded by it; one resolved while it was in flight is newer and stays. */
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
    let reconciling = false;
    let reconcileAgain = false;
    const fullRead = () => {
      if (!live || !snapshot) return;
      if (reconciling) {
        reconcileAgain = true;
        return;
      }
      reconciling = true;
      const superseded = new Set(inputs.keys());
      void window.orca.inputs.list().then((result) => {
        reconciling = false;
        if (!live) return;
        if (result.ok && snapshot) {
          observeRevisions(result.result.inputs);
          for (const id of superseded) inputs.delete(id);
          snapshot = {
            ...snapshot,
            waits: result.result.inputs,
            waiting: result.result.waiting,
            asOf: result.result.asOf,
          };
          publish();
        }
        if (reconcileAgain) {
          reconcileAgain = false;
          reconcile();
        }
      });
    };
    const reconcile = () => {
      if (!live || reconcileTimer !== undefined) return;
      reconcileTimer = setTimeout(() => {
        reconcileTimer = undefined;
        fullRead();
      }, RECONCILE_MS);
    };
    const unresolved = (runId: string, stepRunId?: string) =>
      [...(opened.get(runId) ?? [])].some(
        ([id, step]) =>
          (stepRunId === undefined || step === stepRunId) &&
          !inputs.has(id) &&
          !snapshot?.waits.some((input) => input.id === id) &&
          !pendingAnswers.current.has(id),
      );
    const resolveInputs = (runId: string) => {
      if (resolvingInputs.has(runId)) return;
      resolvingInputs.add(runId);
      const version = inputVersions.get(runId);
      void window.orca.inputs.list({ runId }).then((result) => {
        resolvingInputs.delete(runId);
        if (!live) return;
        if (result.ok) {
          observeRevisions(result.result.inputs);
          for (const input of result.result.inputs) inputs.set(input.id, input);
          publish();
        }
        // A new ask or readiness signal may have arrived after this read began. Only
        // that missed batch can schedule another read; an empty result alone never does.
        if (inputVersions.get(runId) !== version && unresolved(runId)) resolveInputs(runId);
      });
    };
    const refreshInputs = (runId: string) => {
      inputVersions.set(runId, (inputVersions.get(runId) ?? 0) + 1);
      resolveInputs(runId);
    };
    /* A dry run (#183) never asks for a person and is not work: one that fails or runs is read
       once, found to be dry, and kept off this surface, like `runs.list` keeps it. */
    const dryRuns = new Set<string>();
    const resolveRun = (runId: string) => {
      if (resolvingRuns.has(runId) || runs.has(runId) || dryRuns.has(runId)) return;
      resolvingRuns.add(runId);
      void window.orca.runs.get({ runId }).then((result) => {
        resolvingRuns.delete(runId);
        if (!live || !result.ok) return;
        if (result.result.run.dryRun) {
          dryRuns.add(runId);
          return;
        }
        runs.set(runId, result.result.run);
        cursors.set(runId, result.result.lastSeq);
        publish();
      });
    };
    const off = [
      stream.on("input.opened", (params) => {
        const ids = opened.get(params.runId) ?? new Map<string, string>();
        if (ids.has(params.requestId)) return;
        ids.set(params.requestId, params.stepRunId);
        opened.set(params.runId, ids);
        if (unresolved(params.runId, params.stepRunId)) refreshInputs(params.runId);
        reconcile();
      }),
      stream.on("step.changed", (params) => {
        if (params.event !== "step.waiting" || params.waitingOn !== "human-input") return;
        const key = JSON.stringify([params.runId, params.stepRunId]);
        if (params.seq <= (waitingCursors.get(key) ?? -1)) return;
        waitingCursors.set(key, params.seq);
        if (unresolved(params.runId, params.stepRunId)) refreshInputs(params.runId);
        reconcile();
      }),
      stream.on("input.answered", (params) => {
        answered(params.requestId);
        publish();
        reconcile();
      }),
      stream.on("input.invalidated", (params) => {
        invalidated.add(liveInputKey(params.target));
        publish();
        reconcile();
      }),
      stream.on("run.changed", (params) => {
        const previous = changes.get(params.runId);
        if (previous && previous.seq >= params.seq) return;
        changes.set(params.runId, params);
        if (params.event === "run.paused" && unresolved(params.runId)) refreshInputs(params.runId);
        // A run that pauses can open an ask; one that ends can close one with no `input.answered`.
        if (params.event === "run.paused" || TERMINAL_RUN_EVENTS.has(params.event)) reconcile();
        if (
          (params.status === "failed" || params.status === "running") &&
          !snapshot?.failures.some((r) => r.id === params.runId) &&
          !snapshot?.running.some((r) => r.id === params.runId)
        )
          resolveRun(params.runId);
        publish();
      }),
    ];
    void Promise.all([
      window.orca.inputs.list(),
      window.orca.runs.list({ status: ["failed"] }),
      window.orca.runs.list({ status: ["running"] }),
    ]).then(([inputResult, failed, running]) => {
      if (!live) return;
      if (!inputResult.ok) {
        setState({ phase: "error", error: inputResult.error });
        return;
      }
      observeRevisions(inputResult.result.inputs);
      snapshot = {
        phase: "ready",
        waits: inputResult.result.inputs,
        waiting: inputResult.result.waiting,
        failures: failed.ok ? orderRuns(failed.result.runs) : [],
        running: running.ok ? orderRuns(running.result.runs) : [],
        asOf: inputResult.result.asOf,
        authority,
      };
      publish();
    });
    return () => {
      live = false;
      if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
      off.forEach((remove) => remove());
    };
  }, [stream, answered, attempt, generation, authority, observeRevisions, revisions.scope]);

  /* The main process is told what is open, and decides what to post from it (#162). Here
     rather than in the surface because this is the one place that holds both halves, and
     because a component that re-rendered for its own reasons would re-send this. */
  useEffect(() => {
    if (state.phase !== "ready") return;
    window.orca.alerts.update(
      { waiting: state.waiting, items: alertItems(state.waits, state.failures) },
      state.authority,
    );
  }, [state]);

  return { state, reload, answered, revisions };
}

const TERMINAL_RUN_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);

/** The two lists of runs this surface holds. Neither is a tier; the failures are one. */
type RunList = "failed" | "running";

/**
 * Put one resolved run in one of the two lists, and out of the other.
 *
 * Written as a pure function of the state so both lists move in a single commit: a run
 * that failed and was re-driven must not be a row in both of them for the frame between
 * two updates.
 */
function file(
  state: Extract<AttentionState, { phase: "ready" }>,
  run: RunSummaryView,
  into: RunList,
): Extract<AttentionState, { phase: "ready" }> {
  return {
    ...state,
    failures: into === "failed" ? mergeRun(state.failures, run) : state.failures.filter((r) => r.id !== run.id),
    running: into === "running" ? mergeRun(state.running, run) : state.running.filter((r) => r.id !== run.id),
  };
}

/** Drop a run from both lists: it is neither failed nor in flight any more. */
function forget(
  state: Extract<AttentionState, { phase: "ready" }>,
  runId: string,
): Extract<AttentionState, { phase: "ready" }> {
  return {
    ...state,
    failures: state.failures.filter((r) => r.id !== runId),
    running: state.running.filter((r) => r.id !== runId),
  };
}
