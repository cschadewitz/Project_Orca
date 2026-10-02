/** Authorized bounded projections; never accepts a caller-selected principal or raw config RPC. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  OrcaError,
  reduceRunSummary,
  validateWorkflowInputs,
  redactWorkflowInputSchema,
  type OrcaEvent,
  type WorkflowDefinition,
} from "@orca/core";
import { lapsed, type EventStore, type LeaseStore } from "@orca/store";
import { workflowRevision, type ConfigurationGenerations, type GenerationStatus } from "@orca/engine";
import { ProtocolFault, displayStatusForRun, type ArtifactsGetResult } from "@orca/protocol";
import {
  OperatorArtifactParamsSchema,
  OperatorConfigSchema,
  OperatorDiscoverySchema,
  OperatorPageParamsSchema,
  OperatorPreflightParamsSchema,
  OperatorRowSchema,
  OPERATOR_MAX_RESULT_BYTES,
  type OperatorCollection,
  type OperatorDiscovery,
  type OperatorPageParams,
  type OperatorPageResult,
  type OperatorRow,
  type OperatorTarget,
} from "@orca/protocol";
import { holds, workflowAllowed, type Permission, type Principal } from "./auth/principal.js";

export interface OperatorSnapshot {
  /** An opaque revision, covering inserts, removals, sensitivity overlays and backup rewind. */
  revision: string;
  rows: AsyncIterable<OperatorRow>;
  currentRevision(): Promise<string>;
}
export interface OperatorReadOptions {
  target: OperatorTarget;
  orcaVersion: string;
  protocol: { major: number; minor: number };
  /** Must authenticate/current-check the original credential on every invocation. */
  current(): Promise<Principal>;
  allowsRun(principal: Principal, runId: string): Promise<boolean>;
  /** Implementations stream bounded store pages, never call runs.get/inputs.list then slice. */
  collections: Partial<
    Record<OperatorCollection, (params: OperatorPageParams, principal: Principal) => Promise<OperatorSnapshot>>
  >;
  /** Exact methods actually wired, intersected with current grants by the integrator. */
  operations(principal: Principal): string[];
  generations?: ConfigurationGenerations;
  configStatus?: () => Promise<GenerationStatus>;
  artifactRun?: (artifactId: string) => Promise<string | undefined>;
  artifact?: (runId: string, artifactId: string, maxBytes: number) => Promise<ArtifactsGetResult>;
  now?: () => Date;
  /** One random boot key, shared by per-call model instances; never serialized. */
  cursorKey?: Uint8Array;
}
const permissions: Record<OperatorCollection, Permission> = {
  runs: "runs.read",
  steps: "runs.read",
  children: "runs.read",
  events: "runs.read",
  inputs: "runs.read",
  artifacts: "artifacts.read",
  workflows: "workflows.read",
  graph: "workflows.read",
  requests: "plan.read",
  items: "plan.read",
  provenance: "runs.read",
  choices: "config.read",
};
const scoped = new Set<OperatorCollection>(["steps", "children", "events", "inputs", "artifacts", "provenance"]);
const forbidden = () => new ProtocolFault("AUTH_FORBIDDEN", "Operation is not authorized");
const unsupported = () => new OrcaError("NOT_SUPPORTED", "Operator projection is not available");

export class OperatorReadModel {
  // A restart deliberately invalidates cursors. This key is not an admission ledger.
  private readonly cursorKey: Uint8Array;
  constructor(private readonly options: OperatorReadOptions) {
    this.cursorKey = options.cursorKey ?? randomBytes(32);
    if (this.cursorKey.byteLength < 32) throw new OrcaError("CONFIG_INVALID", "Operator cursor key is too short");
  }
  private stamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
  private async principal(permission?: Permission): Promise<Principal> {
    const principal = await this.options.current();
    if (principal.kind !== "credential" || !principal.credentialId)
      throw new ProtocolFault("AUTH_REQUIRED", "A verified credential is required");
    if (permission && !holds(principal, permission)) throw forbidden();
    return principal;
  }
  private async unchanged(principal: Principal, permission: Permission): Promise<void> {
    const latest = await this.principal(permission);
    if (
      latest.id !== principal.id ||
      JSON.stringify(latest.scope) !== JSON.stringify(principal.scope) ||
      JSON.stringify([...latest.permissions].sort()) !== JSON.stringify([...principal.permissions].sort())
    )
      throw forbidden();
  }
  private target(target: OperatorTarget): void {
    if (target.workspaceId !== this.options.target.workspaceId || target.instanceId !== this.options.target.instanceId)
      throw new OrcaError("RUN_STATE", "Target changed; discover the deployment again");
  }
  async discover(): Promise<OperatorDiscovery> {
    const p = await this.principal();
    return OperatorDiscoverySchema.parse({
      target: this.options.target,
      protocol: this.options.protocol,
      orcaVersion: this.options.orcaVersion,
      principalId: p.id,
      authentication: "credential",
      scope: { ...p.scope, permissions: [...p.permissions].filter((x) => holds(p, x)) },
      operations: this.options.operations(p),
      asOf: this.stamp(),
      collections: Object.keys(this.options.collections).filter(
        (c) => holds(p, permissions[c as OperatorCollection]) && (c !== "artifacts" || holds(p, "runs.read")),
      ),
    });
  }
  async page(raw: OperatorPageParams): Promise<OperatorPageResult> {
    // Operation authorization precedes schema diagnostics; collection is a closed routing discriminant.
    const p = await this.principal();
    const permission = permissions[raw?.collection];
    if (!permission || !holds(p, permission) || (raw.collection === "artifacts" && !holds(p, "runs.read")))
      throw forbidden();
    const params = OperatorPageParamsSchema.parse(raw);
    this.target(params.target);
    if (scoped.has(params.collection) && !params.runId)
      throw new ProtocolFault("PROTOCOL_MESSAGE", "This collection requires runId");
    if (params.runId && !(await this.options.allowsRun(p, params.runId)))
      throw new OrcaError("RUN_NOT_FOUND", "Run is unavailable");
    if (params.workflowId && !workflowAllowed(p.scope, params.workflowId))
      throw new OrcaError("WORKFLOW_NOT_FOUND", "Workflow is unavailable");
    if (
      ["graph", "workflows"].includes(params.collection) &&
      !params.workflowId &&
      !params.runId &&
      p.scope.workflows !== "*"
    )
      throw new ProtocolFault("PROTOCOL_MESSAGE", "A scoped workflow read requires workflowId");
    const open = this.options.collections[params.collection];
    if (!open) throw unsupported();
    const { cursor: _cursor, limit: _limit, ...filter } = params;
    const binding = this.sign(
      JSON.stringify({ principal: p.id, scope: p.scope, permissions: [...p.permissions].sort(), filter }),
    );
    const snapshot = await open(params, p);
    const result: OperatorPageResult = {
      target: this.options.target,
      items: [],
      asOf: this.stamp(),
      revision: snapshot.revision,
      truncated: false,
      restartRequired: false,
    };
    let after = -1;
    if (params.cursor) {
      const decoded = this.decode(params.cursor);
      if (!decoded || decoded.binding !== binding || decoded.revision !== snapshot.revision)
        return { ...result, restartRequired: true };
      after = decoded.offset;
    }
    let visible = -1;
    for await (const original of snapshot.rows) {
      const row = await this.project(p, original);
      if (!row) continue;
      visible++;
      if (visible <= after) continue;
      // Budget includes JSON escaping and worst-case MCP text/structured duplication.
      const candidate = { ...result, items: [...result.items, row] };
      if (
        result.items.length === params.limit ||
        Buffer.byteLength(JSON.stringify(candidate)) > (OPERATOR_MAX_RESULT_BYTES - 4096) / 3
      ) {
        result.nextCursor = this.encode({ binding, revision: snapshot.revision, offset: visible - 1 });
        result.truncated = true;
        break;
      }
      result.items.push(row);
    }
    await this.unchanged(p, permission); // revocation during a scan cannot leak its result
    const visibleAgain = await Promise.all(result.items.map((row) => this.project(p, row)));
    if (JSON.stringify(visibleAgain) !== JSON.stringify(result.items)) throw forbidden();
    if ((await snapshot.currentRevision()) !== snapshot.revision)
      return {
        target: result.target,
        items: [],
        asOf: result.asOf,
        revision: result.revision,
        truncated: false,
        restartRequired: true,
      };
    return result;
  }
  private async project(p: Principal, input: OperatorRow): Promise<OperatorRow | undefined> {
    // Strip future/raw fields first. This is an allowlist, never ad-hoc config redaction.
    const row = OperatorRowSchema.parse(input);
    if (
      row.live &&
      (row.live.target.runId !== row.runId ||
        row.live.target.stepRunId !== row.stepRunId ||
        row.live.target.requestId !== row.id)
    )
      throw new OrcaError("RUN_STATE", "Input projection has inconsistent identity");
    if (row.runId && !(await this.options.allowsRun(p, row.runId))) return undefined;
    if (!row.runId && row.workflowId && !workflowAllowed(p.scope, row.workflowId)) return undefined;
    for (const key of ["parentRunId", "childRunId"] as const)
      if (row[key] && !(await this.options.allowsRun(p, row[key]))) delete row[key];
    if (!holds(p, "plan.read")) {
      if (!["decision", "permission", "question", "human.requested", "human.answered"].includes(row.kind))
        delete row.requestId;
      delete row.workItemId;
    }
    if (!holds(p, "artifacts.read")) {
      if (row.kind === "artifact.recorded" || row.artifactId) return undefined;
    }
    if (Buffer.byteLength(JSON.stringify(row)) > 12 * 1024)
      return { id: row.id, kind: row.kind, ...(row.runId ? { runId: row.runId } : {}), omitted: ["oversized-item"] };
    return row;
  }
  async config(target: OperatorTarget) {
    const p = await this.principal("config.read");
    this.target(target);
    if (!this.options.configStatus) throw unsupported();
    const status = await this.options.configStatus();
    await this.unchanged(p, "config.read");
    return OperatorConfigSchema.parse({ ...status, target: this.options.target, asOf: this.stamp() });
  }
  async preflight(raw: import("zod").input<typeof OperatorPreflightParamsSchema>) {
    const p = await this.principal("runs.start");
    const params = OperatorPreflightParamsSchema.parse(raw);
    this.target(params.target);
    const generations = this.options.generations;
    if (!generations) throw unsupported();
    const material = generations.current;
    const workflowId =
      params.workflowId ?? (params.purpose === "request" ? material.snapshot.config.program.workflow : undefined);
    if (!workflowId || !workflowAllowed(p.scope, workflowId))
      throw new OrcaError("WORKFLOW_NOT_FOUND", "Workflow is unavailable");
    // Capture may select stored content before the active definition for an explicit version.
    // The generation guard alone therefore does not prove that our validation uses that content.
    const launch = await generations.captureLaunch({
      purpose: params.purpose,
      workflowId,
      expectedConfigGeneration: material.snapshot.id,
      ...(params.workflowVersion ? { workflowVersion: params.workflowVersion } : {}),
    });
    const definition = material.snapshot.workflowDefinitions?.find(
      (d) => d.id === launch.workflow.id && d.version === launch.workflow.version,
    );
    if (!definition || workflowRevision(definition) !== launch.workflow.revision)
      throw new OrcaError("NOT_SUPPORTED", "The captured workflow definition is unavailable for preflight validation");
    const { validation } = validateWorkflowInputs(definition, params.vars);
    await this.unchanged(p, "runs.start");
    return {
      target: this.options.target,
      workflowId,
      workflowVersion: launch.workflow.version,
      expectedWorkflowRevision: launch.workflow.revision,
      expectedConfigGeneration: launch.generationId,
      validation,
      asOf: this.stamp(),
    };
  }
  async artifact(raw: import("zod").input<typeof OperatorArtifactParamsSchema>) {
    const p = await this.principal("artifacts.read");
    const params = OperatorArtifactParamsSchema.parse(raw);
    this.target(params.target);
    if (!holds(p, "runs.read") || !(await this.options.allowsRun(p, params.runId)))
      throw new OrcaError("ARTIFACT_MISSING", "Artifact is unavailable");
    if (!this.options.artifact || !this.options.artifactRun) throw unsupported();
    if ((await this.options.artifactRun(params.artifactId)) !== params.runId)
      throw new OrcaError("ARTIFACT_MISSING", "Artifact is unavailable");
    // The injected shared read must check exact artifact -> run before reading content and
    // apply the existing protected-artifact sensitivity policy. Never use ArtifactStore.content.
    const result = await this.options.artifact(params.runId, params.artifactId, params.maxBytes);
    const a = result.artifact;
    const row: OperatorRow = {
      id: a.id,
      kind: "artifact",
      runId: params.runId,
      version: a.version,
      size: a.size,
      mediaType: a.mediaType,
    };
    await this.unchanged(p, "artifacts.read");
    if (
      !(await this.options.allowsRun(p, params.runId)) ||
      (await this.options.artifactRun(params.artifactId)) !== params.runId
    )
      throw new OrcaError("ARTIFACT_MISSING", "Artifact is unavailable");
    return {
      target: this.options.target,
      artifact: row,
      ...(result.text !== undefined && Buffer.byteLength(result.text) <= params.maxBytes
        ? { text: result.text }
        : { omitted: result.omitted?.reason ?? ("tooLarge" as const) }),
      asOf: this.stamp(),
    };
  }
  private sign(value: string): string {
    return createHmac("sha256", this.cursorKey).update(value).digest("base64url");
  }
  private encode(value: Cursor): string {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }
  private decode(value: string): Cursor | undefined {
    try {
      const parts = value.split(".");
      if (parts.length !== 2) return undefined;
      const [body, signature] = parts;
      const expected = Buffer.from(this.sign(body!));
      const actual = Buffer.from(signature!);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
      const parsed = JSON.parse(Buffer.from(body!, "base64url").toString()) as Cursor;
      return Number.isSafeInteger(parsed.offset) && parsed.offset >= -1 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}
interface Cursor {
  binding: string;
  revision: string;
  offset: number;
}

/** Public events only. Bounded reads at the store, including for multi-megabyte histories. */
export async function eventSnapshot(events: EventStore, params: OperatorPageParams): Promise<OperatorSnapshot> {
  const runId = params.runId!;
  const revision = await eventRevision(events, runId);
  const endSeq = (await events.lastSeq(runId)) ?? -1;
  const types =
    params.collection === "steps"
      ? ["step.scheduled", "step.started", "step.completed", "step.failed", "step.waiting"]
      : params.collection === "children"
        ? ["child.spawned", "child.finished"]
        : params.collection === "artifacts"
          ? ["artifact.recorded"]
          : params.collection === "provenance"
            ? ["run.created"]
            : undefined;
  return {
    revision,
    currentRevision: async () => eventRevision(events, runId),
    rows: (async function* () {
      let after = -1;
      for (;;) {
        const page = await events.readRange(runId, {
          after,
          limit: 100,
          types,
          match: (e) =>
            e.seq <= endSeq &&
            (!params.stepRunId || ("stepRunId" in e.payload && e.payload.stepRunId === params.stepRunId)),
        });
        if (!page.length) return;
        for (const event of page) {
          yield* eventRows(event);
          after = event.seq;
        }
      }
    })(),
  };
}
function* eventRows(event: OrcaEvent): Generator<OperatorRow> {
  const base: OperatorRow = { id: event.id, kind: event.type, runId: event.runId, seq: event.seq, at: event.at };
  const p = event.payload;
  for (const key of [
    "stepRunId",
    "nodeId",
    "childRunId",
    "parentRunId",
    "workflowId",
    "workflowVersion",
    "requestId",
    "workItemId",
    "agentId",
  ] as const)
    if (key in p && typeof p[key as keyof typeof p] === "string")
      Object.assign(base, { [key]: p[key as keyof typeof p] });
  if ("attempt" in p && typeof p.attempt === "number") base.attempt = p.attempt;
  if ("error" in p && p.error) base.errorCode = p.error.code;
  if (event.type === "agent.update") {
    base.text = event.payload.update.text;
    base.omitted = ["tool-arguments", "tool-results", "paths"];
  }
  if (event.type === "artifact.recorded") {
    const a = event.payload.artifact;
    Object.assign(base, {
      artifactId: a.id,
      version: a.version,
      size: a.size,
      mediaType: a.mediaType,
      contentHash: a.contentHash,
    });
  }
  if (event.type === "run.created" && event.payload.provenance) {
    const prov = event.payload.provenance;
    Object.assign(base, { configGeneration: prov.configGeneration, workflowRevision: prov.workflow.revision });
    for (const [index, choice] of prov.selections.entries())
      yield {
        id: `${event.id}:selection:${index}`,
        kind: "selection",
        runId: event.runId,
        nodeId: choice.nodeId,
        agentId: choice.agent.value,
        source: choice.agent.source,
        ...(choice.model ? { modelId: choice.model.value } : {}),
        ...(choice.template ? { templateId: choice.template.value } : {}),
      };
  }
  yield base;
}

/** A pinned, already-authorized definition; no prompts, vars, paths or executable metadata. */
export async function* workflowRows(definition: WorkflowDefinition): AsyncGenerator<OperatorRow> {
  for (const [id, node] of Object.entries(definition.nodes))
    yield { id, kind: node.type, workflowId: definition.id, workflowVersion: definition.version };
  for (const [index, edge] of definition.edges.entries())
    yield { id: `edge:${index}`, kind: "edge", from: edge.from, to: edge.to };
  const schema = definition.inputSchema && redactWorkflowInputSchema(definition.inputSchema);
  for (const [id, field] of Object.entries(schema?.fields ?? {}))
    yield { id, kind: "input-declaration", text: JSON.stringify(field) };
}

/** Concrete store projections; only run ID metadata is enumerated, never whole run bodies. */
export function operatorEventCollections(options: {
  events: EventStore;
  leases?: LeaseStore;
  allowsRun(principal: Principal, runId: string): Promise<boolean>;
  /** The owning live input coordinator. Without it, callback identities are owner-unavailable. */
  liveRevision?: () => string;
  liveState?: (target: import("@orca/protocol").LiveDecisionTarget) => import("@orca/protocol").LiveInputView["state"];
}): OperatorReadOptions["collections"] {
  const { events } = options;
  const leaseLapsed = async (id: string) => {
    const lease = await options.leases?.get(`run:${id}`);
    return !lease || lapsed(lease, options.leases?.clock?.now());
  };
  if (options.liveState && !options.liveRevision)
    throw new OrcaError("CONFIG_INVALID", "Live input projection requires an invalidation revision");
  return {
    events: (p) => eventSnapshot(events, p),
    steps: (p) => eventSnapshot(events, p),
    children: (p) => eventSnapshot(events, p),
    artifacts: (p) => eventSnapshot(events, p),
    provenance: (p) => eventSnapshot(events, p),
    inputs: async (params) => {
      const runId = params.runId!;
      const base = await eventSnapshot(events, params);
      const endSeq = (await events.lastSeq(runId)) ?? -1;
      const liveRevision = options.liveRevision?.() ?? "unavailable";
      return {
        ...base,
        revision: `${base.revision}:${liveRevision}`,
        currentRevision: async () => `${await base.currentRevision()}:${options.liveRevision?.() ?? "unavailable"}`,
        rows: (async function* () {
          let after = -1;
          for (;;) {
            const page = await events.readRange(runId, {
              after,
              types: ["human.requested"],
              limit: 100,
              match: (e) => e.seq <= endSeq,
            });
            if (!page.length) return;
            for (const event of page) {
              after = event.seq;
              if (event.type !== "human.requested") continue;
              const p = event.payload;
              if (params.stepRunId && p.stepRunId !== params.stepRunId) continue;
              const answered = await events.readRange(runId, {
                after: event.seq,
                limit: 1,
                types: ["human.answered", "run.completed", "run.cancelled", "run.failed"],
                match: (e) => e.type !== "human.answered" || e.payload.requestId === p.requestId,
              });
              if (answered.length) continue;
              const live = p.liveDecision
                ? { runId, stepRunId: p.stepRunId, requestId: p.requestId, ...p.liveDecision }
                : undefined;
              // A legacy permission has no living invocation. Never advertise it as a durable gate.
              if (p.kind === "permission" && !live) continue;
              yield {
                id: p.requestId,
                kind: p.kind,
                runId,
                stepRunId: p.stepRunId,
                requestId: p.requestId,
                text: p.question,
                options: p.options,
                at: event.at,
                ...(live ? { live: { target: live, state: options.liveState?.(live) ?? "owner-unavailable" } } : {}),
                omitted: ["context", "artifact-links"],
              };
            }
          }
        })(),
      };
    },
    runs: async (params, principal) => {
      const visible = async () => {
        const ids = params.runId ? [params.runId] : await events.listRuns();
        const rows: { id: string; revision: string }[] = [];
        for (const id of ids) {
          if (!(await options.allowsRun(principal, id))) continue;
          rows.push({
            id,
            revision: `${await eventRevision(events, id)}:${options.leases ? await leaseLapsed(id) : "unknown"}`,
          });
        }
        return rows;
      };
      const records = await visible();
      const revisionOf = (rows: { id: string; revision: string }[]) =>
        createHmac("sha256", "operator-run-revision").update(JSON.stringify(rows)).digest("hex");
      return {
        revision: revisionOf(records),
        currentRevision: async () => revisionOf(await visible()),
        rows: (async function* () {
          for (const { id } of records) {
            const [first] = await events.readRange(id, { limit: 1 });
            if (first?.type !== "run.created") continue;
            const p = first.payload;
            if (params.workflowId && params.workflowId !== p.workflowId) continue;
            if (params.requestId && params.requestId !== p.requestId) continue;
            const [last] = await events.readRange(id, {
              before: Number.MAX_SAFE_INTEGER,
              limit: 1,
              types: [
                "run.created",
                "run.started",
                "run.resumed",
                "run.paused",
                "run.completed",
                "run.failed",
                "run.cancelled",
              ],
            });
            const [step] = await events.readRange(id, {
              before: Number.MAX_SAFE_INTEGER,
              limit: 1,
              match: (e) => e.seq > (last?.seq ?? first.seq),
              types: ["step.waiting", "step.completed", "step.failed"],
            });
            const summary = reduceRunSummary([
              first,
              ...(last && last.id !== first.id ? [last] : []),
              ...(step ? [step] : []),
            ]);
            const status = options.leases
              ? displayStatusForRun(summary, {
                  waitingOn: step?.type === "step.waiting" ? step.payload.on : undefined,
                  leaseLapsed:
                    (summary.status === "running" || summary.status === "waiting") && (await leaseLapsed(id)),
                })
              : summary.status;
            yield {
              id,
              kind: "run",
              runId: id,
              workflowId: p.workflowId,
              workflowVersion: p.workflowVersion,
              at: first.at,
              status,
              ...(p.parentRunId ? { parentRunId: p.parentRunId } : {}),
              ...(p.requestId ? { requestId: p.requestId } : {}),
              ...(p.workItemId ? { workItemId: p.workItemId } : {}),
              ...(p.provenance
                ? { configGeneration: p.provenance.configGeneration, workflowRevision: p.provenance.workflow.revision }
                : {}),
              ...(options.leases ? {} : { omitted: ["lease-derived-status"] }),
            };
          }
        })(),
      };
    },
  };
}
async function eventRevision(events: EventStore, runId: string): Promise<string> {
  const [last] = await events.readRange(runId, { before: Number.MAX_SAFE_INTEGER, limit: 1 });
  return last ? `${last.id}:${last.seq}` : "empty";
}

/** All choices in a page come from the same immutable generation; no executable config escapes. */
export function operatorGenerationCollections(
  generations: ConfigurationGenerations,
): OperatorReadOptions["collections"] {
  return {
    workflows: async (params) => {
      const generation = generations.current;
      return {
        revision: generation.snapshot.id,
        currentRevision: async () => generations.current.snapshot.id,
        rows: (async function* () {
          for (const wf of generation.snapshot.workflows)
            if (!params.workflowId || params.workflowId === wf.id)
              yield {
                id: wf.id,
                kind: "workflow",
                workflowId: wf.id,
                workflowVersion: wf.version,
                workflowRevision: wf.revision,
                configGeneration: generation.snapshot.id,
              };
        })(),
      };
    },
    graph: async (params) => {
      const generation = generations.current;
      const def = generation.snapshot.workflowDefinitions?.find(
        (d) => d.id === params.workflowId && (!params.workflowVersion || d.version === params.workflowVersion),
      );
      if (!def)
        throw new OrcaError(
          "WORKFLOW_VERSION_NOT_FOUND",
          "Selected workflow is not available in the active generation",
        );
      return {
        revision: generation.snapshot.id,
        currentRevision: async () => generations.current.snapshot.id,
        rows: workflowRows(def),
      };
    },
    choices: async () => {
      const generation = generations.current;
      return {
        revision: generation.snapshot.id,
        currentRevision: async () => generations.current.snapshot.id,
        rows: (async function* () {
          for (const agent of generation.agents.listAgents()) {
            yield { id: agent.id, kind: "agent", agentId: agent.id, configGeneration: generation.snapshot.id };
            for (const [index, model] of (agent.models ?? []).entries())
              yield {
                id: `${agent.id}:model:${index}`,
                kind: "model",
                agentId: agent.id,
                modelId: model.id,
                source: "declared",
                configGeneration: generation.snapshot.id,
              };
          }
          for (const [role, agentId] of Object.entries(generation.agents.listRoles()))
            yield {
              id: role,
              kind: "role",
              agentId,
              source: "configuration",
              configGeneration: generation.snapshot.id,
            };
          for (const template of generation.snapshot.templates)
            yield {
              id: template.id,
              kind: "template",
              templateId: template.id,
              configGeneration: generation.snapshot.id,
            };
        })(),
      };
    },
  };
}

/** Request/work-item links discovered from public run headers, not whole document dumps. */
export function operatorLinkedDocumentCollections(options: {
  events: EventStore;
  requests: import("@orca/store").DocumentStore<import("@orca/core").Request>;
  items: import("@orca/store").DocumentStore<import("@orca/core").WorkItem>;
}): OperatorReadOptions["collections"] {
  const open = async (params: OperatorPageParams): Promise<OperatorSnapshot> => {
    const documents = params.collection === "requests" ? options.requests : options.items;
    const index = async () => {
      const ids = new Set<string>();
      if (params.collection === "requests" && params.requestId) ids.add(params.requestId);
      else
        for (const runId of params.runId ? [params.runId] : await options.events.listRuns()) {
          const [first] = await options.events.readRange(runId, { limit: 1 });
          if (first?.type !== "run.created") continue;
          if (params.requestId && params.requestId !== first.payload.requestId) continue;
          const id = params.collection === "requests" ? first.payload.requestId : first.payload.workItemId;
          if (id) ids.add(id);
        }
      const revisions: [string, string][] = [];
      for (const id of ids) {
        const doc = await documents.get(id);
        if (doc) revisions.push([id, doc.updatedAt]);
      }
      return revisions;
    };
    const records = await index();
    const digest = (rows: [string, string][]) =>
      createHmac("sha256", "operator-document-revision").update(JSON.stringify(rows)).digest("hex");
    return {
      revision: digest(records),
      currentRevision: async () => digest(await index()),
      rows: (async function* () {
        for (const [id] of records) {
          const doc = await documents.get(id);
          if (!doc) continue;
          yield {
            id,
            kind: params.collection === "requests" ? "request" : "work-item",
            status: doc.status,
            ...("programRunId" in doc && doc.programRunId ? { runId: doc.programRunId } : {}),
            ...("runId" in doc && doc.runId ? { runId: doc.runId } : {}),
            ...("requestId" in doc ? { requestId: doc.requestId } : {}),
            at: doc.updatedAt,
            omitted: ["body", "title", "paths", "unlinked-documents"],
          };
        }
      })(),
    };
  };
  return { requests: open, items: open };
}

/** Resolve exactly the workflow pinned by an authorized run, even after active config changes. */
export function operatorPinnedGraph(options: {
  events: EventStore;
  definitionFor(workflowId: string, version: string, stored: boolean): Promise<WorkflowDefinition>;
  active?: NonNullable<OperatorReadOptions["collections"]["graph"]>;
}): NonNullable<OperatorReadOptions["collections"]["graph"]> {
  return async (params, principal) => {
    if (!params.runId) {
      if (!options.active) throw unsupported();
      return options.active(params, principal);
    }
    const [first] = await options.events.readRange(params.runId, { limit: 1 });
    if (first?.type !== "run.created") throw new OrcaError("RUN_NOT_FOUND", "Run is unavailable");
    const p = first.payload;
    if (!workflowAllowed(principal.scope, p.workflowId))
      throw new OrcaError("WORKFLOW_NOT_FOUND", "Workflow is unavailable");
    if (
      (params.workflowId && params.workflowId !== p.workflowId) ||
      (params.workflowVersion && params.workflowVersion !== p.workflowVersion)
    )
      throw new OrcaError("WORKFLOW_VERSION_NOT_FOUND", "Selection differs from the run's pinned workflow");
    const definition = await options.definitionFor(p.workflowId, p.workflowVersion, p.workflowStored ?? false);
    const revision = `${first.id}:${p.provenance?.workflow.revision ?? p.workflowVersion}`;
    return {
      revision,
      currentRevision: async () => {
        const [current] = await options.events.readRange(params.runId!, { limit: 1 });
        return current?.id === first.id ? revision : "changed";
      },
      rows: workflowRows(definition),
    };
  };
}
