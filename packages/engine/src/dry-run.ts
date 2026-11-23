/**
 * Dry run of a draft (#183): simulate one exact workflow definition with deterministic fixtures,
 * so an author can see which way it routes - and which branch it never takes - before anything
 * real runs.
 *
 * A dry run is a real run tree in the run store, every run of it tagged `dryRun` on its
 * `run.created` (see `DryRunSchema`), driven by an orchestrator of its own that is built to stay
 * inside ORCA:
 *
 * - **No agent.** An agent step resolves its inputs and renders its prompt as it would live, then
 *   records the fixture artifacts it was given, or the documented placeholder (below), instead
 *   of opening a session. The session factory, the secret use check and the human input port of
 *   that orchestrator refuse outright, so a path that reached one would fail, not act.
 * - **Simulated choices.** A gate whose `autoApproveWhen` holds is decided by it, as live;
 *   otherwise it takes the fixture choice, or by default its `autoOption`, else its first
 *   option. A decision by expression or artifact field is evaluated as live; one a person, an
 *   agent or the plan would make takes the fixture choice, or by default its `defaultOption`,
 *   else its first option. Each is recorded as `dry-run:fixture` or `dry-run:default` and
 *   never as an answer: no pending gate is created, so nothing real can be approved by it.
 * - **Nothing outside.** No workspace is provisioned (the run gets a placeholder that names no
 *   directory), no Request or work item is bound, and planning intake goes to a scratch plan
 *   that the dry run alone sees. Container nodes (loop, parallel, subworkflow) run their
 *   children as dry runs. Every other executor - the planning and program nodes, any plugin's
 *   custom node - is blocked and named (`DRY_RUN_UNSUPPORTED`) unless it declares a
 *   `simulate`; its `execute` is never called.
 * - **Bounded.** Fixtures are checked against the definition before anything is written; a
 *   step budget across the whole tree stops a cycle that never exits (`DRY_RUN_LIMIT`); and a
 *   dry run can be cancelled like any run.
 *
 * Placeholder artifacts: a required deliverable without a fixture is a document whose front
 * matter sets `dryRun: true` and each validated field - to the first value its `fieldValues`
 * allows, else to `dry-run` - with a body long enough for `minBodyLength`. A decision reading a
 * field the placeholder could not choose for (`dry-run` is rarely an option) falls to its
 * `defaultOption`, which is often the very branch worth seeing; give a fixture to take another.
 *
 * What it proves, and what it does not: a dry run shows that the routing, expressions,
 * templates and artifact contracts do what was meant with these fixtures. A simulated success
 * is no evidence that a live agent will produce those artifacts, that a tool or an
 * integration is available, or that a person would choose as the fixtures did.
 */
import type { AgentSession } from "@orca/agents";
import {
  capabilityManifestKey,
  extractStructuredData,
  evaluateVars,
  OrcaError,
  parseFrontMatter,
  redactCapabilityManifest,
  sha256,
  silentLogger,
  WorkflowRegistry,
  type AgentNode,
  type ArtifactSpec,
  type DecisionNode,
  type DryRun,
  type GateNode,
  type MutationActor,
  type NodeDef,
  type OrcaEvent,
  type ParallelNode,
  type RunOverrides,
  type RunState,
  type WorkflowDefinition,
  type WorkflowGraph,
  type Workspace,
} from "@orca/core";
import { memoryStores } from "@orca/store";
import { z } from "zod";
import { agentInstructions, resolveNodeCapabilities } from "./capabilities.js";
import { validateArtifact } from "./executors/agent-step.js";
import { decisionExecutor, endExecutor, setExecutor, startExecutor } from "./executors/basic.js";
import { loopExecutor, parallelExecutor, subworkflowExecutor } from "./executors/containers.js";
import {
  completed,
  failed,
  NodeExecutorRegistry,
  type NodeExecutor,
  type ResolvedArtifact,
  type StepContext,
  type StepOutcome,
} from "./executors/types.js";
import type { HumanInputPort } from "./human-input.js";
import { INLINE_SEP, inlineWorkflowDefinition, Orchestrator, workflowRevision } from "./orchestrator.js";
import { PlanService } from "./plan/service.js";
import type { WorkspaceProvider } from "./workspace/provider.js";

/** The most steps a dry run's whole tree may take unless the request says otherwise. */
export const DRY_RUN_DEFAULT_MAX_STEPS = 500;
/** The most a request may raise it to. */
export const DRY_RUN_MAX_STEPS = 5_000;

/** The version suffix a simulated definition is kept under, so it never collides with a real one. */
export const DRY_RUN_VERSION_MARK = "+dryrun.";

const MAX_FIXTURE_TEXT = 256 * 1024;
const MAX_VISITS = 64;

const AgentFixtureSchema = z
  .object({
    /** Deliverable content by the produces entry's `name`, else its `kind`. */
    artifacts: z.record(z.string().max(128), z.string().max(MAX_FIXTURE_TEXT)).optional(),
    /** Fail this visit instead, as an agent that did not deliver would. */
    fail: z.string().min(1).max(2_000).optional(),
  })
  .strict();

/**
 * The fixtures and simulated choices of a dry run, keyed by node id - or by the qualified id
 * of a node in a nested graph (`loop::build`), which wins over the plain id. A list gives one
 * entry per visit, in order; the last one repeats.
 */
export const DryRunFixturesSchema = z
  .object({
    agents: z
      .record(z.string().max(512), z.union([AgentFixtureSchema, z.array(AgentFixtureSchema).min(1).max(MAX_VISITS)]))
      .optional(),
    choices: z
      .record(z.string().max(512), z.union([z.string().max(128), z.array(z.string().max(128)).min(1).max(MAX_VISITS)]))
      .optional(),
  })
  .strict();
export type DryRunAgentFixture = z.infer<typeof AgentFixtureSchema>;
export type DryRunFixtures = z.infer<typeof DryRunFixturesSchema>;

export interface DryRunRequest {
  /** The exact definition to simulate: a draft's, or a published one. */
  definition: WorkflowDefinition;
  /** Launch inputs, validated as a live launch would validate them. */
  vars?: Record<string, unknown>;
  fixtures?: DryRunFixtures;
  /** The draft revision the definition was taken from (#180), recorded with the run. */
  draftRevision?: number;
  overrides?: RunOverrides;
  actor?: MutationActor;
  /** Most steps across the whole tree; `DRY_RUN_DEFAULT_MAX_STEPS` when absent. */
  maxSteps?: number;
}

export interface DryRunHandle {
  runId: string;
  /** The identity the run is bound to, as recorded on its `run.created`. */
  dryRun: DryRun;
  /** Settles with the root run's final state once the whole tree has stopped. */
  done: Promise<RunState>;
  cancel(reason?: string): Promise<void>;
}

/** The refusal for anything a dry run cannot simulate safely. */
export function dryRunUnsupported(nodeId: string, type: string, why: string): StepOutcome {
  return failed(
    "DRY_RUN_UNSUPPORTED",
    `a dry run cannot simulate node '${nodeId}' (${type}): ${why}`,
    { nodeId, nodeType: type },
    false,
    "none",
  );
}

function fixtureInvalid(message: string, details?: Record<string, unknown>): OrcaError {
  return new OrcaError("DRY_RUN_FIXTURE_INVALID", message, details);
}

/** Every node of a definition, nested inline graphs included, under its qualified id. */
function qualifiedNodes(graph: WorkflowGraph, prefix = ""): { qualifiedId: string; node: NodeDef }[] {
  const out: { qualifiedId: string; node: NodeDef }[] = [];
  for (const [id, node] of Object.entries(graph.nodes)) {
    const qualifiedId = prefix ? `${prefix}${INLINE_SEP}${id}` : id;
    out.push({ qualifiedId, node });
    if (node.type === "loop" && "graph" in node.body) out.push(...qualifiedNodes(node.body.graph, qualifiedId));
    if (node.type === "parallel") {
      if (node.forEach?.body && "graph" in node.forEach.body)
        out.push(...qualifiedNodes(node.forEach.body.graph, qualifiedId));
      for (const [branch, ref] of Object.entries(node.branches ?? {}))
        if ("graph" in ref) out.push(...qualifiedNodes(ref.graph, `${qualifiedId}${INLINE_SEP}${branch}`));
    }
  }
  return out;
}

/** The ids of the options a person, an agent or the plan would choose from at this node, if any. */
function simulatedOptions(node: NodeDef): string[] | undefined {
  if (node.type === "gate") return node.options.map((o) => o.id);
  if (node.type === "decision" && node.source.kind !== "expression" && node.source.kind !== "artifact")
    return node.options.map((o) => o.id);
  return undefined;
}

/** Check fixtures against the definition before anything is written. */
function checkFixtures(def: WorkflowDefinition, fixtures: DryRunFixtures): void {
  const nodes = qualifiedNodes(def);
  const named = (key: string) =>
    nodes.filter((n) => n.qualifiedId === key || n.qualifiedId.endsWith(`${INLINE_SEP}${key}`));
  for (const [key, given] of Object.entries(fixtures.agents ?? {})) {
    const found = named(key);
    if (!found.length || found.some((n) => n.node.type !== "agent"))
      throw fixtureInvalid(`agent fixture '${key}' names no agent step of '${def.id}'`, { node: key });
    for (const fixture of Array.isArray(given) ? given : [given])
      for (const name of Object.keys(fixture.artifacts ?? {}))
        if (!found.some((n) => (n.node as AgentNode).produces.some((p) => (p.name ?? p.kind) === name)))
          throw fixtureInvalid(`agent fixture '${key}' gives '${name}', which that step does not produce`, {
            node: key,
            artifact: name,
          });
  }
  for (const [key, given] of Object.entries(fixtures.choices ?? {})) {
    const found = named(key);
    const options = found.map((n) => simulatedOptions(n.node));
    if (!found.length || options.some((o) => o === undefined))
      throw fixtureInvalid(
        `choice fixture '${key}' names no gate, or decision made by a person, an agent or the plan, in '${def.id}'`,
        { node: key },
      );
    for (const choice of Array.isArray(given) ? given : [given])
      if (options.some((o) => !o!.includes(choice)))
        throw fixtureInvalid(`choice fixture '${key}': '${choice}' is not one of its options`, {
          node: key,
          choice,
          options: options[0],
        });
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** One placeholder document for a deliverable, satisfying its validation rules. */
export function placeholderArtifact(spec: ArtifactSpec, nodeId: string): string {
  const fields: Record<string, unknown> = { dryRun: true };
  for (const [f, allowed] of Object.entries(spec.validate?.fieldValues ?? {})) if (allowed[0]) fields[f] = allowed[0];
  for (const f of spec.validate?.requiredFields ?? []) fields[f] ??= "dry-run";
  const sentence = `Dry-run placeholder for the ${spec.kind} of step '${nodeId}': no agent wrote this. `;
  const min = spec.validate?.minBodyLength ?? 0;
  const body = sentence.repeat(Math.max(1, Math.ceil((min + 1) / sentence.length))).trim();
  if (isJson(spec)) return JSON.stringify({ ...fields, body });
  const front = Object.entries(fields).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `---\n${front.join("\n")}\n---\n${body}\n`;
}

function isJson(spec: ArtifactSpec): boolean {
  return spec.mediaType === "application/json" || spec.path.endsWith(".json");
}

/** What a dry run's executors share across its tree. */
class Simulation {
  private steps = 0;
  private readonly visits = new Map<string, number>();
  constructor(
    readonly fixtures: DryRunFixtures,
    readonly maxSteps: number,
  ) {}

  /** Count a step against the budget; false once it is spent. */
  step(): boolean {
    return ++this.steps <= this.maxSteps;
  }

  /**
   * The fixture for this visit of a node: under its qualified id if one is given, else its plain
   * id. Visits are counted per node across the whole tree, in the order steps reach it.
   */
  take<T>(table: "agents" | "choices", ctx: StepContext): T | undefined {
    const given = this.fixtures[table] as Record<string, T | T[]> | undefined;
    const qualified = qualifiedId(ctx);
    const key = given?.[qualified] !== undefined ? qualified : ctx.nodeId;
    const counter = `${table}\u0000${qualified}`;
    const visit = this.visits.get(counter) ?? 0;
    this.visits.set(counter, visit + 1);
    const entry = given?.[key];
    if (entry === undefined) return undefined;
    return Array.isArray(entry) ? entry[Math.min(visit, entry.length - 1)] : entry;
  }
}

/** The node's id qualified by the inline path of the graph it is in (`loop::build`). */
function qualifiedId(ctx: StepContext): string {
  const path = ctx.definition.id.split(INLINE_SEP).slice(1);
  return [...path, ctx.nodeId].join(INLINE_SEP);
}

function assumption(kind: "fixture" | "default", detail: string): Record<string, unknown> {
  return { dryRun: { assumption: kind, detail } };
}

async function simulateChoice(
  ctx: StepContext,
  sim: Simulation,
  options: string[],
  fallback: string,
  what: string,
): Promise<StepOutcome> {
  const given = sim.take<string>("choices", ctx);
  const choice = given ?? fallback;
  const source = given !== undefined ? "dry-run:fixture" : "dry-run:default";
  await ctx.emit({ type: "decision.resolved", payload: { stepRunId: ctx.step.id, choice, source } });
  return completed({
    choice,
    data: assumption(
      given !== undefined ? "fixture" : "default",
      given !== undefined
        ? `${what} chose '${choice}' from the fixtures`
        : `${what} took '${choice}' by default (of ${options.join(", ")})`,
    ),
  });
}

async function simulateAgent(ctx: StepContext & { node: AgentNode }, sim: Simulation): Promise<StepOutcome> {
  const n = ctx.node;
  const fixture = sim.take<DryRunAgentFixture>("agents", ctx);
  // Inputs and the prompt as live, so a missing input or a template that does not render fails here.
  const resolved = await ctx.resolveInputs(n.inputs);
  const inputs = resolved.filter((a): a is ResolvedArtifact => a !== undefined);
  const views: Record<string, ResolvedArtifact> = {};
  n.inputs.forEach((ref, i) => {
    const a = resolved[i];
    if (a) views[ref.as ?? a.name] = a;
  });
  const vars = await evaluateVars(n.vars, (expr) => ctx.evaluate(expr));
  const pack = ctx.run.state.run.overrides?.templatePack;
  const body = n.template ? ctx.templates.get(n.template, pack ? { pack } : {}).body : (n.prompt ?? "");
  const prompt = (
    await ctx.render(body, { inputs: views, vars: { ...ctx.run.state.run.vars, ...vars }, deliverables: [] })
  ).trim();
  if (fixture?.fail)
    return failed("DRY_RUN_AGENT_FAILED", `simulated failure of '${ctx.nodeId}': ${fixture.fail}`, {}, false, "none");
  const artifactIds: string[] = [];
  const supplied: string[] = [];
  const placeholders: string[] = [];
  for (const spec of n.produces) {
    const name = spec.name ?? spec.kind;
    const given = fixture?.artifacts?.[name];
    if (given === undefined && !spec.required) continue;
    const content = given ?? placeholderArtifact(spec, ctx.nodeId);
    const mediaType = isJson(spec) ? "application/json" : (spec.mediaType ?? "text/markdown");
    let reason: string | undefined;
    try {
      reason = validateArtifact(spec, extractStructuredData(content, mediaType), parseFrontMatter(content).body);
    } catch (error) {
      reason = `could not parse its structured data: ${(error as Error).message}`;
    }
    if (reason)
      return failed(
        "DRY_RUN_FIXTURE_INVALID",
        `the ${given !== undefined ? "fixture" : "placeholder"} for '${name}' of '${ctx.nodeId}' is invalid: ${reason}`,
        { nodeId: ctx.nodeId, artifact: name },
        false,
        "none",
      );
    const artifact = await ctx.recordArtifact({ ...spec, mediaType }, content, { parents: inputs.map((a) => a.id) });
    artifactIds.push(artifact.id);
    (given !== undefined ? supplied : placeholders).push(name);
  }
  const detail = [
    supplied.length ? `fixture ${supplied.join(", ")}` : "",
    placeholders.length ? `placeholder ${placeholders.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return completed({
    artifactIds,
    data: {
      promptHash: sha256(prompt),
      ...assumption(placeholders.length ? "default" : "fixture", `no agent ran; ${detail || "nothing to deliver"}`),
    },
  });
}

/** The executors of a dry run over the ones live runs use: only what is safe to simulate runs. */
function simulationExecutors(live: NodeExecutorRegistry, sim: Simulation): NodeExecutorRegistry {
  const registry = new NodeExecutorRegistry();
  const guarded = (type: string, execute: (ctx: StepContext) => Promise<StepOutcome>): NodeExecutor => ({
    type: type as NodeDef["type"],
    execute: async (ctx) => {
      if (!sim.step())
        return failed(
          "DRY_RUN_LIMIT",
          `the dry run took more than ${sim.maxSteps} steps; a cycle may never exit with these fixtures`,
          { maxSteps: sim.maxSteps },
          false,
          "none",
        );
      return execute(ctx);
    },
  });
  // Pure control flow, and containers whose children are dry runs of this same orchestrator.
  for (const executor of [startExecutor, endExecutor, setExecutor, loopExecutor, subworkflowExecutor])
    registry.register(guarded(executor.type, (ctx) => executor.execute(ctx as never)));
  registry.register(
    guarded("parallel", (ctx) => {
      const node = ctx.node as ParallelNode;
      if (node.forEach?.workItemId !== undefined)
        return Promise.resolve(dryRunUnsupported(ctx.nodeId, "parallel", "its branches are bound to work items"));
      return parallelExecutor.execute(ctx as never);
    }),
  );
  registry.register(guarded("agent", (ctx) => simulateAgent(ctx as StepContext & { node: AgentNode }, sim)));
  registry.register(
    guarded("decision", (ctx) => {
      const node = ctx.node as DecisionNode;
      if (node.source.kind === "expression" || node.source.kind === "artifact")
        return decisionExecutor.execute(ctx as never);
      const ids = node.options.map((o) => o.id);
      return simulateChoice(ctx, sim, ids, node.defaultOption ?? ids[0]!, `decision by ${node.source.kind}`);
    }),
  );
  registry.register(
    guarded("gate", async (ctx) => {
      const node = ctx.node as GateNode;
      const ids = node.options.map((o) => o.id);
      if (node.autoApproveWhen && (await ctx.evaluate(node.autoApproveWhen))) {
        const choice = node.autoOption ?? ids[0]!;
        await ctx.emit({ type: "decision.resolved", payload: { stepRunId: ctx.step.id, choice, source: "gate:auto" } });
        return completed({ choice });
      }
      return simulateChoice(ctx, sim, ids, node.autoOption ?? ids[0]!, "gate");
    }),
  );
  // A dry run is bound to no work item, so there is never a dependency to wait for.
  registry.register(
    guarded("custom:plan-await", () =>
      Promise.resolve(
        completed({
          data: { skipped: "no work item", ...assumption("default", "a dry run waits on no plan dependency") },
        }),
      ),
    ),
  );
  // Every other type, plugins' included: only an explicit simulation, never `execute`.
  for (const type of live.types()) {
    if (registry.get(type)) continue;
    const executor = live.get(type)!;
    registry.register(
      guarded(type, (ctx) =>
        executor.simulate
          ? executor.simulate(ctx as never)
          : Promise.resolve(dryRunUnsupported(ctx.nodeId, type, "it has no safe simulation and may act outside ORCA")),
      ),
    );
  }
  return registry;
}

function refusingProvider(): WorkspaceProvider {
  return {
    name: "dry-run",
    provision: () => Promise.reject(new OrcaError("NOT_SUPPORTED", "a dry run provisions no workspace")),
  };
}

const refusingHumanInput: HumanInputPort = {
  ask: () => Promise.reject(new OrcaError("NOT_SUPPORTED", "a dry run asks nobody; its choices are simulated")),
};

/** The placeholder workspace a dry run's runs carry: it names no directory anything may use. */
export const DRY_RUN_WORKSPACE: Workspace = { hostId: "dry-run", cwd: "dry-run:", provider: "dry-run" };

/**
 * Start a dry run of `request.definition` beside `base`, on its stores and its current
 * configuration. Refuses invalid fixtures or launch inputs before anything is written; once it
 * resolves, the run exists and `done` settles when it stops.
 */
export async function startDryRun(base: Orchestrator, request: DryRunRequest): Promise<DryRunHandle> {
  const fixtures = DryRunFixturesSchema.safeParse(request.fixtures ?? {});
  if (!fixtures.success)
    throw fixtureInvalid(
      `dry-run fixtures are invalid: ${fixtures.error.issues.map((i) => `${i.path.join(".") || "fixtures"}: ${i.message}`).join("; ")}`,
    );
  const maxSteps = request.maxSteps ?? DRY_RUN_DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > DRY_RUN_MAX_STEPS)
    throw fixtureInvalid(`maxSteps must be a whole number from 1 to ${DRY_RUN_MAX_STEPS}`);
  const draft = request.definition;
  if (draft.id.includes(INLINE_SEP) || draft.version.includes(DRY_RUN_VERSION_MARK))
    throw new OrcaError("WORKFLOW_INVALID", "a dry run takes a root workflow definition");
  checkFixtures(draft, fixtures.data);

  const generation = base.generations?.current;
  const agents = (generation?.agents ?? base.agents).withOverrides(request.overrides);
  const definitionRevision = workflowRevision(draft);
  // Kept under a version of its own, content-addressed, so it never meets a real one.
  const simulated: WorkflowDefinition = {
    ...draft,
    version: `${draft.version}${DRY_RUN_VERSION_MARK}${definitionRevision.slice("sha256:".length, "sha256:".length + 16)}`,
  };
  const workflows = new WorkflowRegistry();
  for (const def of (generation?.workflows ?? base.workflows).list()) workflows.register(def);
  workflows.register(simulated);

  const capabilities = agentInstructions(draft)
    .filter((step) => agents.canResolve(step.agent))
    .map((step) => {
      const { agent } = agents.resolve(step.agent);
      const manifest = resolveNodeCapabilities({
        registry: agents,
        agent,
        workflow: draft.capabilities,
        nodeId: step.nodeId,
        node: step.scope,
        nodePath: step.nodePath,
        digests: true,
      }).manifest;
      return `${step.qualifiedId}=${capabilityManifestKey(redactCapabilityManifest(manifest))}`;
    })
    .sort();
  const dryRun: DryRun = {
    definitionRevision,
    ...(request.draftRevision !== undefined ? { draftRevision: request.draftRevision } : {}),
    ...(generation ? { configGeneration: generation.snapshot.id } : {}),
    fixtures: `sha256:${sha256(canonicalJson(fixtures.data))}`,
    capabilities: `sha256:${sha256(capabilities.join("\n"))}`,
  };

  const sim = new Simulation(fixtures.data, maxSteps);
  const refuseSession = (): Promise<AgentSession> =>
    Promise.reject(new OrcaError("NOT_SUPPORTED", "a dry run opens no agent session"));
  const orchestrator = new Orchestrator({
    stores: base.stores,
    agents: generation?.agents ?? base.agents,
    workflows,
    templates: generation?.templates ?? base.templates,
    executors: simulationExecutors(generation?.executors ?? base.executors, sim),
    humanInput: refusingHumanInput,
    workspaceProvider: refusingProvider(),
    sessionFactory: refuseSession,
    // Set, so a step using a secret reference is not refused at launch; never satisfied.
    secretUse: () => Promise.reject(new OrcaError("NOT_SUPPORTED", "a dry run resolves no secret")),
    plan: new PlanService({
      stores: memoryStores(),
      clock: base.clock,
      logger: silentLogger,
      defaults: base.plan.defaults,
    }),
    clock: base.clock,
    logger: base.logger.child({ component: "dry-run" }),
    dryRun,
  });
  let runId: string;
  try {
    runId = await orchestrator.startRun({
      workflowId: simulated.id,
      workflowVersion: simulated.version,
      vars: request.vars ?? {},
      workspace: { ...DRY_RUN_WORKSPACE },
      ...(request.overrides ? { overrides: request.overrides } : {}),
      ...(request.actor ? { actor: request.actor } : {}),
    });
  } catch (error) {
    orchestrator.detach();
    throw error;
  }
  const done = orchestrator.run(runId).finally(() => orchestrator.detach());
  return {
    runId,
    dryRun,
    done,
    cancel: (reason = "dry run cancelled") => orchestrator.cancel(runId, reason, request.actor),
  };
}

// --------------------------------------------------------------------------- report

export interface DryRunReport {
  runId: string;
  status: RunState["run"]["status"];
  outcome?: RunState["run"]["outcome"];
  dryRun: DryRun;
  /** Every run of the tree, the root first. */
  runs: { runId: string; workflowId: string; status: RunState["run"]["status"] }[];
  /** Each choice made, by whom: live evaluation, a fixture, or a documented default. */
  choices: { runId: string; nodeId: string; choice: string; source: string }[];
  /** Options of a gate or decision that no visit in that run chose. */
  untakenOptions: { runId: string; nodeId: string; options: string[] }[];
  /** Edges out of a node the run reached that it never followed. */
  untakenEdges: { runId: string; from: string; to: string; label?: string }[];
  /** Nodes of a run's graph that no step of that run reached. */
  unreachedNodes: { runId: string; nodeIds: string[] }[];
  /** What was assumed in place of an agent, a person or the plan. */
  assumptions: { runId: string; nodeId: string; assumption: string; detail: string }[];
  /** Steps that failed, unsupported nodes and invalid fixtures among them. */
  failures: { runId: string; nodeId: string; code: string; message: string }[];
  /** Read this before trusting a simulated success. */
  limits: string;
}

export const DRY_RUN_LIMITS =
  "Simulated with fixtures: no agent, tool, integration or person took part. This shows how the workflow routes with " +
  "these fixtures; it is not evidence that a live run would produce them.";

/**
 * Trace a dry run's tree from its logs: the choices made and by whom, the branches never taken,
 * the assumptions behind them, and what failed. Read-only; refuses a run that is not a dry run.
 */
export async function dryRunReport(orchestrator: Orchestrator, runId: string): Promise<DryRunReport> {
  const root = await orchestrator.getState(runId);
  if (!root.run.dryRun) throw new OrcaError("RUN_STATE", `run ${runId} is not a dry run`, { runId });
  const report: DryRunReport = {
    runId,
    status: root.run.status,
    ...(root.run.outcome ? { outcome: root.run.outcome } : {}),
    dryRun: root.run.dryRun,
    runs: [],
    choices: [],
    untakenOptions: [],
    untakenEdges: [],
    unreachedNodes: [],
    assumptions: [],
    failures: [],
    limits: DRY_RUN_LIMITS,
  };
  const queue = [root];
  const roots = new Map<string, WorkflowDefinition | undefined>();
  const definitionOf = async (state: RunState): Promise<WorkflowDefinition | undefined> => {
    const [rootId] = state.run.workflowId.split(INLINE_SEP);
    const key = `${rootId}@${state.run.workflowVersion}`;
    if (!roots.has(key)) roots.set(key, await orchestrator.stores.workflows.get(rootId!, state.run.workflowVersion));
    const kept = roots.get(key);
    if (!kept) return undefined;
    return state.run.workflowId.includes(INLINE_SEP) ? inlineWorkflowDefinition(kept, state.run.workflowId) : kept;
  };
  for (let i = 0; i < queue.length && i < 10_000; i++) {
    const state = queue[i]!;
    const id = state.run.id;
    report.runs.push({ runId: id, workflowId: state.run.workflowId, status: state.run.status });
    const events: OrcaEvent[] = await orchestrator.stores.events.read(id);
    const stepNode = new Map(Object.values(state.steps).map((s) => [s.id, s.nodeId]));
    const chosen = new Map<string, Set<string>>();
    for (const e of events)
      if (e.type === "decision.resolved") {
        const nodeId = stepNode.get(e.payload.stepRunId) ?? "?";
        report.choices.push({ runId: id, nodeId, choice: e.payload.choice, source: e.payload.source });
        chosen.set(nodeId, (chosen.get(nodeId) ?? new Set()).add(e.payload.choice));
      }
    const order = state.stepOrder.map((s) => state.steps[s]!).filter((s) => !s.reusedFrom);
    for (const step of order) {
      const dry = (step.result?.data as { dryRun?: { assumption: string; detail: string } } | undefined)?.dryRun;
      if (dry) report.assumptions.push({ runId: id, nodeId: step.nodeId, ...dry });
      if (step.status === "failed" && step.error)
        report.failures.push({ runId: id, nodeId: step.nodeId, code: step.error.code, message: step.error.message });
      for (const child of step.childRunIds) queue.push(await orchestrator.getState(child));
    }
    const def = await definitionOf(state);
    if (!def) continue;
    const visited = new Set(order.map((s) => s.nodeId));
    const followed = new Set<string>();
    for (let k = 1; k < order.length; k++) followed.add(`${order[k - 1]!.nodeId}\u0000${order[k]!.nodeId}`);
    for (const [nodeId, node] of Object.entries(def.nodes)) {
      if (!visited.has(nodeId)) continue;
      if (node.type === "gate" || node.type === "decision") {
        const untaken = node.options.map((o) => o.id).filter((o) => !chosen.get(nodeId)?.has(o));
        if (untaken.length) report.untakenOptions.push({ runId: id, nodeId, options: untaken });
      }
    }
    for (const edge of def.edges)
      if (visited.has(edge.from) && !followed.has(`${edge.from}\u0000${edge.to}`))
        report.untakenEdges.push({
          runId: id,
          from: edge.from,
          to: edge.to,
          ...(edge.label ? { label: edge.label } : {}),
        });
    const unreached = Object.keys(def.nodes).filter((n) => !visited.has(n));
    if (unreached.length) report.unreachedNodes.push({ runId: id, nodeIds: unreached });
  }
  return report;
}
