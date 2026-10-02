/** One durable Request admission lifecycle, optionally reserved by the shared retry ledger. */
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type {
  JsonValue,
  RetryContext,
  RetryOperation,
  RetryOptions,
  RetryResult,
} from "../../../core/src/model/admission-retry.js";
import { canonicalJson, type RegisteredRetryClaims } from "../admission-retry.js";
import { randomUUID } from "node:crypto";
import { redactExecutionValue } from "@orca/store";
import {
  newId,
  MutationActorSchema,
  type MutationActor,
  OrcaError,
  isOrcaError,
  OrcaEventSchema,
  RequestSchema,
  SubmissionCommandSchema,
  SUBMISSION_CORRELATION_VAR,
  type Request,
  type SubmissionAuthority,
  type SubmissionCommand,
  type SubmissionResult,
  type SubmissionService,
} from "@orca/core";
import type { Orchestrator } from "../orchestrator.js";
import { RequestAdmissionCorrelationSchema } from "./request-admission-event.js";
import { AdmissionSchema, type Admission, type AdmissionStore } from "./submission-store.js";
import {
  publishAdmissionExecutionPolicy,
  requireAdmissionExecutionPolicy,
  type AdmissionExecutionBinding,
} from "../admission-execution.js";

import type {
  CaptureLaunch,
  CapturedLaunch,
  BoundLaunchOptions,
  LaunchSelection,
  RestoreLaunch,
} from "../configuration-generation.js";
export type {
  CaptureLaunch,
  CapturedLaunch,
  BoundLaunchOptions,
  LaunchSelection,
  RestoreLaunch,
} from "../configuration-generation.js";

export interface RequestSubmissionOptions {
  orchestrator: Orchestrator;
  admissions: AdmissionStore;
  captureLaunch: CaptureLaunch;
  restoreLaunch?: RestoreLaunch;
  retries?: RegisteredRetryClaims;
}

const unavailable = () => new OrcaError("RUN_STATE", "request admission is unavailable");
const failure = {
  code: "RUN_STATE",
  message: "Request admission is incomplete; reconcile the original admission",
  recovery: "reconcile",
} as const;

export class RequestSubmissionService implements SubmissionService {
  private readonly authorities = new AsyncLocalStorage<SubmissionAuthority>();
  private readonly operation: RetryOperation<SubmissionCommand, SubmissionResult> | undefined;
  constructor(private readonly opts: RequestSubmissionOptions) {
    this.operation = opts.retries?.register(
      {
        kind: "request.submit",
        canonicalize: (input: SubmissionCommand) => {
          const parsed = SubmissionCommandSchema.safeParse(input);
          if (!parsed.success) throw new OrcaError("WORKFLOW_INPUT_INVALID", "Invalid Request submission");
          // Detect unknown nested source/override fields stripped by legacy schemas.
          const original = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
          const normalized = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
          if (canonicalJson({ ...original, title: parsed.data.title }, false) !== canonicalJson(normalized, false))
            throw new OrcaError("WORKFLOW_INPUT_INVALID", "Unknown Request submission fields");
          return JSON.parse(
            canonicalJson({ ...normalized, title: input.title, vars: parsed.data.vars ?? {} }, false),
          ) as JsonValue;
        },
        prepare: async (command, context) => {
          const binding = {
            admissionId: `admission_${randomUUID()}`,
            requestId: newId("req", this.opts.orchestrator.clock.now()),
          };
          await context.bind(binding);
          return this.prepare(command, this.authority(), { ...binding, context });
        },
        recover: async (_command, context) => this.recoverReserved(context),
      },
      async (command, binding) => {
        await this.authority().authorize(command);
        if (typeof binding?.admissionId === "string") {
          const record = await this.opts.admissions.records.get(binding.admissionId);
          if (record) {
            if (
              record.principalId !== this.authority().actor.principalId ||
              record.workspaceId !== this.authority().workspaceId
            )
              throw unavailable();
            await this.authority().authorize({ ...command, workflowId: record.workflowId });
          }
        }
      },
      async (command, binding, receipt, operationId) => {
        const accepted = z
          .object({ state: z.literal("accepted"), admissionId: z.string(), requestId: z.string(), runId: z.string() })
          .safeParse(receipt);
        if (!accepted.success) {
          if (receipt && typeof receipt === "object" && "state" in receipt && receipt.state === "accepted")
            throw unavailable();
          return;
        }
        try {
          if (binding?.admissionId !== accepted.data.admissionId || binding.requestId !== accepted.data.requestId)
            throw unavailable();
          const record = await this.owned(accepted.data.admissionId, this.authority());
          const material = await this.material(record);
          const normalized = SubmissionCommandSchema.parse(command);
          if (
            canonicalJson({ ...material.command, vars: material.command.vars ?? {} }) !==
              canonicalJson({ ...normalized, vars: normalized.vars ?? {} }) ||
            record.state !== "accepted" ||
            record.runId !== accepted.data.runId ||
            record.requestId !== accepted.data.requestId
          )
            throw unavailable();
          await this.verifyAccepted(record, this.authority());
        } catch {
          throw new OrcaError(
            "RUN_STATE",
            "Request admission acceptance is unavailable; inspect the original admission",
            {
              operationId,
              admissionId: accepted.data.admissionId,
              requestId: accepted.data.requestId,
              runId: accepted.data.runId,
            },
          );
        }
      },
    );
  }
  private authority(): SubmissionAuthority {
    const authority = this.authorities.getStore();
    if (!authority) throw unavailable();
    return authority;
  }
  withRetryAuthority<T>(authority: SubmissionAuthority, action: () => Promise<T>): Promise<T> {
    return this.authorities.run(authority, action);
  }
  async submitRetry(
    command: SubmissionCommand,
    retry: RetryOptions,
    authority: SubmissionAuthority,
  ): Promise<RetryResult<SubmissionResult>> {
    if (!this.opts.retries || !this.operation)
      throw new OrcaError("NOT_SUPPORTED", "Retry admission is not configured");
    return this.withRetryAuthority(authority, () =>
      this.opts.retries!.execute(this.operation!, command, retry, {
        principalId: authority.actor.principalId,
        workspaceId: authority.workspaceId,
        authorize: (value) => authority.authorize(value),
      }),
    );
  }
  private async recoverReserved(context: RetryContext): Promise<SubmissionResult> {
    const binding = z.object({ admissionId: z.string(), requestId: z.string() }).parse(await context.readBinding());
    const authority = this.authority();
    return this.opts.admissions.lock(binding.admissionId, async () => {
      let record = await this.opts.admissions.records.get(binding.admissionId);
      if (!record) {
        const sealed = await this.opts.orchestrator.stores.execution.getInputs(binding.admissionId);
        if (!sealed) return { state: "recoverable-failure", ...binding, failure };
        record = AdmissionSchema.parse(sealed.vars.admission);
        if (
          record.id !== binding.admissionId ||
          record.requestId !== binding.requestId ||
          record.principalId !== authority.actor.principalId ||
          record.workspaceId !== authority.workspaceId
        )
          throw unavailable();
        await this.opts.admissions.records.put(record);
      }
      const { command, request, actor } = await this.material(record);
      await context.reauthorize();
      await authority.authorize({ ...command, workflowId: record.workflowId });
      return this.admit(record, command, request, authority, undefined, actor);
    });
  }

  async submit(
    input: SubmissionCommand,
    authority: SubmissionAuthority,
    retry: RetryOptions = {},
  ): Promise<SubmissionResult> {
    if (this.opts.retries) {
      const response = await this.submitRetry(input, retry, authority);
      if (response.state === "in-progress")
        throw new OrcaError("RUN_STATE", "Request admission is in progress", { ...response });
      return response.result;
    }
    if (retry.idempotencyKey !== undefined) throw new OrcaError("NOT_SUPPORTED", "Retry admission is not configured");
    return this.prepare(input, authority);
  }
  private async prepare(
    input: SubmissionCommand,
    authority: SubmissionAuthority,
    reservation?: { admissionId: string; requestId: string; context: RetryContext },
  ): Promise<SubmissionResult> {
    // Operation/resource authority precedes schema diagnostics. Never accept authority from input.
    await authority.authorize(input);
    const parsed = SubmissionCommandSchema.safeParse(input);
    if (!parsed.success)
      throw new OrcaError("WORKFLOW_INPUT_INVALID", "invalid Request submission", {
        errors: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        warnings: [],
      });
    const command = parsed.data;
    const captured = await this.opts.captureLaunch({ purpose: "request", ...selection(command) });
    const resolved = { ...command, workflowId: captured.workflow.id };
    await authority.authorize(resolved);
    this.requireCorrelation(captured);
    const id = reservation?.admissionId ?? `admission_${randomUUID()}`;
    const request = RequestSchema.parse({
      id: reservation?.requestId ?? newId("req", this.opts.orchestrator.clock.now()),
      title: command.title,
      body: command.body,
      source: command.source,
      labels: command.labels,
      status: "decomposing",
      createdAt: this.opts.orchestrator.clock.isoNow(),
      updatedAt: this.opts.orchestrator.clock.isoNow(),
    });
    const reservedRunId =
      "admissionRunIds" in captured && captured.admissionRunIds === true ? `run_${randomUUID()}` : undefined;
    const options = this.options(command, request, authority, id, reservedRunId);
    await captured.validateStartRun(options);
    await authority.authorize(resolved);
    const record: Admission = {
      id,
      requestId: request.id,
      workspaceId: authority.workspaceId,
      principalId: authority.actor.principalId,
      workflowId: captured.workflow.id,
      workflowVersion: captured.workflow.version,
      workflowRevision: captured.workflow.revision,
      generationId: captured.generationId,
      createdAt: request.createdAt,
      state: "prepared",
      correlationVersion: 2,
      ...(reservedRunId ? { reservedRunId } : {}),
    };
    // Seal first. The discoverable index never contains title/body, vars, source or overrides.
    // Reuse protected-execution-v2 key handling and immutable authenticated records.
    try {
      await reservation?.context.reauthorize();
      await this.opts.orchestrator.stores.execution.putInputs({
        runId: id,
        workflowId: record.workflowId,
        workflowVersion: record.workflowVersion,
        vars: { command, request, admission: record, actor: authority.actor },
        sensitiveNames: ["command", "request", "admission", "actor"],
        secrets: [],
      });
      return await this.opts.admissions.lock(id, async () => {
        await this.opts.admissions.records.put(record);
        return this.admit(record, command, request, authority, captured, authority.actor);
      });
    } catch {
      // A write can commit and then fail its acknowledgment. Supply the correlation, but
      // never promise preparation/acceptance without the durable record being confirmed.
      throw new OrcaError(
        "STORE_WRITE",
        "Request admission could not be prepared; inspect admissions before retrying",
        {
          admissionId: id,
          requestId: request.id,
        },
      );
    }
  }

  async reconcile(id: string, authority: SubmissionAuthority): Promise<SubmissionResult> {
    await authority.authorize({ title: "", body: "" });
    return this.opts.admissions.lock(id, async () => {
      const record = await this.owned(id, authority);
      const { command, request, actor } = await this.material(record);
      await authority.authorize({ ...command, workflowId: record.workflowId });
      return this.admit(record, command, request, authority, undefined, actor);
    });
  }

  async inspect(id: string, authority: SubmissionAuthority): Promise<SubmissionResult> {
    await authority.authorize({ title: "", body: "" });
    const record = await this.owned(id, authority);
    await authority.authorize({ title: "", body: "", workflowId: record.workflowId });
    return this.inspectedResult(record, authority);
  }

  async list(authority: SubmissionAuthority): Promise<SubmissionResult[]> {
    await authority.authorize({ title: "", body: "" });
    const records = await this.opts.admissions.records
      .list((r) => r.workspaceId === authority.workspaceId && r.principalId === authority.actor.principalId)
      .catch(() => {
        throw unavailable();
      });
    const results: SubmissionResult[] = [];
    for (const record of records) {
      try {
        await authority.authorize({ title: "", body: "", workflowId: record.workflowId });
      } catch (error) {
        // A narrowed workflow scope hides that admission, not the other owned ones.
        // Revocation and infrastructure failures still fail the entire operation.
        if (isOrcaError(error, "WORKFLOW_NOT_FOUND")) continue;
        throw error;
      }
      results.push(await this.inspectedResult(record, authority));
    }
    return results;
  }

  private async owned(id: string, authority: SubmissionAuthority): Promise<Admission> {
    const record = await this.opts.admissions.records.get(id).catch(() => {
      throw unavailable();
    });
    if (!record || record.workspaceId !== authority.workspaceId || record.principalId !== authority.actor.principalId)
      throw unavailable();
    return record;
  }

  private async material(
    record: Admission,
  ): Promise<{ command: SubmissionCommand; request: Request; actor: MutationActor }> {
    const sealed = await this.opts.orchestrator.stores.execution.getInputs(record.id);
    const command = SubmissionCommandSchema.safeParse(sealed?.vars.command);
    const request = RequestSchema.safeParse(sealed?.vars.request);
    const admission = AdmissionSchema.safeParse(sealed?.vars.admission);
    const actor = MutationActorSchema.safeParse(sealed?.vars.actor);
    if (
      !sealed ||
      !command.success ||
      !request.success ||
      request.data.id !== record.requestId ||
      !admission.success ||
      !actor.success ||
      actor.data.principalId !== record.principalId ||
      admission.data.workflowId !== record.workflowId ||
      admission.data.workflowVersion !== record.workflowVersion ||
      admission.data.createdAt !== record.createdAt ||
      admission.data.id !== record.id ||
      admission.data.requestId !== record.requestId ||
      admission.data.workspaceId !== record.workspaceId ||
      admission.data.principalId !== record.principalId ||
      admission.data.generationId !== record.generationId ||
      admission.data.correlationVersion !== record.correlationVersion ||
      admission.data.reservedRunId !== record.reservedRunId ||
      admission.data.workflowRevision !== record.workflowRevision ||
      sealed.workflowId !== record.workflowId ||
      sealed.workflowVersion !== record.workflowVersion
    )
      throw unavailable();
    return { command: command.data, request: request.data, actor: actor.data };
  }

  private policyBinding(record: Admission, actor: MutationActor): AdmissionExecutionBinding {
    if (!record.runId) throw unavailable();
    return {
      kind: "request",
      admissionId: record.id,
      runId: record.runId,
      requestId: record.requestId,
      workspaceId: record.workspaceId,
      actor,
      generationId: record.generationId,
      workflow: { id: record.workflowId, version: record.workflowVersion, revision: record.workflowRevision },
    };
  }

  private async verifyAccepted(record: Admission, authority: SubmissionAuthority): Promise<void> {
    if (record.state !== "accepted" || !record.runId) throw unavailable();
    const { command, actor } = await this.material(record);
    await authority.authorize({ ...command, workflowId: record.workflowId });
    if ((await this.findRoot(record)) !== record.runId) throw unavailable();
    await requireAdmissionExecutionPolicy(this.opts.orchestrator.stores, this.policyBinding(record, actor));
    const linked = await this.opts.orchestrator.stores.requests.get(record.requestId);
    if (!linked || linked.programRunId !== record.runId) throw unavailable();
    if (!authority.verifyRunAdmitted) throw unavailable();
    await authority.verifyRunAdmitted(record.runId);
    await authority.authorize({ ...command, workflowId: record.workflowId });
  }

  private async inspectedResult(record: Admission, authority: SubmissionAuthority): Promise<SubmissionResult> {
    if (record.state !== "accepted") return result(record);
    try {
      await this.verifyAccepted(record, authority);
      return result(record);
    } catch {
      // Read paths retain correlation but never repair or downgrade the persisted record.
      return result({ ...record, state: "recoverable-failure" });
    }
  }

  private requireCorrelation(launch: CapturedLaunch): void {
    if (launch.requestAdmissionCorrelation !== true)
      throw new OrcaError("NOT_SUPPORTED", "Request launch provider must support protected admission correlation");
  }

  private options(
    command: SubmissionCommand,
    request: Request,
    authority: SubmissionAuthority,
    admissionId: string,
    admissionRunId?: string,
  ): BoundLaunchOptions & { admissionRunId?: string } {
    return {
      requestId: request.id,
      vars: { ...command.vars, request },
      requestAdmissionId: admissionId,
      ...(admissionRunId ? { admissionRunId } : {}),
      actor: authority.actor,
      ...(command.overrides ? { overrides: command.overrides } : {}),
    };
  }

  /** Request associations are many-to-one; only the admission's program root is recoverable here. */
  private async findRoot(record: Admission): Promise<string | undefined> {
    const orc = this.opts.orchestrator;
    const request = await orc.stores.requests.get(record.requestId);
    if (record.runId && request?.programRunId && record.runId !== request.programRunId) throw unavailable();
    const recorded = record.runId ?? request?.programRunId;
    if (record.reservedRunId && recorded && record.reservedRunId !== recorded) throw unavailable();
    const readRoot = async (runId: string) => {
      const first = (await orc.stores.events.readRange(runId, { limit: 1 }))[0];
      if (!first || first.type !== "run.created") throw unavailable();
      if (first.payload.executionInputsStored && !first.executionPayloadRef) throw unavailable();
      // The correlation can coincide with a sensitive value. Recovery reads the sealed
      // original, never treats redacted public metadata as absence of a durable root.
      if (!orc.stores.events.synchronizeEvent) throw unavailable();
      const authenticated = await orc.stores.events.synchronizeEvent(first);
      const original = authenticated.payload;
      const restored = OrcaEventSchema.safeParse(authenticated);
      if (!restored.success || restored.data.type !== "run.created") throw unavailable();
      const correlation = RequestAdmissionCorrelationSchema.safeParse(original);
      return {
        ...restored.data.payload,
        // Legacy vars may have been redacted; read them from the authenticated original too.
        legacyCorrelation: restored.data.payload.vars[SUBMISSION_CORRELATION_VAR],
        correlation: first.executionPayloadRef && correlation.success ? correlation.data.requestAdmissionId : undefined,
      };
    };
    const correlated = (root: Awaited<ReturnType<typeof readRoot>>) =>
      root.correlation === record.id || (record.correlationVersion === 1 && root.legacyCorrelation === record.id);
    const verify = (root: Awaited<ReturnType<typeof readRoot>>) => {
      if (
        root.requestId !== record.requestId ||
        root.parentRunId ||
        root.workflowId !== record.workflowId ||
        root.workflowVersion !== record.workflowVersion ||
        root.actor?.principalId !== record.principalId ||
        (record.correlationVersion && !correlated(root))
      )
        throw unavailable();
    };
    if (recorded) {
      verify(await readRoot(recorded));
      return recorded;
    }
    if (record.reservedRunId) {
      const first = (await orc.stores.events.readRange(record.reservedRunId, { limit: 1 }))[0];
      if (!first) return undefined;
      verify(await readRoot(record.reservedRunId));
      return record.reservedRunId;
    }
    // Old incomplete admissions have no unambiguous correlation. Fail closed rather than
    // guessing which associated run was the root or launching a duplicate.
    if (!record.correlationVersion) throw unavailable();
    const roots: string[] = [];
    for (const runId of await orc.listRuns()) {
      const root = await readRoot(runId);
      if (root.parentRunId || root.requestId !== record.requestId || !correlated(root)) continue;
      verify(root);
      roots.push(runId);
    }
    if (roots.length > 1) throw unavailable();
    return roots[0];
  }

  private async admit(
    record: Admission,
    command: SubmissionCommand,
    request: Request,
    authority: SubmissionAuthority,
    captured?: CapturedLaunch,
    actor: MutationActor = authority.actor,
  ): Promise<SubmissionResult> {
    const { orchestrator: orc, admissions } = this.opts;
    let current = record;
    // Accepted projections never grant permission to restore ownership, links or policy.
    if (record.state === "accepted") return this.inspectedResult(record, authority);
    try {
      // Only this freshly prepared, mutex-held admission owns a capture. It cannot
      // have an earlier root. Historical/uncertain admission still scans fail-closed.
      let runId = captured ? undefined : await this.findRoot(record);
      await authority.authorize({ ...command, workflowId: record.workflowId });
      if (!runId) {
        // Private preparation may already have provisioned a workspace. Never repeat an
        // uncertain external effect when no authenticated creation event was published.
        if (record.reservedRunId && (await orc.stores.execution.getInputs(record.reservedRunId))) throw unavailable();
        const launch =
          captured ??
          (this.opts.restoreLaunch
            ? await this.opts.restoreLaunch({
                requestId: record.requestId,
                generationId: record.generationId,
                workflow: { id: record.workflowId, version: record.workflowVersion, revision: record.workflowRevision },
              })
            : await this.opts.captureLaunch({
                purpose: "request",
                workflowId: record.workflowId,
                workflowVersion: record.workflowVersion,
                expectedWorkflowRevision: record.workflowRevision,
                expectedConfigGeneration: record.generationId,
              }));
        this.requireCorrelation(launch);
        if (
          launch.generationId !== record.generationId ||
          launch.workflow.id !== record.workflowId ||
          launch.workflow.version !== record.workflowVersion ||
          launch.workflow.revision !== record.workflowRevision
        )
          throw unavailable();
        const options = { ...this.options(command, request, authority, record.id, record.reservedRunId), actor };
        await launch.validateStartRun(options);
        // Request persistence is retried only before a root exists; never overwrite settlement.
        // Until startRun has persisted its authoritative sensitivity overlay we cannot know
        // which Request fields repeat a sensitive launch value. Keep a safe provisional
        // document; execution receives the original Request through protected vars.
        await orc.stores.requests.put(publicRequest(request));
        await authority.authorize({ ...command, workflowId: record.workflowId });
        runId = await launch.startRun(options);
        if (record.reservedRunId && runId !== record.reservedRunId) throw unavailable();
        current = { ...record, runId };
        await authority.authorize({ ...command, workflowId: record.workflowId });
        await publishAdmissionExecutionPolicy(orc.stores, this.policyBinding(current, actor));
      }
      current = { ...record, runId };
      // Historical or uncertain roots must already have their first-attachment policy.
      await requireAdmissionExecutionPolicy(orc.stores, this.policyBinding(current, actor));
      await admissions.records.put(current);
      // Refuse a provider that advertised correlation but failed to persist it.
      if ((await this.findRoot(current)) !== runId) throw unavailable();
      await authority.authorize({ ...command, workflowId: record.workflowId });
      await authority.onRunAdmitted(runId);
      const stored = await orc.stores.requests.get(record.requestId);
      if (stored?.programRunId && stored.programRunId !== runId) throw unavailable();
      // The projection and root link are published together, before execution is
      // accepted. Settlement requires that link. Once linked, this service must not
      // rewrite the Request: even preserving a read status races a concurrent settle.
      // The admission mutex serializes all first-link writers, including recovery.
      if (!stored?.programRunId) {
        const inputs = await orc.stores.execution.getInputs(runId);
        const projected = inputs?.sensitiveNames.includes("request")
          ? publicRequest(request)
          : {
              ...request,
              ...redactExecutionValue(
                { title: request.title, body: request.body, source: request.source, labels: request.labels },
                inputs?.secrets ?? [],
              ),
            };
        // Source kind is a structural enum, like event types; coincidental secret matches
        // must not turn an otherwise valid Request into an unreadable document.
        projected.source.kind = inputs?.sensitiveNames.includes("request") ? "manual" : request.source.kind;
        await orc.stores.requests.put({
          ...projected,
          status: stored?.status ?? request.status,
          updatedAt: stored?.updatedAt ?? request.updatedAt,
          programRunId: runId,
        });
      }
      current = { ...current, state: "accepted" };
      await this.verifyAccepted(current, authority);
      await admissions.records.put(current);
      // Execution is the adapter's responsibility, only after this durable boundary.
      return result(current);
    } catch {
      current = { ...current, state: "recoverable-failure" };
      // If the failure marker cannot be written, prepared remains discoverable and reconcilable.
      await admissions.records.put(current).catch(() => undefined);
      return result(current);
    }
  }
}

function publicRequest(request: Request): Request {
  return { ...request, title: "[REDACTED]", body: "[REDACTED]", source: { kind: "manual" }, labels: [] };
}

function selection(command: SubmissionCommand): Omit<LaunchSelection, "purpose"> {
  return {
    ...(command.workflowId !== undefined ? { workflowId: command.workflowId } : {}),
    ...(command.workflowVersion !== undefined ? { workflowVersion: command.workflowVersion } : {}),
    ...(command.expectedWorkflowRevision !== undefined
      ? { expectedWorkflowRevision: command.expectedWorkflowRevision }
      : {}),
    ...(command.expectedConfigGeneration !== undefined
      ? { expectedConfigGeneration: command.expectedConfigGeneration }
      : {}),
  };
}
function result(record: Admission): SubmissionResult {
  const ids = { admissionId: record.id, requestId: record.requestId };
  if (record.state === "accepted") {
    if (!record.runId) throw unavailable();
    return { ...ids, state: "accepted", runId: record.runId };
  }
  return record.state === "prepared"
    ? { ...ids, state: "prepared" }
    : {
        ...ids,
        state: "recoverable-failure",
        ...(record.runId ? { runId: record.runId } : {}),
        failure,
      };
}
