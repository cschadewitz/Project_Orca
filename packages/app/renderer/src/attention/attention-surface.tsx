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
 *   five keystrokes and the count goes five to zero without navigating. That is the *only*
 *   time focus moves: the card a person is on is known by its id, so a push that puts a
 *   permission ask above it or takes a gate from above it leaves focus where it was — in a
 *   half-typed note, on a button — and focus follows a card only when that card itself left
 *   holding it (`focusAfterLeaving`, the claims list's rule).
 * - **`J`/`K` are the surface's; everything else on a card is the card's.** Moving between
 *   cards is the only thing a single card cannot know how to do. The rest — `1`–`9`,
 *   `Enter`, `⇧Enter`, `G` — is registered by whichever card has focus, which is what lets
 *   the same card be mounted inline in a run and bring its keys with it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ConnectionState } from "@orca/design";
import type { OpenInputView, RunSummaryView } from "@orca/protocol";
import { useWritability } from "../chrome/use-connection.js";
import { useKeyboard } from "../keyboard-context.js";
import { usePaletteWrites, type PaletteWrite } from "../palette/use-write-actions.js";
import { bindOptions, isFreeText } from "./card-model.js";
import { VirtualList } from "../list/index.js";
import {
  Button,
  Duration,
  StateView,
  StatusChip,
  Text,
  Time,
  focusAfterLeaving,
  idText,
  textClass,
  unit,
} from "../ui/index.js";
import type { AnswerRequest } from "./answer-card.js";
import { PendingCorrection } from "./revision-card.js";
import { revisionSlotKey, type RevisionsFeed } from "./use-revisions.js";
import { GateCard } from "./gate-card.js";
import { PermissionCard } from "./permission-card.js";
import { tierOf } from "./items.js";
import type { AttentionFeed } from "./use-attention.js";
import { useControls, type Controls } from "./use-controls.js";
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

  /* The card the person is on, by id and never by index. A push can put a permission ask
     above it (they sort first, `items.ts`) or take a gate from above it, and an index would
     then name a different card — and the keys, the palette's rows and focus would go with
     it. Undefined until a card has had focus; until then the first card is the current one. */
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const [failureIndex, setFailureIndex] = useState<number | undefined>(undefined);
  const cards = useRef(new Map<string, HTMLElement>());

  /* The cards the surface holds, by id: memoised on the ids rather than on `waits`, whose
     identity changes on every push whether or not the list changed shape. `waits` is read
     through this render's closure, which is the array `ids` was computed from. */
  const ids = waits.map((input) => input.id).join("|");
  const keys = useMemo(() => waits.map((input) => input.id), [ids]);
  const focusedAt = focusedId === undefined ? -1 : keys.indexOf(focusedId);
  const focusIndex = focusedAt === -1 ? 0 : focusedAt;

  const focusCard = useCallback((id: string) => {
    setFocusedId(id);
    cards.current.get(id)?.focus();
  }, []);

  /* One stable callback for every card's ref, rather than a closure per row: a new ref
     function each render means React detaches and re-attaches on every push. */
  const registerCard = useCallback((id: string, element: HTMLElement | null) => {
    if (element) cards.current.set(id, element);
    else cards.current.delete(id);
  }, []);

  /* The cards as the last commit drew them, and the one that left holding focus — written
     by the card's own unmount (`Wait`), in the same commit the effect below reads it in. */
  const drawn = useRef<readonly string[]>(keys);
  const leftHoldingFocus = useRef<string | undefined>(undefined);
  const onLeaveHoldingFocus = useCallback((id: string) => {
    leftHoldingFocus.current = id;
  }, []);

  /* Layout, not passive: the card has just gone and focus is on the body, and moving it in
     the same frame means there is never a keystroke with it there. A list that changed shape
     around a card that is still here changes nothing — the person keeps their place, their
     focus and their half-typed note. Only the card the person was on leaving moves anything:
     the current card becomes the one that slides into its place (the one before it when it
     was the last), and focus goes there too if it went with the card. An answer from this
     window is that case, which is how five gates clear in five keystrokes. */
  useLayoutEffect(() => {
    const before = drawn.current;
    drawn.current = keys;
    const gone = leftHoldingFocus.current;
    leftHoldingFocus.current = undefined;
    const neighbour = (id: string): string | undefined => {
      const at = focusAfterLeaving(before, keys, id);
      return at === undefined ? undefined : keys[at];
    };
    setFocusedId((id) => (id === undefined || keys.includes(id) ? id : neighbour(id)));
    if (gone === undefined || keys.includes(gone)) return;
    // Something in this same commit has already put focus somewhere: it is not lost.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const next = neighbour(gone);
    if (next !== undefined) cards.current.get(next)?.focus();
  }, [keys]);

  useSurfaceKeys(keys, focusIndex, focusCard);
  /* The palette's rows are about the card the person is on, which is what "actions on the
     current object" means when the object is one of five cards (#178). */
  useCardWrites(waits[focusIndex], waits, controls);

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
          {state.waiting === 0 ? "nothing waiting" : unit(state.waiting, "waiting")}
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
        <section className="orca-attn__section" aria-label="Waiting">
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
                registerCard={registerCard}
                onLeaveHoldingFocus={onLeaveHoldingFocus}
                onFocus={() => setFocusedId(input.id)}
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
  registerCard: (id: string, element: HTMLElement | null) => void;
  /** Called on the way out when focus was inside the card, so the list can say where it goes. */
  onLeaveHoldingFocus: (id: string) => void;
  focused: boolean;
  pending: boolean;
  cannotWrite: string | undefined;
  outcome: string | undefined;
  onAnswer: (request: AnswerRequest) => void;
  onFocus: () => void;
  goToRun?: () => void;
}

function Wait({ input, registerCard, onLeaveHoldingFocus, revisions, ...rest }: WaitProps): JSX.Element {
  const id = input.id;
  const card = useRef<HTMLElement | null>(null);
  const cardRef = useCallback(
    (element: HTMLElement | null) => {
      card.current = element;
      registerCard(id, element);
    },
    [registerCard, id],
  );
  /* The last moment the card can tell whether it holds focus: a layout effect's cleanup runs
     before React takes it out of the document, and a moment later focus is on the body. The
     claims list's rows do the same (`ClaimRow`). Nothing here changes while the card is
     mounted — it is keyed by `id` — so this runs once, on the way out. */
  useLayoutEffect(() => {
    const element = card.current;
    return () => {
      if (element?.contains(document.activeElement)) onLeaveHoldingFocus(id);
    };
  }, [id, onLeaveHoldingFocus]);
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
function useSurfaceKeys(keys: readonly string[], focusIndex: number, focusCard: (id: string) => void): void {
  const keyboard = useKeyboard();
  const current = useRef({ keys, focusIndex, focusCard });
  current.current = { keys, focusIndex, focusCard };
  // Registered while there is something to move between.
  const anything = keys.length > 0;

  useEffect(() => {
    if (!anything) return;
    const move = (delta: number): void => {
      const { keys: ids, focusIndex: at, focusCard: go } = current.current;
      const id = ids[Math.min(Math.max(at + delta, 0), ids.length - 1)];
      if (id !== undefined) go(id);
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
 *
 * **A row acts on the ask it names, or on nothing.** The palette lists its rows when it
 * opens and runs one later, and in between a push can answer the ask from another window or
 * put a new one first in the list. So a row looks its ask up again by id when it runs, and if
 * the ask has gone or now asks something else — another question, other options, another
 * run — nothing is sent, not even the cancel, and the surface says so. It never falls through
 * to whichever card happens to be current by then.
 */
function useCardWrites(input: OpenInputView | undefined, waits: readonly OpenInputView[], actions: CardWrites): void {
  /* Through a ref: `useControls` rebuilds its callbacks whenever a call goes in flight, and
     the rows must not be unregistered and re-registered underneath a keypress. The asks are
     held the same way and for the same reason — a push rebuilds the whole list. */
  const current = useRef({ input, waits, actions });
  current.current = { input, waits, actions };

  /* What the rows are *about*, as one string. The options are part of it because a gate
     re-asked with different options is a different set of rows. */
  const signature = input === undefined ? "" : writeSignature(input);

  const rows = useMemo((): readonly PaletteWrite[] => {
    const held = current.current.input;
    if (held === undefined || signature === "") return [];
    /* The ask as it is now, if it is still the one these rows were drawn for — the fresh
       copy rather than `held`, because a re-read can carry a newer `live` target. */
    const onHeld = (write: (now: OpenInputView, act: CardWrites) => void) => (): void => {
      const { waits: open, actions: act } = current.current;
      const now = open.find((candidate) => candidate.id === held.id);
      if (now === undefined || writeSignature(now) !== signature) {
        act.refuse(
          held.id,
          `Nothing was sent: "${held.question}" changed or was answered after the palette listed it.`,
        );
        return;
      }
      write(now, act);
    };
    const answers = isFreeText(held.options)
      ? []
      : bindOptions(held.options.filter((option) => option.id !== held.revision?.capability.actionId)).map(
          ({ option }) => ({
            scope: "card" as const,
            method: "inputs.answer",
            label: `Answer ${held.question}: ${option.label}`,
            detail: option.consequence ?? `Answers ${held.runName} the way the card's option does`,
            ...(option.destructive ? { tone: "danger" as const } : {}),
            action: onHeld((now, act) => act.answer(now, { optionId: option.id })),
          }),
        );
    return [
      ...answers,
      {
        scope: "card",
        method: "runs.cancel",
        label: "Cancel the run this is waiting on",
        // The confirmation names the run — its name and its id token, never the raw id; the
        // token is set in mono (rule 8) and the full id is matched, so pasting it finds this.
        labelMachine: idText(held.runId, { kind: "run" }),
        objectId: held.runId,
        detail: "Stops the run; the answer is not given",
        tone: "danger",
        confirm: `Cancel ${held.runName} ${idText(held.runId, { kind: "run" })} — confirm`,
        action: onHeld((now, act) => act.cancel(now.runId)),
      },
      {
        scope: "card",
        method: "runs.resume",
        label: "Resume the run this is waiting on",
        detail: "Re-drives the run without answering; it returns when the run parks again",
        action: onHeld((now, act) => act.resume(now.runId)),
      },
    ];
  }, [signature]);

  usePaletteWrites(rows);
}

/** The writes a card's palette rows make: `useControls`, and nothing else. */
type CardWrites = Pick<Controls, "answer" | "cancel" | "resume" | "refuse">;

/** Which ask a set of rows is about and what it asks; equal only while the rows still fit it. */
function writeSignature(input: OpenInputView): string {
  return [
    input.id,
    input.runId,
    input.question,
    input.revision?.capability.actionId ?? "",
    ...input.options.map((o) => o.id),
  ].join("|");
}
