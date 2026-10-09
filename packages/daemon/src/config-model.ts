/**
 * The configuration model: `config.get`, `config.set` and the `config.changed` push, over
 * the workspace's two configuration documents (#174, #266).
 *
 * **Two documents, one method.** `orca.config.yaml` is hand-written and full of comments;
 * `orca.permissions.json` is the ADR 0009 sidecar, machine-written, and the only place a
 * standing grant lives. A screen that showed one without the other could not show the
 * effective permission policy at all, so `config.get` returns both and `config.set` names
 * which one it writes.
 *
 * **A YAML write never re-serialises the parsed config.** `stringify(OrcaConfigSchema.parse(x))`
 * would be one line of code and would destroy the file: every default in the schema would
 * materialise into the text, and every comment in it would vanish. So a `patch` edits the
 * `yaml` package's `Document` - the comment-preserving representation - with `setIn` and
 * `deleteIn`, and a `text` write stores the bytes the client sent, verbatim. Either way the
 * resulting text is parsed and schema-checked *before* it replaces the file, so a refusal
 * leaves the old file exactly as it was.
 *
 * **The sidecar is the exception, deliberately.** Both of its modes go through
 * `replacePermissionPolicyFile` in `@orca/agents`, which takes the `link()` lock and writes
 * the fixed key order a machine write uses. That means a `text` write of the sidecar is
 * *canonicalised* rather than stored verbatim - reformatting is lost, though nothing else
 * is. It is the right trade for that file: it is generated, its whole reason for being JSON
 * with a fixed key order is that a rewrite should be a minimal diff (ADR 0009), and a second
 * writer that did not take the lock would lose exactly the race #266 asks to be tested - a
 * run answering "always" at the moment an operator saves an edit.
 *
 * **`revision` is a content hash, and it is compared under the write lock.** A client sends
 * back the revision it read; anything else is `CONFIG_STALE`, with both revisions, rather
 * than a write that wins by arriving second. There is no lease here: a configuration file is
 * not a run, and #160's lease story is about who may interpret a run, not who may edit a
 * file. What there is, is a lock per document, and the compare lives *inside* it - the YAML
 * under `<configFile>.lock` (`withFileLock`, the store's), the sidecar inside
 * `replacePermissionPolicyFile`'s `link()` lock, which is where `expectedRevision` is now
 * re-hashed. Compare-then-write as two steps had a window in it, and the thing that fitted
 * through the window was the sidecar case this file is about: a run answering "always"
 * between an operator's `config.get` and their `config.set`, whose grant the replace then
 * dropped without anybody being told.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { permissionOverlayFor, replacePermissionPolicyFile } from "@orca/agents";
import {
  effectivePermissionPolicy,
  isOrcaError,
  OrcaError,
  OrcaConfigSchema,
  PERMISSION_POLICY_FILENAME,
  systemClock,
  WritablePermissionPolicyFileSchema,
  type Clock,
  type PermissionPolicyFile,
} from "@orca/core";
import {
  ProtocolFault,
  type ConfigApplyParams,
  type ConfigApplyResult,
  type ConfigGenerationStatus,
  type ConfigDocument,
  type ConfigDocumentView,
  type ConfigEffectivePolicy,
  type ConfigGetResult,
  type ConfigSetParams,
  type ConfigSetResult,
  type ConfigValidationError,
  type EffectivePermissionRule,
} from "@orca/protocol";
import { withFileLock } from "@orca/store";
import { describeConfigSchema, validationErrors } from "./config-schema.js";
import { describeConfigFormSchema } from "./config-form-schema.js";
import { lowerConfigEdits } from "./config-collection-edits.js";
import { configReferenceErrors } from "./config-references.js";
import { TemplateAuthoringService } from "./template-authoring.js";

/** The default name a `config.set` creates when the workspace has no config file yet. */
export const DEFAULT_CONFIG_FILENAME = "orca.config.yaml";

/** Structural seam: the engine provider is injected at bootstrap, never fabricated here. */
export interface ConfigGenerationProvider {
  effectiveConfig(): unknown;
  status(raw: unknown, revision: string): ConfigGenerationStatus;
  apply(
    raw: unknown,
    revision: string,
    expectedGeneration: string,
    validateOnly: boolean,
    recheck: () => Promise<void>,
  ): Promise<ConfigApplyResult>;
  onChange(
    listener: (status: ConfigGenerationStatus, workflows: { id: string; version: string; removed?: boolean }[]) => void,
  ): () => void;
}

export interface ConfigModelOptions {
  /** The directory the two documents live in - `OrcaApp.configDir`. */
  configDir: string;
  generations?: ConfigGenerationProvider;
  /**
   * The config file discovery actually found, when it found one. Absent means the workspace
   * is running on schema defaults; `config.get` reports `exists: false` at the path a
   * `config.set` would create, which is `<configDir>/orca.config.yaml`.
   */
  configFile?: string | undefined;
  /** The sidecar. Defaults to `orca.permissions.json` in `configDir`, which is where it is. */
  permissionsFile?: string | undefined;
  /** Injectable so a test can pin `asOf` and the notification's `at`. */
  clock?: Clock | undefined;
}

/** What a `config.changed` frame carries, before a subscription stamps its own id on it. */
export interface ConfigChange {
  document: ConfigDocument;
  revision: string;
  path: string;
  at: string;
  kind?: "saved" | "activated";
  generation?: ConfigGenerationStatus;
  workflows?: { id: string; version: string; removed?: boolean }[];
}

/**
 * The two configuration documents, read and written.
 *
 * It is a `config.changed` source as well as a method implementation: `subscriptions.ts`
 * attaches to `onChange` exactly as it attaches to the agent health tracker, because the
 * frame has the same shape of life - no run, no cursor, nothing to replay.
 */
export class ConfigModel {
  readonly templates: TemplateAuthoringService;
  private readonly generations: ConfigGenerationProvider | undefined;
  private readonly configFile: string;
  private readonly permissionsFile: string;
  private readonly clock: Clock;
  private readonly listeners = new Set<(change: ConfigChange) => void>();

  constructor(opts: ConfigModelOptions) {
    this.configFile = opts.configFile ?? join(opts.configDir, DEFAULT_CONFIG_FILENAME);
    this.permissionsFile = opts.permissionsFile ?? join(opts.configDir, PERMISSION_POLICY_FILENAME);
    this.clock = opts.clock ?? systemClock;
    this.generations = opts.generations;
    this.templates = new TemplateAuthoringService({
      baseDir: opts.configDir,
      readConfig: () => this.get(),
      exclusive: async (command) => {
        await mkdir(dirname(this.configFile), { recursive: true });
        return withFileLock(`${this.configFile}.lock`, command);
      },
      applyLocked: (params, recheck) => this.applyLocked(params, recheck),
      changed: () => this.announce("config"),
    });
    this.generations?.onChange((generation, workflows) => {
      const change: ConfigChange = {
        document: "config",
        path: this.configFile,
        revision: generation.activeRevision,
        at: this.clock.isoNow(),
        kind: "activated",
        generation,
        workflows,
      };
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch {
          /* notification isolation */
        }
      }
    });
  }

  /** Where each document is. Public so `orca serve` can say what it is serving. */
  pathOf(document: ConfigDocument): string {
    return document === "config" ? this.configFile : this.permissionsFile;
  }

  /**
   * Subscribe to writes of either document. Returns the detach, like every other listener
   * seam in this package.
   */
  onChange(listener: (change: ConfigChange) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Announce a document somebody else wrote. `inputs.answer` with `always` appends to the
   * sidecar through `recordAlwaysDecision`, which knows nothing about subscriptions, so the
   * control model calls this afterwards - a config screen has to see ORCA's own writes, not
   * only the operator's (ADR 0009: the sidecar is meant to be read).
   */
  async announce(document: ConfigDocument): Promise<void> {
    const view = await this.read(document);
    this.publish(view);
  }

  /**
   * `config.get`: both documents, the schema a form renders, and the effective permission
   * policy the two of them add up to.
   *
   * Editor bytes are unredacted and require config.read authority. The generation provider
   * reports saved versus active state; the effective policy uses active config plus the
   * current sidecar. A saved draft must never masquerade as the running permission policy.
   */
  /** Allowlisted operator projection: never constructs the raw config editor response. */
  async operatorStatus(): Promise<ConfigGenerationStatus> {
    if (!this.generations) throw new OrcaError("NOT_SUPPORTED", "configuration generations are unavailable");
    const config = await this.read("config");
    return this.generations.status(configurationValue(config), config.revision);
  }

  async get(): Promise<ConfigGetResult> {
    const config = await this.read("config");
    const permissions = await this.read("permissions");
    return {
      config,
      permissions,
      schema: describeConfigSchema(),
      formSchema: describeConfigFormSchema(),
      effective: this.effective(
        this.generations ? { ...config, parsed: this.generations.effectiveConfig() } : config,
        permissions,
      ),
      ...(this.generations ? { generation: this.generations.status(configurationValue(config), config.revision) } : {}),
      asOf: this.clock.isoNow(),
    };
  }

  /**
   * `config.set`: write one document, or say why it cannot be written.
   *
   * Saving changes only the document. Explicit apply validates and activates a generation
   * for future launches; existing runs retain their admitted choices. Sidecar edits remain
   * live at the next permission check. No save takes a run lease or appends a run event.
   *
   * **`CONFIG_STALE` is decided inside the write lock, not before it.** The revision compare
   * and the write used to be two unsynchronised steps, with a window between them wide enough
   * for the case ADR 0009 is about: a run answering "always" appends a grant to the sidecar
   * between an operator's `config.get` and their `config.set`, the compare sees the revision
   * it read, and the replace drops the grant. So each document now re-reads and re-hashes
   * under the lock its writer takes - `<configFile>.lock` via `withFileLock` for the YAML,
   * and the sidecar's own `link()` lock inside `replacePermissionPolicyFile`. The compare
   * before the lock stays, because it refuses the ordinary case sooner; it is no longer the
   * one that decides.
   */
  async set(params: ConfigSetParams): Promise<ConfigSetResult> {
    if (params.validateOnly) {
      // Nothing is written, so there is nothing to serialise against: this reports what the
      // document would be, and a `CONFIG_STALE` here is advice rather than a verdict.
      const current = await this.read(params.document);
      refuseIfStale(params, current);
      const text = this.nextText(current, params);
      const parsed = safeParse(params.document, text);
      return {
        document: { ...current, exists: true, revision: hash(text), text, ...(parsed === undefined ? {} : { parsed }) },
        written: false,
        validation: { errors: this.validate(params.document, text) },
        asOf: this.clock.isoNow(),
      };
    }

    const written =
      params.document === "config" ? await this.writeConfigFile(params) : await this.writeSidecarFile(params);
    this.publish(written);
    const config = params.document === "config" ? written : await this.read("config");
    return {
      document: written,
      written: true,
      asOf: this.clock.isoNow(),
      ...(this.generations ? { generation: this.generations.status(configurationValue(config), config.revision) } : {}),
    };
  }

  get canApply(): boolean {
    return this.generations !== undefined;
  }

  /** Explicit manual refresh: reads current file bytes and all candidate assets under the writer lock. */
  async apply(params: ConfigApplyParams): Promise<ConfigApplyResult> {
    await mkdir(dirname(this.configFile), { recursive: true });
    return withFileLock(`${this.configFile}.lock`, () => this.applyLocked(params));
  }

  /** Template publication holds the same lock across catalog verification and generation activation. */
  private async applyLocked(params: ConfigApplyParams, catalogCheck?: () => Promise<void>): Promise<ConfigApplyResult> {
    const generations = this.generations;
    if (!generations) throw new OrcaError("NOT_SUPPORTED", "configuration activation is not wired");
    const current = await this.read("config");
    if (current.revision !== params.expectedRevision)
      throw new ProtocolFault("CONFIG_STALE", "saved configuration changed; refresh before applying");
    const recheck = async () => {
      await catalogCheck?.();
      const latest = await this.read("config");
      if (latest.revision !== params.expectedRevision)
        throw new ProtocolFault("CONFIG_STALE", "saved configuration changed; refresh before applying");
    };
    await recheck();
    return generations.apply(
      configurationValue(current),
      current.revision,
      params.expectedGeneration,
      params.validateOnly ?? false,
      recheck,
    );
  }

  /**
   * `orca.config.yaml`, under `<configFile>.lock`.
   *
   * `withFileLock` is the store's, and the daemon already depends on `@orca/store` for the
   * stores it serves. The layering rule ADR 0009 states is about `@orca/agents`, which sits
   * to the *right* of `store` and so writes the sidecar with its own `link()` idiom; nothing
   * stops the daemon reusing the fuller version. Everything between the read and the rename
   * happens in here: patching a YAML document is read-modify-write, and a compare made
   * outside the lock is a compare of bytes that may not be the ones being replaced.
   */
  private async writeConfigFile(params: ConfigSetParams): Promise<ConfigDocumentView> {
    const path = this.pathOf("config");
    await mkdir(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, async () => {
      const current = await this.read("config");
      refuseIfStale(params, current);
      const text = this.nextConfigText(current, params);
      const errors = this.validate("config", text);
      if (errors.length)
        throw new OrcaError("CONFIG_INVALID", `${path}: ${errors[0]?.message ?? "invalid"}`, { errors });
      await writeAtomically(path, text);
      return this.read("config");
    });
  }

  /**
   * `orca.permissions.json`, through the sidecar's own writer and under the sidecar's own
   * lock - a `link()` lock is only a lock if every writer takes it, and `recordAlwaysDecision`
   * takes that one. `expectedRevision` travels with the document so that the compare happens
   * in there, beside the write, rather than out here where a grant can land between the two.
   */
  private async writeSidecarFile(params: ConfigSetParams): Promise<ConfigDocumentView> {
    const current = await this.read("permissions");
    refuseIfStale(params, current);
    const text = this.nextSidecarText(current, params);
    const errors = this.validate("permissions", text);
    if (errors.length)
      throw new OrcaError("CONFIG_INVALID", `${current.path}: ${errors[0]?.message ?? "invalid"}`, { errors });
    try {
      await replacePermissionPolicyFile(current.path, JSON.parse(text), {
        expectedRevision: params.expectedRevision,
      });
    } catch (e) {
      // The writer's stable code, in the wire's words. `details` already carries both hashes.
      if (isOrcaError(e, "CONFIG_STALE"))
        throw new ProtocolFault("CONFIG_STALE", e.message, { document: "permissions", ...(e.details ?? {}) });
      throw e;
    }
    return this.read("permissions");
  }

  /** The bytes `params` asks for, whichever document it names. */
  private nextText(current: ConfigDocumentView, params: ConfigSetParams): string {
    return params.document === "config" ? this.nextConfigText(current, params) : this.nextSidecarText(current, params);
  }

  // ------------------------------------------------------------------ pieces

  /** One document as it is on disk. A file that is not there is `exists: false`, not an error. */
  async read(document: ConfigDocument): Promise<ConfigDocumentView> {
    const path = this.pathOf(document);
    let text: string | undefined;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (text === undefined) return { document, path, exists: false, revision: "", text: "" };
    const parsed = safeParse(document, text);
    return { document, path, exists: true, revision: hash(text), text, ...(parsed === undefined ? {} : { parsed }) };
  }

  private publish(view: ConfigDocumentView): void {
    const change: ConfigChange = {
      document: view.document,
      revision: view.revision,
      path: view.path,
      ...(this.generations ? { kind: "saved" as const } : {}),
      at: this.clock.isoNow(),
    };
    for (const listener of this.listeners) listener(change);
  }

  /**
   * The new bytes of `orca.config.yaml`.
   *
   * `text` is stored as sent. `patch` edits the parsed `Document`, which is the whole reason
   * the `yaml` package is used here rather than `parse`/`stringify`: `setIn` rewrites one
   * node and leaves every comment, every blank line and every quoting choice in the file
   * alone. A workspace with no config file yet has no comments to preserve, so a patch there
   * starts from an empty mapping and is stringified normally.
   */
  private nextConfigText(current: ConfigDocumentView, params: ConfigSetParams): string {
    if (params.text !== undefined) return params.text;
    if (params.edits !== undefined) return lowerConfigEdits(current.text, params.edits);
    const patch = params.patch ?? [];
    if (!current.exists || current.text.trim() === "") {
      const out: Record<string, unknown> = {};
      for (const entry of patch) setInPlain(out, splitPath(entry.path), entry.value);
      return stringifyYaml(out);
    }
    const doc = parseDocument(current.text);
    for (const entry of patch) {
      const path = splitPath(entry.path);
      if (entry.value === undefined) doc.deleteIn(path);
      else doc.setIn(path, entry.value);
    }
    return doc.toString();
  }

  /**
   * The new bytes of the sidecar. Both modes end up as a plain object that
   * `replacePermissionPolicyFile` serialises; this produces the JSON that will be validated,
   * and the writer canonicalises it.
   */
  private nextSidecarText(current: ConfigDocumentView, params: ConfigSetParams): string {
    if (params.text !== undefined) return params.text;
    const base: unknown = current.exists && current.text.trim() !== "" ? safeParse("permissions", current.text) : {};
    const out = typeof base === "object" && base !== null ? structuredClone(base as Record<string, unknown>) : {};
    for (const entry of params.patch ?? []) setInPlain(out, splitPath(entry.path), entry.value);
    return `${JSON.stringify(out, null, 2)}\n`;
  }

  /** Schema-check the prospective text, as `{ path, message }` a form can place per field. */
  private validate(document: ConfigDocument, text: string): ConfigValidationError[] {
    let raw: unknown;
    try {
      raw = document === "config" ? parseYaml(text) : JSON.parse(text === "" ? "{}" : text);
    } catch (e) {
      // A syntax error has no field to sit on, so it is reported at the root; a form shows
      // it above the fields rather than beside one of them.
      return [{ path: "", message: (e as Error).message }];
    }
    const schema = document === "config" ? OrcaConfigSchema : WritablePermissionPolicyFileSchema;
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) return validationErrors(parsed.error);
    return document === "config" ? configReferenceErrors(OrcaConfigSchema.parse(raw ?? {})) : [];
  }

  /**
   * The permission policy each configured agent is actually evaluated under, in evaluation
   * order, with each rule labelled by the document it came from.
   *
   * The order is `effectivePermissionPolicy`'s and nothing else's - configured rules first,
   * then the sidecar's, then `DEFAULT_PERMISSION_POLICY`'s *when they apply*, first match wins
   * (ADR 0009 as corrected by #140). It is computed there rather than here, and here rather
   * than in the app, for the same reason each time: a second implementation of the layering is
   * a second answer to "why was this allowed", and the two drift.
   *
   * The third layer is the reason `source` has a `default` case. Until #140 the defaults were
   * folded into the parsed config, so `configured` counted them and every one of them was
   * reported as something the operator had written into `orca.config.yaml`. An agent whose
   * config sets `default:` has no third layer at all, and `sidecarEnd` is then the end of the
   * list - which is why this counts rather than assuming.
   */
  private effective(config: ConfigDocumentView, permissions: ConfigDocumentView): ConfigEffectivePolicy {
    const parsed = OrcaConfigSchema.safeParse(config.parsed ?? {});
    if (!parsed.success) return { agents: {} };
    const sidecar = WritablePermissionPolicyFileSchema.safeParse(permissions.parsed ?? {});
    const doc: PermissionPolicyFile = sidecar.success
      ? { version: sidecar.data.version, agents: sidecar.data.agents }
      : { version: 1, agents: {} };
    const agents: ConfigEffectivePolicy["agents"] = {};
    for (const agent of parsed.data.agents) {
      const recorded = doc.agents[agent.id]?.rules ?? [];
      const layered = effectivePermissionPolicy(agent.permissions, permissionOverlayFor(doc, agent.id));
      const configured = agent.permissions.rules.length;
      const sidecarEnd = configured + recorded.length;
      const rules: EffectivePermissionRule[] = layered.rules.map((rule, i) => {
        if (i < configured) return { ...rule, source: "config" };
        if (i >= sidecarEnd) return { ...rule, source: "default" };
        const provenance = recorded[i - configured];
        return {
          ...rule,
          source: "permissions",
          ...(provenance?.addedAt ? { addedAt: provenance.addedAt } : {}),
          ...(provenance?.grantedFor ? { grantedFor: provenance.grantedFor } : {}),
        };
      });
      agents[agent.id] = { default: layered.default, rules };
    }
    return { agents };
  }
}

/* ------------------------------ plain helpers ------------------------------ */

/**
 * Refuse an edit made against a revision the file no longer has.
 *
 * Called twice per write: once before the lock, where it is a cheap refusal with a message
 * that distinguishes "changed" from "exists now and did not", and once inside it, where it is
 * the one that decides. Outside the lock it can be wrong in only one direction - it can miss
 * a change that lands a moment later, which the in-lock compare then catches.
 */
function refuseIfStale(params: ConfigSetParams, current: ConfigDocumentView): void {
  if (params.expectedRevision === current.revision) return;
  throw new ProtocolFault(
    "CONFIG_STALE",
    current.exists
      ? `${current.path} has changed since you read it: write again against the current revision`
      : `${current.path} exists now and did not when you read it: write again against the current revision`,
    { document: params.document, expectedRevision: params.expectedRevision, actualRevision: current.revision },
  );
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `parsed` is best-effort: a file that does not parse still has `text`, which is what an editor shows. */
function safeParse(document: ConfigDocument, text: string): unknown {
  try {
    return document === "config" ? parseYaml(text) : JSON.parse(text === "" ? "{}" : text);
  } catch {
    return undefined;
  }
}

/**
 * `hosts[1].transport` or `hosts.1.transport` into `["hosts", 1, "transport"]`. Both
 * spellings are accepted because the schema description writes `hosts[]` and a form that
 * substitutes an index will produce either.
 */
export function splitPath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const segment of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (segment === "") continue;
    out.push(/^\d+$/.test(segment) ? Number(segment) : segment);
  }
  if (out.length === 0) throw new OrcaError("CONFIG_INVALID", `'${path}' is not a field path`, { path });
  return out;
}

/** `setIn`/`deleteIn` for a plain object, for the two cases with no YAML document to edit. */
function setInPlain(target: Record<string, unknown>, path: (string | number)[], value: unknown): void {
  let node: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = String(path[i]);
    const next = node[key];
    if (typeof next !== "object" || next === null) node[key] = typeof path[i + 1] === "number" ? [] : {};
    node = node[key] as Record<string, unknown>;
  }
  const last = String(path[path.length - 1]);
  if (value === undefined) delete node[last];
  else node[last] = value;
}

/** tmp + rename, so a reader never sees half a config file. */
async function writeAtomically(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

/** YAML null/empty documents use schema defaults; syntax failures keep undefined and fail validation. */
function configurationValue(view: ConfigDocumentView): unknown {
  return !view.exists || view.parsed === null ? {} : view.parsed;
}
