/** Human-readable plan journal entries; JSON command output retains the original event. */
import { planEventSummary, type PlanEvent } from "@orca/core";

type DisplayPlanEvent = Pick<PlanEvent, "at" | "seq" | "origin"> & { type: string; payload: unknown };

export function formatPlanEvent(e: DisplayPlanEvent, slug: (id: string) => string): string {
  return `${e.at.slice(0, 19)} ${String(e.seq).padStart(4)} ${e.type.padEnd(20)} ${e.origin.kind.padEnd(13)} ${planEventSummary(e, slug)}`;
}
