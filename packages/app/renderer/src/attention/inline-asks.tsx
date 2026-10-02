/**
 * The second mounting of the two cards: a gate or a permission ask rendered **inline in the
 * run it came from**, in step detail, "with identical controls and identical keyboard
 * handling" (docs/design/20-attention-and-gates.md, #161).
 *
 * It is a context rather than a prop threaded down through the Runs surface for one reason:
 * the feed is held once, in `App.tsx`, because the title bar shows the same count on every
 * screen. A second `useAttention()` here would be a second `inputs.list`, and the two counts
 * would then differ by one for as long as a push took to reach both — which is the thing the
 * daemon sends `InputsListResult.waiting` to prevent.
 *
 * The provider is also what makes this optional: a surface mounted without it (a test, a
 * preview) renders no card rather than failing, because a step whose ask this app has not
 * read is a step with no card, not a broken pane.
 */
import { createContext, useContext, useEffect, useMemo, type JSX, type ReactNode } from "react";
import { useWritability } from "../chrome/use-connection.js";
import { PendingCorrection } from "./revision-card.js";
import { revisionSlotKey } from "./use-revisions.js";
import { GateCard } from "./gate-card.js";
import { PermissionCard } from "./permission-card.js";
import type { AttentionFeed } from "./use-attention.js";
import { useControls, type Controls } from "./use-controls.js";

interface InlineAsks {
  feed: AttentionFeed;
  controls: Controls;
}

const InlineAsksContext = createContext<InlineAsks | undefined>(undefined);

/** Wraps the surfaces that may render a card inline. `App.tsx` holds the feed it is given. */
export function InlineAsksProvider({ feed, children }: { feed: AttentionFeed; children: ReactNode }): JSX.Element {
  const controls = useControls({ onAnswered: feed.answered });
  const value = useMemo(() => ({ feed, controls }), [feed, controls]);
  return <InlineAsksContext.Provider value={value}>{children}</InlineAsksContext.Provider>;
}

export interface StepAsksProps {
  runId: string;
  stepRunId: string;
}

/**
 * Whatever this step is waiting on a person for, as the card the Attention list would draw.
 * Usually nothing: only a step parked on a gate or an agent's permission ask has one.
 */
export function StepAsks({ runId, stepRunId }: StepAsksProps): JSX.Element | null {
  const inline = useContext(InlineAsksContext);
  const writability = useWritability();
  const state = inline?.feed.state;
  const waits = state?.phase === "ready" ? state.waits : undefined;
  const asks = useMemo(
    () => (waits ?? []).filter((input) => input.runId === runId && input.stepRunId === stepRunId),
    [waits, runId, stepRunId],
  );
  const revisions = inline?.feed.revisions;
  const refresh = revisions?.refresh;
  useEffect(() => {
    refresh?.(runId);
  }, [refresh, runId, revisions?.scope]);
  const corrections =
    revisions?.items.filter((entry) => entry.summary.target.runId === runId && entry.stepRunId === stepRunId) ?? [];
  if (!inline || (asks.length === 0 && corrections.length === 0)) return null;

  const { controls } = inline;
  const cannotWrite = writability.can ? undefined : writability.reason;
  return (
    <div className="orca-step__asks">
      {asks.map((input) => {
        /* `focused` is deliberately false here. The card's number keys belong to the card
           that has the keyboard, and on this surface that is the run tree or the output
           stream — a step's card is answered with the pointer, or from Attention, where the
           keys are. Everything else about it is the same card. */
        const shared = {
          input,
          placement: "inline" as const,
          cannotWrite,
          pending: controls.pending.has(input.id),
          outcome: controls.report?.subject === input.id ? controls.report.message : undefined,
          onAnswer: (request: Parameters<Controls["answer"]>[1]) => controls.answer(input, request),
        };
        return input.kind === "permission" ? (
          <PermissionCard key={input.id} {...shared} />
        ) : (
          <GateCard key={input.id} revisions={revisions} {...shared} />
        );
      })}
      {revisions &&
        corrections.map((entry) => (
          <PendingCorrection key={revisionSlotKey(entry.summary.target)} entry={entry} feed={revisions} />
        ))}
    </div>
  );
}
