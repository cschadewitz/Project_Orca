import { expect, it } from "vitest";
import type { ResponseMessage } from "@orca/protocol";
import { readinessRpcResult } from "./mcp-operator-production-fixture.js";

const refused = (code: string, message: string, details?: Record<string, unknown>): ResponseMessage => ({
  kind: "response",
  id: "read",
  ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});
it("keeps a known changed snapshot distinct from a successful empty result", () => {
  expect(readinessRpcResult(refused("RUN_STATE", "Event observation history changed"))).toEqual({ changed: true });
  const result = { inputs: [], waiting: 0 };
  expect(readinessRpcResult({ kind: "response", id: "read", ok: true, result })).toEqual({ changed: false, result });
});
it.each([
  ["RUN_STATE", "protected execution record or key is missing, invalid or unreadable"],
  ["RUN_STATE", "Event observation requires complete records"],
  ["RUN_STATE", "Event observation exceeds its byte limit"],
  ["RUN_STATE", "Continuation durability could not be verified"],
  ["RUN_STATE", "Revision observation changed or is incomplete; refresh before acting"],
  ["AUTH_INVALID", "Event observation history changed"],
  ["AUTH_FORBIDDEN", "Operation is not authorized"],
  ["STORE_LOCK_TIMEOUT", "Event observation history changed"],
  ["PROTOCOL_MESSAGE", "This collection requires runId"],
])("does not conceal %s: %s", (code, message) => {
  expect(() => readinessRpcResult(refused(code, message))).toThrow(`Backing RPC refused: ${code}`);
});
it("fails closed if a future refusal changes the known error shape", () => {
  expect(() =>
    readinessRpcResult(refused("RUN_STATE", "Event observation history changed", { unknown: true })),
  ).toThrow();
});
