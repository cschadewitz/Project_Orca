/** Executors for start, end, set, decision and gate nodes. */
import { newId, OrcaError, type DecisionNode, type EndNode, type GateNode, type SetNode, type StartNode } from "@orca/core";
import { runAgentTurn } from "./agent-step.js";
import { completed, failed, type NodeExecutor, type StepContext } from "./types.js";

export const startExecutor: NodeExecutor<StartNode> = {
  type: "start",
  execute: async () => completed(),
};

export const endExecutor: NodeExecutor<EndNode> = {
  type: "end",
  execute: async (ctx) => completed({ outcome: ctx.node.outcome }),
};

/** Values starting with "=" are expressions; anything else is a literal. */
export const setExecutor: NodeExecutor<SetNode> = {
  type: "set",
  async execute(ctx) {
    const vars: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx.node.vars)) vars[k] = typeof v === "string" && v.startsWith("=") ? await ctx.evaluate(v.slice(1)) : v;
    await ctx.emit({ type: "vars.set", payload: { vars } });
    return completed({ data: vars });
  },
};

async function resolveChoice(ctx: StepContext & { node: DecisionNode }): Promise<{ raw: unknown; source: string }> {
  const s = ctx.node.source;
  switch (s.kind) {
    case "expression":
      return { raw: await ctx.evaluate(s.expr), source: "expression" };
    case "artifact": {
      const a = (await ctx.resolveInputs([{ name: s.artifact, required: false }, { kind: s.artifact, required: false }])).find((r) => r !== undefined);
      if (!a) throw new OrcaError("ARTIFACT_MISSING", `decision '${ctx.nodeId}' needs artifact '${s.artifact}'`);
      return { raw: a.data[s.field], source: `artifact:${a.name}.${s.field}` };
    }
    case "agent": {
      const produces = s.produces ?? { kind: "decision", path: `.orca/runs/${ctx.run.id}/${ctx.nodeId}-decision.md`, required: true };
      const turn = await runAgentTurn(ctx, {
        agent: s.agent,
        ...(s.template ? { template: s.template } : {}),
        ...(s.prompt ? { prompt: s.prompt } : {}),
        inputs: s.inputs,
        produces: [{ ...produces, validate: { requiredFields: [s.field], fieldValues: { [s.field]: ctx.node.options } } }],
        completion: { mode: "turn-end", maxFollowUps: 1, maxAttempts: 1 },
        vars: { options: ctx.node.options },
      });
      if (turn.kind === "failed") throw new OrcaError(turn.error.code as "INTERNAL", turn.error.message, turn.error.details);
      const art = turn.artifacts[0];
      return { raw: art?.data[s.field], source: `agent:${art?.name ?? "decision"}` };
    }
    case "human": {
      const requestId = newId("hi", ctx.clock.now());
      await ctx.emit({ type: "human.requested", payload: { stepRunId: ctx.step.id, requestId, kind: "decision", question: s.question, options: ctx.node.options, context: {} } });
      await ctx.emit({ type: "step.waiting", payload: { stepRunId: ctx.step.id, on: "human-input", detail: requestId } });
      const answer = await ctx.humanInput.ask({ runId: ctx.run.id, stepRunId: ctx.step.id, requestId, kind: "decision", question: s.question, options: ctx.node.options, context: {} });
      await ctx.emit({ type: "human.answered", payload: { stepRunId: ctx.step.id, requestId, answer: answer ?? "" } });
      return { raw: answer, source: "human" };
    }
  }
}

export const decisionExecutor: NodeExecutor<DecisionNode> = {
  type: "decision",
  async execute(ctx) {
    const { raw, source } = await resolveChoice(ctx);
    let choice = typeof raw === "boolean" ? (raw ? "true" : "false") : raw === undefined || raw === null ? undefined : String(raw);
    if (choice === undefined || !ctx.node.options.includes(choice)) {
      if (!ctx.node.defaultOption) return failed("RUN_STATE", `decision '${ctx.nodeId}' produced '${String(choice)}' which is not one of ${ctx.node.options.join(", ")}`, { raw, source });
      choice = ctx.node.defaultOption;
    }
    await ctx.emit({ type: "decision.resolved", payload: { stepRunId: ctx.step.id, choice, source, raw } });
    return completed({ choice });
  },
};

export const gateExecutor: NodeExecutor<GateNode> = {
  type: "gate",
  async execute(ctx) {
    const n = ctx.node;
    if (n.autoApproveWhen && (await ctx.evaluate(n.autoApproveWhen))) {
      const choice = n.autoOption ?? n.options[0]!;
      await ctx.emit({ type: "decision.resolved", payload: { stepRunId: ctx.step.id, choice, source: "gate:auto" } });
      return completed({ choice });
    }
    const requestId = newId("hi", ctx.clock.now());
    const question = await ctx.render(n.question);
    await ctx.emit({ type: "human.requested", payload: { stepRunId: ctx.step.id, requestId, kind: "decision", question, options: n.options, context: {} } });
    await ctx.emit({ type: "step.waiting", payload: { stepRunId: ctx.step.id, on: "human-input", detail: requestId } });
    const answer = await ctx.humanInput.ask({ runId: ctx.run.id, stepRunId: ctx.step.id, requestId, kind: "decision", question, options: n.options, context: {} });
    await ctx.emit({ type: "human.answered", payload: { stepRunId: ctx.step.id, requestId, answer: answer ?? "" } });
    if (answer === undefined || !n.options.includes(answer)) return failed("CANCELLED", `gate '${ctx.nodeId}' was not approved (answer: ${String(answer)})`, {}, false);
    await ctx.emit({ type: "decision.resolved", payload: { stepRunId: ctx.step.id, choice: answer, source: "gate:human" } });
    return completed({ choice: answer });
  },
};
