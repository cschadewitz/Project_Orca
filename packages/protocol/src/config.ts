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
import { PermissionDecisionSchema, PermissionRuleSchema } from "@orca/core/schemas";

export const CONFIG_GET_METHOD = "config.get";
export const CONFIG_SET_METHOD = "config.set";

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
   * **Nothing here is redacted.** A config may name an ssh host, a command line or an
   * environment variable that a reader would call a secret, and `config.get` hands all of it
   * over. That is deliberate: a form that edits a file has to show the file, and a redacted
   * `text` written back would destroy what it hid. The daemon's port is loopback and
   * unauthenticated (see `orca serve --help`), so anything running as this user can already
   * read the file directly; this method adds no exposure that a `cat` did not have.
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

/**
 * One rule of an agent's effective policy, with where it came from. The order of the array
 * is the order `decidePermission` matches in, so a form that lists them top to bottom is
 * showing the real precedence: configured rules first, then the sidecar's (ADR 0009).
 */
export const EffectivePermissionRuleSchema = PermissionRuleSchema.extend({
  source: ConfigDocumentSchema,
  /** Sidecar provenance, per ADR 0009. Absent on a configured rule. */
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

export const ConfigGetResultSchema = z.object({
  config: ConfigDocumentViewSchema,
  permissions: ConfigDocumentViewSchema,
  schema: ConfigSchemaDescriptionSchema,
  effective: ConfigEffectivePolicySchema,
  asOf: z.string(),
});
export type ConfigGetResult = z.infer<typeof ConfigGetResultSchema>;

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
    /** Validate and report, write nothing. */
    validateOnly: z.boolean().optional(),
  })
  .refine((p) => (p.text === undefined) !== (p.patch === undefined), {
    message: "exactly one of 'text' and 'patch': they are different writes, not two spellings of one",
  });
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
  /**
   * Present under `validateOnly`. A write that would fail raises `CONFIG_INVALID` instead;
   * this is the same information, reported rather than thrown, for a form that asks as the
   * person types.
   */
  validation: z.object({ errors: z.array(ConfigValidationErrorSchema) }).optional(),
  asOf: z.string(),
});
export type ConfigSetResult = z.infer<typeof ConfigSetResultSchema>;
