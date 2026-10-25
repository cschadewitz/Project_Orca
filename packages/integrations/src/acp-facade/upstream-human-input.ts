/**
 * Routes ORCA's human questions (gate decisions, `ask` permissions) to the
 * upstream ACP client that launched ORCA as an agent - Kepler, Zed or
 * any other ACP host. ACP only has `session/request_permission`, so decision
 * options are mapped onto permission options: the first option is presented
 * as "allow", the rest as "reject" variants, all carrying their real labels.
 * Permission asks instead require the exact original ACP kinds supplied in-process.
 *
 * Targets are bound per run, not globally: every ACP prompt binds the run it
 * started to its own session, and a question is routed by the `runId` it
 * carries. Questions raised inside child runs (sub-workflows, parallel
 * branches) walk up `parentRunId` until they reach a bound ancestor, so
 * concurrent sessions never see each other's gates.
 */
import * as acp from "@agentclientprotocol/sdk";
import { HumanInputPending, type HumanInputPort, type HumanInputQuery } from "@orca/engine";

export interface UpstreamTarget {
  sessionId: string;
  /** Typed like the SDK's `ctx.client.request`, so built-in method constants infer their params and response. */
  request: <M extends acp.ClientRequestMethod>(
    method: M,
    params: acp.ClientRequestParamsByMethod[M],
  ) => Promise<acp.ClientRequestResponsesByMethod[M]>;
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
    // Live decisions use the authenticated owner-local answer path. An upstream
    // ACP option alone supplies neither current principal nor invocation identity.
    if (q.live) return this.fallback?.ask(q);
    // Permission semantics come only from the original callback, never from position,
    // labels, destructive hints or context. Refuse malformed metadata without making
    // up choices or falling through to an answerer that could choose one.
    const permissionOptions = q.kind === "permission" ? originalPermissionOptions(q) : undefined;
    if (q.kind === "permission" && (!permissionOptions || q.signal?.aborted)) return undefined;
    const t = await this.targetFor(q.runId);
    if (!t) return this.fallback?.ask(q);
    // `optionId` carries our option's id, so `res.outcome.optionId` comes straight back
    // as the recorded answer; the consequence clause, when there is one, rides along in
    // the name because ACP has nowhere else to put it.
    const options: acp.PermissionOption[] =
      permissionOptions ??
      (q.options.length ? q.options : [{ id: "ok", label: "ok" }]).map((o, i) => ({
        optionId: o.id,
        name: o.consequence ? `${o.label} - ${o.consequence}` : o.label,
        kind: i === 0 ? "allow_once" : "reject_once",
      }));
    const toolCall: acp.ToolCallUpdate = {
      toolCallId: q.requestId,
      title: `[orca ${q.kind}] ${q.question}`,
      kind: "switch_mode",
      status: "pending",
      rawInput: q.context,
    };
    let res: acp.RequestPermissionResponse;
    try {
      res = await t.request(acp.methods.client.session.requestPermission, {
        sessionId: t.sessionId,
        toolCall,
        options,
      });
    } catch {
      return this.disconnected(q);
    }
    if (q.signal?.aborted || (await this.targetFor(q.runId)) !== t) return this.disconnected(q);
    const outcome = res.outcome;
    if (outcome.outcome !== "selected") return undefined;
    if (q.kind === "permission" && !options.some((o) => o.optionId === outcome.optionId)) return undefined;
    return outcome.optionId;
  }

  recordsAnswer(q: HumanInputQuery): boolean {
    return Boolean(q.live && this.fallback?.recordsAnswer?.(q));
  }

  private disconnected(q: HumanInputQuery): Promise<string | undefined> {
    if (q.kind !== "permission") return Promise.reject(new HumanInputPending(q));
    if (this.fallback) return this.fallback.ask(q);
    return Promise.resolve(undefined);
  }
}

/** Validate a complete, unambiguous source pairing before advertising any permission. */
function originalPermissionOptions(q: HumanInputQuery): acp.PermissionOption[] | undefined {
  const source = q.permissionOptions;
  if (!Array.isArray(source) || source.length === 0 || source.length !== q.options.length) return undefined;
  const ids = new Set<string>();
  for (const [i, option] of q.options.entries()) {
    const original = source[i];
    if (
      !original ||
      original.optionId !== option.id ||
      !option.id ||
      ids.has(option.id) ||
      !["allow_once", "allow_always", "reject_once", "reject_always"].includes(original.kind)
    )
      return undefined;
    ids.add(option.id);
  }
  return q.options.map((o, i) => ({ optionId: o.id, name: o.label, kind: source[i]!.kind }));
}
