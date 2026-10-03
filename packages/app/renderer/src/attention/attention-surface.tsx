/**
 * The Attention surface: what needs a person, and answering it without going anywhere
 * (#161, docs/design/20-attention-and-gates.md).
 *
 * Five decisions worth knowing before changing anything here:
 *
 * - **Two regions, in the tier table's order.** Permission asks and gates are cards, tier 1
 *   above tier 2; failed runs are rows below them and out of the count. A failure is
 *   something to go and read, not something a person is being asked.
 * - **At zero it says what is running, not that there is nothing (#256).** With nothing
 *   waiting and nothing failed the surface lists the running runs in place of the empty
 *   state — not beside the waits, and not as a fourth tier, because a running run is
 *   explicitly not asking for anybody's attention. It is the landing screen, and "your work
 *   is all moving, here it is" is the answer a person came for; "nothing needs you" with a
 *   blank page under it is not. Nothing is running either, and the empty state is the truth
 *   again.
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
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ConnectionState } from "@orca/design";
import type { OpenInputView, RunSummaryView } from "@orca/protocol";
import { useWritability } from "../chrome/use-connection.js";
import { useKeyboard } from "../keyboard-context.js";
import { usePaletteWrites, type PaletteWrite } from "../palette/use-write-actions.js";
import { bindOptions, isFreeText } from "./card-model.js";
import { VirtualList } from "../list/index.js";
import { Button, Duration, StateView, StatusChip, Text, Time, textClass } from "../ui/index.js";
import type { AnswerRequest } from "./answer-card.js";
import { PendingCorrection } from "./revision-card.js";
import { revisionSlotKey, type RevisionsFeed } from "./use-revisions.js";
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
   * Open the run a card came from — `G`, and the run name on a card. It stays optional
   * even now that the route table exists (#165), for the same reason `CommandPalette`'s
   * `onJump` is: `G` is registered only when it is passed, and a shortcut that navigates
   * nowhere is worse than one that is not there.
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
  const controls = useControls({ onAnswered: answered, withAnswer: feed.revisions?.withAnswer });
  const writability = useWritability();
  const live = connection === "live";

  const waits = state.phase === "ready" ? state.waits : EMPTY_WAITS;
  const failures = state.phase === "ready" ? state.failures : EMPTY_RUNS;
  const running = state.phase === "ready" ? state.running : EMPTY_RUNS;

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

  useSurfaceKeys(waits.length, focusIndex, focusCard);
  /* The palette's rows are about the card the person is on, which is what "actions on the
     current object" means when the object is one of five cards (#178). */
  useCardWrites(waits[focusIndex], controls);

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
        /* Nothing is waiting and nothing has failed: the landing screen says what is in
           flight rather than that there is nothing (#256). With failures below, the screen
           already has something on it and the empty state stands — the shape only changes
           where it would otherwise be blank. */
        failures.length === 0 && running.length > 0 ? (
          <Running runs={running} live={live} {...(onOpenRun ? { onOpenRun } : {})} />
        ) : (
          <StateView
            kind="empty"
            title={
              feed.revisions?.notice || feed.revisions?.items.length
                ? "No unanswered gates or permission asks"
                : "Nothing needs you"
            }
            body={
              feed.revisions?.notice || feed.revisions?.items.length
                ? "Recorded corrections are shown separately below."
                : "Gates and permission asks appear here the moment a run raises one."
            }
          />
        )
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
                revisions={feed.revisions}
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

      {feed.revisions?.answerNotice && (
        <div role="status">
          <Text style="caption">{feed.revisions.answerNotice}</Text>
          <Button onClick={() => feed.revisions?.checkPendingAnswer?.()}>Check pending answer</Button>
        </div>
      )}
      {feed.revisions && (feed.revisions.items.length > 0 || feed.revisions.notice) && (
        <section className="orca-attn__section" aria-label="Recorded corrections">
          <Text style="eyebrow" as="h2">
            Recorded corrections
          </Text>
          {feed.revisions.notice && (
            <>
              <Text style="caption">{feed.revisions.notice}</Text>
              <Button onClick={() => feed.revisions?.refresh()}>Refresh corrections</Button>
            </>
          )}
          {feed.revisions.items.map((entry) => (
            <PendingCorrection key={revisionSlotKey(entry.summary.target)} entry={entry} feed={feed.revisions!} />
          ))}
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
            rowClassName={() => "orca-attn__row"}
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
const EMPTY_RUNS: readonly RunSummaryView[] = [];

/**
 * What is in flight, where the empty state would otherwise be (#256).
 *
 * A component of its own rather than a branch inline, because it owns two things that have
 * to go away with it: a selection, and `Enter`. One list per scope is the substrate's rule
 * (AGENTS.md), and this list and the failures list are both in `list` — which is safe here
 * and only here, because this one is drawn *only* when there are no failures, so the two
 * are never mounted at once.
 *
 * A running run is not a tier and is not counted: it asks nothing of anybody. It is here so
 * that the app's landing screen answers "what is happening" for a person whose work is all
 * moving, instead of telling them there is nothing.
 */
function Running({
  runs,
  live,
  onOpenRun,
}: {
  runs: readonly RunSummaryView[];
  live: boolean;
  onOpenRun?: (runId: string) => void;
}): JSX.Element {
  const [index, setIndex] = useState<number | undefined>(undefined);
  const keyboard = useKeyboard();
  /* Through a ref for the reason `useSurfaceKeys` uses one: the list changes on every push
     and the shortcut must not be unregistered and re-registered under a keypress. */
  const open = useRef<(() => void) | undefined>(undefined);
  open.current =
    onOpenRun === undefined
      ? undefined
      : () => {
          const run = index === undefined ? undefined : runs[index];
          if (run) onOpenRun(run.id);
        };

  /* Registered only when there is somewhere to go, the same condition `G` on a card takes:
     a shortcut that navigates nowhere is worse than one that is not there. */
  const navigable = onOpenRun !== undefined;
  useEffect(() => {
    if (!navigable) return;
    return keyboard.register({
      scope: "list",
      key: "Enter",
      label: "Open the selected run",
      action: () => open.current?.(),
    });
  }, [keyboard, navigable]);

  return (
    <section className="orca-attn__section orca-attn__running" aria-label="Running runs">
      <Text style="eyebrow" as="h2">
        Running
      </Text>
      <Text style="caption">Nothing is waiting on you.</Text>
      <VirtualList
        items={runs}
        label="Running runs"
        className="orca-attn__running-list"
        rowId={(run) => `attention-running-${run.id}`}
        rowClassName={() => "orca-attn__row"}
        renderRow={(run) => <RunningRow run={run} live={live} />}
        selectedIndex={index}
        onSelect={setIndex}
        noun="running run"
        ticks={[]}
      />
      {navigable && <Text style="caption">Enter opens the selected run.</Text>}
    </section>
  );
}

/** A running run, as a row: what it is, and how long it has been going. */
function RunningRow({ run, live }: { run: RunSummaryView; live: boolean }): JSX.Element {
  return (
    <>
      <StatusChip status={run.status} />
      <span className={`orca-attn__run-name ${textClass("label")}`}>{run.name}</span>
      {/* Accruing while the daemon is answering; frozen at what it last said when it is
          not, because a duration that kept ticking off a dead socket would be invented. */}
      {live && run.startedAt !== undefined ? (
        <Duration since={new Date(run.startedAt)} />
      ) : (
        <Duration ms={run.durationMs ?? 0} />
      )}
    </>
  );
}

/**
 * One waiting item. The tier decides which card it is and **nothing else differs** — same
 * props, same keys, same submit — which is the property #161 asks for and the reason the
 * two components share a shell.
 */
interface WaitProps {
  input: OpenInputView;
  revisions?: RevisionsFeed | undefined;
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

function Wait({ input, index, registerCard, revisions, ...rest }: WaitProps): JSX.Element {
  const cardRef = useCallback((element: HTMLElement | null) => registerCard(index, element), [registerCard, index]);
  return tierOf(input) === "permission" ? (
    <PermissionCard input={input} placement="inbox" cardRef={cardRef} {...rest} />
  ) : (
    <GateCard input={input} revisions={revisions} placement="inbox" cardRef={cardRef} {...rest} />
  );
}

/** A failed run, as a row: what failed, and what it said. */
function FailedRow({ run, live }: { run: RunSummaryView; live: boolean }): JSX.Element {
  return (
    <>
      {/* The glyph and the word are `StatusChip`'s (rule 4); nothing here says "failed" in
          colour alone or in a second voice. */}
      <StatusChip status={run.status} />
      <span className={`orca-attn__run-name ${textClass("label")}`}>{run.name}</span>
      {run.error && <Text style="caption">{run.error.message}</Text>}
      <Time at={new Date(run.finishedAt ?? run.createdAt)} show={live ? "both" : "absolute"} />
    </>
  );
}

/**
 * The keys that belong to the *list* of cards rather than to a card: `J`/`K`, and nothing
 * else. The writes moved to `useCardWrites` below when #178 gave every write in the app the
 * same two gates.
 */
function useSurfaceKeys(count: number, focusIndex: number, focusCard: (index: number) => void): void {
  const keyboard = useKeyboard();
  const current = useRef({ count, focusIndex, focusCard });
  current.current = { count, focusIndex, focusCard };
  // Registered while there is something to move between.
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
    ];
    return () => off.forEach((remove) => remove());
  }, [keyboard, anything]);
}

/**
 * The card's three writes in the palette (#178): answer it with each option it offers,
 * cancel the run it is waiting on, resume that run.
 *
 * **The options are the card's options, in the card's order.** `bindOptions` is what puts
 * the destructive ones last and gives the rest `1`–`9` on the card itself
 * (docs/design/20-attention-and-gates.md: the destructive option is never bound to `1` and
 * never focused by default), and a second ordering here would be a second answer to a
 * safety rule. A destructive option carries the danger tone, which sinks it below every
 * other row in the palette as well.
 *
 * **The rows call the card's own path.** `useControls().answer` — the same hook, the same
 * one-call-in-flight, the same reading of what an "always" actually wrote. What the rows do
 * *not* offer is "always": that is a standing rule written into the workspace sidecar and
 * its two buttons say what they will promise before they are pressed (`alwaysOutcome`); a
 * palette row that wrote one from a single word would be promising on the daemon's behalf.
 *
 * **A free-text ask gets no rows at all.** `options` empty is the protocol's way of saying
 * "type an answer", and there is nothing to type into in a list of commands. The card is
 * where that one is answered, and it says so by being the only place it can be.
 */
function useCardWrites(
  input: OpenInputView | undefined,
  actions: {
    answer: (input: OpenInputView, request: AnswerRequest) => void;
    cancel: (runId: string) => void;
    resume: (runId: string) => void;
  },
): void {
  /* Through a ref: `useControls` rebuilds its callbacks whenever a call goes in flight, and
     the rows must not be unregistered and re-registered underneath a keypress. The input is
     held the same way and for the same reason — a push rebuilds the whole list. */
  const current = useRef({ input, actions });
  current.current = { input, actions };

  /* What the rows are *about*, as one string. The options are part of it because a gate
     re-asked with different options is a different set of rows. */
  const signature =
    input === undefined
      ? ""
      : [
          input.id,
          input.runId,
          input.question,
          input.revision?.capability.actionId ?? "",
          ...input.options.map((o) => o.id),
        ].join("|");

  const rows = useMemo((): readonly PaletteWrite[] => {
    const held = current.current.input;
    if (held === undefined || signature === "") return [];
    const answers = isFreeText(held.options)
      ? []
      : bindOptions(held.options.filter((option) => option.id !== held.revision?.capability.actionId)).map(
          ({ option }) => ({
            scope: "card" as const,
            method: "inputs.answer",
            label: `Answer ${held.question}: ${option.label}`,
            detail: option.consequence ?? `Answers ${held.runName} the way the card's option does`,
            ...(option.destructive ? { tone: "danger" as const } : {}),
            action: () => {
              const { input: now, actions: act } = current.current;
              if (now) act.answer(now, { optionId: option.id });
            },
          }),
        );
    return [
      ...answers,
      {
        scope: "card",
        method: "runs.cancel",
        label: "Cancel the run this is waiting on",
        // The run id is ORCA's and is set in mono where the confirmation names it (rule 8).
        labelMachine: held.runId,
        detail: "Stops the run; the answer is not given",
        tone: "danger",
        confirm: `Cancel ${held.runId} — confirm`,
        action: () => {
          const { input: now, actions: act } = current.current;
          if (now) act.cancel(now.runId);
        },
      },
      {
        scope: "card",
        method: "runs.resume",
        label: "Resume the run this is waiting on",
        detail: "Re-drives the run without answering; it returns when the run parks again",
        action: () => {
          const { input: now, actions: act } = current.current;
          if (now) act.resume(now.runId);
        },
      },
    ];
  }, [signature]);

  usePaletteWrites(rows);
}
