/**
 * ORCA as an ACP *agent* (proxy mode).
 *
 * Any ACP client - GitKraken Kepler, Zed, an IDE - can launch `orca
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
 *
 * The two commands are advertised as ACP `available_commands_update` after
 * `session/new`, and an unknown `/word` answers with that list instead of
 * becoming a Request.
 */
import type { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { stdioAcpStream } from "@orca/agents";
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
  active?: { runId: string };
  lastPlan?: string;
  /** The workflow `/run` defaults to, once a client has selected one (#188). */
  workflowId?: string;
}

/** The facade's slash commands, as ACP advertises them. */
export function facadeCommands(defaultWorkflowId?: string): acp.AvailableCommand[] {
  return [
    {
      name: "run",
      description: "Run a workflow directly in this session's working directory",
      input: { hint: `${defaultWorkflowId ?? "<workflowId>"} [key=value ...]` },
    },
    { name: "status", description: "Summarise the runs started in this session" },
  ];
}

const commandList = (defaultWorkflowId?: string): string =>
  facadeCommands(defaultWorkflowId)
    .map((c) => `- /${c.name}${c.input && "hint" in c.input ? ` ${c.input.hint}` : ""}: ${c.description}`)
    .join("\n");

export class OrcaAcpAgent {
  private readonly sessions = new Map<string, FacadeSession>();
  private readonly humanInput: UpstreamHumanInput;
  constructor(private readonly opts: OrcaAcpAgentOptions) {
    const orchestrator = opts.orchestrator;
    this.humanInput =
      opts.humanInput ??
      new UpstreamHumanInput({
        fallback: orchestrator.humanInput,
        parentRunId: async (runId) => {
          try {
            return (await orchestrator.getState(runId)).run.parentRunId;
          } catch {
            return undefined;
          }
        },
      });
    orchestrator.humanInput = this.humanInput;
  }

  register(app: acp.AgentApp): acp.AgentApp {
    return app
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        agentInfo: { name: this.opts.name ?? "orca", version: this.opts.version ?? "0.1.0" },
      }))
      .onRequest(acp.methods.agent.authenticate, () => ({}))
      .onRequest(acp.methods.agent.session.new, (ctx) => {
        const id = newId("sess");
        const session: FacadeSession = { id, cwd: ctx.params.cwd, runIds: [] };
        this.sessions.set(id, session);
        // After the response, so the client knows the session the update names.
        setImmediate(() => void this.sendCommands(ctx.client, session).catch(() => undefined));
        return { sessionId: id };
      })
      .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
        const s = this.sessions.get(ctx.params.sessionId);
        if (s?.active) await this.opts.orchestrator.cancel(s.active.runId, "cancelled by client");
      })
      .onRequest(acp.methods.agent.session.prompt, (ctx) => this.prompt(ctx));
  }

  /** Advertise `/run` and `/status`; called after `session/new` and whenever the session's workflow changes. */
  private async sendCommands(client: acp.AgentContext, session: FacadeSession): Promise<void> {
    await client.notify(acp.methods.client.session.update, {
      sessionId: session.id,
      update: { sessionUpdate: "available_commands_update", availableCommands: facadeCommands(session.workflowId) },
    });
  }

  private async prompt(ctx: acp.AgentRequestContext<acp.PromptRequest>): Promise<acp.PromptResponse> {
    const session = this.sessions.get(ctx.params.sessionId);
    if (!session) throw acp.RequestError.invalidParams({ sessionId: ctx.params.sessionId, reason: "unknown session" });
    const text = ctx.params.prompt
      .map((b) => (b.type === "text" ? b.text : b.type === "resource" && "text" in b.resource ? b.resource.text : ""))
      .join("\n")
      .trim();
    const say = (t: string) =>
      ctx.client.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } },
      });

    if (text === "/status" || text.startsWith("/status ")) {
      const states = await Promise.all(session.runIds.map((id) => this.opts.orchestrator.getState(id)));
      await say(
        states.length
          ? states
              .map(
                (s) => `- ${s.run.id} ${s.run.workflowId}: ${s.run.status}${s.run.outcome ? `/${s.run.outcome}` : ""}`,
              )
              .join("\n") + "\n"
          : "No runs in this session yet.\n",
      );
      return { stopReason: "end_turn" };
    }

    const command = /^\/(\S+)/.exec(text)?.[1];
    // `/run k=v` (no id) falls back to the session's selected workflow, when there is one.
    const runArgs = command === "run" ? text.split(/\s+/).slice(1) : [];
    const named = runArgs[0] !== undefined && !runArgs[0].includes("=") ? runArgs.shift() : undefined;
    const runWorkflowId = named ?? session.workflowId;
    if (command !== undefined && (command !== "run" || !runWorkflowId)) {
      await say(
        `${command === "run" ? "/run needs a workflow id." : `Unknown command /${command}.`} Available commands:\n${commandList(session.workflowId)}\n`,
      );
      return { stopReason: "end_turn" };
    }

    const orchestrator = this.opts.orchestrator;
    const workspace =
      this.opts.useClientCwd === false ? undefined : { hostId: "local", cwd: session.cwd, provider: "acp-client" };
    let runId: string;
    if (command === "run" && runWorkflowId) {
      const vars: Record<string, unknown> = {};
      for (const kv of runArgs) {
        const [k, ...v] = kv.split("=");
        if (k) vars[k] = v.join("=");
      }
      runId = await orchestrator.startRun({ workflowId: runWorkflowId, vars, ...(workspace ? { workspace } : {}) });
    } else {
      const [title, ...body] = text.split("\n");
      const submitted = await this.opts.program.submit({
        title: title || "Untitled request",
        body: body.join("\n").trim(),
        source: { kind: "acp-session", sessionId: session.id },
      });
      runId = submitted.runId;
    }
    session.runIds.push(runId);
    session.active = { runId };
    delete session.lastPlan;
    // Bound per run, so concurrent sessions each receive only their own gates and `ask` permissions.
    const unbindHumanInput = this.humanInput.bind(runId, {
      sessionId: session.id,
      request: (m, p) => ctx.client.request(m, p),
    });

    const state0 = await orchestrator.getState(runId);
    const def = orchestrator.resolveDefinition(state0.run.workflowId);
    await say(`Starting ${def.name} (run ${runId}) in ${session.cwd}\n`);
    // Preserve event order and drain forwarding before publishing the final snapshot.
    let forwarding = Promise.resolve();
    const unsubscribe = orchestrator.subscribe((e) => {
      forwarding = forwarding.then(() => this.forward(ctx, session, runId, e)).catch(() => undefined);
    });
    try {
      const final = await orchestrator.run(runId);
      await this.opts.program.settle(final);
      await forwarding;
      await this.sendPlan(ctx, session, def, final);
      await say(
        `\nRun ${runId} ${final.run.status}${final.run.outcome ? ` (${final.run.outcome})` : ""}${final.run.error ? `: ${final.run.error.message}` : ""}\n`,
      );
      return { stopReason: final.run.status === "cancelled" ? "cancelled" : "end_turn" };
    } finally {
      unsubscribe();
      unbindHumanInput();
      delete session.active;
    }
  }

  /** Translate ORCA events (root run and its descendants) into ACP session updates. */
  private async forward(
    ctx: acp.AgentRequestContext<acp.PromptRequest>,
    session: FacadeSession,
    rootRunId: string,
    e: OrcaEvent,
  ): Promise<void> {
    const orchestrator = this.opts.orchestrator;
    const notify = (update: acp.SessionUpdate) =>
      ctx.client.notify(acp.methods.client.session.update, { sessionId: session.id, update });
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
      case "step.failed": {
        const root = await orchestrator.getState(rootRunId);
        await this.sendPlan(ctx, session, orchestrator.resolveDefinition(root.run.workflowId), root);
        if (!isRoot && e.type === "step.scheduled")
          await notify({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `${prefix}▶ ${e.payload.nodeId}\n` },
          });
        break;
      }
      case "agent.update": {
        const u = e.payload.update;
        if (u.kind === "agent_message_chunk" && u.text)
          await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${prefix}${u.text}` } });
        else if (u.kind === "tool_call" && u.toolCallId)
          await notify({
            sessionUpdate: "tool_call",
            toolCallId: `${e.runId}:${u.toolCallId}`,
            title: `${prefix}${u.title ?? ""}`,
            kind: (u.toolKind as acp.ToolKind | undefined) ?? "other",
            status: (u.status as acp.ToolCallStatus | undefined) ?? "in_progress",
            locations: (u.locations ?? []).map((path) => ({ path })),
          });
        else if (u.kind === "tool_call_update" && u.toolCallId)
          await notify({
            sessionUpdate: "tool_call_update",
            toolCallId: `${e.runId}:${u.toolCallId}`,
            ...(u.status ? { status: u.status as acp.ToolCallStatus } : {}),
          });
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
          content: a.path
            ? [
                {
                  type: "content",
                  content: { type: "resource_link", uri: `file://${a.path}`, name: a.name, mimeType: a.mediaType },
                },
              ]
            : [],
        });
        break;
      }
      case "decision.resolved":
        await notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${prefix}decision: ${e.payload.choice} (${e.payload.source})\n` },
        });
        break;
      case "run.failed":
        await notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${prefix}run failed: ${e.payload.error.message}\n` },
        });
        break;
      default:
        break;
    }
  }

  private async sendPlan(
    ctx: acp.AgentRequestContext<acp.PromptRequest>,
    session: FacadeSession,
    def: WorkflowDefinition,
    state: RunState,
  ): Promise<void> {
    const entries = await this.planEntries(def, state);
    const snapshot = JSON.stringify(entries);
    if (session.lastPlan === snapshot) return;
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: session.id,
      update: { sessionUpdate: "plan", entries },
    });
    session.lastPlan = snapshot;
  }

  /** Flatten the run tree under the container node that owns each child run. */
  private async planEntries(
    def: WorkflowDefinition,
    state: RunState,
    workflowPath: string[] = [],
    seen = new Set<string>(),
  ): Promise<acp.PlanEntry[]> {
    if (seen.has(state.run.id)) return [];
    seen.add(state.run.id);

    const latest = new Map<string, RunState["steps"][string]>();
    const visits = new Map<string, RunState["steps"][string][]>();
    for (const stepRunId of state.stepOrder) {
      const step = state.steps[stepRunId]!;
      latest.set(step.nodeId, step);
      const nodeVisits = visits.get(step.nodeId) ?? [];
      nodeVisits.push(step);
      visits.set(step.nodeId, nodeVisits);
    }

    const entries: acp.PlanEntry[] = [];
    for (const [id, node] of Object.entries(def.nodes)) {
      if (node.type === "start" || node.type === "end") continue;
      const step = latest.get(id);
      const status: acp.PlanEntryStatus = !step
        ? "pending"
        : step.status === "completed" || ["failed", "cancelled", "skipped"].includes(step.status)
          ? "completed"
          : "in_progress";
      const prefix = workflowPath.length ? `[${workflowPath.join(" › ")}] ` : "";
      entries.push({
        content: `${prefix}${node.name ?? id}${step?.result?.choice ? ` → ${step.result.choice}` : ""}${step && ["failed", "cancelled", "skipped"].includes(step.status) ? ` → ${step.status}` : ""}`,
        priority: node.type === "gate" ? "high" : "medium",
        status,
      });

      for (const visit of visits.get(id) ?? []) {
        for (const childRunId of visit.childRunIds) {
          const child = await this.opts.orchestrator.getState(childRunId);
          entries.push(
            ...(await this.planEntries(
              this.opts.orchestrator.resolveDefinition(child.run.workflowId),
              child,
              [...workflowPath, child.run.workflowId],
              seen,
            )),
          );
        }
      }
    }
    return entries;
  }
}

/** Serve ORCA as an ACP agent on stdio (used by `orca acp`). */
export async function serveAcpFacade(
  opts: OrcaAcpAgentOptions,
  io: { stdin?: Readable; stdout?: Writable } = {},
): Promise<void> {
  const stream = stdioAcpStream(io.stdin ?? process.stdin, io.stdout ?? process.stdout);
  const conn = new OrcaAcpAgent(opts).register(acp.agent({ name: "orca" })).connect(stream);
  await conn.closed;
}
