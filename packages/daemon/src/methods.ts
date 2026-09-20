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
 */
import { OrcaError } from "@orca/core";
import {
  ARTIFACTS_GET_METHOD,
  ARTIFACTS_LIST_METHOD,
  ArtifactsGetParamsSchema,
  ArtifactsListParamsSchema,
  CLAIMS_LIST_METHOD,
  ClaimsListParamsSchema,
  HELLO_METHOD,
  HelloParamsSchema,
  INPUTS_LIST_METHOD,
  InputsListParamsSchema,
  PROTOCOL_VERSION,
  RUNS_EVENTS_METHOD,
  RUNS_GET_METHOD,
  RUNS_LIST_METHOD,
  RunsEventsParamsSchema,
  RunsGetParamsSchema,
  RunsListParamsSchema,
  SUBSCRIBE_METHOD,
  SubscribeParamsSchema,
  UNSUBSCRIBE_METHOD,
  UnsubscribeParamsSchema,
  formatProtocolVersion,
  isCompatible,
  type ArtifactsGetResult,
  type ArtifactsListResult,
  type ClaimsListResult,
  type DaemonCapability,
  type HelloResult,
  type InputsListResult,
  type RunsEventsResult,
  type RunsGetResult,
  type RunsListResult,
  type SubscribeParams,
  type SubscribeResult,
  type UnsubscribeParams,
  type UnsubscribeResult,
} from "@orca/protocol";
import type { ZodType } from "zod";
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

/** Everything a daemon with a store answers. */
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

/**
 * What a daemon in this context actually answers - `hello` alone when it serves no store,
 * and the subscription methods only when it was given an engine feed to fan out.
 */
export function methodsFor(ctx: MethodContext): MethodTable {
  const table: MethodTable = ctx.reads ? { ...methods } : { [HELLO_METHOD]: hello };
  if (ctx.source) {
    table[SUBSCRIBE_METHOD] = subscribe;
    table[UNSUBSCRIBE_METHOD] = unsubscribe;
  }
  return table;
}
