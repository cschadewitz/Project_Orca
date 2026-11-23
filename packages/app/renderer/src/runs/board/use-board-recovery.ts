/**
 * The board's recovery previews (#357): `runs.recovery` for each followed run that has stopped
 * somewhere recovery matters (any status but running, waiting or succeeded), read again when
 * the run moves (its status or its stream cursor changes).
 *
 * It belongs to the board's scope (`useRunBoard`), for the same reason the board's snapshots
 * do: an assessment is an answer about one run as read by one caller in one workspace. A new
 * scope drops every assessment in the render that sees it, and an answer that arrives for an
 * older scope, for a run state that has since moved, or for a request since replaced (the run
 * left the board and came back), is never drawn. What a card shows is filtered by the run's
 * state in the very render it is drawn in, so advice for an earlier state never sits beside a
 * newer one, even for the render before the reads catch up. A daemon that does not
 * list `runs.recovery` (before protocol 2.5) is never asked.
 */
import { useEffect, useRef, useState } from "react";
import { RUNS_RECOVERY_METHOD, type FollowedRun, type RecoveryAssessment } from "@orca/protocol";
import { useConnection } from "../../chrome/use-connection.js";
import { RECOVERY_QUIET } from "./board-model.js";

export type BoardRecovery =
  { phase: "loading" } | { phase: "ready"; assessment: RecoveryAssessment } | { phase: "error"; message: string };

interface Entry {
  key: string;
  /**
   * This request's own identity. A run that leaves the board and comes back in the same state
   * asks again under the same key; only the request that is held now may fill it.
   */
  request: object;
  value: BoardRecovery;
}

interface Scoped {
  scope: string;
  /**
   * New each time the scope changes, even back to a string seen before: a connection that ended
   * and came back reads the same, but an answer asked before it ended is not this one's.
   */
  token: object;
  entries: ReadonlyMap<string, Entry>;
}

/** What an assessment of this run depends on that the board can see. */
function keyOf(followed: FollowedRun): string | undefined {
  const run = followed.run;
  if (!run || followed.phase === "gone" || RECOVERY_QUIET.has(run.status)) return undefined;
  return `${run.status}\n${followed.cursor}`;
}

export function useBoardRecovery(runs: readonly FollowedRun[], scope: string): ReadonlyMap<string, BoardRecovery> {
  const connection = useConnection();
  const bridge = window.orca.runs;
  const readable = connection.methods.includes(RUNS_RECOVERY_METHOD) && bridge.recovery !== undefined;
  // The held assessments, by run; `state` is a new object on every change so the card redraws.
  const held = useRef<Scoped>({ scope, token: {}, entries: new Map() });
  const [state, setState] = useState<Scoped>(held.current);
  const publish = (next: Scoped) => {
    held.current = next;
    setState(next);
  };

  const wanted = readable
    ? runs.flatMap((followed) => {
        const key = keyOf(followed);
        return key === undefined ? [] : [[followed.runId, key] as const];
      })
    : [];
  const signature = JSON.stringify(wanted);

  useEffect(() => {
    const read = bridge.recovery;
    const targets = new Map<string, string>(JSON.parse(signature) as [string, string][]);
    const same = held.current.scope === scope;
    const token = same ? held.current.token : {};
    const current = same ? held.current.entries : new Map<string, Entry>();
    const next = new Map<string, Entry>();
    const ask: [string, object][] = [];
    for (const [runId, key] of targets) {
      const entry = current.get(runId);
      if (entry?.key === key) next.set(runId, entry);
      else {
        const request = {};
        next.set(runId, { key, request, value: { phase: "loading" } });
        ask.push([runId, request]);
      }
    }
    publish({ scope, token, entries: next });
    if (!read) return;
    for (const [runId, request] of ask)
      void read({ runId }).then((result) => {
        // Only into the scope and the very request it answers.
        const entry = held.current.entries.get(runId);
        if (held.current.token !== token || entry?.request !== request) return;
        const value: BoardRecovery = result.ok
          ? { phase: "ready", assessment: result.result.assessment }
          : { phase: "error", message: result.error.message };
        publish({ scope, token, entries: new Map(held.current.entries).set(runId, { ...entry, value }) });
      });
  }, [bridge, scope, signature]);

  // Nothing from another scope, and nothing for a run state other than the one drawn now, from
  // the very render that sees the change. A run whose read has not caught up yet is loading.
  const entries = state.scope === scope ? state.entries : new Map<string, Entry>();
  return new Map(
    wanted.map(([runId, key]): [string, BoardRecovery] => {
      const entry = entries.get(runId);
      return [runId, entry?.key === key ? entry.value : { phase: "loading" }];
    }),
  );
}
