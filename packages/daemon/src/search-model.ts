/**
 * The daemon's half of `search` (#255): a bounded, newest-first substring scan over event
 * text and text artifact contents. The wire contract and the decisions behind it are in
 * `@orca/protocol`'s `search.ts`; this file is how the scan stays inside them.
 *
 * - **One pass per run.** Each run's log is read once, front to back, through the store's own
 *   `readRange` with a `match` test. The test collects hits as a side effect and records the
 *   `step.scheduled` events it passes, so an event hit can name its step's node and attempt
 *   without a second read of the log (`runs.get` replays all of it).
 * - **Stopping is a throw.** The store's scan has no cancel, so when the limit is reached or
 *   the deadline passes the test throws a private sentinel, which `readRange` lets out after
 *   closing its file. The hits gathered so far are kept and the result says why it stopped.
 * - **Only what the reads show.** The caller's `scope` decides which runs are read at all
 *   and whether artifacts are, before anything is opened. A caller restricted to some runs
 *   searches only the one run it names, which the guard has already authorized: walking the
 *   store and asking run by run would spend the caller's deadline on hidden runs and let them
 *   change which visible hits are found and whether the result says it was cut short.
 *   Artifact text is redacted the way `artifacts.get` redacts it before it is matched, so a
 *   search cannot find what a read would hide.
 * - **The deadline is cooperative.** It is checked before each run, each event and each
 *   artifact. A storage read already in flight is not interrupted, so a slow read can carry a
 *   search past the deadline by that one read.
 */
import { isTextMediaType, SEARCH_ARTIFACT_MAX_BYTES, SEARCH_DEADLINE_MS } from "@orca/protocol";
import type { SearchHit, SearchParams, SearchResult } from "@orca/protocol";
import { OrcaError, type Artifact, type OrcaEvent } from "@orca/core";
import type { Orchestrator } from "@orca/engine";
import { redactExecutionValue } from "@orca/store";
import { artifactEvent } from "./auth/artifact-projection.js";

/**
 * Who is asking. `runs: "named"` is a caller limited to some runs: it may search only the
 * `runId` it names, which the guard authorized before the scan, and a search without one is
 * refused here as well as there. `"all"` walks the whole store.
 */
export interface SearchScope {
  runs: "all" | "named";
  artifacts: boolean;
}

export interface SearchDeps {
  orc: Orchestrator;
  isoNow: () => string;
  /** The artifact's name as `artifacts.get` would show it (redacted where it must be). */
  publicName: (artifact: Artifact) => Promise<string>;
  /** Milliseconds now; a test pins it to drive the deadline. */
  now?: () => number;
  deadlineMs?: number;
}

const EVERYTHING: SearchScope = { runs: "all", artifacts: true };
const EXCERPT_RADIUS = 80;

class Stop extends Error {
  constructor(readonly why: "limit" | "deadline") {
    super(why);
  }
}

export async function searchStore(
  deps: SearchDeps,
  params: SearchParams,
  scope: SearchScope = EVERYTHING,
): Promise<SearchResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.deadlineMs ?? SEARCH_DEADLINE_MS);
  const needle = params.query.toLowerCase();
  const kinds = new Set(params.kinds ?? ["event", "artifact"]);
  const wantArtifacts = kinds.has("artifact") && scope.artifacts;
  const hits: SearchHit[] = [];
  let truncated: SearchResult["truncated"];
  let scannedRuns = 0;

  const check = (): void => {
    if (hits.length >= params.limit) throw new Stop("limit");
    if (now() > deadline) throw new Stop("deadline");
  };

  if (scope.runs === "named" && params.runId === undefined)
    throw new OrcaError("RUN_STATE", "A caller limited to some runs searches one named run");
  // `listRuns` is oldest first and ids are time-ordered; the newest run is the likeliest answer.
  const runs = params.runId !== undefined ? [params.runId] : [...(await deps.orc.listRuns())].reverse();
  try {
    for (const runId of runs) {
      check();
      if ((await deps.orc.lastSeq(runId)) === undefined) continue;
      scannedRuns++;
      if (kinds.has("event")) await searchEvents(deps, runId, needle, hits, check, scope.artifacts);
      if (wantArtifacts) await searchArtifacts(deps, runId, needle, hits, check);
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    truncated = error.why;
  }
  return { hits, ...(truncated ? { truncated } : {}), scannedRuns, asOf: deps.isoNow() };
}

async function searchEvents(
  deps: SearchDeps,
  runId: string,
  needle: string,
  hits: SearchHit[],
  check: () => void,
  artifacts: boolean,
): Promise<void> {
  const steps = new Map<string, { nodeId: string; attempt: number }>();
  await deps.orc.eventsRange(runId, {
    match: (event: OrcaEvent) => {
      check();
      if (event.type === "step.scheduled")
        steps.set(event.payload.stepRunId, { nodeId: event.payload.nodeId, attempt: event.payload.attempt });
      // An artifact event is an artifact read: without `artifacts.read` it is not searched.
      if (!artifacts && artifactEvent(event.type)) return false;
      const text = eventText(event.payload);
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) return false;
      const stepRunId = stepRunIdOf(event);
      const step = stepRunId === undefined ? undefined : steps.get(stepRunId);
      hits.push({
        kind: "event",
        runId,
        seq: event.seq,
        type: event.type,
        ...(step ? { step } : {}),
        excerpt: excerpt(text, at, needle.length),
      });
      // Nothing is kept by the store itself: the hits are collected here.
      return false;
    },
  });
}

async function searchArtifacts(
  deps: SearchDeps,
  runId: string,
  needle: string,
  hits: SearchHit[],
  check: () => void,
): Promise<void> {
  const artifacts = (await deps.orc.stores.artifacts.list({ runId }))
    .filter((a) => isTextMediaType(a.mediaType) && a.size <= SEARCH_ARTIFACT_MAX_BYTES)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version || a.id.localeCompare(b.id));
  if (artifacts.length === 0) return;
  const inputs = await deps.orc.stores.execution.getInputs(runId);
  for (const artifact of artifacts) {
    check();
    let text: string;
    try {
      text = await deps.orc.stores.artifacts.content(artifact.id);
    } catch {
      // A body that has gone is a body with nothing to match, the same as `artifacts.list` shows it.
      continue;
    }
    if (inputs) text = redactExecutionValue(text, inputs.secrets);
    const at = text.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    hits.push({
      kind: "artifact",
      runId,
      artifactId: artifact.id,
      name: await deps.publicName(artifact),
      version: artifact.version,
      excerpt: excerpt(text, at, needle.length),
    });
  }
}

/**
 * An event's words: every string in its payload, in order, except identifiers. A key ending
 * `Id` or `Ids` holds an id, and an id that happens to contain the query is not a match a
 * person was looking for - nor, for artifact links, one every reader may see.
 */
export function eventText(payload: unknown): string {
  const out: string[] = [];
  const walk = (value: unknown, key: string | undefined): void => {
    if (key !== undefined && /Ids?$/.test(key)) return;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item, undefined);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
  };
  walk(payload, undefined);
  return out.join(" · ");
}

/** The match with some of its surroundings, on one line, cut on the excerpt's limit. */
export function excerpt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const end = Math.min(text.length, at + length + EXCERPT_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function stepRunIdOf(event: OrcaEvent): string | undefined {
  const payload: unknown = event.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as { stepRunId?: unknown }).stepRunId;
  return typeof id === "string" ? id : undefined;
}
