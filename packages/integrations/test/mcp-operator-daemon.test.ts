/** Real authenticated daemon/read integration, executed with the reserved patch applied. */
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CredentialStore, OwnershipStore, ReadModel, orchestratorResolver, startDaemon } from "@orca/daemon";
import { artifactFixture } from "../../daemon/test/fixture.js";
import { DaemonOperatorBackend } from "../src/mcp/backend.js";
import { createOperatorServer } from "../src/mcp/server.js";
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
it("inspects a pre-existing run, pages public history, reads final artifacts and refuses revoked and owned-only callers", async () => {
  const f = await artifactFixture();
  const credentials = new CredentialStore();
  const viewer = await credentials.issue({ principal: "operator", preset: "viewer" });
  const restricted = await credentials.issue({ principal: "limited", preset: "client" });
  const ownership = new OwnershipStore();
  const reads = new ReadModel({ orchestrator: f.orchestrator });
  const daemon = await startDaemon({
    workspaceId: crypto.randomUUID(),
    orcaVersion: "integration-test",
    capabilities: ["runs.read"],
    reads,
    operatorSources: {
      events: f.stores.events,
      artifactRun: async (id) => (await f.stores.artifacts.get(id))?.producedBy.runId,
      artifact: (_run, artifactId, maxBytes) => reads.artifactsGet({ artifactId, maxBytes }),
    },
    auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(f.orchestrator) },
  });
  closers.push(daemon.close);
  const connect = async (token: string) => {
    const backend = new DaemonOperatorBackend({ endpoint: daemon.url, credential: async () => token });
    const server = createOperatorServer(backend);
    const client = new Client({ name: "reference", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return { backend, client };
  };
  // Exercise production discovery with each single grant, not a fixture inventory.
  for (const permissions of [["artifacts.read"], ["runs.read"], ["artifacts.read", "runs.read"]] as const) {
    const credential = await credentials.issue({
      principal: "discovery-test",
      permissions,
      scope: { runs: "all", workflows: "*" },
    });
    const connection = await connect(credential.token);
    const expected = permissions.length === 2;
    const discovery = await connection.backend.call("discover", {});
    expect(discovery.operations.includes("operator.artifact")).toBe(expected);
    expect(discovery.collections.includes("artifacts")).toBe(expected);
    expect((await connection.client.listTools()).tools.some((tool) => tool.name === "get_artifact")).toBe(expected);
  }
  const { backend, client } = await connect(viewer.token);
  const { target } = await backend.call("discover", {});
  const listed = await client.listTools();
  expect(listed.tools.some((t) => t.name === "start_workflow")).toBe(false);
  const runPage = await backend.call("page", { target, collection: "runs" });
  expect(runPage.items.some((r) => r.id === "run-art")).toBe(true);
  const first = await backend.call("page", { target, collection: "events", runId: "run-art", limit: 2 });
  expect(first.nextCursor).toBeTruthy();
  const second = await backend.call("page", {
    target,
    collection: "events",
    runId: "run-art",
    limit: 2,
    cursor: first.nextCursor,
  });
  expect(second.restartRequired).toBe(false);
  expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  const artifacts = await backend.call("page", { target, collection: "artifacts", runId: "run-art" });
  const artifactId = artifacts.items.find((r) => r.mediaType?.startsWith("text/"))!.artifactId!;
  const content = await backend.call("artifact", { target, runId: "run-art", artifactId });
  expect(content.text).toBeTruthy();
  expect(JSON.stringify(content)).not.toContain("/work/orca");
  const denied = await connect(restricted.token);
  expect((await denied.backend.call("page", { target, collection: "runs" })).items).toEqual([]);
  expect(
    (await denied.client.callTool({ name: "get_artifact", arguments: { target, runId: "run-art", artifactId } }))
      .isError,
  ).toBe(true);
  await credentials.revoke(viewer.credential.id);
  expect((await client.callTool({ name: "get_events", arguments: { target, runId: "run-art" } })).isError).toBe(true);
});
