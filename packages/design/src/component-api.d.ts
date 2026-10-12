/**
 * ORCA design system — the React surface the app should expose over css/components.css.
 *
 * This file is documentation, not a shipped package. The CSS layer is the
 * implementation; these signatures say what each primitive needs from the
 * caller so two developers build the same component.
 *
 * The primitives marked "built" below exist in `packages/app/renderer/src/ui`; where the
 * implementation had to diverge from the signature drafted here, this file was corrected
 * rather than the code. The rest are still drafts and will be corrected the same way as
 * the surfaces that need them land.
 */

export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "blocked" | "held" | "stale";

/** Scheduler classification for a work item. Distinct from RunStatus on purpose. */
export type ScheduleClass = "unschedulable" | "waiting" | "held" | "ready" | "running";

export type ConnectionState = "live" | "reconnecting" | "disconnected" | "file" | "mismatch";

export type WorkflowNodeType =
  "start" | "end" | "agent" | "decision" | "gate" | "set" | "loop" | "parallel" | "subworkflow";

export type DependencyKind = "blocks" | "soft" | "informs";
export type DependencyState = "open" | "satisfied" | "failed" | "waived";

/** Status chip (built). `label` is required — status is never colour alone. */
export interface StatusChipProps {
  status: RunStatus;
  /** Defaults to the status word. Override only to add a count ("failed ×3"). */
  label?: string;
  /** Glyph-only form for a dense tree row; the word moves to the accessible name. */
  glyphOnly?: boolean;
  /**
   * `orca-chip--aligned`: the longest status word's width, so a list's statuses form one
   * column (the run tree, the claims list). A floor, not a clamp — `.orca-chip` is never
   * narrower than its own glyph and word. There is no `className`: the chip's box is the
   * component layer's, and a surface lays out around it rather than sizing it.
   * `"schedule"` (`orca-chip--aligned-schedule`) is the one column that mixes chips with
   * schedule badges — the plan's schedule column, where a settled item's outcome is a chip —
   * and takes the aligned badge's width (`--badge-aligned-width`) instead.
   */
  aligned?: boolean | "schedule";
}

/**
 * The chip's minimap form (built): a status where there is only room for a swatch — the
 * scrollbar gutter, a legend, a nav count. The one place colour carries a status alone,
 * so it is only ever drawn beside something that also says the word. Without a `label` it
 * is decorative and hidden from assistive technology.
 */
export interface StatusDotProps {
  status: RunStatus;
  label?: string;
}

/**
 * A chip that is not a status (built): a count, a filter, a role. Always `orca-chip--plain`.
 *
 * Several of them in a card or a panel go in `.orca-chips`, the one class for a run of chips,
 * which wraps rather than running past its box. A row never wraps (RULES.md rule 9), so a row
 * gives a chip a column of its own instead.
 */
export interface ChipProps {
  children: unknown;
  /** Decorative; the label beside it carries the meaning. */
  glyph?: string;
}

/**
 * Button (built). Tone is meaning: `primary` is the accent (interactive, never a state),
 * `danger` is the control that cancels or denies, `ghost` must not compete with content.
 *
 * Disabled is `aria-disabled` plus a swallowed click, not the `disabled` attribute: a
 * disabled button is unfocusable, and 40-connection-states.md requires its reason to be
 * reachable on the control itself.
 */
export interface ButtonProps {
  children: unknown;
  tone?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  disabledReason?: string;
  onClick?(): void;
}

/**
 * The raised block an interruption arrives in (built). `interrupt` is what makes it
 * announce assertively; a card replayed in a finished run must not announce at all, which
 * is why it is a prop rather than a consequence of the tone.
 */
export interface CardProps {
  children: unknown;
  tone?: "default" | "gate" | "permission";
  eyebrow?: unknown;
  interrupt?: boolean;
}

/**
 * A sunken block for text ORCA produced (built): a command, a payload, a stack trace.
 * `surface-sunken` is what says "machine output"; it is a `<pre>`, so whitespace the
 * machine emitted is whitespace the reader sees.
 */
export interface WellProps {
  children: unknown;
  /** Defaults to `mono-log`. */
  style?: TextStyleName;
  /** Names the block, which a screen reader then reads as a region on demand. */
  label?: string;
  /** So a disclosure that clamps or opens the well can name it in `aria-controls`. */
  id?: string;
}

/** The generated union of `orca-text-*` class names; see `TextStyle` in src/tokens.ts. */
export type TextStyleName = string;

/**
 * The one way to pick a type style (built). `style` deliberately shadows the DOM `style`
 * prop, so a `<Text>` cannot carry an inline value (rule 1).
 */
export interface TextProps {
  style: TextStyleName;
  children: unknown;
  /** The element to render. Defaults to `span`. */
  as?: unknown;
}

/**
 * `.orca-visually-hidden` (built, in the CSS layer only — #262): in the accessibility tree
 * and nowhere on screen. The app's polite announcer is what it was written for; a word a
 * glyph already carries, or a heading the layout gives a sighted reader, is the same shape.
 *
 * **It is a class and gets no component**, deliberately, which is why this entry is a class
 * name rather than a props interface. A `<VisuallyHidden>` wrapper would have to choose an
 * element, and the callers do not agree: the announcer is a `div` with `role="status"`, a
 * hidden heading is an `h2`, a hidden label is a `label` bound to an input. Wrapping them in
 * a `div` would break two of the three, and an `as` prop would be `className` with extra
 * steps. Rule 14 the short way: reach for the class.
 *
 * Nothing composes with it that would fight it — it sets position, box and clipping, so a
 * caller adding its own layout to the same element is the one mistake to look for.
 */
export type VisuallyHiddenClass = "orca-visually-hidden";

/**
 * An elapsed span (built), to two units at most. Exactly one of `ms` (finished) or
 * `since` (accruing) — `since` ticks at 1Hz off one clock shared by the whole renderer.
 */
export interface DurationProps {
  ms?: number;
  since?: Date;
}

/**
 * A timestamp (built). Absolute in `mono-id`, relative in `caption`, together by default
 * ("14:02:31 · 6m ago"). Drop to `absolute` when the connection is not live: a relative
 * time computed against a stale clock is a lie (40-connection-states.md).
 */
export interface TimeProps {
  at: Date;
  show?: "absolute" | "relative" | "both";
}

/**
 * A run tree row (built: `app/renderer/src/runs/tree/`).
 *
 * `selected`, `onSelect` and the row element itself are **not** the row's: the list
 * substrate owns the row, its `aria-selected` and its click, and the surface passes only
 * the cells inside it (`app/renderer/src/list/virtual-list.tsx`). They stay named here
 * because the class layer still describes a whole row.
 */
export interface RunTreeRowProps {
  id: string;
  /** Monospace: this is a machine name. */
  name: string;
  /**
   * Absent on a `note` row only. A skipped fan-out branch never became a run, so it has no
   * status and no duration — it shows the word "skipped" and why (rule 12, and rule 3: the
   * eight statuses stay eight).
   */
  status?: RunStatus;
  level: number;
  /** `note` is the fifth kind: a skipped fan-out branch, drawn as part of the fan-out. */
  kind: "run" | "step" | "attempt" | "child-run" | "note";
  expanded?: boolean;
  hasChildren?: boolean;
  selected?: boolean;
  /** Elapsed for a running step, total for a finished one. */
  durationMs?: number;
  /** "attempt 2 of 3" — shown only when attempts > 1. */
  attempt?: { n: number; of: number };
  agent?: string;
  /** A running *run*: an indeterminate meter, never a percentage (rule 12, #156). */
  meter?: boolean;
  /** The second half of a `note` row: why the branch never ran. */
  note?: string;
  onToggle?(id: string): void;
  onSelect?(id: string): void;
}

/**
 * An event timeline row (built: `app/renderer/src/runs/timeline/`).
 *
 * It was **not** promoted to a shared `ui/` component for the plan journal (#170), which
 * is drawn on the same `.orca-timeline-entry` class. The two rows are about different
 * things: an event row carries a run status, an event kind, a sequence range and a copy
 * menu for an event id, and a plan journal entry has none of those — it has an origin (who
 * did it) where an event has a status (what happened). Sharing the component would have
 * made four props optional to serve one caller each, which is two rows in one file. What
 * is shared is the class, which is where the grid, the row height and the truncation live.
 */
export interface TimelineEntryProps {
  /**
   * Event id; shown in mono-id at the end of the row and copied from the row's `Menu`.
   *
   * **Optional**, because one row has no id to show. A live `agent.update` arrives as a
   * coalesced batch — `fromSeq`, `seq` and the updates between them, and no event ids — so
   * a batch row is addressed by its sequence range instead. Inventing an id for it is what
   * rule 12 forbids.
   */
  eventId?: string;
  at: Date;
  /** The ORCA event kind, verbatim: 'step.started', 'agent.update', … */
  kind: string;
  /** One line. Subject first so a truncated row still means something. */
  summary: string;
  status?: RunStatus;
  selected?: boolean;
  /** The last sequence number the row stands for, and the first when it is coalesced. */
  seq?: number;
  fromSeq?: number;
  /** How many events the row stands for: 1, or the size of a coalesced batch. */
  count?: number;
  /**
   * A gate a policy settled with nobody asked (`decision.resolved`, `source: "gate:auto"`).
   * Drawn in `ink-secondary` and it never raises a count. The row names the *source* and
   * not the condition: `autoApproveWhen` is configuration and is not on the event.
   */
  autoApproved?: boolean;
}

/**
 * Built (#158), and corrected here against what the implementation met. Three changes,
 * each because the draft assumed something the wire does not carry:
 *
 * - `lines` became `rows`, and a row is not always a line. The stream also holds the two
 *   seams a reconnection leaves — `◷ paused — reconnecting` where it stopped and
 *   `── reconnected hh:mm:ss ──` where it came back — and they are rows because *where*
 *   the gap falls in the output is the whole of what they say.
 * - A row's number is its event's `seq`, not an ordinal `n`. An absolute line number is a
 *   thing ORCA cannot supply once the buffer has trimmed or a page has been loaded in
 *   front of it — "a line boundary is not a thing the wire can name"
 *   (docs/design/30-long-running-content.md) — and inventing one is what rule 12 forbids.
 *   `seq` repeats when one `agent.update` rendered several lines, which is honest.
 * - There is no `stream: 'stdout' | 'stderr'`. ACP has no such split; a step's output is
 *   its `agent.update` events, and the tone a line takes is derived from the update's kind
 *   and status instead.
 */
export interface OutputPaneProps {
  rows: ReadonlyArray<
    | { kind: "line"; key: string; seq: number; text: string; tone: "out" | "dim" | "err"; folded: number }
    | { kind: "paused" | "reconnected"; key: string; at: string }
  >;
  /** The pane's accessible name. Not a live region: rule 11. */
  label: string;
  /** True while the step is producing output; draws the caret. */
  streaming: boolean;
  /** 'following' pins to the bottom; 'held' shows the jump button. */
  mode: "following" | "held";
  /** Lines that arrived while held. */
  pending: number;
  /** Set when there is output in front of the buffer; renders the load-earlier marker. */
  trimmedBefore?: number;
  loadingEarlier?: boolean;
  onJumpToLatest(): void;
  /** Called once when a scroll leaves the end while following. */
  onHold(): void;
  onLoadEarlier?(): void;
}

/**
 * Built (#158). The draft's five fields became one `call` object, because every one of
 * them is a projection of the same fold over the step's log (`renderer/src/step/tool-calls.ts`)
 * and passing them apart invited a row assembled from two different calls.
 *
 * `durationMs` is gone: `agent.update` carries no timing per call, and `agent.turn.completed`
 * times the *turn*, not the call inside it. A per-call duration would be invented (rule 12).
 *
 * `body` is `{ args, result }` with each one's *pre-cut* length beside it, because
 * `toolCallBody` caps both at 2,000 characters when the event is written (#220): a row has
 * to be able to say it is showing 2,000 of 41,318 rather than end mid-token.
 */
export interface ToolCallRowProps {
  call: {
    id: string;
    tool: string;
    toolKind?: string;
    /** One-line argument summary; the full payload goes in the body. */
    argSummary: string;
    state: "pending" | "ok" | "failed" | "awaiting-permission";
    locations: readonly string[];
    args?: { text: string; length: number };
    result?: { text: string; length: number };
    /** What a person answered, once `agent.permission` has settled the call. */
    decision?: string;
    /** What they are being asked, while it is still open. */
    question?: string;
  };
  /** Open on first render. Defaults to open for a failed call and closed for the rest. */
  expanded?: boolean;
}

/**
 * Built (#159), as an *address* rather than as data. The draft passed the versions, the
 * current one and the consumed-by list in; the implementation passes
 * `{ runId, name, version, compareWith? }` and reads the rest, for two reasons:
 *
 * - The panel is opened from four places — a step's artifact chip, a gate card, the
 *   version menu and `orca://artifact/spec.md@v3` (#165) — and the last of those has
 *   nothing but a name and a version. A prop shape only a caller holding `ArtifactView`s
 *   could satisfy would have locked the deep link out.
 * - `versions`, the body and the consumed-by links are three different reads
 *   (`artifacts.list`, `artifacts.get`, `runs.get`), and hoisting them into the caller
 *   would have made every caller do all three.
 *
 * `onSelectVersion` is gone for the same reason: version selection, the comparison and the
 * panel's open state are one controller held above every surface
 * (`renderer/src/artifacts/panel-context.tsx`), not a callback a parent has to hold.
 *
 * There is **no rendered/raw toggle**, and that is decided (#245, v0.5.0), not pending:
 * an artifact body is machine output (rule 8, mono means ORCA produced it) written by an
 * agent, so it is untrusted input, and rendering it would mean a sanitising markdown
 * dependency `packages/app` has chosen not to take. The body stays raw in `mono-log`; a
 * remote link or image in it is never fetched, because it is never turned into markup.
 * Reopening this means a new issue with the dependency named, not a toggle.
 */
export interface ArtifactPanelProps {
  target: {
    runId: string;
    /** The logical name within the run — what `artifacts.list` groups versions by. */
    name: string;
    version: number;
    /** When set, the body renders as a diff against this version of the same name. */
    compareWith?: number;
  };
}

/**
 * One option a gate, a decision or a permission ask offers — the model's `GateOption`, which
 * is also the wire's (`@orca/core`'s `run.ts`, `OpenInputView.options`). This is a correction
 * of the draft, not a second shape: the draft required `consequence` and offered a `tone`,
 * and neither survived contact (#247).
 *
 * `consequence` is optional because it is the *author's* to write. A workflow that says
 * nothing about what rejecting does leaves this empty, and a card that invented a clause
 * would be making up runtime facts (RULES.md rule 12). Ask for one in review; do not fake it.
 *
 * `tone` is gone. The one distinction a card has to draw is "this option destroys something",
 * which is `destructive` — a property of the option, checkable, and what the design's rule
 * about never binding it to `1` is written against. A three-value presentation hint invited a
 * caller to colour a safe option `danger` and left the real flag unrepresented.
 */
export interface GateOption {
  id: string;
  label: string;
  /** One clause on what happens if chosen. Absent when the workflow's author wrote none. */
  consequence?: string;
  /** Never bound to a number key, never the default focus (docs/design/20-attention-and-gates.md). */
  destructive?: boolean;
}

/**
 * Who is blocked on an ask: an agent and the host it runs on, as `OpenInputView.agent` and
 * `input.opened` carry it (protocol 1.6, #248). `hostType` is absent when that host is no
 * longer configured — say nothing rather than guess at the transport.
 */
export interface InputAgent {
  id: string;
  hostId: string;
  hostType?: "local" | "ssh";
}

/**
 * The ask a card renders, mirroring `@orca/protocol`'s `OpenInputView` (protocol 1.6).
 * It is restated rather than imported because this file is documentation and imports
 * nothing from the runtime - so if the wire's view gains a field, this mirror is corrected
 * here in the same PR, the way the rest of this file is.
 */
export interface OpenInputView {
  id: string;
  kind: "decision" | "permission" | "question";
  question: string;
  /** The options offered, verbatim. Empty means free text; answer with an option's `id`. */
  options: ReadonlyArray<GateOption>;
  /** Whatever the asking step attached (tool call, file path, policy). Rendered as-is or not at all. */
  context: Readonly<Record<string, unknown>>;
  runId: string;
  runName: string;
  stepRunId: string;
  nodeId?: string;
  workItem?: { id: string; title: string };
  /** Who is blocked, on a permission ask. Absent on a gate, and on an ask older than 1.6. */
  agent?: InputAgent;
  requestedAt: string;
  /** Measured against the result's `asOf`, so a client's own clock never enters into it. */
  waitingMs: number;
  /** The artifacts the step had in hand when it asked: what the decision is about. */
  artifacts: ReadonlyArray<{ name: string; version: number }>;
}

export interface GateCardProps {
  /**
   * The ask whole, as `inputs.list` and `input.opened` give it, rather than the eight
   * fields this block used to list separately. Those fields *are* that view's fields, and
   * the card has two mountings - the Attention list and inline in a run's step detail
   * (#158, #161) - so passing the view is what makes "identical controls and identical
   * keyboard handling" a property of the component instead of two call sites remembering
   * to spread the same eight things the same way.
   */
  input: OpenInputView;
  /** Rendered inline in a run, or in the attention list. Behaviour is identical. */
  placement: "inline" | "inbox";
  /**
   * Whether the artifacts the decision is about are in hand. False disables the options
   * with the reason said on the control: the app does not offer an answer it could not
   * show the basis for. Derived from the ask when it is not given, so the list and an
   * inline mounting cannot disagree about it.
   */
  artifactsReady?: boolean;
  /** Why this app cannot write right now, from `useWritability()`. Absent means it can. */
  cannotWrite?: string;
  /** This card has the keyboard: it registers `1`-`9`, `Enter`, `⇧Enter` and `G`. */
  focused?: boolean;
  /** An answer is in flight; the controls wait rather than being pressed twice. */
  pending?: boolean;
  /** What the daemon said about the last answer, said on the card that is still on screen. */
  outcome?: string;
  /**
   * The note is the person's reasoning and the run does not branch on it - but it is now
   * recorded on `human.answered` with the answer (#238), so the card may say it is kept.
   * Until this release it reached the daemon's own log and nothing that outlived the run.
   */
  onAnswer(request: { optionId: string; note?: string; always?: { decision: "allow" | "deny" } }): void;
  /** Present only when there is somewhere to go; `G` is registered only when it is. */
  goToRun?: () => void;
}

/**
 * A permission ask: an agent's turn is held open on a tool call. Three fields of the draft
 * were wrong about the runtime and are corrected here rather than in the app (AGENTS.md).
 *
 * **`kind` is an ACP tool kind, not a category somebody invented.** The draft's
 * `'exec' | 'write' | 'read' | 'network'` matches nothing: the vocabulary is
 * `ToolKindSchema` (`packages/core/src/model/agent.ts`), it is what an agent sends and what
 * a permission rule matches on, and `network` is not in it at all. Ten values, mirrored here
 * so this file does not import from the runtime.
 *
 * **The options are the agent's own.** The draft's `'allow-once' | 'allow-always' | 'deny'`
 * assumed ORCA composes the choice; it does not. The ask arrives with the agent's options and
 * they travel verbatim (`Orchestrator`'s `askPermission`), because their ids are the agent's
 * contract and an ORCA that renamed them would be answering a different question.
 *
 * **"Always" is a separate modifier, not a fourth option.** `inputs.answer` takes `optionId`
 * *plus* an optional `always: { decision }`, and the client is what states the decision —
 * ORCA will not read an agent's option ids and guess which way a standing grant goes
 * (`packages/protocol/src/control.ts`). So the card renders one row of the agent's options
 * and one affordance beside them, and `onAnswer` carries the two separately.
 */
export interface PermissionCardProps {
  /**
   * The ask whole, for the reason `GateCardProps.input` gives. The agent and its host come
   * off it too (`OpenInputView.agent`, protocol 1.6, #248): who is blocked is what makes
   * "always allow" a decision a person can size, and an ask recorded before 1.6 carries
   * none, in which case the card says the run rather than guessing a process.
   *
   * `kind` is not a prop: the ten ACP tool kinds live on the tool call, and what this card
   * shows verbatim is the subject out of the ask's `context` (rule 12 - it shows what the
   * step attached, and the question alone when it attached nothing).
   */
  input: OpenInputView;
  placement: "inline" | "inbox";
  cannotWrite?: string;
  focused?: boolean;
  pending?: boolean;
  outcome?: string;
  /**
   * `always` says which way the standing rule goes, and is the client's statement rather
   * than a reading of `optionId` - ORCA will not read an agent's own option ids and guess.
   * Absent means answer this one call. A card that promises "ORCA will not ask again" must
   * read the result's `added`, `alreadyPresent` and `refused` before saying so; a daemon
   * with nowhere to write a rule answers `refused` and the card says that instead.
   */
  onAnswer(request: { optionId: string; note?: string; always?: { decision: "allow" | "deny" } }): void;
  goToRun?: () => void;
}

/**
 * Built, and corrected here against what the Plan surface met (#170) and since:
 *
 * - **Glyph and word, not word alone.** `SCHEDULE_PRESENTATION` now carries a glyph for
 *   each of the five, the way `STATUS_PRESENTATION` does: a classification is never
 *   carried by its tint (rule 4). The glyphs are reused from the run statuses whose colour
 *   each classification already borrows — ◐ running, ▣ waiting on deps, ⏸ held, ⊘
 *   unschedulable — with ▸ for `ready`, which means "next" rather than a state.
 * - **The wire has seven classifications and this draws five.** `ItemClassification`
 *   (`@orca/protocol`) adds `done` and `failed`, which are item *outcomes* rather than
 *   places in the schedule — a settled item is not in the ordering at all. A surface draws
 *   those two with `StatusChip`'s `succeeded` and `failed`, and never invents a sixth
 *   badge (`renderer/src/plan/plan-model.ts` holds the mapping).
 * - **`onExplain` is no longer the only disclosure.** The explanation is the app's one
 *   `Menu`, and a `Menu` owns its own trigger — so a caller that owns the disclosure (the
 *   schedule table) omits `onExplain` and draws that trigger *beside* the badge with the
 *   same `.orca-badge__why` class. Neither draws no disclosure at all, which is the badge
 *   as a *label* (the inspector, the dependency strip).
 * - **The why is beside the badge, never inside it.** It is a control and so `accent`,
 *   which is never a state (rule 5), and a link drawn on the classification's tint reads
 *   as part of it. Inside, the tint ended after "why" on a classified row and before it on
 *   a settled one (whose outcome chip had the why beside it), and the links did not line up.
 *   The `explanation` slot that put a caller's trigger inside the badge is gone with it.
 * - **`aligned`** (`orca-badge--aligned`): the longest schedule word's width
 *   (`--badge-aligned-width`, "waiting on deps"), so a column of badges — and of
 *   `StatusChip`s drawn `aligned="schedule"` beside them — ends at one edge and every why
 *   after them starts at one. A floor: `.orca-badge` is never narrower than its word.
 */
export interface ScheduleBadgeProps {
  classification: ScheduleClass;
  /** Draws a **why** button beside the badge that opens the explanation popover. */
  onExplain?(): void;
  /** The longest schedule word's width, for a column of them. */
  aligned?: boolean;
}

/**
 * Dependency node (built, #171: `renderer/src/ui/dependency-node.tsx`). Corrected against
 * what the graph met:
 *
 * - **No `kind`.** A dependency's kind is a fact about an *edge* and is drawn as the edge's
 *   stroke (`.orca-dep-edge--blocks|soft|informs`); a node can sit on edges of all three.
 * - **`name` and an optional `title`**, not `itemId`/`title`: a decision or an external target
 *   has a key and no title, and every node's name is drawn in mono.
 * - **`state` is folded from the edges around the node** (failed, else open, else waived,
 *   else satisfied) and said as a word as well as a border colour; `inCycle` says "on a cycle".
 * - **No `onWaive`.** A waive is about one dependency, not a node, so it lives in the
 *   relationship inspector in the docked panel, armed with a confirmation naming what it
 *   unblocks. The node is an `option` on a one-tab-stop canvas and never a control.
 */
export interface DependencyNodeProps {
  id: string;
  name: string;
  title?: string;
  /** 'decision' and 'external' targets render a different glyph and word, same shell. */
  target: "item" | "decision" | "external";
  state: DependencyState;
  inCycle?: boolean;
  selected?: boolean;
  onOpen?(): void;
}

/** The four levels `core` cuts a risk matrix into, lowest first. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Risk matrix (built, #172: `renderer/src/ui/risk-matrix.tsx`). Corrected against the wire
 * (`RisksListResult` in `@orca/protocol`) in four places:
 *
 * - **The grid is the plan's, not 5×5.** `riskMatrix.scale` runs 2..10, so `scale` is a
 *   prop and likelihood and impact are plain numbers in `1..scale`.
 * - **The band comes from `thresholds`,** the plan's minimum score for each level above
 *   `low`. The four core levels draw on the four grounds: low → `risk-low`, medium →
 *   `risk-moderate`, high → `risk-high`, critical → `risk-severe` (hatched).
 * - **`appetite` is a level word, not a number.** It is the plan's `policy.riskAppetite`;
 *   every cell whose level is above it is outlined (`.orca-risk__appetite`).
 * - **A risk has a `key` and a `title`,** and both are drawn on its pin — key in mono, title
 *   in sans, never a tooltip. What it holds is the detail's, not the pin's.
 */
export interface RiskMatrixProps {
  scale: number;
  thresholds: { medium: number; high: number; critical: number };
  appetite: RiskLevel;
  risks: ReadonlyArray<{
    id: string;
    key: string;
    title: string;
    likelihood: number;
    impact: number;
  }>;
  selected?: string;
  onSelect(riskId: string): void;
}

/**
 * Decision matrix (built, #173: `renderer/src/ui/decision-matrix.tsx`). Corrected against the
 * wire (`DecisionView` in `@orca/protocol`):
 *
 * - **`key` and `name`, not `id` and `label`,** and a criterion carries its `direction`
 *   (`maximize` | `minimize`) — a minimised criterion is drawn as "lower is better".
 * - **Scores run 0..`scale`,** which is the decision's own and is drawn beside each score.
 * - **The recommendation and the totals are `result`,** `core`'s `evaluateDecisionMatrix`
 *   (stored, or previewed by the daemon with `resultIsPreview`), never computed by the
 *   component. The recommended column is `.orca-matrix__win`, outlined in accent.
 * - **Deciding is `onChoose`,** one control per option column; absent once decided, when
 *   `chosen` names the column instead. Due-by and supersedes are the surface's, not the
 *   table's: they describe the decision, and the table is its arithmetic.
 */
export interface DecisionMatrixProps {
  criteria: ReadonlyArray<{
    key: string;
    name: string;
    weight: number;
    direction: "maximize" | "minimize";
    description?: string;
  }>;
  options: ReadonlyArray<{ key: string; name: string; scores: Record<string, number> }>;
  scale: number;
  result?: {
    ranking: ReadonlyArray<{ option: string; score: number; normalized: number }>;
    recommended: string;
    margin: number;
    confidence: "clear" | "close" | "tie";
  };
  chosen?: string;
  /** Present while the decision is open; never auto-applied from the app. */
  onChoose?(option: string): void;
  disabledReason?: string;
  label: string;
}

/**
 * Built, and corrected against the wire it is drawn from (`AgentView` in `@orca/protocol`).
 * Four things the draft got wrong, all of them found by building it:
 *
 * - **`state` has four values, not three.** `unknown` is the state of every agent on a
 *   freshly started daemon: health is tracked in the daemon's process and never persisted
 *   (#222), so "nothing has contacted this agent since the daemon started" is the honest
 *   answer and not a missing one. `AGENT_HEALTH_PRESENTATION` carries its word and glyph.
 * - **A host has an id, not a name.** Nothing in ORCA names a host; `hosts:` in the config
 *   is a list of ids, which is also what an agent's `hostId` points at and what the cards
 *   are grouped by. `transport` is optional for the same reason the wire's `hostType` is:
 *   an agent whose host has left the config has no transport to report, and `local` would
 *   be a guess (RULES.md rule 12).
 * - **Two timestamps, not one (#227).** `lastHandshakeAt` is when ORCA last established a
 *   connection — what `state`, `roundTripMs` and `consecutiveFailures` are about — and
 *   `lastSeenAt` is when the agent last said anything. A pooled session handshakes once and
 *   then talks for an hour, so one `lastAt` would have to choose between them. Both are
 *   absent until first contact.
 * - **There is no `policy`.** Nothing in ORCA counts auto-approvals: permission decisions
 *   are evaluated per tool call, first-match-wins, against the agent's configured rules and
 *   then the `orca.permissions.json` sidecar layered after them (ADR 0009, `PermissionRule`)
 *   — and no running total is kept anywhere, on the wire or off it. Rule 12 forbids
 *   inventing one, so the field is gone rather than approximated.
 *
 *   A permission *policy* surface is its own screen and not a line on this card, and as of
 *   #176 it is built: the card carries one action, **Permissions**, which opens that agent's
 *   policy as an inspector beside the cards. The configured rules are read-only there — they
 *   are the YAML's, and nothing machine-written rewrites a hand-curated array — and the
 *   sidecar's grants are editable through the `permissions` document of `config.set`.
 * - **And there is no `claim` either, for the same reason.** A `ClaimView` names the work
 *   item and the *run* that owns it; it names no agent, and an `AgentView` names no run. So
 *   "what is this agent on" cannot be answered from `agents.list`, however much the card
 *   wants to say it. The claims travel with the list all the same and the surface renders
 *   them as their own region, where a claim is a work item and the run holding it — which
 *   is what the data does support (RULES.md rule 12).
 */
export interface AgentHealthCardProps {
  /** The agent's id. There is no separate display name; ids are what config and runs use. */
  name: string;
  /**
   * Gives way to `name` on the card's one header line: it truncates at its end, whole in its
   * title, because the host heading above the cards already says it.
   */
  host: { id: string; transport?: "local" | "ssh" };
  /** Every one of them, as a run of chips that wraps inside the card (`.orca-chips`). */
  roles: ReadonlyArray<string>;
  state: "unknown" | "ok" | "degraded" | "down";
  /** The last handshake attempt, successful or not. Absent while `unknown`. */
  lastHandshakeAt?: Date;
  /** The last time it said anything at all — output from an old session counts. */
  lastSeenAt?: Date;
  /** Round trip of the last *successful* handshake; it survives a later failure. */
  roundTripMs?: number;
  /** Failed handshakes since the last successful one. Non-zero exactly while `down`. */
  consecutiveFailures: number;
  /** Why the last handshake failed. Kept only while `down`. */
  lastError?: { code: string; message: string };
  /** False when the daemon is not answering: the timestamps stop reading as relative. */
  live?: boolean;
  /**
   * Open this agent's permission policy (#176). A *read* — `config.get` is answered by a
   * read-only daemon too — so the action is present whatever the connection says, and it is
   * the editor inside that goes read-only. Absent means there is nowhere to open it, and a
   * card with nowhere to send you draws no button rather than one that does nothing.
   */
  onEditPermissions?(): void;
}

/**
 * Built, and corrected twice by building it (#175, #266).
 *
 * `children` is a render function, not a node: the field owns no control, but it does own
 * the ids that tie the label, the help and the error to whatever control the caller puts
 * inside it, and it has to hand them over to do that.
 *
 * - **The path is into a *document*, not into "the YAML".** Config shows two: the YAML and
 *   the ADR 0009 permission sidecar, which is JSON and has keys of its own. `document` says
 *   which, and it is what makes **raw** open the right file; it defaults to `config`,
 *   because most of the form is about the YAML.
 * - **`onShowRaw` is optional.** One section of the Config surface is fields of a document
 *   ORCA does not own — the app's own preferences (theme, per-surface density) — which have
 *   a key and no raw view anywhere in the app to show it in. Those fields still show their
 *   path, because it is what gets written, and draw no **raw** button rather than a button
 *   that does nothing.
 */
export type ConfigFieldDocument = "config" | "permissions";

export interface ConfigFieldProps {
  label: string;
  /** Dotted path into `document` — always shown, it is how the form maps to the file. */
  path: string;
  /** Which of the workspace's two configuration documents that path is in. Defaults to `config`. */
  document?: ConfigFieldDocument;
  children(control: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }): unknown;
  help?: string;
  error?: string;
  /** Opens that document's raw view, scrolled to and highlighting this path. */
  onShowRaw?(path: string, document: ConfigFieldDocument): void;
}

/**
 * Built (#175). The config surface's save bar, over `.orca-draftbar` — and the bar the
 * workflow editor reuses rather than redraws: "the draft bar is the config editor's save
 * bar with two more actions" (docs/design/70-workflow-editing.md), those two being
 * **Validate all** and **Publish**.
 *
 * `changes` counts what would be *written*, not what was typed: a field edited back to the
 * file's own value is not a change. The bar is **absent** rather than disabled where there
 * is no `config.set` to call at all — file mode, and a `--read-only` daemon — which is the
 * caller's decision; `disabledReason` is for the states where the daemon would take the
 * write if it were answering, and it comes from `useWritability()`.
 */
export interface DraftBarProps {
  changes: number;
  /** A call is out; the buttons wait rather than sending a second write. */
  busy: boolean;
  /** The `CONFIG_STALE` message. Turns the bar `--blocked` and offers **Reload**; the draft is kept. */
  conflict?: string;
  /** What the last Validate or Save said, in words. */
  message?: string;
  /** Why the daemon cannot take a write right now. Never composed by the bar itself. */
  disabledReason?: string;
  /** Which of the form and the raw editor holds the live draft: the last edited wins. */
  note?: string;
  onValidate(): void;
  onSave(): void;
  onDiscard(): void;
  onReload(): void;
}

/**
 * Built (#177), in `renderer/src/ui/workflow-node.tsx`. Four corrections the implementation
 * forced, each of them a thing the draft could not express:
 *
 * - **`type` may be undefined and `typeLabel` is separate.** `WorkflowNodeView.type` is the
 *   node type verbatim and may be a `custom:<name>` a plugin registered; the protocol says a
 *   client that does not know a type draws the generic node rather than dropping it. So the
 *   icon takes one of the nine or nothing, and the eyebrow prints the type as written.
 * - **`id` is required, and `onOpen` takes it.** Selection on the canvas is
 *   `aria-activedescendant` over one tab stop, which needs a DOM id — and a node's *name* is
 *   not unique (two nodes may share one) while its id is.
 * - **`collapsed`** — a collapsed `subworkflow` or `parallel` says how many graphs it is
 *   hiding, which is the whole of what a person gets back for the ones they cannot see.
 * - **`untaken` draws at `--opacity-untaken`, not `--opacity-stale`.** The component layer
 *   already bound `.orca-node--untaken` to the token named for it; `opacity-stale` is the
 *   one a disconnected surface uses, and they are different states.
 *
 * `onOpen` is optional: a node drawn inside an expanded group box in a read-only viewer is
 * a picture of a node, and a click target that does nothing is worse than none.
 *
 * The box is `node-w` × `node-h` and never grows, because the layout routes every edge
 * against that box. So no prop's text sets the height: the kind and the meta line are one
 * line each and the name at most two, cut at their end and whole in each part's `title`
 * (`DependencyNode` takes the same box and the same rule).
 */
export interface WorkflowNodeProps {
  id: string;
  /** One of the nine, or undefined for a `custom:*` with no icon of its own. */
  type?: WorkflowNodeType;
  /** The type as written, which is what the kind eyebrow prints. One line, cut at its end. */
  typeLabel: string;
  /** Drawn in mono, at most two lines, cut at the end of the second. */
  name: string;
  /** Present only when a run is overlaid. Absent means 'definition view'. */
  runState?: { status: RunStatus; attempts?: number; current?: boolean };
  /** True when a run is overlaid and this node was not traversed. */
  untaken?: boolean;
  selected?: boolean;
  /**
   * What a collapsed container is hiding, counted: `2 nested graphs`. The last thing on the
   * one meta line, so it is the part that gives way when the line runs out of room.
   */
  collapsed?: string;
  onOpen?(id: string): void;
}

/** Generated: `OBJECT_KINDS` from semantics.json's `objectKind`. */
export type ObjectKind = "run" | "workItem" | "request" | "step" | "gate" | "event";

/**
 * Object id (built: `renderer/src/ui/object-id.tsx`, over `.orca-objid`). The one way an
 * ORCA id reaches the screen in a row or a header; nothing prints or slices a raw id
 * (RULES.md rule 8, held by `renderer/test/object-id-guard.test.ts`).
 *
 * - **Name first, id second.** Where an object has a human name it leads, sans, and is cut at
 *   its end; the id follows as a faint **token** — the kind's glyph and the last six
 *   characters of the id, `Database schema ⬡ 5M579G`. With no name the token stands alone
 *   and is not faint. The token is `flex: none`: it never truncates and never wraps.
 * - **Six characters for every format** (ULID, keyed hash, UUID). A list in which two ids
 *   share a tail lengthens just those (`useIdTails`, over the whole list's data, suffix-
 *   preserving) — a safety net that should almost never fire.
 * - **The whole id is one action away**: `title` on the token, **Copy id** in the object
 *   header's crumb menu, the palette's matching, and `variant="full"` for a detail pane.
 * - **Accessible name is the kind's word and the tail** ("run 7X8PXX"): the glyph is
 *   `aria-hidden` and the word is in the text, visually hidden.
 *
 * Events are the exception: a timeline row names its event by sequence number (`#148`), and
 * the event's copy menu keeps the full id. There is no `copyable` prop: copying is a menu's
 * act, and a row that is a click target already has one meaning for a click.
 */
export interface ObjectIdProps {
  id: string;
  /** Inferred from the id's prefix; required for an unprefixed id (a bare UUID). */
  kind?: ObjectKind;
  /** `row` (default), `header` (always faint, after a crumb's name and type), `full` (verbatim). */
  variant?: "row" | "header" | "full";
  /** What a person calls the object; leads, truncates. */
  name?: string;
  /** From `useIdTails(ids)` over the whole list; six characters otherwise. */
  tail?: string;
}

/** `plan` is the root of the Plan surface's trail (#170): plan ▸ work item. */
export type CrumbType = "plan" | "request" | "item" | "run" | "step" | "workflow" | "agent" | "config";

export interface Crumb {
  type: CrumbType;
  id: string;
  label: string;
  current?: boolean;
  /**
   * The ids this crumb's counterparts name, where the surface that built it knows them:
   * `{ workflow: "ai-sdlc" }` on a run crumb (#177). Most counterparts are queries over data
   * no breadcrumb holds; this is how the one that is not says so.
   */
  counterpartIds?: Readonly<Record<string, string>>;
  /**
   * Added in #177. The workflow this object runs and the version it is pinned to, as one
   * string: `ai-sdlc v11`. 70-workflow-editing.md asks for the version wherever a run's
   * workflow is named, and the run header is a crumb — the header could not carry it
   * without this. The `◷ pinned` chip is deliberately not here: it is a comparison against
   * the definition on disk, which is a second read the runs surface does not make.
   */
  version?: string;
}

/**
 * The counterpart objects a crumb can lead to. The four 10-information-architecture.md
 * names, and no more: a crumb type with none renders no menu rather than an empty one.
 */
export interface Counterpart {
  id: string;
  label: string;
  leadsTo: CrumbType;
}

/**
 * Built. The two navigation callbacks were not in the original draft, and without them
 * the header cannot be the app's only breadcrumb: `onOpen` for the crumb itself (never
 * called for the current crumb, which is not a link) and `onOpenCounterpart` for its
 * menu. Omitting `onOpenCounterpart` suppresses the menus entirely.
 */
export interface ObjectHeaderProps {
  crumbs: ReadonlyArray<Crumb>;
  /**
   * The **mode variant** (#170). `docs/design/80-dependency-graph-options.md` ships option
   * B, and its second concrete change to the rest of the system is this one: "the object
   * header gains a mode segmented control, which is a new `ObjectHeader` variant". It
   * draws `.orca-seg` to the right of the trail, before `actions`.
   *
   * The modes are the object's views, not destinations — Plan's Schedule and Journal — and
   * a mode this build does not have is **absent** rather than disabled: the dependency
   * graph (#171), the risk matrix (#172) and the decision matrix (#173) are v0.6.0, and a
   * segment that never does anything is a dead end. `aria-pressed` on buttons in a named
   * group, not a tablist: one pane, two views, and no arrow-key contract to promise.
   */
  mode?: {
    options: ReadonlyArray<{ id: string; label: string }>;
    active: string;
    onChange(id: string): void;
    /** The group's accessible name. Defaults to "View". */
    label?: string;
  };
  actions?: unknown;
  /**
   * Called for a crumb, and for a folded crumb chosen from `…`, which navigates exactly as
   * the crumb would have. Never called for the current crumb, which is not a link.
   */
  onOpen?(crumb: Crumb): void;
  onOpenCounterpart?(crumb: Crumb, counterpart: Counterpart): void;
  /**
   * **Chain elision.** A trail that does not fit folds its middle into a `…` control: the
   * crumbs after the root fold first, nearest the root first, until the root, `…`, the parent
   * and the current crumb are left; then the parent folds; then the current crumb's name is
   * cut at its end (`.orca-objhead__crumb--current`). The root and the current crumb never
   * fold; a trail of one or two never does. The type label, the id token and the version are
   * never cut. `…` is a `Menu` of the folded crumbs (name, token, type as the hint) whose
   * accessible name lists them in order ("2 hidden levels: work item …, run …").
   *
   * The decision is `elideTrail` in `ui/crumb-elision.ts`, a pure function over natural
   * widths, re-measured on a `ResizeObserver`. This is how the header learns them: the
   * trail (`.orca-objhead__trail`, which takes the header's room from zero, so its width is
   * the room), every crumb's item in chain order — the folded ones from the unseen, `inert`
   * `.orca-objhead__measure` row — and an unseen `…`. The default measures the document; a
   * test injects widths, because happy-dom measures every box as zero, which folds nothing.
   */
  measure?: (
    trail: Element,
    crumbs: ReadonlyArray<Element>,
    elision: Element,
  ) => { available: number; crumbs: ReadonlyArray<number>; elision: number; gap: number };
}

/**
 * Built (#202). The app's one popover: `.orca-menu` hung off a trigger button inside
 * `.orca-menu-anchor`. Every popover uses it — the crumb's counterparts, and the schedule
 * explanation, artifact versions and risk detail that follow — because the behaviour the
 * accessibility spec asks for is not per-surface work:
 *
 *  - roving focus over the items (`↑`/`↓`, `Home`/`End`, `Enter`, and typeahead on the
 *    first letter), registered in the keyboard map's `menu` scope so the command palette
 *    lists it;
 *  - focus into the menu on open and back to the trigger on close, `Esc` included — `Esc`
 *    is the layer stack's, never the component's. Focus lands on the first item that is
 *    neither disabled nor `danger`, so an `Enter` pressed out of habit destroys nothing; and
 *    **a destructive item is never first** in the list a caller passes, the rule a gate's
 *    options and the palette's rows keep too;
 *  - placement that flips rather than clips, above the trigger when the window has no room
 *    below and aligned to the trailing edge when it has none to the right
 *    (`.orca-menu--above`, `.orca-menu--end`).
 *
 * An empty `items` renders nothing at all, trigger included: a disclosure that opens an
 * empty list is worse than no disclosure.
 */
export interface MenuItem {
  id: string;
  label: string;
  /**
   * A one-word meta in `.orca-menu__type` — the type a counterpart leads to, a version date.
   * Eyebrow style, so uppercase and unwrapped: never a sentence (that is the menu's `note`)
   * and never an id, which uppercase would re-capitalise.
   */
  hint?: string;
  /**
   * The same trailing meta when it is machine text — an intent id, a workflow's
   * `id · vN · N nodes`, `orca://` — in `.orca-menu__machine`: mono, never re-cased. An id
   * token from `idText` is drawn as one (glyph decorative, kind as a word). Instead of `hint`.
   */
  hintMachine?: string;
  /**
   * The id of the object the item names, drawn after the label as a faint `ObjectId` token —
   * the workflow viewer's run picker, where runs of one workflow share a name. The label
   * still leads and is what typeahead reads.
   */
  labelId?: string;
  /** The kind of `labelId`, for an id whose prefix does not say (an unprefixed UUID). */
  labelKind?: ObjectKind;
  /**
   * The object has no name: the `labelId` token is drawn in the label's place, not faint, and
   * `label` is the token said as words (`idWords`), which typeahead reads. A request in the
   * object header's `…`.
   */
  nameless?: boolean;
  /** Shown, named and skipped by the arrow keys rather than hidden. */
  disabled?: boolean;
  /**
   * A destructive choice: `.orca-menu__item--danger`, led by `✕` so the colour is not the
   * only channel, and never focused when the menu opens. List it after the safe choices.
   */
  danger?: boolean;
}

export interface MenuProps {
  /** The accessible name of the trigger and of the menu it opens. */
  label: string;
  items: ReadonlyArray<MenuItem>;
  onChoose(item: MenuItem): void;
  /** The trigger's content. */
  children: unknown;
  /** The trigger's own class, so a surface keeps its disclosure styling (`orca-crumb__more`). */
  triggerClassName?: string;
  /** Injected measurement for placement; the default measures the document. */
  measure?: (
    trigger: Element,
    menu: Element,
  ) => {
    trigger: { top: number; left: number; width: number; height: number };
    menu: { width: number; height: number };
    viewport: { width: number; height: number };
  };
  /**
   * Controlled disclosure (#170). Pass both or neither. It exists for the one case a
   * surface cannot press the trigger itself: `orca://item/<slug>` lands on Plan **with the
   * explanation open**, and a link that arrives is not a click. Everything else stays the
   * primitive's, so a controlled menu is the same menu with its open state one level up.
   */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /**
   * Something the popover has to *say* rather than offer (#170): an error where a list of
   * choices was expected, or a sentence an item would otherwise have carried as its `hint`.
   * Rendered above the items, never a `menuitem`, never focused, typed to or chosen — so it
   * cannot be copied as though it were one of them. A menu with a note and no items still
   * renders its trigger and still opens; focus lands on the list itself, so `Esc` returns
   * it to the trigger.
   *
   * It is deliberately not a disabled item: a disabled item is still counted and read as
   * one of the choices, and a menu whose only row is a disabled error is a popover focus
   * cannot enter.
   */
  note?: unknown;
}

/** Built — rendering only; the state machine that decides which state is live is #163. */
export interface ConnectionIndicatorProps {
  state: ConnectionState;
  /** For 'reconnecting': when the attempt started. For 'disconnected': the last event. */
  since: Date;
  eventCursor?: number;
  versions?: { app: string; daemon: string };
}

/**
 * Built, as a union rather than a record with optional fields: "omit only for 'loading'"
 * is a rule the types can hold, and a state view with no body and no way out is the dead
 * end the information architecture exists to prevent. `loading` takes neither; every
 * other kind requires a body and may carry an action.
 *
 * The glyph per kind comes from `STATE_VIEW_PRESENTATION` in semantics.json, so it is
 * covered by the bundled-font check like every other glyph the app draws.
 */
export type StateViewProps =
  | { kind: "loading"; title: string }
  | {
      kind: "empty" | "error" | "disconnected" | "no-results";
      title: string;
      /** What the person can do about it. */
      body: string;
      action?: { label: string; onClick(): void };
    };

/**
 * The status minimap's kinds (built, as part of `VirtualList`). Three statuses, not eight:
 * `.orca-minimap__tick--failed`, `--waiting` and `--blocked` are the only tick colours
 * components.css declares, and that is the design decision rather than an omission — a
 * gutter that marked every row would mark nothing. These are the three a person scrolls a
 * long list looking for.
 *
 * `current` is the fourth and is not a status: it is where the rendered window sits, so over
 * fifty thousand rows the gutter says where you are as well as where the trouble is. It
 * draws *taller* rather than only in another colour, because position must not read as a
 * state (docs/design/RULES.md rule 10).
 */
export type MinimapKind = "failed" | "waiting" | "blocked" | "current";

/**
 * One mark in the gutter. `index` is into the **whole** list rather than into whatever the
 * list has rendered, which is the whole purpose of the gutter: a failure four thousand rows
 * below the fold is a mark on the right-hand edge. A tick is a control, not a decoration —
 * clicking it scrolls to its row — so `label` is required and names the row it goes to. The
 * button takes `.orca-bare` for its reset and is `hit-min` tall with the mark drawn inside
 * it: a 3px mark is a mark, not a target.
 */
export interface MinimapTickProps {
  index: number;
  kind: MinimapKind;
  label: string;
}

/**
 * The list substrate (built — `packages/app/renderer/src/list`). Every list surface is one
 * of these: the Runs list today, the run tree, the event timeline and the inputs queue as
 * they land. A surface says what a row contains; the substrate owns everything a list has
 * to get right and no surface should re-derive.
 *
 * **It renders a window, not a list.** Only the band a person can see, plus a few rows
 * either side, is in the document; the rest is two spacer heights, so the scrollbar is
 * still the length of the whole list. Fifty thousand rows are a few dozen elements.
 *
 * **Height is read, never written.** A row is `--row-h` tall because its row class says so
 * (`.orca-tree-row` and its kin), and the substrate reads that value back off the cascade
 * to do its arithmetic — so `data-density="compact"` rebinding the token is not a special
 * case, it is the same read taken again. Nothing in the substrate states a height, and
 * `rowClassName` therefore has to name a row class that does.
 *
 * **Selection and focus are different things** (docs/design/RULES.md rule 10). One tab
 * stop, on the container; `aria-activedescendant` carries the selection; the ring is the
 * container's and the accent rail is the row's. The container is a `listbox` of `option`s
 * by default, a `tree` of `treeitem`s or a `grid` of `row`s when `role` says so — see
 * `role` and `rowProps`.
 *
 * **The keys are registered, not listened for.** `J`/`K`, `↑`/`↓`, `Home`/`End` and the
 * page keys go on the `KeyboardMap` in the scope `scope` names, so the command palette
 * lists them and so an open menu's `↑`/`↓` out-rank them. It follows that one scope holds
 * one `VirtualList` at a time — a second registration of `J` in one scope throws, which is
 * the right answer rather than a race — and that a screen with three lists on it gives them
 * three scopes.
 */
export interface VirtualListProps<T> {
  items: ReadonlyArray<T>;
  /** The listbox's accessible name: "Runs". */
  label: string;
  /** A stable DOM id per row; `aria-activedescendant` names it. */
  rowId(item: T, index: number): string;
  /** The row's own classes — a system row class, which is where `--row-h` comes from. */
  rowClassName?(item: T, index: number, selected: boolean): string;
  /** The cells inside the row; the substrate supplies the `option` element around them. */
  renderRow(item: T, index: number, selected: boolean): unknown;
  selectedIndex?: number;
  onSelect(index: number): void;
  /** The word the palette uses for a row: "run" gives "Next run". Defaults to "row". */
  noun?: string;
  /**
   * Two lines is a *declared variant*, never a row that grew (rule 9): the row is exactly
   * two `--row-h` tall and the window arithmetic counts it that way.
   * `.orca-list--two-line .orca-list__row` is the declaration.
   */
  variant?: "single" | "two-line";
  /** Ticks for the whole list. An empty array keeps the gutter and draws no marks. */
  ticks?: ReadonlyArray<MinimapTickProps>;
  /**
   * The sticky context header's content, in `.orca-pane__head--sticky`. The lift is its own
   * modifier, `--lifted`, and appears only once content is actually beneath it: a shadow
   * over an unscrolled list says "there is more above" when there is not.
   */
  header?: unknown;
  className?: string;
  /**
   * Which `ShortcutScope` the list's keys are registered in. One list per scope; three
   * scopes, so one screen can hold a run tree, a timeline and a stream. Defaults to `list`.
   */
  scope?: "list" | "run-tree" | "stream";
  /**
   * What the rows are, as ARIA sees them: a `listbox` of `option`s (the default, a flat
   * list of choices), a `tree` of `treeitem`s (rows with depth — the run tree, #156) or a
   * `grid` of `row`s (rows that hold controls — the plan's schedule table, #170).
   *
   * The third is not a preference. An `option` is a leaf, so a button inside one is a
   * button nothing can reach — the row is one stop and the control inside it is not
   * another — and axe reports it as `nested-interactive`. A `grid` is the role that
   * carries cells which may themselves be interactive, so a surface whose rows hold a
   * control asks for it and gives each cell `role="gridcell"` in `renderRow`.
   *
   * It is the substrate's because the substrate owns the row element. A surface cannot fix
   * this from `renderRow`, which returns only the row's *children*: `aria-level` on a span
   * inside a row, or a `treeitem` nested in an `option`, is invalid ARIA and reads as a
   * flat list either way. Everything else is identical for all three — one tab stop,
   * `aria-activedescendant`, `aria-selected`.
   */
  role?: "listbox" | "tree" | "grid";
  /**
   * Per-row ARIA only the surface can know — `aria-level` and `aria-expanded` on a tree
   * row — merged onto the row element. Applied *before* the attributes the substrate owns,
   * so a surface reaching too far cannot overwrite the role, the id or the selection. A
   * row with no children omits `aria-expanded` rather than setting it false: "closed" and
   * "nothing to open" are different facts.
   */
  rowProps?(item: T, index: number, selected: boolean): Record<string, string | number | boolean | undefined>;
  /**
   * Per-row custom properties the row's class reads — `--level` on a tree row, which
   * `.orca-tree-row` indents by. Custom properties only: how a row looks stays its class's.
   */
  rowStyle?(item: T, index: number, selected: boolean): Record<`--${string}`, string | number>;
  /**
   * Stay at the end as the list grows — a stream that is following. A growing `items`
   * reveals the last row; a scroll away from the bottom calls `onHold` **once**, not per
   * scroll event. The surface owns the flag: the substrate says when following stopped, not
   * whether it should start again.
   */
  follow?: boolean;
  onHold?(): void;
  /**
   * The imperative half, for the two things a re-render cannot ask for:
   * `reveal(index)` puts a row on screen, and `shiftBy(rows)` keeps what is on screen on
   * screen after `rows` items were *prepended* — paging backwards through a log without it
   * throws a person back by exactly the page they asked for.
   */
  ref?: unknown;
}

export interface VirtualListHandle {
  reveal(index: number): void;
  shiftBy(rows: number): void;
}
