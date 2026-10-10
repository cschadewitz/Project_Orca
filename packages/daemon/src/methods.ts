/** Typed daemon dispatch, including opt-in authenticated operator projections. */
import { createOperatorMutationMethods, type OperatorMutationComposition } from "./operator-mutations.js";
import { z } from "zod";
import type { OperatorReadModel } from "./operator-read-model.js";
import type { ContinuationAdmissionModel, ContinuationAccess } from "./continuation-admission.js";
import {
  RunsContinueParamsSchema,
  ContinuationsGetParamsSchema,
  ContinuationsReconcileParamsSchema,
} from "@orca/protocol";
import {
  OPERATOR_METHODS,
  OperatorTargetSchema,
  OperatorPreflightParamsSchema,
  OperatorArtifactParamsSchema,
  type OperatorPageParams,
} from "@orca/protocol";
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

import {
  InputsReviseParamsSchema,
  InputsReplaceRevisionParamsSchema,
  InputsRevisionPendingParamsSchema,
  RevisionBoundaryViewSchema,
} from "@orca/protocol";
import type { RevisionInputService, RevisionAccess, RevisionBoundary } from "@orca/engine";
import { revisionAuthority } from "./revision-input.js";
import type { SubmissionAuthority } from "@orca/core";
import {
  RequestsSubmitParamsSchema,
  RequestsAdmissionParamsSchema,
  RequestsAdmissionsParamsSchema,
} from "@orca/protocol";
import { RunsAdmitParamsSchema, AdmissionsGetParamsSchema, AdmissionsReconcileParamsSchema } from "@orca/protocol";
import { checkAdmissionScope, type AdmissionRetryModel, type AdmissionAuthorities } from "./admission-retry.js";
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
  type PendingRevisionsDiscovery,
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
import { templateMethods } from "./template-methods.js";

export interface MethodContext {
  /** Guard-owned current workspace authority, rechecked after reads and under the config writer lock. */
  configurationAuthority?: (write: boolean, read?: boolean) => Promise<void>;
  /** Internal authenticated mount; never a collector constructed by the method table. */
  hostResourceRead?: (params: unknown, invocation: MethodContext) => Promise<unknown>;
  operatorMutations?: OperatorMutationComposition | undefined;
  /** Internal exact decision guard; never parsed from legacy RPC params. */
  operatorDecisionTarget?:
    { runId: string; requestId: string; stepRunId: string; kind: "decision" | "permission" } | undefined;
  admissionExecution?:
    ((invocation: MethodContext, runId: string) => Promise<RunsGetResult["admissionExecution"]>) | undefined;
  continuationAdmissions?: ContinuationAdmissionModel | undefined;
  continuationAccess?: ((ctx: MethodContext) => Promise<ContinuationAccess>) | undefined;
  /** Bound to the original authenticated invocation; absent without production sources. */
  operatorReads?: { methods: readonly string[]; model(ctx: MethodContext): Promise<OperatorReadModel> };
  /** Only install after protected journal, #331 claims, exact attempt dispatch and live auth are wired. */
  revisionInputs?:
    | ((invocation: MethodContext) => Promise<{
        service: Pick<RevisionInputService, "submit" | "readPending" | "replacePending">;
        access: RevisionAccess;
      }>)
    | undefined;
  /** Authenticated optional enrichment; each run is authorized before protected reads. */
  revisionBoundaries?: ((invocation: MethodContext, runId: string) => Promise<readonly RevisionBoundary[]>) | undefined;
  /** Current input-read authorization; filters rows before projecting restriction-only action IDs. */
  inputRevisionRestrictions?:
    | ((
        invocation: MethodContext,
        inputs: InputsListResult["inputs"],
        revisionRunIds: readonly string[],
      ) => Promise<{
        inputs: InputsListResult["inputs"];
        recheck(): Promise<void>;
      }>)
    | undefined;
  pendingRevisionDiscovery?:
    ((invocation: MethodContext, runIds: readonly string[]) => Promise<PendingRevisionsDiscovery>) | undefined;
  liveInputs?: LiveInputChangeSource | undefined;
  liveAnswerAuthority?: LiveAnswerAuthority;
  executionResumeAuthority?: ExecutionResumeAuthority;
  requestSubmissions?: RequestSubmissionModel | undefined;
  admissionRetries?: AdmissionRetryModel | undefined;
  admissionAuthorities?: ((ctx: MethodContext) => Promise<AdmissionAuthorities>) | undefined;
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
        ...(Object.keys(createOperatorMutationMethods(ctx)) as DaemonCapability[]),
        ...(ctx.hostResourceRead ? ["operator.hostResources" as const] : []),
        ...OPERATOR_METHODS.filter(
          (name) => name !== "operator.hostResources" && ctx.operatorReads?.methods.includes(name),
        ),
        ...(ctx.continuationAdmissions && ctx.continuationAccess ? ["continuations.get" as const] : []),
        ...(ctx.control && ctx.continuationAdmissions && ctx.continuationAccess
          ? (["runs.continue", "continuations.reconcile"] as const)
          : []),
        ...(ctx.control && ctx.admissionRetries && ctx.admissionAuthorities
          ? (["runs.admit", "admissions.get", "admissions.reconcile"] as const)
          : []),
        ...ctx.capabilities.filter(
          (c) =>
            !c.startsWith("operator.") &&
            c !== "runs.admit" &&
            c !== "admissions.get" &&
            c !== "admissions.reconcile" &&
            c !== "runs.continue" &&
            c !== "continuations.get" &&
            c !== "continuations.reconcile" &&
            c !== "workflows.validateInputs" &&
            c !== "inputs.live" &&
            c !== "inputs.revise" &&
            c !== "inputs.revisionPending" &&
            c !== "inputs.replaceRevision",
        ),
        ...(ctx.revisionInputs ? ["inputs.revisionPending" as const] : []),
        ...(ctx.revisionInputs && ctx.control ? ["inputs.revise" as const, "inputs.replaceRevision" as const] : []),
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
  handle: async (params, ctx) => {
    const result = await reads(ctx).runsGet(params);
    const admissionExecution = await ctx.admissionExecution?.(ctx, params.runId);
    if (admissionExecution) result.admissionExecution = admissionExecution;
    if (!ctx.continuationAdmissions || !ctx.continuationAccess) return result;
    const expectedBoundary = await ctx.continuationAdmissions.expectedBoundary(
      params.runId,
      await ctx.continuationAccess(ctx),
    );
    return expectedBoundary ? { ...result, continuation: { expectedBoundary } } : result;
  },
};

/** `runs.events`: one page of a run's log, by sequence number, forwards or backwards. */
export const runsEvents: Method<Parameters<ReadModel["runsEvents"]>[0], RunsEventsResult> = {
  params: RunsEventsParamsSchema,
  handle: (params, ctx) => reads(ctx).runsEvents(params),
};

/** `inputs.list`: the gates and permission asks waiting on a person. */
export const inputsList: Method<Parameters<ReadModel["inputsList"]>[0], InputsListResult> = {
  params: InputsListParamsSchema,
  handle: async (params, ctx) => {
    const result = { ...(await reads(ctx).inputsList(params)) };
    delete result.pendingRevisions;
    const revisionRunIds = params.revisionRunIds ?? (params.runId === undefined ? [] : [params.runId]);
    const clean = result.inputs.map((row) => {
      const input = { ...row };
      // Only authenticated projections may install these fields, never a legacy read model.
      delete input.revision;
      delete input.revisionActionId;
      return input;
    });
    const restricted = ctx.inputRevisionRestrictions
      ? await ctx.inputRevisionRestrictions(ctx, clean, revisionRunIds)
      : { inputs: clean, recheck: undefined };
    const boundaries = new Map<string, readonly RevisionBoundary[]>();
    const inputs = [];
    for (const input of restricted.inputs) {
      if (ctx.revisionBoundaries && input.kind === "decision" && !input.live) {
        if (!boundaries.has(input.runId)) boundaries.set(input.runId, await ctx.revisionBoundaries(ctx, input.runId));
        const matching = boundaries
          .get(input.runId)!
          .filter(
            (boundary) =>
              boundary?.target?.runId === input.runId &&
              boundary.target.stepRunId === input.stepRunId &&
              boundary.target.requestId === input.id,
          );
        // Ambiguity is not permission to choose a destination. Status and public fields
        // must agree with this exact open input; private journal fields never cross RPC.
        const boundary = matching.length === 1 ? matching[0] : undefined;
        if (boundary?.status === "waiting") {
          const view = RevisionBoundaryViewSchema.safeParse({
            target: boundary.target,
            capability: boundary.capability,
            destinationDescription: boundary.destinationDescription,
          });
          if (view.success && input.options.some((option) => option.id === view.data.capability.actionId))
            input.revision = view.data;
        }
      }
      inputs.push(input);
    }
    const pendingRevisions = ctx.pendingRevisionDiscovery
      ? await ctx.pendingRevisionDiscovery(ctx, revisionRunIds)
      : undefined;
    // Recheck all row and discovery-run visibility after every awaited enrichment. Changed
    // authority refuses the whole response, including protected metadata and omission counts.
    await restricted.recheck?.();
    return {
      ...result,
      inputs,
      waiting: inputs.length,
      ...(pendingRevisions ? { pendingRevisions } : {}),
    };
  },
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
  handle: (_params, ctx) => config(ctx).get(ctx.configurationAuthority && (() => ctx.configurationAuthority!(false))),
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
  handle: (params, ctx) =>
    control(ctx).answerInput(params, ctx.mutationActor, ctx.liveAnswerAuthority, ctx.operatorDecisionTarget),
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
  handle: async (params, ctx) => {
    if (!ctx.admissionRetries || !ctx.admissionAuthorities) {
      if (params.idempotencyKey !== undefined)
        throw new OrcaError("NOT_SUPPORTED", "Retry admission is not configured");
      return control(ctx).startRun(params, ctx.attributeStartedRun, ctx.mutationActor);
    }
    const { idempotencyKey, ...command } = params;
    const admitted = await ctx.admissionRetries.admit(
      command,
      idempotencyKey === undefined ? {} : { idempotencyKey },
      await (await ctx.admissionAuthorities(ctx)).direct(),
    );
    if (admitted.state !== "accepted")
      throw new OrcaError("RUN_STATE", "Run admission requires reconciliation", { ...admitted });
    return control(ctx).settleAdmitted(admitted.runId);
  },
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
  handle: (params, ctx) =>
    config(ctx).apply(params, ctx.configurationAuthority && (() => ctx.configurationAuthority!(true, false))),
};

export const configSet: Method<ConfigSetParams, ConfigSetResult> = {
  params: ConfigSetParamsSchema,
  handle: (params, ctx) =>
    config(ctx).set(params, ctx.configurationAuthority && (() => ctx.configurationAuthority!(true))),
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
  const operator = ctx.operatorReads;
  const table: MethodTable = ctx.reads ? { ...methods } : { [HELLO_METHOD]: hello };
  if (ctx.hostResourceRead) {
    table["operator.hostResources"] = {
      params: z.unknown(),
      handle: (p, call) => ctx.hostResourceRead!(p, call),
    };
  }
  if (operator) {
    const available: MethodTable = {
      "operator.discover": {
        params: z.strictObject({}),
        handle: async (_p, call) => (await operator.model(call)).discover(),
      },
      // Collection routing is authorized inside the model BEFORE its schema diagnostics.
      "operator.page": {
        params: z.unknown(),
        handle: async (p, call) => (await operator.model(call)).page(p as OperatorPageParams),
      },
      "operator.config": {
        params: z.strictObject({ target: OperatorTargetSchema }),
        handle: async (p, call) => (await operator.model(call)).config(p.target),
      },
      "operator.preflight": {
        params: OperatorPreflightParamsSchema,
        handle: async (p, call) => (await operator.model(call)).preflight(p),
      },
      "operator.artifact": {
        params: OperatorArtifactParamsSchema,
        handle: async (p, call) => (await operator.model(call)).artifact(p),
      },
    };
    for (const name of operator.methods) if (available[name]) table[name] = available[name]!;
  }
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
        handle: async (params, invocation) => {
          const { idempotencyKey, ...command } = params;
          return model.submit(
            command,
            await authority(invocation),
            idempotencyKey === undefined ? {} : { idempotencyKey },
          );
        },
      },
      "requests.reconcile": {
        params: RequestsAdmissionParamsSchema,
        handle: async (params, invocation) =>
          model.reconcile(params.admissionId, await authority(invocation), invocation.executionResumeAuthority),
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
  if (ctx.control && ctx.admissionRetries && ctx.admissionAuthorities) {
    const model = ctx.admissionRetries,
      authorities = ctx.admissionAuthorities;
    table["runs.admit"] = {
      params: RunsAdmitParamsSchema,
      handle: async (params, invocation) => {
        const { idempotencyKey, expectedScope, ...command } = params;
        const authority = await authorities(invocation);
        await checkAdmissionScope(expectedScope, authority);
        return model.admit(command, idempotencyKey === undefined ? {} : { idempotencyKey }, await authority.direct());
      },
    };
    table["admissions.get"] = {
      params: AdmissionsGetParamsSchema,
      handle: async (params, invocation) => model.inspect(params.operationId, await authorities(invocation)),
    };
    table["admissions.reconcile"] = {
      params: AdmissionsReconcileParamsSchema,
      handle: async (params, invocation) => model.reconcile(params.operationId, await authorities(invocation)),
    };
  }
  if (ctx.continuationAdmissions && ctx.continuationAccess) {
    const model = ctx.continuationAdmissions;
    const access = ctx.continuationAccess;
    table["continuations.get"] = {
      params: ContinuationsGetParamsSchema,
      handle: async (params, invocation) => model.inspect(params.continuationId, await access(invocation)),
    };
    if (ctx.control) {
      table["runs.continue"] = {
        params: RunsContinueParamsSchema,
        handle: async (params, invocation) => model.admit(params.command, params.retry, await access(invocation)),
      };
      table["continuations.reconcile"] = {
        params: ContinuationsReconcileParamsSchema,
        handle: async (params, invocation) => model.reconcile(params.continuationId, await access(invocation)),
      };
    }
  }
  if (ctx.revisionInputs) {
    const authenticated = ctx.revisionInputs;
    table["inputs.revisionPending"] = {
      params: InputsRevisionPendingParamsSchema,
      handle: async (params, invocation) => (await authenticated(invocation)).service.readPending(params.target),
    };
    if (ctx.control) {
      table["inputs.revise"] = {
        params: InputsReviseParamsSchema,
        handle: async (params, invocation) => {
          const { service, access } = await authenticated(invocation);
          return service.submit(params.command, params.retry, revisionAuthority(access));
        },
      };
      table["inputs.replaceRevision"] = {
        params: InputsReplaceRevisionParamsSchema,
        handle: async (params, invocation) => {
          const { service, access } = await authenticated(invocation);
          return service.replacePending(params.command, params.retry, revisionAuthority(access));
        },
      };
    }
  }
  if (ctx.workflowInputs) table[WORKFLOWS_VALIDATE_INPUTS_METHOD] = workflowsValidateInputs;
  if (ctx.planControl) Object.assign(table, planControlMethods);
  if (ctx.agents) Object.assign(table, agentMethods);
  if (ctx.config) {
    Object.assign(table, configMethods);
    if (ctx.config.canApply && ctx.identity) Object.assign(table, templateMethods(Boolean(ctx.control)));
    // Reading the configuration is a read; writing it is a write, and a read-only daemon
    // has no `control`. Two facts, one `if`, so the two can never drift apart.
    if (ctx.control) {
      Object.assign(table, configControlMethods);
      if (ctx.config.canApply) table[CONFIG_APPLY_METHOD] = configApply;
    }
  }
  Object.assign(table, createOperatorMutationMethods(ctx));
  return ctx.maintenance ? ctx.maintenance.wrap(table) : table;
}
