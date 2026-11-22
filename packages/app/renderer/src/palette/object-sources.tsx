/**
 * The palette's object rows: recent runs, agents, and search over the steps and artifacts
 * the app can ask the daemon for (#206).
 *
 * Three decisions worth knowing before changing anything here.
 *
 * **Every row returns a canonical `orca://` URL and opens it through the route table.** A
 * palette that navigated by calling a surface directly would be a second resolver, and the
 * information architecture requires the palette's entries to *be* links — "#206's entries
 * are required to return canonical `orca://` URLs" is what makes one route table possible.
 *
 * **These sources are the store's, not a surface's.** `sources.tsx` says a source is
 * registered for as long as its surface is mounted, which is right for a source that is a
 * view of what a surface holds — a filtered run list, the timeline's current page. These
 * three are reads of the daemon, they are wanted whether or not Runs is on screen, and the
 * palette is global; so they are registered here, beside the palette itself.
 *
 * **Nothing polls and nothing re-reads per keystroke.** Each source reads once and filters
 * what it holds; a `run.changed` or an `agent.changed` drops the cache so the next query
 * reads again. That is the same rule every list in the app follows.
 *
 * **Event text and artifact contents are the daemon's to search (#255).** The renderer never
 * scans a log: the `contents` source asks the daemon's `search` method, which reads the store
 * within a limit and a deadline and answers with places — a run and a `seq`, with the step
 * that event belongs to, or a run, an artifact name and a version — so each row is still a
 * canonical `orca://` URL. It waits a moment after the last keystroke and drops an answer
 * for a query that has moved on, and a daemon that does not list `search` in
 * `hello.methods` gets the names-only search below and nothing else. A scan the daemon cut
 * short says so in a disabled last row rather than implying it found everything.
 */
import { useCallback, useEffect, useRef, type JSX } from "react";
import {
  SEARCH_METHOD,
  SEARCH_MIN_QUERY,
  type ArtifactView,
  type RunSummaryView,
  type SearchHit,
  type StepView,
} from "@orca/protocol";
import { useMethodPresent } from "../chrome/use-connection.js";
import { useNotifications } from "../notifications-context.js";
import { artifactUrl, agentUrl, runUrl, stepUrl } from "../route-table.js";
import { usePaletteSource, type SourceEntry } from "./sources.js";

/**
 * How many runs the palette knows about. The daemon orders `runs.list` newest first, so
 * this is "recent" in the only sense the store defines, and it is small because the
 * navigation section is a shortlist — a person looking for the two-hundredth run types its
 * id, which the jump row already understands.
 */
export const RECENT_RUNS = 10;

/** How long the contents search waits after a keystroke before it asks the daemon. */
export const CONTENT_SEARCH_DELAY_MS = 150;
/** How many content hits the palette asks for: a shortlist, like the recent runs. */
export const CONTENT_SEARCH_LIMIT = 20;

export interface PaletteObjectSourcesProps {
  /** Open an `orca://` URL — `App`'s `navigate`, which is the route table. */
  onOpen: (url: string) => void;
}

/** Nothing to render: this component *is* three registrations and their caches. */
export function PaletteObjectSources({ onOpen }: PaletteObjectSourcesProps): JSX.Element | null {
  const stream = useNotifications();

  /* Read once, filtered locally after that, dropped when the store says something changed.
     Refs rather than state: a cache that re-rendered the whole chrome on every palette
     query would be a cache that costs more than the read it saves. */
  const runs = useRef<Promise<readonly RunSummaryView[]> | undefined>(undefined);
  const agents = useRef<Promise<readonly { id: string; hostId: string; state: string }[]> | undefined>(undefined);
  const contents = useRef(new Map<string, Promise<RunContents>>());
  const searchable = useMethodPresent(SEARCH_METHOD);
  const latest = useRef(0);

  useEffect(() => {
    const forget = (): void => {
      runs.current = undefined;
      contents.current.clear();
    };
    const unsubscribeRun = stream.on("run.changed", forget);
    const unsubscribeAgent = stream.on("agent.changed", () => {
      agents.current = undefined;
    });
    return () => {
      unsubscribeRun();
      unsubscribeAgent();
    };
  }, [stream]);

  const recentRuns = useCallback(async (): Promise<readonly RunSummaryView[]> => {
    runs.current ??= window.orca.runs
      .list({ limit: RECENT_RUNS })
      .then((result) => (result.ok ? result.result.runs : []));
    return runs.current;
  }, []);

  usePaletteSource(
    "runs",
    "navigation",
    useCallback(
      async (query: string) => {
        const recent = await recentRuns();
        return recent
          .filter((run) => matches(query, run.name, run.id))
          .map((run) => ({
            id: run.id,
            label: run.name,
            /* The id as its token beside the name — two runs of one workflow share a name —
               and matched whole, so the full id pasted or the tail a row showed finds it. */
            detailId: run.id,
            run: () => onOpen(runUrl(run.id)),
          }));
      },
      [recentRuns, onOpen],
    ),
  );

  usePaletteSource(
    "agents",
    "navigation",
    useCallback(
      async (query: string) => {
        agents.current ??= window.orca.agents
          .list()
          .then((result) =>
            result.ok
              ? result.result.agents.map((agent) => ({ id: agent.id, hostId: agent.hostId, state: agent.state }))
              : [],
          );
        const listed = await agents.current;
        return listed
          .filter((agent) => matches(query, agent.id, agent.hostId))
          .map((agent) => ({
            id: agent.id,
            label: agent.id,
            // The host and the health together, because an agent nobody has contacted is
            // `unknown` rather than missing and a row that hid that would be the lie (#222).
            detail: `${agent.hostId} · ${agent.state}`,
            run: () => onOpen(agentUrl(agent.id)),
          }));
      },
      [onOpen],
    ),
  );

  usePaletteSource(
    "search",
    "search",
    useCallback(
      async (query: string) => {
        const needle = query.trim();
        // An empty query is not a search: it would list every step of every recent run,
        // which is the "global search screen" the information architecture rules out.
        if (needle.length < 2) return [];
        const recent = await recentRuns();
        const found = await Promise.all(recent.map((run) => contentsOf(contents.current, run)));
        return found.flatMap(({ run, steps, artifacts }) => [
          ...steps
            .filter((step) => matches(needle, step.nodeId))
            .map((step) => ({
              id: `${run.id}:step:${step.id}`,
              label: step.nodeId,
              detail: `step in ${run.name}`,
              run: () => onOpen(stepUrl(run.id, step.nodeId, step.attempt)),
            })),
          ...artifacts
            .filter((artifact) => matches(needle, artifact.name))
            .map((artifact) => ({
              id: `${run.id}:artifact:${artifact.id}`,
              label: artifact.name,
              detail: `artifact v${artifact.version} in ${run.name}`,
              run: () => onOpen(artifactUrl(run.id, artifact.name, artifact.version)),
            })),
        ]) satisfies SourceEntry[];
      },
      [recentRuns, onOpen],
    ),
  );

  usePaletteSource(
    "contents",
    "search",
    useCallback(
      async (query: string) => {
        const needle = query.trim();
        const ask = ++latest.current;
        if (!searchable || needle.length < SEARCH_MIN_QUERY) return [];
        // A pause, then only the newest query goes to the daemon: typing is not a stream of scans.
        await new Promise((resolve) => setTimeout(resolve, CONTENT_SEARCH_DELAY_MS));
        if (ask !== latest.current) return [];
        const answer = await window.orca.search.query({ query: needle, limit: CONTENT_SEARCH_LIMIT });
        if (!answer.ok) return [];
        const rows: SourceEntry[] = answer.result.hits.map((hit) => hitEntry(hit, onOpen));
        if (answer.result.truncated)
          rows.push({
            id: "more",
            label: "More matches may exist",
            unavailable:
              answer.result.truncated === "limit"
                ? `showing the first ${answer.result.hits.length}; type more of the text to narrow it`
                : "the daemon stopped looking to keep the palette quick; type more of the text to narrow it",
            // Disabled: there is nothing to open, only something to know.
            run: () => {},
          });
        return rows;
      },
      [searchable, onOpen],
    ),
  );

  return null;
}

/** One daemon search hit as a row: a place, opened through the route table like every other row. */
function hitEntry(hit: SearchHit, onOpen: (url: string) => void): SourceEntry {
  if (hit.kind === "artifact")
    return {
      id: `${hit.runId}:artifact:${hit.artifactId}`,
      label: `${hit.name} v${hit.version}`,
      labelMachine: hit.name,
      detail: hit.excerpt,
      detailId: hit.runId,
      run: () => onOpen(artifactUrl(hit.runId, hit.name, hit.version)),
    };
  return {
    id: `${hit.runId}:event:${hit.seq}`,
    label: hit.excerpt,
    // The event's step when it has one: an event has no URL of its own, its step does.
    detail: hit.step ? `${hit.type} in ${hit.step.nodeId}` : hit.type,
    detailId: hit.runId,
    run: () => onOpen(hit.step ? stepUrl(hit.runId, hit.step.nodeId, hit.step.attempt) : runUrl(hit.runId)),
  };
}

/** Case-insensitive substring, over whichever of an object's names were handed in. */
function matches(query: string, ...fields: readonly string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field.toLowerCase().includes(needle));
}

interface RunContents {
  run: RunSummaryView;
  steps: readonly StepView[];
  artifacts: readonly ArtifactView[];
}

/**
 * One run's steps and artifacts, read once. Both calls are the ones the Runs surface makes
 * for the same run, so a person who searches for a step they are already looking at pays
 * for nothing the app did not already have to fetch.
 */
function contentsOf(cache: Map<string, Promise<RunContents>>, run: RunSummaryView): Promise<RunContents> {
  const held = cache.get(run.id);
  if (held) return held;
  const reading = Promise.all([window.orca.runs.get({ runId: run.id }), window.orca.artifacts.list({ runId: run.id })])
    .then(([detail, artifacts]) => ({
      run,
      steps: detail.ok ? detail.result.steps : [],
      artifacts: artifacts.ok ? artifacts.result.artifacts : [],
    }))
    // A run that cannot be read is a run with nothing to match, not a palette that fails.
    .catch(() => ({ run, steps: [], artifacts: [] }));
  cache.set(run.id, reading);
  return reading;
}
