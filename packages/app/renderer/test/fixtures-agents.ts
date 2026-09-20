/**
 * What the fake bridge answers `agents.list` with: two hosts, four agents, and all four
 * health states.
 *
 * It is kept apart from `fixtures.ts` because it is not a projection of that store. Agent
 * health lives in the daemon's process and not in any log (#222), so there is no event
 * sequence it could have been derived from — `fixtures.ts` is the store a `ReadModel` read,
 * and this is the tracker beside it. The `claims` half *is* that store's, so it is imported
 * rather than restated: `agents.list` and `claims.list` project the same claims, and two
 * copies would let the Agents surface and the Plan surface disagree about what is claimed.
 *
 * The four agents are chosen so that a surface test never has to build its own:
 *
 * - `claude` on `local` — `ok`, handshaken a while ago and still talking, so the two
 *   timestamps differ (#227);
 * - `codex` on `local` — `unknown`, with no timestamps at all: nothing has contacted it
 *   since the daemon started, which is the honest state and not a missing one;
 * - `gemini` on `build-box` (ssh) — `degraded`: the handshake worked, but only after one
 *   failed, so `consecutiveFailures` is back to zero;
 * - `sandbox` on `build-box` — `down`, with the failure count and the error that explains it.
 *
 * Two hosts, and deliberately one of each transport: grouping by host is the surface's
 * shape, and a fixture with one host would let a broken grouping pass.
 */
import type { AgentView, AgentsListResult } from "@orca/protocol";
import { AS_OF, CLAIMS, START } from "./fixtures.js";

/** Second `n` of the same fixture clock `fixtures.ts` runs on. */
const at = (n: number): string => new Date(START + n * 1000).toISOString();

export const AGENTS: readonly AgentView[] = [
  {
    id: "claude",
    hostId: "local",
    hostType: "local",
    roles: ["build", "review"],
    state: "ok",
    // Handshaken at second 4 and last heard from at second 38: a pooled session shakes
    // hands once and then talks, which is why one timestamp could not say both.
    lastHandshakeAt: at(4),
    lastSeenAt: at(38),
    roundTripMs: 240,
    consecutiveFailures: 0,
  },
  {
    id: "codex",
    hostId: "local",
    hostType: "local",
    roles: ["review"],
    // Never contacted since the daemon started. No timestamps, no round trip, and no
    // pretending: health is not persisted, so this is what a fresh daemon says.
    state: "unknown",
    consecutiveFailures: 0,
  },
  {
    id: "gemini",
    hostId: "build-box",
    hostType: "ssh",
    roles: ["build"],
    // `degraded` is "it worked, but only after one failed", so the count is back to zero and
    // the round trip is the successful attempt's.
    state: "degraded",
    lastHandshakeAt: at(31),
    lastSeenAt: at(31),
    roundTripMs: 1_900,
    consecutiveFailures: 0,
  },
  {
    id: "sandbox",
    hostId: "build-box",
    hostType: "ssh",
    roles: ["sandbox"],
    state: "down",
    lastHandshakeAt: at(36),
    // It answered once, long before the run of failures: a round trip survives a later
    // failure, so a down agent still reports what it cost when it last worked.
    lastSeenAt: at(12),
    roundTripMs: 1_450,
    consecutiveFailures: 3,
    lastError: { code: "AGENT_SPAWN", message: "ssh: connect to host build-box port 22: connection refused" },
  },
];

export const AGENTS_LIST: AgentsListResult = { agents: [...AGENTS], claims: [...CLAIMS], asOf: AS_OF };

/** One agent as it reads after a change, for a test that pushes `agent.changed`. */
export function changed(id: string, patch: Partial<AgentView>): AgentView {
  const agent = AGENTS.find((a) => a.id === id);
  if (!agent) throw new Error(`no fixture agent ${id}`);
  return { ...agent, ...patch };
}
