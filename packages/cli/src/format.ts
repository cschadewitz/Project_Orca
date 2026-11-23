/** Human-readable rendering of events and run state for the terminal. */
import { EventPayload, pendingHumanInputs, type HumanInputRequest, type OrcaEvent, type RunState } from "@orca/core";

export function formatEvent(e: Pick<OrcaEvent, "at" | "runId"> & { type: string; payload: unknown }): string {
  const t = e.at.slice(11, 19);
  const p = new EventPayload(e.payload);
  switch (e.type) {
    case "run.created":
      return `${t} run ${e.runId} created (workflow ${p.text("workflowId")})`;
    case "run.completed":
      return `${t} run ${e.runId} completed: ${p.text("outcome")}`;
    case "run.failed":
      return `${t} run ${e.runId} FAILED: ${p.record("error").text("message")}`;
    case "run.cancelled":
      return `${t} run ${e.runId} cancelled`;
    case "run.paused":
      return `${t} run ${e.runId} paused${p.optionalText("reason") ? `: ${p.text("reason")}` : ""}`;
    case "run.resumed":
      return `${t} run ${e.runId} resumed`;
    case "step.scheduled":
      return `${t}   ▶ ${p.text("nodeId")} (${p.text("nodeType")}, attempt ${p.text("attempt")})`;
    case "step.completed": {
      const r = p.record("result");
      return `${t}   ✔ ${p.optionalText("stepRunId").replace(/^step_/, "step ")}${r.optionalText("choice") ? ` → ${r.optionalText("choice")}` : ""}${r.list("artifactIds").length ? ` [${r.list("artifactIds").length} artifact(s)]` : ""}`;
    }
    case "step.failed":
      return `${t}   ✖ ${p.optionalText("stepRunId").replace(/^step_/, "step ")}: ${p.record("error").text("message")}${p.flag("willRetry") ? " (retrying)" : ""}`;
    case "step.inputs":
      return `${t}     ⬓ inputs ${p.strings("artifactIds").join(", ")}`;
    case "step.waiting":
      return `${t}   … waiting on ${p.text("on")}${p.optionalText("detail") ? ` (${p.text("detail")})` : ""}`;
    case "agent.session.opened":
      return `${t}     session ${p.text("sessionId")} agent=${p.text("agentId")}${p.optionalText("model") ? ` model=${p.text("model")}` : ""} host=${p.text("hostId")} cwd=${p.text("cwd")}`;
    case "agent.turn.started":
      return `${t}     prompt (${p.text("promptHash", 8)}) follow-up=${p.text("followUp")}`;
    case "agent.turn.completed":
      return `${t}     turn ended: ${p.text("stopReason")} in ${p.text("durationMs")}ms`;
    case "agent.update": {
      const u = p.record("update");
      if (u.text("kind") === "agent_message_chunk")
        return `${t}     │ ${u.optionalText("text").trim().split("\n").join("\n           │ ")}`;
      if (u.text("kind") === "tool_call" || u.text("kind") === "tool_call_update")
        return `${t}     ⚙ ${u.optionalText("title")} ${u.optionalText("status")}`.trimEnd();
      return `${t}     [${u.text("kind")}]`;
    }
    case "agent.permission":
      return `${t}     permission "${p.text("title")}" → ${p.text("decision")}`;
    case "agent.fs.authorized":
      return `${t}     file ${p.text("access")} "${p.text("display")}" authorized (${p.text("decision")}, ${p.text("io")})`;
    case "agent.fs.completed":
      return `${t}     file operation ${p.text("outcome")}`;
    case "artifact.recorded": {
      const a = p.record("artifact");
      return `${t}     ⬒ artifact ${a.text("name")} (${a.text("kind")} v${a.text("version")}) ${a.optionalText("path")}`;
    }
    case "artifact.rejected":
      return `${t}     ⚠ artifact ${p.text("kind")} rejected: ${p.text("reason")}`;
    case "plan.signals.rejected":
      return `${t}     ⚠ plan signals rejected: ${p.strings("issues").join("; ")}`;
    case "decision.resolved":
      return `${t}     decision: ${p.text("choice")} (${p.text("source")})`;
    case "human.requested":
      return `${t}     ? ${p.text("question")} [${p.optionLabels("options").join(" | ")}]`;
    case "human.answered":
      return `${t}     ! answered: ${p.text("answer")}`;
    case "child.spawned":
      return `${t}     ↳ child run ${p.text("childRunId")}${p.optionalText("branch") ? ` (${p.text("branch")})` : ""}`;
    case "child.finished":
      return `${t}     ↲ child run ${p.text("childRunId")} ${p.text("status")}${p.optionalText("outcome") ? `/${p.text("outcome")}` : ""}`;
    case "branch.skipped":
      return `${t}     ⤫ branch ${p.text("branch")} ${p.optionalText("reason") === "claimed" ? "claimed by another run" : `skipped (${p.text("reason")})`}`;
    case "loop.iteration":
      return `${t}     ↻ iteration ${p.text("iteration")}`;
    case "vars.set":
      return `${t}     vars ${p.record("vars").keys().join(", ")}`;
    default:
      return `${t}     ${e.type}`;
  }
}

/** Which agent (and model, when recorded) opened a session for each step, from `agent.session.opened`. */
export type StepAgents = ReadonlyMap<string, { agentId: string; model?: string }>;

export function stepAgents(events: readonly OrcaEvent[]): StepAgents {
  const byStep = new Map<string, { agentId: string; model?: string }>();
  for (const e of events)
    if (e.type === "agent.session.opened")
      byStep.set(e.payload.stepRunId, {
        agentId: e.payload.agentId,
        ...(e.payload.model !== undefined ? { model: e.payload.model } : {}),
      });
  return byStep;
}

export function formatRunState(s: RunState, agents: StepAgents = new Map()): string {
  const lines = [
    `run ${s.run.id}  workflow=${s.run.workflowId}@${s.run.workflowVersion}  status=${s.run.status}${s.run.outcome ? `/${s.run.outcome}` : ""}`,
    `workspace ${s.run.workspace.hostId}:${s.run.workspace.cwd}${s.run.workspace.branch ? ` (${s.run.workspace.branch})` : ""}`,
  ];
  if (s.run.parentRunId) lines.push(`parent ${s.run.parentRunId}`);
  if (s.run.error) lines.push(`error ${s.run.error.code}: ${s.run.error.message}`);
  lines.push("", "steps:");
  for (const id of s.stepOrder) {
    const st = s.steps[id]!;
    const agent = agents.get(id);
    const extras = [
      agent ? `agent=${agent.agentId}` : "",
      agent?.model ? `model=${agent.model}` : "",
      st.result?.choice ? `choice=${st.result.choice}` : "",
      st.inputArtifactIds.length ? `inputs=${st.inputArtifactIds.length}` : "",
      st.childRunIds.length ? `children=${st.childRunIds.length}` : "",
      st.error ? `error=${st.error.message}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `  ${st.status.padEnd(9)} ${st.nodeId.padEnd(22)} ${st.nodeType.padEnd(14)} attempt=${st.attempt} ${extras}`.trimEnd(),
    );
  }
  const arts = Object.values(s.artifacts);
  if (arts.length) {
    lines.push("", "artifacts:");
    for (const a of arts.sort((x, y) => x.createdAt.localeCompare(y.createdAt)))
      lines.push(`  ${a.name.padEnd(16)} ${a.kind.padEnd(14)} v${a.version}  ${a.path ?? a.id}`);
  }
  const pending = pendingHumanInputs(s);
  if (pending.length) {
    lines.push("", "waiting for humans:");
    for (const h of pending) lines.push(`  ${formatPendingInput(h)}`);
  }
  return lines.join("\n");
}

export function formatPendingInput(h: HumanInputRequest): string {
  return `${h.id}  run=${h.runId}  ${h.question} [${h.options.map((o) => o.label).join(" | ")}]`;
}

/** What a user sees when a run parks at a human gate: the open questions (across the run tree) and how to answer them. */
export function formatPaused(runId: string, pending: HumanInputRequest[]): string {
  const lines = [`run ${runId} is paused, waiting for a human:`];
  for (const h of pending) lines.push(`  ${formatPendingInput(h)}`);
  const example = pending[0];
  lines.push(
    // Ids, not labels: `orca answer` records what it is given, and the id is what a re-run compares against.
    `answer with: orca answer ${example?.id ?? "<requestId>"} ${example?.options.length ? `<${example.options.map((o) => o.id).join("|")}>` : "<answer>"}   (records the answer and resumes the run)`,
  );
  return lines.join("\n");
}
