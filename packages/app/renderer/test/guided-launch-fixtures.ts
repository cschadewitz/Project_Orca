import { vi } from "vitest";
import type { LaunchContext, LaunchDraft, LaunchPorts } from "../src/guided-launch/contracts.js";

export const launchContext = (): LaunchContext => ({
  target: {
    endpointId: "synthetic-target",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
    principalId: "operator",
    epoch: 1,
  },
  activeGeneration: "generation-1",
  roots: [
    {
      id: "disposable-root",
      label: "Synthetic disposable checkout",
      evidence: { state: "verified", revision: "root-evidence-1", summary: "Synthetic owned checkout at frozen base" },
    },
  ],
  workflows: [
    {
      id: "synthetic-work",
      name: "Synthetic work",
      version: "1",
      revision: "digest-1",
      modes: ["direct", "request"],
      rootIds: ["disposable-root"],
      provenance: ["Synthetic configured agent and instructions"],
      inputSchema: {
        fields: {
          task: { type: "string", required: true },
          count: { type: "integer", default: 2 },
          enabled: { type: "boolean" },
          token: { type: "string", sensitive: true },
        },
      },
    },
  ],
});
export const launchDraft = (): LaunchDraft => ({
  mode: "direct",
  rootId: "disposable-root",
  workflowId: "synthetic-work",
  title: "New task",
  body: "Request body",
  vars: { task: "Make a small change" },
});
export function launchPorts(context = launchContext()) {
  return {
    preflight: vi.fn<LaunchPorts["preflight"]>().mockResolvedValue({
      target: context.target,
      workflowId: "synthetic-work",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: "generation-1",
      rootId: "disposable-root",
      rootRevision: "root-evidence-1",
      validation: { ok: true, errors: [], warnings: [] },
      inputSchema: context.workflows[0]!.inputSchema!,
    }),
    retain: vi.fn<NonNullable<LaunchPorts["retain"]>>().mockResolvedValue({ id: "protected-intent-1" }),
    submit: vi.fn<NonNullable<LaunchPorts["submit"]>>().mockResolvedValue({
      state: "accepted",
      operationId: "retry-original",
      admissionId: "admission-original",
      runId: "run-original",
    }),
    recover: vi.fn<LaunchPorts["recover"]>().mockResolvedValue({
      state: "resolved",
      operationId: "retry-original",
      replayed: true,
      result: { state: "accepted", admissionId: "admission-original", runId: "run-original" },
    }),
    abandon: vi.fn<NonNullable<LaunchPorts["abandon"]>>().mockResolvedValue(true),
    navigate: vi.fn<LaunchPorts["navigate"]>(),
    announce: vi.fn<LaunchPorts["announce"]>(),
  } satisfies LaunchPorts;
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
