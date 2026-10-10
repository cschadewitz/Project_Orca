/** File-backed template authoring over the config writer lock; never reads protected run material. */
import { randomUUID } from "node:crypto";
import { link, lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { isScalar, parseDocument } from "yaml";
import {
  expandPatterns,
  OrcaError,
  parseOrcaConfig,
  parsePromptTemplate,
  parseWorkflow,
  renderTemplate,
  sha256,
  templateReferences,
  TemplateRegistry,
  validateWorkflow,
  type PromptTemplate,
  type WorkflowDefinition,
  type WorkflowGraph,
  type SubworkflowRef,
} from "@orca/core";
import {
  ProtocolFault,
  TemplateHistoryResultSchema,
  type ConfigApplyResult,
  type ConfigGetResult,
  type TemplateCatalog,
  type TemplateSourceCandidate,
  type TemplateSourceReview,
  type TemplatePreviewParams,
  type TemplateVariantParams,
  type TemplatePublicationParams,
  type TemplateAssignmentParams,
} from "@orca/protocol";

type Diagnostic = TemplateSourceReview["errors"][number];
type Source = { key: string; path: string; text: string; revision: string; template?: PromptTemplate };
type WorkflowSource = { key: string; path: string; text: string; revision: string; workflow: WorkflowDefinition };
type Loaded = { view: ConfigGetResult; sources: Source[]; workflows: WorkflowSource[]; snapshot: TemplateCatalog };
export interface TemplateAuthoringOptions {
  baseDir: string;
  readConfig(): Promise<ConfigGetResult>;
  exclusive<T>(command: () => Promise<T>): Promise<T>;
  applyLocked(
    params: { expectedRevision: string; expectedGeneration: string; validateOnly: boolean },
    recheck: () => Promise<void>,
  ): Promise<ConfigApplyResult>;
  changed(): Promise<void>;
}
function refuse(message: string): never {
  throw new ProtocolFault("CONFIG_STALE", message);
}
function invalid(message: string): never {
  throw new OrcaError("CONFIG_INVALID", message);
}
const assetKey = (path: string) => sha256(resolve(path));
const EMPTY = sha256("");

/** Canonical graph paths include inline graphs and decision-agent instruction choices. */
function selections(
  graph: WorkflowGraph,
  prefix: (string | number)[] = ["nodes"],
): { path: (string | number)[]; nodeId: string; templateId?: string }[] {
  return Object.entries(graph.nodes).flatMap(([id, node]) => {
    const path = [...prefix, id];
    const nodeId = path.filter((part) => part !== "nodes" && part !== "graph").join("::");
    if (node.type === "agent") return [{ path, nodeId, ...(node.template ? { templateId: node.template } : {}) }];
    if (node.type === "decision" && node.source.kind === "agent")
      return [
        { path: [...path, "source"], nodeId, ...(node.source.template ? { templateId: node.source.template } : {}) },
      ];
    const nested = (ref: SubworkflowRef | undefined, suffix: string[]) =>
      ref && "graph" in ref ? selections(ref.graph, [...path, ...suffix, "graph", "nodes"]) : [];
    if (node.type === "loop") return nested(node.body, ["body"]);
    if (node.type === "parallel")
      return [
        ...Object.entries(node.branches ?? {}).flatMap(([key, ref]) => nested(ref, ["branches", key])),
        ...nested(node.forEach?.body, ["forEach", "body"]),
      ];
    return [];
  });
}

/** Diagnostics are fixed prose. Parser exceptions may contain arbitrary rejected source. */
function parseSource(source: Source): Diagnostic[] {
  try {
    source.template = parsePromptTemplate(source.text);
    if (!source.template.id.trim()) {
      delete source.template;
      return [{ key: source.key, code: "missing-id", message: "Declare a non-empty template ID in front matter." }];
    }
    templateReferences(source.template.body);
    return [];
  } catch {
    delete source.template;
    return [
      {
        key: source.key,
        code: "front-matter",
        message: "Declare a valid ID and front matter; check template directives and expressions.",
      },
    ];
  }
}
function catalogDiagnostics(sources: Source[], workflows: WorkflowSource[]): Diagnostic[] {
  const errors = sources.flatMap(parseSource);
  const byId = new Map<string, Source>();
  for (const source of sources) {
    const template = source.template;
    if (!template) continue;
    if (byId.has(template.id))
      errors.push({
        key: source.key,
        code: "duplicate-id",
        message: "Template ID is already declared. Change one ID and its consumers.",
      });
    byId.set(template.id, source);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(source: Source): void {
    const template = source.template;
    if (!template || visited.has(template.id)) return;
    if (visiting.has(template.id)) {
      errors.push({
        key: source.key,
        code: "reference",
        message: "Partial references form a cycle. Remove the recursive exact-ID reference.",
      });
      return;
    }
    visiting.add(template.id);
    for (const id of templateReferences(template.body)) {
      const partial = byId.get(id);
      if (!partial)
        errors.push({
          key: source.key,
          code: "reference",
          message: "An exact-ID partial is missing. Register that ID; partials do not use pack fallback.",
        });
      else visit(partial);
    }
    visiting.delete(template.id);
    visited.add(template.id);
  }
  for (const source of sources) visit(source);
  for (const source of sources) {
    const template = source.template;
    if (!template?.id.includes("/")) continue;
    const base = byId.get(template.id.slice(template.id.indexOf("/") + 1))?.template;
    if (
      base &&
      (template.requires.some((kind) => !base.requires.includes(kind)) || template.produces !== base.produces)
    )
      errors.push({
        key: source.key,
        code: "compatibility",
        message:
          "Pack override requires additional context or changes the produced artifact kind. Keep the base instruction contract.",
      });
  }
  for (const { workflow } of workflows) {
    const check = validateWorkflow(workflow, { hasTemplate: (id) => byId.has(id) });
    if (!check.ok)
      errors.push({
        code: "reference",
        message: "A configured workflow is invalid or references a missing template. Repair its instruction selection.",
      });
  }
  return errors;
}

export class TemplateAuthoringService {
  private variants = new Map<
    string,
    { path: string; origin: string; originRevision: string; id: string; catalog: string; generation: string }
  >();
  constructor(private readonly options: TemplateAuthoringOptions) {}
  private assertTarget(target: TemplateSourceCandidate["target"], current: TemplateSourceCandidate["target"]): void {
    if (target.workspaceId !== current.workspaceId || target.instanceId !== current.instanceId)
      refuse("Template target changed.");
  }
  private fence(
    loaded: Loaded,
    params: {
      target: TemplateSourceCandidate["target"];
      expectedCatalogRevision: string;
      expectedConfigGeneration: string;
    },
  ): void {
    this.assertTarget(params.target, loaded.snapshot.target);
    if (
      params.expectedCatalogRevision !== loaded.snapshot.catalogRevision ||
      params.expectedConfigGeneration !== loaded.snapshot.generation
    )
      refuse("Template catalog or active generation changed. Reconcile retained source and review again.");
  }
  private async text(path: string): Promise<string> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144 || (await realpath(path)) !== resolve(path))
      invalid("Configured asset must be a bounded regular file without symlink traversal.");
    return readFile(path, "utf8");
  }
  private async loaded(target: TemplateSourceCandidate["target"]): Promise<Loaded> {
    const view = await this.options.readConfig();
    if (!view.generation) throw new OrcaError("NOT_SUPPORTED", "Template authoring needs configuration generations.");
    const config = parseOrcaConfig(view.config.parsed);
    if ([...config.templates, ...config.workflows].some((pattern) => pattern.includes("${")))
      throw new OrcaError("NOT_SUPPORTED", "Managed release assets require concrete configured paths.");
    const sources: Source[] = [],
      workflows: WorkflowSource[] = [];
    const workflowDigests = new Map<string, string>();
    const paths = await expandPatterns(config.templates, this.options.baseDir);
    const workflowPaths = await expandPatterns(config.workflows, this.options.baseDir);
    if (paths.length + workflowPaths.length > 500) invalid("Asset catalog exceeds the authoring bound.");
    for (const path of paths) {
      const text = await this.text(path);
      sources.push({ key: assetKey(path), path, text, revision: sha256(text) });
    }
    const errors: Diagnostic[] = [];
    for (const path of workflowPaths) {
      const text = await this.text(path);
      workflowDigests.set(path, sha256(text));
      try {
        workflows.push({
          key: assetKey(path),
          path,
          text,
          revision: sha256(text),
          workflow: parseWorkflow(text, path),
        });
      } catch {
        errors.push({
          code: "invalid",
          message: "A configured workflow cannot be parsed. Repair its source before template publication.",
        });
      }
    }
    errors.push(...catalogDiagnostics(sources, workflows));
    const assignments = workflows.flatMap((source) =>
      selections(source.workflow).map((selection) => ({
        key: `${source.key}:${JSON.stringify(selection.path)}`,
        workflowId: source.workflow.id,
        nodeId: selection.nodeId,
        revision: source.revision,
        ...(selection.templateId ? { templateId: selection.templateId } : {}),
      })),
    );
    const partialUses = new Map<string, string[]>();
    for (const source of sources) {
      if (!source.template) continue;
      for (const id of templateReferences(source.template.body)) {
        const uses = partialUses.get(id) ?? [];
        uses.push(`template:${source.template.id}`);
        partialUses.set(id, uses);
      }
    }
    const snapshot: TemplateCatalog = {
      target,
      configRevision: view.config.revision,
      generation: view.generation.activeGeneration,
      contextRevision: sha256(
        JSON.stringify([
          view.config.revision,
          workflowPaths.map((path) => [assetKey(path), workflowDigests.get(path)]),
        ]),
      ),
      catalogRevision: sha256(
        JSON.stringify([
          view.config.revision,
          sources.map(({ key, revision }) => [key, revision]),
          workflowPaths.map((path) => [assetKey(path), workflowDigests.get(path)]),
        ]),
      ),
      assets: sources.map((source) => ({
        key: source.key,
        revision: source.revision,
        id: source.template?.id ?? "",
        version: source.template?.version ?? "",
        requires: source.template?.requires ?? [],
        partials: source.template ? templateReferences(source.template.body) : [],
        usedBy: assignments
          .filter((assignment) => assignment.templateId !== undefined && assignment.templateId === source.template?.id)
          .map((assignment) => `${assignment.workflowId}:${assignment.nodeId}`)
          .concat(partialUses.get(source.template?.id ?? "") ?? []),
        source: { state: "available", text: source.text },
      })),
      assignments,
      workflows: workflows.map(({ workflow }) => ({ id: workflow.id, version: workflow.version })),
      errors,
    };
    return { view, sources, workflows, snapshot };
  }
  async read(target: TemplateSourceCandidate["target"], authorize: () => Promise<void>): Promise<TemplateCatalog> {
    await authorize();
    const loaded = await this.loaded(target);
    await authorize();
    return loaded.snapshot;
  }
  private candidate(
    loaded: Loaded,
    candidate: TemplateSourceCandidate,
  ): { sources: Source[]; source: Source; review: TemplateSourceReview } {
    this.fence(loaded, candidate);
    const existing = loaded.sources.find((source) => source.key === candidate.key);
    const variant = this.variants.get(candidate.key);
    if (
      !existing &&
      (!variant ||
        variant.catalog !== loaded.snapshot.catalogRevision ||
        variant.generation !== loaded.snapshot.generation ||
        !loaded.sources.some((source) => source.key === variant.origin && source.revision === variant.originRevision))
    )
      refuse("Source identity is unavailable. Recreate the variant from current source.");
    if (candidate.expectedSourceRevision !== (existing?.revision ?? EMPTY)) refuse("Template source changed.");
    const source: Source = {
      key: candidate.key,
      path: existing?.path ?? variant!.path,
      text: candidate.text,
      revision: sha256(candidate.text),
    };
    const sources = [...loaded.sources.filter((entry) => entry.key !== candidate.key), source].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const errors = [
      ...loaded.snapshot.errors.filter((error) => !error.key && error.code !== "reference"),
      ...catalogDiagnostics(sources, loaded.workflows),
    ];
    if (!existing && source.template?.id !== variant!.id)
      errors.push({
        key: candidate.key,
        code: "invalid",
        message: "Keep the service-derived variant ID or recreate this variant.",
      });
    const before = existing?.template,
      after = source.template;
    const changes = [existing ? "One existing source will be saved." : "One pack variant source will be created."];
    if (before?.body !== after?.body) changes.push("Instruction body changed; values are withheld from this review.");
    if (before?.version !== after?.version)
      changes.push("Version metadata changed; the label is not immutable lookup identity.");
    if (JSON.stringify(before?.requires) !== JSON.stringify(after?.requires))
      changes.push("Declared context requirements changed.");
    if (JSON.stringify(before?.meta) !== JSON.stringify(after?.meta) || before?.produces !== after?.produces)
      changes.push("Metadata or produced-artifact declaration changed; values are withheld.");
    const review: TemplateSourceReview = {
      candidateRevision: sha256(JSON.stringify([loaded.snapshot.catalogRevision, candidate.key, source.revision])),
      errors,
      compatibility: errors.length ? "incompatible" : "compatible",
      changes,
    };
    return { sources, source, review };
  }
  async validate(candidate: TemplateSourceCandidate, authorize: () => Promise<void>): Promise<TemplateSourceReview> {
    await authorize();
    const loaded = await this.loaded(candidate.target);
    const result = this.candidate(loaded, candidate).review;
    await authorize();
    this.fence(await this.loaded(candidate.target), candidate);
    return result;
  }
  async preview(params: TemplatePreviewParams, authorize: () => Promise<void>) {
    await authorize();
    const loaded = await this.loaded(params.target);
    this.fence(loaded, params);
    const candidate = params.candidate ? this.candidate(loaded, params.candidate) : undefined;
    if (candidate?.review.errors.length || (!candidate && loaded.snapshot.errors.length))
      invalid("Resolve template validation errors before preview.");
    const registry = new TemplateRegistry();
    for (const source of candidate?.sources ?? loaded.sources) if (source.template) registry.register(source.template);
    let template: PromptTemplate;
    try {
      template = registry.get(params.id, params.pack ? { pack: params.pack } : {});
    } catch {
      invalid("Choose a registered template ID before preview.");
    }
    const partialIds: string[] = [];
    const fixtures = params.fixtures;
    if (JSON.stringify(fixtures).length > 262_144) invalid("Preview fixtures exceed the authoring bound.");
    // values cannot replace artifact fixtures; there is no environment, path, secret or agent resolver here.
    let text: string;
    try {
      text = renderTemplate(
        template.body,
        {
          ...fixtures.values,
          artifacts: Object.fromEntries(Object.entries(fixtures.artifacts).map(([id, content]) => [id, { content }])),
        },
        {
          partials: (id) => {
            if (!partialIds.includes(id)) partialIds.push(id);
            return registry.partials(id);
          },
          maxOutputLength: 262_144,
          maxOperations: 100_000,
        },
      );
    } catch {
      invalid("Fixture preview refused. Check fixture shapes and reduce output or iteration size.");
    }
    if (text.length > 262_144) invalid("Rendered prompt exceeds the preview bound.");
    await authorize();
    this.fence(await this.loaded(params.target), params);
    return {
      requestedId: params.id,
      resolvedId: template.id,
      fallback: params.pack !== undefined && template.id === params.id,
      partialIds,
      text: redactPreview(text, loaded.view.config.parsed),
    };
  }
  private async writable(path: string): Promise<void> {
    const base = await realpath(this.options.baseDir),
      parent = await realpath(dirname(path));
    const rel = relative(base, parent);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      invalid("Save requires an asset inside this configuration directory. Import a local copy first.");
    if (parent !== resolve(dirname(path))) invalid("Asset directory traverses a symlink.");
  }
  async variant(params: TemplateVariantParams, authorize: () => Promise<void>) {
    await authorize();
    const loaded = await this.loaded(params.target);
    this.fence(loaded, params);
    const source = loaded.sources.find((item) => item.key === params.key);
    if (!source?.template || source.revision !== params.expectedSourceRevision) refuse("Variant origin changed.");
    const id = `${params.pack}/${source.template.id}`;
    if (loaded.sources.some((item) => item.template?.id === id)) invalid("Pack variant already exists.");
    const path = join(dirname(source.path), `${params.pack}.${basename(source.path)}`);
    await this.writable(path);
    if (
      await lstat(path).catch((error: unknown) => {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        return undefined;
      })
    )
      invalid("Variant source filename is already in use. Choose another pack name.");
    const config = parseOrcaConfig(loaded.view.config.parsed);
    if (!config.templates.some((pattern) => matchesGlob(path, resolve(this.options.baseDir, pattern))))
      invalid("Configured template patterns do not admit a sibling variant. Extend the pattern in Config first.");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.text);
    if (!match) invalid("Variant origin needs YAML front matter.");
    const document = parseDocument(match[1]!);
    const idNode = document.get("id", true);
    if (document.errors.length || !isScalar(idNode) || typeof idNode.value !== "string" || !idNode.range)
      invalid("Variant ID needs a scalar source span.");
    const start = source.text.indexOf(match[1]!);
    const text =
      source.text.slice(0, start + idNode.range[0]) + JSON.stringify(id) + source.text.slice(start + idNode.range[1]);
    parsePromptTemplate(text);
    await authorize();
    this.fence(await this.loaded(params.target), params);
    if (this.variants.size >= 500) this.variants.delete(this.variants.keys().next().value!);
    // The stable key is the service's future configured file identity, never a renderer path.
    const key = assetKey(path);
    this.variants.set(key, {
      path,
      origin: source.key,
      originRevision: source.revision,
      id,
      catalog: loaded.snapshot.catalogRevision,
      generation: loaded.snapshot.generation,
    });
    return { key, text };
  }
  async save(candidate: TemplateSourceCandidate, candidateRevision: string, authorize: () => Promise<void>) {
    return this.options.exclusive(async () => {
      await authorize();
      const loaded = await this.loaded(candidate.target);
      const result = this.candidate(loaded, candidate);
      if (result.review.candidateRevision !== candidateRevision) refuse("Reviewed template content changed.");
      if (result.review.errors.length) invalid("Template validation refused this source. Retain and repair the draft.");
      await this.writable(result.source.path);
      await authorize();
      this.fence(await this.loaded(candidate.target), candidate);
      const exists = loaded.sources.some((source) => source.key === candidate.key);
      await atomicSource(result.source.path, candidate.text, !exists);
      await this.recordHistory([
        { key: candidate.key, revision: result.source.revision, at: new Date().toISOString() },
      ]);
      this.variants.delete(candidate.key);
      await this.options.changed();
      const snapshot = (await this.loaded(candidate.target)).snapshot;
      await authorize();
      if (
        snapshot.generation !== candidate.expectedConfigGeneration ||
        snapshot.assets.find((source) => source.key === candidate.key)?.revision !== result.source.revision
      )
        refuse("Saved source changed before acknowledgement. Read and reconcile.");
      return { status: "saved" as const, candidateRevision, snapshot };
    });
  }
  async publish(params: TemplatePublicationParams, authorize: () => Promise<void>): Promise<ConfigApplyResult> {
    return this.options.exclusive(async () => {
      let reviewed: Source[] = [];
      const recheck = async () => {
        await authorize();
        const current = await this.loaded(params.target);
        this.fence(current, params);
        if (current.snapshot.configRevision !== params.expectedConfigRevision) refuse("Saved configuration changed.");
        if (current.snapshot.errors.length) invalid("Saved catalog is invalid. Repair references before Apply.");
        reviewed = current.sources;
      };
      await recheck();
      const result = await this.options.applyLocked(
        {
          expectedRevision: params.expectedConfigRevision,
          expectedGeneration: params.expectedConfigGeneration,
          validateOnly: params.validateOnly ?? false,
        },
        recheck,
      );
      if (!params.validateOnly && result.outcome === "applied") {
        await this.recordHistory(
          reviewed.map((source) => ({
            key: source.key,
            revision: source.revision,
            generation: result.status.activeGeneration,
            at: new Date().toISOString(),
          })),
        );
      }
      return result;
    });
  }
  async assign(params: TemplateAssignmentParams, authorize: () => Promise<void>) {
    return this.options.exclusive(async () => {
      await authorize();
      const loaded = await this.loaded(params.target);
      this.fence(loaded, params);
      if (!loaded.sources.some((item) => item.template?.id === params.templateId))
        invalid("Select a current catalog template ID.");
      const source = loaded.workflows.find((item) =>
        selections(item.workflow).some((choice) => `${item.key}:${JSON.stringify(choice.path)}` === params.key),
      );
      if (!source || source.revision !== params.expectedSourceRevision) refuse("Workflow instruction source changed.");
      const choice = selections(source.workflow).find(
        (item) => `${source.key}:${JSON.stringify(item.path)}` === params.key,
      )!;
      if (source.path.endsWith(".json"))
        invalid("Comment-preserving assignment currently requires YAML workflow source.");
      const document = parseDocument(source.text);
      document.setIn([...choice.path, "template"], params.templateId);
      document.deleteIn([...choice.path, "prompt"]);
      document.set("version", params.version);
      const text = document.toString();
      const workflow = parseWorkflow(text, source.path);
      if (
        !validateWorkflow(workflow, { hasTemplate: (id) => loaded.sources.some((item) => item.template?.id === id) }).ok
      )
        invalid("Workflow assignment validation refused.");
      if (params.version === source.workflow.version)
        invalid("Choose a new workflow version for changed instruction assignment.");
      const candidateRevision = sha256(text);
      if (params.validateOnly) return { written: false, candidateRevision, snapshot: loaded.snapshot };
      if (params.candidateRevision !== candidateRevision) refuse("Review the exact workflow assignment before saving.");
      await this.writable(source.path);
      await authorize();
      this.fence(await this.loaded(params.target), params);
      await atomicSource(source.path, text, false);
      await this.options.changed();
      const snapshot = (await this.loaded(params.target)).snapshot;
      await authorize();
      if (
        snapshot.generation !== params.expectedConfigGeneration ||
        snapshot.assignments.find((item) => item.key === params.key)?.revision !== candidateRevision
      )
        refuse("Workflow source changed before acknowledgement. Read and reconcile.");
      return { written: true, candidateRevision, snapshot };
    });
  }
  private historyPath(): string {
    return join(this.options.baseDir, ".orca-template-history.json");
  }
  private async historyEntries(): Promise<{ key: string; revision: string; at: string; generation?: string }[]> {
    try {
      const text = await this.text(this.historyPath());
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) invalid("Template history metadata is invalid.");
      return parsed.map((entry: unknown) => {
        if (!entry || typeof entry !== "object" || typeof (entry as { key?: unknown }).key !== "string")
          invalid("Template history metadata is invalid.");
        const key = (entry as { key: string }).key;
        const row = TemplateHistoryResultSchema.shape.entries.element.parse(entry);
        const { generation, ...rest } = row;
        return { key, ...rest, ...(generation === undefined ? {} : { generation }) };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
  }
  private async recordHistory(
    entries: { key: string; revision: string; at: string; generation?: string }[],
  ): Promise<void> {
    const path = this.historyPath();
    const history = await this.historyEntries();
    const next = [...history, ...entries].filter(
      (entry, index, all) =>
        all.findIndex(
          (other) =>
            other.key === entry.key && other.revision === entry.revision && other.generation === entry.generation,
        ) === index,
    );
    const text = JSON.stringify(next) + "\n";
    if (text.length > 262_144)
      invalid("Template revision history reached its bound. Source was saved; read and reconcile before retrying.");
    await this.writable(path);
    await atomicSource(path, text, history.length === 0 && !(await lstat(path).catch(() => undefined)));
  }
  async history(key: string, target: TemplateSourceCandidate["target"], authorize: () => Promise<void>) {
    await authorize();
    const loaded = await this.loaded(target);
    if (!loaded.sources.some((source) => source.key === key)) refuse("Template history source is unavailable.");
    const entries = (await this.historyEntries())
      .filter((entry) => entry.key === key)
      .map(({ key: _key, ...entry }) => entry);
    await authorize();
    return { scope: "acknowledged-local-revisions" as const, entries };
  }
}

/** New sources use exclusive creation; existing files use temp + rename under the shared writer lock. */
async function atomicSource(path: string, text: string, create: boolean): Promise<void> {
  const stat = create ? undefined : await lstat(path);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) invalid("Asset is no longer a regular file.");
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { encoding: "utf8", flag: "wx", mode: stat ? stat.mode & 0o777 : 0o600 });
    if (create) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Preview only: preserve source bytes, never resolve secrets, withhold identifiable literal credentials. */
function redactPreview(text: string, config: unknown): string {
  const needles = new Set<string>();
  function walk(value: unknown, sensitive = false): void {
    if (typeof value === "string" && sensitive && value) needles.add(value);
    else if (Array.isArray(value)) value.forEach((item) => walk(item, sensitive));
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value))
        walk(item, sensitive || /(?:token|secret|password|credential|api[_-]?key|authorization)/i.test(key));
  }
  walk(config);
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) text = text.replaceAll(needle, "[REDACTED]");
  return text.replace(
    /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
    "[REDACTED]",
  );
}
