import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  OperatorMutationContracts,
  OperatorBoundaryPageResultSchema,
  PROTOCOL_VERSION,
  OPERATOR_MAX_RESULT_BYTES,
} from "@orca/protocol";
import { MCP_OPERATIONS, type AuthenticatedOperatorBackend } from "../src/mcp/contracts.js";
import { createOperatorServer } from "../src/mcp/server.js";
import { DaemonOperatorBackend } from "../src/mcp/backend.js";
import { createOperatorHttpHandler } from "../src/mcp/transport.js";
import {
  operatorMutationParams,
  operatorProjectionFixture as f,
} from "../../protocol/test/fixtures/operator-mutations.js";

const stamp = "2026-10-03T00:00:00Z";
const page = () => ({
  target: f.params.target,
  items: [structuredClone(f.after)],
  asOf: stamp,
  revision: "1",
  truncated: false,
  restartRequired: false,
});
const discovery = () => ({
  target: f.params.target,
  protocol: PROTOCOL_VERSION,
  orcaVersion: "test",
  principalId: "caller",
  authentication: "credential",
  scope: { runs: "all", workflows: "*", permissions: ["runs.read"] },
  operations: Object.values(MCP_OPERATIONS).map((x) => x.method),
  collections: ["inputs"],
  asOf: stamp,
});
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
async function connect(call: (operation: string, input: unknown) => Promise<unknown>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  // Deliberately untrusted output to exercise validation at the consumer edge.
  const server = createOperatorServer({ call } as AuthenticatedOperatorBackend);
  const client = new Client({ name: "contract", version: "1" });
  await server.connect(a);
  await client.connect(b);
  closes.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
it("uses the exact shared schemas for all ten aliases and enriched page results", () => {
  let count = 0;
  for (const operation of Object.values(MCP_OPERATIONS)) {
    if (!(operation.method in OperatorMutationContracts)) continue;
    const name = operation.method as keyof typeof OperatorMutationContracts;
    expect(operation.input).toBe(OperatorMutationContracts[name].params);
    expect(operation.output).toBe(OperatorMutationContracts[name].result);
    expect(operation.input.safeParse(operatorMutationParams[name]).success).toBe(true);
    count++;
  }
  expect(count).toBe(10);
  expect(MCP_OPERATIONS.page.output).toBe(OperatorBoundaryPageResultSchema);
  expect(
    MCP_OPERATIONS.admitRun.input.safeParse({
      ...operatorMutationParams["operator.admitRun"],
      retry: { idempotencyKey: "é".repeat(65) },
    }).success,
  ).toBe(false);
});
it("preserves enriched output through both private RPC and MCP consumers", async () => {
  const backend = new DaemonOperatorBackend({
    endpoint: "https://daemon",
    credential: async () => "token",
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string; method: string };
      return Response.json({
        kind: "response",
        id: request.id,
        ok: true,
        result: request.method === "operator.discover" ? discovery() : page(),
      });
    },
  });
  const client = await connect(backend.call.bind(backend) as (operation: string, input: unknown) => Promise<unknown>);
  const result = await client.callTool({
    name: "list_approvals",
    arguments: { target: f.params.target, runId: "run" },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual(page());
});
it("keeps absent aliases undiscoverable and refuses calls before argument diagnostics", async () => {
  const calls = vi.fn(async (operation: string) =>
    operation === "discover" ? { ...discovery(), operations: ["operator.discover"] } : page(),
  );
  const client = await connect(calls);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["discover_orca"]);
  const response = await client.callTool({ name: "revise_input", arguments: { invalid: "PRIVATE" } });
  expect(JSON.stringify(response)).toContain("NOT_SUPPORTED");
  expect(calls.mock.calls.every(([op]) => op === "discover")).toBe(true);
});
it("refuses late permission withdrawal even when principal and boot stay unchanged", async () => {
  let withdrawn = false;
  const client = await connect(async (operation) => {
    if (operation === "discover") return { ...discovery(), operations: withdrawn ? [] : discovery().operations };
    withdrawn = true;
    return page();
  });
  const result = await client.callTool({
    name: "list_approvals",
    arguments: { target: f.params.target, runId: "run" },
  });
  expect(JSON.stringify(result)).toContain("AUTH_FORBIDDEN");
  expect(result.structuredContent).toBeUndefined();
});
it.each([{ revisionState: "unavailable" }, { secret: "PRIVATE" }, { revisionActionId: "invented" }])(
  "rejects unsafe boundary output %j without leaking it",
  async (extra) => {
    const client = await connect(async (operation) =>
      operation === "discover" ? discovery() : { ...page(), items: [{ ...f.after, ...extra }] },
    );
    const result = await client.callTool({
      name: "list_approvals",
      arguments: { target: f.params.target, runId: "run" },
    });
    expect(JSON.stringify(result)).toContain("PROTOCOL_MESSAGE");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  },
);
it("sanitizes denied discovery before malformed tool diagnostics", async () => {
  const client = await connect(async () => {
    throw Object.assign(new Error("PRIVATE"), { code: "AUTH_FORBIDDEN" });
  });
  const result = await client.callTool({ name: "revise_input", arguments: { invalid: true } });
  expect(JSON.stringify(result)).toContain("AUTH_FORBIDDEN");
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
it("enforces serialized MCP output and private RPC streaming limits", async () => {
  const client = await connect(async (operation) =>
    operation === "discover"
      ? discovery()
      : { ...page(), items: [{ id: "input", kind: "decision", text: "x".repeat(OPERATOR_MAX_RESULT_BYTES) }] },
  );
  expect(
    JSON.stringify(
      await client.callTool({ name: "list_approvals", arguments: { target: f.params.target, runId: "run" } }),
    ),
  ).toContain("PROTOCOL_MESSAGE");
  const cancel = vi.fn();
  const backend = new DaemonOperatorBackend({
    endpoint: "https://daemon",
    credential: async () => "token",
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(32 * 1024));
          },
          cancel,
        }),
      ),
  });
  await expect(backend.call("discover", {})).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
  expect(cancel).toHaveBeenCalled();
});
it("bounds authenticated HTTP request bodies before tool execution", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    Response.json({
      kind: "response",
      id: (JSON.parse(String(init?.body)) as { id: string }).id,
      ok: true,
      result: discovery(),
    }),
  );
  const handler = createOperatorHttpHandler({
    daemonEndpoint: "https://daemon",
    origin: "https://orca.example",
    fetch: fetcher,
  });
  const response = await handler(
    new Request("https://orca.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "revise_input", arguments: { text: "x".repeat(65536) } },
      }),
    }),
  );
  expect(response.status).toBe(413);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("replays normalized direct commands unchanged across adapter reconnect", async () => {
  const received: unknown[] = [];
  const call = async (operation: string, input: unknown) => {
    if (operation === "discover") return discovery();
    received.push(input);
    return {
      state: "resolved",
      operationId: "op",
      replayed: received.length > 1,
      result: { state: "accepted", admissionId: "admission", runId: "run" },
    };
  };
  const args = operatorMutationParams["operator.admitRun"];
  for (let i = 0; i < 2; i++) {
    const client = await connect(call);
    const response = await client.callTool({ name: "start_workflow", arguments: args });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ replayed: i > 0 });
  }
  const normalized = OperatorMutationContracts["operator.admitRun"].params.parse(args);
  expect(received).toEqual([normalized, normalized]);
  expect(normalized.command.vars).toEqual({});
});

it("refuses oversized private commands before fetching and preserves stable backend error codes", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    Response.json({
      kind: "response",
      id: (JSON.parse(String(init?.body)) as { id: string }).id,
      ok: false,
      error: { code: "RUN_STATE", message: "PRIVATE", details: { secret: "PRIVATE" } },
    }),
  );
  const backend = new DaemonOperatorBackend({
    endpoint: "https://daemon",
    credential: async () => "token",
    fetch: fetcher,
  });
  await expect(
    backend.call("cancel", { target: f.params.target, runId: "run", reason: "é".repeat(65536) }),
  ).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
  expect(fetcher).not.toHaveBeenCalled();
  const client = await connect(async (operation) =>
    operation === "discover" ? discovery() : backend.call("cancel", { target: f.params.target, runId: "run" }),
  );
  const response = await client.callTool({ name: "cancel_run", arguments: { target: f.params.target, runId: "run" } });
  expect(JSON.stringify(response)).toContain("RUN_STATE");
  expect(JSON.stringify(response)).not.toContain("PRIVATE");
});
