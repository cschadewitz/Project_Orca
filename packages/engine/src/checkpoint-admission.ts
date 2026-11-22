/**
 * Retry-safe admission of checkpoint attempts (#357, phase 2), modeled on direct-run
 * admission: one retry claim (`run.recover`) binds a reserved run id before anything is
 * written, so a replayed request returns the same attempt and a lost response never starts a
 * second one. Execution is a separate attachment, under the same bounded first-attachment
 * policy as a direct run.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OrcaError, OrcaEventSchema, type MutationActor } from "@orca/core";
import type {
  JsonValue,
  RetryContext,
  RetryOperation,
  RetryOptions,
  RetryResult,
} from "../../core/src/model/admission-retry.js";
import { checkpointAttempts, type Orchestrator } from "./orchestrator.js";
import { canonicalJson, type RegisteredRetryClaims } from "./admission-retry.js";
import {
  publishAdmissionExecutionPolicy,
  requireAdmissionExecutionPolicy,
  type AdmissionExecutionBinding,
} from "./admission-execution.js";
import { previewRecovery } from "./recovery-preview.js";

export const CheckpointAdmissionCommandSchema = z.strictObject({
  /** The failed run to recover. */
  runId: z.string().min(1),
  /** The checkpoint: a step run id, or a node id that names exactly one. The latest usable one when absent. */
  checkpoint: z.string().min(1).optional(),
});
export type CheckpointAdmissionCommand = z.infer<typeof CheckpointAdmissionCommandSchema>;

export type CheckpointAdmissionResult =
  | { state: "accepted"; admissionId: string; runId: string; sourceRunId: string }
  | {
      state: "recoverable-failure";
      admissionId: string;
      runId?: string;
      failure: { code: "RUN_STATE"; message: string; recovery: "reconcile" };
    };

export interface CheckpointAdmissionAuthority {
  readonly workspaceId: string;
  readonly actor: MutationActor;
  /** May this principal start a checkpoint attempt of the command's run? */
  authorize(command: CheckpointAdmissionCommand): Promise<void>;
  onRunAdmitted(runId: string): Promise<void>;
  /** Verify existing exact durable ownership without attributing or repairing it. */
  verifyRunAdmitted?(runId: string): Promise<void>;
}

const BindingSchema = z.strictObject({ admissionId: z.string(), runId: z.string(), materialId: z.string() });
type Binding = z.infer<typeof BindingSchema>;
const IdentitySchema = z.object({ id: z.string(), version: z.string(), revision: z.string() });
const MaterialSchema = z.object({
  command: CheckpointAdmissionCommandSchema,
  actor: z.object({ principalId: z.string(), credentialId: z.string().optional() }),
  workspaceId: z.string(),
  generationId: z.string(),
  workflow: IdentitySchema,
  requestId: z.string().optional(),
  workItemId: z.string().optional(),
});
type Material = z.infer<typeof MaterialSchema>;
const unavailable = () => new OrcaError("RUN_STATE", "Checkpoint admission is unavailable");
const failure = {
  code: "RUN_STATE",
  message: "Checkpoint admission is incomplete; reconcile the original admission",
  recovery: "reconcile",
} as const;

export class CheckpointAdmissionService {
  private readonly authorities = new AsyncLocalStorage<CheckpointAdmissionAuthority>();
  private readonly operation: RetryOperation<CheckpointAdmissionCommand, CheckpointAdmissionResult>;
  constructor(private readonly options: { orchestrator: Orchestrator; retries: RegisteredRetryClaims }) {
    this.operation = options.retries.register(
      {
        kind: "run.recover",
        canonicalize: (input: CheckpointAdmissionCommand) => {
          const parsed = CheckpointAdmissionCommandSchema.safeParse(input);
          if (!parsed.success) throw new OrcaError("CONFIG_INVALID", "Invalid checkpoint admission");
          return JSON.parse(
            canonicalJson(
              Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)),
              false,
            ),
          ) as JsonValue;
        },
        validateFresh: async (command) => {
          await this.validate(command);
        },
        prepare: (command, context) => this.prepare(command, context),
        recover: (command, context) => this.recover(command, context),
      },
      undefined,
      (command, binding, receipt, operationId) => this.verifyAccepted(command, binding, receipt, operationId),
    );
  }

  /** Start a checkpoint attempt (created, not driven) once per retry key. */
  startAttempt(
    command: CheckpointAdmissionCommand,
    retry: RetryOptions,
    authority: CheckpointAdmissionAuthority,
  ): Promise<RetryResult<CheckpointAdmissionResult>> {
    return this.authorities.run(authority, () =>
      this.options.retries.execute(this.operation, command, retry, {
        principalId: authority.actor.principalId,
        workspaceId: authority.workspaceId,
        authorize: (value) => authority.authorize(value),
      }),
    );
  }

  /**
   * Finish an admission that returned a recoverable failure: create its reserved attempt if it
   * is still the source's pending reservation, or keep failing if that reservation was retired.
   */
  reconcile(
    operationId: string,
    authority: CheckpointAdmissionAuthority,
  ): Promise<RetryResult<CheckpointAdmissionResult>> {
    return this.authorities.run(authority, async () => {
      const scope = {
        principalId: authority.actor.principalId,
        workspaceId: authority.workspaceId,
        authorize: (value: unknown) => authority.authorize(value as CheckpointAdmissionCommand),
      };
      if ((await this.options.retries.operationKind(operationId, scope)) !== "run.recover") throw unavailable();
      return (await this.options.retries.reconcile(operationId, scope)) as RetryResult<CheckpointAdmissionResult>;
    });
  }

  private authority(): CheckpointAdmissionAuthority {
    const authority = this.authorities.getStore();
    if (!authority) throw unavailable();
    return authority;
  }

  /**
   * Read-only: the source can be recovered from this checkpoint by this principal, and it
   * recorded the configuration the attempt is pinned to. Repeated, under the source's lease,
   * when the attempt is created.
   */
  private async validate(
    command: CheckpointAdmissionCommand,
  ): Promise<Omit<Material, "command" | "actor" | "workspaceId">> {
    const { stores } = this.options.orchestrator;
    const assessment = await previewRecovery(stores, command.runId, {
      checkpoint: command.checkpoint,
      principalId: this.authority().actor.principalId,
    });
    const option = assessment.options.find((o) => o.kind === "checkpoint-attempt");
    if (!option || option.readiness === "blocked")
      throw new OrcaError("RECOVERY_BLOCKED", `run ${command.runId} cannot be recovered from a checkpoint`, {
        runId: command.runId,
        blockers: option?.blockers ?? [],
      });
    const state = await this.options.orchestrator.getState(command.runId);
    const provenance = state.run.provenance;
    if (!provenance)
      throw new OrcaError(
        "NOT_SUPPORTED",
        "a run that recorded no configuration generation cannot be recovered through admission",
      );
    return {
      generationId: provenance.configGeneration,
      workflow: { ...provenance.workflow },
      ...(state.run.requestId ? { requestId: state.run.requestId } : {}),
      ...(state.run.workItemId ? { workItemId: state.run.workItemId } : {}),
    };
  }

  private async prepare(
    command: CheckpointAdmissionCommand,
    context: RetryContext,
  ): Promise<CheckpointAdmissionResult> {
    const pinned = await this.validate(command);
    const binding: Binding = {
      admissionId: `checkpoint_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      materialId: `checkpoint-material-${randomUUID()}`,
    };
    const authority = this.authority();
    // Bind before any admission effects: an interrupted reservation stays recoverable and
    // never substitutes a different run.
    await context.bind(binding);
    const material: Material = { command, actor: authority.actor, workspaceId: authority.workspaceId, ...pinned };
    await this.options.orchestrator.stores.execution.putGeneration(binding.materialId, material);
    return this.admit(context, binding, material);
  }

  private async recover(
    command: CheckpointAdmissionCommand,
    context: RetryContext,
  ): Promise<CheckpointAdmissionResult> {
    const binding = BindingSchema.parse(await context.readBinding());
    try {
      const material = await this.material(binding, command);
      await context.reauthorize();
      if (await this.findRun(binding, material)) return await this.accept(binding, context, material);
      // A private record without run.created: do not guess what it started.
      if (await this.options.orchestrator.stores.execution.getInputs(binding.runId))
        return { state: "recoverable-failure", admissionId: binding.admissionId, runId: binding.runId, failure };
      return await this.admit(context, binding, material);
    } catch {
      return { state: "recoverable-failure", admissionId: binding.admissionId, runId: binding.runId, failure };
    }
  }

  private async admit(context: RetryContext, binding: Binding, material: Material): Promise<CheckpointAdmissionResult> {
    try {
      await context.reauthorize();
      const runId = await this.options.orchestrator.startCheckpointAttempt({
        runId: material.command.runId,
        checkpoint: material.command.checkpoint,
        actor: material.actor,
        admissionRunId: binding.runId,
        directAdmissionId: binding.admissionId,
      });
      if (runId !== binding.runId || !(await this.findRun(binding, material))) throw unavailable();
      await context.reauthorize();
      await publishAdmissionExecutionPolicy(this.options.orchestrator.stores, this.policyBinding(binding, material));
      return await this.accept(binding, context, material);
    } catch (error) {
      // A refusal before anything was written is the caller's answer, not a reconciliation.
      // A reservation already names this attempt: only reconciling (or retiring) it ends it.
      const { stores } = this.options.orchestrator;
      if (
        error instanceof OrcaError &&
        (await stores.events.lastSeq(binding.runId)) === undefined &&
        !(await stores.execution.getInputs(binding.runId)) &&
        !(await checkpointAttempts(stores, material.command.runId)).some((a) => a.runId === binding.runId)
      )
        throw error;
      return { state: "recoverable-failure", admissionId: binding.admissionId, runId: binding.runId, failure };
    }
  }

  private async findRun(binding: Binding, material: Material): Promise<boolean> {
    const { stores } = this.options.orchestrator;
    const first = (await stores.events.readRange(binding.runId, { limit: 1 }))[0];
    if (!first) return false;
    if (first.type !== "run.created" || !first.executionPayloadRef || !stores.events.synchronizeEvent)
      throw unavailable();
    const original = await stores.events.synchronizeEvent(first);
    const parsed = OrcaEventSchema.safeParse(original);
    const correlation = z.object({ directAdmissionId: z.string() }).safeParse(original.payload);
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
      root.requestId !== material.requestId ||
      root.workItemId !== material.workItemId ||
      root.checkpoint?.runId !== material.command.runId ||
      root.provenance?.configGeneration !== material.generationId
    )
      throw unavailable();
    return true;
  }

  private async material(binding: Binding, command: CheckpointAdmissionCommand): Promise<Material> {
    const parsed = MaterialSchema.safeParse(
      await this.options.orchestrator.stores.execution.getGeneration(binding.materialId),
    );
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

  private policyBinding(binding: Binding, material: Material): AdmissionExecutionBinding {
    return {
      kind: "direct",
      admissionId: binding.admissionId,
      runId: binding.runId,
      workspaceId: material.workspaceId,
      actor: material.actor,
      generationId: material.generationId,
      workflow: material.workflow,
      ...(material.requestId ? { requestId: material.requestId } : {}),
      ...(material.workItemId ? { workItemId: material.workItemId } : {}),
    };
  }

  private async verifyAccepted(
    command: CheckpointAdmissionCommand,
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
      throw new OrcaError(
        "RUN_STATE",
        "Checkpoint admission acceptance is unavailable; inspect the original admission",
        {
          operationId,
          admissionId: accepted.data.admissionId,
          runId: accepted.data.runId,
        },
      );
    }
  }

  private async accept(
    binding: Binding,
    context: RetryContext,
    material: Material,
  ): Promise<CheckpointAdmissionResult> {
    await context.reauthorize();
    await requireAdmissionExecutionPolicy(this.options.orchestrator.stores, this.policyBinding(binding, material));
    await context.reauthorize();
    await this.authority().onRunAdmitted(binding.runId);
    if (!this.authority().verifyRunAdmitted) throw unavailable();
    await this.authority().verifyRunAdmitted!(binding.runId);
    await context.reauthorize();
    // The enclosing retry journal commits this receipt before any adapter may attach execution.
    return {
      state: "accepted",
      admissionId: binding.admissionId,
      runId: binding.runId,
      sourceRunId: material.command.runId,
    };
  }
}
