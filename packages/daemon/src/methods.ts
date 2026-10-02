/**
 * The method table: one entry per protocol method, each validating its params with the
 * schema the protocol package publishes and returning a result the same package types.
 * The transport is deliberately unaware of what any method does; adding a method is one
 * entry here plus its schemas in `@orca/protocol`.
 *
 * The read methods need a projection of a store, which a daemon may not have (`hello` alone
 * is a valid daemon, and is what `orca serve` outside a configured workspace can offer). So
 * `MethodContext.reads` is optional and every read method starts by demanding it; a client
 * that checked `capabilities`/`methods` in the handshake never sees that error.
 *
 * The control methods (`MethodContext.control`) and the agent methods
 * (`MethodContext.agents`) are optional in the same way and for a stronger reason: a daemon
 * started with `--read-only` has no `control`, so its methods are not in this table at all
 * and `hello.methods` does not list them. "Absent" and "present but refusing" are different
 * promises, and a client that has to hide a button needs the first one.
 */
import {
  CONFIG_APPLY_METHOD,
  ConfigApplyParamsSchema,
  type ConfigApplyParams,
  type ConfigApplyResult,
} from "@orca/protocol";

import type { SubmissionAuthority } from "@orca/core";
import {
  RequestsSubmitParamsSchema,
  RequestsAdmissionParamsSchema,
  RequestsAdmissionsParamsSchema,
} from "@orca/protocol";
import type { RequestSubmissionModel } from "./request-submission.js";
import type { LiveAnswerAuthority, ExecutionResumeAuthority } from "@orca/engine";
import type { Maintenance } from "./maintenance.js";
import { OrcaError, type MutationActor } from "@orca/core";
import {
  AGENTS_LIST_METHOD,
  AGENTS_PING_METHOD,
  ARTIFACTS_GET_METHOD,
  ARTIFACTS_LIST_METHOD,
  AgentsListParamsSchema,
  AgentsPingParamsSchema,
  ArtifactsGetParamsSchema,
  ArtifactsListParamsSchema,
  CLAIMS_LIST_METHOD,
  CLAIMS_RELEASE_METHOD,
  CONFIG_GET_METHOD,
  CONFIG_SET_METHOD,
  ClaimsListParamsSchema,
  ClaimsReleaseParamsSchema,
  ConfigGetParamsSchema,
  ConfigSetParamsSchema,
  DECISIONS_DECIDE_METHOD,
  DECISIONS_LIST_METHOD,
  DECISIONS_REOPEN_METHOD,
  DEPENDENCIES_LIST_METHOD,
  DEPENDENCIES_WAIVE_METHOD,
  DecisionsDecideParamsSchema,
  DecisionsListParamsSchema,
  DecisionsReopenParamsSchema,
  DependenciesListParamsSchema,
  DependenciesWaiveParamsSchema,
  HELLO_METHOD,
  HelloParamsSchema,
  INPUTS_ANSWER_METHOD,
  INPUTS_LIST_METHOD,
  ITEMS_LIST_METHOD,
  InputsAnswerParamsSchema,
  InputsListParamsSchema,
  ItemsListParamsSchema,
  JOURNAL_LIST_METHOD,
  JournalListParamsSchema,
  PLANS_LIST_METHOD,
  PLAN_GET_METHOD,
  PROTOCOL_VERSION,
  PlanGetParamsSchema,
  PlansListParamsSchema,
  RISKS_LIST_METHOD,
  RISKS_UPDATE_METHOD,
  RUNS_CANCEL_METHOD,
  RUNS_EVENTS_METHOD,
  RUNS_GET_METHOD,
  RUNS_LIST_METHOD,
  RUNS_RESUME_METHOD,
  RUNS_START_METHOD,
  RisksListParamsSchema,
  RisksUpdateParamsSchema,
  RunsCancelParamsSchema,
  RunsEventsParamsSchema,
  RunsGetParamsSchema,
  RunsListParamsSchema,
  RunsResumeParamsSchema,
  RunsStartParamsSchema,
  SCHEDULE_EXPLAIN_METHOD,
  SCHEDULE_GET_METHOD,
  SUBSCRIBE_METHOD,
  ScheduleExplainParamsSchema,
  ScheduleGetParamsSchema,
  SubscribeParamsSchema,
  UNSUBSCRIBE_METHOD,
  UnsubscribeParamsSchema,
  WORKFLOWS_GET_METHOD,
  WORKFLOWS_LIST_METHOD,
  WorkflowsGetParamsSchema,
  WorkflowsListParamsSchema,
  formatProtocolVersion,
  isCompatible,
  type AgentsListParams,
  type AgentsListResult,
  type AgentsPingParams,
  type AgentsPingResult,
  type ArtifactsGetResult,
  type ArtifactsListResult,
  type ClaimsListResult,
  type ClaimsReleaseParams,
  type ClaimsReleaseResult,
  type ConfigGetParams,
  type ConfigGetResult,
  type ConfigSetParams,
  type ConfigSetResult,
  type DaemonCapability,
  type DecisionsDecideParams,
  type DecisionsDecideResult,
  type DecisionsListResult,
  type DecisionsReopenParams,
  type DecisionsReopenResult,
  type DependenciesListResult,
  type DependenciesWaiveParams,
  type DependenciesWaiveResult,
  type HelloResult,
  type InputsAnswerParams,
  type InputsAnswerResult,
  type InputsListResult,
  type ItemsListResult,
  type JournalListResult,
  type PlanGetResult,
  type PlansListParams,
  type PlansListResult,
  type RisksListResult,
  type RisksUpdateParams,
  type RisksUpdateResult,
  type RunsCancelParams,
  type RunsCancelResult,
  type RunsEventsResult,
  type RunsGetResult,
  type RunsListResult,
  type RunsResumeParams,
  type RunsResumeResult,
  type RunsStartParams,
  type RunsStartResult,
  type ScheduleExplainResult,
  type ScheduleGetResult,
  type SubscribeParams,
  type SubscribeResult,
  type UnsubscribeParams,
  type UnsubscribeResult,
  type WorkflowsGetResult,
  type WorkflowsListResult,
} from "@orca/protocol";
import type { ZodType } from "zod";
import {
  WORKFLOWS_VALIDATE_INPUTS_METHOD,
  WorkflowsValidateInputsParamsSchema,
  type WorkflowsValidateInputsParams,
  type WorkflowsValidateInputsResult,
} from "@orca/protocol";
import type { WorkflowInputsModel } from "./workflow-inputs.js";
import type { AgentModel } from "./agent-model.js";
import type { ConfigModel } from "./config-model.js";
import type { ControlModel } from "./control.js";
import type { PlanControlModel } from "./plan-control.js";
import type { PlanModel } from "./plan-model.js";
import type { ReadModel } from "./read-model.js";
import type { PlanChangeSource, SubscriptionSource } from "./subscriptions.js";

import type { LiveInputChangeSource } from "./live-input-notifications.js";

export interface MethodContext {
  liveInputs?: LiveInputChangeSource | undefined;
  liveAnswerAuthority?: LiveAnswerAuthority;
  executionResumeAuthority?: ExecutionResumeAuthority;
  requestSubmissions?: RequestSubmissionModel | undefined;
  submissionWorkspaceId?: string | undefined;
  requestSubmissionAuthority?: ((ctx: MethodContext) => Promise<SubmissionAuthority>) | undefined;
  identity?: { workspaceId: string; instanceId: string };
  /** Set only by the authenticating guard, never read from RPC params. */
  mutationActor?: MutationActor | undefined;
  /** Side-effect-free launch preflight, using the same resolver as admission. */
  workflowInputs?: WorkflowInputsModel | undefined;
  /** Server-bound per-call ownership handoff; never parsed from RPC params. */
  attributeStartedRun?: ((runId: string) => void | Promise<void>) | undefined;
  /** ORCA's own version, reported in `hello`. */
  orcaVersion: string;
  maintenance?: Maintenance | undefined;
  processId?: number | undefined;
  storeDir?: string | undefined;
  capabilities: readonly DaemonCapability[];
  /** The projection the read methods answer from. Without it they refuse; `hello` does not need it. */
  reads?: ReadModel | undefined;
  /**
   * The engine feed a subscription reads from. Present means this daemon runs a WebSocket
   * endpoint and advertises `subscribe`/`unsubscribe`; absent means it does not.
   */
  source?: SubscriptionSource | undefined;
  /**
   * The plan journal a `plan.changed` push is folded from - the store's own listener seam.
   * Present means store-wide subscriptions are woken when this process changes a plan;
   * absent means they are not, and a plan screen re-reads on its own.
   */
  planSource?: PlanChangeSource | undefined;
  /**
   * The writing half. Present means this daemon drives runs - it advertises `runs.control`,
   * answers the four control methods, and holds a lease on every run it touches. Absent is
   * `orca serve --read-only`: the methods are not in the table and not in `hello.methods`.
   */
  control?: ControlModel | undefined;
  /**
   * The plan's writing half (#169, #88). Present exactly when `control` is - `--read-only` is
   * one switch, and a daemon that will not drive a run will not waive a dependency either -
   * but it is its own field because a plan write is not a run write: it takes no lease and
   * drives no interpreter, it journals under `PlanService`'s per-plan lock.
   */
  planControl?: PlanControlModel | undefined;
  /**
   * Handshake health and the ping that produces it. Present whenever the daemon has a
   * configured agent registry, `--read-only` or not: neither method touches a run.
   */
  agents?: AgentModel | undefined;
  /**
   * The workspace's two configuration documents (#174, #266). Present whenever the daemon
   * was started over a config directory, `--read-only` or not: `config.get` is a read, and a
   * read-only daemon answers it. `config.set` additionally needs `control` - it is in
   * `controlMethods`, so a read-only daemon does not have it at all.
   */
  config?: ConfigModel | undefined;
}

export interface Method<P, R> {
  params: ZodType<P>;
  handle: (params: P, ctx: MethodContext) => Promise<R> | R;
}

function reads(ctx: MethodContext): ReadModel {
  if (!ctx.reads)
    throw new OrcaError("NOT_SUPPORTED", "this daemon serves no store: it answers 'hello' only", {
      capabilities: [...ctx.capabilities],
    });
  return ctx.reads;
}

/**
 * The control model, or the reason there is none. A client that read `hello` never sees
 * this: the methods are absent from the table, so a call reaches `PROTOCOL_METHOD` first.
 * It exists for an embedder that built its own table by hand.
 */
function control(ctx: MethodContext): ControlModel {
  if (!ctx.control)
    throw new OrcaError("NOT_SUPPORTED", "this daemon is read-only: it does not drive runs", {
      capabilities: [...ctx.capabilities],
    });
  return ctx.control;
}

function config(ctx: MethodContext): ConfigModel {
  if (!ctx.config)
    throw new OrcaError("NOT_SUPPORTED", "this daemon serves no workspace configuration", {
      capabilities: [...ctx.capabilities],
    });
  return ctx.config;
}

/** The plan projection, or the reason there is none. Absent from the table when absent here. */
function plans(ctx: MethodContext): PlanModel {
  const model = reads(ctx).plans;
  if (!model)
    throw new OrcaError("NOT_SUPPORTED", "this daemon serves no plan: it answers the run methods only", {
      capabilities: [...ctx.capabilities],
    });
  return model;
}

function planControl(ctx: MethodContext): PlanControlModel {
  if (!ctx.planControl)
    throw new OrcaError("NOT_SUPPORTED", "this daemon is read-only: it does not write to the plan", {
      capabilities: [...ctx.capabilities],
    });
  return ctx.planControl;
}

function agents(ctx: MethodContext): AgentModel {
  if (!ctx.agents)
    throw new OrcaError("NOT_SUPPORTED", "this daemon has no agent registry", {
      capabilities: [...ctx.capabilities],
    });
  return ctx.agents;
}

/** `hello`: check the client's protocol version and describe this daemon. */
export const hello: Method<{ client: string; protocol: { major: number; minor: number } }, HelloResult> = {
  params: HelloParamsSchema,
  handle(params, ctx) {
    if (!isCompatible(params.protocol, PROTOCOL_VERSION)) {
      throw new OrcaError(
        "NOT_SUPPORTED",
        `client speaks protocol ${formatProtocolVersion(params.protocol)}, daemon speaks ${formatProtocolVersion(PROTOCOL_VERSION)}`,
        { client: params.protocol, daemon: PROTOCOL_VERSION },
      );
    }
    return {
      protocol: PROTOCOL_VERSION,
      orcaVersion: ctx.orcaVersion,
      ...(ctx.processId === undefined ? {} : { processId: ctx.processId }),
      ...(ctx.identity ? { identity: ctx.identity } : {}),
      ...(ctx.storeDir ? { storeDir: ctx.storeDir } : {}),
      capabilities: [
        ...ctx.capabilities.filter((c) => c !== "workflows.validateInputs" && c !== "inputs.live"),
        ...(ctx.control?.supportsLiveInputs ? ["inputs.live" as const] : []),
        ...(ctx.workflowInputs ? ["workflows.validateInputs" as const] : []),
      ],
      methods: Object.keys(methodsFor(ctx)),
    };
  },
};

/** `runs.list`: the run list, newest first. */
export const runsList: Method<Parameters<ReadModel["runsList"]>[0], RunsListResult> = {
  params: RunsListParamsSchema,
  handle: (params, ctx) => reads(ctx).runsList(params),
};

/** `runs.get`: one run's tree - steps, attempts, children, artifacts. */
export const runsGet: Method<Parameters<ReadModel["runsGet"]>[0], RunsGetResult> = {
  params: RunsGetParamsSchema,
  handle: (params, ctx) => reads(ctx).runsGet(params),
};

/** `runs.events`: one page of a run's log, by sequence number, forwards or backwards. */
export const runsEvents: Method<Parameters<ReadModel["runsEvents"]>[0], RunsEventsResult> = {
  params: RunsEventsParamsSchema,
  handle: (params, ctx) => reads(ctx).runsEvents(params),
};

/** `inputs.list`: the gates and permission asks waiting on a person. */
export const inputsList: Method<Parameters<ReadModel["inputsList"]>[0], InputsListResult> = {
  params: InputsListParamsSchema,
  handle: (params, ctx) => reads(ctx).inputsList(params),
};

/** `claims.list`: who owns which work item, and whether that run is still alive. */
export const claimsList: Method<Parameters<ReadModel["claimsList"]>[0], ClaimsListResult> = {
  params: ClaimsListParamsSchema,
  handle: (params, ctx) => reads(ctx).claimsList(params),
};

/** `artifacts.list`: the artifact index, filtered - a run's, a name's versions, a step's. */
export const artifactsList: Method<Parameters<ReadModel["artifactsList"]>[0], ArtifactsListResult> = {
  params: ArtifactsListParamsSchema,
  handle: (params, ctx) => reads(ctx).artifactsList(params),
};

/** `artifacts.get`: one artifact with its body, or the reason the body is not shown. */
export const artifactsGet: Method<Parameters<ReadModel["artifactsGet"]>[0], ArtifactsGetResult> = {
  params: ArtifactsGetParamsSchema,
  handle: (params, ctx) => reads(ctx).artifactsGet(params),
};

/** `workflows.list`: every workflow this daemon has registered, as rows. */
export const workflowsList: Method<Parameters<ReadModel["workflowsList"]>[0], WorkflowsListResult> = {
  params: WorkflowsListParamsSchema,
  handle: (params, ctx) => reads(ctx).workflowsList(params),
};

/** `workflows.get`: one workflow's graph - nodes, their fields, edges, nested graphs. */
export const workflowsGet: Method<Parameters<ReadModel["workflowsGet"]>[0], WorkflowsGetResult> = {
  params: WorkflowsGetParamsSchema,
  handle: (params, ctx) => reads(ctx).workflowsGet(params),
};

/**
 * `config.get`: both configuration documents, the schema a form renders, and the effective
 * permission policy the two of them add up to (#174, #266).
 *
 * A read, so a `--read-only` daemon answers it. **It redacts nothing**: `config.text` is the
 * bytes of `orca.config.yaml`, ssh hosts, command lines and environment names included. A
 * form that edits a file has to show the file, and a redacted text written back would
 * destroy what it hid. This read requires current config.read authority.
 */
export const configGet: Method<ConfigGetParams, ConfigGetResult> = {
  params: ConfigGetParamsSchema,
  handle: (_params, ctx) => config(ctx).get(),
};

// ------------------------------------------------------------- the plan reads

/** `plans.list`: every plan in the store, with its item counts per classification. */
export const plansList: Method<PlansListParams, PlansListResult> = {
  params: PlansListParamsSchema,
  handle: (_params, ctx) => plans(ctx).plansList(),
};

/** `plan.get`: one plan's header - requests, counts, matrix and policy. */
export const planGet: Method<Parameters<PlanModel["planGet"]>[0], PlanGetResult> = {
  params: PlanGetParamsSchema,
  handle: (params, ctx) => plans(ctx).planGet(params),
};

/** `items.list`: the schedule table, in schedule order, filtered and paged. */
export const itemsList: Method<Parameters<PlanModel["itemsList"]>[0], ItemsListResult> = {
  params: ItemsListParamsSchema,
  handle: (params, ctx) => plans(ctx).itemsList(params),
};

/** `schedule.get`: what may run now, what waits and why, the waves and the critical path. */
export const scheduleGet: Method<Parameters<PlanModel["scheduleGet"]>[0], ScheduleGetResult> = {
  params: ScheduleGetParamsSchema,
  handle: (params, ctx) => plans(ctx).scheduleGet(params),
};

/** `schedule.explain`: one item's place in the schedule, in `core`'s own words. */
export const scheduleExplain: Method<Parameters<PlanModel["scheduleExplain"]>[0], ScheduleExplainResult> = {
  params: ScheduleExplainParamsSchema,
  handle: (params, ctx) => plans(ctx).scheduleExplain(params),
};

/** `dependencies.list`: the edges, with the scheduler's live evaluation of each. */
export const dependenciesList: Method<Parameters<PlanModel["dependenciesList"]>[0], DependenciesListResult> = {
  params: DependenciesListParamsSchema,
  handle: (params, ctx) => plans(ctx).dependenciesList(params),
};

/** `risks.list`: the register with scores and levels, plus the matrix and the appetite. */
export const risksList: Method<Parameters<PlanModel["risksList"]>[0], RisksListResult> = {
  params: RisksListParamsSchema,
  handle: (params, ctx) => plans(ctx).risksList(params),
};

/** `decisions.list`: the decisions, their matrices, and the items each one gates. */
export const decisionsList: Method<Parameters<PlanModel["decisionsList"]>[0], DecisionsListResult> = {
  params: DecisionsListParamsSchema,
  handle: (params, ctx) => plans(ctx).decisionsList(params),
};

/** `journal.list`: one page of the plan's audit trail, forwards or backwards. */
export const journalList: Method<Parameters<PlanModel["journalList"]>[0], JournalListResult> = {
  params: JournalListParamsSchema,
  handle: (params, ctx) => plans(ctx).journalList(params),
};

/** Launch preflight is read-only, but requires launch authority before resolving a workflow. */
export const workflowsValidateInputs: Method<WorkflowsValidateInputsParams, WorkflowsValidateInputsResult> = {
  params: WorkflowsValidateInputsParamsSchema,
  handle: (params, ctx) => {
    if (!ctx.workflowInputs) throw new OrcaError("NOT_SUPPORTED", "this daemon serves no workflow preflight");
    return ctx.workflowInputs.validateInputs(params);
  },
};

// ----------------------------------------------------------------- the writes

/** `inputs.answer`: record a person's answer to an open gate or permission ask, and continue. */
export const inputsAnswer: Method<InputsAnswerParams, InputsAnswerResult> = {
  params: InputsAnswerParamsSchema,
  handle: (params, ctx) => control(ctx).answerInput(params, ctx.mutationActor, ctx.liveAnswerAuthority),
};

/** `runs.resume`: re-drive a parked run here until it parks again or finishes. */
export const runsResume: Method<RunsResumeParams, RunsResumeResult> = {
  params: RunsResumeParamsSchema,
  handle: (params, ctx) => control(ctx).resumeRun(params, ctx.executionResumeAuthority),
};

/** `runs.cancel`: close a run and the children it is waiting on. */
export const runsCancel: Method<RunsCancelParams, RunsCancelResult> = {
  params: RunsCancelParamsSchema,
  handle: (params, ctx) => control(ctx).cancelRun(params, ctx.mutationActor),
};

/** `runs.start`: a workflow and its vars. No request, no work item, no documents - by decision. */
export const runsStart: Method<RunsStartParams, RunsStartResult> = {
  params: RunsStartParamsSchema,
  handle: (params, ctx) => control(ctx).startRun(params, ctx.attributeStartedRun, ctx.mutationActor),
};

/**
 * `config.set`: write `orca.config.yaml` or the ADR 0009 permission sidecar (#174, #266).
 *
 * A write, so a `--read-only` daemon does not have it. It takes no run lease and appends no
 * event: a configuration file is not a run, and a `config.set` while a run is in flight
 * disturbs nothing.
 *
 * Saving does not activate the document. An explicitly wired config.apply validates and
 * installs a generation for future launches; existing runs keep their admitted choices.
 */
export const configApply: Method<ConfigApplyParams, ConfigApplyResult> = {
  params: ConfigApplyParamsSchema,
  handle: (params, ctx) => config(ctx).apply(params),
};

export const configSet: Method<ConfigSetParams, ConfigSetResult> = {
  params: ConfigSetParamsSchema,
  handle: (params, ctx) => config(ctx).set(params),
};

// ------------------------------------------------------------ the plan writes

/** `dependencies.waive`: a person saying this edge no longer has to hold. */
export const dependenciesWaive: Method<DependenciesWaiveParams, DependenciesWaiveResult> = {
  params: DependenciesWaiveParamsSchema,
  handle: (params, ctx) => planControl(ctx).waiveDependency(params),
};

/** `decisions.decide`: record a human choice and reconcile what it unblocks. */
export const decisionsDecide: Method<DecisionsDecideParams, DecisionsDecideResult> = {
  params: DecisionsDecideParamsSchema,
  handle: (params, ctx) => planControl(ctx).decide(params),
};

/** `decisions.reopen`: clear a choice, and with it the dependencies it satisfied (#104). */
export const decisionsReopen: Method<DecisionsReopenParams, DecisionsReopenResult> = {
  params: DecisionsReopenParamsSchema,
  handle: (params, ctx) => planControl(ctx).reopen(params),
};

/** `risks.update`: move a risk along its lifecycle; accepting one releases what it held. */
export const risksUpdate: Method<RisksUpdateParams, RisksUpdateResult> = {
  params: RisksUpdateParamsSchema,
  handle: (params, ctx) => planControl(ctx).updateRisk(params),
};

/**
 * `claims.release`: take a work item away from the run that claimed it (#88).
 *
 * Answered by `ControlModel`, not `PlanControlModel`: it is in `CONTROL_METHODS` on the wire
 * and it touches no plan, so gating it on one made a control daemon over a plan-less store
 * refuse a method its own `hello` had promised (#169).
 */
export const claimsRelease: Method<ClaimsReleaseParams, ClaimsReleaseResult> = {
  params: ClaimsReleaseParamsSchema,
  handle: (params, ctx) => control(ctx).releaseClaim(params),
};

// ---------------------------------------------------------------- the agents

/** `agents.list`: every configured agent's handshake health, and what is claimed right now. */
export const agentsList: Method<AgentsListParams, AgentsListResult> = {
  params: AgentsListParamsSchema,
  handle: (_params, ctx) => agents(ctx).agentsList(),
};

/** `agents.ping`: handshake with one agent from this process, record it, push `agent.changed`. */
export const agentsPing: Method<AgentsPingParams, AgentsPingResult> = {
  params: AgentsPingParamsSchema,
  handle: (params, ctx) => agents(ctx).ping(params),
};

/**
 * A connection's subscription state is the connection's, so these two are answered by the
 * socket transport (socket.ts) before dispatch ever sees them. They are in the table so that
 * `hello.methods` can advertise them, and so a client that tries them over `/rpc` - which has
 * nowhere to push to - is told exactly that instead of "unknown method".
 */
function socketOnly(name: string): never {
  throw new OrcaError("NOT_SUPPORTED", `'${name}' needs a connection to push on: call it over the WebSocket endpoint`, {
    method: name,
  });
}

export const subscribe: Method<SubscribeParams, SubscribeResult> = {
  params: SubscribeParamsSchema,
  handle: () => socketOnly(SUBSCRIBE_METHOD),
};

export const unsubscribe: Method<UnsubscribeParams, UnsubscribeResult> = {
  params: UnsubscribeParamsSchema,
  handle: () => socketOnly(UNSUBSCRIBE_METHOD),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the table is heterogeneous; each entry is typed at its definition.
export type MethodTable = Record<string, Method<any, unknown>>;

/** Everything a daemon with a store answers, before its capabilities are taken into account. */
export const methods: MethodTable = {
  [HELLO_METHOD]: hello,
  [RUNS_LIST_METHOD]: runsList,
  [RUNS_GET_METHOD]: runsGet,
  [RUNS_EVENTS_METHOD]: runsEvents,
  [INPUTS_LIST_METHOD]: inputsList,
  [CLAIMS_LIST_METHOD]: claimsList,
  [ARTIFACTS_LIST_METHOD]: artifactsList,
  [ARTIFACTS_GET_METHOD]: artifactsGet,
  [WORKFLOWS_LIST_METHOD]: workflowsList,
  [WORKFLOWS_GET_METHOD]: workflowsGet,
};

/**
 * The configuration methods, kept apart from both tables above because they turn on a
 * different fact: a `ConfigModel`, which a daemon serving a store outside a workspace has
 * not got. `config.get` needs only that; `config.set` needs a control model too, so it is
 * absent from a `--read-only` daemon exactly like the other writes.
 */
export const configMethods: MethodTable = { [CONFIG_GET_METHOD]: configGet };
export const configControlMethods: MethodTable = { [CONFIG_SET_METHOD]: configSet };

/**
 * The nine plan reads, kept apart so a daemon projecting runs alone leaves them out whole.
 * `ReadModel.plans` is what decides, and `hello.methods` says which way it went.
 */
export const planMethods: MethodTable = {
  [PLANS_LIST_METHOD]: plansList,
  [PLAN_GET_METHOD]: planGet,
  [ITEMS_LIST_METHOD]: itemsList,
  [SCHEDULE_GET_METHOD]: scheduleGet,
  [SCHEDULE_EXPLAIN_METHOD]: scheduleExplain,
  [DEPENDENCIES_LIST_METHOD]: dependenciesList,
  [RISKS_LIST_METHOD]: risksList,
  [DECISIONS_LIST_METHOD]: decisionsList,
  [JOURNAL_LIST_METHOD]: journalList,
};

/**
 * The five writing methods that need no plan, kept apart so `--read-only` is one omission and
 * not five.
 *
 * `claims.release` is one of them (#169): `handshake.ts` has always listed it in
 * `CONTROL_METHODS`, it needs only `Orchestrator.releaseClaim` and the run projection, and a
 * control daemon over a store with no plan in it must answer every method the `runs.control`
 * capability it advertises names.
 */
export const controlMethods: MethodTable = {
  [INPUTS_ANSWER_METHOD]: inputsAnswer,
  [RUNS_RESUME_METHOD]: runsResume,
  [RUNS_CANCEL_METHOD]: runsCancel,
  [RUNS_START_METHOD]: runsStart,
  [CLAIMS_RELEASE_METHOD]: claimsRelease,
};

/** The four plan-writing methods, omitted by `--read-only` alongside the five above. */
export const planControlMethods: MethodTable = {
  [DEPENDENCIES_WAIVE_METHOD]: dependenciesWaive,
  [DECISIONS_DECIDE_METHOD]: decisionsDecide,
  [DECISIONS_REOPEN_METHOD]: decisionsReopen,
  [RISKS_UPDATE_METHOD]: risksUpdate,
};

export const agentMethods: MethodTable = {
  [AGENTS_LIST_METHOD]: agentsList,
  [AGENTS_PING_METHOD]: agentsPing,
};

/**
 * What a daemon in this context actually answers - `hello` alone when it serves no store,
 * the plan reads only when the read model was given a plan service, the subscription methods
 * only when it was given an engine feed to fan out, the control and plan-control methods only
 * when it was given the models that write, and the agent methods only when it has a registry.
 *
 * `hello.methods` is `Object.keys` of this, so the six facts stay one fact: a method this
 * daemon will not answer is a method it does not advertise.
 */
export function methodsFor(ctx: MethodContext): MethodTable {
  const table: MethodTable = ctx.reads ? { ...methods } : { [HELLO_METHOD]: hello };
  if (ctx.reads?.plans) Object.assign(table, planMethods);
  if (ctx.source) {
    table[SUBSCRIBE_METHOD] = subscribe;
    table[UNSUBSCRIBE_METHOD] = unsubscribe;
  }
  if (ctx.control) Object.assign(table, controlMethods);
  if (ctx.control && ctx.requestSubmissions && ctx.requestSubmissionAuthority) {
    const model = ctx.requestSubmissions;
    const authority = ctx.requestSubmissionAuthority;
    Object.assign(table, {
      "requests.submit": {
        params: RequestsSubmitParamsSchema,
        handle: async (params, invocation) => model.submit(params, await authority(invocation)),
      },
      "requests.reconcile": {
        params: RequestsAdmissionParamsSchema,
        handle: async (params, invocation) => model.reconcile(params.admissionId, await authority(invocation)),
      },
      "requests.admission": {
        params: RequestsAdmissionParamsSchema,
        handle: async (params, invocation) => model.inspect(params.admissionId, await authority(invocation)),
      },
      "requests.admissions": {
        params: RequestsAdmissionsParamsSchema,
        handle: async (_params, invocation) => model.list(await authority(invocation)),
      },
    } satisfies MethodTable);
  }
  if (ctx.workflowInputs) table[WORKFLOWS_VALIDATE_INPUTS_METHOD] = workflowsValidateInputs;
  if (ctx.planControl) Object.assign(table, planControlMethods);
  if (ctx.agents) Object.assign(table, agentMethods);
  if (ctx.config) {
    Object.assign(table, configMethods);
    // Reading the configuration is a read; writing it is a write, and a read-only daemon
    // has no `control`. Two facts, one `if`, so the two can never drift apart.
    if (ctx.control) {
      Object.assign(table, configControlMethods);
      if (ctx.config.canApply) table[CONFIG_APPLY_METHOD] = configApply;
    }
  }
  return ctx.maintenance ? ctx.maintenance.wrap(table) : table;
}
