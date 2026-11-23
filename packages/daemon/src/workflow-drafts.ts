/**
 * Workflow drafts (#180): the daemon half of the visual workflow editor (#181, #182).
 *
 * **A draft is a file beside the workflow, never the workflow.** Opening the editor copies
 * the workflow's YAML into `<workflow dir>/.drafts/<id>@<owner>.json`, with the base it was
 * taken from, the layout, and an undo history; every edit lands there. The live file changes
 * only on an explicit, reviewed publish. `.drafts/` and `.layout/` are dot directories, which
 * the configured `workflows/**` globs never descend into, so neither is ever loaded as a
 * workflow.
 *
 * **Every edit goes through the comment-preserving YAML document.** Operations are semantic
 * (add a node, connect two, rename one) and each is applied to the `yaml` package's
 * `Document` with `setIn`, `deleteIn` and the collection APIs - the same representation
 * `config-model.ts` and template assignment edit - so comments, key order, quoting and blank
 * lines survive, and a published change diffs exactly like the hand edit it stands for.
 *
 * **Layout is separate metadata.** A dragged node's position is a `place` operation on the
 * draft's layout record, never a field in the workflow: a drag cannot show in a workflow diff,
 * and a node nobody pinned is drawn by the client's automatic layout. Publishing writes the
 * layout to `<workflow dir>/.layout/<id>.json`.
 *
 * **One draft per workflow, owned by whoever opened it.** Another principal sees it read-only
 * rather than starting a competing one (docs/design/70-workflow-editing.md). Every mutation
 * names the revision it was made against, under a per-workflow lock, so two windows cannot
 * overwrite each other; publish names the review it confirmed and runs under the
 * configuration writer lock, re-checking the base file, then activates a generation exactly
 * as `templates.publish` does. A refused activation restores the previous file.
 */
import { readdir, lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Document, type Pair, type YAMLMap, type YAMLSeq } from "yaml";
import { z } from "zod";
import {
  expandPatterns,
  OrcaError,
  parseOrcaConfig,
  parseWorkflow,
  type WorkflowDefinition,
  sha256,
  systemClock,
  validateWorkflow,
  WorkflowDefinitionSchema,
  type Clock,
  type ValidationContext,
  type WorkflowGraph,
  type NodeDef,
} from "@orca/core";
import {
  draftGraphKey,
  DraftLayoutSchema,
  ProtocolFault,
  type ConfigApplyResult,
  type ConfigGetResult,
  type DraftGraphPath,
  type DraftGraphStep,
  type DraftIssue,
  type DraftLayout,
  type DraftOperation,
  type WorkflowDraftGetResult,
  type WorkflowDraftPublishResult,
  type WorkflowDraftReview,
  type WorkflowDraftView,
} from "@orca/protocol";
import { withFileLock } from "@orca/store";
import { atomicSource } from "./template-authoring.js";

/** The same bound template authoring puts on one source. */
const MAX_TEXT = 262_144;
/** Undo steps kept per draft, and the most bytes of history the draft file carries. */
const MAX_HISTORY = 100;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const DRAFTS_DIR = ".drafts";
const LAYOUT_DIR = ".layout";

export interface WorkflowDraftOptions {
  baseDir: string;
  readConfig(): Promise<ConfigGetResult>;
  /** The configuration writer lock publication holds, shared with `config.set` and templates. */
  exclusive<T>(command: () => Promise<T>): Promise<T>;
  applyLocked(
    params: { expectedRevision: string; expectedGeneration: string; validateOnly: boolean },
    recheck: () => Promise<void>,
  ): Promise<ConfigApplyResult>;
  /** The active generation's references; absent before a generation exists. */
  validationContext(): ValidationContext | undefined;
  clock?: Clock;
}

/** Who is asking, and the two authority checks the guard hands every configuration method. */
export interface DraftCaller {
  principalId: string;
  read(): Promise<void>;
  write(): Promise<void>;
}

function refuse(message: string): never {
  throw new ProtocolFault("CONFIG_STALE", message);
}
function invalid(message: string): never {
  throw new OrcaError("CONFIG_INVALID", message);
}

const SnapshotSchema = z.object({ text: z.string(), layout: DraftLayoutSchema });
const DraftRecordSchema = z.object({
  v: z.literal(1),
  workflowId: z.string(),
  owner: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  base: z.object({ version: z.string(), revision: z.string(), text: z.string(), layout: DraftLayoutSchema }),
  text: z.string(),
  layout: DraftLayoutSchema,
  past: z.array(SnapshotSchema),
  future: z.array(SnapshotSchema),
});
type DraftRecord = z.infer<typeof DraftRecordSchema>;
type Snapshot = z.infer<typeof SnapshotSchema>;
const LayoutFileSchema = z.object({ v: z.literal(1), workflowId: z.string(), graphs: DraftLayoutSchema.shape.graphs });

interface WorkflowSource {
  path: string;
  text: string;
  revision: string;
  version: string;
}

const emptyLayout = (): DraftLayout => ({ graphs: {} });

/**
 * The next version a publish writes. Trailing digits count up (`1` → `2`, `1.4` → `1.5`,
 * `v3` → `v4`); a version with none gains `.1`. Publication needs a new version - a recorded
 * version with different content is refused by generation activation (#179).
 */
export function nextWorkflowVersion(version: string): string {
  const match = /^(.*?)(\d+)$/.exec(version);
  return match ? `${match[1]}${Number(match[2]) + 1}` : `${version}.1`;
}

export class WorkflowDraftService {
  private readonly clock: Clock;
  constructor(private readonly options: WorkflowDraftOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /* ---------- reads ---------- */

  async get(workflowId: string, caller: DraftCaller): Promise<WorkflowDraftGetResult> {
    await caller.read();
    const located = await this.locate(workflowId);
    if (!located.source) {
      await caller.read();
      return { draft: null, layout: emptyLayout(), editable: false, reason: located.reason };
    }
    const layout = await this.publishedLayout(located.source.path, workflowId);
    const record = await this.findDraft(located.source.path, workflowId);
    const draft = record ? this.view(record, located.source, caller.principalId) : null;
    await caller.read();
    return {
      draft,
      layout,
      editable: located.reason === undefined,
      ...(located.reason !== undefined ? { reason: located.reason } : {}),
    };
  }

  /* ---------- writes ---------- */

  /** The caller's draft, created from the live file if there is none; somebody else's, read-only. */
  async open(workflowId: string, caller: DraftCaller): Promise<WorkflowDraftView> {
    await caller.write();
    const source = await this.editable(workflowId);
    return this.locked(source.path, workflowId, async () => {
      const existing = await this.findDraft(source.path, workflowId);
      if (existing) return this.view(existing, source, caller.principalId);
      const now = this.clock.isoNow();
      const layout = await this.publishedLayout(source.path, workflowId);
      const record: DraftRecord = {
        v: 1,
        workflowId,
        owner: caller.principalId,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        base: { version: source.version, revision: source.revision, text: source.text, layout },
        text: source.text,
        layout,
        past: [],
        future: [],
      };
      await caller.write();
      await this.writeDraft(source.path, record, true);
      return this.view(record, source, caller.principalId);
    });
  }

  async apply(
    params: { workflowId: string; expectedRevision: number; ops: DraftOperation[] },
    caller: DraftCaller,
  ): Promise<WorkflowDraftView> {
    return this.mutate(params, caller, (record) => {
      const next = applyOperations(record.text, record.layout, params.ops, params.workflowId);
      if (next.text === record.text && isDeepStrictEqual(next.layout, record.layout)) return undefined;
      return {
        current: next,
        past: trimHistory([...record.past, { text: record.text, layout: record.layout }]),
        future: [],
      };
    });
  }

  async undo(params: { workflowId: string; expectedRevision: number }, caller: DraftCaller) {
    return this.mutate(params, caller, (record) => {
      const previous = record.past.at(-1);
      if (!previous) invalid("There is nothing to undo.");
      return {
        current: previous,
        past: record.past.slice(0, -1),
        future: trimHistory([...record.future, { text: record.text, layout: record.layout }]),
      };
    });
  }

  async redo(params: { workflowId: string; expectedRevision: number }, caller: DraftCaller) {
    return this.mutate(params, caller, (record) => {
      const following = record.future.at(-1);
      if (!following) invalid("There is nothing to redo.");
      return {
        current: following,
        past: trimHistory([...record.past, { text: record.text, layout: record.layout }]),
        future: record.future.slice(0, -1),
      };
    });
  }

  /**
   * The exact definition this revision of the caller's own draft describes, for a dry run (#183).
   * Refused while validation finds an error, as publish is; nothing is written.
   */
  async dryRunSource(
    params: { workflowId: string; expectedRevision: number },
    caller: DraftCaller,
  ): Promise<{ definition: WorkflowDefinition; revision: number }> {
    await caller.write();
    const source = await this.editable(params.workflowId);
    const record = await this.locked(source.path, params.workflowId, () => this.ownDraft(source, params, caller));
    const errors = this.issues(record.text, record.workflowId).filter((issue) => issue.severity === "error").length;
    if (errors) invalid(`${plural(errors, "validation error")} to fix before a dry run.`);
    const definition = parseWorkflow(record.text, `${params.workflowId} (draft revision ${record.revision})`);
    if (definition.id !== params.workflowId) invalid("The draft's id is not the workflow's.");
    return { definition, revision: record.revision };
  }

  /** The exact bytes publish would write, and the token that binds a publish to them. */
  async review(
    params: { workflowId: string; expectedRevision: number },
    caller: DraftCaller,
  ): Promise<WorkflowDraftReview> {
    await caller.write();
    const source = await this.editable(params.workflowId);
    const record = await this.ownDraft(source, params, caller);
    const review = this.prepareReview(record, source);
    await caller.write();
    return review;
  }

  async publish(
    params: { workflowId: string; expectedRevision: number; reviewToken: string },
    caller: DraftCaller,
  ): Promise<WorkflowDraftPublishResult> {
    return this.options.exclusive(async () => {
      await caller.write();
      const source = await this.editable(params.workflowId);
      return this.locked(source.path, params.workflowId, async () => {
        const record = await this.ownDraft(source, params, caller);
        const review = this.prepareReview(record, source);
        if (review.reviewToken !== params.reviewToken)
          refuse("The draft or the workflow changed after review. Review the new diff before publishing.");
        const errors = this.issues(review.text, params.workflowId).filter((issue) => issue.severity === "error");
        if (errors.length) invalid(`Fix ${plural(errors.length, "validation error")} before publishing.`);
        const config = await this.options.readConfig();
        if (!config.generation) throw new OrcaError("NOT_SUPPORTED", "Publishing needs configuration generations.");
        await this.writable(source.path);
        await caller.write();

        const layoutPath = this.layoutPath(source.path, params.workflowId);
        const previousLayout = await readBounded(layoutPath).catch(missingAsUndefined);
        await atomicSource(source.path, review.text, false);
        await this.writeLayout(layoutPath, params.workflowId, record.layout, previousLayout === undefined);
        const restore = async () => {
          await atomicSource(source.path, source.text, false);
          if (previousLayout === undefined) await unlink(layoutPath).catch(() => {});
          else await atomicSource(layoutPath, previousLayout, false);
        };
        let apply: ConfigApplyResult;
        try {
          apply = await this.options.applyLocked(
            {
              expectedRevision: config.config.revision,
              expectedGeneration: config.generation.activeGeneration,
              validateOnly: false,
            },
            async () => {
              await caller.write();
              const now = await readBounded(source.path);
              if (sha256(now) !== sha256(review.text)) refuse("The workflow file changed during publication.");
            },
          );
        } catch (error) {
          await restore();
          throw error;
        }
        if (apply.outcome === "invalid") {
          await restore();
          const first = apply.validation.errors[0];
          invalid(
            first
              ? `Activation refused the published workflow: ${first.path}: ${first.message}`
              : "Activation refused the published workflow.",
          );
        }
        await unlink(this.draftPath(source.path, params.workflowId, record.owner)).catch(() => {});
        return { workflowId: params.workflowId, version: review.nextVersion, apply };
      });
    });
  }

  async discard(params: { workflowId: string; expectedRevision: number }, caller: DraftCaller) {
    await caller.write();
    const source = await this.editable(params.workflowId);
    return this.locked(source.path, params.workflowId, async () => {
      const record = await this.ownDraft(source, params, caller);
      await caller.write();
      await unlink(this.draftPath(source.path, params.workflowId, record.owner));
      return { discarded: true as const };
    });
  }

  /* ---------- the draft record ---------- */

  private async mutate(
    params: { workflowId: string; expectedRevision: number },
    caller: DraftCaller,
    change: (record: DraftRecord) => { current: Snapshot; past: Snapshot[]; future: Snapshot[] } | undefined,
  ): Promise<WorkflowDraftView> {
    await caller.write();
    const source = await this.editable(params.workflowId);
    return this.locked(source.path, params.workflowId, async () => {
      const record = await this.ownDraft(source, params, caller);
      const next = change(record);
      if (!next) return this.view(record, source, caller.principalId);
      const updated: DraftRecord = {
        ...record,
        text: next.current.text,
        layout: next.current.layout,
        past: next.past,
        future: next.future,
        revision: record.revision + 1,
        updatedAt: this.clock.isoNow(),
      };
      await caller.write();
      await this.writeDraft(source.path, updated, false);
      return this.view(updated, source, caller.principalId);
    });
  }

  /** The caller's own draft at the revision they named, or a refusal that says which it is not. */
  private async ownDraft(
    source: WorkflowSource,
    params: { workflowId: string; expectedRevision: number },
    caller: DraftCaller,
  ): Promise<DraftRecord> {
    const record = await this.findDraft(source.path, params.workflowId);
    if (!record) refuse("This draft no longer exists. Open the workflow again.");
    if (record.owner !== caller.principalId)
      invalid("This draft belongs to someone else. It can be read here, not changed.");
    if (record.revision !== params.expectedRevision)
      refuse("The draft changed in another window. Reload it before editing again.");
    return record;
  }

  private prepareReview(record: DraftRecord, source: WorkflowSource): WorkflowDraftReview {
    if (sha256(source.text) !== record.base.revision)
      refuse("The workflow file changed since this draft was taken. Discard the draft and start again.");
    const nextVersion = nextWorkflowVersion(record.base.version);
    const document = parseDocument(record.text);
    if (document.errors.length) invalid("The draft's YAML does not parse.");
    document.set("version", nextVersion);
    const text = document.toString();
    return {
      revision: record.revision,
      baseVersion: record.base.version,
      nextVersion,
      baseText: source.text,
      text,
      reviewToken: sha256(JSON.stringify([record.workflowId, record.revision, record.base.revision, sha256(text)])),
    };
  }

  private view(record: DraftRecord, source: WorkflowSource, principalId: string): WorkflowDraftView {
    const issues = this.issues(record.text, record.workflowId);
    const current = sha256(source.text) === record.base.revision;
    const dirty = record.text !== record.base.text || !isDeepStrictEqual(record.layout, record.base.layout);
    const errors = issues.filter((issue) => issue.severity === "error").length;
    const you = record.owner === principalId;
    const publishBlocked = !you
      ? "Only the person who opened this draft can publish it."
      : !current
        ? "The workflow file changed since this draft was taken. Discard the draft and start again."
        : !dirty
          ? "Nothing has changed yet."
          : errors
            ? `${plural(errors, "validation error")} to fix before publishing.`
            : undefined;
    const document = toDocument(record.text);
    return {
      workflowId: record.workflowId,
      owner: { principalId: record.owner, you },
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      base: {
        version: record.base.version,
        revision: record.base.revision,
        current,
        text: record.base.text,
        document: toDocument(record.base.text) ?? null,
      },
      text: record.text,
      ...(document !== undefined ? { document } : {}),
      layout: record.layout,
      issues,
      dirty,
      canUndo: you && record.past.length > 0,
      canRedo: you && record.future.length > 0,
      ...(publishBlocked !== undefined ? { publishBlocked } : {}),
    };
  }

  /**
   * Without an active generation there is nothing to check templates, agents and workflows
   * against, and a draft that looks clean here might not be (#182): the schema and graph
   * findings still show, and one whole-workflow error says why the draft is not validated,
   * which keeps it from publishing.
   */
  private issues(text: string, workflowId: string): DraftIssue[] {
    const context = this.options.validationContext();
    const issues = validateDraft(text, workflowId, context ?? {});
    if (context) return issues;
    return [{ severity: "error", message: UNVALIDATED, path: "", graph: [] }, ...issues];
  }

  /* ---------- files ---------- */

  /** The workflow's source file, or why it cannot be edited here. */
  private async locate(workflowId: string): Promise<{ source?: WorkflowSource; reason?: string }> {
    const view = await this.options.readConfig();
    const config = parseOrcaConfig(view.config.parsed);
    if (config.workflows.some((pattern) => pattern.includes("${")))
      return { reason: "Workflows from a managed release are read-only here." };
    const paths = await expandPatterns(config.workflows, this.options.baseDir);
    if (paths.length > 500) invalid("Too many workflow files to search.");
    let found: WorkflowSource | undefined;
    for (const path of paths) {
      let text: string;
      try {
        text = await readBounded(path);
      } catch {
        continue;
      }
      let id: string, version: string;
      try {
        ({ id, version } = parseWorkflow(text, path));
      } catch {
        continue;
      }
      // The last file wins on a duplicate id, as the registry does when it loads them.
      if (id === workflowId) found = { path, text, revision: sha256(text), version };
    }
    if (!found) throw new OrcaError("WORKFLOW_NOT_FOUND", `workflow '${workflowId}' is not configured`);
    if (found.path.endsWith(".json")) return { source: found, reason: "JSON workflows are read-only here." };
    try {
      await this.writable(found.path);
    } catch {
      return { source: found, reason: "This workflow lives outside the configuration directory." };
    }
    return { source: found };
  }

  private async editable(workflowId: string): Promise<WorkflowSource> {
    const located = await this.locate(workflowId);
    if (!located.source || located.reason !== undefined) invalid(located.reason ?? "This workflow cannot be edited.");
    return located.source;
  }

  private async writable(path: string): Promise<void> {
    const base = await realpath(this.options.baseDir),
      parent = await realpath(dirname(path));
    const rel = relative(base, parent);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      invalid("The workflow must live inside the configuration directory.");
    if (parent !== resolve(dirname(path))) invalid("The workflow directory traverses a symlink.");
  }

  private draftsDir(sourcePath: string): string {
    return join(dirname(sourcePath), DRAFTS_DIR);
  }
  private draftPath(sourcePath: string, workflowId: string, owner: string): string {
    // A principal id is the daemon's, but it is not a filename: hash it.
    return join(this.draftsDir(sourcePath), `${workflowId}@${sha256(owner).slice(0, 16)}.json`);
  }
  private layoutPath(sourcePath: string, workflowId: string): string {
    return join(dirname(sourcePath), LAYOUT_DIR, `${workflowId}.json`);
  }

  /** One lock per workflow: the draft's revision check and its write happen inside it. */
  private async locked<T>(sourcePath: string, workflowId: string, command: () => Promise<T>): Promise<T> {
    const dir = this.draftsDir(sourcePath);
    await mkdir(dir, { recursive: true });
    return withFileLock(join(dir, `${workflowId}.lock`), command);
  }

  private async findDraft(sourcePath: string, workflowId: string): Promise<DraftRecord | undefined> {
    const dir = this.draftsDir(sourcePath);
    const names = await readdir(dir).catch((error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return [] as string[];
      throw error;
    });
    const mine = names.filter((name) => name.startsWith(`${workflowId}@`) && name.endsWith(".json")).sort();
    for (const name of mine) {
      const parsed = DraftRecordSchema.safeParse(JSON.parse(await readBounded(join(dir, name), MAX_HISTORY_BYTES * 2)));
      if (parsed.success && parsed.data.workflowId === workflowId) return parsed.data;
    }
    return undefined;
  }

  private async writeDraft(sourcePath: string, record: DraftRecord, create: boolean): Promise<void> {
    const path = this.draftPath(sourcePath, record.workflowId, record.owner);
    if (basename(path) !== basename(path).replace(/[\\/]/g, "")) invalid("Draft name is invalid.");
    await atomicSource(path, JSON.stringify(record) + "\n", create);
  }

  private async publishedLayout(sourcePath: string, workflowId: string): Promise<DraftLayout> {
    const text = await readBounded(this.layoutPath(sourcePath, workflowId)).catch(missingAsUndefined);
    if (text === undefined) return emptyLayout();
    const parsed = LayoutFileSchema.safeParse(safeJson(text));
    return parsed.success && parsed.data.workflowId === workflowId ? { graphs: parsed.data.graphs } : emptyLayout();
  }

  private async writeLayout(path: string, workflowId: string, layout: DraftLayout, create: boolean): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await atomicSource(path, JSON.stringify({ v: 1, workflowId, graphs: layout.graphs }, null, 2) + "\n", create);
  }
}

/* ---------- operations ---------- */

type Path = (string | number)[];

/** Apply a batch to the draft's text and layout; all of it, or a refusal naming the step. */
export function applyOperations(
  text: string,
  layout: DraftLayout,
  ops: DraftOperation[],
  workflowId: string,
): Snapshot {
  const document = parseDocument(text);
  if (document.errors.length) invalid("The draft's YAML does not parse.");
  const graphs = structuredClone(layout.graphs);
  ops.forEach((op, index) => {
    try {
      applyOne(document, graphs, op);
    } catch (error) {
      if (error instanceof OrcaError || error instanceof ProtocolFault) {
        throw new OrcaError("CONFIG_INVALID", ops.length > 1 ? `Step ${index + 1}: ${error.message}` : error.message);
      }
      throw error;
    }
  });
  const next = document.toString();
  if (next.length > MAX_TEXT) invalid("The workflow would exceed the editing bound.");
  const reparsed = parseDocument(next);
  if (reparsed.errors.length) invalid("That change would leave the YAML unreadable.");
  if (reparsed.get("id") !== workflowId) invalid("A draft cannot change the workflow's id.");
  return { text: next, layout: { graphs: pruneLayout(graphs) } };
}

function applyOne(document: Document, graphs: DraftLayout["graphs"], op: DraftOperation): void {
  if (op.op === "setWorkflow") {
    if (op.name !== undefined) document.set("name", op.name);
    if (op.description === null) document.delete("description");
    else if (op.description !== undefined) document.set("description", op.description);
    return;
  }
  const prefix = graphPrefix(document, op.graph);
  const nodes = mapAt(document, [...prefix, "nodes"]);
  const key = draftGraphKey(op.graph);
  const requireNode = (id: string) => {
    if (!nodes.has(id)) invalid(`There is no node named '${id}'.`);
  };
  switch (op.op) {
    case "addNode":
    case "insertNode": {
      if (nodes.has(op.id)) invalid(`A node named '${op.id}' already exists.`);
      if (
        op.node.type === "start" &&
        Object.values(nodes.toJSON() as Record<string, { type?: unknown }>).some((n) => n?.type === "start")
      )
        invalid("A graph has exactly one start node.");
      appendPair(document, nodes, op.id, op.node);
      if (op.op === "insertNode") {
        const edges = edgesAt(document, prefix);
        const edge = edgeAt(edges, op.edge);
        const to = edge.get("to");
        edge.set("to", op.id);
        const next = createLike(document, edges, { from: op.id, to });
        edges.items.splice(op.edge + 1, 0, next);
      }
      return;
    }
    case "updateNode": {
      requireNode(op.id);
      const node = mapAt(document, [...prefix, "nodes", op.id]);
      for (const [field, value] of Object.entries(op.set ?? {})) {
        if (field === "type") invalid("Change a node's type with changeType.");
        if (value === undefined) continue;
        node.set(field, document.createNode(value));
      }
      for (const field of op.unset ?? []) {
        if (field === "type") invalid("A node keeps its type.");
        node.delete(field);
      }
      return;
    }
    case "changeType": {
      requireNode(op.id);
      if (op.type === "start") invalid("Add a start node rather than converting one.");
      mapAt(document, [...prefix, "nodes", op.id]).set("type", op.type);
      return;
    }
    case "renameNode": {
      requireNode(op.id);
      if (op.id === op.to) return;
      if (nodes.has(op.to)) invalid(`A node named '${op.to}' already exists.`);
      const pair = nodes.items.find((item) => keyOf(item) === op.id)!;
      if (isScalar(pair.key)) pair.key.value = op.to;
      else pair.key = document.createNode(op.to);
      const edges = optionalEdges(document, prefix);
      for (const edge of edges?.items ?? []) {
        if (!isMap(edge)) continue;
        if (edge.get("from") === op.id) edge.set("from", op.to);
        if (edge.get("to") === op.id) edge.set("to", op.to);
      }
      if (document.getIn([...prefix, "start"]) === op.id) document.setIn([...prefix, "start"], op.to);
      // Artifact inputs name the node that produced them; the graph is their namespace.
      for (const item of nodes.items) renameFromNode(item.value, op.id, op.to);
      const pins = graphs[key];
      if (pins?.[op.id]) {
        pins[op.to] = pins[op.id]!;
        delete pins[op.id];
      }
      return;
    }
    case "removeNode": {
      requireNode(op.id);
      nodes.delete(op.id);
      if (op.detach) {
        const edges = optionalEdges(document, prefix);
        if (edges)
          for (let i = edges.items.length - 1; i >= 0; i--) {
            const edge = edges.items[i];
            if (isMap(edge) && (edge.get("from") === op.id || edge.get("to") === op.id)) edges.items.splice(i, 1);
          }
      }
      delete graphs[key]?.[op.id];
      return;
    }
    case "moveNode": {
      requireNode(op.id);
      if (op.before !== undefined) requireNode(op.before);
      if (op.before === op.id) return;
      const at = nodes.items.findIndex((item) => keyOf(item) === op.id);
      const [pair] = nodes.items.splice(at, 1);
      const before = op.before === undefined ? -1 : nodes.items.findIndex((item) => keyOf(item) === op.before);
      if (before === -1) nodes.items.push(pair!);
      else nodes.items.splice(before, 0, pair!);
      return;
    }
    case "addEdge": {
      requireNode(op.from);
      requireNode(op.to);
      const edges = edgesAt(document, prefix);
      edges.items.push(
        createLike(document, edges, {
          from: op.from,
          to: op.to,
          ...(op.when !== undefined ? { when: op.when } : {}),
          ...(op.label !== undefined ? { label: op.label } : {}),
        }),
      );
      return;
    }
    case "updateEdge": {
      const edge = edgeAt(edgesAt(document, prefix), op.index);
      if (op.from !== undefined) {
        requireNode(op.from);
        edge.set("from", op.from);
      }
      if (op.to !== undefined) {
        requireNode(op.to);
        edge.set("to", op.to);
      }
      if (op.when === null) edge.delete("when");
      else if (op.when !== undefined) edge.set("when", op.when);
      if (op.label === null) edge.delete("label");
      else if (op.label !== undefined) edge.set("label", op.label);
      return;
    }
    case "removeEdge": {
      const edges = edgesAt(document, prefix);
      edgeAt(edges, op.index);
      edges.items.splice(op.index, 1);
      return;
    }
    case "setStart": {
      requireNode(op.id);
      document.setIn([...prefix, "start"], op.id);
      return;
    }
    case "place": {
      requireNode(op.id);
      (graphs[key] ??= {})[op.id] = { x: Math.round(op.x), y: Math.round(op.y) };
      return;
    }
    case "unpin": {
      delete graphs[key]?.[op.id];
      return;
    }
    case "tidy": {
      delete graphs[key];
      return;
    }
  }
}

/** The YAML path of a graph: `[]` for the root, `nodes.<id>.body.graph` and the like below it. */
function graphPrefix(document: Document, path: DraftGraphPath | undefined): Path {
  let prefix: Path = [];
  for (const step of path ?? []) {
    const type = document.getIn([...prefix, "nodes", step.node, "type"]);
    const slot =
      type === "loop" && step.branch === undefined && !step.forEach
        ? ["body", "graph"]
        : type === "parallel" && step.branch !== undefined
          ? ["branches", step.branch, "graph"]
          : type === "parallel" && step.forEach
            ? ["forEach", "body", "graph"]
            : undefined;
    if (!slot) invalid(`'${step.node}' has no inline graph there.`);
    prefix = [...prefix, "nodes", step.node, ...slot];
    if (!isMap(document.getIn([...prefix, "nodes"])))
      invalid(`'${step.node}' runs another workflow, not an inline graph.`);
  }
  return prefix;
}

function mapAt(document: Document, path: Path): YAMLMap {
  const node = document.getIn(path, true);
  if (!isMap(node)) invalid(`Expected a mapping at ${path.join(".")}.`);
  return node;
}

function optionalEdges(document: Document, prefix: Path): YAMLSeq | undefined {
  const node = document.getIn([...prefix, "edges"], true);
  return isSeq(node) ? node : undefined;
}

function edgesAt(document: Document, prefix: Path): YAMLSeq {
  const existing = optionalEdges(document, prefix);
  if (existing) return existing;
  document.setIn([...prefix, "edges"], document.createNode([]));
  return optionalEdges(document, prefix)!;
}

function edgeAt(edges: YAMLSeq, index: number): YAMLMap {
  const edge = edges.items[index];
  if (!isMap(edge)) invalid(`There is no edge ${index}.`);
  return edge;
}

const keyOf = (item: Pair): unknown => (isScalar(item.key) ? item.key.value : item.key);

/** A new collection styled like its siblings: an edge list written in flow maps gets a flow map. */
function createLike(document: Document, siblings: YAMLSeq, value: Record<string, unknown>) {
  const node = document.createNode(value) as YAMLMap;
  const last = siblings.items.at(-1);
  if (isMap(last)) node.flow = Boolean(last.flow);
  else node.flow = true;
  return node;
}

/** Append a node keeping the file's rhythm: a blank line before it when the others have one. */
function appendPair(document: Document, nodes: YAMLMap, id: string, value: Record<string, unknown>): void {
  const pair = document.createPair(id, value);
  const previous = nodes.items.at(-1);
  if (previous && isScalar(previous.key) && previous.key.spaceBefore && isScalar(pair.key)) pair.key.spaceBefore = true;
  nodes.items.push(pair);
}

function renameFromNode(value: unknown, from: string, to: string): void {
  if (isMap(value)) {
    for (const item of value.items) {
      if (keyOf(item) === "graph") continue;
      if (keyOf(item) === "fromNode" && isScalar(item.value) && item.value.value === from) item.value.value = to;
      else renameFromNode(item.value, from, to);
    }
  } else if (isSeq(value)) for (const item of value.items) renameFromNode(item, from, to);
}

function pruneLayout(graphs: DraftLayout["graphs"]): DraftLayout["graphs"] {
  return Object.fromEntries(Object.entries(graphs).filter(([, pins]) => Object.keys(pins).length > 0));
}

function trimHistory(entries: Snapshot[]): Snapshot[] {
  let kept = entries.slice(-MAX_HISTORY);
  let bytes = kept.reduce((sum, entry) => sum + entry.text.length, 0);
  while (kept.length > 1 && bytes > MAX_HISTORY_BYTES) {
    bytes -= kept[0]!.text.length;
    kept = kept.slice(1);
  }
  return kept;
}

/* ---------- validation ---------- */

const UNVALIDATED =
  "ORCA has no active configuration to check this draft against. It can be published once one is active.";

/**
 * The draft's findings, each placed on a graph and a node or edge. The runtime's own schema
 * and graph validator decide errors and warnings, against the active generation, so a clean
 * draft is one activation accepts; three rules are the editor's (docs/design/70):
 *
 * - an unreachable node is an **error** here, not the runtime's warning (#180) - in an editor,
 *   a node nothing reaches is a node somebody forgot to connect;
 * - a field the node's type does not use is a **warning** - a changed type keeps its old fields
 *   in the draft rather than dropping them, and says so;
 * - an auto-approving gate is a **note**, as is a parallel node with one branch a warning.
 */
export function validateDraft(text: string, workflowId: string, context: ValidationContext): DraftIssue[] {
  const document = parseDocument(text);
  if (document.errors.length)
    return [
      { severity: "error", message: `The YAML does not parse: ${document.errors[0]!.message}`, path: "", graph: [] },
    ];
  const raw: unknown = document.toJS();
  if (!raw || typeof raw !== "object")
    return [{ severity: "error", message: "The workflow is empty.", path: "", graph: [] }];
  const issues: DraftIssue[] = [];
  if ((raw as { id?: unknown }).id !== workflowId)
    issues.push({ severity: "error", message: "A draft cannot change the workflow's id.", path: "id", graph: [] });
  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 200))
      issues.push({
        severity: "error",
        message: schemaMessage(issue.path, issue.message),
        path: issue.path.join("."),
        ...locate(issue.path),
      });
    return issues;
  }
  let result;
  try {
    result = validateWorkflow(parsed.data, context);
  } catch {
    issues.push({ severity: "error", message: "The workflow could not be validated.", path: "", graph: [] });
    return issues;
  }
  for (const issue of result.errors)
    issues.push({ severity: "error", ...fromValidatorPath(issue.path), message: issue.message });
  // A graph whose start names no node reaches nothing, so every node in it would also be
  // "unreachable": one row for the cause, not one per node for its echo.
  const startless = new Set(
    issues
      .filter((issue) => issue.path.endsWith("start") && /^start node '.*' does not exist$/.test(issue.message))
      .map((issue) => draftGraphKey(issue.graph)),
  );
  for (const issue of result.warnings) {
    const unreachable = /is unreachable from start$/.test(issue.message);
    const placed = fromValidatorPath(issue.path);
    if (unreachable && startless.has(draftGraphKey(placed.graph))) continue;
    issues.push({ severity: unreachable ? "error" : "warning", ...placed, message: issue.message });
  }
  editorFindings(raw, parsed.data, [], [], issues);
  const order = { error: 0, warning: 1, note: 2 } as const;
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

type RawGraph = { nodes?: Record<string, Record<string, unknown> | null>; edges?: unknown };

function editorFindings(
  raw: RawGraph,
  graph: WorkflowGraph,
  path: DraftGraphStep[],
  prefix: string[],
  issues: DraftIssue[],
): void {
  for (const [id, node] of Object.entries(graph.nodes)) {
    const rawNode = raw.nodes?.[id] ?? {};
    const at = [...prefix, "nodes", id].join(".");
    if (!node.type.startsWith("custom:")) {
      const known = new Set(Object.keys(node));
      for (const field of Object.keys(rawNode))
        if (!known.has(field))
          issues.push({
            severity: "warning",
            message: `'${field}' is not used by a ${node.type} node. It is kept in the draft and ignored when the workflow runs.`,
            path: `${at}.${field}`,
            graph: path,
            node: id,
          });
    }
    if (node.type === "gate" && node.autoApproveWhen)
      issues.push({
        severity: "note",
        message: `This gate approves itself when ${node.autoApproveWhen}.`,
        path: `${at}.autoApproveWhen`,
        graph: path,
        node: id,
      });
    nested(id, node, rawNode).forEach(({ step, graph: inner, raw: innerRaw, slot }) =>
      editorFindings(innerRaw, inner, [...path, step], [...prefix, "nodes", id, ...slot], issues),
    );
    if (node.type === "parallel" && node.branches && Object.keys(node.branches).length === 1)
      issues.push({
        severity: "warning",
        message: "This parallel node has one branch; it runs nothing in parallel.",
        path: `${at}.branches`,
        graph: path,
        node: id,
      });
  }
}

function nested(
  id: string,
  node: NodeDef,
  raw: Record<string, unknown>,
): { step: DraftGraphStep; graph: WorkflowGraph; raw: RawGraph; slot: string[] }[] {
  const pick = (value: unknown, ...keys: string[]): RawGraph => {
    let at: unknown = value;
    for (const key of keys) at = at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
    return at && typeof at === "object" ? at : {};
  };
  const out: { step: DraftGraphStep; graph: WorkflowGraph; raw: RawGraph; slot: string[] }[] = [];
  if (node.type === "loop" && "graph" in node.body)
    out.push({ step: { node: id }, graph: node.body.graph, raw: pick(raw, "body", "graph"), slot: ["body", "graph"] });
  if (node.type === "parallel") {
    for (const [branch, ref] of Object.entries(node.branches ?? {}))
      if ("graph" in ref)
        out.push({
          step: { node: id, branch },
          graph: ref.graph,
          raw: pick(raw, "branches", branch, "graph"),
          slot: ["branches", branch, "graph"],
        });
    const body = node.forEach?.body;
    if (body && "graph" in body)
      out.push({
        step: { node: id, forEach: true },
        graph: body.graph,
        raw: pick(raw, "forEach", "body", "graph"),
        slot: ["forEach", "body", "graph"],
      });
  }
  return out;
}

/** Place a schema or validator path on a graph, a node and an edge. Tolerates the `graph` hop either way. */
export function locate(tokens: readonly PropertyKey[]): { graph: DraftGraphPath; node?: string; edge?: number } {
  const graph: DraftGraphStep[] = [];
  let node: string | undefined;
  let edge: number | undefined;
  const opens = (token: unknown) => token === "nodes" || token === "edges" || token === "start";
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "nodes" && typeof tokens[i + 1] === "string") {
      node = tokens[i + 1] as string;
      edge = undefined;
      i += 2;
      const rest = tokens.slice(i);
      const hop = (offset: number) => (rest[offset] === "graph" ? offset + 1 : offset);
      if (rest[0] === "body" && opens(rest[hop(1)])) {
        graph.push({ node });
        i += hop(1);
        node = undefined;
        continue;
      }
      if (rest[0] === "branches" && typeof rest[1] === "string" && opens(rest[hop(2)])) {
        graph.push({ node, branch: rest[1] });
        i += hop(2);
        node = undefined;
        continue;
      }
      if (rest[0] === "forEach" && rest[1] === "body" && opens(rest[hop(2)])) {
        graph.push({ node, forEach: true });
        i += hop(2);
        node = undefined;
        continue;
      }
      break;
    }
    if (token === "edges" && typeof tokens[i + 1] === "number") {
      edge = tokens[i + 1] as number;
      node = undefined;
      break;
    }
    i++;
  }
  return { graph, ...(node !== undefined ? { node } : {}), ...(edge !== undefined ? { edge } : {}) };
}

/** `workflow(id).nodes.loop.body.edges[2].when` → its tokens, located, with the path kept for the YAML reader. */
function fromValidatorPath(path: string): { path: string; graph: DraftGraphPath; node?: string; edge?: number } {
  const body = path.replace(/^workflow\([^)]*\)\.?/, "");
  const tokens: PropertyKey[] = [];
  for (const part of body.split(".").filter(Boolean)) {
    const match = /^(.*)\[(\d+)\]$/.exec(part);
    if (match) tokens.push(match[1]!, Number(match[2]));
    else tokens.push(part);
  }
  return { path: body, ...locate(tokens) };
}

function schemaMessage(path: readonly PropertyKey[], message: string): string {
  const where = path.length ? path.map(String).join(".") : "workflow";
  return `${where}: ${message}`;
}

/* ---------- small helpers ---------- */

function toDocument(text: string): unknown {
  const document = parseDocument(text);
  return document.errors.length ? undefined : (document.toJS() as unknown);
}

async function readBounded(path: string, max = MAX_TEXT): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) invalid("Expected a bounded regular file.");
  return readFile(path, "utf8");
}

function missingAsUndefined(error: unknown): undefined {
  if ((error as { code?: string }).code === "ENOENT") return undefined;
  throw error;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
