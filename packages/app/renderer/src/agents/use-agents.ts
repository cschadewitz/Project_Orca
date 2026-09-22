/**
 * The Agents surface's data: one `agents.list` for the page, then `agent.changed` for
 * everything after it.
 *
 * The rule is the one every list in this app keeps — updates without refetching. A screen
 * that re-read `agents.list` whenever a handshake moved would ask the daemon for every
 * agent *and* every claim in the store on each frame, and would still flicker. So the list
 * is read once and each later change is folded into the agent it is about
 * (`agent-groups.ts`).
 *
 * Here that costs nothing extra, because `agent.changed` carries the whole `AgentView`:
 * there is no equivalent of the `runs.get` that `use-runs.ts` has to make for a run it has
 * never seen. One subscription, one method, no second path and no polling.
 *
 * Health is in the daemon's memory and not in any log (#222), so a reconnect replays
 * nothing: the notification has no cursor and asking for one would be asking for a lie. The
 * subscription generation triggers a fresh snapshot after reattachment; `reload` also reads it.
 *
 * `claims` is the other half of the same result and is *not* updated by `agent.changed` —
 * a claim moves when a run takes or releases one, which is not a change in agent health.
 * It is as fresh as the last read says it is, and the surface says which read that was.
 *
 * **Nothing pushes when a claim is released (#176), so the list is re-read once.** A release
 * is `ClaimStore.release` — a file under `<store>/claims/` being deleted — and it appends no
 * event to any run's log, so `notificationsFor` has nothing to fold and no notification
 * exists to listen for. `planChangeKindsFor` is about journal entries and a release writes
 * none either. So `releaseClaim` below does the one thing that can be done honestly: it
 * calls, and on success re-reads `claims.list` and replaces the claims with what came back.
 * That is one read per release and not a poll.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentView, ClaimView, ProtocolError } from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import { useSubscriptionGeneration } from "../chrome/use-connection.js";
import { useNotifications } from "../notifications-context.js";
import { applyAgentChanged } from "./agent-groups.js";

export type AgentsState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | {
      phase: "ready";
      agents: readonly AgentView[];
      /** What is claimed right now, as of the read; pushes do not move it. */
      claims: readonly ClaimView[];
      /** When the daemon answered the read the claims came from. */
      asOf: string;
    };

/** What the last release said, against the work item it was about. */
export interface ReleaseReport {
  workItemId: string;
  message: string;
  failed: boolean;
}

export interface AgentsFeed {
  state: AgentsState;
  /** Re-read the list: the error state's retry, and what a person reaches for after a blip. */
  reload: () => void;
  /** Work item ids with a release in flight: one call per claim, never two. */
  releasing: ReadonlySet<string>;
  /** What the last release said, shown on the row it was about. */
  release: ReleaseReport | undefined;
  /**
   * Take a work item back from the run that claimed it. Never `force`: forcing a release
   * out of a run that could still resume is a CLI act (`orca claims release --force`), and
   * a keyless palette entry for it here would be a destructive command with no undo behind
   * one keystroke. A claim the daemon will refuse is disabled with the reason instead
   * (`releaseRefusal`).
   */
  releaseClaim: (workItemId: string) => void;
}

export function useAgents(): AgentsFeed {
  const stream = useNotifications();
  const generation = useSubscriptionGeneration();
  const pending = useRef(new Map<string, AgentView>());
  const announce = useAnnounce();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AgentsState>({ phase: "loading" });
  const [releasing, setReleasing] = useState<ReadonlySet<string>>(new Set());
  const [release, setRelease] = useState<ReleaseReport | undefined>(undefined);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    pending.current.clear();
    setState({ phase: "loading" });
    void window.orca.agents.list().then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? {
              phase: "ready",
              agents: [...pending.current.values()].reduce(applyAgentChanged, result.result.agents),
              claims: result.result.claims,
              asOf: result.result.asOf,
            }
          : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [attempt, generation]);

  useEffect(() => {
    /* No `runId` filter: `agent.changed` is about the process and carries no run, so a
       filtered listener would never be woken (#241). The daemon only sends it to
       store-wide subscriptions, which is the one the main process holds. */
    const off = stream.on("agent.changed", (params) => {
      pending.current.set(params.agent.id, params.agent);
      setState((prev) =>
        prev.phase === "ready" ? { ...prev, agents: applyAgentChanged(prev.agents, params.agent) } : prev,
      );
    });
    return off;
  }, [stream]);

  const releaseClaim = useCallback(
    (workItemId: string) => {
      if (releasing.has(workItemId)) return;
      setReleasing((current) => new Set([...current, workItemId]));
      void window.orca.claims
        .release({ workItemId })
        .then(async (result) => {
          if (!result.ok) {
            const message = `${result.error.code}: ${result.error.message}`;
            setRelease({ workItemId, failed: true, message });
            announce(`Claim not released: ${result.error.message}`);
            return;
          }
          /* The daemon explains any child execution that remains protected after release.
             Missing or safely cancelled abandoned children are repaired for dispatch;
             live/parked children and recorded terminal outcomes keep their own state. */
          const note = result.result.note;
          const message = note ?? `${workItemId} is released and back with the scheduler.`;
          setRelease({ workItemId, failed: false, message });
          announce(message);
          // Nothing pushes for a release — see the file header. One read, on purpose.
          const claims = await window.orca.claims.list();
          if (claims.ok) {
            setState((prev) =>
              prev.phase === "ready" ? { ...prev, claims: claims.result.claims, asOf: claims.result.asOf } : prev,
            );
          }
        })
        .finally(() =>
          setReleasing((current) => {
            const next = new Set(current);
            next.delete(workItemId);
            return next;
          }),
        );
    },
    [announce, releasing],
  );

  return { state, reload, releasing, release, releaseClaim };
}
