/**
 * Routes ORCA's human questions (gate decisions, `ask` permissions) to the
 * upstream ACP client that launched ORCA as an agent - Kepler, Zed, T3 Code or
 * any other ACP host. ACP only has `session/request_permission`, so decision
 * options are mapped onto permission options: the first option is presented
 * as "allow", the rest as "reject" variants, all carrying their real labels.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { HumanInputPort, HumanInputQuery } from "@orca/engine";

export interface UpstreamTarget {
  sessionId: string;
  request: (method: string, params?: unknown) => Promise<unknown>;
}

export class UpstreamHumanInput implements HumanInputPort {
  private target: UpstreamTarget | undefined;
  private readonly fallback: HumanInputPort | undefined;
  constructor(fallback?: HumanInputPort) {
    this.fallback = fallback;
  }
  bind(target: UpstreamTarget | undefined): void {
    this.target = target;
  }
  async ask(q: HumanInputQuery): Promise<string | undefined> {
    const t = this.target;
    if (!t) return this.fallback?.ask(q);
    const options: acp.PermissionOption[] = (q.options.length ? q.options : ["ok"]).map((o, i) => ({ optionId: o, name: o, kind: i === 0 ? "allow_once" : "reject_once" }));
    const toolCall: acp.ToolCallUpdate = { toolCallId: q.requestId, title: `[orca ${q.kind}] ${q.question}`, kind: "switch_mode", status: "pending", rawInput: q.context };
    const res = await t.request("session/request_permission", { sessionId: t.sessionId, toolCall, options } satisfies acp.RequestPermissionRequest);
    const outcome = (res as acp.RequestPermissionResponse).outcome;
    return outcome.outcome === "selected" ? outcome.optionId : undefined;
  }
}
