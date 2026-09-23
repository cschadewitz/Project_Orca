/**
 * A deterministic ACP agent for tests and demos. On every prompt it:
 *  1. parses the ORCA deliverables block from the prompt,
 *  2. streams a few session/update notifications (message chunks, tool calls),
 *  3. writes each deliverable from its playbook straight to disk,
 *  4. returns `end_turn` (or `cancelled` when the client cancelled the turn;
 *     deliverables not yet written at that point are skipped).
 * It keeps a small state file so per-kind counters survive across processes
 * (ORCA opens a fresh process per step by default).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import {
  appendJsonl,
  configOptionValues,
  parseDeliverablesBlock,
  serializeFrontMatter,
  type SessionConfigOption,
} from "@orca/core";
import type { Playbook, PlaybookEntry } from "./playbook.js";

export interface ScriptedAgentOptions {
  playbook: Playbook;
  /** JSON file holding per-kind counters. */
  stateFile?: string;
  /** JSONL file where every prompt is appended (for test assertions). */
  promptLog?: string;
  name?: string;
}

interface State {
  counts: Record<string, number>;
}

interface SessionState {
  cwd: string;
  turns: number;
  /** Set by `session/cancel`; checked before every write so a cancelled turn stops early. */
  cancelled: boolean;
  /** This session's copy of the playbook's config options. */
  configOptions: SessionConfigOption[];
  /** Wakes the sleeping turn so cancellation is honoured promptly. */
  wake?: () => void;
}

/** Sleep that returns early when the session is cancelled. */
const sleep = (ms: number, session: SessionState) =>
  ms > 0 && !session.cancelled
    ? new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          if (session.wake === done) delete session.wake;
          resolve();
        }
        session.wake = done;
      })
    : Promise.resolve();

export class ScriptedAgent {
  private readonly sessions = new Map<string, SessionState>();
  constructor(private readonly opts: ScriptedAgentOptions) {}

  register(app: acp.AgentApp): acp.AgentApp {
    return app
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: this.opts.name ?? "orca-scripted-agent", version: "0.1.0" },
      }))
      .onRequest(acp.methods.agent.authenticate, () => ({}))
      .onRequest(acp.methods.agent.session.new, (ctx) => {
        const sessionId = randomUUID();
        const advertised = this.opts.playbook.configOptions;
        const configOptions = advertised ? structuredClone(advertised) : [];
        this.sessions.set(sessionId, { cwd: ctx.params.cwd, turns: 0, cancelled: false, configOptions });
        return advertised ? { sessionId, configOptions: toWire(configOptions) } : { sessionId };
      })
      .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => this.setConfigOption(ctx.params))
      .onNotification(acp.methods.agent.session.cancel, (ctx) => {
        const session = this.sessions.get(ctx.params.sessionId);
        if (!session) return;
        session.cancelled = true;
        session.wake?.();
      })
      .onRequest(acp.methods.agent.session.prompt, (ctx) => this.prompt(ctx));
  }

  /**
   * Update one option's `currentValue` and answer with the full list, as ACP requires. The set
   * is appended to the prompt log as `{sessionId, configId, value}` so a test can assert it
   * arrived. An unknown option, a value the select does not offer, or a type mismatch is refused.
   */
  private async setConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const { sessionId, configId, value } = params;
    const session = this.sessions.get(sessionId);
    if (!session) throw acp.RequestError.invalidParams({ sessionId, reason: "unknown session" });
    const option = session.configOptions.find((o) => o.id === configId);
    if (!option) throw acp.RequestError.invalidParams({ configId, reason: "unknown config option" });
    if (option.type === "boolean") {
      if (typeof value !== "boolean") throw acp.RequestError.invalidParams({ configId, reason: "expected a boolean" });
      option.currentValue = value;
    } else {
      if (typeof value !== "string" || !configOptionValues(option).some((o) => o.value === value)) {
        throw acp.RequestError.invalidParams({ configId, value, reason: "value not offered" });
      }
      option.currentValue = value;
    }
    if (this.opts.promptLog) {
      await mkdir(dirname(this.opts.promptLog), { recursive: true });
      await appendJsonl(this.opts.promptLog, { sessionId, configId, value });
    }
    return { configOptions: toWire(session.configOptions) };
  }

  private async loadState(): Promise<State> {
    if (!this.opts.stateFile) return { counts: {} };
    try {
      return JSON.parse(await readFile(this.opts.stateFile, "utf8")) as State;
    } catch {
      return { counts: {} };
    }
  }
  private async saveState(s: State): Promise<void> {
    if (!this.opts.stateFile) return;
    await mkdir(dirname(this.opts.stateFile), { recursive: true });
    await writeFile(this.opts.stateFile, JSON.stringify(s), "utf8");
  }

  private pick(kind: string, n: number): PlaybookEntry {
    const list = this.opts.playbook.kinds[kind];
    if (!list || list.length === 0) return this.opts.playbook.default;
    return list[Math.min(n - 1, list.length - 1)]!;
  }

  private async prompt(ctx: acp.AgentRequestContext<acp.PromptRequest>): Promise<acp.PromptResponse> {
    const { sessionId, prompt } = ctx.params;
    const session = this.sessions.get(sessionId);
    if (!session) throw acp.RequestError.invalidParams({ sessionId, reason: "unknown session" });
    session.turns++;
    session.cancelled = false;
    const text = prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
    if (this.opts.promptLog) {
      await mkdir(dirname(this.opts.promptLog), { recursive: true });
      await appendJsonl(this.opts.promptLog, { sessionId, turn: session.turns, cwd: session.cwd, text });
    }
    const say = (t: string) =>
      ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } },
      });
    const delay = this.opts.playbook.delayMs;

    await say(this.opts.playbook.greeting + "\n");
    const deliverables = parseDeliverablesBlock(text);
    if (deliverables.length === 0) {
      await say("No deliverables block found; nothing to do.\n");
      return { stopReason: "end_turn" };
    }
    const state = await this.loadState();
    let stopReason: acp.StopReason = "end_turn";

    for (const d of deliverables) {
      const n = (state.counts[d.kind] ?? 0) + 1;
      const entry = this.pick(d.kind, n);
      if (entry.hang) {
        // A deadlocked agent: no response, no reaction to session/cancel. Only a kill ends this.
        await say(`Hanging on ${d.kind} (playbook says hang).\n`);
        await new Promise<never>(() => {});
      }
      if (entry.setConfig) {
        const option = session.configOptions.find((o) => o.id === entry.setConfig!.configId);
        const value = entry.setConfig.value;
        if (option) {
          if (option.type === "boolean" && typeof value === "boolean") option.currentValue = value;
          if (option.type === "select" && typeof value === "string") option.currentValue = value;
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: toWire(session.configOptions) },
          });
        }
      }
      await sleep(entry.delayMs ?? delay, session);
      if (session.cancelled) {
        // Leave the counter alone: the entry was never consumed, so a follow-up turn replays it.
        await say(`Turn cancelled by the client before writing ${d.kind}.\n`);
        stopReason = "cancelled";
        break;
      }
      state.counts[d.kind] = n;
      if (entry.say) await say(entry.say + "\n");
      if (entry.skip) {
        await say(`Skipping ${d.kind} (playbook says skip).\n`);
        continue;
      }
      const toolCallId = `write-${d.kind}-${n}`;
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: `Write ${d.kind} to ${d.path}`,
          kind: "edit",
          status: "in_progress",
          locations: [{ path: d.path }],
        },
      });
      if (entry.askPermission) {
        const permissionPath = entry.permissionPath ?? d.path;
        const res = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId,
            title: `Write ${permissionPath}`,
            kind: "edit",
            locations: [{ path: permissionPath }],
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        if (res.outcome.outcome !== "selected" || res.outcome.optionId !== "allow") {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed" },
          });
          await say(`Permission denied for ${d.path}.\n`);
          continue;
        }
      }
      const content = renderEntry(entry, { kind: d.kind, path: d.path, n, prompt: text });
      await mkdir(dirname(d.path), { recursive: true });
      await writeFile(d.path, content, "utf8");
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
      });
      await say(`Wrote ${d.kind} (${content.length} chars) to ${d.path}\n`);
      if (entry.stopReason) stopReason = entry.stopReason;
    }
    await this.saveState(state);
    return { stopReason };
  }
}

/** A copy in the SDK's wire shape; the JSON round trip drops the keys zod leaves `undefined`. */
function toWire(options: SessionConfigOption[]): acp.SessionConfigOption[] {
  return JSON.parse(JSON.stringify(options)) as acp.SessionConfigOption[];
}

function renderEntry(entry: PlaybookEntry, vars: { kind: string; path: string; n: number; prompt: string }): string {
  const sub = (s: string) => s.replace(/\{(kind|path|n|prompt)\}/g, (_, k: keyof typeof vars) => String(vars[k]));
  if (entry.content !== undefined) return sub(entry.content);
  const body = sub(entry.body ?? `# ${vars.kind}\n\nGenerated by the scripted agent (occurrence ${vars.n}).\n`);
  return serializeFrontMatter({ data: { status: "done", ...(entry.data ?? {}) }, body });
}
