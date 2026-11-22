/** Prompt direct-run receipts. Execution is a separate, currently authorized attachment. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OrcaError, OrcaEventSchema, RunOriginSchema } from "@orca/core";
import type { MutationActor } from "@orca/core";
import type {
  DirectAdmissionAuthority,
  DirectAdmissionCommand,
  DirectAdmissionResult,
  JsonValue,
  RetryContext,
  RetryOperation,
  RetryOptions,
  RetryResult,
} from "../../core/src/model/admission-retry.js";
import type { Orchestrator } from "./orchestrator.js";
import type { BoundLaunchOptions, CapturedLaunch, LaunchSelection } from "./configuration-generation.js";
import { canonicalJson, type RegisteredRetryClaims } from "./admission-retry.js";
import {
  publishAdmissionExecutionPolicy,
  requireAdmissionExecutionPolicy,
  type AdmissionExecutionBinding,
} from "./admission-execution.js";

export const DirectAdmissionCommandSchema = z.strictObject({
  workflowId: z.string().min(1),
  vars: z.record(z.string(), z.unknown()).optional(),
  workflowVersion: z.string().min(1).optional(),
  expectedWorkflowRevision: z.string().min(1).optional(),
  expectedConfigGeneration: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  workItemId: z.string().min(1).optional(),
  origin: RunOriginSchema.optional(),
  /** A named git ref the run works from (#883): checked before admission, fetched at creation. */
  gitRef: z.string().min(1).max(200).optional(),
  fence: z.literal(true).optional(),
});
/** Reserved orchestrator/generation integration supplies this explicit capability. */
export interface DirectCapturedLaunch extends CapturedLaunch {
  readonly admissionRunIds: true;
  startRun(options: BoundLaunchOptions & { admissionRunId?: string; directAdmissionId?: string }): Promise<string>;
}
export interface RecordedDirectLaunch {
  generationId: string;
  workflow: { id: string; version: string; revision: string };
}
const BindingSchema = z.strictObject({ admissionId: z.string(), runId: z.string(), materialId: z.string() });
const MaterialSchema = z.object({
  command: DirectAdmissionCommandSchema,
  actor: z.object({ principalId: z.string(), credentialId: z.string().optional() }),
  workspaceId: z.string(),
  generationId: z.string(),
  workflow: z.object({ id: z.string(), version: z.string(), revision: z.string() }),
});
const unavailable = () => new OrcaError("RUN_STATE", "Direct admission is unavailable");
/** A fence's receipt, bound like any admission: stable for its operation, so a replay answers the same. */
async function fenced(context: RetryContext): Promise<DirectAdmissionResult> {
  const admissionId = `fence_${context.operationId}`;
  if (!(await context.readBinding())) await context.bind({ admissionId, fence: true });
  return { state: "fenced", admissionId };
}
const failure = {
  code: "RUN_STATE",
  message: "Direct admission is incomplete; reconcile the original admission",
  recovery: "reconcile",
} as const;

export class DirectAdmissionService {
  private readonly authorities = new AsyncLocalStorage<DirectAdmissionAuthority>();
  private readonly operation: RetryOperation<DirectAdmissionCommand, DirectAdmissionResult>;
  constructor(
    private readonly options: {
      orchestrator: Orchestrator;
      retries: RegisteredRetryClaims;
      captureLaunch(selection: LaunchSelection): Promise<DirectCapturedLaunch>;
      restoreLaunch(recorded: RecordedDirectLaunch): Promise<DirectCapturedLaunch>;
    },
  ) {
    this.operation = options.retries.register(
      {
        kind: "run.admit",
        canonicalize: (input: DirectAdmissionCommand) => {
          const parsed = DirectAdmissionCommandSchema.safeParse(input);
          if (!parsed.success) throw new OrcaError("WORKFLOW_INPUT_INVALID", "Invalid direct admission");
          return JSON.parse(
            canonicalJson(
              {
                ...Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)),
                vars: parsed.data.vars ?? {},
              },
              false,
            ),
          ) as JsonValue;
        },
        validateFresh: async (command) => {
          // A fence launches nothing, so there is no launch to validate.
          if (command.fence) return;
          await this.validateLaunch(command);
        },
        prepare: (command, context) => (command.fence ? fenced(context) : this.prepare(command, context)),
        recover: (command, context) => (command.fence ? fenced(context) : this.recover(command, context)),
      },
      undefined,
      (command, binding, receipt, operationId) => this.verifyAccepted(command, binding, receipt, operationId),
    );
  }
  withRetryAuthority<T>(authority: DirectAdmissionAuthority, action: () => Promise<T>): Promise<T> {
    return this.authorities.run(authority, action);
  }
  private authority(): DirectAdmissionAuthority {
    const authority = this.authorities.getStore();
    if (!authority) throw unavailable();
    return authority;
  }
  admitRun(
    command: DirectAdmissionCommand,
    retry: RetryOptions,
    authority: DirectAdmissionAuthority,
  ): Promise<RetryResult<DirectAdmissionResult>> {
    return this.withRetryAuthority(authority, () =>
      this.options.retries.execute(this.operation, command, retry, {
        principalId: authority.actor.principalId,
        workspaceId: authority.workspaceId,
        authorize: (value) => authority.authorize(value),
      }),
    );
  }
  /**
   * Fence an idempotency key (#883): claim it for `workflowId` with a command no admission ever
   * sends, so a later `runs.admit` under the key conflicts instead of admitting a run. A key
   * already claimed by an admission answers that admission's receipt, or conflicts.
   */
  fence(
    workflowId: string,
    retry: RetryOptions,
    authority: DirectAdmissionAuthority,
  ): Promise<RetryResult<DirectAdmissionResult>> {
    return this.admitRun({ workflowId, fence: true }, retry, authority);
  }
  /** Read-only preflight, repeated during preparation after the retry claim is published. */
  private async validateLaunch(command: DirectAdmissionCommand): Promise<DirectCapturedLaunch> {
    const { workflowId, workflowVersion, expectedWorkflowRevision, expectedConfigGeneration } = command;
    const launch = await this.options.captureLaunch({
      purpose: "workflow",
      workflowId,
      ...(workflowVersion ? { workflowVersion } : {}),
      ...(expectedWorkflowRevision ? { expectedWorkflowRevision } : {}),
      ...(expectedConfigGeneration ? { expectedConfigGeneration } : {}),
    });
    if (!launch.admissionRunIds)
      throw new OrcaError("NOT_SUPPORTED", "Direct launch provider must support reserved run identities");
    await launch.validateStartRun(this.launchOptions(command, this.authority().actor));
    return launch;
  }
  private async prepare(command: DirectAdmissionCommand, context: RetryContext): Promise<DirectAdmissionResult> {
    const launch = await this.validateLaunch(command);
    const binding = {
      admissionId: `direct_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      materialId: `direct-material-${randomUUID()}`,
    };
    const authority = this.authority();
    // Bind before any admission effects. An interrupted unsealed reservation stays recoverable,
    // never recaptures current defaults or substitutes a different run.
    await context.bind(binding);
    await this.options.orchestrator.stores.execution.putGeneration(binding.materialId, {
      command,
      actor: authority.actor,
      workspaceId: authority.workspaceId,
      generationId: launch.generationId,
      workflow: launch.workflow,
    });
    return this.admit(command, context, binding, launch, authority.actor);
  }
  private launchOptions(command: DirectAdmissionCommand, actor: MutationActor): BoundLaunchOptions {
    return {
      actor,
      vars: command.vars ?? {},
      ...(command.requestId ? { requestId: command.requestId } : {}),
      ...(command.workItemId ? { workItemId: command.workItemId } : {}),
      ...(command.origin ? { origin: command.origin } : {}),
      ...(command.gitRef !== undefined ? { gitRef: command.gitRef } : {}),
    };
  }
  private async recover(command: DirectAdmissionCommand, context: RetryContext): Promise<DirectAdmissionResult> {
    const binding = BindingSchema.parse(await context.readBinding());
    try {
      const material = await this.material(binding, command);
      await context.reauthorize();
      if (await this.findRun(binding, material)) return await this.accept(binding, context, material);
      // A private run record without run.created may have provisioned external workspace state.
      // Do not repeat that uncertain side effect; preserve the reserved identity for inspection.
      if (await this.options.orchestrator.stores.execution.getInputs(binding.runId))
        return { state: "recoverable-failure", admissionId: binding.admissionId, runId: binding.runId, failure };
      const launch = await this.options.restoreLaunch(material);
      if (
        !launch.admissionRunIds ||
        launch.generationId !== material.generationId ||
        canonicalJson(launch.workflow) !== canonicalJson(material.workflow)
      )
        throw unavailable();
      return this.admit(command, context, binding, launch, material.actor);
    } catch {
      return { state: "recoverable-failure", admissionId: binding.admissionId, runId: binding.runId, failure };
    }
  }

  private async findRun(
    binding: z.infer<typeof BindingSchema>,
    material: z.infer<typeof MaterialSchema>,
  ): Promise<boolean> {
    const { stores } = this.options.orchestrator;
    const first = (await stores.events.readRange(binding.runId, { limit: 1 }))[0];
    if (!first) return false;
    if (first.type !== "run.created" || !first.executionPayloadRef) throw unavailable();
    if (!stores.events.synchronizeEvent) throw unavailable();
    const original = await stores.events.synchronizeEvent(first);
    const payload = original.payload;
    const parsed = OrcaEventSchema.safeParse(original);
    const correlation = z.object({ directAdmissionId: z.string() }).safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.type !== "run.created" ||
      !correlation.success ||
      correlation.data.directAdmissionId !== binding.admissionId
    )
      throw unavailable();
    const root = parsed.data.payload;
    if (
      root.actor?.principalId !== material.actor.principalId ||
      root.workflowId !== material.workflow.id ||
      root.workflowVersion !== material.workflow.version ||
      root.parentRunId ||
      root.requestId !== material.command.requestId ||
      root.workItemId !== material.command.workItemId ||
      canonicalJson(root.origin ?? null) !== canonicalJson(material.command.origin ?? null) ||
      root.workspace.rootProvisioning?.ref !== material.command.gitRef
    )
      throw unavailable();
    return true;
  }
  private async admit(
    command: DirectAdmissionCommand,
    context: RetryContext,
    binding: z.infer<typeof BindingSchema>,
    launch: DirectCapturedLaunch,
    actor: MutationActor,
  ): Promise<DirectAdmissionResult> {
    try {
      await context.reauthorize();
      const runId = await launch.startRun({
        ...this.launchOptions(command, actor),
        admissionRunId: binding.runId,
        directAdmissionId: binding.admissionId,
      });
      if (runId !== binding.runId) throw unavailable();
      if (
        !(await this.findRun(binding, {
          command,
          actor,
          workspaceId: this.authority().workspaceId,
          generationId: launch.generationId,
          workflow: launch.workflow,
        }))
      )
        throw unavailable();
      const material = await this.material(binding, command);
      await context.reauthorize();
      await publishAdmissionExecutionPolicy(this.options.orchestrator.stores, this.policyBinding(binding, material));
      return await this.accept(binding, context, material);
    } catch {
      return { state: "recoverable-failure", admissionId: binding.admissionId, runId: binding.runId, failure };
    }
  }
  private async material(binding: z.infer<typeof BindingSchema>, command: DirectAdmissionCommand) {
    const raw = await this.options.orchestrator.stores.execution.getGeneration(binding.materialId);
    const parsed = MaterialSchema.safeParse(raw);
    if (!parsed.success) throw unavailable();
    const material = parsed.data;
    if (
      material.actor.principalId !== this.authority().actor.principalId ||
      material.workspaceId !== this.authority().workspaceId ||
      canonicalJson(material.command) !== canonicalJson(command)
    )
      throw unavailable();
    return material;
  }
  private policyBinding(
    binding: z.infer<typeof BindingSchema>,
    material: z.infer<typeof MaterialSchema>,
  ): AdmissionExecutionBinding {
    return {
      kind: "direct",
      admissionId: binding.admissionId,
      runId: binding.runId,
      workspaceId: material.workspaceId,
      actor: material.actor,
      generationId: material.generationId,
      workflow: material.workflow,
      ...(material.command.requestId ? { requestId: material.command.requestId } : {}),
      ...(material.command.workItemId ? { workItemId: material.command.workItemId } : {}),
      ...(material.command.origin ? { origin: material.command.origin } : {}),
      ...(material.command.gitRef !== undefined ? { gitRef: material.command.gitRef } : {}),
    };
  }
  private async verifyAccepted(
    command: DirectAdmissionCommand,
    rawBinding: Record<string, JsonValue> | undefined,
    receipt: unknown,
    operationId: string,
  ): Promise<void> {
    const accepted = z
      .object({ state: z.literal("accepted"), admissionId: z.string(), runId: z.string() })
      .safeParse(receipt);
    if (!accepted.success) {
      if (receipt && typeof receipt === "object" && "state" in receipt && receipt.state === "accepted")
        throw unavailable();
      return;
    }
    const binding = BindingSchema.safeParse(rawBinding);
    try {
      if (
        !binding.success ||
        accepted.data.admissionId !== binding.data.admissionId ||
        accepted.data.runId !== binding.data.runId
      )
        throw unavailable();
      const material = await this.material(binding.data, command);
      await this.authority().authorize(command);
      if (!(await this.findRun(binding.data, material))) throw unavailable();
      await requireAdmissionExecutionPolicy(
        this.options.orchestrator.stores,
        this.policyBinding(binding.data, material),
      );
      if (!this.authority().verifyRunAdmitted) throw unavailable();
      await this.authority().verifyRunAdmitted!(binding.data.runId);
      await this.authority().authorize(command);
    } catch {
      throw new OrcaError("RUN_STATE", "Direct admission acceptance is unavailable; inspect the original admission", {
        operationId,
        admissionId: accepted.data.admissionId,
        runId: accepted.data.runId,
      });
    }
  }
  private async accept(
    binding: z.infer<typeof BindingSchema>,
    context: RetryContext,
    material: z.infer<typeof MaterialSchema>,
  ): Promise<DirectAdmissionResult> {
    await context.reauthorize();
    await requireAdmissionExecutionPolicy(this.options.orchestrator.stores, this.policyBinding(binding, material));
    await context.reauthorize();
    await this.authority().onRunAdmitted(binding.runId);
    if (!this.authority().verifyRunAdmitted) throw unavailable();
    await this.authority().verifyRunAdmitted!(binding.runId);
    await context.reauthorize();
    // The enclosing retry journal commits this receipt before any adapter may attach execution.
    return { state: "accepted", admissionId: binding.admissionId, runId: binding.runId };
  }
}
