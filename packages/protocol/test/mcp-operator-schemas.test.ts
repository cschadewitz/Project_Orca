/** Operator schema limits and allowlisted result fields. */
import { expect, it } from "vitest";
import {
  OperatorLaunchSelectionSchema,
  OperatorPageParamsSchema,
  OperatorRowSchema,
  OperatorPreflightParamsSchema,
} from "../src/operator-reads.js";
const target = { workspaceId: crypto.randomUUID(), instanceId: crypto.randomUUID() };
it("bounds pages and rejects actor/collection injection", () => {
  expect(OperatorPageParamsSchema.parse({ target, collection: "runs" }).limit).toBe(50);
  for (const limit of [0, 101, -1, 1.5])
    expect(OperatorPageParamsSchema.safeParse({ target, collection: "runs", limit }).success).toBe(false);
  expect(OperatorPageParamsSchema.safeParse({ target, collection: "config.get" }).success).toBe(false);
  expect(OperatorPreflightParamsSchema.safeParse({ target, purpose: "workflow", actor: "owner" }).success).toBe(false);
});
it("has an allowlisted output with no arbitrary payload, paths or config passthrough", () => {
  expect(
    OperatorRowSchema.parse({ id: "event", kind: "event", payload: { secret: "x" }, path: "/secret", config: {} }),
  ).toEqual({ id: "event", kind: "event" });
});

it("accepts additive guarded Request choices while refusing executable override injection", () => {
  const parsed = OperatorPreflightParamsSchema.parse({
    target,
    purpose: "request",
    request: { title: "Build", body: "Draft" },
    expectedWorkflowRevision: "revision",
    expectedConfigGeneration: "generation",
    overrides: { roles: { builder: "agent" }, model: { agent: "model" }, itemWorkflow: "item", templatePack: "pack" },
  });
  expect(parsed.vars).toEqual({});
  expect(parsed.overrides?.templatePack).toBe("pack");
  expect(
    OperatorPreflightParamsSchema.safeParse({ target, purpose: "request", overrides: { command: "execute" } }).success,
  ).toBe(false);
});

it("strips hosts, partial bodies and arbitrary generation material from effective selection metadata", () => {
  expect(
    OperatorLaunchSelectionSchema.parse({
      nodeId: "build",
      agent: { value: "agent", source: "config.roles", command: "PRIVATE" },
      host: { value: "PRIVATE", source: "agent.hostId" },
      template: { value: "base", source: "workflow.template", revision: "digest", partials: [{ body: "PRIVATE" }] },
      config: { token: "PRIVATE" },
    }),
  ).toEqual({
    nodeId: "build",
    agent: { value: "agent", source: "config.roles" },
    template: { value: "base", source: "workflow.template", revision: "digest" },
  });
});
