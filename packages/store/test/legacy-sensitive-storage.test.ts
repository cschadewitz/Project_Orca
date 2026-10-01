/** Known typed plaintext history is withheld, never rewritten during a normal open. */
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "@orca/core";
import {
  InMemoryEventStore,
  InMemoryExecutionStore,
  InMemoryWorkflowVersionStore,
  ProtectedEventStore,
} from "@orca/store";

it("withholds identifiable legacy sensitive events from reads, replay and mutation", async () => {
  const raw = new InMemoryEventStore();
  const workflows = new InMemoryWorkflowVersionStore();
  const definition = parseWorkflow(
    `id: legacy\nname: Legacy\ninputSchema:\n  fields:\n    credentials:\n      type: object\n      properties:\n        token: { type: string, sensitive: true }\nstart: e\nnodes: { e: { type: end } }\nedges: []`,
  );
  await workflows.put(definition);
  const input = {
    type: "run.created" as const,
    runId: "legacy-run",
    payload: {
      workflowId: definition.id,
      workflowVersion: definition.version,
      workspace: { hostId: "local", cwd: "/tmp" },
      vars: { credentials: { token: "legacy-secret" } },
    },
  };
  await raw.append(input);
  const guarded = new ProtectedEventStore(raw, new InMemoryExecutionStore(), workflows);
  for (const read of [
    () => guarded.read("legacy-run"),
    () => guarded.readTypes("legacy-run", ["run.created"]),
    () => guarded.readRange("legacy-run", { after: 0 }),
  ]) {
    await expect(read()).rejects.toMatchObject({
      code: "RUN_STATE",
      message: "legacy sensitive execution requires explicit migration before reading or resuming",
    });
  }
  await expect(guarded.append({ type: "run.started", runId: "legacy-run", payload: {} })).rejects.toMatchObject({
    code: "RUN_STATE",
  });
  expect(await raw.read("legacy-run")).toHaveLength(1);
  expect(JSON.stringify(await raw.read("legacy-run"))).toContain("legacy-secret");
});

describe("ordinary legacy store compatibility", () => {
  for (const snapshot of [true, false])
    it(`keeps an ordinary run readable with snapshot=${snapshot}`, async () => {
      const raw = new InMemoryEventStore();
      const workflows = new InMemoryWorkflowVersionStore();
      const definition = parseWorkflow("id: legacy\nname: Legacy\nstart: e\nnodes: { e: { type: end } }\nedges: []");
      if (snapshot) await workflows.put(definition);
      await raw.append({
        type: "run.created",
        runId: "ordinary",
        payload: {
          workflowId: definition.id,
          workflowVersion: definition.version,
          workspace: { hostId: "local", cwd: "/tmp" },
          vars: { greeting: "hello" },
        },
      });
      const guarded = new ProtectedEventStore(raw, new InMemoryExecutionStore(), workflows);
      expect(await guarded.read("ordinary")).toEqual(await raw.read("ordinary"));
      await guarded.append({ type: "run.started", runId: "ordinary", payload: {} });
      expect(await guarded.read("ordinary")).toHaveLength(2);
    });
});
