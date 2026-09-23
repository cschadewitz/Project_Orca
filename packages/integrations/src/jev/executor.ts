/**
 * The `custom:jev-eval` node: judge explicitly selected artifacts with TypeSafe's System One
 * primitives and record what came back as a durable `evaluation` artifact.
 *
 * The shape is deliberately narrow. The node names its inputs; the executor builds a bounded
 * state from them (failing, never truncating, when it is too big), sends the node's versioned
 * questions to a pinned model, validates every field of the response, and records the answers
 * with the provenance of what was judged - artifact ids, hashes and versions, the resolved
 * model, token usage - and never a credential. What to *do* with an answer is ORCA's:
 * thresholds, arithmetic and routing stay in `decision` nodes and expressions, which read the
 * result as `steps.<node>.result.data.answers.<id>`.
 */
import { describeError, serializeFrontMatter } from "@orca/core";
import {
  completed,
  failed,
  type NodeExecutor,
  type ResolvedArtifact as CoreResolved,
  type StepContext,
  type StepOutcome,
} from "@orca/engine";
import { JevHttpProvider } from "./http-provider.js";
import { JevEvalNodeSchema, type JevEvalNode } from "./node.js";
import { JevProviderError, type JevAnswer, type JevProvider, type JevRequest, type JevUsage } from "./types.js";
import { validateJevResponse } from "./validate.js";

export interface JevEvalOptions {
  /** Replace the HTTP provider - a scripted one in tests, or another transport. */
  provider?: JevProvider;
  /** Default pinned model when a node names none. */
  model?: string;
  /** For the HTTP provider; default `TYPESAFE_API_KEY` / `TYPESAFE_BASE_URL` / `ORCA_JEV_MODEL` from `env`. */
  apiKey?: string;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
}

/** Aliases move underneath a calibrated threshold; a run must say exactly which version judged it. */
const MODEL_ALIASES = new Set(["jev-latest", "jev-preview"]);

/** What the artifact records about each input it judged - enough to find and re-hash it, not its content. */
export interface JevInputProvenance {
  alias: string;
  artifactId: string;
  name: string;
  kind: string;
  version: number;
  contentHash: string;
  size: number;
}

export interface JevEvaluationData {
  status: "ok" | "failed";
  rubric: { id: string; version: string | number };
  model: { requested: string; resolved?: string };
  questions: JevEvalNode["questions"];
  inputs: JevInputProvenance[];
  missingInputs: string[];
  stateChars: number;
  maxStateChars: number;
  evaluatedAt: string;
  answers?: Record<string, JevAnswer>;
  usage?: JevUsage;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

type Failure = { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };

class EvalFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

/** A function declaration, not an arrow: control flow only narrows after a call whose target is explicitly typed `never`. */
function fail(code: string, message: string, retryable: boolean, details?: Record<string, unknown>): never {
  throw new EvalFailure({ code, message, retryable, ...(details ? { details } : {}) });
}

function inputAlias(ref: JevEvalNode["inputs"][number], resolved: CoreResolved | undefined, i: number): string {
  return ref.as ?? resolved?.name ?? ref.name ?? ref.kind ?? ref.fromNode ?? `input${i}`;
}

function answerCell(a: JevAnswer): { answer: string; confidence: string } {
  switch (a.type) {
    case "noul":
      return { answer: a.noul.toFixed(3), confidence: "—" };
    case "choice":
      return { answer: `\`${a.choice}\``, confidence: a.confidence.toFixed(3) };
    case "score":
      return {
        answer: `${a.score.toFixed(2)} of ${a.levels - 1} (normalized ${a.normalized.toFixed(3)})`,
        confidence: a.confidence.toFixed(3),
      };
  }
}

function renderBody(data: JevEvaluationData): string {
  const lines = [`# JEV evaluation: ${data.rubric.id} v${data.rubric.version}`, ""];
  if (data.status === "failed") {
    lines.push(
      `**No answers were recorded.** The evaluation failed with \`${data.error?.code ?? "?"}\`: ${data.error?.message ?? ""}`,
      "",
      "Nothing downstream may read this as an approval; it is a record that the question went unanswered.",
      "",
    );
  } else {
    lines.push(
      `Model \`${data.model.resolved ?? data.model.requested}\`; ${Object.keys(data.questions).length} question(s) over ${data.inputs.length} artifact(s)` +
        (data.usage ? `; ${data.usage.inputTokens} input / ${data.usage.outputTokens} output tokens.` : "."),
      "",
      "| question | type | answer | confidence |",
      "| --- | --- | --- | --- |",
    );
    for (const [id, a] of Object.entries(data.answers ?? {})) {
      const cell = answerCell(a);
      lines.push(`| ${id} | ${a.type} | ${cell.answer} | ${cell.confidence} |`);
    }
    lines.push(
      "",
      "A noul is the probability the proposition holds. A choice or score confidence is a statistic of the",
      "returned distribution (1 = all mass on one outcome), not an accuracy guarantee; thresholds are the",
      "workflow's, in its decision nodes.",
      "",
    );
  }
  lines.push("## Inputs", "");
  for (const i of data.inputs)
    lines.push(
      `- \`${i.alias}\`: ${i.name} v${i.version} (${i.kind}, ${i.artifactId}, sha256 ${i.contentHash.slice(0, 12)}…)`,
    );
  for (const m of data.missingInputs) lines.push(`- \`${m}\`: not present (optional)`);
  lines.push("");
  return lines.join("\n");
}

/** Build the executor. `options` pin the provider and default model; the node supplies the rest. */
export function jevEvalExecutor(options: JevEvalOptions = {}): NodeExecutor {
  const env = options.env ?? process.env;

  function providerFor(): JevProvider {
    if (options.provider) return options.provider;
    const apiKey = options.apiKey ?? env.TYPESAFE_API_KEY;
    if (!apiKey)
      fail("JEV_NOT_CONFIGURED", "no TypeSafe API key: set TYPESAFE_API_KEY or pass apiKey to the plugin", false);
    const baseUrl = options.baseUrl ?? env.TYPESAFE_BASE_URL;
    return new JevHttpProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
  }

  function modelFor(node: JevEvalNode): string {
    const model = node.model ?? options.model ?? env.ORCA_JEV_MODEL;
    if (!model)
      fail("JEV_NOT_CONFIGURED", "no model: set `model:` on the node, the plugin's `model`, or ORCA_JEV_MODEL", false);
    if (MODEL_ALIASES.has(model))
      fail("WORKFLOW_INVALID", `model '${model}' is an alias; pin a version such as jev-1.13.0`, false);
    return model;
  }

  async function evaluate(ctx: StepContext, node: JevEvalNode, model: string): Promise<JevEvaluationData> {
    const provider = providerFor();

    let resolved: (CoreResolved | undefined)[];
    try {
      resolved = await ctx.resolveInputs(node.inputs);
    } catch (e) {
      const err = describeError(e);
      return fail(err.code, err.message, false, err.details);
    }
    const inputs: JevInputProvenance[] = [];
    const missingInputs: string[] = [];
    const artifacts: Record<string, string> = {};
    node.inputs.forEach((ref, i) => {
      const a = resolved[i];
      const alias = inputAlias(ref, a, i);
      if (!a) {
        missingInputs.push(alias);
        return;
      }
      artifacts[alias] = a.content;
      inputs.push({
        alias,
        artifactId: a.id,
        name: a.name,
        kind: a.kind,
        version: a.version,
        contentHash: a.contentHash,
        size: a.size,
      });
    });

    const context: Record<string, string> = {};
    for (const [key, template] of Object.entries(node.context)) context[key] = await ctx.render(template);
    const state: JevRequest["state"] = Object.keys(context).length ? { artifacts, context } : { artifacts };
    const stateChars = JSON.stringify(state).length;
    const base = {
      rubric: node.rubric,
      questions: node.questions,
      inputs,
      missingInputs,
      stateChars,
      maxStateChars: node.maxStateChars,
    };
    if (stateChars > node.maxStateChars)
      fail(
        "JEV_STATE_TOO_LARGE",
        `state is ${stateChars} characters, over the node's maxStateChars of ${node.maxStateChars}; select fewer or smaller inputs`,
        false,
        { stateChars, maxStateChars: node.maxStateChars, inputs: inputs.map((i) => `${i.alias}=${i.size}B`) },
      );

    const timeout = AbortSignal.timeout(node.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    let raw: unknown;
    try {
      raw = await provider.evaluate({ state, model, questions: node.questions }, { signal });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      if (timeout.aborted) fail("STEP_TIMEOUT", `JEV did not answer within ${node.timeoutMs}ms`, true);
      if (e instanceof JevProviderError)
        fail("JEV_PROVIDER", e.message, e.retryable, e.status !== undefined ? { status: e.status } : undefined);
      const err = describeError(e);
      return fail(err.code === "INTERNAL" ? "JEV_PROVIDER" : err.code, err.message, true, err.details);
    }

    const checked = validateJevResponse(node.questions, raw);
    if (!checked.ok)
      fail("JEV_RESPONSE_INVALID", `JEV response rejected: ${checked.problems.join("; ")}`, false, {
        problems: checked.problems,
      });
    const { answers, usage, model: resolvedModel } = checked.response;
    if (resolvedModel !== undefined && resolvedModel !== model)
      fail("JEV_MODEL_MISMATCH", `asked for model '${model}' but '${resolvedModel}' answered`, false, {
        requested: model,
        resolved: resolvedModel,
      });

    return {
      status: "ok",
      ...base,
      model: { requested: model, ...(resolvedModel !== undefined ? { resolved: resolvedModel } : {}) },
      answers,
      ...(usage ? { usage } : {}),
      evaluatedAt: ctx.clock.isoNow(),
    };
  }

  async function record(ctx: StepContext, node: JevEvalNode, data: JevEvaluationData): Promise<StepOutcome> {
    const name = node.produces.name ?? ctx.nodeId;
    const content = serializeFrontMatter({ data: { ...data }, body: renderBody(data) });
    const artifact = await ctx.recordArtifact(
      { kind: node.produces.kind, name, path: `.orca/runs/${ctx.run.id}/${name}.md`, required: true },
      content,
      { parents: data.inputs.map((i) => i.artifactId) },
    );
    ctx.logger.info("jev evaluation recorded", {
      status: data.status,
      rubric: `${data.rubric.id}@${data.rubric.version}`,
      model: data.model.resolved ?? data.model.requested,
      questions: Object.keys(data.questions).length,
      inputs: data.inputs.length,
      ...(data.usage ? { inputTokens: data.usage.inputTokens } : {}),
      ...(data.error ? { error: data.error.code } : {}),
    });
    return completed({ artifactIds: [artifact.id], data: { artifactId: artifact.id, ...data } });
  }

  return {
    type: "custom:jev-eval",
    async execute(ctx) {
      const parsed = JevEvalNodeSchema.safeParse(ctx.node);
      if (!parsed.success)
        return failed(
          "WORKFLOW_INVALID",
          `custom:jev-eval '${ctx.nodeId}': ${parsed.error.issues.map((i) => `${i.path.join(".") || "node"}: ${i.message}`).join("; ")}`,
          { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        );
      const node = parsed.data;
      let requested: string | undefined;
      try {
        requested = modelFor(node);
        return await record(ctx, node, await evaluate(ctx, node, requested));
      } catch (e) {
        if (!(e instanceof EvalFailure)) throw e;
        const { code, message, retryable, details } = e.failure;
        if (node.onError === "fail" || code === "WORKFLOW_INVALID") return failed(code, message, details, retryable);
        ctx.logger.warn("jev evaluation failed; recording the failure as the node asked", { code, message });
        return record(ctx, node, {
          status: "failed",
          rubric: node.rubric,
          model: { requested: requested ?? "" },
          questions: node.questions,
          inputs: [],
          missingInputs: [],
          stateChars: 0,
          maxStateChars: node.maxStateChars,
          evaluatedAt: ctx.clock.isoNow(),
          error: { code, message, ...(details ? { details } : {}) },
        });
      }
    },
  };
}
