/**
 * Shared harness for the `custom:jev-eval` tests: an orchestrator with in-memory stores, the JEV
 * plugin registered with whatever provider the test hands in, and a `custom:seed` node that
 * records an artifact so a run has something to judge without an agent. A `ScriptedJevProvider`
 * answers from a queue and keeps every request it saw.
 */
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, parseWorkflow, TemplateRegistry, WorkflowRegistry, type RunState } from "@orca/core";
import {
  builtinExecutors,
  completed,
  definePlugin,
  LocalWorkspaceProvider,
  Orchestrator,
  PlanService,
  type OrchestratorOptions,
} from "@orca/engine";
import { createJevEvalPlugin, type JevEvalOptions, type JevProvider, type JevRequest } from "@orca/integrations";
import { memoryStores } from "@orca/store";

type Scripted = { body: unknown } | { throws: Error };

export class ScriptedJevProvider implements JevProvider {
  readonly requests: JevRequest[] = [];
  private readonly queue: Scripted[];
  constructor(...script: Scripted[]) {
    this.queue = script;
  }
  async evaluate(request: JevRequest, options: { signal: AbortSignal }): Promise<unknown> {
    this.requests.push(structuredClone(request));
    options.signal.throwIfAborted();
    const next = this.queue.shift();
    if (!next) throw new Error("scripted provider has no more answers");
    if ("throws" in next) throw next.throws;
    return structuredClone(next.body);
  }
}

export interface JevTestHarness {
  orchestrator: Orchestrator;
  stores: ReturnType<typeof memoryStores>;
  run(workflowId: string, vars?: Record<string, unknown>): Promise<RunState>;
}

export function jevHarness(
  yaml: string,
  jev: JevEvalOptions,
  overrides: Partial<OrchestratorOptions> = {},
): JevTestHarness {
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(yaml));
  const executors = builtinExecutors();
  const stores = overrides.stores ?? memoryStores();
  const api = {
    executors,
    templates: new TemplateRegistry(),
    workflows,
    agents: new AgentRegistry(),
    plan: new PlanService({ stores }),
    setHumanInput() {},
    setWorkspaceProvider() {},
  };
  void createJevEvalPlugin(jev).register(api);
  void definePlugin({
    name: "seed",
    register(a) {
      a.executors.register({
        type: "custom:seed",
        async execute(ctx) {
          const n = ctx.node as unknown as { kind: string; name?: string; content: string };
          const artifact = await ctx.recordArtifact(
            { kind: n.kind, ...(n.name ? { name: n.name } : {}), path: `${n.name ?? n.kind}.md`, required: true },
            n.content,
          );
          return completed({ artifactIds: [artifact.id] });
        },
      });
    },
  }).register(api);
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    workflows,
    templates: new TemplateRegistry(),
    executors,
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    clock: new FakeClock(),
    ...overrides,
  });
  return {
    orchestrator,
    stores,
    run: (workflowId, vars) => orchestrator.startAndRun({ workflowId, ...(vars ? { vars } : {}) }),
  };
}

/** The step run for `nodeId` (the last attempt, when there were several). */
export function stepFor(state: RunState, nodeId: string) {
  return [...state.stepOrder]
    .reverse()
    .map((id) => state.steps[id]!)
    .find((s) => s.nodeId === nodeId);
}

/** The node the run ended on - which `end` the routing reached. */
export function endedAt(state: RunState): string | undefined {
  return state.steps[state.stepOrder[state.stepOrder.length - 1] ?? ""]?.nodeId;
}

/** The artifacts the run recorded with `kind`. */
export function artifactsOfKind(state: RunState, kind: string) {
  return Object.values(state.artifacts).filter((a) => a.kind === kind);
}

/** One choice, one score, one noul - the three primitives in one rubric, all valid. */
export const THREE_QUESTIONS = `
      conflict:
        type: choice
        instructions: "Do the implementation summary and the test report contradict each other?"
        criteria:
          none: "The two agree on what was built and tested."
          minor: "They differ on details that do not change the outcome."
          major: "One claims something the other denies."
      coverage:
        type: score
        instructions: "How much of the acceptance criteria does the implementation summary address?"
        criteria: ["None of them", "Some of them", "All of them"]
      tested:
        type: noul
        instructions: "Does the test report say the acceptance criteria were exercised by tests?"
        criteria: { true: "Names tests for the criteria", false: "Does not mention them" }`;

export const GOOD_ANSWERS = {
  model: "jev-1.13.0",
  answers: {
    conflict: {
      type: "choice",
      choice: "none",
      probabilities: { none: 0.9, minor: 0.08, major: 0.02 },
      confidence: 0.85,
    },
    coverage: {
      type: "score",
      score: 1.6,
      probabilities: { "0": 0.0, "1": 0.4, "2": 0.6 },
      confidence: 0.4,
      legend: { "0": "None of them", "1": "Some of them", "2": "All of them" },
    },
    tested: { type: "noul", noul: 0.93 },
  },
  usage: { input_tokens: 512, output_tokens: 12 },
};

/**
 * seed two artifacts -> jev -> a decision on the choice -> a decision on a noul threshold. The
 * routing is ORCA's: the model answers, the expressions decide.
 */
export const ROUTED = `
id: routed
name: routed
inputs:
  acceptance: The criteria to judge against.
start: s
nodes:
  s: { type: start }
  impl: { type: "custom:seed", kind: implementation, content: "---\\nstatus: done\\n---\\nAdded the export button." }
  tests: { type: "custom:seed", kind: test-report, name: testReport, content: "---\\npassed: true\\n---\\nexport.test.ts covers it." }
  jev:
    type: "custom:jev-eval"
    model: jev-1.13.0
    inputs:
      - { kind: implementation }
      - { name: testReport, as: report }
      - { kind: review, required: false }
    context:
      acceptance: "{{ vars.acceptance }}"
    rubric: { id: test/shadow, version: 2 }
    questions:${THREE_QUESTIONS}
  conflict:
    type: decision
    source: { kind: expression, expr: "steps.jev.result.data.answers.conflict.choice" }
    options: [none, minor, major]
  tested:
    type: decision
    source: { kind: expression, expr: "steps.jev.result.data.answers.tested.noul >= 0.9 ? 'yes' : 'no'" }
    options: [yes, no]
  agree: { type: end, outcome: success, message: agree }
  disagree: { type: end, outcome: failure, message: disagree }
  untested: { type: end, outcome: failure, message: untested }
edges:
  - { from: s, to: impl }
  - { from: impl, to: tests }
  - { from: tests, to: jev }
  - { from: jev, to: conflict }
  - { from: conflict, to: tested, when: "choice == 'none'" }
  - { from: conflict, to: disagree }
  - { from: tested, to: agree, when: "choice == 'yes'" }
  - { from: tested, to: untested }
`;
