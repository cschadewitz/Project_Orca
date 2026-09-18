/**
 * Terminal rendering: one line per event type, the run-state summary, and the
 * "you are paused, here is how to answer" hint. These are what a user reads
 * when something goes wrong, so every branch gets an assertion rather than a
 * snapshot.
 */
import { describe, expect, it } from "vitest";
import type { HumanInputRequest, OrcaEvent, RunState } from "@orca/core";
import { formatEvent, formatPaused, formatPendingInput, formatRunState } from "../src/format.js";

/** The union is exhaustive over payloads; tests care about rendering, not about re-typing each one. */
function ev(type: string, payload: Record<string, unknown>, runId = "run_1"): OrcaEvent {
  return { id: "ev_1", seq: 1, runId, at: "2026-01-02T03:04:05.678Z", type, payload } as unknown as OrcaEvent;
}

const AT = "03:04:05";

describe("formatEvent", () => {
  it("renders the run lifecycle", () => {
    expect(formatEvent(ev("run.created", { workflowId: "ai-sdlc" }))).toBe(
      `${AT} run run_1 created (workflow ai-sdlc)`,
    );
    expect(formatEvent(ev("run.completed", { outcome: "success" }))).toBe(`${AT} run run_1 completed: success`);
    expect(formatEvent(ev("run.failed", { error: { message: "boom" } }))).toBe(`${AT} run run_1 FAILED: boom`);
    expect(formatEvent(ev("run.cancelled", {}))).toBe(`${AT} run run_1 cancelled`);
    expect(formatEvent(ev("run.resumed", {}))).toBe(`${AT} run run_1 resumed`);
  });

  it("shows a pause reason only when there is one", () => {
    expect(formatEvent(ev("run.paused", { reason: "human input" }))).toBe(`${AT} run run_1 paused: human input`);
    expect(formatEvent(ev("run.paused", {}))).toBe(`${AT} run run_1 paused`);
  });

  it("renders steps, with the choice and artifact count only when present", () => {
    expect(formatEvent(ev("step.scheduled", { nodeId: "build", nodeType: "agent", attempt: 2 }))).toBe(
      `${AT}   ▶ build (agent, attempt 2)`,
    );
    expect(
      formatEvent(
        ev("step.completed", { stepRunId: "step_gate", result: { choice: "ship", artifactIds: ["a1", "a2"] } }),
      ),
    ).toBe(`${AT}   ✔ step gate → ship [2 artifact(s)]`);
    expect(formatEvent(ev("step.completed", { stepRunId: "step_noop", result: { artifactIds: [] } }))).toBe(
      `${AT}   ✔ step noop`,
    );
    // No stepRunId at all: the name collapses to empty rather than "undefined".
    expect(formatEvent(ev("step.completed", { result: { artifactIds: [] } }))).toBe(`${AT}   ✔ `);
    expect(formatEvent(ev("step.failed", { stepRunId: "step_test", error: { message: "red" }, willRetry: true }))).toBe(
      `${AT}   ✖ step test: red (retrying)`,
    );
    expect(formatEvent(ev("step.failed", { stepRunId: "step_test", error: { message: "red" } }))).toBe(
      `${AT}   ✖ step test: red`,
    );
    expect(formatEvent(ev("step.inputs", { artifactIds: ["a1", "a2"] }))).toBe(`${AT}     ⬓ inputs a1, a2`);
    expect(formatEvent(ev("step.waiting", { on: "dependency", detail: "schema@spec" }))).toBe(
      `${AT}   … waiting on dependency (schema@spec)`,
    );
    expect(formatEvent(ev("step.waiting", { on: "dependency" }))).toBe(`${AT}   … waiting on dependency`);
  });

  it("renders the agent conversation", () => {
    expect(
      formatEvent(ev("agent.session.opened", { sessionId: "s1", agentId: "scripted", hostId: "local", cwd: "/w" })),
    ).toBe(`${AT}     session s1 agent=scripted host=local cwd=/w`);
    expect(formatEvent(ev("agent.turn.started", { promptHash: "0123456789abcdef", followUp: false }))).toBe(
      `${AT}     prompt (01234567) follow-up=false`,
    );
    expect(formatEvent(ev("agent.turn.completed", { stopReason: "end_turn", durationMs: 42 }))).toBe(
      `${AT}     turn ended: end_turn in 42ms`,
    );
    // A multi-line chunk is indented to line up under the first line.
    expect(formatEvent(ev("agent.update", { update: { kind: "agent_message_chunk", text: " one\ntwo\n" } }))).toBe(
      `${AT}     │ one\n           │ two`,
    );
    expect(formatEvent(ev("agent.update", { update: { kind: "agent_message_chunk" } }))).toBe(`${AT}     │ `);
    expect(
      formatEvent(ev("agent.update", { update: { kind: "tool_call", title: "Read file", status: "in_progress" } })),
    ).toBe(`${AT}     ⚙ Read file in_progress`);
    // Neither title nor status: no trailing whitespace is left behind.
    expect(formatEvent(ev("agent.update", { update: { kind: "tool_call_update" } }))).toBe(`${AT}     ⚙`);
    expect(formatEvent(ev("agent.update", { update: { kind: "available_commands_update" } }))).toBe(
      `${AT}     [available_commands_update]`,
    );
    expect(formatEvent(ev("agent.permission", { title: "Write /etc/hosts", decision: "deny" }))).toBe(
      `${AT}     permission "Write /etc/hosts" → deny`,
    );
  });

  it("renders artifacts, plan signals and decisions", () => {
    expect(
      formatEvent(
        ev("artifact.recorded", { artifact: { kind: "spec", name: "spec", version: 2, path: ".orca/spec.md" } }),
      ),
    ).toBe(`${AT}     ⬒ artifact spec (spec v2) .orca/spec.md`);
    expect(formatEvent(ev("artifact.recorded", { artifact: { kind: "spec", name: "spec", version: 1 } }))).toBe(
      `${AT}     ⬒ artifact spec (spec v1) `,
    );
    expect(formatEvent(ev("artifact.rejected", { kind: "spec", reason: "missing status" }))).toBe(
      `${AT}     ⚠ artifact spec rejected: missing status`,
    );
    expect(formatEvent(ev("plan.signals.rejected", { issues: ["bad ref", "cycle"] }))).toBe(
      `${AT}     ⚠ plan signals rejected: bad ref; cycle`,
    );
    expect(formatEvent(ev("decision.resolved", { choice: "ship", source: "human" }))).toBe(
      `${AT}     decision: ship (human)`,
    );
  });

  it("renders human input, children, branches, loops and vars", () => {
    expect(formatEvent(ev("human.requested", { question: "Ship it?", options: ["ship", "hold"] }))).toBe(
      `${AT}     ? Ship it? [ship | hold]`,
    );
    expect(formatEvent(ev("human.answered", { answer: "ship" }))).toBe(`${AT}     ! answered: ship`);
    expect(formatEvent(ev("child.spawned", { childRunId: "run_2", branch: "api" }))).toBe(
      `${AT}     ↳ child run run_2 (api)`,
    );
    expect(formatEvent(ev("child.spawned", { childRunId: "run_2" }))).toBe(`${AT}     ↳ child run run_2`);
    expect(formatEvent(ev("child.finished", { childRunId: "run_2", status: "completed", outcome: "success" }))).toBe(
      `${AT}     ↲ child run run_2 completed/success`,
    );
    expect(formatEvent(ev("child.finished", { childRunId: "run_2", status: "cancelled" }))).toBe(
      `${AT}     ↲ child run run_2 cancelled`,
    );
    // "claimed" is spelled out; every other reason is passed through.
    expect(formatEvent(ev("branch.skipped", { branch: "api", reason: "claimed" }))).toBe(
      `${AT}     ⤫ branch api claimed by another run`,
    );
    expect(formatEvent(ev("branch.skipped", { branch: "api", reason: "when-false" }))).toBe(
      `${AT}     ⤫ branch api skipped (when-false)`,
    );
    expect(formatEvent(ev("loop.iteration", { iteration: 3 }))).toBe(`${AT}     ↻ iteration 3`);
    expect(formatEvent(ev("vars.set", { vars: { a: 1, b: 2 } }))).toBe(`${AT}     vars a, b`);
  });

  it("falls back to the bare event type for anything it has no line for", () => {
    expect(formatEvent(ev("run.started", {}))).toBe(`${AT}     run.started`);
  });
});

const REQUEST: HumanInputRequest = {
  id: "hi_1",
  runId: "run_1",
  stepRunId: "step_gate",
  kind: "decision",
  question: "Ship it?",
  options: ["ship", "hold"],
  context: {},
  requestedAt: "2026-01-02T03:04:05.678Z",
};

function state(over: Partial<RunState["run"]> = {}): RunState {
  return {
    run: {
      id: "run_1",
      workflowId: "ai-sdlc",
      workflowVersion: "1",
      status: "running",
      workspace: { hostId: "local", cwd: "/w" },
      vars: {},
      createdAt: "2026-01-02T03:04:05.678Z",
      ...over,
    },
    steps: {},
    stepOrder: [],
    artifacts: {},
    humanInputs: {},
    lastSeq: 0,
  };
}

describe("formatRunState", () => {
  it("renders the header, steps and artifacts", () => {
    const s = state({
      outcome: "success",
      status: "completed",
      parentRunId: "run_0",
      workspace: { hostId: "local", cwd: "/w", branch: "orca/x" },
    });
    s.stepOrder = ["step_a", "step_b"];
    s.steps = {
      step_a: {
        id: "step_a",
        runId: "run_1",
        nodeId: "build",
        nodeType: "agent",
        status: "completed",
        attempt: 1,
        inputArtifactIds: ["art_1"],
        childRunIds: [],
        result: { artifactIds: ["art_1"] },
        scheduledAt: "t",
      },
      step_b: {
        id: "step_b",
        runId: "run_1",
        nodeId: "gate",
        nodeType: "gate",
        status: "failed",
        attempt: 2,
        inputArtifactIds: [],
        childRunIds: ["run_2"],
        result: { choice: "hold", artifactIds: [] },
        error: { code: "RUN_STATE", message: "nope" },
        scheduledAt: "t",
      },
    } as unknown as RunState["steps"];
    s.artifacts = {
      art_2: { id: "art_2", kind: "review", name: "review", version: 1, createdAt: "2026-01-02T03:04:06.000Z" },
      art_1: {
        id: "art_1",
        kind: "spec",
        name: "spec",
        version: 1,
        path: ".orca/spec.md",
        createdAt: "2026-01-02T03:04:05.000Z",
      },
    } as unknown as RunState["artifacts"];

    const lines = formatRunState(s).split("\n");
    expect(lines[0]).toBe("run run_1  workflow=ai-sdlc@1  status=completed/success");
    expect(lines[1]).toBe("workspace local:/w (orca/x)");
    expect(lines[2]).toBe("parent run_0");
    expect(lines).toContain("  completed build                  agent          attempt=1 inputs=1");
    expect(lines).toContain(
      "  failed    gate                   gate           attempt=2 choice=hold children=1 error=nope",
    );
    // Artifacts are listed oldest first, and an id stands in for a missing path.
    const arts = lines.slice(lines.indexOf("artifacts:") + 1);
    expect(arts[0]).toBe("  spec             spec           v1  .orca/spec.md");
    expect(arts[1]).toBe("  review           review         v1  art_2");
  });

  it("puts a run's error on its own line and lists the humans it is waiting on", () => {
    const s = state({ status: "failed", error: { code: "AGENT_FAILED", message: "agent died" } });
    expect(formatRunState(s)).toContain("error AGENT_FAILED: agent died");

    const paused = state({ status: "paused" });
    paused.humanInputs = { hi_1: REQUEST };
    paused.stepOrder = ["step_gate"];
    paused.steps = {
      step_gate: {
        id: "step_gate",
        runId: "run_1",
        nodeId: "gate",
        nodeType: "gate",
        status: "waiting",
        attempt: 1,
        inputArtifactIds: [],
        childRunIds: [],
        scheduledAt: "t",
      },
    } as unknown as RunState["steps"];
    const text = formatRunState(paused);
    expect(text).toContain("waiting for humans:");
    expect(text).toContain("  hi_1  run=run_1  Ship it? [ship | hold]");
  });
});

describe("formatPaused", () => {
  it("names a concrete request and its options in the answer hint", () => {
    expect(formatPaused("run_1", [REQUEST]).split("\n")).toEqual([
      "run run_1 is paused, waiting for a human:",
      "  hi_1  run=run_1  Ship it? [ship | hold]",
      "answer with: orca answer hi_1 <ship|hold>   (records the answer and resumes the run)",
    ]);
  });

  it("falls back to placeholders when there is nothing pending, or nothing to choose from", () => {
    expect(formatPaused("run_1", [])).toContain("orca answer <requestId> <answer>");
    expect(formatPaused("run_1", [{ ...REQUEST, options: [] }])).toContain("orca answer hi_1 <answer>");
  });
});

describe("formatPendingInput", () => {
  it("is one line: id, run and the question", () => {
    expect(formatPendingInput(REQUEST)).toBe("hi_1  run=run_1  Ship it? [ship | hold]");
  });
});
