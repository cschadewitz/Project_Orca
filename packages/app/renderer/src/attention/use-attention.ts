/**
 * The Attention surface's data: one `inputs.list` and one `runs.list` for the page, then
 * the push stream for everything after them.
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
  const held = useRef<{ waits: ReadonlySet<string>; failures: ReadonlySet<string> }>({
    waits: new Set(),
    failures: new Set(),
  });

  useEffect(() => {
    held.current =
      state.phase === "ready"
        ? { waits: new Set(state.waits.map((i) => i.id)), failures: new Set(state.failures.map((r) => r.id)) }
        : { waits: new Set(), failures: new Set() };
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
    void Promise.all([window.orca.inputs.list(), window.orca.runs.list({ status: ["failed"] })]).then(
      ([inputs, runs]) => {
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
          failures: runs.ok ? orderRuns(runs.result.runs) : [],
          asOf: inputs.result.asOf,
        });
      },
    );
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

    /** A run that has just failed: one `runs.get` for the row, then insert it in order. */
    const resolveFailure = (runId: string): void => {
      if (resolvingRuns.current.has(runId)) return;
      resolvingRuns.current.add(runId);
      void window.orca.runs.get({ runId }).then((result) => {
        resolvingRuns.current.delete(runId);
        if (!live || !result.ok) return;
        setState((prev) =>
          prev.phase === "ready" ? { ...prev, failures: mergeRun(prev.failures, result.result.run) } : prev,
        );
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
        const known = held.current.failures.has(params.runId);
        if (params.status === "failed") {
          if (known) return;
          // The row needs a name, a workflow and a duration, none of which is on the
          // notification — one `runs.get`, the same resolution `use-runs.ts` makes.
          resolveFailure(params.runId);
          return;
        }
        // A failed run that was re-driven and is running again is no longer a failure on
        // this screen, whatever else it is.
        if (known) {
          setState((prev) =>
            prev.phase === "ready" ? { ...prev, failures: prev.failures.filter((r) => r.id !== params.runId) } : prev,
          );
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
