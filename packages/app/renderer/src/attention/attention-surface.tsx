/**
 * The Attention surface: what needs a person, and answering it without going anywhere
 * (#161, docs/design/20-attention-and-gates.md).
 *
 * Five decisions worth knowing before changing anything here:
 *
 * - **Two regions, in the tier table's order.** Permission asks and gates are cards, tier 1
 *   above tier 2; failed runs are rows below them and out of the count. A failure is
 *   something to go and read, not something a person is being asked.
 * - **Cards are not rows, so they are not virtualised.** The list substrate is for
 *   fixed-height rows read off `--row-h` (rule 9); a card carries a question, its
 *   consequences and its controls and is as tall as it needs to be. What is bounded is the
 *   *number* of them — there are as many cards as there are things blocked on a person,
 *   which is a number somebody is already unhappy about. The failures below them are rows
 *   and are a `VirtualList`, in the `list` scope.
 * - **This is the first surface that writes.** Every control asks `useWritability()` first
 *   and disables itself with its sentence — a read-only daemon, a reconnecting socket and a
 *   version mismatch all say why rather than failing at the moment of pressing.
 * - **Answering keeps the person here.** The card is dropped the moment the daemon takes the
 *   answer and focus moves to the card that slides into its place, so five gates clear in
 *   five keystrokes and the count goes five to zero without navigating.
 * - **`J`/`K` are the surface's; everything else on a card is the card's.** Moving between
 *   cards is the only thing a single card cannot know how to do. The rest — `1`–`9`,
 *   `Enter`, `⇧Enter`, `G` — is registered by whichever card has focus, which is what lets
 *   the same card be mounted inline in a run and bring its keys with it.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { ConnectionState } from "@orca/design";
import type { OpenInputView, RunSummaryView } from "@orca/protocol";
import { useWritability } from "../chrome/use-connection.js";
import { useKeyboard } from "../keyboard-context.js";
import { VirtualList } from "../list/index.js";
import { StateView, StatusChip, Text, Time, textClass } from "../ui/index.js";
import type { AnswerRequest } from "./answer-card.js";
import { GateCard } from "./gate-card.js";
import { PermissionCard } from "./permission-card.js";
import { tierOf } from "./items.js";
import type { AttentionFeed } from "./use-attention.js";
import { useControls } from "./use-controls.js";
import "./attention.css";

export interface AttentionSurfaceProps {
  /** Whether the daemon is answering. A screen nobody is updating says so rather than lying. */
  connection: ConnectionState;
  /**
   * Open the run a card came from — `G`, and the run name on a card. Absent until there is
   * an `orca://` route table to open one into (#165), exactly as `CommandPalette`'s
   * `onJump` is: a shortcut that navigates nowhere is worse than one that is not there.
   */
  onOpenRun?: (runId: string) => void;
  /**
   * The waiting list and the failures. Held by the chrome rather than by this surface, for
   * the reason the count is: the title bar shows the same number on every screen, so the
   * read has to outlive this component (`App.tsx`). Passed in rather than read from a
   * context so the dependency is visible at the call site.
   */
  feed: AttentionFeed;
}

export function AttentionSurface({ connection, onOpenRun, feed }: AttentionSurfaceProps): JSX.Element {
  const { state, reload, answered } = feed;
  const controls = useControls({ onAnswered: answered });
  const writability = useWritability();
  const live = connection === "live";

  const waits = state.phase === "ready" ? state.waits : EMPTY_WAITS;
  const failures = state.phase === "ready" ? state.failures : EMPTY_FAILURES;

  const [focusIndex, setFocusIndex] = useState(0);
  const [failureIndex, setFailureIndex] = useState<number | undefined>(undefined);
  const cards = useRef<(HTMLElement | null)[]>([]);
  /* Whether the person is in the list. Answering advances focus, and a screen that grabbed
     focus because a *notification* removed a card would take the keyboard off whatever the
     person had actually gone to do. */
  const inList = useRef(false);

  const focusCard = useCallback((index: number) => {
    setFocusIndex(index);
    cards.current[index]?.focus();
  }, []);

  /* One stable callback for every card's ref, rather than a closure per row: a new ref
     function each render means React detaches and re-attaches on every push. */
  const registerCard = useCallback((index: number, element: HTMLElement | null) => {
    cards.current[index] = element;
  }, []);

  /* The cards the surface holds, by id: the effect below has to know whether the list
     changed shape, and an array identity changes on every push. */
  const ids = waits.map((input) => input.id).join("|");
  useEffect(() => {
    const index = Math.min(focusIndex, waits.length - 1);
    if (index < 0 || !inList.current) return;
    // The next card has slid into the index the answered one had, which is what "advances
    // to the next waiting item" means when the list is ordered by how long things waited.
    cards.current[index]?.focus();
    setFocusIndex(index);
    /* `ids` and nothing else: `focusIndex` is read but must not re-run this, or focus would
       be pulled back to the list every time a person clicked a card's option. */
  }, [ids, waits.length]);

  useSurfaceKeys(waits.length, focusIndex, focusCard, {
    cancel: () => {
      const run = waits[focusIndex]?.runId;
      if (run) controls.cancel(run);
    },
    resume: () => {
      const run = waits[focusIndex]?.runId;
      if (run) controls.resume(run);
    },
  });

  const cannotWrite = writability.can ? undefined : writability.reason;
  const report = controls.report;
  /* A failure whose card is still on screen is said *on the card*, next to the control that
     was pressed; everything else — an answer accepted, a rule written, a run cancelled — is
     said here, because the card it was about is gone. One message, in one place. */
  const onCard = report?.failed === true && waits.some((input) => input.id === report.subject);

  if (state.phase === "loading") return <StateView kind="loading" title="Loading what needs you" />;
  if (state.phase === "error") {
    return connection === "live" ? (
      <StateView
        kind="error"
        title="Could not load the attention list"
        body={`${state.error.code}: ${state.error.message}`}
        action={{ label: "Try again", onClick: reload }}
      />
    ) : (
      <StateView
        kind="disconnected"
        title="No daemon to ask"
        body="Start one with orca serve, then try again."
        action={{ label: "Try again", onClick: reload }}
      />
    );
  }

  return (
    <div className="orca-attn-surface" data-testid="attention">
      {!live && (
        <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
          <Text style="caption">Not connected — this is the last the daemon said about these.</Text>
        </div>
      )}

      <div className="orca-attn__head">
        <Text style="heading" as="h1">
          Attention
        </Text>
        <Text style="caption">
          {/* The daemon's own count, never a recount of the array (see `use-attention.ts`). */}
          {state.waiting === 0 ? "nothing waiting" : `${state.waiting} waiting`}
        </Text>
      </div>

      {report && !onCard && (
        <p className={`orca-attn__report ${textClass("caption")}`} role="status">
          {report.message}
        </p>
      )}

      {waits.length === 0 ? (
        <StateView
          kind="empty"
          title="Nothing needs you"
          body="Gates and permission asks appear here the moment a run raises one."
        />
      ) : (
        <section
          className="orca-attn__section"
          aria-label="Waiting"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) inList.current = false;
          }}
        >
          <div className="orca-attn__cards">
            {waits.map((input, index) => (
              <Wait
                key={input.id}
                input={input}
                focused={index === focusIndex}
                pending={controls.pending.has(input.id)}
                cannotWrite={cannotWrite}
                outcome={report?.subject === input.id && report.failed ? report.message : undefined}
                onAnswer={(request) => controls.answer(input, request)}
                index={index}
                registerCard={registerCard}
                onFocus={() => {
                  inList.current = true;
                  setFocusIndex(index);
                }}
                {...(onOpenRun ? { goToRun: () => onOpenRun(input.runId) } : {})}
              />
            ))}
          </div>
        </section>
      )}

      {failures.length > 0 && (
        <section className="orca-attn__section orca-attn__failures" aria-label="Failed runs">
          <Text style="eyebrow" as="h2">
            Failed
          </Text>
          <VirtualList
            items={failures}
            label="Failed runs"
            className="orca-attn__failure-list"
            rowId={(run) => `attention-failure-${run.id}`}
            rowClassName={() => "orca-attn__row orca-attn__row--listed"}
            renderRow={(run) => <FailedRow run={run} live={live} />}
            selectedIndex={failureIndex}
            onSelect={setFailureIndex}
            noun="failed run"
            ticks={[]}
          />
        </section>
      )}
    </div>
  );
}

const EMPTY_WAITS: readonly OpenInputView[] = [];
const EMPTY_FAILURES: readonly RunSummaryView[] = [];

/**
 * One waiting item. The tier decides which card it is and **nothing else differs** — same
 * props, same keys, same submit — which is the property #161 asks for and the reason the
 * two components share a shell.
 */
interface WaitProps {
  input: OpenInputView;
  index: number;
  registerCard: (index: number, element: HTMLElement | null) => void;
  focused: boolean;
  pending: boolean;
  cannotWrite: string | undefined;
  outcome: string | undefined;
  onAnswer: (request: AnswerRequest) => void;
  onFocus: () => void;
  goToRun?: () => void;
}

function Wait({ input, index, registerCard, ...rest }: WaitProps): JSX.Element {
  const cardRef = useCallback((element: HTMLElement | null) => registerCard(index, element), [registerCard, index]);
  return tierOf(input) === "permission" ? (
    <PermissionCard input={input} placement="inbox" cardRef={cardRef} {...rest} />
  ) : (
    <GateCard input={input} placement="inbox" cardRef={cardRef} {...rest} />
  );
}

/** A failed run, as a row: what failed, and what it said. */
function FailedRow({ run, live }: { run: RunSummaryView; live: boolean }): JSX.Element {
  return (
    <>
      {/* The glyph and the word are `StatusChip`'s (rule 4); nothing here says "failed" in
          colour alone or in a second voice. */}
      <StatusChip status={run.status} />
      <span className={`orca-attn__failed-name ${textClass("label")}`}>{run.name}</span>
      {run.error && <Text style="caption">{run.error.message}</Text>}
      <Time at={new Date(run.finishedAt ?? run.createdAt)} show={live ? "both" : "absolute"} />
    </>
  );
}

/**
 * The keys that belong to the *list* of cards rather than to a card: `J`/`K`, and the two
 * keyless commands (#205).
 *
 * Cancel and resume have no key on purpose. The design's keyboard table is short and every
 * letter in it is spoken for; these two are real write actions all the same, and #205's
 * whole point is that a command with no key is still a command as long as the palette can
 * find it. They are registered while there is something to act on, so what is in the
 * registry is what a person can actually do right now.
 */
function useSurfaceKeys(
  count: number,
  focusIndex: number,
  focusCard: (index: number) => void,
  actions: { cancel: () => void; resume: () => void },
): void {
  const keyboard = useKeyboard();
  const current = useRef({ count, focusIndex, focusCard, actions });
  current.current = { count, focusIndex, focusCard, actions };
  // Registered while there is something to act on, so the palette lists what can be done
  // now rather than four commands that would do nothing.
  const anything = count > 0;

  useEffect(() => {
    if (!anything) return;
    const move = (delta: number): void => {
      const { count: n, focusIndex: at, focusCard: go } = current.current;
      if (n === 0) return;
      go(Math.min(Math.max(at + delta, 0), n - 1));
    };
    const off = [
      keyboard.register({ scope: "card", key: "J", label: "Next card", action: () => move(1) }),
      keyboard.register({ scope: "card", key: "K", label: "Previous card", action: () => move(-1) }),
      keyboard.register({
        scope: "card",
        label: "Cancel the run this is waiting on",
        detail: "Stops the run; the answer is not given",
        action: () => current.current.actions.cancel(),
      }),
      keyboard.register({
        scope: "card",
        label: "Resume the run this is waiting on",
        detail: "Re-drives the run without answering; it returns when the run parks again",
        action: () => current.current.actions.resume(),
      }),
    ];
    return () => off.forEach((remove) => remove());
  }, [keyboard, anything]);
}
