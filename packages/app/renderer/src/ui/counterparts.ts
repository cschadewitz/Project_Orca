/**
 * What each kind of crumb can point at.
 *
 * "From any crumb, a menu offers the counterpart objects: from a work item, 'runs that
 * attempted this' and 'dependencies'; from a run, 'the work item it claims' and 'the
 * workflow it executes'." (docs/design/10-information-architecture.md.) This is that list
 * and nothing more — the four the spec names. A crumb type with no counterparts renders
 * no menu button rather than an empty menu, because a menu that opens onto nothing is
 * worse than no menu.
 *
 * Kept apart from the component so the map is data a test can read, and so adding a fifth
 * counterpart is an edit here rather than in JSX.
 */

export type CrumbType = "plan" | "request" | "item" | "run" | "step" | "workflow" | "agent" | "config";

export interface Counterpart {
  /** Stable key, used as the menu item's id and as what `onOpenCounterpart` reports. */
  id: string;
  /** Sentence case, subject first (rule 13). */
  label: string;
  /** The type of object the menu item leads to; shown on the right of the row. */
  leadsTo: CrumbType;
}

export const COUNTERPARTS: Record<CrumbType, readonly Counterpart[]> = {
  /* A plan is the root of the Plan surface's trail (#170) and leads nowhere else: its
     requests are the sidebar and its items are the table, both already on screen. */
  plan: [],
  request: [],
  item: [
    { id: "runs", label: "Runs that attempted this", leadsTo: "run" },
    { id: "dependencies", label: "Dependencies", leadsTo: "item" },
  ],
  run: [
    { id: "claimed-item", label: "The work item it claims", leadsTo: "item" },
    { id: "workflow", label: "The workflow it executes", leadsTo: "workflow" },
  ],
  step: [],
  workflow: [],
  agent: [],
  config: [],
};

export const counterpartsFor = (type: CrumbType): readonly Counterpart[] => COUNTERPARTS[type];
