/** Production composition over the accepted operator aliases, independent checkout verification and encrypted journal. */
import {
  OperatorDiscoverySchema,
  OperatorConfigSchema,
  OperatorMutationContracts,
  ConfigGetResultSchema,
  WorkflowsListResultSchema,
  OperatorPreflightResultSchema,
  OperatorPageResultSchema,
} from "@orca/protocol";
import type { AdmissionRetryResult, OperatorRow } from "@orca/protocol";
import type { DaemonClient } from "../client/daemon-client.js";
import type { DaemonTargetSnapshot } from "../daemon-connection.js";
import { daemonEndpoint } from "../daemon-connection.js";
import type { WorkspaceSnapshot } from "../bridge.js";
import type {
  CheckoutEvidence,
  LaunchReview,
  PreflightParams,
  RetainedLaunch,
} from "../configuration-launch-contract.js";
import type { GuidedLaunchSnapshot, ProtectedGuidedLaunch } from "../guided-launch-bridge.js";
import { AdmissionIntents } from "./admission-intents.js";
import { GuidedLaunchController, type GuidedIntentConnection } from "./guided-launch.js";
import { canonicalGuidedValue, parseGuidedReview } from "./guided-intent-contract.js";
import { observePreparedCheckout } from "./guided-checkout.js";
import { verifyFirstRunSampleAssets } from "./first-run/sample-assets.js";
import { FIRST_RUN_SAMPLE, FIRST_RUN_SAMPLE_TASK } from "../first-run-sample.js";
import { launchSelectionProvenance } from "../launch-provenance.js";

export interface GuidedConnectionCapture {
  client: DaemonClient;
  target: DaemonTargetSnapshot;
  workspace: WorkspaceSnapshot;
  assertCurrent(): void;
}
const refuse = (): never => {
  throw new Error("Guided launch cannot verify the current authorized target, checkout or exact retained command.");
};
// Operator projections intentionally omit raw failure messages. Preserve the receipt with a safe fixed explanation.
function operatorReceipt(receipt: AdmissionRetryResult): AdmissionRetryResult {
  if (receipt.state !== "resolved") return receipt;
  const result = receipt.result as { state?: string; failure?: { code: string; recovery: "reconcile" } };
  if (result.state !== "recoverable-failure" || !result.failure) return receipt;
  return {
    ...receipt,
    result: {
      ...result,
      failure: {
        ...result.failure,
        message: "The original admission needs inspection or reconciliation before separate work is started.",
      },
    },
  };
}
export class GuidedLaunchAdapter {
  readonly controller: GuidedLaunchController;
  constructor(
    private readonly journal: AdmissionIntents,
    private readonly capture: () => GuidedConnectionCapture,
  ) {
    this.controller = new GuidedLaunchController(journal, () => this.connection());
  }
  private async current() {
    const original = this.capture();
    const captured = { ...original, client: original.client.withCapturedAuthentication() };
    captured.assertCurrent();
    const found = await captured.client.call("operator.discover", {}, OperatorDiscoverySchema, false);
    captured.assertCurrent();
    if (
      !captured.target.identity ||
      found.target.workspaceId !== captured.target.identity.workspaceId ||
      found.target.instanceId !== captured.target.identity.instanceId
    )
      refuse();
    const endpointId =
      captured.target.source === "bundled" ? `bundled:${captured.workspace.path}` : daemonEndpoint(captured.target.url);
    return {
      captured,
      found,
      scope: { target: endpointId, principalId: found.principalId, workspaceId: found.target.workspaceId },
    };
  }
  private async checkout(
    current: Awaited<ReturnType<GuidedLaunchAdapter["current"]>>,
    generation: string,
  ): Promise<CheckoutEvidence> {
    const config = await current.captured.client.call("config.get", {}, ConfigGetResultSchema, false);
    current.captured.assertCurrent();
    const result = await observePreparedCheckout(
      config,
      current.captured.target,
      current.captured.workspace,
      generation,
      { endpointId: current.scope.target, principalId: current.scope.principalId },
    );
    current.captured.assertCurrent();
    return result;
  }
  private async choices(current: Awaited<ReturnType<GuidedLaunchAdapter["current"]>>, generation: string) {
    if (!current.found.collections.includes("choices")) return undefined;
    const rows: OperatorRow[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await current.captured.client.call(
        "operator.page",
        {
          target: current.found.target,
          collection: "choices",
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
        OperatorPageResultSchema,
        false,
      );
      current.captured.assertCurrent();
      if (
        page.target.workspaceId !== current.found.target.workspaceId ||
        page.target.instanceId !== current.found.target.instanceId ||
        page.revision !== generation ||
        page.restartRequired ||
        page.items.some((row) => row.configGeneration !== generation) ||
        (page.truncated && !page.nextCursor)
      )
        refuse();
      rows.push(...page.items);
      if (rows.length > 1000) refuse();
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) refuse();
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    return rows;
  }
  async snapshot(): Promise<GuidedLaunchSnapshot> {
    const current = await this.current();
    let activeGeneration = "";
    let checkout: CheckoutEvidence;
    const workflows = [] as GuidedLaunchSnapshot["workflows"][number][];
    let choices: OperatorRow[] | undefined;
    try {
      const config = await current.captured.client.call(
        "operator.config",
        { target: current.found.target },
        OperatorConfigSchema,
        false,
      );
      activeGeneration = config.activeGeneration;
      checkout = await this.checkout(current, activeGeneration);
      const list = await current.captured.client.call("workflows.list", {}, WorkflowsListResultSchema, false);
      if (list.workflows.length > 100) refuse();
      for (const item of list.workflows) {
        try {
          const preflight = await current.captured.client.call(
            "operator.preflight",
            {
              target: current.found.target,
              purpose: "workflow",
              workflowId: item.id,
              workflowVersion: item.version,
              expectedConfigGeneration: activeGeneration,
              vars: {},
            },
            OperatorPreflightResultSchema,
            false,
          );
          current.captured.assertCurrent();
          if (
            preflight.target.workspaceId !== current.found.target.workspaceId ||
            preflight.target.instanceId !== current.found.target.instanceId ||
            preflight.expectedConfigGeneration !== activeGeneration ||
            preflight.workflowId !== item.id ||
            preflight.workflowVersion !== item.version ||
            preflight.inputSchema === undefined
          )
            refuse();
          if (
            item.id === FIRST_RUN_SAMPLE.id &&
            (preflight.workflowVersion !== FIRST_RUN_SAMPLE.version ||
              preflight.expectedWorkflowRevision !== FIRST_RUN_SAMPLE.revision)
          )
            refuse();
          if (item.id === FIRST_RUN_SAMPLE.id) await verifyFirstRunSampleAssets(current.captured.workspace.path);
          workflows.push({
            id: item.id,
            name: item.name,
            version: preflight.workflowVersion,
            revision: preflight.expectedWorkflowRevision,
            ...(preflight.inputSchema ? { inputSchema: preflight.inputSchema } : {}),
            ...(launchSelectionProvenance(preflight) === undefined
              ? {}
              : { selectionProvenance: launchSelectionProvenance(preflight)! }),
          });
        } catch {
          current.captured.assertCurrent();
        }
      }
      try {
        choices = await this.choices(current, activeGeneration);
      } catch {
        // Missing optional selection reads do not disable configured direct launches or recovery.
        choices = undefined;
        current.captured.assertCurrent();
      }
      const final = await current.captured.client.call(
        "operator.config",
        { target: current.found.target },
        OperatorConfigSchema,
        false,
      );
      if (final.activeGeneration !== activeGeneration) refuse();
    } catch {
      // Read authority/config failures disable new launches, not exact protected recovery under its own grants.
      workflows.length = 0;
      choices = undefined;
      checkout = {
        state: "unavailable",
        reason:
          "Current launch configuration or workflow bindings could not be verified. Read again after fixing setup.",
      };
    }
    current.captured.assertCurrent();
    return {
      target: { ...current.found.target, epoch: current.captured.target.epoch },
      endpointId: current.scope.target,
      principalId: current.found.principalId,
      operations: current.found.operations,
      activeGeneration,
      checkout,
      workflows,
      ...(choices === undefined ? {} : { choices }),
    };
  }
  async preflight(params: PreflightParams) {
    const current = await this.current();
    if (
      params.target.workspaceId !== current.found.target.workspaceId ||
      params.target.instanceId !== current.found.target.instanceId
    )
      refuse();
    const result = await current.captured.client.call(
      "operator.preflight",
      params,
      OperatorPreflightResultSchema,
      false,
    );
    if (
      params.workflowId === FIRST_RUN_SAMPLE.id &&
      (params.purpose !== "workflow" ||
        result.workflowVersion !== FIRST_RUN_SAMPLE.version ||
        result.expectedWorkflowRevision !== FIRST_RUN_SAMPLE.revision)
    )
      refuse();
    if (params.workflowId === FIRST_RUN_SAMPLE.id) await verifyFirstRunSampleAssets(current.captured.workspace.path);
    const checkout = await this.checkout(current, result.expectedConfigGeneration);
    current.captured.assertCurrent();
    return { preflight: result, checkout };
  }
  private async connection(): Promise<GuidedIntentConnection> {
    const current = await this.current();
    const { captured, found, scope } = current;
    const send = async (record: ReturnType<AdmissionIntents["guided"]>) => {
      const command = record.guided!.review.command;
      const method = command.mode === "direct" ? "operator.admitRun" : "operator.submitRequest";
      if (!found.operations.includes(method)) refuse();
      captured.assertCurrent();
      const contract = OperatorMutationContracts[method];
      const receipt = await captured.client.call(
        method,
        contract.params.parse({
          target: found.target,
          command: command.params,
          retry: { idempotencyKey: record.idempotencyKey },
        }),
        contract.result,
        false,
      );
      captured.assertCurrent();
      return { kind: "retry" as const, receipt: operatorReceipt(receipt) };
    };
    return {
      scope,
      target: { ...found.target, epoch: captured.target.epoch },
      assertCurrent: () => captured.assertCurrent(),
      verifyReview: async (review) => {
        if (
          review.workflowId === FIRST_RUN_SAMPLE.id &&
          (review.command.mode !== "direct" ||
            review.workflowVersion !== FIRST_RUN_SAMPLE.version ||
            review.expectedWorkflowRevision !== FIRST_RUN_SAMPLE.revision ||
            canonicalGuidedValue(review.command.params.vars ?? {}) !==
              canonicalGuidedValue({ task: FIRST_RUN_SAMPLE_TASK }))
        )
          refuse();
        if (review.workflowId === FIRST_RUN_SAMPLE.id) await verifyFirstRunSampleAssets(captured.workspace.path);
        if (
          review.command.mode === "request" &&
          review.command.params.overrides !== undefined &&
          !found.collections.includes("choices")
        )
          refuse();
        const check = await captured.client.call(
          "operator.preflight",
          {
            target: found.target,
            purpose: review.command.mode === "direct" ? "workflow" : "request",
            workflowId: review.workflowId,
            workflowVersion: review.workflowVersion,
            expectedWorkflowRevision: review.expectedWorkflowRevision,
            expectedConfigGeneration: review.expectedConfigGeneration,
            vars: review.command.params.vars ?? {},
            ...(review.command.mode === "request"
              ? {
                  request: {
                    title: review.command.params.title,
                    body: review.command.params.body,
                    ...(review.command.params.source === undefined ? {} : { source: review.command.params.source }),
                    ...(review.command.params.labels === undefined ? {} : { labels: review.command.params.labels }),
                  },
                  ...(review.command.params.overrides === undefined
                    ? {}
                    : { overrides: review.command.params.overrides }),
                }
              : {}),
          },
          OperatorPreflightResultSchema,
          false,
        );
        captured.assertCurrent();
        if (
          check.target.workspaceId !== found.target.workspaceId ||
          check.target.instanceId !== found.target.instanceId ||
          check.workflowId !== review.workflowId ||
          check.workflowVersion !== review.workflowVersion ||
          !check.validation.ok ||
          check.validation.errors.length ||
          check.expectedWorkflowRevision !== review.expectedWorkflowRevision ||
          check.expectedConfigGeneration !== review.expectedConfigGeneration
        )
          refuse();
        if (
          canonicalGuidedValue(launchSelectionProvenance(check) ?? null) !==
          canonicalGuidedValue(review.selectionProvenance ?? null)
        )
          refuse();
        const checkout = await this.checkout(current, review.expectedConfigGeneration);
        if (
          checkout.state !== "verified" ||
          review.checkout.state !== "verified" ||
          checkout.evidenceId !== review.checkout.evidenceId ||
          checkout.profile !== review.checkout.profile ||
          checkout.repository !== review.checkout.repository ||
          checkout.baseCommit !== review.checkout.baseCommit ||
          (checkout.profile === "prepared-local" &&
            (review.checkout.profile !== "prepared-local" ||
              checkout.cwd !== review.checkout.cwd ||
              checkout.branch !== review.checkout.branch))
        )
          refuse();
        captured.assertCurrent();
      },
      verifyRecovery: async (record) => {
        if (
          record.principalId !== found.principalId ||
          record.workspaceId !== found.target.workspaceId ||
          record.target !== scope.target ||
          (!found.operations.includes("operator.admission") &&
            !found.operations.includes("operator.reconcileAdmission"))
        )
          refuse();
        captured.assertCurrent();
      },
      send,
      recover: async (record, action) => {
        if (!record.guided?.operationId) {
          if (action === "inspect") return refuse();
          return send(record);
        }
        const method = action === "inspect" ? "operator.admission" : "operator.reconcileAdmission";
        if (!found.operations.includes(method)) return refuse();
        const contract = OperatorMutationContracts[method];
        const receipt = await captured.client.call(
          method,
          { target: found.target, operationId: record.guided.operationId },
          contract.result,
          false,
        );
        captured.assertCurrent();
        return { kind: "retry", receipt: operatorReceipt(receipt) };
      },
    };
  }
  async load(id: string): Promise<ProtectedGuidedLaunch> {
    const current = await this.current();
    const record = this.journal.guided(current.scope, id);
    const intent = this.journal.guidedList(current.scope).find((entry) => entry.intentId === id);
    if (!intent) return refuse();
    current.captured.assertCurrent();
    return { intent, review: parseGuidedReview(record.guided!.review) };
  }
  async resolve(raw: LaunchReview): Promise<RetainedLaunch | undefined> {
    const review = parseGuidedReview(raw);
    const current = await this.current();
    const retained = this.journal.guidedList(current.scope).filter((item) => item.workflowId === review.workflowId);
    const matched = retained.find(
      (item) =>
        canonicalGuidedValue(this.journal.guided(current.scope, item.intentId).guided!.review) ===
        canonicalGuidedValue(review),
    );
    current.captured.assertCurrent();
    return matched;
  }
}
