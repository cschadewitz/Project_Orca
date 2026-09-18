/**
 * Routes ORCA's human questions (gate decisions, `ask` permissions) to the
 * upstream ACP client that launched ORCA as an agent - Kepler, Zed or
 * any other ACP host. ACP only has `session/request_permission`, so decision
 * options are mapped onto permission options: the first option is presented
 * as "allow", the rest as "reject" variants, all carrying their real labels.
 *
 * Targets are bound per run, not globally: every ACP prompt binds the run it
 * started to its own session, and a question is routed by the `runId` it
 * carries. Questions raised inside child runs (sub-workflows, parallel
 * branches) walk up `parentRunId` until they reach a bound ancestor, so
 * concurrent sessions never see each other's gates.
 */
import * as acp from "@agentclientprotocol/sdk";
import type { HumanInputPort, HumanInputQuery } from "@orca/engine";

export interface UpstreamTarget {
  sessionId: string;
  /** Typed like the SDK's `ctx.client.request`, so built-in method constants infer their params and response. */
  request: <M extends acp.ClientRequestMethod>(method: M, params: acp.ClientRequestParamsByMethod[M]) => Promise<acp.ClientRequestResponsesByMethod[M]>;
}

export interface UpstreamHumanInputOptions {
  /** Answers questions for runs no session is bound to (e.g. runs started outside ACP). */
  fallback?: HumanInputPort;
  /** Resolves a run's parent run id (undefined for a root run or an unknown run). */
  parentRunId?: (runId: string) => Promise<string | undefined>;
}

export class UpstreamHumanInput implements HumanInputPort {
  private readonly targets = new Map<string, UpstreamTarget>();
  private readonly fallback: HumanInputPort | undefined;
  private readonly parentRunId: ((runId: string) => Promise<string | undefined>) | undefined;
  constructor(opts: UpstreamHumanInputOptions = {}) {
    this.fallback = opts.fallback;
    this.parentRunId = opts.parentRunId;
  }

  /** Route questions from `runId` (and its descendants) to `target`. Returns the matching unbind. */
  bind(runId: string, target: UpstreamTarget): () => void {
    this.targets.set(runId, target);
    return () => this.unbind(runId, target);
  }

  /** Remove the binding for `runId`; with `target` given, only if it is still the bound one. */
  unbind(runId: string, target?: UpstreamTarget): void {
    if (target && this.targets.get(runId) !== target) return;
    this.targets.delete(runId);
  }

  /** The session a question from `runId` would be routed to, if any. */
  async targetFor(runId: string): Promise<UpstreamTarget | undefined> {
    const seen = new Set<string>();
    let id: string | undefined = runId;
    while (id && !seen.has(id)) {
      const target = this.targets.get(id);
      if (target) return target;
      seen.add(id);
      id = this.parentRunId ? await this.parentRunId(id) : undefined;
    }
    return undefined;
  }

  async ask(q: HumanInputQuery): Promise<string | undefined> {
    const t = await this.targetFor(q.runId);
    if (!t) return this.fallback?.ask(q);
    const options: acp.PermissionOption[] = (q.options.length ? q.options : ["ok"]).map((o, i) => ({ optionId: o, name: o, kind: i === 0 ? "allow_once" : "reject_once" }));
    const toolCall: acp.ToolCallUpdate = { toolCallId: q.requestId, title: `[orca ${q.kind}] ${q.question}`, kind: "switch_mode", status: "pending", rawInput: q.context };
    const res = await t.request(acp.methods.client.session.requestPermission, { sessionId: t.sessionId, toolCall, options });
    const outcome = res.outcome;
    return outcome.outcome === "selected" ? outcome.optionId : undefined;
  }
}
