/**
 * `config.get` and `config.set` - the workspace's configuration over the wire, so the app
 * can render and edit it without ever reading a file (ADR 0008: everything the app knows
 * about ORCA arrives as a protocol method).
 *
 * **Two documents, not one (#266).** ADR 0009 moved written permission grants out of
 * `orca.config.yaml` and into `orca.permissions.json` beside it, and `layerPermissionPolicies`
 * evaluates the configured rules first and the sidecar's after them. A `config.get` that
 * returned only the YAML could not show the effective policy, and a `config.set` that wrote
 * only the YAML would have nowhere to put an edited grant. So a `ConfigDocumentView` carries
 * its own `path` and its own `revision`, and `config.set` names which of the two it writes.
 *
 * **`revision` is a content hash, and it is the whole of the concurrency story.** A client
 * reads a document, edits it, and sends back the revision it read; a daemon whose bytes have
 * moved since answers `CONFIG_STALE` with both revisions rather than overwriting whatever
 * landed in between. An mtime would have been cheaper and would have lied on a filesystem
 * with a one-second stamp; a hash of the bytes cannot.
 *
 * **Three views of the same thing, on purpose.** `text` is the bytes, which is what an editor
 * pane shows and what a `text` write sends back; `parsed` is the document as YAML/JSON reads
 * it, *before* schema defaults are applied, which is what a form binds to; `schema` describes
 * the fields the form should draw. They are separate because materialising defaults into the
 * text is exactly what a config editor must never do - see `ConfigSetParams.patch`.
 *
 * **`effective` is computed by the daemon, never by the client.** Evaluation order is
 * `layerPermissionPolicies`' and first-match-wins is `decidePermission`'s; a second
 * implementation in a renderer would be a second answer to "why was this allowed".
 */
import { z } from "zod";
// The node-free subpath, not the package root: the renderer bundles this package. See runs.ts.
import { PermissionDecisionSchema, PermissionRuleSchema, ToolKindSchema } from "@orca/core/schemas";

export const CONFIG_GET_METHOD = "config.get";
export const CONFIG_SET_METHOD = "config.set";

/**
 * The sidecar document itself, as a client composes it for `config.set { document:
 * "permissions", text }` (#176).
 *
 * Re-exported from `@orca/core` rather than restated here. The daemon validates the bytes a
 * client sends through `replacePermissionPolicyFile`, which parses against *this* schema, so
 * a second spelling of the shape in the protocol would be a second answer to "is this a
 * valid sidecar" and the two would drift on the first field either of them gained. What the
 * wire adds over the file is nothing: the sidecar is a document, not a message.
 *
 * Note the file's central rule is enforced at the daemon, not here: `PermissionPolicyFile`
 * has no `default` field, and a document carrying one is *refused* by the writer rather than
 * stripped (ADR 0009, #266). An editor must therefore never offer one.
 */
export {
  PermissionPolicyFileSchema,
  RecordedPermissionRuleSchema,
  PERMISSION_POLICY_FILENAME,
} from "@orca/core/schemas";
export type { PermissionPolicyFile, RecordedPermissionRule } from "@orca/core/schemas";

/**
 * The ten ACP tool kinds and the three decisions, as arrays rather than as a type.
 *
 * A form that edits a permission rule has to *draw* the choices, and a renderer may not
 * import `@orca/core` to get at `ToolKindSchema` (ADR 0008: the app imports `@orca/protocol`
 * and `@orca/design` and nothing else). These are the schemas' own option lists, so a kind
 * added to the vocabulary appears in the control without this line being edited — and a
 * client that hard-coded ten strings could not say the same.
 */
export const TOOL_KINDS = ToolKindSchema.options;
export const PERMISSION_DECISIONS = PermissionDecisionSchema.options;

/**
 * Which of the workspace's two configuration documents. `config` is `orca.config.yaml` (or
 * `.yml`/`.json`, whichever discovery found); `permissions` is the ADR 0009 sidecar.
 */
export const CONFIG_DOCUMENTS = ["config", "permissions"] as const;
export const ConfigDocumentSchema = z.enum(CONFIG_DOCUMENTS);
export type ConfigDocument = z.infer<typeof ConfigDocumentSchema>;

/** One document as it is on disk right now. */
export const ConfigDocumentViewSchema = z.object({
  document: ConfigDocumentSchema,
  /** Absolute path, so a client can name the file a person would open in an editor. */
  path: z.string(),
  /**
   * False when there is no file yet. That is an ordinary state, not an error: a workspace
   * where nobody has answered "always" has no sidecar, and `config.set` creates either one.
   */
  exists: z.boolean(),
  /**
   * `sha256` of the bytes, hex. `""` when the file does not exist, which is the revision a
   * client sends as `expectedRevision` to say "create this, and refuse if somebody beat me".
   */
  revision: z.string(),
  /**
   * The bytes, verbatim - comments and formatting included.
   *
   * Unredacted editor bytes. Requires current config.read authority; ordinary run readers
   * cannot access this method. Saving a redacted document would destroy hidden values.
   */
  text: z.string(),
  /**
   * The document as YAML/JSON parsed it, before schema defaults. Absent when the file does
   * not exist or does not parse; a form binds to this and to `schema` beside it.
   */
  parsed: z.unknown().optional(),
});
export type ConfigDocumentView = z.infer<typeof ConfigDocumentViewSchema>;

/** The kinds a form can draw. `unknown` is honest: a schema node this walker cannot describe. */
export const CONFIG_FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "enum",
  "object",
  "array",
  "record",
  "unknown",
] as const;
export const ConfigFieldTypeSchema = z.enum(CONFIG_FIELD_TYPES);
export type ConfigFieldType = z.infer<typeof ConfigFieldTypeSchema>;

/**
 * One field of the config schema, as the form renders it.
 *
 * `path` is dotted, with an array's element type written once as `hosts[]` rather than per
 * index: the description is of the *schema*, not of the document, so it says what a host
 * looks like and the form repeats it for each one the document holds.
 */
export const ConfigFieldDescriptionSchema = z.object({
  path: z.string(),
  type: ConfigFieldTypeSchema,
  /** The allowed values, when `type` is `enum`. */
  enum: z.array(z.string()).optional(),
  /** False when the schema supplies a default or the field is optional. */
  required: z.boolean(),
  /** The schema's default, when it has one. Absent is not the same as `null`. */
  default: z.unknown().optional(),
  /** The doc comment the schema carries, when it carries one. */
  help: z.string().optional(),
});
export type ConfigFieldDescription = z.infer<typeof ConfigFieldDescriptionSchema>;

/** The whole of the config schema, flattened, in declaration order. */
export const ConfigSchemaDescriptionSchema = z.array(ConfigFieldDescriptionSchema);
export type ConfigSchemaDescription = z.infer<typeof ConfigSchemaDescriptionSchema>;

/** Rich input structure supplements the legacy flat descriptor; never infer it from required. */
export interface ConfigFieldMetadata {
  acceptsAbsent: boolean | "metadata-unavailable";
  acceptsNull: boolean | "metadata-unavailable";
  visibility: "non-secret" | "withheld" | "metadata-unavailable";
  default:
    | { state: "none" }
    | { state: "available"; value: unknown }
    | { state: "withheld" }
    | { state: "metadata-unavailable" };
}
export type ConfigFieldShape = ConfigFieldMetadata &
  (
    | { kind: "scalar"; field: ConfigFieldDescription }
    | { kind: "object"; fields: Record<string, ConfigFieldShape> }
    | { kind: "array"; item: ConfigFieldShape }
    | { kind: "record"; value: ConfigFieldShape }
    | { kind: "union"; discriminator: string; branches: Record<string, ConfigFieldShape> }
    | { kind: "unsupported"; reason: "opaque" | "metadata-unavailable" }
  );
const FieldMetadataShape = {
  acceptsAbsent: z.union([z.boolean(), z.literal("metadata-unavailable")]),
  acceptsNull: z.union([z.boolean(), z.literal("metadata-unavailable")]),
  visibility: z.enum(["non-secret", "withheld", "metadata-unavailable"]),
  default: z.discriminatedUnion("state", [
    z.object({ state: z.literal("none") }),
    z.object({ state: z.literal("available"), value: z.unknown() }),
    z.object({ state: z.literal("withheld") }),
    z.object({ state: z.literal("metadata-unavailable") }),
  ]),
};
export const ConfigFieldShapeSchema: z.ZodType<ConfigFieldShape> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ ...FieldMetadataShape, kind: z.literal("scalar"), field: ConfigFieldDescriptionSchema }),
    z.object({
      ...FieldMetadataShape,
      kind: z.literal("object"),
      fields: z.record(z.string(), ConfigFieldShapeSchema),
    }),
    z.object({ ...FieldMetadataShape, kind: z.literal("array"), item: ConfigFieldShapeSchema }),
    z.object({ ...FieldMetadataShape, kind: z.literal("record"), value: ConfigFieldShapeSchema }),
    z.object({
      ...FieldMetadataShape,
      kind: z.literal("union"),
      discriminator: z.string().min(1),
      branches: z.record(z.string(), ConfigFieldShapeSchema),
    }),
    z.object({
      ...FieldMetadataShape,
      kind: z.literal("unsupported"),
      reason: z.enum(["opaque", "metadata-unavailable"]),
    }),
  ]),
);
export const ConfigFormSchemaSchema = z.object({ version: z.literal(1), root: ConfigFieldShapeSchema });
export type ConfigFormSchema = z.infer<typeof ConfigFormSchemaSchema>;

/**
 * Where an effective rule came from. The two documents, plus `default` — the built-in rules
 * `@orca/agents` appends last (#140). `default` is *not* a `ConfigDocument`: there is no file
 * behind it and `config.set` cannot address it, which is exactly why it needs its own name.
 * Adding it was the fix for the Config surface reporting rules nobody wrote as `config`.
 */
export const EFFECTIVE_RULE_SOURCES = [...CONFIG_DOCUMENTS, "default"] as const;
export const EffectiveRuleSourceSchema = z.enum(EFFECTIVE_RULE_SOURCES);
export type EffectiveRuleSource = z.infer<typeof EffectiveRuleSourceSchema>;

/**
 * One rule of an agent's effective policy, with where it came from. The order of the array
 * is the order `decidePermission` matches in, so a form that lists them top to bottom is
 * showing the real precedence: configured rules first, then the sidecar's, then the
 * defaults' (ADR 0009, as corrected by #140).
 */
export const EffectivePermissionRuleSchema = PermissionRuleSchema.extend({
  source: EffectiveRuleSourceSchema,
  /** Sidecar provenance, per ADR 0009. Absent on a configured or default rule. */
  addedAt: z.string().optional(),
  grantedFor: z.string().optional(),
});
export type EffectivePermissionRule = z.infer<typeof EffectivePermissionRuleSchema>;

/**
 * One agent's policy as it is actually evaluated.
 *
 * `default` is on the *configured* policy alone and the sidecar cannot carry one, which is
 * ADR 0009's central rule: answering one prompt must never change the answer to every other
 * one. It is reported here because a list of rules without the fallthrough is not the
 * effective policy, it is half of it.
 */
export const EffectiveAgentPolicySchema = z.object({
  default: PermissionDecisionSchema,
  rules: z.array(EffectivePermissionRuleSchema),
});
export type EffectiveAgentPolicy = z.infer<typeof EffectiveAgentPolicySchema>;

export const ConfigEffectivePolicySchema = z.object({
  /** Keyed by agent id, for every agent the config declares. */
  agents: z.record(z.string(), EffectiveAgentPolicySchema),
});
export type ConfigEffectivePolicy = z.infer<typeof ConfigEffectivePolicySchema>;

export const ConfigGetParamsSchema = z.object({});
export type ConfigGetParams = z.infer<typeof ConfigGetParamsSchema>;

export const CONFIG_APPLY_METHOD = "config.apply";
export const ConfigGenerationStatusSchema = z.object({
  savedRevision: z.string(),
  activeGeneration: z.string(),
  activeRevision: z.string(),
  state: z.enum(["active", "pending", "restart-required", "invalid"]),
  restartRequired: z.array(z.string()),
});
export type ConfigGenerationStatus = z.infer<typeof ConfigGenerationStatusSchema>;
export const ConfigApplyParamsSchema = z
  .object({
    expectedRevision: z.string(),
    expectedGeneration: z.string().min(1),
    validateOnly: z.boolean().optional(),
  })
  .strict();
export type ConfigApplyParams = z.infer<typeof ConfigApplyParamsSchema>;
export const ConfigApplyResultSchema = z.object({
  outcome: z.enum(["applied", "unchanged", "validated", "restart-required", "invalid"]),
  status: ConfigGenerationStatusSchema,
  validation: z.object({ errors: z.array(z.object({ path: z.string(), message: z.string() })) }),
});
export type ConfigApplyResult = z.infer<typeof ConfigApplyResultSchema>;

export const ConfigGetResultSchema = z.object({
  config: ConfigDocumentViewSchema,
  permissions: ConfigDocumentViewSchema,
  schema: ConfigSchemaDescriptionSchema,
  formSchema: ConfigFormSchemaSchema.optional(),
  effective: ConfigEffectivePolicySchema,
  generation: ConfigGenerationStatusSchema.optional(),
  asOf: z.string(),
});
export type ConfigGetResult = z.infer<typeof ConfigGetResultSchema>;

/** Literal tuple paths: a string key containing dots/brackets/numerals is never an index. */
export const ConfigEditPathSchema = z
  .array(z.union([z.string().min(1), z.number().int().nonnegative()]))
  .min(1)
  .max(64)
  .refine(
    (path) => path.every((key) => typeof key !== "string" || !["__proto__", "prototype", "constructor"].includes(key)),
    "unsafe configuration key",
  );
export const ConfigEditIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("set"), path: ConfigEditPathSchema, value: z.unknown() })
    .refine((edit) => Object.hasOwn(edit, "value") && edit.value !== undefined, "set requires an explicit value"),
  z.object({ kind: z.literal("remove"), path: ConfigEditPathSchema }),
  z
    .object({
      kind: z.literal("insert"),
      path: ConfigEditPathSchema,
      index: z.number().int().nonnegative(),
      value: z.unknown(),
    })
    .refine((edit) => Object.hasOwn(edit, "value") && edit.value !== undefined, "insert requires an explicit value"),
  z.object({
    kind: z.literal("move"),
    path: ConfigEditPathSchema,
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }),
]);
export type ConfigEditIntent = z.infer<typeof ConfigEditIntentSchema>;

/**
 * One field-level edit. `path` is dotted with numeric array indices (`hosts.1.transport`)
 * or bracketed (`hosts[1].transport`) - both are accepted, because the schema description
 * writes `hosts[]` and a form that substitutes an index will write either.
 *
 * Omitting `value` **deletes** the key rather than setting it to null. A form that clears an
 * optional field wants the key gone, so the default comes back; writing `null` would be a
 * value the schema has to reject.
 */
export const ConfigPatchEntrySchema = z.object({
  path: z.string().min(1),
  value: z.unknown().optional(),
});
export type ConfigPatchEntry = z.infer<typeof ConfigPatchEntrySchema>;

/**
 * `config.set` - write one document.
 *
 * **Exactly one of `text` and `patch`.** They are different promises. `text` replaces the
 * bytes with the bytes given, which is what an editor pane sends; `patch` edits the parsed
 * YAML *document* in place, preserving every comment and every piece of formatting the file
 * already had, which is what a form sends. What the daemon never does is re-serialise the
 * parsed config: that would materialise every schema default into the file and delete every
 * comment in it, turning one changed field into a diff nobody can review.
 *
 * `validateOnly` runs the whole of a write - build the new text, parse it, check it against
 * the schema - and then does not write it. The result carries the document as it *would*
 * become plus `validation.errors`, so a form can mark its fields as somebody types.
 */
export const ConfigSetParamsSchema = z
  .object({
    document: ConfigDocumentSchema,
    /**
     * The `revision` this edit was made against, from the `ConfigDocumentView` the client
     * read. `""` asserts the file did not exist. A mismatch is `CONFIG_STALE`.
     */
    expectedRevision: z.string(),
    /** Replace the file's bytes with these, after validating them. */
    text: z.string().optional(),
    /** Or apply these field edits to the existing document, comments and all. */
    patch: z.array(ConfigPatchEntrySchema).optional(),
    /** Rich form operations lowered against the exact revision, preserving retained source spans. */
    edits: z.array(ConfigEditIntentSchema).max(1000).optional(),
    /** Validate and report, write nothing. */
    validateOnly: z.boolean().optional(),
  })
  .refine((p) => [p.text, p.patch, p.edits].filter((value) => value !== undefined).length === 1, {
    message: "exactly one of 'text', 'patch' and 'edits': they are different writes, not two spellings of one",
  })
  .refine(
    (p) => p.edits === undefined || p.document === "config",
    "structured operations apply only to the config document",
  );
export type ConfigSetParams = z.infer<typeof ConfigSetParamsSchema>;

/** A schema failure, keyed by the dotted path a form places it at (`hosts[1].transport`). */
export const ConfigValidationErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ConfigValidationError = z.infer<typeof ConfigValidationErrorSchema>;

export const ConfigSetResultSchema = z.object({
  /** The document as it now is - or, under `validateOnly`, as it would have been. */
  document: ConfigDocumentViewSchema,
  /** Written to disk. False under `validateOnly`, and only then. */
  written: z.boolean(),
  generation: ConfigGenerationStatusSchema.optional(),
  /**
   * Present under `validateOnly`. A write that would fail raises `CONFIG_INVALID` instead;
   * this is the same information, reported rather than thrown, for a form that asks as the
   * person types.
   */
  validation: z.object({ errors: z.array(ConfigValidationErrorSchema) }).optional(),
  asOf: z.string(),
});
export type ConfigSetResult = z.infer<typeof ConfigSetResultSchema>;
