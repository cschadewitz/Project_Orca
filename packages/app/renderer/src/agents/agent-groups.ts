/**
 * The Agents surface's arithmetic: grouping the list by host, and folding one
 * `agent.changed` into it. A plain module with a plain test, so the parts of the surface
 * that are decisions rather than markup can be read without mounting anything
 * (`renderer/src/runs/run-rows.ts` is the same idea).
 *
 * Two things are settled here rather than in the component.
 *
 * **A host is a group, and its order is config order.** `agents.list` returns every
 * configured agent in the order config declares them, so the groups come out in the order
 * each host is first mentioned and the agents inside one keep their own order. Nothing is
 * sorted by health: a card moving because an agent went down is exactly the kind of motion
 * that loses the card a person was reading, and health is already on the card.
 *
 * **`agent.changed` needs no read behind it.** The frame carries the whole `AgentView` - the
 * same shape `agents.list` returns - so a change is folded into the row it is about, and an
 * agent the list has never seen (a config reload added one) is appended from the frame
 * alone. That is what makes "one subscription, no second path, no polling" possible here:
 * unlike `run.changed`, which carries a status and a cursor and so needs a `runs.get` to
 * become a row, this notification *is* the row.
 */
import type { AgentHostType, AgentView, ClaimView } from "@orca/protocol";

/** Every agent spawned on one host, with that host's transport when it has one. */
export interface HostGroup {
  hostId: string;
  /** Absent when the host has left the config under the agent; never guessed. */
  hostType?: AgentHostType;
  agents: readonly AgentView[];
}

/**
 * The agents grouped by `hostId`, hosts in first-appearance order and agents in the order
 * the list gave them. An agent whose host is gone has `hostId: ""` on the wire and groups
 * under its own heading rather than being folded into `local` — a card that cannot say
 * where it runs must not be filed as though it could.
 */
export function groupByHost(agents: readonly AgentView[]): readonly HostGroup[] {
  const order: string[] = [];
  const byHost = new Map<string, AgentView[]>();

  for (const agent of agents) {
    const held = byHost.get(agent.hostId);
    if (held) held.push(agent);
    else {
      order.push(agent.hostId);
      byHost.set(agent.hostId, [agent]);
    }
  }

  return order.map((hostId) => {
    const members = byHost.get(hostId) ?? [];
    // Every agent on one host reports that host's transport, so the first that has one
    // answers for the group; the case where none does is the host having left the config.
    const hostType = members.find((a) => a.hostType !== undefined)?.hostType;
    return { hostId, ...(hostType === undefined ? {} : { hostType }), agents: members };
  });
}

/**
 * One `agent.changed` folded in: the agent it is about is replaced in place, and one the
 * list has never seen is appended. Never a re-read — see the file header.
 */
export function applyAgentChanged(agents: readonly AgentView[], next: AgentView): readonly AgentView[] {
  const index = agents.findIndex((a) => a.id === next.id);
  if (index === -1) return [...agents, next];
  const out = [...agents];
  out[index] = next;
  return out;
}

/** "4 agents on 2 hosts", or "1 agent on 1 host". Sentence case, subject first (rule 13). */
export function countLabel(agents: number, hosts: number): string {
  return `${agents} ${agents === 1 ? "agent" : "agents"} on ${hosts} ${hosts === 1 ? "host" : "hosts"}`;
}

/**
 * What a host heading says after its id. A transport this build cannot name is not
 * rendered as a guess: the heading carries the id alone, which is all that is known.
 */
export function transportLabel(hostType: AgentHostType | undefined): string | undefined {
  if (hostType === undefined) return undefined;
  return hostType === "local" ? "local" : "ssh";
}

/* ------------------------------------------------------------------ claims -- */

/**
 * Why **Release** will not fire, when `owner.releasable` says it will not (#88, #176).
 *
 * The daemon refuses a release while the owning run could still resume, and
 * `ClaimView.owner.releasable` predicts exactly that refusal — which is what lets a client
 * disable the control with a reason instead of calling and being told. The sentence is the
 * daemon's own reading of the situation, in its own terms (`claims.ts` in `@orca/protocol`,
 * `orca claims release`), not a second rule invented here: this function decides nothing, it
 * only puts the run's status into words.
 *
 * `--force` is deliberately not offered as a way round it. Taking an item away from a run
 * that is merely paused-and-forgotten is a decision with no undo, and the reason names the
 * two ordinary ways out before it names the CLI.
 */
export function releaseRefusal(claim: ClaimView): string | undefined {
  if (claim.owner.releasable) return undefined;
  const run = claim.owner.name ?? claim.owner.runId;
  return `The run could still resume: ${run} is ${claim.owner.status}. Resume or cancel it first, or force the release from the command line.`;
}

/**
 * What releasing this claim does, in the words the confirmation shows: the work item, the
 * run it is taken from, and the consequence. Every clause is a fact off the `ClaimView` —
 * nothing here predicts what the scheduler will then do, which is what the result's own
 * `note` is for.
 */
export function releaseConsequence(claim: ClaimView): string {
  const run = claim.owner.name ?? claim.owner.runId;
  const title = claim.workItem?.title;
  const subject = title === undefined || title === "" ? claim.workItemId : `${claim.workItemId} — ${title}`;
  return `Take ${subject} back from ${run}. The item goes back to the scheduler and another run may claim it.`;
}
