/** Claim-release recovery projects durable outcomes without disturbing resumable children. */
import { describe, expect, it } from "vitest";
import { recoverReleasedWorkItem } from "@orca/engine";
import { memoryStores } from "@orca/store";
import type { RunOutcome, RunStatus, WorkItemStatus } from "@orca/core";

describe("released work item recovery", () => {
  it.each<[RunStatus, RunOutcome | undefined, WorkItemStatus]>([
    ["completed", "success", "done"],
    ["completed", "failure", "failed"],
    ["failed", undefined, "failed"],
    ["cancelled", undefined, "cancelled"],
    ["running", undefined, "in-progress"],
    ["paused", undefined, "in-progress"],
    ["waiting", undefined, "in-progress"],
  ])("projects %s / %s as %s", async (status, outcome, expected) => {
    const stores = memoryStores();
    await stores.workItems.put({
      id: "wi_1",
      requestId: "req_1",
      slug: "api",
      title: "API",
      description: "",
      kind: "task",
      acceptanceCriteria: [],
      dependsOn: [],
      priority: "normal",
      produced: {},
      status: "in-progress",
      runId: "run_child",
      createdAt: "t",
      updatedAt: "t",
    });
    const changes = await recoverReleasedWorkItem(
      stores,
      "wi_1",
      {
        id: "run_child",
        status,
        ...(outcome ? { outcome } : {}),
      },
      "later",
    );
    expect((await stores.workItems.get("wi_1"))?.status).toBe(expected);
    expect(changes).toHaveLength(expected === "in-progress" ? 0 : 1);
  });
});
