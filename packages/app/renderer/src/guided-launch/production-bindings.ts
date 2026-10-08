/** Production UI bindings over the shared guarded bridge; no renderer journal or execution key. */
import { RequestsSubmitResultSchema, RunsAdmitResultSchema, type RunsAdmitResult } from "@orca/protocol";
import type { BridgeResult, OrcaBridge } from "../../../src/bridge.js";
import type { GuidedLaunchSnapshot, ProtectedGuidedLaunch } from "../../../src/guided-launch-bridge.js";
import type {
  LaunchContext,
  LaunchDraft,
  LaunchPorts,
  LaunchReceipt,
  LaunchReview,
  LaunchTarget,
} from "./contracts.js";
import { LaunchPortFailure } from "./contracts.js";
import { sameLaunchTarget } from "./controller.js";
import { sharedLaunchResult, sharedLaunchReview, sharedSubmission } from "./shared-bindings.js";

export const CONFIGURED_ROOT = "configured-project";
export function unwrap<T>(value: BridgeResult<T>): T {
  if (value.ok) return value.result;
  throw new LaunchPortFailure(value.error.code === "AUTH_FORBIDDEN" ? "unauthorized" : "unavailable");
}
export function launchContext(snapshot: GuidedLaunchSnapshot): LaunchContext {
  const checkout = snapshot.checkout;
  const modes = (["direct", "request"] as const).filter((mode) =>
    snapshot.operations.includes(mode === "direct" ? "operator.admitRun" : "operator.submitRequest"),
  );
  return {
    target: { ...snapshot.target, endpointId: snapshot.endpointId, principalId: snapshot.principalId },
    activeGeneration: snapshot.activeGeneration,
    ...(!modes.includes("direct")
      ? { directReason: "This principal cannot start workflows on the current target." }
      : {}),
    ...(!modes.includes("request")
      ? { requestReason: "This principal cannot submit Requests on the current target." }
      : {}),
    roots: [
      {
        id: CONFIGURED_ROOT,
        label: "Configured project checkout",
        evidence:
          checkout.state === "verified"
            ? {
                state: "verified",
                revision: checkout.evidenceId,
                summary: `${checkout.repository} / ${checkout.profile === "prepared-local" ? checkout.branch : checkout.branchPrefix} / base ${checkout.baseCommit}`,
              }
            : checkout,
      },
    ],
    workflows: snapshot.workflows.map((workflow) => ({
      ...workflow,
      modes,
      rootIds: [CONFIGURED_ROOT],
      provenance: [
        `Registered workflow ${workflow.id} / ${workflow.version}`,
        `Revision ${workflow.revision}`,
        `Active configuration ${snapshot.activeGeneration}.`,
        "Detailed agent, model and instruction provenance is unavailable here; review the workflow and Config.",
      ],
    })),
  };
}
function decode(raw: unknown, mode: LaunchDraft["mode"], operationId?: string): LaunchReceipt {
  if (mode === "request") return RequestsSubmitResultSchema.parse(raw);
  // The core receipt omits operationId; retain/validate the actual retry envelope's ID.
  const receipt = RunsAdmitResultSchema.parse({ ...Object(raw), operationId }) as RunsAdmitResult;
  const { operationId: _operationId, ...result } = receipt;
  return result;
}
export function restoredLaunch(saved: ProtectedGuidedLaunch, target: LaunchTarget) {
  const source = saved.review;
  const checkout = source.checkout;
  if (checkout.state !== "verified") throw new LaunchPortFailure("unavailable");
  const command = source.command;
  const review: LaunchReview = {
    target: { ...target, ...source.target },
    draftSequence: source.draftSequence,
    rootId: CONFIGURED_ROOT,
    rootRevision: checkout.evidenceId,
    workflowId: source.workflowId,
    workflowVersion: source.workflowVersion,
    workflowRevision: source.expectedWorkflowRevision,
    generation: source.expectedConfigGeneration,
    command,
    warnings: [],
    visibleInputs: [],
    checkout,
  };
  const draft: LaunchDraft = {
    mode: command.mode,
    rootId: CONFIGURED_ROOT,
    workflowId: source.workflowId,
    vars: structuredClone(command.params.vars ?? {}),
    title: command.mode === "request" ? command.params.title : "",
    body: command.mode === "request" ? command.params.body : "",
    ...(command.mode === "request" && command.params.overrides !== undefined
      ? { overrides: command.params.overrides }
      : {}),
  };
  return { review, draft, intent: { id: saved.intent.intentId } };
}
export function productionPorts(
  bridge: NonNullable<OrcaBridge["guidedLaunch"]>,
  binding: {
    current: () => LaunchContext;
    selectedIntent: () => string;
    live: () => boolean;
    navigate: LaunchPorts["navigate"];
    announce: LaunchPorts["announce"];
  },
): LaunchPorts {
  const assertCurrent = (target: LaunchTarget) => {
    const raw = window.orca.daemonConnection?.read();
    if (
      !binding.live() ||
      !sameLaunchTarget(target, binding.current().target) ||
      (raw &&
        (!raw.identity ||
          raw.epoch !== target.epoch ||
          raw.identity.workspaceId !== target.workspaceId ||
          raw.identity.instanceId !== target.instanceId))
    )
      throw new LaunchPortFailure("stale");
  };
  return {
    preflight: async (candidate) => {
      assertCurrent(candidate.target);
      if (candidate.rootId !== CONFIGURED_ROOT || candidate.overrides !== undefined)
        throw new LaunchPortFailure("unavailable");
      const result = unwrap(
        await bridge.preflight({
          target: { workspaceId: candidate.target.workspaceId, instanceId: candidate.target.instanceId },
          purpose: candidate.mode === "direct" ? "workflow" : "request",
          workflowId: candidate.workflowId,
          workflowVersion: candidate.workflowVersion,
          vars: candidate.vars,
        }),
      );
      assertCurrent(candidate.target);
      if (result.checkout.state !== "verified") throw new LaunchPortFailure("unavailable");
      return {
        ...result.preflight,
        rootId: CONFIGURED_ROOT,
        rootRevision: result.checkout.evidenceId,
        checkout: result.checkout,
      };
    },
    launch: sharedSubmission(
      { submit: async (review) => unwrap(await bridge.submit(review)) },
      { assertCurrent, decodeRetryReceipt: decode },
    ),
    resolveIntent: async (review) => {
      const target = binding.current().target;
      assertCurrent(target);
      if (!review.checkout) throw new LaunchPortFailure("unavailable");
      const retained = unwrap(await bridge.resolve(sharedLaunchReview(review, review.checkout)));
      assertCurrent(target);
      return retained ? { id: retained.intentId } : undefined;
    },
    recover: async (intent) => {
      const target = binding.current().target;
      assertCurrent(target);
      const response = unwrap(await bridge.recover({ id: intent.id, action: "reconcile" }));
      assertCurrent(target);
      // Exact protected mode is read under the same authority; never decode as the current workflow choice.
      const saved = unwrap(await bridge.load(intent.id));
      assertCurrent(target);
      return sharedLaunchResult(response, saved.review.command.mode, decode);
    },
    restore: async (target) => {
      assertCurrent(target);
      const id = binding.selectedIntent();
      if (!id) throw new LaunchPortFailure("unavailable");
      const saved = unwrap(await bridge.load(id));
      assertCurrent(target);
      return restoredLaunch(saved, target);
    },
    abandon: async (intent) => {
      const target = binding.current().target;
      assertCurrent(target);
      const result = unwrap(await bridge.abandon(intent.id));
      assertCurrent(target);
      return result.abandoned;
    },
    navigate: binding.navigate,
    announce: binding.announce,
  };
}
