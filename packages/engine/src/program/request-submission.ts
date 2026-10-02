/** One durable admission lifecycle; client retry keys deliberately belong to #331. */
import { randomUUID } from "node:crypto";
import { redactExecutionValue } from "@orca/store";
import {
  newId,
  OrcaError,
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
import type { Orchestrator, StartRunOptions } from "../orchestrator.js";
import { RequestAdmissionCorrelationSchema } from "./request-admission-event.js";
import { AdmissionSchema, type Admission, type AdmissionStore } from "./submission-store.js";

export interface LaunchSelection {
  purpose: "workflow" | "request";
  workflowId?: string;
  workflowVersion?: string;
  expectedWorkflowRevision?: string;
  expectedConfigGeneration?: string;
}
export type BoundLaunchOptions = Omit<
  StartRunOptions,
  "workflowId" | "workflowVersion" | "expectedWorkflowRevision" | "inline"
> & { requestAdmissionId?: string };
export interface CapturedLaunch {
  /** startRun persists requestAdmissionId in the protected creation payload, never in vars. */
  readonly requestAdmissionCorrelation: true;
  readonly generationId: string;
  readonly workflow: Readonly<{ id: string; version: string; revision: string }>;
  validateStartRun(options: BoundLaunchOptions): Promise<void>;
  startRun(options: BoundLaunchOptions): Promise<string>;
}
export type CaptureLaunch = (selection: LaunchSelection) => Promise<CapturedLaunch>;

export interface RequestSubmissionOptions {
  orchestrator: Orchestrator;
  admissions: AdmissionStore;
  captureLaunch: CaptureLaunch;
}

const unavailable = () => new OrcaError("RUN_STATE", "request admission is unavailable");
const failure = {
  code: "RUN_STATE",
  message: "Request admission is incomplete; reconcile the original admission",
  recovery: "reconcile",
} as const;

export class RequestSubmissionService implements SubmissionService {
  constructor(private readonly opts: RequestSubmissionOptions) {}

  async submit(input: SubmissionCommand, authority: SubmissionAuthority): Promise<SubmissionResult> {
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
    const id = `admission_${randomUUID()}`;
    const request = RequestSchema.parse({
      id: newId("req", this.opts.orchestrator.clock.now()),
      title: command.title,
      body: command.body,
      source: command.source,
      labels: command.labels,
      status: "decomposing",
      createdAt: this.opts.orchestrator.clock.isoNow(),
      updatedAt: this.opts.orchestrator.clock.isoNow(),
    });
    const options = this.options(command, request, authority, id);
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
    };
    // Seal first. The discoverable index never contains title/body, vars, source or overrides.
    // Reuse protected-execution-v2 key handling and immutable authenticated records.
    try {
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
        return this.admit(record, command, request, authority, captured);
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
      const { command, request } = await this.material(record);
      await authority.authorize({ ...command, workflowId: record.workflowId });
      return this.admit(record, command, request, authority);
    });
  }

  async inspect(id: string, authority: SubmissionAuthority): Promise<SubmissionResult> {
    await authority.authorize({ title: "", body: "" });
    const record = await this.owned(id, authority);
    await authority.authorize({ title: "", body: "", workflowId: record.workflowId });
    return result(record);
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
      await authority.authorize({ title: "", body: "", workflowId: record.workflowId });
      results.push(result(record));
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

  private async material(record: Admission): Promise<{ command: SubmissionCommand; request: Request }> {
    const sealed = await this.opts.orchestrator.stores.execution.getInputs(record.id);
    const command = SubmissionCommandSchema.safeParse(sealed?.vars.command);
    const request = RequestSchema.safeParse(sealed?.vars.request);
    const admission = AdmissionSchema.safeParse(sealed?.vars.admission);
    if (
      !sealed ||
      !command.success ||
      !request.success ||
      request.data.id !== record.requestId ||
      !admission.success ||
      admission.data.id !== record.id ||
      admission.data.requestId !== record.requestId ||
      admission.data.workspaceId !== record.workspaceId ||
      admission.data.principalId !== record.principalId ||
      admission.data.generationId !== record.generationId ||
      admission.data.correlationVersion !== record.correlationVersion ||
      admission.data.workflowRevision !== record.workflowRevision ||
      sealed.workflowId !== record.workflowId ||
      sealed.workflowVersion !== record.workflowVersion
    )
      throw unavailable();
    return { command: command.data, request: request.data };
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
  ): BoundLaunchOptions {
    return {
      requestId: request.id,
      vars: { ...command.vars, request },
      requestAdmissionId: admissionId,
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
    const readRoot = async (runId: string) => {
      const first = (await orc.stores.events.readRange(runId, { limit: 1 }))[0];
      if (!first || first.type !== "run.created") throw unavailable();
      if (first.payload.executionInputsStored && !first.executionPayloadRef) throw unavailable();
      // The correlation can coincide with a sensitive value. Recovery reads the sealed
      // original, never treats redacted public metadata as absence of a durable root.
      const original = first.executionPayloadRef
        ? await orc.stores.execution.getPayload(runId, first.executionPayloadRef, first.type)
        : first.payload;
      const restored = OrcaEventSchema.safeParse({ ...first, payload: original });
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
  ): Promise<SubmissionResult> {
    const { orchestrator: orc, admissions } = this.opts;
    let current = record;
    try {
      let runId = await this.findRoot(record);
      await authority.authorize({ ...command, workflowId: record.workflowId });
      if (!runId) {
        const launch =
          captured ??
          (await this.opts.captureLaunch({
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
        const options = this.options(command, request, authority, record.id);
        await launch.validateStartRun(options);
        // Request persistence is retried only before a root exists; never overwrite settlement.
        // Until startRun has persisted its authoritative sensitivity overlay we cannot know
        // which Request fields repeat a sensitive launch value. Keep a safe provisional
        // document; execution receives the original Request through protected vars.
        await orc.stores.requests.put(publicRequest(request));
        await authority.authorize({ ...command, workflowId: record.workflowId });
        runId = await launch.startRun(options);
      }
      current = { ...record, runId };
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
