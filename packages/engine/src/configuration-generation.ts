/** Immutable launch generations. Persistence uses the existing protected execution store. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AgentRegistry } from "@orca/agents";
import {
  AgentSpecSchema,
  OrcaConfigSchema,
  OrcaError,
  PromptTemplateSchema,
  TemplateRegistry,
  WorkflowRegistry,
  validateWorkflow,
  type OrcaConfig,
  type PromptTemplate,
  type WorkflowDefinition,
} from "@orca/core";
import type { WorkflowVersionStore } from "@orca/store";
import { workflowRevision, type StartRunOptions } from "./orchestrator.js";

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
>;
export interface CapturedLaunch {
  readonly generationId: string;
  readonly workflow: Readonly<{ id: string; version: string; revision: string }>;
  validateStartRun(options: BoundLaunchOptions): Promise<void>;
  startRun(options: BoundLaunchOptions): Promise<string>;
}
export type CaptureLaunch = (selection: LaunchSelection) => Promise<CapturedLaunch>;
/** Trusted recovery only: values must come from the authorized, durable Request admission. */
export interface RecordedRequestLaunch {
  requestId: string;
  generationId: string;
  workflow: { id: string; version: string; revision: string };
}
export type RestoreLaunch = (recorded: RecordedRequestLaunch) => Promise<CapturedLaunch>;

const WorkflowIdentitySchema = z.object({ id: z.string(), version: z.string(), revision: z.string() });
export const GenerationSnapshotSchema = z.object({
  id: z.string(),
  savedRevision: z.string(),
  config: OrcaConfigSchema,
  workflows: z.array(WorkflowIdentitySchema),
  templates: z.array(PromptTemplateSchema),
  runtimeBinding: z.string().optional(),
  effectiveAgents: z.array(AgentSpecSchema).optional(),
  effectiveRoles: z.record(z.string(), z.string()).optional(),
});
export type GenerationSnapshot = z.infer<typeof GenerationSnapshotSchema>;
export interface GenerationStore {
  getGeneration(id: string): Promise<unknown>;
  putGeneration(id: string, snapshot: GenerationSnapshot): Promise<void>;
}
export interface GenerationAssets {
  /** Executable plugin hosts are retained only within this provider lifetime. */
  agents?: AgentRegistry;
  workflows: WorkflowDefinition[];
  templates: PromptTemplate[];
}
export interface GenerationMaterial {
  readonly snapshot: GenerationSnapshot;
  readonly agents: AgentRegistry;
  readonly workflows: WorkflowRegistry;
  readonly templates: TemplateRegistry;
}
/** The integration binds these operations to the existing orchestrator, never to an RPC caller. */
export interface GenerationAdmission {
  validateStartRun(options: StartRunOptions, generation: GenerationMaterial): Promise<unknown>;
  startRun(options: StartRunOptions, generation: GenerationMaterial): Promise<string>;
}
export interface GenerationStatus {
  savedRevision: string;
  activeGeneration: string;
  activeRevision: string;
  state: "active" | "pending" | "restart-required" | "invalid";
  restartRequired: string[];
}
export interface GenerationApplyResult {
  outcome: "applied" | "unchanged" | "validated" | "restart-required" | "invalid";
  status: GenerationStatus;
  validation: { errors: { path: string; message: string }[] };
}

/** Exhaustive allow-list. Every other setting, including newly introduced ones, requires restart. */
export const RELOADABLE_CONFIG_FIELDS = ["roles", "program", "workflows", "templates"] as const;
export function restartRequired(active: unknown, candidate: unknown): string[] {
  const before = record(active),
    after = record(candidate);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !RELOADABLE_CONFIG_FIELDS.some((field) => field === key))
    .filter((key) => !isDeepStrictEqual(before[key], after[key]))
    .sort();
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
const unavailable = () => new OrcaError("RUN_STATE", "recorded configuration generation is missing or invalid");

export class ConfigurationGenerations {
  private active: GenerationMaterial | undefined;
  private readonly runtimeBindings = new Map<string, AgentRegistry>();
  private readonly listeners = new Set<(status: GenerationStatus, workflows: WorkflowChange[]) => void>();
  constructor(
    private readonly options: {
      store: GenerationStore;
      workflows: WorkflowVersionStore;
      loadAssets(config: OrcaConfig): Promise<GenerationAssets>;
      admission: GenerationAdmission;
      validateCustomNode?: NonNullable<Parameters<typeof validateWorkflow>[1]>["validateCustomNode"];
    },
  ) {}

  /** Boot adopts the saved config. Old runs restore their own recorded generation, never this one. */
  async initialize(config: OrcaConfig, savedRevision: string, assets?: GenerationAssets): Promise<void> {
    if (this.active) throw new OrcaError("CONFIG_INVALID", "configuration generations are already initialized");
    const material = await this.prepare(OrcaConfigSchema.parse(OrcaConfigSchema.parse(config)), savedRevision, assets);
    await this.persist(material);
    this.active = material;
  }
  effectiveConfig(): OrcaConfig {
    return this.current.snapshot.config;
  }
  get current(): GenerationMaterial {
    if (!this.active) throw unavailable();
    return this.active;
  }
  onChange(listener: (status: GenerationStatus, workflows: WorkflowChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  status(raw: unknown, savedRevision: string): GenerationStatus {
    const active = this.current.snapshot;
    const first = OrcaConfigSchema.safeParse(raw);
    const parsed = first.success ? OrcaConfigSchema.safeParse(first.data) : first;
    // Check unknown keys too: Zod intentionally strips these, but apply must not silently accept them.
    const extra = first.success ? unknownFields(raw, first.data) : [];
    const restart = parsed.success ? [...restartRequired(active.config, parsed.data), ...extra].sort() : [];
    return {
      savedRevision,
      activeGeneration: active.id,
      activeRevision: active.savedRevision,
      state: !parsed.success
        ? "invalid"
        : restart.length
          ? "restart-required"
          : savedRevision === active.savedRevision
            ? "active"
            : "pending",
      restartRequired: restart,
    };
  }
  /** Called under the config file writer's lock; recheck() also detects noncooperating external edits. */
  async apply(
    raw: unknown,
    savedRevision: string,
    expectedGeneration: string,
    validateOnly: boolean,
    recheck: () => Promise<void>,
  ): Promise<GenerationApplyResult> {
    const previous = this.current;
    if (previous.snapshot.id !== expectedGeneration)
      throw new OrcaError("CONFIG_STALE", "active configuration changed; refresh before applying");
    const status = this.status(raw, savedRevision);
    const errors: { path: string; message: string }[] = [];
    const result = (outcome: GenerationApplyResult["outcome"]): GenerationApplyResult => ({
      outcome,
      status,
      validation: { errors },
    });
    const first = OrcaConfigSchema.safeParse(raw);
    const parsed = first.success ? OrcaConfigSchema.safeParse(first.data) : first;
    if (!parsed.success) {
      errors.push(
        ...parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: "invalid configuration value" })),
      );
      return result("invalid");
    }
    if (status.restartRequired.length) return result("restart-required");
    if (parsed.data.plugins.length) {
      status.state = "restart-required";
      status.restartRequired = ["plugins"];
      return result("restart-required");
    }
    let candidate: GenerationMaterial;
    try {
      candidate = await this.prepare(parsed.data, savedRevision);
      for (const field of ["workflow", "itemWorkflow"] as const) {
        const value = parsed.data.program[field];
        if (
          (value !== previous.snapshot.config.program[field] || previous.workflows.has(value)) &&
          !candidate.workflows.has(value)
        )
          candidateInvalid(`program.${field}`, "selected workflow is not registered");
      }
    } catch (error) {
      // Parsers and plugins can include source bytes in errors. Never send those over apply.
      const safe = CandidateIssueSchema.safeParse(
        error instanceof OrcaError ? error.details?.generationValidation : undefined,
      );
      errors.push(
        safe.success
          ? safe.data
          : {
              path: "workflows",
              message: "candidate assets could not be loaded; inspect their syntax and references",
            },
      );
      return result("invalid");
    }
    await recheck();
    if (this.current !== previous)
      throw new OrcaError("CONFIG_STALE", "active configuration changed; refresh before applying");
    if (validateOnly) return result("validated");
    if (isDeepStrictEqual({ ...candidate.snapshot, id: "" }, { ...previous.snapshot, id: "" }))
      return result("unchanged");
    await this.persist(candidate);
    await recheck();
    if (this.current !== previous)
      throw new OrcaError("CONFIG_STALE", "active configuration changed; refresh before applying");
    this.active = candidate; // The only activation point; no await between compare and swap.
    const applied = this.status(raw, savedRevision);
    for (const listener of this.listeners) {
      try {
        listener(applied, workflowChanges(previous.snapshot, candidate.snapshot));
      } catch {
        /* observers cannot undo activation */
      }
    }
    return { outcome: "applied", status: applied, validation: { errors: [] } };
  }

  readonly captureLaunch: CaptureLaunch = async (selection) => {
    selection = { ...selection };
    const material = this.current; // Capture before the first await.
    if (selection.expectedConfigGeneration !== undefined && selection.expectedConfigGeneration !== material.snapshot.id)
      throw new OrcaError("CONFIG_STALE", "active configuration changed; refresh before launching");
    return this.captureMaterial(selection, material);
  };

  /** Distinct from fresh capture: never expose historical selection directly to RPC callers. */
  readonly restoreLaunch: RestoreLaunch = async (recorded) => {
    recorded = structuredClone(recorded);
    if (!recorded.requestId) throw unavailable();
    const material = await this.restore(recorded.generationId);
    return this.captureMaterial(
      {
        purpose: "request",
        workflowId: recorded.workflow.id,
        workflowVersion: recorded.workflow.version,
        expectedWorkflowRevision: recorded.workflow.revision,
      },
      material,
      recorded.requestId,
    );
  };

  private async captureMaterial(
    selection: LaunchSelection,
    material: GenerationMaterial,
    recordedRequestId?: string,
  ): Promise<CapturedLaunch> {
    const id =
      selection.workflowId ?? (selection.purpose === "request" ? material.snapshot.config.program.workflow : undefined);
    if (!id) throw new OrcaError("WORKFLOW_NOT_FOUND", "workflow launch requires a workflow id");
    const live = material.workflows.has(id) ? material.workflows.get(id) : undefined;
    const definition =
      selection.workflowVersion === undefined
        ? live
        : ((await this.options.workflows.get(id, selection.workflowVersion)) ??
          (live?.version === selection.workflowVersion ? live : undefined));
    if (!definition) throw new OrcaError("WORKFLOW_VERSION_NOT_FOUND", "selected workflow version is unavailable");
    const workflow = frozen({ id: definition.id, version: definition.version, revision: workflowRevision(definition) });
    if (selection.expectedWorkflowRevision !== undefined && selection.expectedWorkflowRevision !== workflow.revision)
      throw new OrcaError("WORKFLOW_INVALID", "workflow changed; validate inputs again before launching");
    // Explicit whitelist prevents JavaScript callers from smuggling inline/workflow/generation substitutions.
    const bound = (options: BoundLaunchOptions): StartRunOptions => {
      if (recordedRequestId && options.requestId !== undefined && options.requestId !== recordedRequestId)
        throw new OrcaError("RUN_STATE", "recovery Request differs from recorded admission");
      const { actor, workspace, workItemId, parentRunId, parentStepRunId, overrides } = options;
      const requestId = recordedRequestId ?? options.requestId;
      const vars =
        selection.purpose === "request"
          ? { itemWorkflow: material.snapshot.config.program.itemWorkflow, ...options.vars }
          : options.vars;
      return {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        expectedWorkflowRevision: workflow.revision,
        ...(actor ? { actor } : {}),
        ...(vars ? { vars: structuredClone(vars) } : {}),
        ...(workspace ? { workspace: structuredClone(workspace) } : {}),
        ...(requestId ? { requestId } : {}),
        ...(workItemId ? { workItemId } : {}),
        ...(parentRunId ? { parentRunId } : {}),
        ...(parentStepRunId ? { parentStepRunId } : {}),
        ...(overrides ? { overrides: structuredClone(overrides) } : {}),
      };
    };
    return Object.freeze({
      generationId: material.snapshot.id,
      workflow,
      validateStartRun: async (options: BoundLaunchOptions) => {
        await this.options.admission.validateStartRun(bound(options), material);
      },
      startRun: async (options: BoundLaunchOptions) => this.options.admission.startRun(bound(options), material),
    });
  }

  /** No fallback to current. Validate protected material and every reused workflow pin on each restore. */
  async restore(id: string): Promise<GenerationMaterial> {
    const parsed = GenerationSnapshotSchema.safeParse(await this.options.store.getGeneration(id));
    if (!parsed.success || parsed.data.id !== id) throw unavailable();
    const definitions = await Promise.all(
      parsed.data.workflows.map(async (identity) => {
        const def = await this.options.workflows.get(identity.id, identity.version);
        if (!def || workflowRevision(def) !== identity.revision) throw unavailable();
        return def;
      }),
    );
    return this.material(parsed.data, definitions);
  }
  private material(snapshot: GenerationSnapshot, definitions: WorkflowDefinition[]): GenerationMaterial {
    const runtimeAgents = snapshot.runtimeBinding ? this.runtimeBindings.get(snapshot.runtimeBinding) : undefined;
    if (snapshot.config.plugins.length && !snapshot.runtimeBinding) throw unavailable();
    if (snapshot.runtimeBinding && (!runtimeAgents || !snapshot.effectiveAgents || !snapshot.effectiveRoles))
      throw unavailable();
    frozen(snapshot);
    const agents = snapshot.runtimeBinding ? new AgentRegistry() : AgentRegistry.fromConfig(snapshot.config);
    if (snapshot.runtimeBinding) {
      for (const host of runtimeAgents!.listHosts()) agents.addHost(host);
      for (const agent of snapshot.effectiveAgents ?? []) agents.addAgent(agent);
      for (const [role, id] of Object.entries(snapshot.effectiveRoles ?? {})) agents.mapRole(role, id);
    }
    const workflows = new WorkflowRegistry(),
      templates = new TemplateRegistry();
    for (const def of definitions) workflows.register(frozen(structuredClone(def)));
    for (const template of snapshot.templates) templates.register(template);
    readonlyRegistry(workflows, ["register"]);
    readonlyRegistry(templates, ["register", "registerSource"]);
    return Object.freeze({
      snapshot,
      agents: readonlyRegistry(agents, ["addHost", "addAgent", "mapRole"]),
      workflows,
      templates,
    });
  }
  private async prepare(
    config: OrcaConfig,
    savedRevision: string,
    supplied?: GenerationAssets,
  ): Promise<GenerationMaterial> {
    const loaded = supplied ?? (await this.options.loadAssets(config));
    const assets = structuredClone({ workflows: loaded.workflows, templates: loaded.templates });
    const runtimeBinding = loaded.agents ? randomUUID() : undefined;
    if (loaded.agents && runtimeBinding) {
      const runtimeAgents = new AgentRegistry();
      for (const host of loaded.agents.listHosts()) runtimeAgents.addHost(host);
      this.runtimeBindings.set(runtimeBinding, runtimeAgents);
    }
    const material = this.material(
      {
        id: randomUUID(),
        savedRevision,
        config: structuredClone(config),
        ...(loaded.agents
          ? {
              runtimeBinding,
              effectiveAgents: structuredClone(loaded.agents.listAgents()),
              effectiveRoles: loaded.agents.listRoles(),
            }
          : {}),
        workflows: assets.workflows.map((def) => ({
          id: def.id,
          version: def.version,
          revision: workflowRevision(def),
        })),
        templates: assets.templates,
      },
      assets.workflows,
    );
    for (const [role, id] of Object.entries(config.roles)) {
      if (!material.agents.canResolve(id))
        candidateInvalid(`roles.${role}`, "selected agent or host is not configured");
    }
    for (const def of assets.workflows) {
      const kept = await this.options.workflows.get(def.id, def.version);
      if (kept && workflowRevision(kept) !== workflowRevision(def))
        candidateInvalid(
          `workflows.${def.id}.version`,
          "recorded workflow version has different content; bump its version",
        );
      const validation = validateWorkflow(def, {
        hasTemplate: (id) => material.templates.has(id),
        hasWorkflow: (id) => material.workflows.has(id),
        hasAgent: (selector) => material.agents.canResolve(selector),
        ...(this.options.validateCustomNode ? { validateCustomNode: this.options.validateCustomNode } : {}),
      });
      if (!validation.ok)
        candidateInvalid(validation.errors[0]?.path ?? `workflows.${def.id}`, "workflow graph or reference is invalid");
    }
    return material;
  }
  private async persist(material: GenerationMaterial): Promise<void> {
    for (const def of material.workflows.list()) {
      await this.options.workflows.put(def);
      const kept = await this.options.workflows.get(def.id, def.version);
      if (!kept || workflowRevision(kept) !== workflowRevision(def))
        throw new OrcaError("WORKFLOW_INVALID", "recorded workflow versions are immutable");
    }
    await this.options.store.putGeneration(material.snapshot.id, material.snapshot);
  }
}

export interface WorkflowChange {
  id: string;
  version: string;
  removed?: boolean;
}
function workflowChanges(before: GenerationSnapshot, after: GenerationSnapshot): WorkflowChange[] {
  const changed = after.workflows.filter((item) => !before.workflows.some((old) => isDeepStrictEqual(item, old)));
  const removed = before.workflows.filter((item) => !after.workflows.some((next) => next.id === item.id));
  return [
    ...changed.map(({ id, version }) => ({ id, version })),
    ...removed.map(({ id, version }) => ({ id, version, removed: true })),
  ];
}

/** Freeze the registration surface too: Object.freeze alone does not freeze Map entries. */
function readonlyRegistry<T extends object>(registry: T, methods: (keyof T)[]): T {
  for (const method of methods)
    Object.defineProperty(registry, method, {
      value: () => {
        throw new OrcaError("NOT_SUPPORTED", "configuration generation registries are immutable");
      },
      writable: false,
      configurable: false,
    });
  return Object.freeze(registry);
}
function unknownFields(raw: unknown, parsed: unknown, prefix = ""): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed))
    return raw.flatMap((value, index) => unknownFields(value, parsed[index], `${prefix}[${index}]`));
  if (raw === null || typeof raw !== "object") return [];
  const normalized = record(parsed);
  return Object.entries(record(raw)).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return !Object.hasOwn(normalized, key) ? [path] : unknownFields(value, normalized[key], path);
  });
}

const CandidateIssueSchema = z.object({ path: z.string(), message: z.string() });
function candidateInvalid(path: string, message: string): never {
  throw new OrcaError("CONFIG_INVALID", "candidate configuration is invalid", {
    generationValidation: { path, message },
  });
}
