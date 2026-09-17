/** Human-readable rendering of events and run state for the terminal. */
import { pendingHumanInputs, type HumanInputRequest, type OrcaEvent, type RunState } from "@orca/core";

export function formatEvent(e: OrcaEvent): string {
  const t = e.at.slice(11, 19);
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "run.created":
      return `${t} run ${e.runId} created (workflow ${String(p.workflowId)})`;
    case "run.completed":
      return `${t} run ${e.runId} completed: ${String(p.outcome)}`;
    case "run.failed":
      return `${t} run ${e.runId} FAILED: ${(p.error as { message: string }).message}`;
    case "run.cancelled":
      return `${t} run ${e.runId} cancelled`;
    case "run.paused":
      return `${t} run ${e.runId} paused${p.reason ? `: ${String(p.reason)}` : ""}`;
    case "run.resumed":
      return `${t} run ${e.runId} resumed`;
    case "step.scheduled":
      return `${t}   ▶ ${String(p.nodeId)} (${String(p.nodeType)}, attempt ${String(p.attempt)})`;
    case "step.completed": {
      const r = p.result as { choice?: string; artifactIds: string[] };
      return `${t}   ✔ ${stepName(e)}${r.choice ? ` → ${r.choice}` : ""}${r.artifactIds.length ? ` [${r.artifactIds.length} artifact(s)]` : ""}`;
    }
    case "step.failed":
      return `${t}   ✖ ${stepName(e)}: ${(p.error as { message: string }).message}${p.willRetry ? " (retrying)" : ""}`;
    case "step.inputs":
      return `${t}     ⬓ inputs ${(p.artifactIds as string[]).join(", ")}`;
    case "step.waiting":
      return `${t}   … waiting on ${String(p.on)}${p.detail ? ` (${String(p.detail)})` : ""}`;
    case "agent.session.opened":
      return `${t}     session ${String(p.sessionId)} agent=${String(p.agentId)} host=${String(p.hostId)} cwd=${String(p.cwd)}`;
    case "agent.turn.started":
      return `${t}     prompt (${String(p.promptHash).slice(0, 8)}) follow-up=${String(p.followUp)}`;
    case "agent.turn.completed":
      return `${t}     turn ended: ${String(p.stopReason)} in ${String(p.durationMs)}ms`;
    case "agent.update": {
      const u = p.update as { kind: string; text?: string; title?: string; status?: string };
      if (u.kind === "agent_message_chunk") return `${t}     │ ${(u.text ?? "").trim().split("\n").join("\n           │ ")}`;
      if (u.kind === "tool_call" || u.kind === "tool_call_update") return `${t}     ⚙ ${u.title ?? ""} ${u.status ?? ""}`.trimEnd();
      return `${t}     [${u.kind}]`;
    }
    case "agent.permission":
      return `${t}     permission "${String(p.title)}" → ${String(p.decision)}`;
    case "artifact.recorded": {
      const a = p.artifact as { kind: string; name: string; version: number; path?: string };
      return `${t}     ⬒ artifact ${a.name} (${a.kind} v${a.version}) ${a.path ?? ""}`;
    }
    case "artifact.rejected":
      return `${t}     ⚠ artifact ${String(p.kind)} rejected: ${String(p.reason)}`;
    case "decision.resolved":
      return `${t}     decision: ${String(p.choice)} (${String(p.source)})`;
    case "human.requested":
      return `${t}     ? ${String(p.question)} [${(p.options as string[]).join(" | ")}]`;
    case "human.answered":
      return `${t}     ! answered: ${String(p.answer)}`;
    case "child.spawned":
      return `${t}     ↳ child run ${String(p.childRunId)}${p.branch ? ` (${String(p.branch)})` : ""}`;
    case "child.finished":
      return `${t}     ↲ child run ${String(p.childRunId)} ${String(p.status)}${p.outcome ? `/${String(p.outcome)}` : ""}`;
    case "loop.iteration":
      return `${t}     ↻ iteration ${String(p.iteration)}`;
    case "vars.set":
      return `${t}     vars ${Object.keys(p.vars as object).join(", ")}`;
    default:
      return `${t}     ${e.type}`;
  }
}

function stepName(e: OrcaEvent): string {
  return String((e.payload as { stepRunId?: string }).stepRunId ?? "").replace(/^step_/, "step ");
}

export function formatRunState(s: RunState): string {
  const lines = [`run ${s.run.id}  workflow=${s.run.workflowId}@${s.run.workflowVersion}  status=${s.run.status}${s.run.outcome ? `/${s.run.outcome}` : ""}`, `workspace ${s.run.workspace.hostId}:${s.run.workspace.cwd}${s.run.workspace.branch ? ` (${s.run.workspace.branch})` : ""}`];
  if (s.run.parentRunId) lines.push(`parent ${s.run.parentRunId}`);
  if (s.run.error) lines.push(`error ${s.run.error.code}: ${s.run.error.message}`);
  lines.push("", "steps:");
  for (const id of s.stepOrder) {
    const st = s.steps[id]!;
    const extras = [st.result?.choice ? `choice=${st.result.choice}` : "", st.inputArtifactIds.length ? `inputs=${st.inputArtifactIds.length}` : "", st.childRunIds.length ? `children=${st.childRunIds.length}` : "", st.error ? `error=${st.error.message}` : ""].filter(Boolean).join(" ");
    lines.push(`  ${st.status.padEnd(9)} ${st.nodeId.padEnd(22)} ${st.nodeType.padEnd(14)} attempt=${st.attempt} ${extras}`.trimEnd());
  }
  const arts = Object.values(s.artifacts);
  if (arts.length) {
    lines.push("", "artifacts:");
    for (const a of arts.sort((x, y) => x.createdAt.localeCompare(y.createdAt))) lines.push(`  ${a.name.padEnd(16)} ${a.kind.padEnd(14)} v${a.version}  ${a.path ?? a.id}`);
  }
  const pending = pendingHumanInputs(s);
  if (pending.length) {
    lines.push("", "waiting for humans:");
    for (const h of pending) lines.push(`  ${formatPendingInput(h)}`);
  }
  return lines.join("\n");
}

export function formatPendingInput(h: HumanInputRequest): string {
  return `${h.id}  run=${h.runId}  ${h.question} [${h.options.join(" | ")}]`;
}

/** What a user sees when a run parks at a human gate: the open questions (across the run tree) and how to answer them. */
export function formatPaused(runId: string, pending: HumanInputRequest[]): string {
  const lines = [`run ${runId} is paused, waiting for a human:`];
  for (const h of pending) lines.push(`  ${formatPendingInput(h)}`);
  const example = pending[0];
  lines.push(`answer with: orca answer ${example?.id ?? "<requestId>"} ${example?.options.length ? `<${example.options.join("|")}>` : "<answer>"}   (records the answer and resumes the run)`);
  return lines.join("\n");
}
