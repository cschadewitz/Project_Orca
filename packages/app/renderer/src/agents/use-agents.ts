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
 * nothing: the notification has no cursor and asking for one would be asking for a lie. A
 * person who has been disconnected gets the current answer from `reload`, which is one call.
 *
 * `claims` is the other half of the same result and is *not* updated by `agent.changed` —
 * a claim moves when a run takes or releases one, which is not a change in agent health.
 * It is as fresh as the last read says it is, and the surface says which read that was.
 */
import { useCallback, useEffect, useState } from "react";
import type { AgentView, ClaimView, ProtocolError } from "@orca/protocol";
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

export interface AgentsFeed {
  state: AgentsState;
  /** Re-read the list: the error state's retry, and what a person reaches for after a blip. */
  reload: () => void;
}

export function useAgents(): AgentsFeed {
  const stream = useNotifications();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AgentsState>({ phase: "loading" });
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    void window.orca.agents.list().then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? { phase: "ready", agents: result.result.agents, claims: result.result.claims, asOf: result.result.asOf }
          : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    /* No `runId` filter: `agent.changed` is about the process and carries no run, so a
       filtered listener would never be woken (#241). The daemon only sends it to
       store-wide subscriptions, which is the one the main process holds. */
    const off = stream.on("agent.changed", (params) => {
      setState((prev) =>
        prev.phase === "ready" ? { ...prev, agents: applyAgentChanged(prev.agents, params.agent) } : prev,
      );
    });
    return off;
  }, [stream]);

  return { state, reload };
}
