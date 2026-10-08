/** Defense against malformed and late telemetry from an authenticated backend. */
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { hostResourceFixture, PROTOCOL_VERSION, type OperatorDiscovery } from "@orca/protocol";
import { createOperatorServer } from "../src/mcp/server.js";
import type { AuthenticatedOperatorBackend, McpInput, McpOperation, McpOutput } from "../src/mcp/contracts.js";

const target = {
  workspaceId: "20000000-0000-4000-8000-000000000001",
  instanceId: hostResourceFixture().daemonInstanceId,
};
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function fixture(result: () => unknown) {
  let discovery: OperatorDiscovery = {
    target,
    orcaVersion: "fixture",
    protocol: PROTOCOL_VERSION,
    principalId: "caller",
    authentication: "credential",
    scope: { runs: "owned", workflows: ["allowed"], permissions: ["host.telemetry.read"] },
    operations: ["operator.discover", "operator.hostResources"],
    collections: [],
    asOf: hostResourceFixture().collectedAt,
  };
  const backend: AuthenticatedOperatorBackend = {
    async call<K extends McpOperation>(operation: K, _input: McpInput<K>): Promise<McpOutput<K>> {
      return (operation === "discover" ? discovery : await result()) as McpOutput<K>;
    },
  };
  const client = new Client({ name: "resource-reference", version: "1" });
  const server = createOperatorServer(backend);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    client,
    setDiscovery: (value: OperatorDiscovery) => {
      discovery = value;
    },
    discovery: () => discovery,
  };
}

it.each(["oversized", "malformed", "wrong-daemon", "aggregate", "warnings"])(
  "rejects %s backend telemetry without leaking payload",
  async (kind) => {
    const snapshot = hostResourceFixture();
    if (kind === "wrong-daemon") snapshot.daemonInstanceId = crypto.randomUUID();
    if (kind === "warnings")
      snapshot.warnings = [
        { code: "cpu-pressure", metric: "cpu", basis: "utilization-ratio", threshold: 0.9, policy: "advisory-v1" },
      ];
    if (kind === "aggregate")
      snapshot.workstreams = {
        status: "available",
        source: "runtime-ownership",
        observedAt: snapshot.collectedAt,
        ageMs: 0,
        precision: "exact",
        value: {
          scope: "authorized-aggregate",
          coverage: "authorized-run-set",
          complete: true,
          activeRoots: 50,
          executingRuns: 50,
          waitingRuns: 0,
          blockedRuns: 0,
          uncertainRuns: 0,
        },
      };
    const f = await fixture(() =>
      kind === "oversized"
        ? { ...snapshot, privatePath: "SECRET".repeat(6000) }
        : kind === "malformed"
          ? { privatePath: "SECRET" }
          : snapshot,
    );
    const response = await f.client.callTool({ name: "get_daemon_resources", arguments: { target } });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain("SECRET");
    expect(JSON.stringify(response)).toContain(kind === "wrong-daemon" ? "RUN_STATE" : "PROTOCOL_MESSAGE");
  },
);

it.each(["revoked-operation", "scope", "reconnect"])("discards an awaited result after %s", async (change) => {
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const held = new Promise<unknown>((r) => {
    release = r;
  });
  const f = await fixture(() => {
    entered();
    return held;
  });
  const pending = f.client.callTool({ name: "get_daemon_resources", arguments: { target } });
  await started;
  const before = f.discovery();
  f.setDiscovery(
    change === "reconnect"
      ? { ...before, target: { ...target, instanceId: crypto.randomUUID() } }
      : change === "scope"
        ? { ...before, scope: { ...before.scope, workflows: ["different"] } }
        : { ...before, operations: ["operator.discover"] },
  );
  release(hostResourceFixture("pressure"));
  const response = await pending;
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response)).toContain(change === "reconnect" ? "RUN_STATE" : "AUTH_FORBIDDEN");
  expect(JSON.stringify(response)).not.toContain("cpu-pressure");
});
