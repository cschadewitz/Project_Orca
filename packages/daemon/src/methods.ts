/**
 * The method table: one entry per protocol method, each validating its params with the
 * schema the protocol package publishes and returning a result the same package types.
 * The transport is deliberately unaware of what any method does; adding a method is one
 * entry here plus its schemas in `@orca/protocol`.
 */
import { OrcaError } from "@orca/core";
import {
  HELLO_METHOD,
  HelloParamsSchema,
  PROTOCOL_VERSION,
  formatProtocolVersion,
  isCompatible,
  type DaemonCapability,
  type HelloResult,
} from "@orca/protocol";
import type { ZodType } from "zod";

export interface MethodContext {
  /** ORCA's own version, reported in `hello`. */
  orcaVersion: string;
  storeDir?: string | undefined;
  capabilities: readonly DaemonCapability[];
}

export interface Method<P, R> {
  params: ZodType<P>;
  handle: (params: P, ctx: MethodContext) => Promise<R> | R;
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
    };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the table is heterogeneous; each entry is typed at its definition.
export type MethodTable = Record<string, Method<any, unknown>>;

export const methods: MethodTable = {
  [HELLO_METHOD]: hello,
};
