import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_DRAFT_METHOD_CONTRACTS } from "@orca/protocol";
import { callWorkflowDraft } from "../src/client/workflow-draft-client.js";

describe("workflow draft client bindings (#180)", () => {
  it("parses params against the method's contract and passes its result schema to the daemon", async () => {
    const call = vi.fn().mockResolvedValue({ discarded: true });
    const params = { workflowId: "triage", expectedRevision: 3 };
    await expect(callWorkflowDraft({ call }, "workflowDrafts.discard", params)).resolves.toEqual({ discarded: true });
    expect(call).toHaveBeenCalledWith(
      "workflowDrafts.discard",
      params,
      WORKFLOW_DRAFT_METHOD_CONTRACTS["workflowDrafts.discard"].result,
    );
  });

  it("refuses params the contract does not accept before anything reaches the daemon", async () => {
    const call = vi.fn();
    await expect(callWorkflowDraft({ call }, "workflowDrafts.get", { workflowId: "Not An Id" })).rejects.toThrow();
    await expect(
      callWorkflowDraft({ call }, "workflowDrafts.undo", { workflowId: "triage", expectedRevision: 1, extra: true }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("accepts only the closed method inventory, not inherited or arbitrary names", async () => {
    const call = vi.fn();
    for (const method of ["workflows.list", "toString", "__proto__"]) {
      await expect(callWorkflowDraft({ call }, method as never, { workflowId: "triage" })).rejects.toThrow(
        "Workflow draft method unavailable.",
      );
    }
    expect(call).not.toHaveBeenCalled();
  });
});
