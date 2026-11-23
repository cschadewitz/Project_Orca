/**
 * The Runs surface's search (#340 over #255): event text and artifact contents, asked of the
 * daemon's `search` and shown as places. Every hit opens through the route table by its
 * canonical `orca://` URL (a step for an event that belongs to one, else the run; an artifact
 * by run, name and version), so a hit and a link are the same thing.
 *
 * - **The daemon searches, the renderer never scans.** A query waits `SEARCH_DELAY_MS` after
 *   the last keystroke, only the newest one is sent, and an answer for a query that has moved
 *   on is dropped.
 * - **One boundary.** The daemon answers with what the caller's `runs.list`, `runs.events`
 *   and `artifacts.get` would show it (`docs/daemon-security.md`), so this view filters
 *   nothing of its own and shows no hit the rest of the console could not open. A caller
 *   limited to some runs searches one run at a time: the daemon refuses its store-wide search
 *   until there is a bounded run catalog, and the view says so and offers the selected run.
 * - **Results belong to one connection.** Like the board's follower, an answer is kept with
 *   the scope it was asked under (workspace, subscription generation, grant, methods), and a
 *   change of scope drops it in the same render and drops any reply still in flight, so one
 *   daemon's or one principal's excerpts never show under another.
 * - **Unavailable says so.** A daemon that does not list `search` in `hello.methods` gets a
 *   disabled view switch with the reason (`runs-surface.tsx`), not an empty result.
 * - **Cut short says so.** A scan the daemon stopped at its limit or its deadline ends the list
 *   with a line saying more may exist, rather than implying it found everything.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { ConnectionState } from "@orca/design";
import { useAuthority, useConnection, useSubscriptionGeneration } from "../../chrome/use-connection.js";
import { useWorkspace } from "../../chrome/use-workspace.js";
import { SEARCH_MIN_QUERY, type ProtocolError, type SearchHit, type SearchResult } from "@orca/protocol";
import { Button, ObjectId, StateView, Text, textClass } from "../../ui/index.js";
import { artifactUrl, runUrl, stepUrl } from "../../route-table.js";

/** How long the view waits after a keystroke before it asks the daemon. */
export const SEARCH_DELAY_MS = 150;
/** Hits per query: the protocol's ceiling, since this view, unlike the palette, is the place to look. */
export const SEARCH_LIMIT = 100;

type SearchState =
  | { phase: "idle" }
  | { phase: "searching" }
  | { phase: "error"; error: ProtocolError }
  | { phase: "ready"; result: SearchResult };

/** The canonical URL a hit opens: the route table is the single resolver. */
export function hitUrl(hit: SearchHit): string {
  if (hit.kind === "artifact") return artifactUrl(hit.runId, hit.name, hit.version);
  return hit.step ? stepUrl(hit.runId, hit.step.nodeId, hit.step.attempt) : runUrl(hit.runId);
}

export interface RunSearchProps {
  /** The run selected in the tree, which the view can search within. */
  selectedRunId?: string | undefined;
  /** The selected run's name, for the scope control. */
  selectedRunName?: string | undefined;
  connection: ConnectionState;
  /** Open a hit's `orca://` URL. */
  onOpen: (url: string) => void;
}

/** What the answers on screen were asked under: a change of any part makes them another caller's. */
function useSearchScope(connection: ConnectionState): string {
  const generation = useSubscriptionGeneration();
  const workspace = useWorkspace();
  const authority = useConnection();
  const grant = useAuthority();
  return JSON.stringify([
    workspace.path,
    workspace.source,
    workspace.readOnly,
    generation,
    grant ?? null,
    authority.capabilities,
    authority.methods,
    connection === "disconnected" || connection === "mismatch",
  ]);
}

export function RunSearch({ selectedRunId, selectedRunName, connection, onOpen }: RunSearchProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [within, setWithin] = useState(false);
  const scope = useSearchScope(connection);
  const ended = connection === "disconnected" || connection === "mismatch";
  /* The answer and the scope it was asked under. Rendered only while that scope is current,
     so a target or grant change clears the results in the very render that sees it. */
  const [held, setHeld] = useState<{ scope: string; state: SearchState }>({ scope, state: { phase: "idle" } });
  const latest = useRef(0);
  const needle = query.trim();
  const runId = within ? selectedRunId : undefined;

  useEffect(() => {
    const ask = ++latest.current;
    const settle = (state: SearchState) => {
      if (ask === latest.current) setHeld({ scope, state });
    };
    if (ended || needle.length < SEARCH_MIN_QUERY || (within && runId === undefined)) {
      settle({ phase: "idle" });
      return;
    }
    settle({ phase: "searching" });
    const timer = setTimeout(() => {
      void window.orca.search
        .query({ query: needle, limit: SEARCH_LIMIT, ...(runId === undefined ? {} : { runId }) })
        .then((answer) => {
          // Superseded: a newer query, another run, another connection, or the view went.
          settle(answer.ok ? { phase: "ready", result: answer.result } : { phase: "error", error: answer.error });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      // Leaving the view, or a new query, run or scope, makes any answer in flight stale.
      latest.current++;
    };
  }, [needle, runId, within, scope, ended]);

  const state: SearchState = held.scope === scope ? held.state : { phase: "idle" };

  return (
    <section className="orca-run-search" aria-label="Search run contents">
      <div className="orca-run-search__bar">
        <input
          type="search"
          className={`orca-input ${textClass("body")} orca-run-search__field`}
          aria-label="Search run contents"
          placeholder={runId === undefined ? "Event text or artifact contents" : "Text in the selected run"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="orca-runs__views" role="group" aria-label="Search scope">
          <button
            type="button"
            className={`orca-btn ${textClass("caption")} orca-btn--ghost orca-btn--sm`}
            aria-pressed={!within}
            onClick={() => setWithin(false)}
          >
            All runs
          </button>
          {selectedRunId === undefined ? (
            <Button size="sm" tone="ghost" disabled disabledReason="Select a run in the tree to search within it">
              Selected run
            </Button>
          ) : (
            <button
              type="button"
              className={`orca-btn ${textClass("caption")} orca-btn--ghost orca-btn--sm`}
              aria-pressed={within}
              title={selectedRunName}
              onClick={() => setWithin(true)}
            >
              Selected run
            </button>
          )}
        </div>
      </div>
      <SearchBody
        state={state}
        onOpen={onOpen}
        {...(!within && selectedRunId !== undefined ? { onWithin: () => setWithin(true) } : {})}
      />
    </section>
  );
}

function SearchBody({
  state,
  onOpen,
  onWithin,
}: {
  state: SearchState;
  onOpen: (url: string) => void;
  /** Search the selected run instead: offered when a store-wide search was refused. */
  onWithin?: () => void;
}): JSX.Element {
  if (state.phase === "idle")
    return (
      <StateView
        kind="empty"
        title="Search run contents"
        body={`Type at least ${SEARCH_MIN_QUERY} characters to search event text and text artifacts.`}
      />
    );
  if (state.phase === "searching") return <StateView kind="loading" title="Searching" />;
  if (state.phase === "error" && state.error.code === "AUTH_FORBIDDEN")
    return (
      <StateView
        kind="empty"
        title="Search one run at a time"
        body={
          onWithin
            ? "Your access covers some runs, not the whole store, so search within the run selected in the tree."
            : "Your access covers some runs, not the whole store. Select a run in the tree to search within it."
        }
        {...(onWithin ? { action: { label: "Search the selected run", onClick: onWithin } } : {})}
      />
    );
  if (state.phase === "error")
    return <StateView kind="error" title="Search failed" body={`${state.error.code}: ${state.error.message}`} />;
  const { hits, truncated } = state.result;
  if (hits.length === 0)
    return (
      <StateView
        kind="no-results"
        title="No matches"
        body={truncated === "deadline" ? "The daemon stopped looking before it read everything." : "Nothing matched."}
      />
    );
  return (
    <ul className="orca-run-search__hits" aria-label="Search results">
      {hits.map((hit) => (
        <li key={hit.kind === "artifact" ? `${hit.runId}:a:${hit.artifactId}` : `${hit.runId}:e:${hit.seq}`}>
          <button type="button" className="orca-run-search__hit" onClick={() => onOpen(hitUrl(hit))}>
            <Text style="body" className="orca-run-search__excerpt">
              {hit.excerpt}
            </Text>
            <Text style="caption" className="orca-run-search__where">
              {hit.kind === "artifact"
                ? `${hit.name} v${hit.version}`
                : hit.step
                  ? `${hit.type} in ${hit.step.nodeId}, attempt ${hit.step.attempt}`
                  : hit.type}{" "}
              <ObjectId id={hit.runId} kind="run" />
            </Text>
          </button>
        </li>
      ))}
      {truncated && (
        <li>
          <Text style="caption" as="p" className="orca-run-search__more" role="status">
            {truncated === "limit"
              ? `More matches may exist: showing the first ${hits.length}. Type more of the text to narrow it.`
              : "More matches may exist: the daemon stopped looking to answer quickly. Type more of the text to narrow it."}
          </Text>
        </li>
      )}
    </ul>
  );
}
