/**
 * Resolve the registered palette sources for the current query.
 *
 * A source may answer asynchronously, so answers are guarded by a sequence number: the
 * person is still typing, and a slow source must never overwrite the list for a query
 * that has already moved on. One source rejecting does not blank the others.
 */
import { useEffect, useState } from "react";
import type { PaletteEntry } from "./entries.js";
import type { PaletteSource } from "./sources.js";

export interface SourceEntries {
  entries: readonly PaletteEntry[];
  /** True while at least one source has not answered for this query. */
  pending: boolean;
}

const EMPTY: SourceEntries = { entries: [], pending: false };

export function useSourceEntries(sources: readonly PaletteSource[], query: string, enabled: boolean): SourceEntries {
  const [state, setState] = useState<SourceEntries>(EMPTY);

  useEffect(() => {
    if (!enabled || sources.length === 0) {
      setState(EMPTY);
      return;
    }
    let live = true;
    setState((previous) => ({ entries: previous.entries, pending: true }));

    const answered = sources.map(async (source) => {
      try {
        const entries = await source.entries(query);
        // Namespaced here rather than in the source: an id only has to be unique within
        // the source that made it, and it has to be unique in the DOM.
        return entries.map((entry) => ({ ...entry, id: `${source.id}:${entry.id}`, section: source.section }));
      } catch (error) {
        // A search that cannot reach the daemon is not a palette that cannot open.
        console.error(`palette source ${source.id} failed`, error);
        return [];
      }
    });

    void Promise.all(answered).then((lists) => {
      if (live) setState({ entries: lists.flat(), pending: false });
    });
    return () => {
      live = false;
    };
  }, [sources, query, enabled]);

  return state;
}
