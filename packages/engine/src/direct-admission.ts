/** Prompt direct-run receipts. Execution is a separate, currently authorized attachment. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OrcaError, OrcaEventSchema } from "@orca/core";
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

export const DirectAdmissionCommandSchema = z.strictObject({
  workflowId: z.string().min(1),
  vars: z.record(z.string(), z.unknown()).optional(),
  workflowVersion: z.string().min(1).optional(),
  expectedWorkflowRevision: z.string().min(1).optional(),
  expectedConfigGeneration: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  workItemId: z.string().min(1).optional(),
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
    this.operation = options.retries.register({
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
      prepare: (command, context) => this.prepare(command, context),
      recover: (command, context) => this.recover(command, context),
    });
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
  private async prepare(command: DirectAdmissionCommand, context: RetryContext): Promise<DirectAdmissionResult> {
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
    const binding = {
      admissionId: `direct_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      materialId: `direct-material-${randomUUID()}`,
    };
    const authority = this.authority();
    await launch.validateStartRun(this.launchOptions(command, authority.actor));
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
    };
  }
  private async recover(command: DirectAdmissionCommand, context: RetryContext): Promise<DirectAdmissionResult> {
    const binding = BindingSchema.parse(await context.readBinding());
    const raw = await this.options.orchestrator.stores.execution.getGeneration(binding.materialId);
    if (!raw) return { state: "recoverable-failure", admissionId: binding.admissionId, failure };
    const material = MaterialSchema.parse(raw);
    if (
      material.actor.principalId !== this.authority().actor.principalId ||
      material.workspaceId !== this.authority().workspaceId ||
      canonicalJson(material.command) !== canonicalJson(command)
    )
      throw unavailable();
    await context.reauthorize();
    if (await this.findRun(binding, material)) return this.accept(binding, context);
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
  }
  private async findRun(
    binding: z.infer<typeof BindingSchema>,
    material: z.infer<typeof MaterialSchema>,
  ): Promise<boolean> {
    const { stores } = this.options.orchestrator;
    const first = (await stores.events.readRange(binding.runId, { limit: 1 }))[0];
    if (!first) return false;
    if (first.type !== "run.created" || !first.executionPayloadRef) throw unavailable();
    const payload = await stores.execution.getPayload(binding.runId, first.executionPayloadRef, first.type);
    const parsed = OrcaEventSchema.safeParse({ ...first, payload });
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
      root.workItemId !== material.command.workItemId
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
      return await this.accept(binding, context);
    } catch {
      return { state: "recoverable-failure", admissionId: binding.admissionId, runId: binding.runId, failure };
    }
  }
  private async accept(binding: z.infer<typeof BindingSchema>, context: RetryContext): Promise<DirectAdmissionResult> {
    await context.reauthorize();
    await this.authority().onRunAdmitted(binding.runId);
    await context.reauthorize();
    // The enclosing retry journal commits this receipt before any adapter may attach execution.
    return { state: "accepted", admissionId: binding.admissionId, runId: binding.runId };
  }
}
