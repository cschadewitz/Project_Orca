/** Wire contract rejects caller authority, note overloading and unbounded revision material. */
import { expect, it } from "vitest";
import { InputsReviseParamsSchema, RevisionPayloadSchema, RevisionReceiptSchema } from "../src/revision-input.js";
const command = {
  target: { runId: "run", stepRunId: "step", requestId: "input", destinationId: "dest", expectedRevision: "rev" },
  actionId: "changes",
  payload: { kind: "text", text: "Correction" },
};
it("parses the separate action and retry envelope", () => {
  expect(InputsReviseParamsSchema.parse({ command, retry: { idempotencyKey: "intent" } }).command).toEqual(command);
  for (const extra of [{ note: "also change this" }, { principalId: "owner" }, { always: true }])
    expect(InputsReviseParamsSchema.safeParse({ command: { ...command, ...extra }, retry: {} }).success).toBe(false);
});
it("counts UTF-8 bytes rather than characters", () => {
  expect(RevisionPayloadSchema.safeParse({ kind: "text", text: "é".repeat(32769) }).success).toBe(false);
  expect(InputsReviseParamsSchema.safeParse({ command, retry: { idempotencyKey: "é".repeat(65) } }).success).toBe(
    false,
  );
});
it("requires the server attempt and current revision in every receipt", () => {
  expect(RevisionReceiptSchema.safeParse({ revisionId: "rev", target: command.target, state: "pending" }).success).toBe(
    false,
  );
});
