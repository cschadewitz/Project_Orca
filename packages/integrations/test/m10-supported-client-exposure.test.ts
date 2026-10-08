/** Synthetic grant evidence for #327/#328; this does not change or contact Cal's deployment. */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialStore, OwnershipStore, ReadModel, orchestratorResolver, startDaemon } from "@orca/daemon";
import { fileStores } from "@orca/store";
import { OperatorDiscoverySchema } from "@orca/protocol";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
import { DaemonOperatorBackend } from "../src/mcp/backend.js";
import { createOperatorServer } from "../src/mcp/server.js";
import { ProductionFixture, refused, tool, transports } from "./mcp-operator-production-fixture.js";
import { join } from "node:path";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const gated = ["submit_request", "list_requests", "list_work_items", "get_configuration_status", "list_launch_choices"];

describe.each(transports)("#327/#328 production exposure via %s", (transport) => {
  it("the six-grant Cal-shaped principal omits Request/config/choice tools; explicit fixture grants expose only their own operations", async () => {
    const f = await ProductionFixture.create();
    cleanups.push(() => f.close());
    const stores = fileStores(join(f.dir, "state"));
    const issued = await f.issue({
      principal: "synthetic-cal-six-grants",
      permissions: ["runs.read", "artifacts.read", "workflows.read", "runs.start", "runs.control", "inputs.answer"],
      scope: { runs: "owned", workflows: ["gate"] },
    });
    const peer = await f.connect(transport, issued.token);
    const discovery = OperatorDiscoverySchema.parse(await tool(peer.client, "discover_orca", {}));
    expect(discovery.scope.permissions).toHaveLength(6);
    expect(discovery.operations).not.toContain("operator.submitRequest");
    expect(discovery.operations).not.toContain("operator.config");
    for (const collection of ["requests", "items", "choices"]) expect(discovery.collections).not.toContain(collection);
    const names = (await peer.client.listTools()).tools.map((entry) => entry.name);
    expect(names).toContain("start_workflow");
    const before = { requests: await stores.requests.list(), runs: await stores.events.listRuns() };
    for (const name of gated) {
      expect(names).not.toContain(name);
      const text = await refused(peer, name, { secret: "PRIVATE_MALFORMED_ARGUMENTS" }, "NOT_SUPPORTED");
      expect(text).not.toContain("PRIVATE_MALFORMED_ARGUMENTS");
      expect({ requests: await stores.requests.list(), runs: await stores.events.listRuns() }).toEqual(before);
    }
    // Workspace grants require unrestricted resource scope. Every credential is confined to this temporary fixture.
    for (const row of [
      { permissions: ["plan.read"] as const, visible: ["list_requests", "list_work_items"] },
      { permissions: ["plan.write"] as const, visible: [] },
      { permissions: ["runs.start"] as const, visible: [] },
      { permissions: ["plan.write", "runs.start"] as const, visible: ["submit_request"] },
      { permissions: ["config.read"] as const, visible: ["get_configuration_status", "list_launch_choices"] },
    ]) {
      const grant = await f.issue({
        principal: "synthetic-exposure",
        permissions: row.permissions,
        scope: { workflows: "*", runs: "all" },
      });
      const client = (await f.connect(transport, grant.token)).client;
      const exposed = (await client.listTools()).tools.map((entry) => entry.name);
      const visible: readonly string[] = row.visible;
      expect(gated.filter((name) => exposed.includes(name))).toEqual(row.visible);
      const found = OperatorDiscoverySchema.parse(await tool(client, "discover_orca", {}));
      expect(found.operations.includes("operator.submitRequest")).toBe(visible.includes("submit_request"));
      expect(found.operations.includes("operator.config")).toBe(visible.includes("get_configuration_status"));
      expect(found.collections.includes("requests")).toBe(visible.includes("list_requests"));
      expect(found.collections.includes("choices")).toBe(visible.includes("list_launch_choices"));
      for (const name of row.visible.filter((name) => name !== "submit_request")) {
        const result = await tool(client, name, { target: found.target });
        expect(JSON.stringify(result)).not.toContain(grant.token);
      }
    }
    expect({ requests: await stores.requests.list(), runs: await stores.events.listRuns() }).toEqual(before);
  });
});

it("permissions alone cannot fabricate Request/config/choice tools when their production services and collections are unmounted", async () => {
  const f = submissionFixture();
  await f.ready();
  const credentials = new CredentialStore();
  const owner = await credentials.issue({ principal: "synthetic-unmounted-owner", preset: "owner" });
  const reads = new ReadModel({ orchestrator: f.orc });
  const daemon = await startDaemon({
    workspaceId: randomUUID(),
    orcaVersion: "synthetic-unmounted",
    capabilities: [],
    reads,
    operatorSources: { events: f.stores.events },
    auth: { mode: "token", credentials, ownership: new OwnershipStore(), resolver: orchestratorResolver(f.orc) },
  });
  cleanups.push(daemon.close);
  const backend = new DaemonOperatorBackend({ endpoint: daemon.url, credential: async () => owner.token });
  const server = createOperatorServer(backend);
  const client = new Client({ name: "m10-unmounted", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(a);
  await client.connect(b);
  const discovered = await backend.call("discover", {});
  expect(discovered.scope.permissions).toEqual(
    expect.arrayContaining(["plan.read", "plan.write", "config.read", "runs.start"]),
  );
  expect(discovered.operations).toContain("operator.page");
  expect(discovered.operations).not.toContain("operator.submitRequest");
  expect(discovered.operations).not.toContain("operator.config");
  for (const collection of ["requests", "items", "choices"]) expect(discovered.collections).not.toContain(collection);
  const exposed = (await client.listTools()).tools.map((entry) => entry.name);
  for (const name of gated) {
    expect(exposed).not.toContain(name);
    const result = await client.callTool({ name, arguments: { secret: "PRIVATE_UNMOUNTED_INPUT" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result)).toContain("NOT_SUPPORTED");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_UNMOUNTED_INPUT|orca1\./);
  }
  expect(await f.stores.requests.list()).toHaveLength(0);
  expect(await f.orc.listRuns()).toHaveLength(0);
  expect(await f.admissions.records.list()).toHaveLength(0);
});
