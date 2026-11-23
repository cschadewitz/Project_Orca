/**
 * The board's data (#340): one `RunFollower` for the runs on it, fed by the window's single
 * notification stream and read through `runs.get` with `operations`.
 *
 * The follower (`@orca/protocol`) owns the hard part - cursors, duplicates, gaps, snapshots
 * that must not go backwards - so this hook only wires it to the app: which runs, which
 * frames, what the connection is doing, and *whose* runs they are.
 *
 * That last one is an access boundary, not a cache detail. A run id names a run in one store
 * as read by one caller; the same id in another workspace, or through a connection with other
 * authority, is another thing entirely. So a follower belongs to one **scope** - the
 * workspace, the subscription generation, and the capabilities and methods the daemon granted
 * - and a change of scope ends it: nothing it held is drawn again, from the very render that
 * sees the change, and a fresh follower reads every run from nothing. A definitive refusal
 * from `runs.get` (not found, not authorized) is `FollowRefusedError`, which drops the run's
 * data instead of leaving its last snapshot on screen as an ordinary stale read would.
 *
 * Losing the connection is two different things. A stream that drops and is coming back
 * (`reconnecting`) is the same caller against the same daemon, so the follower keeps its cards
 * and says they are not current. A connection that has *ended* (`disconnected`, which is what
 * an authentication or authorization refusal of the stream becomes, published at once rather
 * than after the blip window; or `mismatch`) is not something to keep drawing from, even when
 * the workspace, generation and grants all read the same: it is part of the scope, so the
 * follower and every snapshot it held go in that same render, and nothing is read until the
 * connection is live again, when a fresh follower reads every run from nothing.
 */
import { useEffect, useState } from "react";
import { FollowRefusedError, RunFollower, type FollowedRun } from "@orca/protocol";
import type { ConnectionState } from "@orca/design";
import { useConnection, useSubscriptionGeneration } from "../../chrome/use-connection.js";
import { useWorkspace } from "../../chrome/use-workspace.js";
import { useNotifications } from "../../notifications-context.js";

/** Codes that are an answer about the run or the caller, not a failure to get one. */
const REFUSALS = new Set(["RUN_NOT_FOUND", "AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN"]);

export interface RunBoard {
  /** One entry per followed run, in `runIds` order. */
  runs: readonly FollowedRun[];
  /** Try a `stale` or refused run again. */
  retry: (runId: string) => void;
  /** Whose runs these are (workspace, generation, grants, connection ended): anything read for them belongs to it. */
  scope: string;
}

interface Scoped {
  scope: string;
  follower: RunFollower;
  views: ReadonlyMap<string, FollowedRun>;
}

export function useRunBoard(runIds: readonly string[], connection: ConnectionState): RunBoard {
  const stream = useNotifications();
  const generation = useSubscriptionGeneration();
  const workspace = useWorkspace();
  const authority = useConnection();
  // Ended, not interrupted: no follower at all until a live connection comes back.
  const ended = connection === "disconnected" || connection === "mismatch";
  const scope = JSON.stringify([
    workspace.path,
    workspace.source,
    workspace.readOnly,
    generation,
    authority.capabilities,
    authority.methods,
    ended,
  ]);
  const [current, setCurrent] = useState<Scoped | undefined>(undefined);

  // One follower per scope; its frames come from every run in the stream.
  useEffect(() => {
    if (ended) {
      setCurrent(undefined);
      return;
    }
    let live = true;
    const follower = new RunFollower({
      fetch: async (runId) => {
        const result = await window.orca.runs.get({ runId, operations: true });
        if (!result.ok) {
          const message = `${result.error.code}: ${result.error.message}`;
          throw REFUSALS.has(result.error.code) ? new FollowRefusedError(message) : new Error(message);
        }
        return { run: result.result.run, lastSeq: result.result.lastSeq };
      },
      onChange: (view) => {
        if (!live) return;
        setCurrent((previous) =>
          previous?.follower === follower
            ? { ...previous, views: new Map(previous.views).set(view.runId, view) }
            : previous,
        );
      },
    });
    setCurrent({ scope, follower, views: new Map() });
    const off = stream.onAny((notification) => follower.notify(notification));
    return () => {
      live = false;
      off();
      follower.dispose();
    };
  }, [stream, scope, ended]);

  // Only a follower of this very scope is used; until the effect above has made one, nothing.
  const active = current?.scope === scope ? current : undefined;
  const follower = active?.follower;

  // Follow exactly `runIds`.
  const key = runIds.join("\n");
  useEffect(() => {
    if (!follower) return;
    const wanted = new Set(key ? key.split("\n") : []);
    for (const run of follower.list()) if (!wanted.has(run.runId)) follower.unfollow(run.runId);
    for (const runId of wanted) follower.follow(runId);
  }, [follower, key]);

  // A new scope (a new generation among it) already re-reads everything; within one, the
  // stream dropping and coming back is what the follower is told. A read-only store (`file`)
  // is served by a live daemon and streams like any other.
  const live = connection === "live" || connection === "file";
  useEffect(() => {
    if (!follower) return;
    // Both are idempotent: a follower already connected re-reads nothing on `connectionRestored`.
    if (!live) follower.connectionLost();
    else follower.connectionRestored();
  }, [follower, live]);

  // A run with no view yet in this scope is loading, or waiting on the connection when it has
  // ended: never a view from another scope.
  const placeholder = ended ? "reconnecting" : "loading";
  const runs = runIds.map(
    (runId): FollowedRun => active?.views.get(runId) ?? { runId, phase: placeholder, cursor: -1, resyncs: 0 },
  );
  return { runs, retry: (runId) => follower?.retry(runId), scope };
}
