/**
 * Selection in the Runs list: which run is selected, said as an id and as a row index.
 *
 * The keys that move it are **not** here any more. `J`/`K`, `↑`/`↓`, `Home`/`End` and the
 * page keys belong to the list substrate (`list/use-list-keys.ts`) and register in the
 * `list` scope once for whatever list is on screen. Moving a selection and moving the
 * window it is rendered in are the same act now that the list is virtualised — a surface
 * that moved the selection on its own would routinely select a row that is not in the
 * document — and two components registering `J` in one scope is a throw, correctly.
 *
 * What is left is the part that is genuinely the surface's. A run is named by its id
 * everywhere else in the app — a notification, an `orca://` link, the run tree — while a
 * list is ordered by position, so something has to hold the two against each other and
 * decide what happens when a row leaves.
 */
import { useEffect, useMemo, useState } from "react";

export interface RunSelection {
  /** The selected run, or `undefined` when nothing is selected yet. */
  selectedId: string | undefined;
  /** Where that run is in the list — what the substrate moves, and `undefined` with it. */
  selectedIndex: number | undefined;
  /** Select by id — what a click on a row elsewhere in the app would call. */
  select: (id: string) => void;
  /** Select by row index — what a key and a click on a row call, through the substrate. */
  selectAt: (index: number) => void;
}

export function useRunSelection(ids: readonly string[]): RunSelection {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  /* A row can leave the list under the selection — the text filter narrowed, or a status
     filter dropped the run when it finished. Clearing is the honest answer: keeping an id
     that names no row would make the next `J` jump somewhere unrelated. */
  useEffect(() => {
    setSelectedId((selected) => (selected !== undefined && !ids.includes(selected) ? undefined : selected));
  }, [ids]);

  const selectedIndex = useMemo(() => {
    if (selectedId === undefined) return undefined;
    const at = ids.indexOf(selectedId);
    return at === -1 ? undefined : at;
  }, [ids, selectedId]);

  return {
    selectedId,
    selectedIndex,
    select: setSelectedId,
    selectAt: (index: number) => setSelectedId(ids[index]),
  };
}
