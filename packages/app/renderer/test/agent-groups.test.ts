/**
 * The Agents surface's arithmetic, without a DOM: grouping by host, folding one
 * `agent.changed`, and the two labels.
 *
 * It is a plain test of a plain module for the same reason `run-rows.test.ts` is — the
 * decisions that are not markup should be readable without mounting anything, and the
 * fixture is the one the surface test renders, so the two cannot disagree about what a
 * group is.
 */
import { describe, expect, it } from "vitest";
import type { AgentView } from "@orca/protocol";
import { applyAgentChanged, countLabel, groupByHost, transportLabel } from "../src/agents/agent-groups.js";
import { AGENTS, changed } from "./fixtures-agents.js";

describe("groupByHost", () => {
  it("groups by host id, hosts in first-appearance order and agents in config order", () => {
    expect(groupByHost(AGENTS).map((g) => [g.hostId, g.hostType, g.agents.map((a) => a.id)])).toEqual([
      ["local", "local", ["claude", "codex"]],
      ["build-box", "ssh", ["gemini", "sandbox"]],
    ]);
  });

  it("does not reorder by health: a card must not move under a person because an agent fell over", () => {
    const down = AGENTS.map((a) => (a.id === "codex" ? changed("codex", { state: "down" }) : a));
    expect(groupByHost(down)[0]!.agents.map((a) => a.id)).toEqual(["claude", "codex"]);
  });

  it("keeps an agent whose host has gone in a group of its own rather than filing it as local", () => {
    // No `hostType` at all, which is what the daemon sends when the host has left the
    // config under the agent — not `hostType: undefined` and not a guess.
    const orphan: AgentView = { id: "orphan", hostId: "", roles: [], state: "unknown", consecutiveFailures: 0 };
    const groups = groupByHost([...AGENTS, orphan]);
    expect(groups.map((g) => g.hostId)).toEqual(["local", "build-box", ""]);
    // No transport is reported rather than the commoner of the two (RULES.md rule 12).
    expect(groups[2]!.hostType).toBeUndefined();
  });

  it("is empty for an empty list, rather than inventing a host", () => {
    expect(groupByHost([])).toEqual([]);
  });
});

describe("applyAgentChanged", () => {
  it("replaces the agent in place, so nothing on screen moves", () => {
    const next = changed("gemini", { state: "down", consecutiveFailures: 2 });
    const folded = applyAgentChanged(AGENTS, next);
    expect(folded.map((a) => a.id)).toEqual(AGENTS.map((a) => a.id));
    expect(folded.find((a) => a.id === "gemini")).toEqual(next);
  });

  it("appends an agent the list has never seen, from the frame alone", () => {
    /* The whole point of `agent.changed` carrying an `AgentView`: unlike `run.changed`,
       which needs a `runs.get` before it can become a row, this notification *is* the row.
       A config reload that adds an agent therefore costs no read. */
    const fresh = { ...changed("claude", {}), id: "new-one", hostId: "local" };
    const folded = applyAgentChanged(AGENTS, fresh);
    expect(folded).toHaveLength(AGENTS.length + 1);
    expect(folded[folded.length - 1]!.id).toBe("new-one");
  });

  it("does not mutate what it was given", () => {
    const before = AGENTS.map((a) => a.state);
    applyAgentChanged(AGENTS, changed("claude", { state: "down" }));
    expect(AGENTS.map((a) => a.state)).toEqual(before);
  });
});

describe("the labels", () => {
  it("counts agents and hosts, singular and plural", () => {
    expect(countLabel(4, 2)).toBe("4 agents on 2 hosts");
    expect(countLabel(1, 1)).toBe("1 agent on 1 host");
    expect(countLabel(0, 0)).toBe("0 agents on 0 hosts");
  });

  it("names a transport it knows and says nothing about one it does not", () => {
    expect(transportLabel("local")).toBe("local");
    expect(transportLabel("ssh")).toBe("ssh");
    expect(transportLabel(undefined)).toBeUndefined();
  });
});
