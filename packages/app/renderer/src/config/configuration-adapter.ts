/** One authorized editor adapter: ordered daemon lowering, private reviewed bytes and target-fenced writes. */
import {
  ConfigFormSchemaSchema,
  ConfigGetResultSchema,
  ConfigSetParamsSchema,
  ConfigSetResultSchema,
  ConfigApplyResultSchema,
  ConfigApplyParamsSchema,
  type ConfigGetResult,
  type ConfigSetParams,
  type ConfigValidationError,
} from "@orca/protocol";
import type { OrcaBridge, BridgeResult } from "../../../src/bridge.js";
import type {
  ConfigurationPorts,
  ConfigCandidate,
  ConfigReview,
  EditorTarget,
  DocumentPath,
  FieldShape,
} from "../../../src/configuration-launch-contract.js";
import { isObject, pathLabel } from "./structured-form/collection-model.js";
import { capabilityPreview } from "./capability-preview.js";

export const sameEditorTarget = (a: EditorTarget | undefined, b: EditorTarget | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.workspaceId === b.workspaceId &&
  a.instanceId === b.instanceId &&
  a.epoch === b.epoch;
export function currentEditorTarget(bridge: OrcaBridge): EditorTarget | undefined {
  const observed = bridge.daemonConnection?.read();
  return observed?.identity ? { ...observed.identity, epoch: observed.epoch } : undefined;
}
export function richShape(data: ConfigGetResult): FieldShape | undefined {
  const schema = ConfigFormSchemaSchema.safeParse(data.formSchema);
  return schema.success && schema.data.version === 1 && schema.data.root.kind === "object"
    ? schema.data.root
    : undefined;
}
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    );
  }
  return false;
};
function branch(shape: FieldShape, value: unknown): FieldShape | undefined {
  return shape.kind === "union" && isObject(value) && typeof value[shape.discriminator] === "string"
    ? shape.branches[value[shape.discriminator] as string]
    : shape;
}

/** Semantic evidence is the pre-default base/candidate, never raw intent verbs or clear values. */
export function configurationChanges(shape: FieldShape, before: unknown, after: unknown): ConfigReview["changes"] {
  const changes: ConfigReview["changes"][number][] = [];
  function walk(
    node: FieldShape | undefined,
    a: unknown,
    b: unknown,
    path: DocumentPath,
    hasA: boolean,
    hasB: boolean,
  ): void {
    if (hasA === hasB && sameValue(a, b)) return;
    const kind = !hasA ? "added" : !hasB ? "removed" : "changed";
    // Unclassified names/record keys never enter a shareable summary.
    if (!node) {
      changes.push({ path: path.slice(0, -1), kind: "changed", valueDisplay: "withheld" });
      return;
    }
    if (node.visibility !== "non-secret" || !hasA || !hasB) {
      changes.push({ path, kind, valueDisplay: "withheld" });
      return;
    }
    const selectedA = branch(node, a),
      selectedB = branch(node, b);
    if (node.kind === "union") {
      if (selectedA && selectedA === selectedB && selectedA !== node) walk(selectedA, a, b, path, hasA, hasB);
      else changes.push({ path, kind, valueDisplay: "withheld" });
      return;
    }
    if ((node.kind === "object" || node.kind === "record") && isObject(a) && isObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(
          node.kind === "object" ? node.fields[key] : node.value,
          a[key],
          b[key],
          [...path, key],
          Object.hasOwn(a, key),
          Object.hasOwn(b, key),
        );
    } else changes.push({ path, kind, valueDisplay: "withheld" });
  }
  walk(shape, before ?? {}, after ?? {}, [], true, true);
  return changes.filter(
    (item, index) =>
      changes.findIndex((other) => pathLabel(other.path) === pathLabel(item.path) && other.kind === item.kind) ===
      index,
  );
}

/** All failures survive redaction. Ambiguous dotted/numeric keys become a root diagnostic. */
export function safeConfigurationErrors(
  shape: FieldShape | undefined,
  documents: readonly unknown[],
  errors: readonly ConfigValidationError[],
) {
  const paths = new Map<string, DocumentPath[]>();
  let remaining = 10_000;
  function walk(node: FieldShape, value: unknown, path: DocumentPath, visible: boolean): void {
    if (--remaining < 0 || path.length > 64) return;
    visible = visible && node.visibility === "non-secret" && node.kind !== "unsupported";
    if (visible)
      for (const spelling of new Set([path.map(String).join("."), pathLabel(path)])) {
        const listed = paths.get(spelling) ?? [];
        if (!listed.some((p) => pathLabel(p) === pathLabel(path))) listed.push(path);
        paths.set(spelling, listed);
      }
    if (node.kind === "union") {
      const selected = branch(node, value);
      if (selected && selected !== node) walk(selected, value, path, visible);
    } else if (node.kind === "object") {
      for (const [key, child] of Object.entries(node.fields))
        walk(child, isObject(value) ? value[key] : undefined, [...path, key], visible);
    } else if (node.kind === "array" && Array.isArray(value))
      value.forEach((v, i) => walk(node.item, v, [...path, i], visible));
    else if (node.kind === "record" && isObject(value))
      for (const [key, child] of Object.entries(value)) walk(node.value, child, [...path, key], visible);
  }
  if (shape) for (const document of documents) walk(shape, document, [], true);
  return errors.map((error) => ({
    path: remaining < 0 || paths.get(error.path)?.length !== 1 ? [] : paths.get(error.path)![0]!,
    message: "Configuration validation refused this field. Check its value and references.",
  }));
}

export function configurationPolicyChanged(before: unknown, after: unknown): boolean {
  function explicitPolicies(value: unknown): unknown {
    const agents = isObject(value) && Array.isArray(value.agents) ? value.agents : [];
    return agents
      .filter((agent): agent is Record<string, unknown> => isObject(agent) && Object.hasOwn(agent, "permissions"))
      .map((agent) => ({ id: agent.id, permissions: agent.permissions }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return !sameValue(explicitPolicies(before), explicitPolicies(after));
}

export class ConfigurationAdapter implements ConfigurationPorts {
  private retained: { review: ConfigReview; text: string; parsed: unknown } | undefined;
  constructor(
    readonly target: EditorTarget,
    private readonly bridge: OrcaBridge,
    private readonly base: () => ConfigGetResult,
    private readonly access: (action: "validate" | "save" | "apply") => string | undefined,
  ) {}
  private assert(action: "validate" | "save" | "apply"): void {
    if (!sameEditorTarget(this.target, currentEditorTarget(this.bridge)))
      throw new Error("Configuration target changed.");
    const reason = this.access(action);
    if (reason) throw new Error(reason);
  }
  async read(): ReturnType<ConfigurationPorts["read"]> {
    const assertRead = () => {
      if (
        !sameEditorTarget(this.target, currentEditorTarget(this.bridge)) ||
        this.bridge.connection.read().state !== "live" ||
        !this.bridge.connection.read().methods?.includes("config.get")
      )
        throw new Error("Configuration read unavailable.");
    };
    assertRead();
    const response = await this.bridge.config.get();
    assertRead();
    if (!response.ok) throw new Error("Configuration read refused.");
    const { formSchema, ...rest } = ConfigGetResultSchema.parse(response.result);
    return { ...rest, ...(formSchema ? { formSchema } : {}) };
  }
  async review(candidate: ConfigCandidate, rawText?: string): Promise<ConfigReview> {
    this.assert("validate");
    if (
      !sameEditorTarget(candidate.target, this.target) ||
      candidate.document !== "config" ||
      candidate.expectedRevision !== this.base().config.revision
    )
      throw new Error("Configuration base changed.");
    const params = ConfigSetParamsSchema.parse({
      document: "config",
      expectedRevision: candidate.expectedRevision,
      ...(rawText === undefined ? { edits: candidate.edits } : { text: rawText }),
      validateOnly: true,
    });
    const response = await this.bridge.config.set(params);
    this.assert("validate");
    if (!response.ok) throw new ConfigurationRefusal(response.error.code);
    const result = ConfigSetResultSchema.parse(response.result);
    if (result.written || result.document.document !== "config" || !result.validation)
      throw new Error("Unexpected configuration validation response.");
    const shape = richShape(this.base());
    if (!shape && rawText === undefined) throw new Error("Structured metadata unavailable.");
    const capabilities = capabilityPreview(this.base().capabilities, result.capabilities);
    const review: ConfigReview = {
      ...(capabilities ? { capabilities } : {}),
      candidate: structuredClone(candidate),
      candidateRevision: result.document.revision,
      validation: result.validation.errors,
      changes: shape
        ? configurationChanges(shape, this.base().config.parsed, result.document.parsed)
        : [{ path: [], kind: "changed", valueDisplay: "withheld" }],
    };

    this.retained = { review, text: result.document.text, parsed: result.document.parsed };
    return review;
  }
  get reviewed(): ConfigReview | undefined {
    return this.retained?.review;
  }
  get privateText(): string | undefined {
    return this.retained?.text;
  }
  get candidateParsed(): unknown {
    return this.retained?.parsed;
  }
  policyChange(): boolean {
    return !this.retained || configurationPolicyChanged(this.base().config.parsed, this.retained.parsed);
  }
  async save(review: ConfigReview) {
    this.assert("save");
    const retained = this.retained;
    if (!retained || review !== retained.review || review.validation.length > 0)
      throw new Error("Review changed or is invalid.");
    const result = await this.bridge.config.set({
      document: "config",
      expectedRevision: review.candidate.expectedRevision,
      text: retained.text,
    });
    this.assert("save");
    if (!result.ok) throw new ConfigurationRefusal(result.error.code);
    const saved = ConfigSetResultSchema.parse(result.result);
    if (
      !saved.written ||
      saved.document.document !== "config" ||
      saved.document.revision !== review.candidateRevision ||
      saved.document.text !== retained.text ||
      (saved.generation !== undefined && saved.generation.savedRevision !== saved.document.revision)
    )
      throw new Error("Unexpected configuration save acknowledgement.");
    return saved;
  }
  async apply(params: Parameters<ConfigurationPorts["apply"]>[0], target: EditorTarget) {
    this.assert("apply");
    if (!sameEditorTarget(target, this.target) || !this.bridge.config.apply)
      throw new Error("Guarded apply unavailable.");
    const response = await this.bridge.config.apply(ConfigApplyParamsSchema.parse(params));
    this.assert("apply");
    if (!response.ok) throw new ConfigurationRefusal(response.error.code);
    const result = ConfigApplyResultSchema.parse(response.result);
    const active = result.outcome === "applied" || result.outcome === "unchanged";
    if (
      result.status.savedRevision !== params.expectedRevision ||
      (active &&
        (result.status.activeRevision !== params.expectedRevision ||
          result.status.state !== "active" ||
          result.validation.errors.length > 0)) ||
      (!active && result.status.activeGeneration !== params.expectedGeneration)
    )
      throw new Error("Unexpected activation acknowledgement.");
    return result;
  }
  /** Session validation must reuse the exact lowered private bytes. */
  async validateText(params: ConfigSetParams): Promise<BridgeResult<import("@orca/protocol").ConfigSetResult>> {
    this.assert("validate");
    const retained = this.retained;
    if (
      !retained ||
      !params.validateOnly ||
      params.text !== retained.text ||
      params.expectedRevision !== retained.review.candidate.expectedRevision
    )
      throw new Error("Reviewed configuration bytes changed.");
    const response = await this.bridge.config.set(params);
    this.assert("validate");
    if (!response.ok) return response;
    const result = ConfigSetResultSchema.parse(response.result);
    if (result.document.text !== retained.text || result.document.revision !== retained.review.candidateRevision)
      throw new Error("Validated candidate changed.");
    return { ok: true, result };
  }
  invalidate(): void {
    this.retained = undefined;
  }
}
export class ConfigurationRefusal extends Error {
  constructor(readonly code: string) {
    super("Configuration command refused. Draft retained.");
  }
}
