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

/** A chip that is not a status (built): a count, a filter, a role. Always `orca-chip--plain`. */
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

export interface RunTreeRowProps {
  id: string;
  /** Monospace: this is a machine name. */
  name: string;
  status: RunStatus;
  level: number;
  kind: "run" | "step" | "attempt" | "child-run";
  expanded?: boolean;
  hasChildren?: boolean;
  selected?: boolean;
  /** Elapsed for a running step, total for a finished one. */
  durationMs?: number;
  /** "attempt 2 of 3" — shown only when attempts > 1. */
  attempt?: { n: number; of: number };
  agent?: string;
  onToggle?(id: string): void;
  onSelect?(id: string): void;
}

export interface TimelineEntryProps {
  /** Event id; shown in mono-id on hover and copied by the row's context menu. */
  eventId: string;
  at: Date;
  /** The ORCA event kind, verbatim: 'step.started', 'agent.update', … */
  kind: string;
  /** One line. Subject first so a truncated row still means something. */
  summary: string;
  status?: RunStatus;
  selected?: boolean;
}

export interface OutputPaneProps {
  lines: ReadonlyArray<{ n: number; text: string; stream?: "stdout" | "stderr" }>;
  /** True while the step is producing output; draws the caret. */
  streaming: boolean;
  /** 'following' pins to the bottom; 'held' shows the jump button. */
  mode: "following" | "held";
  /** Lines that arrived while held. */
  pending: number;
  /** Set when the in-memory buffer has trimmed; renders the load-earlier marker. */
  trimmedBefore?: number;
  onJumpToLatest(): void;
  onLoadEarlier?(): void;
}

export interface ToolCallRowProps {
  tool: string;
  /** One-line argument summary; the full payload goes in the body. */
  argSummary: string;
  state: "pending" | "ok" | "failed" | "awaiting-permission";
  durationMs?: number;
  expanded?: boolean;
  body?: { args?: string; result?: string };
}

export interface ArtifactPanelProps {
  name: string;
  versions: ReadonlyArray<{ v: number; at: Date; producedBy: string }>;
  current: number;
  /** When set, the body renders as a diff against this version. */
  compareWith?: number;
  /** Steps that read this artifact — rendered as links under the header. */
  consumedBy?: ReadonlyArray<{ stepId: string; name: string }>;
  onSelectVersion(v: number): void;
}

export interface GateOption {
  id: string;
  label: string;
  /** One clause on what happens if chosen. Required: a person should not guess. */
  consequence: string;
  tone?: "default" | "primary" | "danger";
}

export interface GateCardProps {
  gateId: string;
  question: string;
  options: ReadonlyArray<GateOption>;
  waitingSince: Date;
  run: { id: string; name: string };
  workItem?: { id: string; title: string };
  /** Artifacts the decision is about. If these fail to load, options are disabled. */
  artifacts: ReadonlyArray<{ name: string; version: number }>;
  artifactsReady: boolean;
  /** Rendered inline in a run, or in the attention list. Behaviour is identical. */
  placement: "inline" | "inbox";
  onAnswer(optionId: string, note?: string): void;
}

export interface PermissionCardProps {
  askId: string;
  agent: string;
  host: string;
  /** 'exec' | 'write' | 'read' | 'network' — drives the glyph and the wording. */
  kind: string;
  /** The exact command or path, verbatim, in mono. Never summarised. */
  subject: string;
  step: { id: string; name: string };
  waitingSince: Date;
  /** Offering 'always' writes to the agent's permission policy; say so on the button. */
  options: ReadonlyArray<"allow-once" | "allow-always" | "deny">;
  onAnswer(option: string): void;
}

/** Built. */
export interface ScheduleBadgeProps {
  classification: ScheduleClass;
  /** Opens the explanation popover. Every classification can explain itself. */
  onExplain(): void;
}

export interface DependencyNodeProps {
  itemId: string;
  title: string;
  kind: DependencyKind;
  state: DependencyState;
  /** 'decision' and 'external' dependencies render a different glyph, same shell. */
  target: "item" | "decision" | "external";
  onWaive?(itemId: string): void;
}

export interface RiskMatrixProps {
  /** 5×5. Cell band is derived from likelihood × impact, not passed in. */
  risks: ReadonlyArray<{
    id: string;
    title: string;
    likelihood: 1 | 2 | 3 | 4 | 5;
    impact: 1 | 2 | 3 | 4 | 5;
    holding?: ReadonlyArray<string>;
  }>;
  /** Exposure above this is outlined as over-appetite. */
  appetite: number;
  onSelect(riskId: string): void;
}

export interface DecisionMatrixProps {
  criteria: ReadonlyArray<{ id: string; label: string; weight: number }>;
  options: ReadonlyArray<{ id: string; label: string; scores: Record<string, number> }>;
  /** Highest weighted total; shown as the winning column, never auto-applied. */
  recommended?: string;
  due?: Date;
  supersedes?: string;
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
 *   are evaluated per tool call against the rules in config (`PermissionRule`) and no
 *   running total is kept anywhere, on the wire or off it. Rule 12 forbids inventing one,
 *   so the field is gone rather than approximated. A permission *policy* surface is its own
 *   screen; it is not a line on this card.
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
  host: { id: string; transport?: "local" | "ssh" };
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
}

/**
 * Built. `children` is a render function, not a node: the field owns no control, but it
 * does own the ids that tie the label, the help and the error to whatever control the
 * caller puts inside it, and it has to hand them over to do that.
 */
export interface ConfigFieldProps {
  label: string;
  /** Dotted path into the YAML — always shown, it is how the form maps to the file. */
  path: string;
  children(control: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }): unknown;
  help?: string;
  error?: string;
  /** Opens the raw YAML view scrolled to and highlighting this path. */
  onShowRaw(path: string): void;
}

export interface WorkflowNodeProps {
  type: WorkflowNodeType;
  name: string;
  /** Present only when a run is overlaid. Absent means 'definition view'. */
  runState?: { status: RunStatus; attempts?: number; current?: boolean };
  /** True when a run is overlaid and this node was not traversed. */
  untaken?: boolean;
  onOpen(name: string): void;
}

export type CrumbType = "request" | "item" | "run" | "step" | "workflow" | "agent" | "config";

export interface Crumb {
  type: CrumbType;
  id: string;
  label: string;
  current?: boolean;
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
  actions?: unknown;
  onOpen?(crumb: Crumb): void;
  onOpenCounterpart?(crumb: Crumb, counterpart: Counterpart): void;
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
 *    is the layer stack's, never the component's;
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
  /** Trailing meta in `.orca-menu__type` — the type a counterpart leads to, a version date. */
  hint?: string;
  /** Shown, named and skipped by the arrow keys rather than hidden. */
  disabled?: boolean;
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
 * stop, on the listbox; `aria-activedescendant` carries the selection; the ring is the
 * listbox's and the accent rail is the row's.
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
