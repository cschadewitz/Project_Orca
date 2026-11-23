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
import { isGitRefMoved } from "./workspace/provider.js";
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
  /**
   * The object `command.gitRef` named when this admission checked it (#883), captured with the
   * rest of the material: creation and recovery provision exactly it, never a later lookup.
   */
  gitRefObject: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
});
type Material = z.infer<typeof MaterialSchema>;
/**
 * A final refusal for an admission's reserved run (#956): the ref it pinned moved before the
 * run could be created. It is recorded as the reserved run's private inputs record, under the
 * workflow id below, with the refusal as its only vars. Every version of this service that
 * reserves run ids already treats an inputs record without `run.created` as "never create this
 * run here" (`recover` answers the reconcile failure, and `Orchestrator.startRun` refuses a
 * reserved id that has one), so an older worker on the same store after a rollback still never
 * creates the run; this version also reads it back as the final refusal. One write-once record:
 * the refusal is durable exactly when it is reported.
 *
 * The move can also be found later, when provisioning fetches the ref, after `startRun` has
 * already written the run's own inputs record. That record is the same fence for every version,
 * so the refusal is then kept beside it, write-once under the material's id, and is read only
 * while that fence stands.
 */
const REFUSED_WORKFLOW = "orca:refused-admission";
const refusalId = (binding: { materialId: string }) => `${binding.materialId}-refused`;
const RefusalSchema = z.strictObject({ code: z.literal("GIT_REF_MOVED"), message: z.string().min(1) });
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
  /**
   * Read-only preflight, repeated during preparation after the retry claim is published; that
   * repetition's `gitRefObject` is the pin the admission persists.
   */
  private async validateLaunch(
    command: DirectAdmissionCommand,
  ): Promise<{ launch: DirectCapturedLaunch; gitRefObject?: string }> {
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
    const checked = await launch.validateStartRun(this.launchOptions(command, this.authority().actor));
    const gitRefObject = checked ? checked.gitRefObject : undefined;
    // A ref is admitted only with the object it named: there is nothing else to bind creation to.
    if ((command.gitRef !== undefined) !== (gitRefObject !== undefined)) throw unavailable();
    return { launch, ...(gitRefObject !== undefined ? { gitRefObject } : {}) };
  }
  private async prepare(command: DirectAdmissionCommand, context: RetryContext): Promise<DirectAdmissionResult> {
    const { launch, gitRefObject } = await this.validateLaunch(command);
    const binding = {
      admissionId: `direct_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      materialId: `direct-material-${randomUUID()}`,
    };
    const authority = this.authority();
    // Bind before any admission effects. An interrupted unsealed reservation stays recoverable,
    // never recaptures current defaults or substitutes a different run.
    await context.bind(binding);
    const material: Material = {
      command,
      actor: authority.actor,
      workspaceId: authority.workspaceId,
      generationId: launch.generationId,
      workflow: launch.workflow,
      ...(gitRefObject !== undefined ? { gitRefObject } : {}),
    };
    await this.options.orchestrator.stores.execution.putGeneration(binding.materialId, material);
    return this.admit(command, context, binding, launch, material);
  }
  private launchOptions(
    command: DirectAdmissionCommand,
    actor: MutationActor,
    gitRefObject?: string,
  ): BoundLaunchOptions {
    return {
      actor,
      vars: command.vars ?? {},
      ...(command.requestId ? { requestId: command.requestId } : {}),
      ...(command.workItemId ? { workItemId: command.workItemId } : {}),
      ...(command.origin ? { origin: command.origin } : {}),
      ...(command.gitRef !== undefined ? { gitRef: command.gitRef } : {}),
      ...(gitRefObject !== undefined ? { gitRefObject } : {}),
    };
  }
  private async recover(command: DirectAdmissionCommand, context: RetryContext): Promise<DirectAdmissionResult> {
    const binding = BindingSchema.parse(await context.readBinding());
    try {
      const material = await this.material(binding, command);
      await context.reauthorize();
      if (await this.findRun(binding, material)) return await this.accept(binding, context, material);
      const refused = await this.refused(binding);
      if (refused) return refused;
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
      return this.admit(command, context, binding, launch, material);
    } catch {
      return { state: "recoverable-failure", admissionId: binding.admissionId, runId: binding.runId, failure };
    }
  }

  private async findRun(binding: z.infer<typeof BindingSchema>, material: Material): Promise<boolean> {
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
      root.workspace.rootProvisioning?.ref !== material.command.gitRef ||
      root.workspace.rootProvisioning?.refObject !== material.gitRefObject
    )
      throw unavailable();
    return true;
  }
  private async admit(
    command: DirectAdmissionCommand,
    context: RetryContext,
    binding: z.infer<typeof BindingSchema>,
    launch: DirectCapturedLaunch,
    reserved: Material,
  ): Promise<DirectAdmissionResult> {
    try {
      await context.reauthorize();
      // Creation is bound to the reserved material, including the pinned ref object.
      const runId = await launch.startRun({
        ...this.launchOptions(command, reserved.actor, reserved.gitRefObject),
        admissionRunId: binding.runId,
        directAdmissionId: binding.admissionId,
      });
      if (runId !== binding.runId) throw unavailable();
      if (!(await this.findRun(binding, reserved))) throw unavailable();
      const material = await this.material(binding, command);
      if (material.gitRefObject !== reserved.gitRefObject) throw unavailable();
      await context.reauthorize();
      await publishAdmissionExecutionPolicy(this.options.orchestrator.stores, this.policyBinding(binding, material));
      return await this.accept(binding, context, material);
    } catch (error) {
      if (isGitRefMoved(error)) {
        const refused = await this.refuse(binding, reserved, error.message).catch(() => undefined);
        if (refused) return refused;
      }
      return { state: "recoverable-failure", admissionId: binding.admissionId, runId: binding.runId, failure };
    }
  }
  /**
   * Record that the reserved run will never be created because its pinned ref moved (#956),
   * and answer that. Only while no run exists under the reserved id: a run that does exist is
   * left to reconcile, as before.
   */
  private async refuse(
    binding: z.infer<typeof BindingSchema>,
    reserved: Material,
    message: string,
  ): Promise<DirectAdmissionResult | undefined> {
    if (await this.findRun(binding, reserved)) return undefined;
    const recorded = await this.refused(binding);
    if (recorded) return recorded;
    const { execution } = this.options.orchestrator.stores;
    const refusal = RefusalSchema.parse({ code: "GIT_REF_MOVED", message: message.slice(0, 500) });
    const inputs = await execution.getInputs(binding.runId);
    if (!inputs)
      await execution.putInputs({
        runId: binding.runId,
        workflowId: REFUSED_WORKFLOW,
        workflowVersion: reserved.workflow.version,
        vars: refusal,
        sensitiveNames: [],
        secrets: [],
      });
    // Found at fetch time: `startRun` refuses a reserved id that already has inputs, so the run's
    // own record was written by the very call that found the move. It already fences the run for
    // every version; keep the refusal beside it.
    else if (this.ownInputs(binding, reserved, inputs)) await execution.putGeneration(refusalId(binding), refusal);
    // Anything else under the reserved id is left to reconcile.
    else return undefined;
    // Reported as final only once it reads back durable; a failed write stays the transient,
    // reconcilable failure, and the next reconcile decides again.
    return this.refused(binding);
  }
  private ownInputs(
    binding: z.infer<typeof BindingSchema>,
    reserved: Material,
    inputs: { runId: string; workflowId: string; workflowVersion: string },
  ): boolean {
    return (
      inputs.runId === binding.runId &&
      inputs.workflowId === reserved.workflow.id &&
      inputs.workflowVersion === reserved.workflow.version
    );
  }
  /** The recorded final refusal for this admission's reserved run, if there is one. */
  private async refused(binding: z.infer<typeof BindingSchema>): Promise<DirectAdmissionResult | undefined> {
    const { execution } = this.options.orchestrator.stores;
    const inputs = await execution.getInputs(binding.runId);
    if (!inputs) return undefined;
    // Read only while a fence stands: the tombstone itself, or the run's own inputs record.
    const raw =
      inputs.workflowId === REFUSED_WORKFLOW ? inputs.vars : await execution.getGeneration(refusalId(binding));
    if (raw === undefined || raw === null) return undefined;
    const refusal = RefusalSchema.parse(raw);
    return {
      state: "recoverable-failure",
      admissionId: binding.admissionId,
      runId: binding.runId,
      failure: { code: refusal.code, message: refusal.message, recovery: "reconcile" },
    };
  }
  private async material(binding: z.infer<typeof BindingSchema>, command: DirectAdmissionCommand) {
    const raw = await this.options.orchestrator.stores.execution.getGeneration(binding.materialId);
    const parsed = MaterialSchema.safeParse(raw);
    if (!parsed.success) throw unavailable();
    const material = parsed.data;
    if (
      material.actor.principalId !== this.authority().actor.principalId ||
      material.workspaceId !== this.authority().workspaceId ||
      canonicalJson(material.command) !== canonicalJson(command) ||
      (command.gitRef !== undefined) !== (material.gitRefObject !== undefined)
    )
      throw unavailable();
    return material;
  }
  private policyBinding(binding: z.infer<typeof BindingSchema>, material: Material): AdmissionExecutionBinding {
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
      ...(material.gitRefObject !== undefined ? { gitRefObject: material.gitRefObject } : {}),
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
