import { describe, expect, it, vi } from "vitest";
import {
  ConfigApplyResultSchema,
  OperatorPreflightResultSchema,
  WorkflowsValidateInputsResultSchema,
} from "@orca/protocol";
import { DaemonClient } from "../src/client/daemon-client.js";

describe("configuration and coherent launch client bindings", () => {
  it("passes exact revision and generation guards to explicit apply", async () => {
    const client = new DaemonClient("http://127.0.0.1:6722");
    const call = vi.spyOn(client, "call").mockResolvedValue({});
    const params = { expectedRevision: "revision", expectedGeneration: "generation", validateOnly: true };
    await client.configApply(params);
    expect(call).toHaveBeenCalledWith("config.apply", params, ConfigApplyResultSchema);
  });
  it("preserves typed false zero empty and null inputs through preflight without unguarded config assembly", async () => {
    const client = new DaemonClient("http://127.0.0.1:6722");
    const call = vi.spyOn(client, "call").mockResolvedValue({});
    const params = {
      target: {
        workspaceId: "00000000-0000-4000-8000-000000000001",
        instanceId: "00000000-0000-4000-8000-000000000002",
      },
      purpose: "workflow" as const,
      workflowId: "sample",
      vars: { count: 0, enabled: false, note: "", nullable: null },
    };
    await client.operatorPreflight(params);
    expect(call).toHaveBeenCalledWith("operator.preflight", params, OperatorPreflightResultSchema);
    await client.workflowsValidateInputs({ workflowId: "sample", vars: params.vars });
    expect(call).toHaveBeenLastCalledWith(
      "workflows.validateInputs",
      { workflowId: "sample", vars: params.vars },
      WorkflowsValidateInputsResultSchema,
    );
  });
});
