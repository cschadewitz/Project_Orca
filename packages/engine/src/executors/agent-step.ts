/**
 * Agent step executor - the heart of the hand-off.
 *
 *  1. resolve input artifacts and render the prompt template
 *  2. open (or reuse) an ACP session on the agent's host
 *  3. send the prompt; stream updates into the event log
 *  4. when the turn ends, read the promised artifacts from the host's file
 *     system, validate their front matter, and record them
 *  5. if something is missing, send a follow-up prompt (bounded)
 */
import { isAbsolute } from "node:path";
import type { AgentSession, SessionUpdateEvent } from "@orca/agents";
import { OrcaError, renderDeliverablesBlock, sha256, type AgentNode, type AgentSelector, type Artifact, type ArtifactRef, type ArtifactSpec, type CompletionPolicy, type Deliverable } from "@orca/core";
import { completed, failed, type NodeExecutor, type ResolvedArtifact, type StepContext, type StepOutcome } from "./types.js";

export interface AgentTurnSpec {
  agent: AgentSelector;
  template?: string;
  prompt?: string;
  inputs: ArtifactRef[];
  produces: ArtifactSpec[];
  completion: CompletionPolicy;
  vars: Record<string, unknown>;
}

export type AgentTurnOutcome = { kind: "completed"; artifacts: Artifact[]; stopReason: string } | { kind: "failed"; error: { code: string; message: string; details?: Record<string, unknown> } };

interface PlannedDeliverable extends Deliverable {
  spec: ArtifactSpec;
  absolutePath: string;
}

export function absolutize(cwd: string, path: string, join: (...p: string[]) => string): string {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) ? path : join(cwd, path);
}

async function planDeliverables(ctx: StepContext, produces: ArtifactSpec[], extra: Record<string, unknown>): Promise<PlannedDeliverable[]> {
  const { host } = ctx.agents.resolve((ctx.node as AgentNode).agent ?? "local");
  const out: PlannedDeliverable[] = [];
  for (const spec of produces) {
    const rel = (await ctx.render(spec.path, extra)).trim();
    const absolutePath = absolutize(ctx.workspace.cwd, rel, (...p) => host.joinPath(...p));
    out.push({
      spec,
      kind: spec.kind,
      ...(spec.name ? { name: spec.name } : {}),
      path: absolutePath,
      absolutePath,
      required: spec.required,
      ...(spec.mediaType ? { mediaType: spec.mediaType } : {}),
      ...(spec.validate?.requiredFields ? { requiredFields: spec.validate.requiredFields } : {}),
      ...(spec.validate?.fieldValues ? { fieldValues: spec.validate.fieldValues } : {}),
    });
  }
  return out;
}

/** Validate an artifact's structured data against the node's rules. Returns a reason when invalid. */
export function validateArtifact(spec: ArtifactSpec, data: Record<string, unknown>, body: string): string | undefined {
  const v = spec.validate;
  if (!v) return undefined;
  for (const f of v.requiredFields ?? []) {
    const val = data[f];
    if (val === undefined || val === null || val === "") return `front matter field '${f}' is missing`;
  }
  for (const [f, allowed] of Object.entries(v.fieldValues ?? {})) {
    const val = data[f];
    if (val !== undefined && !allowed.includes(String(val))) return `front matter field '${f}' must be one of ${allowed.join(", ")} (got '${String(val)}')`;
  }
  if (v.minBodyLength !== undefined && body.trim().length < v.minBodyLength) return `body shorter than ${v.minBodyLength} characters`;
  return undefined;
}

/** Read deliverables from the host; returns recorded artifacts and problems. */
async function collect(ctx: StepContext, planned: PlannedDeliverable[], inputs: ResolvedArtifact[], session: AgentSession): Promise<{ artifacts: Artifact[]; problems: string[] }> {
  const { extractStructuredData, parseFrontMatter } = await import("@orca/core");
  const { host } = ctx.agents.resolve(session.agentId);
  const artifacts: Artifact[] = [];
  const problems: string[] = [];
  for (const d of planned) {
    if (!(await host.fs.exists(d.absolutePath))) {
      if (d.required) problems.push(`missing ${d.kind} at ${d.absolutePath}`);
      continue;
    }
    const content = await host.fs.readFile(d.absolutePath);
    const data = extractStructuredData(content, d.mediaType);
    const reason = validateArtifact(d.spec, data, parseFrontMatter(content).body);
    if (reason) {
      await ctx.emit({ type: "artifact.rejected", payload: { stepRunId: ctx.step.id, kind: d.kind, path: d.absolutePath, reason } });
      if (d.required) problems.push(`${d.kind} at ${d.absolutePath}: ${reason}`);
      continue;
    }
    artifacts.push(await ctx.recordArtifact(d.spec, content, { path: d.absolutePath, parents: inputs.map((i) => i.id), agentSessionId: session.id, agentId: session.agentId }));
  }
  return { artifacts, problems };
}

/** Coalesce streamed text so the event log holds readable messages, not thousands of chunks. */
class UpdateRecorder {
  private buffer = "";
  private bufferKind = "";
  constructor(
    private readonly ctx: StepContext,
    private readonly sessionId: string,
  ) {}
  handle = (e: SessionUpdateEvent): void => {
    const s = e.summary;
    if (s.kind === "agent_message_chunk" || s.kind === "agent_thought_chunk") {
      if (this.bufferKind && this.bufferKind !== s.kind) void this.flush();
      this.bufferKind = s.kind;
      this.buffer += s.text ?? "";
      if (this.buffer.length > 4000) void this.flush();
      return;
    }
    void this.flush();
    void this.ctx.emit({ type: "agent.update", payload: { stepRunId: this.ctx.step.id, sessionId: this.sessionId, update: s } });
  };
  async flush(): Promise<void> {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return;
    }
    const text = this.buffer;
    const kind = this.bufferKind;
    this.buffer = "";
    await this.ctx.emit({ type: "agent.update", payload: { stepRunId: this.ctx.step.id, sessionId: this.sessionId, update: { kind, text } } });
  }
}

/** Run one agent step (prompt -> artifacts) inside an existing StepContext. Shared by agent and decision nodes. */
export async function runAgentTurn(ctx: StepContext, spec: AgentTurnSpec): Promise<AgentTurnOutcome> {
  const inputs = await ctx.resolveInputs(spec.inputs);
  const inputViews: Record<string, ResolvedArtifact> = {};
  spec.inputs.forEach((ref, i) => {
    const a = inputs[i];
    if (a) inputViews[ref.as ?? a.name] = a;
  });
  const extra = { inputs: inputViews, vars: { ...ctx.run.state.run.vars, ...spec.vars } };
  const deliverables = await planDeliverables(ctx, spec.produces, extra);
  const body = spec.template ? ctx.templates.get(spec.template).body : (spec.prompt ?? "");
  const basePrompt = (await ctx.render(body, { ...extra, deliverables })).trim() + "\n\n" + renderDeliverablesBlock(deliverables);

  await ctx.emit({ type: "step.waiting", payload: { stepRunId: ctx.step.id, on: "agent-turn" } });
  const { session, release } = await ctx.openSession(spec.agent);
  const recorder = new UpdateRecorder(ctx, session.id);
  const unsubscribe = session.onUpdate(recorder.handle);
  const { agent } = ctx.agents.resolve(spec.agent);
  const timeoutMs = spec.completion.timeoutMs ?? agent.turnTimeoutMs;

  try {
    let prompt = basePrompt;
    for (let followUp = 0; followUp <= spec.completion.maxFollowUps; followUp++) {
      if (ctx.signal.aborted) throw new OrcaError("CANCELLED", "cancelled");
      await ctx.emit({ type: "agent.turn.started", payload: { stepRunId: ctx.step.id, sessionId: session.id, promptHash: sha256(prompt), promptPreview: prompt.slice(0, 400), followUp } });

      // artifact-present mode: watch the host while the turn runs and cancel once everything exists.
      let watcher: ReturnType<typeof setInterval> | undefined;
      if (spec.completion.mode === "artifact-present" && deliverables.length > 0) {
        const { host } = ctx.agents.resolve(spec.agent);
        watcher = setInterval(() => {
          void Promise.all(deliverables.filter((d) => d.required).map((d) => host.fs.exists(d.absolutePath))).then((flags) => {
            if (flags.every(Boolean)) void session.cancel();
          });
        }, 1500);
      }
      let stopReason: string;
      try {
        const turn = await session.prompt(prompt, { signal: ctx.signal, timeoutMs });
        stopReason = turn.stopReason;
        await recorder.flush();
        await ctx.emit({ type: "agent.turn.completed", payload: { stepRunId: ctx.step.id, sessionId: session.id, stopReason, durationMs: turn.durationMs } });
      } finally {
        if (watcher) clearInterval(watcher);
        await recorder.flush();
      }
      if (ctx.signal.aborted) throw new OrcaError("CANCELLED", "cancelled");

      const { artifacts, problems } = await collect(ctx, deliverables, inputs, session);
      if (problems.length === 0) return { kind: "completed", artifacts, stopReason };
      if (followUp === spec.completion.maxFollowUps) {
        return { kind: "failed", error: { code: "ARTIFACT_MISSING", message: `agent did not deliver required artifacts: ${problems.join("; ")}`, details: { problems, stopReason } } };
      }
      prompt = `Your previous turn ended (${stopReason}) but the following deliverables are missing or invalid:\n\n${problems.map((p) => `- ${p}`).join("\n")}\n\nPlease fix them now. Do not start unrelated work.\n\n${renderDeliverablesBlock(deliverables)}`;
    }
    throw new OrcaError("INTERNAL", "unreachable");
  } finally {
    unsubscribe();
    await release();
  }
}

export const agentExecutor: NodeExecutor<AgentNode> = {
  type: "agent",
  async execute(ctx): Promise<StepOutcome> {
    const n = ctx.node;
    const turn = await runAgentTurn(ctx, {
      agent: n.agent,
      ...(n.template ? { template: n.template } : {}),
      ...(n.prompt ? { prompt: n.prompt } : {}),
      inputs: n.inputs,
      produces: n.produces,
      completion: n.completion,
      vars: n.vars,
    });
    if (turn.kind === "failed") return failed(turn.error.code, turn.error.message, turn.error.details, true);
    return completed({ artifactIds: turn.artifacts.map((a) => a.id), data: { stopReason: turn.stopReason } });
  },
};
