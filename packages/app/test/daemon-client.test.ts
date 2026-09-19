import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CLAIMS_LIST_METHOD,
  ClaimsListParamsSchema,
  HELLO_METHOD,
  INPUTS_LIST_METHOD,
  InputsListParamsSchema,
  PROTOCOL_VERSION,
  RUNS_EVENTS_METHOD,
  RUNS_GET_METHOD,
  RUNS_LIST_METHOD,
  RunsEventsParamsSchema,
  RunsGetParamsSchema,
  RunsListParamsSchema,
  SOCKET_PATH,
} from "@orca/protocol";
import { hello, startDaemon, type DaemonHandle, type MethodTable } from "@orca/daemon";
import { DaemonClient, DaemonClientError, DEFAULT_DAEMON_URL } from "../src/client/daemon-client.js";

describe("DaemonClient", () => {
  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({ orcaVersion: "0.1.0-test", capabilities: ["runs.read"] });
  });
  afterAll(async () => {
    await d.close();
  });

  it("defaults to the local daemon URL", () => {
    expect(new DaemonClient().url).toBe(DEFAULT_DAEMON_URL);
  });

  it("completes the handshake against a real daemon", async () => {
    const hello = await new DaemonClient(d.url).hello("test/1");
    expect(hello.protocol).toEqual(PROTOCOL_VERSION);
    expect(hello.capabilities).toEqual(["runs.read"]);
  });

  it("surfaces a daemon error as DaemonClientError with the protocol code", async () => {
    await expect(new DaemonClient(d.url).call("runs.list", {}, z.unknown())).rejects.toMatchObject({
      name: "DaemonClientError",
      error: { code: "PROTOCOL_METHOD" },
    });
  });

  it("rejects a body that is not a response envelope", async () => {
    const fake: typeof fetch = async () => new Response(JSON.stringify({ nope: 1 }));
    const err = await new DaemonClient("http://x", fake).hello("t").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonClientError);
    expect((err as DaemonClientError).error.code).toBe("PROTOCOL_MESSAGE");
  });

  it("puts the socket beside the read endpoint, on the same host and port", () => {
    expect(new DaemonClient("http://10.0.0.2:6722").socketUrl).toBe(`ws://10.0.0.2:6722${SOCKET_PATH}`);
    expect(new DaemonClient("https://orca.example/").socketUrl).toBe(`wss://orca.example${SOCKET_PATH}`);
  });
});

/**
 * The five read methods over the wire. The daemon behind them answers from a stub table
 * rather than a `ReadModel`, because what is under test here is the client: that it names
 * the right method, passes its params through and parses the answer with the right schema.
 * The projection itself is `packages/daemon`'s test, and building one needs an engine, which
 * `packages/app` may not depend on (ADR 0008).
 */
describe("the read methods", () => {
  const asOf = "2026-03-01T09:00:00.000Z";
  const seen: { method: string; params: unknown }[] = [];

  /** Record the call, then answer with the emptiest thing each result schema accepts. */
  const answer = <P, R>(method: string, params: z.ZodType<P>, result: R) => ({
    params,
    handle: (p: P): R => {
      seen.push({ method, params: p });
      return result;
    },
  });

  const table: MethodTable = {
    [HELLO_METHOD]: hello,
    [RUNS_LIST_METHOD]: answer(RUNS_LIST_METHOD, RunsListParamsSchema, { runs: [], total: 0, asOf }),
    [RUNS_GET_METHOD]: answer(RUNS_GET_METHOD, RunsGetParamsSchema, {
      run: {
        id: "run-1",
        name: "A run",
        workflowId: "wf",
        workflowVersion: "1",
        status: "running" as const,
        createdAt: asOf,
      },
      workspace: { hostId: "local", cwd: "/work/orca" },
      vars: {},
      steps: [],
      artifacts: [],
      lastSeq: 0,
      asOf,
    }),
    [RUNS_EVENTS_METHOD]: answer(RUNS_EVENTS_METHOD, RunsEventsParamsSchema, {
      events: [],
      hasMore: false,
      lastSeq: 0,
      asOf,
    }),
    [INPUTS_LIST_METHOD]: answer(INPUTS_LIST_METHOD, InputsListParamsSchema, { inputs: [], waiting: 0, asOf }),
    [CLAIMS_LIST_METHOD]: answer(CLAIMS_LIST_METHOD, ClaimsListParamsSchema, { claims: [], asOf }),
  };

  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({ orcaVersion: "0.1.0-test", capabilities: ["runs.read"], methods: table });
  });
  afterAll(async () => {
    await d.close();
  });

  it("calls each one by name and parses its result", async () => {
    const client = new DaemonClient(d.url);
    expect((await client.runsList({ roots: true })).total).toBe(0);
    expect((await client.runsGet({ runId: "run-1" })).run.id).toBe("run-1");
    expect((await client.runsEvents({ runId: "run-1", after: 3 })).lastSeq).toBe(0);
    expect((await client.inputsList({ kind: ["decision"] })).waiting).toBe(0);
    expect((await client.claimsList()).claims).toEqual([]);

    expect(seen.map((c) => c.method)).toEqual([
      RUNS_LIST_METHOD,
      RUNS_GET_METHOD,
      RUNS_EVENTS_METHOD,
      INPUTS_LIST_METHOD,
      CLAIMS_LIST_METHOD,
    ]);
    // Params travel as given, with the schema's paging defaults filled in by the daemon.
    expect(seen[0]!.params).toEqual({ roots: true, limit: 100, offset: 0 });
    expect(seen[2]!.params).toEqual({ runId: "run-1", after: 3, limit: 200 });
    expect(seen[3]!.params).toEqual({ kind: ["decision"] });
  });
});
