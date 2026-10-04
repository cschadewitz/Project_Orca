/** Unsupported adapters never downgrade a correction to an ordinary answer/note. */
import { expect, it, vi } from "vitest";
import { RevisionInputClient } from "../src/commands/revision-input.js";
it.each(["CLI", "ACP", "MCP"])("%s without negotiated revision methods fails explicitly", () => {
  const call = vi.fn();
  const client = new RevisionInputClient({ capabilities: [], call });
  expect(() =>
    client.submit(
      {
        target: { runId: "r", stepRunId: "s", requestId: "i", destinationId: "d", expectedRevision: "v" },
        actionId: "changes",
        payload: { kind: "text", text: "fix" },
      },
      "intent",
    ),
  ).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED" }));
  expect(call).not.toHaveBeenCalled();
});
it("keeps the supplied intent key and uses the separate operation", async () => {
  const call = vi.fn().mockResolvedValue({ state: "in-progress", operationId: "op", recovery: "inspect-or-retry" });
  const client = new RevisionInputClient({ capabilities: ["inputs.revise"], call });
  const command = {
    target: { runId: "r", stepRunId: "s", requestId: "i", destinationId: "d", expectedRevision: "v" },
    actionId: "changes",
    payload: { kind: "text" as const, text: "fix" },
  };
  await client.submit(command, "same-intent");
  await client.submit(command, "same-intent");
  expect(call.mock.calls[0]).toEqual(call.mock.calls[1]);
  expect(call.mock.calls[0]).toEqual(["inputs.revise", { command, retry: { idempotencyKey: "same-intent" } }]);
});
