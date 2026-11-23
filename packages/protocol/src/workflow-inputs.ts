/**
 * Typed workflow launch inputs on the wire (#330): the declaration a client discovers on
 * `workflows.get` (`WorkflowView.inputSchema`), and the reserved `workflows.validateInputs`
 * preflight that answers with the same field-level diagnostics a launch would refuse with.
 *
 * The preflight is side-effect-free: no run, no workspace, no agent, no stored definition. Its
 * result names the definition it checked by `version` and an opaque `revision` (a content
 * digest the daemon computes), and a client that then starts the run passes both back so
 * admission refuses rather than launching a definition that changed in between. It never echoes
 * the resolved values - a client already has what it sent, and defaults may be sensitive.
 *
 * Failures are `ValidationResult { ok, errors, warnings }` with `{ path, message }` issues,
 * paths like `vars.count` or `vars.repo.branches[0]`. A launch refused for the same reasons
 * is `WORKFLOW_INPUT_INVALID` with `details: { errors, warnings }`.
 *
 * The method name and schemas are reserved, not advertised: registration, authorization and
 * capability advertisement belong to the integration that wires it (see
 * docs/runtime-foundation-parallel-contract.md).
 */
import { z } from "zod";

export const WORKFLOWS_VALIDATE_INPUTS_METHOD = "workflows.validateInputs";

/** One problem with one field. The message says what is wrong, never what the value was. */
export const ValidationIssueSchema = z.object({ path: z.string(), message: z.string() });
export type ValidationIssueView = z.infer<typeof ValidationIssueSchema>;

/** `ok` means no errors; warnings never block a launch. */
export const ValidationResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(ValidationIssueSchema),
  warnings: z.array(ValidationIssueSchema),
});
export type ValidationResultView = z.infer<typeof ValidationResultSchema>;

/**
 * One declared input as discovery shows it. Loose on purpose: `type` is a string rather than
 * the types the daemon knows today (`secret` names a configured secret by id, #363) and unknown keys survive parsing, so an older client draws a
 * newer declaration as a plain field instead of failing to read the workflow. A `sensitive`
 * declaration arrives without its `default` and `enum`, at every depth.
 */
export interface WorkflowInputDeclarationView {
  type: string;
  description?: string | undefined;
  required?: boolean | undefined;
  default?: unknown;
  nullable?: boolean | undefined;
  sensitive?: boolean | undefined;
  enum?: (string | number | boolean)[] | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  pattern?: string | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  items?: WorkflowInputDeclarationView | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  properties?: Record<string, WorkflowInputDeclarationView> | undefined;
  additionalProperties?: boolean | undefined;
}

export const WorkflowInputDeclarationViewSchema: z.ZodType<WorkflowInputDeclarationView> = z.lazy(() =>
  z.looseObject({
    type: z.string(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    nullable: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    pattern: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    items: WorkflowInputDeclarationViewSchema.optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    properties: z.record(z.string(), WorkflowInputDeclarationViewSchema).optional(),
    additionalProperties: z.boolean().optional(),
  }),
);

/**
 * A workflow's launch-input declaration. `unknown` is what happens to a var nothing declares:
 * `allow` (the default when absent) passes it through, `warn` passes it with a warning,
 * `reject` refuses the launch. A string here so a newer policy does not break an older client.
 */
export interface WorkflowInputSchemaView {
  fields: Record<string, WorkflowInputDeclarationView>;
  unknown?: string | undefined;
}

export const WorkflowInputSchemaViewSchema: z.ZodType<WorkflowInputSchemaView> = z.looseObject({
  fields: z.record(z.string(), WorkflowInputDeclarationViewSchema),
  unknown: z.string().optional(),
});

export const WorkflowsValidateInputsParamsSchema = z.object({
  /** A registered workflow's id. */
  workflowId: z.string().min(1),
  /**
   * The version to check: one kept in the workflow-version store, or the one on disk. Absent
   * means the one a launch without a version would start on.
   */
  version: z.string().min(1).optional(),
  /** The launch vars a client would start with. Absent means none. */
  vars: z.record(z.string(), z.unknown()).default({}),
});
export type WorkflowsValidateInputsParams = z.input<typeof WorkflowsValidateInputsParamsSchema>;

export const WorkflowsValidateInputsResultSchema = z.object({
  workflowId: z.string(),
  /** The version that was checked; pass it to the launch as `workflowVersion`. */
  version: z.string(),
  /** Opaque content digest of that definition; pass it to the launch as `expectedWorkflowRevision`. */
  revision: z.string(),
  validation: ValidationResultSchema,
});
export type WorkflowsValidateInputsResult = z.infer<typeof WorkflowsValidateInputsResultSchema>;
