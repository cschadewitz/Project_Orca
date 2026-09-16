/** Fold a run's events into a RunState. Pure and deterministic. */
import { OrcaError } from "../errors.js";
import type { HumanInputRequest, RunState, StepRun } from "../model/run.js";
import type { OrcaEvent } from "./events.js";

export function reduceRun(events: readonly OrcaEvent[]): RunState {
  const first = events[0];
  if (!first || first.type !== "run.created") {
    throw new OrcaError("RUN_STATE", "cannot reduce: first event must be run.created", { first: first?.type });
  }
  const state: RunState = {
    run: {
      id: first.runId,
      workflowId: first.payload.workflowId,
      workflowVersion: first.payload.workflowVersion,
      status: "created",
      workspace: first.payload.workspace,
      vars: { ...first.payload.vars },
      createdAt: first.at,
      ...(first.payload.requestId ? { requestId: first.payload.requestId } : {}),
      ...(first.payload.workItemId ? { workItemId: first.payload.workItemId } : {}),
      ...(first.payload.parentRunId ? { parentRunId: first.payload.parentRunId } : {}),
      ...(first.payload.parentStepRunId ? { parentStepRunId: first.payload.parentStepRunId } : {}),
    },
    steps: {},
    stepOrder: [],
    artifacts: {},
    humanInputs: {},
    lastSeq: first.seq,
  };
  for (let i = 1; i < events.length; i++) applyEvent(state, events[i]!);
  return state;
}

/** Apply one event in place. Exported so live projections can stay incremental. */
export function applyEvent(state: RunState, e: OrcaEvent): RunState {
  state.lastSeq = e.seq;
  const step = (id: string): StepRun => {
    const s = state.steps[id];
    if (!s) throw new OrcaError("RUN_STATE", `event ${e.type} refers to unknown step ${id}`, { seq: e.seq });
    return s;
  };
  switch (e.type) {
    case "run.created":
      break;
    case "run.started":
      state.run.status = "running";
      state.run.startedAt = e.at;
      break;
    case "run.paused":
      state.run.status = "paused";
      break;
    case "run.resumed":
      state.run.status = "running";
      break;
    case "run.completed":
      state.run.status = "completed";
      state.run.outcome = e.payload.outcome;
      state.run.completedAt = e.at;
      break;
    case "run.failed":
      state.run.status = "failed";
      state.run.outcome = "failure";
      state.run.error = e.payload.error;
      state.run.completedAt = e.at;
      break;
    case "run.cancelled":
      state.run.status = "cancelled";
      state.run.outcome = "cancelled";
      state.run.completedAt = e.at;
      break;
    case "vars.set":
      Object.assign(state.run.vars, e.payload.vars);
      break;
    case "step.scheduled": {
      const s: StepRun = {
        id: e.payload.stepRunId,
        runId: e.runId,
        nodeId: e.payload.nodeId,
        nodeType: e.payload.nodeType,
        attempt: e.payload.attempt,
        status: "scheduled",
        inputArtifactIds: [],
        childRunIds: [],
        scheduledAt: e.at,
        ...(e.payload.iteration !== undefined ? { iteration: e.payload.iteration } : {}),
      };
      state.steps[s.id] = s;
      state.stepOrder.push(s.id);
      break;
    }
    case "step.started": {
      const s = step(e.payload.stepRunId);
      s.status = "running";
      s.startedAt = e.at;
      s.inputArtifactIds = e.payload.inputArtifactIds;
      delete s.waitingOn;
      break;
    }
    case "step.waiting": {
      const s = step(e.payload.stepRunId);
      s.status = "waiting";
      s.waitingOn = e.payload.on;
      if (state.run.status === "running") state.run.status = "waiting";
      break;
    }
    case "step.completed": {
      const s = step(e.payload.stepRunId);
      s.status = "completed";
      s.result = e.payload.result;
      s.completedAt = e.at;
      delete s.waitingOn;
      if (state.run.status === "waiting") state.run.status = "running";
      break;
    }
    case "step.failed": {
      const s = step(e.payload.stepRunId);
      s.status = "failed";
      s.error = e.payload.error;
      s.completedAt = e.at;
      delete s.waitingOn;
      if (state.run.status === "waiting") state.run.status = "running";
      break;
    }
    case "step.cancelled": {
      const s = step(e.payload.stepRunId);
      s.status = "cancelled";
      s.completedAt = e.at;
      break;
    }
    case "step.skipped": {
      const s = step(e.payload.stepRunId);
      s.status = "skipped";
      s.completedAt = e.at;
      break;
    }
    case "agent.session.opened":
      step(e.payload.stepRunId).agentSessionId = e.payload.sessionId;
      break;
    case "agent.turn.started":
    case "agent.update":
    case "agent.permission":
    case "agent.turn.completed":
    case "agent.session.closed":
    case "artifact.rejected":
    case "loop.iteration":
      break;
    case "artifact.recorded": {
      state.artifacts[e.payload.artifact.id] = e.payload.artifact;
      const s = state.steps[e.payload.stepRunId];
      if (s) {
        s.result ??= { artifactIds: [], data: {} };
        if (!s.result.artifactIds.includes(e.payload.artifact.id)) s.result.artifactIds.push(e.payload.artifact.id);
      }
      break;
    }
    case "decision.resolved": {
      const s = step(e.payload.stepRunId);
      s.result ??= { artifactIds: [], data: {} };
      s.result.choice = e.payload.choice;
      break;
    }
    case "child.spawned":
      step(e.payload.stepRunId).childRunIds.push(e.payload.childRunId);
      break;
    case "child.finished":
      break;
    case "human.requested": {
      const r: HumanInputRequest = {
        id: e.payload.requestId,
        runId: e.runId,
        stepRunId: e.payload.stepRunId,
        kind: e.payload.kind,
        question: e.payload.question,
        options: e.payload.options,
        context: e.payload.context,
        requestedAt: e.at,
      };
      state.humanInputs[r.id] = r;
      break;
    }
    case "human.answered": {
      const r = state.humanInputs[e.payload.requestId];
      if (r) {
        r.answer = e.payload.answer;
        r.answeredAt = e.at;
      }
      break;
    }
    default: {
      const never: never = e;
      throw new OrcaError("INTERNAL", `unhandled event ${(never as OrcaEvent).type}`);
    }
  }
  return state;
}

/**
 * Human-input requests still waiting for an answer. A request is no longer
 * pending once its run finished (e.g. was cancelled while parked) or its step
 * was cancelled (the run was resumed without an answer and asked again), even
 * though it never got an answer.
 */
export function pendingHumanInputs(state: RunState): HumanInputRequest[] {
  const { status } = state.run;
  if (status === "completed" || status === "failed" || status === "cancelled") return [];
  return Object.values(state.humanInputs).filter((h) => h.answer === undefined && state.steps[h.stepRunId]?.status === "waiting");
}

/** Latest step run for a node (highest attempt / most recently scheduled). */
export function latestStepForNode(state: RunState, nodeId: string): StepRun | undefined {
  for (let i = state.stepOrder.length - 1; i >= 0; i--) {
    const s = state.steps[state.stepOrder[i]!];
    if (s && s.nodeId === nodeId) return s;
  }
  return undefined;
}

/** Artifacts visible in a run, newest version per name first. */
export function artifactsByName(state: RunState): Map<string, RunState["artifacts"][string]> {
  const out = new Map<string, RunState["artifacts"][string]>();
  for (const a of Object.values(state.artifacts)) {
    const cur = out.get(a.name);
    if (!cur || cur.version < a.version || (cur.version === a.version && cur.createdAt < a.createdAt)) out.set(a.name, a);
  }
  return out;
}
