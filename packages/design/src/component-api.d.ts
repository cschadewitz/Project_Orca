/**
 * ORCA design system — the React surface the app should expose over css/components.css.
 *
 * This file is documentation, not a shipped package. The CSS layer is the
 * implementation; these signatures say what each primitive needs from the
 * caller so two developers build the same component.
 */

export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "blocked" | "held" | "stale";

/** Scheduler classification for a work item. Distinct from RunStatus on purpose. */
export type ScheduleClass = "unschedulable" | "waiting" | "held" | "ready" | "running";

export type ConnectionState = "live" | "reconnecting" | "disconnected" | "file" | "mismatch";

export type WorkflowNodeType =
  "start" | "end" | "agent" | "decision" | "gate" | "set" | "loop" | "parallel" | "subworkflow";

export type DependencyKind = "blocks" | "soft" | "informs";
export type DependencyState = "open" | "satisfied" | "failed" | "waived";

/** Status chip. `label` is required — status is never colour alone. */
export interface StatusChipProps {
  status: RunStatus;
  /** Defaults to the status word. Override only to add a count ("failed ×3"). */
  label?: string;
  /** Glyph-only form for a dense tree row; the word moves to the accessible name. */
  glyphOnly?: boolean;
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

export interface AgentHealthCardProps {
  name: string;
  host: { name: string; transport: "local" | "ssh" };
  roles: ReadonlyArray<string>;
  handshake: { state: "ok" | "degraded" | "down"; lastAt: Date; rttMs?: number };
  policy: { label: string; autoApprovals: number };
  /** The work item this agent's current run claims, if any. */
  claim?: { runId: string; itemId: string; itemTitle: string };
}

export interface ConfigFieldProps {
  label: string;
  /** Dotted path into the YAML — always shown, it is how the form maps to the file. */
  path: string;
  children: unknown;
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

export interface ObjectHeaderProps {
  crumbs: ReadonlyArray<{
    type: "request" | "item" | "run" | "step" | "workflow" | "agent" | "config";
    id: string;
    label: string;
    current?: boolean;
  }>;
  actions?: unknown;
}

export interface ConnectionIndicatorProps {
  state: ConnectionState;
  /** For 'reconnecting': seconds elapsed. For 'disconnected': time of last event. */
  since: Date;
  eventCursor?: number;
  versions?: { app: string; daemon: string };
}

export interface StateViewProps {
  kind: "empty" | "loading" | "error" | "disconnected" | "no-results";
  title: string;
  /** What the person can do about it. Omit only for 'loading'. */
  body?: string;
  action?: { label: string; onClick(): void };
}
