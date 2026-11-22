/**
 * Artifact permission projections at the outbound boundary only. Always copy changed paths:
 * stored events and frames shared with artifact readers must keep their original references.
 * This covers schema-defined artifact links, not arbitrary strings in user-authored data.
 */
import type { OrcaEvent, PlanOrigin } from "@orca/core";
import type { JournalListResult, PlanJournalEntryView, RunsGetResult } from "@orca/protocol";

/** Events whose whole purpose is artifact data, metadata or references are withheld. */
export function artifactEvent(type: string): boolean {
  return type.startsWith("artifact.") || type === "step.inputs" || type === "plan.signals.rejected";
}

export function runWithoutArtifacts(result: RunsGetResult): RunsGetResult {
  return {
    ...result,
    artifacts: [],
    steps: result.steps.map((step) => ({ ...step, inputArtifactIds: [], outputArtifactIds: [] })),
  };
}

/** Keep lifecycle events and their cursors, but clear their schema-defined artifact links. */
export function eventWithoutArtifacts(event: OrcaEvent): OrcaEvent {
  switch (event.type) {
    case "step.started":
      return { ...event, payload: { ...event.payload, inputArtifactIds: [] } };
    case "step.completed":
      return { ...event, payload: { ...event.payload, result: { ...event.payload.result, artifactIds: [] } } };
    case "run.created": {
      // A checkpoint attempt's seed (#357) carries the reused artifacts and their references.
      const checkpoint = event.payload.checkpoint;
      if (!checkpoint) return event;
      return {
        ...event,
        payload: {
          ...event.payload,
          checkpoint: {
            ...checkpoint,
            artifacts: [],
            steps: checkpoint.steps.map((step) => ({ ...step, result: { ...step.result, artifactIds: [] } })),
          },
        },
      };
    }
    default:
      return event;
  }
}

/** Optional provenance links may be omitted while retaining the origin's kind/run/actor. */
function originWithoutArtifact(origin: PlanOrigin): PlanOrigin {
  const { artifactId: _artifactId, ...visible } = origin;
  return visible;
}

/** Only plan entities with a schema-defined origin use this helper, never arbitrary data. */
function entityWithoutArtifactOrigin(entity: Record<string, unknown>): Record<string, unknown> {
  return entity.origin && typeof entity.origin === "object"
    ? { ...entity, origin: originWithoutArtifact(entity.origin as PlanOrigin) }
    : entity;
}

/** The model's update summaries end in the serialized changes; retain their readable prefix. */
function projectedUpdateSummary(entry: PlanJournalEntryView, changes: Record<string, unknown>): string {
  const original = JSON.stringify(entry.payload.changes);
  return entry.summary.endsWith(original)
    ? entry.summary.slice(0, -original.length) + JSON.stringify(changes)
    : JSON.stringify({ ...entry.payload, changes });
}

function journalEntryWithoutArtifacts(entry: PlanJournalEntryView): PlanJournalEntryView {
  let payload = entry.payload;
  let summary = entry.summary;
  switch (entry.type) {
    case "work-item.added":
      payload = { ...payload, workItem: { ...(payload.workItem as Record<string, unknown>), produced: {} } };
      break;
    case "work-item.updated": {
      const changes = payload.changes as Record<string, unknown>;
      if (Object.hasOwn(changes, "produced")) {
        const visible = { ...changes, produced: {} };
        payload = { ...payload, changes: visible };
        summary = projectedUpdateSummary(entry, visible);
      }
      break;
    }
    case "dependency.added":
    case "risk.raised":
    case "decision.opened": {
      const field =
        entry.type === "dependency.added" ? "dependency" : entry.type === "risk.raised" ? "risk" : "decision";
      payload = { ...payload, [field]: entityWithoutArtifactOrigin(payload[field] as Record<string, unknown>) };
      break;
    }
    case "risk.updated":
    case "decision.updated": {
      const changes = payload.changes as Record<string, unknown>;
      const visible = entityWithoutArtifactOrigin(changes);
      if (visible !== changes) {
        payload = { ...payload, changes: visible };
        summary = entry.type === "risk.updated" ? projectedUpdateSummary(entry, visible) : JSON.stringify(payload);
      }
      break;
    }
  }
  return { ...entry, origin: originWithoutArtifact(entry.origin), payload, summary };
}

/** The journal is the only plan response carrying artifact provenance/produced maps. */
export function journalWithoutArtifacts(page: JournalListResult): JournalListResult {
  return {
    ...page,
    entries: page.entries.filter((entry) => entry.type !== "signals.rejected").map(journalEntryWithoutArtifacts),
  };
}
