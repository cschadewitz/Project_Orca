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
 * **`revision` is a content hash and the only concurrency control there is.** A client sends
 * back the revision it read; anything else is `CONFIG_STALE`, with both revisions, rather
 * than a write that wins by arriving second. There is no lease here: a configuration file is
 * not a run, and #160's lease story is about who may interpret a run, not who may edit a
 * file. What `config.set` does hold is the sidecar's own lock, for the sidecar.
 */
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { permissionOverlayFor, replacePermissionPolicyFile } from "@orca/agents";
import {
  DEFAULT_PERMISSION_POLICY,
  layerPermissionPolicies,
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
  type ConfigDocument,
  type ConfigDocumentView,
  type ConfigEffectivePolicy,
  type ConfigGetResult,
  type ConfigSetParams,
  type ConfigSetResult,
  type ConfigValidationError,
  type EffectivePermissionRule,
} from "@orca/protocol";
import { describeConfigSchema, validationErrors } from "./config-schema.js";

/** The default name a `config.set` creates when the workspace has no config file yet. */
export const DEFAULT_CONFIG_FILENAME = "orca.config.yaml";

export interface ConfigModelOptions {
  /** The directory the two documents live in - `OrcaApp.configDir`. */
  configDir: string;
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
}

/**
 * The two configuration documents, read and written.
 *
 * It is a `config.changed` source as well as a method implementation: `subscriptions.ts`
 * attaches to `onChange` exactly as it attaches to the agent health tracker, because the
 * frame has the same shape of life - no run, no cursor, nothing to replay.
 */
export class ConfigModel {
  private readonly configFile: string;
  private readonly permissionsFile: string;
  private readonly clock: Clock;
  private readonly listeners = new Set<(change: ConfigChange) => void>();

  constructor(opts: ConfigModelOptions) {
    this.configFile = opts.configFile ?? join(opts.configDir, DEFAULT_CONFIG_FILENAME);
    this.permissionsFile = opts.permissionsFile ?? join(opts.configDir, PERMISSION_POLICY_FILENAME);
    this.clock = opts.clock ?? systemClock;
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
   * **Nothing in `text` is redacted** - see `ConfigDocumentViewSchema.text` for why, and say
   * so to anyone who asks: this method hands a client the bytes of the config file, host
   * entries and command lines included. The daemon's port is loopback and unauthenticated,
   * so it grants no reader anything a `cat` did not already grant them, but it is a real
   * widening of what travels over the wire and it is not hidden behind a flag.
   */
  async get(): Promise<ConfigGetResult> {
    const config = await this.read("config");
    const permissions = await this.read("permissions");
    return {
      config,
      permissions,
      schema: describeConfigSchema(),
      effective: this.effective(config, permissions),
      asOf: this.clock.isoNow(),
    };
  }

  /**
   * `config.set`: write one document, or say why it cannot be written.
   *
   * **The daemon goes on serving the configuration it booted with.** Nothing here reloads
   * the orchestrator: agents, hosts, workflows and the store were wired at `bootstrap` and
   * rewiring them under runs that are in flight is its own piece of work, not a side effect
   * of a form being saved. So a `config.set` changes the file and the next `orca serve`, and
   * a run starting a moment later still uses the old config. A run already in flight is
   * likewise undisturbed - this method touches no run, takes no lease and appends no event,
   * which is what makes editing the config while a run starts a safe thing to do rather than
   * a race (#174).
   */
  async set(params: ConfigSetParams): Promise<ConfigSetResult> {
    const current = await this.read(params.document);
    if (params.expectedRevision !== current.revision)
      throw new ProtocolFault(
        "CONFIG_STALE",
        current.exists
          ? `${current.path} has changed since you read it: write again against the current revision`
          : `${current.path} exists now and did not when you read it: write again against the current revision`,
        { document: params.document, expectedRevision: params.expectedRevision, actualRevision: current.revision },
      );

    const text =
      params.document === "config" ? this.nextConfigText(current, params) : this.nextSidecarText(current, params);
    const errors = this.validate(params.document, text);

    if (params.validateOnly) {
      const parsed = safeParse(params.document, text);
      return {
        document: { ...current, exists: true, revision: hash(text), text, ...(parsed === undefined ? {} : { parsed }) },
        written: false,
        validation: { errors },
        asOf: this.clock.isoNow(),
      };
    }
    if (errors.length)
      throw new OrcaError("CONFIG_INVALID", `${current.path}: ${errors[0]?.message ?? "invalid"}`, { errors });

    if (params.document === "config") await writeAtomically(current.path, text);
    // The sidecar's own writer, under the sidecar's own lock. See the file header.
    else await replacePermissionPolicyFile(current.path, JSON.parse(text));

    const written = await this.read(params.document);
    this.publish(written);
    return { document: written, written: true, asOf: this.clock.isoNow() };
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
    return parsed.success ? [] : validationErrors(parsed.error);
  }

  /**
   * The permission policy each configured agent is actually evaluated under, in evaluation
   * order, with each rule labelled by the document it came from.
   *
   * The order is `layerPermissionPolicies`' and nothing else's - configured rules first, then
   * the sidecar's, then `DEFAULT_PERMISSION_POLICY`'s, first match wins (ADR 0009 as corrected
   * by #140). It is computed here rather than left to the app for exactly that reason: a
   * renderer that concatenated the lists itself would be a second answer to "why was this
   * allowed", and the two would drift the day a fourth layer lands.
   *
   * The third layer is the reason `source` has a `default` case. Until #140 the defaults were
   * folded into the parsed config, so `configured` counted them and every one of them was
   * reported as something the operator had written into `orca.config.yaml`.
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
      const layered = layerPermissionPolicies(
        agent.permissions,
        permissionOverlayFor(doc, agent.id),
        DEFAULT_PERMISSION_POLICY.rules,
      );
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
