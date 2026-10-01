/** Compatibility fixtures for the independent #328/#330 branches; no feature is enabled here. */
import { describe, expect, it } from "vitest";
import { OrcaError } from "@orca/core/schemas";
import type { ValidationResult } from "@orca/core";
import { AUTH_ERROR_CODES, ProtocolFault, parseMessage, protocolError } from "@orca/protocol";

describe("runtime foundation error contracts", () => {
  it("keeps launch-input diagnostics distinct from workflow-definition errors", () => {
    const validation: ValidationResult = {
      ok: false,
      errors: [{ path: "vars.count", message: "Expected a number" }],
      warnings: [{ path: "vars.extra", message: "Undeclared input is preserved" }],
    };
    const details = { errors: validation.errors, warnings: validation.warnings };
    const error = new OrcaError("WORKFLOW_INPUT_INVALID", "Workflow inputs are invalid", details).toJSON();
    const response = { kind: "response", id: "input-check", ok: false, error };
    expect(parseMessage(JSON.stringify(response))).toEqual(response);
    expect(error.details).toEqual(details);
    expect(protocolError("WORKFLOW_INVALID", "Invalid definition").code).not.toBe(error.code);
  });

  it.each(AUTH_ERROR_CODES)("carries %s through the existing fault and response envelope", (code) => {
    const error = new ProtocolFault(code, "Generic security refusal").toJSON();
    expect(error).toEqual({ code, message: "Generic security refusal" });
    const response = { kind: "response", id: 1, ok: false, error };
    expect(parseMessage(JSON.stringify(response))).toEqual(response);
  });

  it("retains forward-compatible parsing of error codes", () => {
    const response = {
      kind: "response",
      id: 1,
      ok: false,
      error: { code: "FUTURE_ERROR", message: "Newer daemon" },
    };
    expect(parseMessage(JSON.stringify(response))).toEqual(response);
  });
});
