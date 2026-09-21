/**
 * The Attention surface's data: one `inputs.list` and two `runs.list` for the page — the
 * failures and the runs in flight — then the push stream for everything after them.
 *
 * The rule every list in this app keeps — updates without refetching — has one exception
 * here, and it is the same exception `use-runs.ts` makes. `input.opened` carries the
 * question and the options but not the run's name, not how long it has waited and not the
 * artifacts the decision is about, and the design forbids offering an answer the app cannot
 * show the basis for. So an ask the list has never seen is resolved with a single
 * `inputs.list({ runId })` — one call, scoped to one run — exactly as an unknown run is
 * resolved with one `runs.get`. Nothing else re-reads.
 *
 * **The count is the daemon's.** `InputsListResult.waiting` is sent so that a client never
 * recounts, and this hook does not: it holds that number and moves it by the same delta it
 * applies to the list. Recounting would be a second opinion about the one number in the
 * app, and the two would disagree the moment a push arrived for a run this surface has
 * filtered or has not resolved yet.
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
import type { OpenInputView, ProtocolError, RunSummaryView } from "@orca/protocol";
import { useNotifications } from "../notifications-context.js";
import { mergeRun, orderRuns } from "../runs/run-rows.js";
import { alertItems, mergeInput, orderWaits } from "./items.js";

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
    };

export interface AttentionFeed {
  state: AttentionState;
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
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AttentionState>({ phase: "loading" });
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /* Run ids with a resolving call in flight, so a step that opens three asks in a row is
     resolved once rather than three times. Two sets, because the two calls are about
     different things about the same run and one must not suppress the other. */
  const resolvingInputs = useRef<Set<string>>(new Set());
  const resolvingRuns = useRef<Set<string>>(new Set());

  /* What is held, for the two decisions a state updater must not make: whether to issue a
     resolving call at all. An updater has to be pure — React may run it twice — so the
     "have I seen this?" question is asked out here, off a ref that trails the state by a
     commit. A stale answer costs one redundant call and nothing else, because both merges
     replace rather than duplicate. The same trick `runs/use-runs.ts` uses. */
  const held = useRef<{ waits: ReadonlySet<string>; failures: ReadonlySet<string>; running: ReadonlySet<string> }>({
    waits: new Set(),
    failures: new Set(),
    running: new Set(),
  });

  useEffect(() => {
    held.current =
      state.phase === "ready"
        ? {
            waits: new Set(state.waits.map((i) => i.id)),
            failures: new Set(state.failures.map((r) => r.id)),
            running: new Set(state.running.map((r) => r.id)),
          }
        : { waits: new Set(), failures: new Set(), running: new Set() };
  }, [state]);

  const answered = useCallback((requestId: string) => {
    setState((prev) => {
      if (prev.phase !== "ready" || !prev.waits.some((i) => i.id === requestId)) return prev;
      return { ...prev, waits: prev.waits.filter((i) => i.id !== requestId), waiting: Math.max(0, prev.waiting - 1) };
    });
  }, []);

  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    void Promise.all([
      window.orca.inputs.list(),
      window.orca.runs.list({ status: ["failed"] }),
      window.orca.runs.list({ status: ["running"] }),
    ]).then(([inputs, failed, running]) => {
      if (!live) return;
      if (!inputs.ok) {
        setState({ phase: "error", error: inputs.error });
        return;
      }
      setState({
        phase: "ready",
        waits: orderWaits(inputs.result.inputs),
        waiting: inputs.result.waiting,
        // Best-effort, see the header: no gates are hidden because the run list did not answer.
        failures: failed.ok ? orderRuns(failed.result.runs) : [],
        running: running.ok ? orderRuns(running.result.runs) : [],
        asOf: inputs.result.asOf,
      });
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    let live = true;

    /** An ask this surface has never seen: resolve its run's asks, once, and merge them. */
    const resolve = (runId: string): void => {
      if (resolvingInputs.current.has(runId)) return;
      resolvingInputs.current.add(runId);
      void window.orca.inputs.list({ runId }).then((result) => {
        resolvingInputs.current.delete(runId);
        if (!live || !result.ok) return;
        setState((prev) => {
          if (prev.phase !== "ready") return prev;
          const known = new Set(prev.waits.map((i) => i.id));
          const fresh = result.result.inputs.filter((i) => !known.has(i.id));
          if (fresh.length === 0) return prev;
          return {
            ...prev,
            waits: fresh.reduce(mergeInput, prev.waits),
            waiting: prev.waiting + fresh.length,
          };
        });
      });
    };

    /**
     * A run this surface does not hold a row for: one `runs.get` for what the notification
     * does not carry — a name, a workflow, a duration — then file it in the list the
     * *notification* named.
     *
     * The notification decides which list, not the fetched run: the push is the newer of
     * the two, and a `runs.get` that answers a moment behind it would file a run that has
     * just failed under what it was doing before. One call serves both lists, because the
     * two are views of the same object and a run can only be in one of them — a run that
     * failed and was re-driven leaves the failures and joins the running in one commit.
     */
    const resolveRun = (runId: string, into: RunList): void => {
      if (resolvingRuns.current.has(runId)) return;
      resolvingRuns.current.add(runId);
      void window.orca.runs.get({ runId }).then((result) => {
        resolvingRuns.current.delete(runId);
        if (!live || !result.ok) return;
        setState((prev) => (prev.phase === "ready" ? file(prev, result.result.run, into) : prev));
      });
    };

    const off = [
      // A second `input.opened` for an ask already held changes nothing this surface
      // draws, so it is not worth a call.
      stream.on("input.opened", (params) => {
        if (!held.current.waits.has(params.requestId)) resolve(params.runId);
      }),

      // Answered here, or in another window, or by `orca answer` in a terminal: the same
      // frame settles all three, which is why this is not conditional on who answered.
      stream.on("input.answered", (params) => answered(params.requestId)),

      stream.on("run.changed", (params) => {
        const heldNow = held.current;
        const listed = heldNow.failures.has(params.runId) || heldNow.running.has(params.runId);
        if (params.status === "failed" || params.status === "running") {
          // A row this surface has never drawn needs a name, a workflow and a duration,
          // none of which is on the notification — one `runs.get`, the same resolution
          // `use-runs.ts` makes. A run already in the *other* list is resolved too, because
          // the row it moves to is a different row.
          const into: RunList = params.status === "failed" ? "failed" : "running";
          const already = into === "failed" ? heldNow.failures.has(params.runId) : heldNow.running.has(params.runId);
          if (!already) resolveRun(params.runId, into);
          return;
        }
        // Succeeded, cancelled, waiting, stale: not a failure and not in flight, so this
        // screen has nothing to say about it. A failed run that was re-driven leaves here
        // by the branch above instead.
        if (listed) {
          setState((prev) => (prev.phase === "ready" ? forget(prev, params.runId) : prev));
        }
      }),
    ];

    return () => {
      live = false;
      off.forEach((remove) => remove());
    };
  }, [stream, answered]);

  /* The main process is told what is open, and decides what to post from it (#162). Here
     rather than in the surface because this is the one place that holds both halves, and
     because a component that re-rendered for its own reasons would re-send this. */
  useEffect(() => {
    if (state.phase !== "ready") return;
    window.orca.alerts.update({ waiting: state.waiting, items: alertItems(state.waits, state.failures) });
  }, [state]);

  return { state, reload, answered };
}

/** The two lists of runs this surface holds. Neither is a tier; the failures are one. */
type RunList = "failed" | "running";

/**
 * Put one resolved run in one of the two lists, and out of the other.
 *
 * Written as a pure function of the state so both lists move in a single commit: a run
 * that failed and was re-driven must not be a row in both of them for the frame between
 * two updates.
 */
function file(state: Extract<AttentionState, { phase: "ready" }>, run: RunSummaryView, into: RunList): AttentionState {
  return {
    ...state,
    failures: into === "failed" ? mergeRun(state.failures, run) : state.failures.filter((r) => r.id !== run.id),
    running: into === "running" ? mergeRun(state.running, run) : state.running.filter((r) => r.id !== run.id),
  };
}

/** Drop a run from both lists: it is neither failed nor in flight any more. */
function forget(state: Extract<AttentionState, { phase: "ready" }>, runId: string): AttentionState {
  return {
    ...state,
    failures: state.failures.filter((r) => r.id !== runId),
    running: state.running.filter((r) => r.id !== runId),
  };
}
