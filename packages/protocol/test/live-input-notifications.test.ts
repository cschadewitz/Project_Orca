import { expect, it } from "vitest";
import {
  INPUT_INVALIDATED,
  InputInvalidatedParamsSchema,
  NOTIFICATION_METHODS,
  SubscribeParamsSchema,
  parseNotification,
} from "../src/index.js";
const target = {
  instanceId: "boot",
  sessionId: "session",
  turnId: "turn",
  invocationId: "invocation",
  runId: "run",
  stepRunId: "step",
  requestId: "ask",
};
const params = { subscriptionId: "subscription", runId: target.runId, target, at: "2026-10-02T00:00:00Z" };
it("parses an exact ephemeral invalidation without fabricating a durable sequence", () => {
  expect(NOTIFICATION_METHODS).toContain(INPUT_INVALIDATED);
  expect(SubscribeParamsSchema.parse({ methods: [INPUT_INVALIDATED] }).methods).toEqual([INPUT_INVALIDATED]);
  expect(parseNotification({ method: INPUT_INVALIDATED, params })).toEqual({ method: INPUT_INVALIDATED, params });
  expect(InputInvalidatedParamsSchema.parse({ ...params, seq: 99 })).not.toHaveProperty("seq");
});
it("rejects mismatched resource scope and incomplete callback identities", () => {
  expect(parseNotification({ method: INPUT_INVALIDATED, params: { ...params, runId: "other" } })).toBeUndefined();
  for (const key of Object.keys(target)) {
    const incomplete = { ...target } as Record<string, string>;
    delete incomplete[key];
    expect(parseNotification({ method: INPUT_INVALIDATED, params: { ...params, target: incomplete } })).toBeUndefined();
  }
});
