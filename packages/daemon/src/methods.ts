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
  CONFIG_GET_METHOD,
  CONFIG_SET_METHOD,
  ClaimsListParamsSchema,
  ConfigGetParamsSchema,
  ConfigSetParamsSchema,
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
  type ConfigGetParams,
  type ConfigGetResult,
  type ConfigSetParams,
  type ConfigSetResult,
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
  type WorkflowsGetResult,
  type WorkflowsListResult,
} from "@orca/protocol";
import type { ZodType } from "zod";
import type { AgentModel } from "./agent-model.js";
import type { ConfigModel } from "./config-model.js";
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
 * destroy what it hid. The port is loopback and unauthenticated either way.
 */
export const configGet: Method<ConfigGetParams, ConfigGetResult> = {
  params: ConfigGetParamsSchema,
  handle: (_params, ctx) => config(ctx).get(),
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

/**
 * `config.set`: write `orca.config.yaml` or the ADR 0009 permission sidecar (#174, #266).
 *
 * A write, so a `--read-only` daemon does not have it. It takes no run lease and appends no
 * event: a configuration file is not a run, and a `config.set` while a run is in flight
 * disturbs nothing.
 *
 * **The daemon goes on serving the configuration it booted with.** Agents, hosts, workflows
 * and the store were wired at `bootstrap`; nothing here rewires them, so a run started a
 * moment after a successful write still uses the old config, and the new one takes effect on
 * the next `orca serve`. Reloading a live orchestrator is its own piece of work and not a
 * side effect of a form being saved.
 */
export const configSet: Method<ConfigSetParams, ConfigSetResult> = {
  params: ConfigSetParamsSchema,
  handle: (params, ctx) => config(ctx).set(params),
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

/** The four run-writing methods, kept apart so `--read-only` is one omission and not four. */
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
  if (ctx.config) {
    Object.assign(table, configMethods);
    // Reading the configuration is a read; writing it is a write, and a read-only daemon
    // has no `control`. Two facts, one `if`, so the two can never drift apart.
    if (ctx.control) Object.assign(table, configControlMethods);
  }
  return table;
}
