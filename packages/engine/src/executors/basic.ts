/** Executors for start, end, set, decision and gate nodes. */
import {
  evaluateVars,
  OrcaError,
  type DecisionNode,
  type EndNode,
  type GateNode,
  type GateOptionInput,
  type SetNode,
  type StartNode,
} from "@orca/core";
import { askHumanInput, type HumanInputQuery } from "../human-input.js";
import { resolveMatrixChoice } from "../plan/executors.js";
import { runAgentTurn } from "./agent-step.js";
import { artifactFieldGet } from "./artifact-field.js";
import { completed, failed, type NodeExecutor, type StepContext } from "./types.js";

export const startExecutor: NodeExecutor<StartNode> = {
  type: "start",
  execute: async () => completed(),
};

export const endExecutor: NodeExecutor<EndNode> = {
  type: "end",
  // Any step whose result carries an `outcome` ends the run, so a custom terminal node needs no engine change.
  execute: async (ctx) =>
    completed({ outcome: ctx.node.outcome, ...(ctx.node.message ? { message: ctx.node.message } : {}) }),
};

/** Assign run vars; `=`-prefixed values are expressions (see evaluateVars). */
export const setExecutor: NodeExecutor<SetNode> = {
  type: "set",
  async execute(ctx) {
    const vars = await evaluateVars(ctx.node.vars, (expr) => ctx.evaluate(expr));
    await ctx.emit({ type: "vars.set", payload: { vars } });
    return completed({ data: vars });
  },
};

/**
 * Ask a human, or reuse the answer already recorded for this node's previous
 * attempt. In pause mode the port throws HumanInputPending: the run is parked
 * with the request pending, `orca answer` appends `human.answered`, and the
 * resumed run re-schedules the node as a new attempt, which lands here and
 * picks that answer up instead of asking again.
 */
export async function askHuman(
  ctx: StepContext,
  question: string,
  options: GateOptionInput[],
  kind: HumanInputQuery["kind"] = "decision",
): Promise<string | undefined> {
  const recorded = answerFromPreviousAttempt(ctx);
  if (recorded !== undefined) return recorded;
  const revision = (ctx.node.type === "gate" || ctx.node.type === "decision") && ctx.node.revision;
  if (revision && !ctx.declareRevision)
    throw new OrcaError("NOT_SUPPORTED", "revision-enabled gates require the protected revision runtime");
  return askHumanInput({
    ...(revision && ctx.declareRevision ? { onRequested: ctx.declareRevision } : {}),
    port: ctx.humanInput,
    emit: (e) => ctx.emit(e),
    clock: ctx.clock,
    runId: ctx.run.id,
    stepRunId: ctx.step.id,
    kind,
    question,
    options,
  });
}

/**
 * The ids of a decision's or a gate's options - the whole of what this file compares.
 *
 * Since #247 an option is `{ id, label, consequence?, destructive? }` and a bare word in a
 * workflow reads as an option that is its own id and label. Everything mechanical is the
 * id: the choice a source produced, `defaultOption`, `autoOption`, the `when: choice ==
 * '<option>'` on an outgoing edge, and the recorded `human.answered.answer`. The label is
 * for a person to read and may be reworded without invalidating any of them.
 */
function optionIds(node: DecisionNode | GateNode): string[] {
  return node.options.map((o) => o.id);
}

/** The answer given to the immediately preceding, cancelled attempt of this node (a resumed pause), if any. */
function answerFromPreviousAttempt(ctx: StepContext): string | undefined {
  const { stepOrder, steps, humanInputs } = ctx.run.state;
  const prev = steps[stepOrder[stepOrder.indexOf(ctx.step.id) - 1] ?? ""];
  if (!prev || prev.nodeId !== ctx.nodeId || prev.status !== "cancelled") return undefined;
  return Object.values(humanInputs).find((h) => h.stepRunId === prev.id && h.answer !== undefined)?.answer;
}

async function resolveChoice(ctx: StepContext & { node: DecisionNode }): Promise<{ raw: unknown; source: string }> {
  const s = ctx.node.source;
  switch (s.kind) {
    case "expression":
      return { raw: await ctx.evaluate(s.expr), source: "expression" };
    case "artifact": {
      const a = (
        await ctx.resolveInputs([
          { name: s.artifact, required: false },
          { kind: s.artifact, required: false },
        ])
      ).find((r) => r !== undefined);
      if (!a) throw new OrcaError("ARTIFACT_MISSING", `decision '${ctx.nodeId}' needs artifact '${s.artifact}'`);
      return { raw: artifactFieldGet(a.data, s.field), source: `artifact:${a.name}.${s.field}` };
    }
    case "agent": {
      const produces = s.produces ?? {
        kind: "decision",
        path: `.orca/runs/${ctx.run.id}/${ctx.nodeId}-decision.md`,
        required: true,
      };
      const turn = await runAgentTurn(ctx, {
        agent: s.agent,
        ...(s.template ? { template: s.template } : {}),
        ...(s.prompt ? { prompt: s.prompt } : {}),
        inputs: s.inputs,
        // Both halves are ids: the artifact field is validated against them and the prompt
        // asks the agent to answer with one of them, so an option's consequence clause
        // never reaches a template as though it were a choice.
        produces: [
          { ...produces, validate: { requiredFields: [s.field], fieldValues: { [s.field]: optionIds(ctx.node) } } },
        ],
        completion: { mode: "turn-end", maxFollowUps: 1, maxAttempts: 1 },
        vars: { options: optionIds(ctx.node) },
      });
      if (turn.kind === "failed")
        throw new OrcaError(turn.error.code as "INTERNAL", turn.error.message, turn.error.details);
      const art = turn.artifacts[0];
      return { raw: art ? artifactFieldGet(art.data, s.field) : undefined, source: `agent:${art?.name ?? "decision"}` };
    }
    case "human":
      return { raw: await askHuman(ctx, s.question, ctx.node.options), source: "human" };
    case "matrix": {
      const m = await resolveMatrixChoice(ctx, s.artifact, s.decision);
      return { raw: m.choice, source: `matrix:${m.key}:${m.decidedBy}` };
    }
  }
}

export const decisionExecutor: NodeExecutor<DecisionNode> = {
  type: "decision",
  async execute(ctx) {
    const { raw, source } = await resolveChoice(ctx);
    let choice =
      typeof raw === "boolean" ? (raw ? "true" : "false") : raw === undefined || raw === null ? undefined : String(raw);
    const ids = optionIds(ctx.node);
    if (choice === undefined || !ids.includes(choice)) {
      if (!ctx.node.defaultOption)
        return failed(
          "RUN_STATE",
          `decision '${ctx.nodeId}' produced '${String(choice)}' which is not one of ${ids.join(", ")}`,
          { raw, source },
        );
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
      const choice = n.autoOption ?? optionIds(n)[0]!;
      await ctx.emit({ type: "decision.resolved", payload: { stepRunId: ctx.step.id, choice, source: "gate:auto" } });
      return completed({ choice });
    }
    const answer = await askHuman(ctx, await ctx.render(n.question), n.options);
    if (answer === undefined || !optionIds(n).includes(answer))
      return failed("CANCELLED", `gate '${ctx.nodeId}' was not approved (answer: ${String(answer)})`, {}, false);
    await ctx.emit({
      type: "decision.resolved",
      payload: { stepRunId: ctx.step.id, choice: answer, source: "gate:human" },
    });
    return completed({ choice: answer });
  },
};
