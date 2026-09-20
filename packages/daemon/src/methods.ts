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
import { OrcaError } from "@orca/core";
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
  ClaimsListParamsSchema,
  HELLO_METHOD,
  HelloParamsSchema,
  INPUTS_ANSWER_METHOD,
  INPUTS_LIST_METHOD,
  InputsAnswerParamsSchema,
  InputsListParamsSchema,
  PROTOCOL_VERSION,
  RUNS_CANCEL_METHOD,
  RUNS_EVENTS_METHOD,
  RUNS_GET_METHOD,
  RUNS_LIST_METHOD,
  RUNS_RESUME_METHOD,
  RUNS_START_METHOD,
  RunsCancelParamsSchema,
  RunsEventsParamsSchema,
  RunsGetParamsSchema,
  RunsListParamsSchema,
  RunsResumeParamsSchema,
  RunsStartParamsSchema,
  SUBSCRIBE_METHOD,
  SubscribeParamsSchema,
  UNSUBSCRIBE_METHOD,
  UnsubscribeParamsSchema,
  formatProtocolVersion,
  isCompatible,
  type AgentsListParams,
  type AgentsListResult,
  type AgentsPingParams,
  type AgentsPingResult,
  type ArtifactsGetResult,
  type ArtifactsListResult,
  type ClaimsListResult,
  type DaemonCapability,
  type HelloResult,
  type InputsAnswerParams,
  type InputsAnswerResult,
  type InputsListResult,
  type RunsCancelParams,
  type RunsCancelResult,
  type RunsEventsResult,
  type RunsGetResult,
  type RunsListResult,
  type RunsResumeParams,
  type RunsResumeResult,
  type RunsStartParams,
  type RunsStartResult,
  type SubscribeParams,
  type SubscribeResult,
  type UnsubscribeParams,
  type UnsubscribeResult,
} from "@orca/protocol";
import type { ZodType } from "zod";
import type { AgentModel } from "./agent-model.js";
import type { ControlModel } from "./control.js";
import type { ReadModel } from "./read-model.js";
import type { SubscriptionSource } from "./subscriptions.js";

export interface MethodContext {
  /** ORCA's own version, reported in `hello`. */
  orcaVersion: string;
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
   * The writing half. Present means this daemon drives runs - it advertises `runs.control`,
   * answers the four control methods, and holds a lease on every run it touches. Absent is
   * `orca serve --read-only`: the methods are not in the table and not in `hello.methods`.
   */
  control?: ControlModel | undefined;
  /**
   * Handshake health and the ping that produces it. Present whenever the daemon has a
   * configured agent registry, `--read-only` or not: neither method touches a run.
   */
  agents?: AgentModel | undefined;
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
      ...(ctx.storeDir ? { storeDir: ctx.storeDir } : {}),
      capabilities: [...ctx.capabilities],
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

// ----------------------------------------------------------------- the writes

/** `inputs.answer`: record a person's answer to an open gate or permission ask, and continue. */
export const inputsAnswer: Method<InputsAnswerParams, InputsAnswerResult> = {
  params: InputsAnswerParamsSchema,
  handle: (params, ctx) => control(ctx).answerInput(params),
};

/** `runs.resume`: re-drive a parked run here until it parks again or finishes. */
export const runsResume: Method<RunsResumeParams, RunsResumeResult> = {
  params: RunsResumeParamsSchema,
  handle: (params, ctx) => control(ctx).resumeRun(params),
};

/** `runs.cancel`: close a run and the children it is waiting on. */
export const runsCancel: Method<RunsCancelParams, RunsCancelResult> = {
  params: RunsCancelParamsSchema,
  handle: (params, ctx) => control(ctx).cancelRun(params),
};

/** `runs.start`: a workflow and its vars. No request, no work item, no documents (#196). */
export const runsStart: Method<RunsStartParams, RunsStartResult> = {
  params: RunsStartParamsSchema,
  handle: (params, ctx) => control(ctx).startRun(params),
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
};

/** The four writing methods, kept apart so `--read-only` is one omission and not four. */
export const controlMethods: MethodTable = {
  [INPUTS_ANSWER_METHOD]: inputsAnswer,
  [RUNS_RESUME_METHOD]: runsResume,
  [RUNS_CANCEL_METHOD]: runsCancel,
  [RUNS_START_METHOD]: runsStart,
};

export const agentMethods: MethodTable = {
  [AGENTS_LIST_METHOD]: agentsList,
  [AGENTS_PING_METHOD]: agentsPing,
};

/**
 * What a daemon in this context actually answers - `hello` alone when it serves no store,
 * the subscription methods only when it was given an engine feed to fan out, the control
 * methods only when it was given a control model, and the agent methods only when it has a
 * registry.
 *
 * `hello.methods` is `Object.keys` of this, so the four facts stay one fact: a method this
 * daemon will not answer is a method it does not advertise.
 */
export function methodsFor(ctx: MethodContext): MethodTable {
  const table: MethodTable = ctx.reads ? { ...methods } : { [HELLO_METHOD]: hello };
  if (ctx.source) {
    table[SUBSCRIBE_METHOD] = subscribe;
    table[UNSUBSCRIBE_METHOD] = unsubscribe;
  }
  if (ctx.control) Object.assign(table, controlMethods);
  if (ctx.agents) Object.assign(table, agentMethods);
  return table;
}
