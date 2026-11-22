/**
 * The board's data (#340): one `RunFollower` for the runs on it, fed by the window's single
 * notification stream and read through `runs.get` with `operations`.
 *
 * The follower (`@orca/protocol`) owns the hard part - cursors, duplicates, gaps, snapshots
 * that must not go backwards - so this hook only wires it to the app: which runs, which
 * frames, and what the connection is doing. A dropped connection marks every card
 * `reconnecting`; a re-attached subscription (a new generation) or a connection coming back
 * live re-reads every run that has not finished.
 */
import { useEffect, useRef, useState } from "react";
import { RunFollower, type FollowedRun } from "@orca/protocol";
import type { ConnectionState } from "@orca/design";
import { useSubscriptionGeneration } from "../../chrome/use-connection.js";
import { useNotifications } from "../../notifications-context.js";

export interface RunBoard {
  /** One entry per followed run, in `runIds` order. */
  runs: readonly FollowedRun[];
  /** Try a `stale` run's snapshot again. */
  retry: (runId: string) => void;
}

export function useRunBoard(runIds: readonly string[], connection: ConnectionState): RunBoard {
  const stream = useNotifications();
  const generation = useSubscriptionGeneration();
  const [views, setViews] = useState<ReadonlyMap<string, FollowedRun>>(new Map());
  const [follower, setFollower] = useState<RunFollower | undefined>(undefined);

  // One follower for the life of the board; its frames come from every run in the stream.
  useEffect(() => {
    let live = true;
    const follower = new RunFollower({
      fetch: async (runId) => {
        const result = await window.orca.runs.get({ runId, operations: true });
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return { run: result.result.run, lastSeq: result.result.lastSeq };
      },
      onChange: (view) => {
        if (!live) return;
        setViews((previous) => new Map(previous).set(view.runId, view));
      },
    });
    setFollower(follower);
    const off = stream.onAny((notification) => follower.notify(notification));
    return () => {
      live = false;
      off();
      follower.dispose();
    };
  }, [stream]);

  // Follow exactly `runIds`.
  const key = runIds.join("\n");
  useEffect(() => {
    if (!follower) return;
    const wanted = new Set(key ? key.split("\n") : []);
    for (const run of follower.list()) if (!wanted.has(run.runId)) follower.unfollow(run.runId);
    for (const runId of wanted) follower.follow(runId);
    setViews((previous) => {
      const next = new Map<string, FollowedRun>();
      for (const runId of wanted) {
        const view = follower.get(runId) ?? previous.get(runId);
        if (view) next.set(runId, view);
      }
      return next;
    });
  }, [follower, key]);

  // The stream: lost while the connection is not live, re-read when it is back or re-attached.
  const live = connection === "live";
  const seen = useRef<{ follower: RunFollower | undefined; live: boolean; generation: number }>({
    follower: undefined,
    live,
    generation,
  });
  useEffect(() => {
    if (!follower) return;
    const before = seen.current;
    seen.current = { follower, live, generation };
    // A new follower starts connected; tell it otherwise if the board mounted offline.
    if (before.follower !== follower) {
      if (!live) follower.connectionLost();
      return;
    }
    if (!live) {
      if (before.live) follower.connectionLost();
      return;
    }
    if (!before.live || before.generation !== generation) {
      if (before.live) follower.connectionLost();
      follower.connectionRestored();
    }
  }, [follower, live, generation]);

  const runs = runIds.flatMap((id) => {
    const view = views.get(id);
    return view ? [view] : [];
  });
  return { runs, retry: (runId) => follower?.retry(runId) };
}
