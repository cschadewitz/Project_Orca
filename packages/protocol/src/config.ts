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
import {
  JUDGED_CRITERION_MAX,
  MAX_PERMISSION_RULE_LIFETIME_MS,
  PermissionDecisionSchema,
  PermissionRuleSchema,
  SAVED_JUDGED_KINDS,
  ToolKindSchema,
} from "@orca/core/schemas";

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
    | {
        kind: "record";
        value: ConfigFieldShape;
        /**
         * When keys are constrained (#335), the named rule they follow, which a client checks
         * with its own fixed validator; never a pattern for the client to evaluate. Known:
         * `catalog-id` (a letter or digit, then letters, digits, `.`, `_`, `-`). A client that
         * does not know the name refuses structured key edits. Absent: any key the form's own
         * safety rule allows.
         */
        keyFormat?: string | undefined;
        /**
         * `env` (#335): every value is an environment value, a literal string (whose text is
         * never shown) or a secret reference `{ secret: <id> }`. Its `value` shape stays
         * `unsupported`, so a client that does not know this hint edits nothing inside it.
         */
        valueKind?: "env" | undefined;
      }
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
    z.object({
      ...FieldMetadataShape,
      kind: z.literal("record"),
      value: ConfigFieldShapeSchema,
      keyFormat: z.string().max(64).optional(),
      valueKind: z.literal("env").optional(),
    }),
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
  /** When a sidecar rule stops deciding (protocol 2.8, #702). Absent: until removed. */
  expiresAt: z.string().optional(),
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
/**
 * One plain-language rule an agent's policy holds (protocol 2.12, #701), apart from `rules`:
 * a judged rule decides nothing in the first-match order, so listing it among the typed rules
 * would draw a precedence it does not have. It is asked about only after the typed rules
 * answered `ask`, only by a session given a judge, and its `covered` allows one call once.
 *
 * `ruleId` is the name the judged lane and the decision record give it, `config:N` or
 * `sidecar:N`: its index in its list as written, typed rules counted. A saved rule whose
 * lifetime has run out is left out, as the lane leaves it out.
 */
export const EffectiveJudgedRuleSchema = z.object({
  ruleId: z.string(),
  source: z.enum(["config", "permissions"]),
  match: PermissionRuleSchema.shape.match,
  criterion: z.string(),
  /**
   * A rule about one relayed MCP tool (#701 experimental `mcpCalls` class): its server and tool,
   * and the argument names the judge may see. Configured rules only; its `match` is then empty.
   */
  mcp: z.object({ server: z.string(), tool: z.string(), arguments: z.array(z.string()).optional() }).optional(),
  /** Sidecar provenance. Absent on a configured rule. */
  addedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type EffectiveJudgedRule = z.infer<typeof EffectiveJudgedRuleSchema>;

export const EffectiveAgentPolicySchema = z.object({
  default: PermissionDecisionSchema,
  rules: z.array(EffectivePermissionRuleSchema),
  /** The plain-language rules (protocol 2.12, #701). Absent from an older daemon: none listed. */
  judged: z.array(EffectiveJudgedRuleSchema).optional(),
});
export type EffectiveAgentPolicy = z.infer<typeof EffectiveAgentPolicySchema>;

export const ConfigEffectivePolicySchema = z.object({
  /** Keyed by agent id, for every agent the config declares. */
  agents: z.record(z.string(), EffectiveAgentPolicySchema),
});
export type ConfigEffectivePolicy = z.infer<typeof ConfigEffectivePolicySchema>;

/**
 * One agent's capability set at its own scope (#335): the workspace scope, then its inline MCP
 * servers, then `agents[].capabilities`, which is what a step gets when its workflow and node
 * select nothing. Identities and the scope that decided each entry, never a definition: no
 * command, argument, environment value or skill path. `catalog` is false for an agent's own
 * inline server. Skills carry a digest only when the catalog pins one; content is not read.
 */
const CapabilityIssueSchema = z.object({ path: z.string(), message: z.string() });
export const ConfigAgentCapabilitiesSchema = z.object({
  mcpServers: z.array(z.object({ id: z.string(), source: z.string(), catalog: z.boolean() })),
  skills: z.array(
    z.object({ id: z.string(), source: z.string(), version: z.string().optional(), digest: z.string().optional() }),
  ),
  errors: z.array(CapabilityIssueSchema),
  warnings: z.array(CapabilityIssueSchema),
});
export type ConfigAgentCapabilities = z.infer<typeof ConfigAgentCapabilitiesSchema>;
export const ConfigEffectiveCapabilitiesSchema = z.object({
  /** Keyed by agent id, for every agent the config declares. */
  agents: z.record(z.string(), ConfigAgentCapabilitiesSchema),
});
export type ConfigEffectiveCapabilities = z.infer<typeof ConfigEffectiveCapabilitiesSchema>;

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
  /** The active configuration's capability sets (#335). Absent from an older daemon. */
  capabilities: ConfigEffectiveCapabilitiesSchema.optional(),
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
  /**
   * Under `validateOnly` for the config document (#335): the capability sets the candidate
   * would give each agent, so a form can preview them before saving and applying. Absent when
   * the candidate does not parse against the schema, and from an older daemon.
   */
  capabilities: ConfigEffectiveCapabilitiesSchema.optional(),
  asOf: z.string(),
});
export type ConfigSetResult = z.infer<typeof ConfigSetResultSchema>;

/**
 * `permissions.saveJudgedRule` (protocol 2.12, #701): the app's save method for a
 * plain-language rule a person wrote or accepted.
 *
 * The daemon appends the rule to the ADR 0009 sidecar for `agentId`, after every hand-written
 * rule, and the file becomes version 4, which earlier releases refuse rather than read the rule
 * as a plain allow. A judged rule allows nothing by itself: a judge is asked about it only in a
 * session given one, only after the typed rules answered `ask`, only inside the judged lane's
 * hard boundaries, and its `covered` is an allow for one call, never a standing grant
 * (`plain-language-rules.md` in `docs/preparation/review-judge-701`).
 *
 * The match must name a kind, `read` or `search` for now: the kinds the judged lane can open
 * for, so a saved rule can never be a match-everything rule nor one that could never apply.
 * A `command` match is refused, and `path` and `pathPrefix` are relative to the workspace.
 * A saved rule always comes after the configuration's rules (decided 2026-11-23).
 *
 * It needs `permissions.grant` and `config.write`, because it writes standing permission policy
 * to the workspace's configuration, and `config.read`, because its answer describes the file:
 * whether an equal rule was already there, its place and its end. That holds on every path,
 * the duplicate that writes nothing included.
 */
export const PERMISSIONS_SAVE_JUDGED_RULE_METHOD = "permissions.saveJudgedRule";

/** The kinds a saved judged rule may name; `SAVED_JUDGED_KINDS` in `@orca/core`. */
export const SAVED_JUDGED_RULE_KINDS = SAVED_JUDGED_KINDS;

/** The longest criterion a judged rule may carry; `JUDGED_CRITERION_MAX` in `@orca/core`. */
export const JUDGED_RULE_CRITERION_MAX = JUDGED_CRITERION_MAX;

export const PermissionsSaveJudgedRuleParamsSchema = z
  .object({
    /** The agent whose policy the rule joins; it must be one the active configuration declares. */
    agentId: z.string().min(1),
    /** The deterministic gate: which calls the judge is asked about at all. */
    match: z
      .object({
        kind: z.enum(SAVED_JUDGED_KINDS),
        titlePattern: z.string().optional(),
        path: z.string().optional(),
        pathPrefix: z.string().optional(),
        scope: z.enum(["workspace", "outside-workspace"]).optional(),
      })
      .strict(),
    /** The sentence the judge applies, as the person wrote or accepted it. */
    criterion: z.string().trim().min(1).max(JUDGED_CRITERION_MAX),
    /**
     * How long the rule lasts, in milliseconds from when the daemon writes it, as on
     * `inputs.answer`'s `always`. Absent: until somebody removes it.
     */
    durationMs: z.number().int().positive().max(MAX_PERMISSION_RULE_LIFETIME_MS).optional(),
  })
  .strict();
export type PermissionsSaveJudgedRuleParams = z.infer<typeof PermissionsSaveJudgedRuleParamsSchema>;

export const PermissionsSaveJudgedRuleResultSchema = z.object({
  agentId: z.string(),
  /** The rule's id as the judged lane and the decision record name it, `sidecar:N`. */
  ruleId: z.string(),
  /**
   * `added`: appended. `extended`: the same rule (same match and criterion) was on file and
   * ended sooner, so its end moved out in place. `already-present`: on file for at least as
   * long, and nothing was written.
   */
  outcome: z.enum(["added", "extended", "already-present"]),
  /** When the rule stops deciding, stamped on the daemon's clock. Absent: until removed. */
  expiresAt: z.string().optional(),
  asOf: z.string(),
});
export type PermissionsSaveJudgedRuleResult = z.infer<typeof PermissionsSaveJudgedRuleResultSchema>;
