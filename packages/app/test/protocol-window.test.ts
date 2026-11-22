/**
 * App N against an N-1 daemon (#880). This build's own daemon is the N-1 fixture: the app's
 * protocol window is replaced with one a major ahead of it (current N, previous = this
 * build's protocol), so the real `DaemonClient` negotiates down over HTTP, reads and writes,
 * and the real connection machine reports the older protocol for the banner to explain.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HELLO_METHOD,
  PROTOCOL_VERSION,
  RUNS_CANCEL_METHOD,
  RUNS_LIST_METHOD,
  RunsCancelParamsSchema,
  RunsListParamsSchema,
  daemonRelation,
  formatProtocolVersion,
  helloOffer,
  windowOf,
  type HelloResult,
  type ProtocolVersion,
  type ProtocolWindow,
} from "@orca/protocol";
import { hello, startDaemon, type DaemonHandle, type MethodTable } from "@orca/daemon";
import type { ConnectionSnapshot } from "../src/bridge.js";

const window: { value?: ProtocolWindow } = vi.hoisted(() => ({}));
vi.mock("../src/client/protocol-window.js", async () => {
  const protocol = await import("@orca/protocol");
  const w = windowOf({ major: protocol.PROTOCOL_VERSION.major + 1, minor: 0 }, protocol.PROTOCOL_VERSION);
  window.value = w;
  return {
    APP_PROTOCOL_WINDOW: w,
    appHelloOffer: () => helloOffer(w),
    appDaemonRelation: (d: ProtocolVersion) => daemonRelation(d, w),
    appSpeaks: (d: ProtocolVersion) => daemonRelation(d, w) !== undefined,
    appProtocolLabel: () => formatProtocolVersion(w.current),
  };
});

const { DaemonClient } = await import("../src/client/daemon-client.js");
const { ConnectionMachine } = await import("../src/main/connection-state.js");
const { toConnection, writability } = await import("../renderer/src/connection.js");

const N = formatProtocolVersion({ major: PROTOCOL_VERSION.major + 1, minor: 0 });
const N1 = formatProtocolVersion(PROTOCOL_VERSION);
const asOf = "2026-11-22T00:00:00.000Z";
const run = {
  id: "run-1",
  name: "A run",
  workflowId: "wf",
  workflowVersion: "1",
  status: "cancelled" as const,
  createdAt: asOf,
};

describe("app N against an N-1 daemon", () => {
  const seen: { method: string; params: unknown }[] = [];
  const table: MethodTable = {
    [HELLO_METHOD]: hello,
    [RUNS_LIST_METHOD]: {
      params: RunsListParamsSchema,
      handle: (p) => (seen.push({ method: RUNS_LIST_METHOD, params: p }), { runs: [run], total: 1, asOf }),
    },
    [RUNS_CANCEL_METHOD]: {
      params: RunsCancelParamsSchema,
      handle: (p) => (seen.push({ method: RUNS_CANCEL_METHOD, params: p }), { run, asOf }),
    },
  };
  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({
      orcaVersion: "n-1-fixture",
      capabilities: ["runs.read", "runs.control"],
      auth: { mode: "loopback-unauthenticated" },
      methods: table,
    });
  });
  afterAll(async () => {
    await d.close();
  });

  it("offers its fallback and gets the daemon's own protocol back", async () => {
    expect(window.value).toMatchObject({ previous: PROTOCOL_VERSION });
    const result = await new DaemonClient(d.url).hello("orca-app/n");
    expect(result.protocol).toEqual(PROTOCOL_VERSION);
  });

  it("reads and writes on the older protocol", async () => {
    const client = new DaemonClient(d.url);
    expect((await client.runsList({})).runs).toHaveLength(1);
    expect((await client.runsCancel({ runId: "run-1", reason: "n-1" })).run.status).toBe("cancelled");
    expect(seen.map((s) => s.method)).toEqual([RUNS_LIST_METHOD, RUNS_CANCEL_METHOD]);
  });

  it("is live and writable, and says the daemon is a version behind", async () => {
    const result = await new DaemonClient(d.url).hello("orca-app/n");
    const snapshots: ConnectionSnapshot[] = [];
    const machine = new ConnectionMachine({
      hello: async () => result,
      onChange: (s) => snapshots.push(s),
      quietMs: 0,
    });
    machine.acceptHello(result);
    machine.linkChanged("live");
    const snapshot = snapshots.at(-1)!;
    expect(snapshot).toMatchObject({ state: "live", olderProtocol: true, versions: { app: N, daemon: N1 } });
    const connection = toConnection(snapshot);
    expect(connection.olderProtocol).toBe(true);
    expect(writability(connection)).toEqual({ can: true });
    machine.close();
  });

  it("treats a daemon on N as current and one on N-2 as a mismatch", () => {
    const snapshots: ConnectionSnapshot[] = [];
    const base: HelloResult = { protocol: PROTOCOL_VERSION, orcaVersion: "x", capabilities: ["runs.read"] };
    const machine = new ConnectionMachine({ hello: async () => base, onChange: (s) => snapshots.push(s), quietMs: 0 });
    machine.linkChanged("live");
    machine.acceptHello({ ...base, protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 } });
    expect(snapshots.at(-1)).toMatchObject({ state: "live" });
    expect(snapshots.at(-1)).not.toHaveProperty("olderProtocol");
    machine.acceptHello({ ...base, protocol: { major: PROTOCOL_VERSION.major - 1, minor: 10 } });
    expect(snapshots.at(-1)).toMatchObject({ state: "mismatch" });
    expect(snapshots.at(-1)).not.toHaveProperty("olderProtocol");
    machine.close();
  });
});
