/**
 * ORCA as an ACP *agent* (proxy mode).
 *
 * Any ACP client - GitKraken Kepler, Zed, T3 Code, an IDE - can launch `orca
 * acp` exactly as it would launch Claude Code or Codex. Prompts become
 * Requests (or direct workflow runs); ORCA then fans out to the real coding
 * agents (local or over SSH) and streams progress back as ACP session updates:
 *
 *   - the workflow's nodes become a `plan` update (one entry per node)
 *   - agent text becomes `agent_message_chunk`s prefixed with the node id
 *   - recorded artifacts become completed `tool_call`s with file locations
 *   - gates and `ask` permissions are forwarded as `session/request_permission`
 *
 * Prompt grammar:
 *   /run <workflowId> [key=value ...]   run a workflow in the session cwd
 *   /status                             summarise runs in this session
 *   anything else                       submit as a Request (first line = title)
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { newId, type OrcaEvent, type RunState, type WorkflowDefinition } from "@orca/core";
import type { Orchestrator, ProgramService } from "@orca/engine";
import { UpstreamHumanInput } from "./upstream-human-input.js";

export interface OrcaAcpAgentOptions {
  orchestrator: Orchestrator;
  program: ProgramService;
  /** Where ORCA's workspace provider is ignored and the client's cwd is used instead (default true). */
  useClientCwd?: boolean;
  humanInput?: UpstreamHumanInput;
  name?: string;
  version?: string;
}

interface FacadeSession {
  id: string;
  cwd: string;
  runIds: string[];
  active?: { runId: string; abort: AbortController };
}

export class OrcaAcpAgent {
  private readonly sessions = new Map<string, FacadeSession>();
  private readonly humanInput: UpstreamHumanInput;
  constructor(private readonly opts: OrcaAcpAgentOptions) {
    this.humanInput = opts.humanInput ?? new UpstreamHumanInput(opts.orchestrator.humanInput);
    opts.orchestrator.humanInput = this.humanInput;
  }

  register(app: acp.AgentApp): acp.AgentApp {
    return app
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
        agentInfo: { name: this.opts.name ?? "orca", version: this.opts.version ?? "0.1.0" },
      }))
      .onRequest(acp.methods.agent.authenticate, () => ({}))
      .onRequest(acp.methods.agent.session.new, (ctx) => {
        const id = newId("sess");
        this.sessions.set(id, { id, cwd: ctx.params.cwd, runIds: [] });
        return { sessionId: id };
      })
      .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
        const s = this.sessions.get(ctx.params.sessionId);
        if (s?.active) await this.opts.orchestrator.cancel(s.active.runId, "cancelled by client");
      })
      .onRequest(acp.methods.agent.session.prompt, (ctx) => this.prompt(ctx));
  }

  private async prompt(ctx: acp.AgentRequestContext<acp.PromptRequest>): Promise<acp.PromptResponse> {
    const session = this.sessions.get(ctx.params.sessionId);
    if (!session) throw acp.RequestError.invalidParams({ sessionId: ctx.params.sessionId, reason: "unknown session" });
    const text = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : b.type === "resource" && "text" in b.resource ? b.resource.text : "")).join("\n").trim();
    const say = (t: string) => ctx.client.notify(acp.methods.client.session.update, { sessionId: session.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } });

    if (text === "/status") {
      const states = await Promise.all(session.runIds.map((id) => this.opts.orchestrator.getState(id)));
      await say(states.length ? states.map((s) => `- ${s.run.id} ${s.run.workflowId}: ${s.run.status}${s.run.outcome ? `/${s.run.outcome}` : ""}`).join("\n") + "\n" : "No runs in this session yet.\n");
      return { stopReason: "end_turn" };
    }

    const orchestrator = this.opts.orchestrator;
    const workspace = this.opts.useClientCwd === false ? undefined : { hostId: "local", cwd: session.cwd, provider: "acp-client" };
    let runId: string;
    if (text.startsWith("/run ")) {
      const [, workflowId, ...rest] = text.split(/\s+/);
      const vars: Record<string, unknown> = {};
      for (const kv of rest) {
        const [k, ...v] = kv.split("=");
        if (k) vars[k] = v.join("=");
      }
      runId = await orchestrator.startRun({ workflowId: workflowId!, vars, ...(workspace ? { workspace } : {}) });
    } else {
      const [title, ...body] = text.split("\n");
      const submitted = await this.opts.program.submit({ title: title || "Untitled request", body: body.join("\n").trim(), source: { kind: "acp-session", sessionId: session.id } });
      runId = submitted.runId;
    }
    session.runIds.push(runId);
    session.active = { runId, abort: new AbortController() };
    this.humanInput.bind({ sessionId: session.id, request: (m, p) => ctx.client.request(m, p) });

    const state0 = await orchestrator.getState(runId);
    const def = orchestrator.resolveDefinition(state0.run.workflowId);
    await say(`Starting ${def.name} (run ${runId}) in ${session.cwd}\n`);
    const unsubscribe = orchestrator.subscribe((e) => void this.forward(ctx, session, def, runId, e));
    try {
      const final = await orchestrator.run(runId);
      await this.sendPlan(ctx, session, def, final);
      await say(`\nRun ${runId} ${final.run.status}${final.run.outcome ? ` (${final.run.outcome})` : ""}${final.run.error ? `: ${final.run.error.message}` : ""}\n`);
      return { stopReason: final.run.status === "cancelled" ? "cancelled" : "end_turn" };
    } finally {
      unsubscribe();
      this.humanInput.bind(undefined);
      delete session.active;
    }
  }

  /** Translate ORCA events (root run and its descendants) into ACP session updates. */
  private async forward(ctx: acp.AgentRequestContext<acp.PromptRequest>, session: FacadeSession, def: WorkflowDefinition, rootRunId: string, e: OrcaEvent): Promise<void> {
    const orchestrator = this.opts.orchestrator;
    const notify = (update: acp.SessionUpdate) => ctx.client.notify(acp.methods.client.session.update, { sessionId: session.id, update });
    const isRoot = e.runId === rootRunId;
    let prefix = "";
    if (!isRoot) {
      // Only forward descendants of our run.
      try {
        let cur = await orchestrator.getState(e.runId);
        const chain: string[] = [];
        while (cur.run.parentRunId && cur.run.parentRunId !== rootRunId) {
          chain.unshift(cur.run.workflowId);
          cur = await orchestrator.getState(cur.run.parentRunId);
        }
        if (cur.run.parentRunId !== rootRunId) return;
        prefix = `[${[cur.run.workflowId, ...chain].join(" › ")}] `;
      } catch {
        return;
      }
    }
    switch (e.type) {
      case "step.scheduled":
      case "step.completed":
      case "step.failed":
        if (isRoot) await this.sendPlan(ctx, session, def, await orchestrator.getState(rootRunId));
        else if (e.type === "step.scheduled") await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${prefix}▶ ${e.payload.nodeId}\n` } });
        break;
      case "agent.update": {
        const u = e.payload.update;
        if (u.kind === "agent_message_chunk" && u.text) await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${prefix}${u.text}` } });
        else if (u.kind === "tool_call" && u.toolCallId) await notify({ sessionUpdate: "tool_call", toolCallId: `${e.runId}:${u.toolCallId}`, title: `${prefix}${u.title ?? ""}`, kind: (u.toolKind as acp.ToolKind | undefined) ?? "other", status: (u.status as acp.ToolCallStatus | undefined) ?? "in_progress", locations: (u.locations ?? []).map((path) => ({ path })) });
        else if (u.kind === "tool_call_update" && u.toolCallId) await notify({ sessionUpdate: "tool_call_update", toolCallId: `${e.runId}:${u.toolCallId}`, ...(u.status ? { status: u.status as acp.ToolCallStatus } : {}) });
        break;
      }
      case "artifact.recorded": {
        const a = e.payload.artifact;
        await notify({
          sessionUpdate: "tool_call",
          toolCallId: a.id,
          title: `${prefix}artifact ${a.name} (${a.kind} v${a.version})`,
          kind: "edit",
          status: "completed",
          locations: a.path ? [{ path: a.path }] : [],
          content: a.path ? [{ type: "content", content: { type: "resource_link", uri: `file://${a.path}`, name: a.name, mimeType: a.mediaType } }] : [],
        });
        break;
      }
      case "decision.resolved":
        await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${prefix}decision: ${e.payload.choice} (${e.payload.source})\n` } });
        break;
      case "run.failed":
        await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${prefix}run failed: ${e.payload.error.message}\n` } });
        break;
      default:
        break;
    }
  }

  private async sendPlan(ctx: acp.AgentRequestContext<acp.PromptRequest>, session: FacadeSession, def: WorkflowDefinition, state: RunState): Promise<void> {
    const latest = new Map<string, RunState["steps"][string]>();
    for (const id of state.stepOrder) latest.set(state.steps[id]!.nodeId, state.steps[id]!);
    const entries: acp.PlanEntry[] = Object.entries(def.nodes)
      .filter(([, n]) => n.type !== "start" && n.type !== "end")
      .map(([id, n]) => {
        const s = latest.get(id);
        const status: acp.PlanEntryStatus = !s ? "pending" : s.status === "completed" ? "completed" : s.status === "failed" || s.status === "cancelled" || s.status === "skipped" ? "pending" : "in_progress";
        return { content: `${n.name ?? id}${s?.result?.choice ? ` → ${s.result.choice}` : ""}`, priority: n.type === "gate" ? "high" : "medium", status };
      });
    await ctx.client.notify(acp.methods.client.session.update, { sessionId: session.id, update: { sessionUpdate: "plan", entries } });
  }
}

/** Serve ORCA as an ACP agent on stdio (used by `orca acp`). */
export async function serveAcpFacade(opts: OrcaAcpAgentOptions, io: { stdin?: Readable; stdout?: Writable } = {}): Promise<void> {
  const stream = acp.ndJsonStream(Writable.toWeb(io.stdout ?? process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(io.stdin ?? process.stdin) as ReadableStream<Uint8Array>);
  const conn = new OrcaAcpAgent(opts).register(acp.agent({ name: "orca" })).connect(stream);
  await conn.closed;
}
