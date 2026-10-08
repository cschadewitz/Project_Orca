/** Memory-only failure evidence: closed stage names, bounded elapsed times, no request or error content. */
const rpcStages = {
  hello: "rpc.hello",
  "runs.admit": "rpc.admission",
  "operator.admitRun": "rpc.admission",
  "operator.submitRequest": "rpc.admission",
  "operator.admission": "rpc.admission",
  "operator.reconcileAdmission": "rpc.admission",
  "inputs.revise": "rpc.revision",
  "inputs.replaceRevision": "rpc.revision",
  "operator.revise": "rpc.revision",
  "runs.continue": "rpc.continuation",
  "continuations.get": "rpc.continuation",
  "operator.continueRun": "rpc.continuation",
  "operator.continuation": "rpc.continuation",
  "operator.reconcileContinuation": "rpc.continuation",
  "inputs.list": "rpc.inputs",
  "inputs.answer": "rpc.inputs",
  "operator.answer": "rpc.inputs",
  "runs.events": "rpc.events",
  "runs.get": "rpc.read",
  "operator.page": "rpc.read",
} as const;
const toolStages = {
  discover_orca: "mcp.discovery",
  start_workflow: "mcp.admission",
  submit_request: "mcp.admission",
  get_admission: "mcp.admission",
  reconcile_admission: "mcp.admission",
  revise_input: "mcp.revision",
  continue_run: "mcp.continuation",
  get_continuation: "mcp.continuation",
  reconcile_continuation: "mcp.continuation",
  respond_to_approval: "mcp.inputs",
  cancel_run: "mcp.cancel",
} as const;
export const rpcStage = (method: string) =>
  Object.hasOwn(rpcStages, method) ? rpcStages[method as keyof typeof rpcStages] : "rpc.other";
export const toolStage = (name: string) =>
  Object.hasOwn(toolStages, name) ? toolStages[name as keyof typeof toolStages] : "mcp.read";
type Stage =
  | ReturnType<typeof rpcStage>
  | ReturnType<typeof toolStage>
  | "daemon.boot"
  | "daemon.stop"
  | "credential.issue"
  | "credential.revoke"
  | "mcp.connect"
  | "wait.input"
  | "wait.waiting"
  | "wait.succeeded"
  | "wait.cancelled"
  | "wait.boundary";
const elapsed = (at: number) => Math.min(3_600_000, Math.max(0, Math.round(performance.now() - at)));

export class FixtureProgress {
  private readonly active = new Map<object, { stage: Stage; at: number }>();
  private readonly recent: { stage: Stage; elapsedMs: number; outcome: "settled" | "rejected" }[] = [];
  private truncated = false;

  async measure<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
    const key = {};
    const at = performance.now();
    if (this.active.size < 16) this.active.set(key, { stage, at });
    else this.truncated = true;
    let outcome: "settled" | "rejected" = "rejected";
    try {
      const value = await work();
      outcome = "settled";
      return value;
    } finally {
      this.active.delete(key);
      if (this.recent.length === 16) {
        this.recent.shift();
        this.truncated = true;
      }
      this.recent.push({ stage, elapsedMs: elapsed(at), outcome });
    }
  }

  snapshot() {
    return {
      active: Array.from(this.active.values(), ({ stage, at }) => ({ stage, elapsedMs: elapsed(at) })),
      recent: this.recent.map((entry) => ({ ...entry })),
      truncated: this.truncated,
    };
  }
}
