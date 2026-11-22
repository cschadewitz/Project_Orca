/**
 * `secrets.list` and `secrets.check` (#336, part B2): metadata about the secret references a
 * workspace configures, for the app's reference picker. Neither ever returns a value, and
 * neither falls back to another host. Both need `secrets.read`, a workspace permission.
 *
 * A caller whose grant is not `*` sees only the references its grant names, on the host and
 * endpoint each is bound to now; any other id is not found. Where a value is read from (the
 * variable name, the file path) is shown only to a caller that may also read the config.
 */
import { z } from "zod";

export const SECRETS_LIST_METHOD = "secrets.list";
export const SECRETS_CHECK_METHOD = "secrets.check";
export const SECRET_METHODS = [SECRETS_LIST_METHOD, SECRETS_CHECK_METHOD] as const;

const SecretIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const SecretReferenceViewSchema = z
  .object({
    id: SecretIdSchema,
    /** The one host the value is read on. */
    host: z.string().min(1),
    provider: z.enum(["env", "file"]),
    description: z.string().optional(),
    /** `provider: env`: the variable, shown only with `config.read`. */
    name: z.string().optional(),
    /** `provider: file`: the path on the host, shown only with `config.read`. */
    path: z.string().optional(),
  })
  .strict();
export type SecretReferenceView = z.infer<typeof SecretReferenceViewSchema>;

export const SecretsListParamsSchema = z.object({}).strict();
export type SecretsListParams = z.infer<typeof SecretsListParamsSchema>;
export const SecretsListResultSchema = z.object({ secrets: z.array(SecretReferenceViewSchema) }).strict();
export type SecretsListResult = z.infer<typeof SecretsListResultSchema>;

export const SecretsCheckParamsSchema = z.object({ id: SecretIdSchema }).strict();
export type SecretsCheckParams = z.infer<typeof SecretsCheckParamsSchema>;

/**
 * Why a reference is not available, never in the provider's own words: `missing` (the
 * variable is unset or empty, or the file is absent, unreadable or empty), `unreachable` (the
 * host did not answer), `unknown-host` (the configured host does not exist), `busy` (too many
 * remote checks are already running; nothing was started, try again).
 */
export const SECRET_UNAVAILABLE_REASONS = ["missing", "unreachable", "unknown-host", "busy"] as const;
export const SecretsCheckResultSchema = z
  .object({
    id: SecretIdSchema,
    host: z.string().min(1),
    available: z.boolean(),
    reason: z.enum(SECRET_UNAVAILABLE_REASONS).optional(),
  })
  .strict();
export type SecretsCheckResult = z.infer<typeof SecretsCheckResultSchema>;
