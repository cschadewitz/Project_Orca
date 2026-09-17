/** Fold a run's events into a RunState. Pure and deterministic. */
import { OrcaError } from "../errors.js";
import type { HumanInputRequest, RunState, RunSummary, StepRun } from "../model/run.js";
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
        children: [],
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
      // Keep the union of artifact ids already recorded during the step (via
      // artifact.recorded) and those the executor's result repeats. Executors
      // such as decision nodes or plugins may record artifacts and then return
      // a result whose artifactIds is empty; the recorded ones must survive.
      const recorded = s.result?.artifactIds ?? [];
      const artifactIds = [...recorded];
      for (const id of e.payload.result.artifactIds) if (!artifactIds.includes(id)) artifactIds.push(id);
      s.result = { ...e.payload.result, artifactIds };
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
    case "child.spawned": {
      const s = step(e.payload.stepRunId);
      s.childRunIds.push(e.payload.childRunId);
      s.children.push({ runId: e.payload.childRunId, ...(e.payload.branch !== undefined ? { branch: e.payload.branch } : {}), ...(e.payload.resumed ? { resumed: true } : {}) });
      break;
    }
    case "child.finished": {
      const link = step(e.payload.stepRunId).children.find((c) => c.runId === e.payload.childRunId);
      if (link) {
        link.status = e.payload.status;
        if (e.payload.outcome) link.outcome = e.payload.outcome;
      }
      break;
    }
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

/**
 * The only event types that can move a field of RunSummary. Listings project a
 * run from these alone, so they never touch the `agent.update` bulk of a log.
 * Keep in sync with reduceRunSummary (and with applyEvent, which it mirrors).
 */
export const RUN_SUMMARY_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.paused",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "step.waiting",
  "step.completed",
  "step.failed",
] as const satisfies readonly OrcaEvent["type"][];

/** Narrow a full run projection to its summary. */
export function runSummary(state: RunState): RunSummary {
  const r = state.run;
  return {
    id: r.id,
    workflowId: r.workflowId,
    workflowVersion: r.workflowVersion,
    status: r.status,
    createdAt: r.createdAt,
    ...(r.outcome ? { outcome: r.outcome } : {}),
    ...(r.requestId ? { requestId: r.requestId } : {}),
    ...(r.workItemId ? { workItemId: r.workItemId } : {}),
    ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}),
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.completedAt ? { completedAt: r.completedAt } : {}),
  };
}

/**
 * Fold a run's RUN_SUMMARY_EVENT_TYPES events into a RunSummary. Equivalent to
 * `runSummary(reduceRun(allEvents))` but needs only the filtered events; events
 * of other types are ignored, so a full log works too.
 */
export function reduceRunSummary(events: readonly OrcaEvent[]): RunSummary {
  const first = events[0];
  if (!first || first.type !== "run.created") {
    throw new OrcaError("RUN_STATE", "cannot reduce: first event must be run.created", { first: first?.type });
  }
  const s: RunSummary = {
    id: first.runId,
    workflowId: first.payload.workflowId,
    workflowVersion: first.payload.workflowVersion,
    status: "created",
    createdAt: first.at,
    ...(first.payload.requestId ? { requestId: first.payload.requestId } : {}),
    ...(first.payload.workItemId ? { workItemId: first.payload.workItemId } : {}),
    ...(first.payload.parentRunId ? { parentRunId: first.payload.parentRunId } : {}),
  };
  for (let i = 1; i < events.length; i++) {
    const e = events[i]!;
    switch (e.type) {
      case "run.started":
        s.status = "running";
        s.startedAt = e.at;
        break;
      case "run.paused":
        s.status = "paused";
        break;
      case "run.resumed":
        s.status = "running";
        break;
      case "run.completed":
        s.status = "completed";
        s.outcome = e.payload.outcome;
        s.completedAt = e.at;
        break;
      case "run.failed":
        s.status = "failed";
        s.outcome = "failure";
        s.completedAt = e.at;
        break;
      case "run.cancelled":
        s.status = "cancelled";
        s.outcome = "cancelled";
        s.completedAt = e.at;
        break;
      case "step.waiting":
        if (s.status === "running") s.status = "waiting";
        break;
      case "step.completed":
      case "step.failed":
        if (s.status === "waiting") s.status = "running";
        break;
      default:
        break;
    }
  }
  return s;
}
