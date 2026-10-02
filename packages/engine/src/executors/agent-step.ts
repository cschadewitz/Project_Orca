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
import type { AgentSession, HostFileSystem, SessionUpdateEvent } from "@orca/agents";
import {
  describeError,
  evaluateVars,
  OrcaError,
  renderDeliverablesBlock,
  sha256,
  type AgentNode,
  type AgentUpdateSummary,
  type AgentSelector,
  type Artifact,
  type ArtifactRef,
  type ArtifactSpec,
  type CompletionPolicy,
  type Deliverable,
} from "@orca/core";
import {
  completed,
  failed,
  type NodeExecutor,
  type ResolvedArtifact,
  type StepContext,
  type StepOutcome,
} from "./types.js";
import { artifactFieldGet } from "./artifact-field.js";

export interface AgentTurnSpec {
  agent: AgentSelector;
  template?: string;
  prompt?: string;
  inputs: ArtifactRef[];
  produces: ArtifactSpec[];
  completion: CompletionPolicy;
  /** Already-evaluated template vars: callers resolve "="-prefixed expressions with evaluateVars first. */
  vars: Record<string, unknown>;
}

export type AgentTurnOutcome =
  | { kind: "completed"; artifacts: Artifact[]; stopReason: string }
  | { kind: "failed"; error: { code: string; message: string; details?: Record<string, unknown> } };

interface PlannedDeliverable extends Deliverable {
  spec: ArtifactSpec;
}

export function absolutize(cwd: string, path: string, join: (...p: string[]) => string): string {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) ? path : join(cwd, path);
}

async function planDeliverables(
  ctx: StepContext,
  agent: AgentSelector,
  produces: ArtifactSpec[],
  extra: Record<string, unknown>,
): Promise<PlannedDeliverable[]> {
  // Paths are joined with the conventions of the host that will run the turn, so resolve
  // through the turn's own selector (decision nodes carry it under `source.agent`, not `node.agent`).
  const { host } = ctx.agents.resolve(agent);
  const out: PlannedDeliverable[] = [];
  for (const spec of produces) {
    const rel = (await ctx.render(spec.path, extra)).trim();
    // The configured path chooses the directory and filename; every visit gets a private
    // output slot. Even an identical report must be written by this attempt to count.
    const parts = rel.replaceAll("\\", "/").split("/");
    const filename = parts.pop()!;
    const attemptPath = host.joinPath(parts.join("/"), ".orca-attempts", ctx.run.id, ctx.step.id, filename);
    out.push({
      spec,
      kind: spec.kind,
      ...(spec.name ? { name: spec.name } : {}),
      path: absolutize(ctx.workspace.cwd, attemptPath, (...p) => host.joinPath(...p)),
      required: spec.required,
      ...(spec.mediaType ? { mediaType: spec.mediaType } : {}),
      ...(spec.validate?.requiredFields ? { requiredFields: spec.validate.requiredFields } : {}),
      ...(spec.validate?.fieldValues ? { fieldValues: spec.validate.fieldValues } : {}),
    });
  }
  return out;
}

/**
 * Validate an artifact's structured data against the node's rules. Returns a reason when invalid.
 *
 * A field name reads an exact top-level key first, then a dotted path into the data (#309),
 * the same way a decision's `field` does.
 */
export function validateArtifact(spec: ArtifactSpec, data: Record<string, unknown>, body: string): string | undefined {
  const v = spec.validate;
  if (!v) return undefined;
  for (const f of v.requiredFields ?? []) {
    const val = artifactFieldGet(data, f);
    if (val === undefined || val === null || val === "") return `front matter field '${f}' is missing`;
  }
  for (const [f, allowed] of Object.entries(v.fieldValues ?? {})) {
    const val = artifactFieldGet(data, f);
    if (val !== undefined && !allowed.includes(String(val)))
      return `front matter field '${f}' must be one of ${allowed.join(", ")} (got '${String(val)}')`;
  }
  if (v.minBodyLength !== undefined && body.trim().length < v.minBodyLength)
    return `body shorter than ${v.minBodyLength} characters`;
  return undefined;
}

/** Read deliverables from the host; returns recorded artifacts and problems. */
async function collect(
  ctx: StepContext,
  planned: PlannedDeliverable[],
  inputs: ResolvedArtifact[],
  session: AgentSession,
): Promise<{ artifacts: Artifact[]; problems: string[] }> {
  const { extractStructuredData, parseFrontMatter } = await import("@orca/core");
  const { host } = ctx.agents.resolve(session.agentId);
  const artifacts: Artifact[] = [];
  const problems: string[] = [];
  // One existence round trip for the whole set, then every read in flight at once: on a remote
  // host each of these is an ssh process, and doing them serially per deliverable showed up as
  // dead time at the end of every turn.
  const present = await host.fs.existsMany(planned.map((d) => d.path));
  // eslint-disable-next-line @typescript-eslint/await-thenable -- an absent deliverable maps to a plain `undefined`.
  const contents = await Promise.all(planned.map((d, i) => (present[i] ? host.fs.readFile(d.path) : undefined)));
  for (const [i, d] of planned.entries()) {
    const content = contents[i];
    if (content === undefined) {
      if (d.required) problems.push(`missing ${d.kind} at ${d.path}`);
      continue;
    }
    const data = extractStructuredData(content, d.mediaType);
    const reason = validateArtifact(d.spec, data, parseFrontMatter(content).body);
    if (reason) {
      await ctx.emit({
        type: "artifact.rejected",
        payload: { stepRunId: ctx.step.id, kind: d.kind, path: d.path, reason },
      });
      if (d.required) problems.push(`${d.kind} at ${d.path}: ${reason}`);
      continue;
    }
    artifacts.push(
      await ctx.recordArtifact(d.spec, content, {
        path: d.path,
        parents: inputs.map((i) => i.id),
        agentSessionId: session.id,
        agentId: session.agentId,
      }),
    );
  }
  return { artifacts, problems };
}

/**
 * Coalesce streamed text so the event log holds readable messages, not thousands of chunks.
 *
 * `handle` is an ACP callback: it cannot await, and it must not leave a rejected promise
 * behind - an unobserved append failure would take the whole process down (#268). So every
 * append goes onto one chain (`tail`), which keeps them in order and in which the first
 * failure is captured rather than thrown. The turn asks for it with `drain()` when it ends,
 * and fails the step with it.
 */
class UpdateRecorder {
  private buffer = "";
  private bufferKind = "";
  /** The serialised append chain; never rejects, because `append` captures instead. */
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  constructor(
    private readonly ctx: StepContext,
    private readonly sessionId: string,
    private readonly agentId: string,
  ) {}
  handle = (e: SessionUpdateEvent): void => {
    // Anything at all over this session is the agent alive, so `lastSeenAt` moves here and
    // not at the handshake. A pooled per-run session hands out one handshake and then talks
    // for as long as the run does (#227); it is one map write, on the coalescing path rather
    // than per chunk, and it notifies nobody - see `AgentHealthTracker.touch`.
    this.ctx.agents.health.touch(this.agentId);
    const s = e.summary;
    if (s.kind === "agent_message_chunk" || s.kind === "agent_thought_chunk") {
      if (this.bufferKind && this.bufferKind !== s.kind) void this.flush();
      this.bufferKind = s.kind;
      this.buffer += s.text ?? "";
      if (this.buffer.length > 4000) void this.flush();
      return;
    }
    void this.flush();
    this.append(s);
  };
  /** Queue the buffered text, if any; resolves when everything queued so far has settled. */
  flush(): Promise<void> {
    const text = this.buffer;
    const kind = this.bufferKind;
    this.buffer = "";
    if (text.trim()) this.append({ kind, text });
    return this.tail;
  }
  /** Await every queued append and hand back the first one that failed, if one did. */
  async drain(): Promise<unknown> {
    await this.flush();
    return this.failure;
  }
  private append(update: AgentUpdateSummary): void {
    this.tail = this.tail.then(async () => {
      // Once one append has failed the step is finished either way; queueing more writes
      // against a store that is already refusing them only multiplies the log lines.
      if (this.failure !== undefined) return;
      try {
        await this.ctx.emit({
          type: "agent.update",
          payload: { stepRunId: this.ctx.step.id, sessionId: this.sessionId, update },
        });
      } catch (e) {
        this.failure = e;
        this.ctx.logger.error("agent.update append failed", {
          stepRunId: this.ctx.step.id,
          sessionId: this.sessionId,
          error: describeError(e),
        });
      }
    });
  }
}

/** Base delay between two artifact-presence checks. */
const WATCH_POLL_MS = 1500;
/** Upper bound for the adaptive delay, so a sick host is still checked occasionally. */
const WATCH_MAX_POLL_MS = 30_000;

/**
 * Poll `paths` until all of them exist on the host, then call `onPresent` once.
 *
 * Checks never overlap: the next one is scheduled only after the previous has
 * settled, and it waits at least as long as that check took. A host answering in
 * 4 s is therefore polled every 4 s rather than accumulating a backlog of
 * in-flight checks (on an SSH host each check is a process). Errors are transient
 * by assumption - the turn ends on its own anyway - so they back off exponentially
 * instead of aborting the watch. Returns a function that stops the watcher.
 */
export function watchForArtifacts(fs: HostFileSystem, paths: string[], onPresent: () => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let errorDelay = WATCH_POLL_MS;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), Math.min(delayMs, WATCH_MAX_POLL_MS));
  };

  const tick = async (): Promise<void> => {
    const started = Date.now();
    let flags: boolean[];
    try {
      flags = await fs.existsMany(paths);
      errorDelay = WATCH_POLL_MS;
    } catch {
      errorDelay = Math.min(errorDelay * 2, WATCH_MAX_POLL_MS);
      schedule(errorDelay);
      return;
    }
    if (stopped) return;
    if (flags.every(Boolean)) {
      stopped = true;
      onPresent();
      return;
    }
    schedule(Math.max(WATCH_POLL_MS, Date.now() - started));
  };

  schedule(WATCH_POLL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Run one agent step (prompt -> artifacts) inside an existing StepContext. Shared by agent and decision nodes. */
export async function runAgentTurn(ctx: StepContext, spec: AgentTurnSpec): Promise<AgentTurnOutcome> {
  // resolved[i] belongs to spec.inputs[i] (undefined when an optional ref did not resolve),
  // so a missing optional input never shifts an `as` alias onto the next artifact.
  const resolved = await ctx.resolveInputs(spec.inputs);
  const inputs = resolved.filter((a): a is ResolvedArtifact => a !== undefined);
  const inputViews: Record<string, ResolvedArtifact> = {};
  spec.inputs.forEach((ref, i) => {
    const a = resolved[i];
    if (a) inputViews[ref.as ?? a.name] = a;
  });
  const extra = { inputs: inputViews, vars: { ...ctx.run.state.run.vars, ...spec.vars } };
  const deliverables = await planDeliverables(ctx, spec.agent, spec.produces, extra);
  // The run's template pack (#191), when it chose one: `<pack>/<id>` wins over `<id>`.
  const pack = ctx.run.state.run.overrides?.templatePack;
  const body = spec.template ? ctx.templates.get(spec.template, pack ? { pack } : {}).body : (spec.prompt ?? "");
  const renderPrompt = async (revision?: import("../revision-delivery.js").RevisionSlot) =>
    (await ctx.render(body, { ...extra, deliverables, ...(revision ? { revision } : {}) })).trim() +
    "\n\nUse only the explicitly supplied input artifacts as prior workflow context. Files in .orca/work, " +
    ".orca/program or .orca-attempts from other runs or attempts are not inputs; do not explore or copy them. " +
    "Write this attempt's outputs only to the exact deliverable paths below.\n\n" +
    renderDeliverablesBlock(deliverables);
  const revisionHandoff = await ctx.revisionInput?.claim(renderPrompt);
  const basePrompt = revisionHandoff?.prompt ?? (await renderPrompt());

  await ctx.emit({ type: "step.waiting", payload: { stepRunId: ctx.step.id, on: "agent-turn" } });
  const { session, release } = await ctx.openSession(spec.agent);
  const recorder = new UpdateRecorder(ctx, session.id, session.agentId);
  const unsubscribe = session.onUpdate(recorder.handle);
  const { agent } = ctx.agents.resolve(spec.agent);
  const timeoutMs = spec.completion.timeoutMs ?? agent.turnTimeoutMs;

  try {
    let prompt = basePrompt;
    for (let followUp = 0; followUp <= spec.completion.maxFollowUps; followUp++) {
      if (ctx.signal.aborted) throw new OrcaError("CANCELLED", "cancelled");
      await ctx.emit({
        type: "agent.turn.started",
        payload: {
          stepRunId: ctx.step.id,
          sessionId: session.id,
          promptHash: sha256(prompt),
          promptPreview: revisionHandoff ? "[REDACTED]" : prompt.slice(0, 400),
          followUp,
        },
      });

      // artifact-present mode: watch the host while the turn runs and cancel once every *required*
      // deliverable exists. With nothing required there is nothing to wait for (`[].every` is
      // vacuously true and would cancel on the first tick), so the step behaves like turn-end.
      const watched = spec.completion.mode === "artifact-present" ? deliverables.filter((d) => d.required) : [];
      const stopWatching =
        watched.length > 0
          ? watchForArtifacts(
              ctx.agents.resolve(spec.agent).host.fs,
              watched.map((d) => d.path),
              () => void session.cancel(),
            )
          : undefined;
      let stopReason: string;
      try {
        if (followUp === 0 && revisionHandoff) await ctx.revisionInput!.beforeSend(revisionHandoff);
        const turn = await session.prompt(prompt, { signal: ctx.signal, timeoutMs }).catch(async (error: unknown) => {
          if (followUp === 0 && revisionHandoff) await ctx.revisionInput!.uncertain(revisionHandoff);
          throw error;
        });
        if (followUp === 0 && revisionHandoff) await ctx.revisionInput!.confirm(revisionHandoff);
        stopReason = turn.stopReason;
        await recorder.flush();
        await ctx.emit({
          type: "agent.turn.completed",
          payload: { stepRunId: ctx.step.id, sessionId: session.id, stopReason, durationMs: turn.durationMs },
        });
      } finally {
        stopWatching?.();
        await recorder.flush();
      }
      // The streamed appends run off an ACP callback, so a store that refused one says so
      // here rather than as an unhandled rejection (#268). The turn's own output is part of
      // the run's record: if it did not land, the step failed, retryably.
      const appendFailure = await recorder.drain();
      if (appendFailure !== undefined) {
        const described = describeError(appendFailure);
        return {
          kind: "failed",
          error: {
            code: "STORE_WRITE",
            message: `could not record agent output for step ${ctx.step.id} (${ctx.nodeId}): ${described.message}`,
            details: { stepRunId: ctx.step.id, nodeId: ctx.nodeId, sessionId: session.id, cause: described },
          },
        };
      }
      if (ctx.signal.aborted) throw new OrcaError("CANCELLED", "cancelled");

      const { artifacts, problems } = await collect(ctx, deliverables, inputs, session);
      if (problems.length === 0) return { kind: "completed", artifacts, stopReason };
      if (followUp === spec.completion.maxFollowUps) {
        return {
          kind: "failed",
          error: {
            code: "ARTIFACT_MISSING",
            message: `agent did not deliver required artifacts: ${problems.join("; ")}`,
            details: { problems, stopReason },
          },
        };
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
      vars: await evaluateVars(n.vars, (expr) => ctx.evaluate(expr)),
    });
    if (turn.kind === "failed") return failed(turn.error.code, turn.error.message, turn.error.details, true);
    return completed({ artifactIds: turn.artifacts.map((a) => a.id), data: { stopReason: turn.stopReason } });
  },
};
