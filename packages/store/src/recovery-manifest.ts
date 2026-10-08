/** Strict local engineering inventory envelope; parsing grants no recovery capability. */
import { z } from "zod";

export const RECOVERY_REASONS = [
  "MANIFEST_INVALID",
  "RESOURCE_LIMIT",
  "ROOT_INVALID",
  "ROOT_OVERLAP",
  "PATH_UNSAFE",
  "PATH_COLLISION",
  "SYMLINK_REFUSED",
  "SPECIAL_FILE_REFUSED",
  "ACCESS_UNSAFE",
  "ACL_UNVERIFIED",
  "READ_FAILED",
  "OBSERVATION_CHANGED",
  "COMPONENT_MISSING",
  "COMPONENT_UNKNOWN",
  "ENTRY_UNCLASSIFIED",
  "EXTERNAL_UNVERIFIED",
  "IDENTITY_MISSING",
  "IDENTITY_MISMATCH",
  "KEY_MISSING",
  "KEY_INVALID",
  "REFERENCE_MISSING",
  "CANDIDATE_MISMATCH",
  "INTEGRITY_UNVERIFIED",
  "DIGEST_MISMATCH",
  "SEMANTIC_UNVERIFIED",
  "SEMANTIC_UNREADABLE",
  "WRITER_COVERAGE_UNKNOWN",
  "RECOVERY_DISABLED",
] as const;
export type RecoveryReason = (typeof RECOVERY_REASONS)[number];
export const RECOVERY_LIMITS = Object.freeze({
  maxRoots: 32,
  maxComponents: 64,
  maxReferences: 4096,
  maxEntries: 10000,
  maxDepth: 32,
  maxPathLength: 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxManifestBytes: 8 * 1024 * 1024,
});
export type RecoveryLimits = { -readonly [Key in keyof typeof RECOVERY_LIMITS]: number };
export const STORE_COMPONENTS = {
  runs: ["runs"],
  artifacts: ["artifacts"],
  "artifact-index": ["artifacts/index.jsonl"],
  "artifact-blobs": ["artifacts/blobs"],
  "private-execution": ["private-execution"],
  "private-execution-key": ["private-execution/.execution-key"],
  "private-workflows": ["private-workflows"],
  "private-workflows-key": ["private-workflows/.execution-key"],
  "legacy-workflows": ["workflows"],
  requests: ["requests.json"],
  "work-items": ["work-items.json"],
  plans: ["plans.json"],
  dependencies: ["dependencies.json"],
  risks: ["risks.json"],
  decisions: ["decisions.json"],
  "plan-journals": ["plans"],
  claims: ["claims"],
  leases: ["leases"],
  "request-admissions": ["request-admissions.json"],
  "request-admission-locks": ["request-admission-locks"],
  "admission-retries": ["admission-retries"],
  "continuation-locators": ["continuation-locators"],
  "workspace-identity": ["workspace-identity", "workspace-identity/id", ".workspace-identified"],
} as const;
export const REQUIRED_COMPONENTS = {
  store: Object.keys(STORE_COMPONENTS),
  app: ["preferences", "admission-intents"],
  configuration: ["configuration", "permissions", "assets", "credentials"],
} as const;
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const candidate = z.string().min(1).max(512);
export function safeRecoveryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= RECOVERY_LIMITS.maxPathLength &&
    !/[\\:]/.test(path) &&
    ![...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !/[ .]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}
export const pathCollisionKey = (path: string): string => path.normalize("NFC").toLowerCase();
const relativePath = z.string().refine(safeRecoveryPath);
const classification = z.enum(["present", "absent", "not-applicable", "external-unverified", "unknown"]);
export const RecoveryComponentSchema = z.strictObject({
  id: token,
  state: classification,
  paths: z.array(relativePath).max(32),
  candidateRef: candidate,
});
export const RecoveryReferenceSchema = z.strictObject({
  rootId: token,
  path: relativePath,
  candidateRef: candidate,
});
const access = z.strictObject({
  mode: z.number().int().min(0).max(0o7777),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  acl: z.enum(["posix-mode", "unverified"]),
});
const fileIdentity = z.strictObject({ device: z.string().max(32), inode: z.string().max(32) });
export const RecoveryEntrySchema = z
  .strictObject({
    path: relativePath,
    kind: z.enum(["file", "directory"]),
    size: z.number().int().nonnegative().max(RECOVERY_LIMITS.maxFileBytes),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    identity: fileIdentity,
    access,
    candidateRef: candidate,
  })
  .refine((entry) => (entry.kind === "file" ? entry.sha256 !== undefined : entry.sha256 === undefined));
const identity = z.string().uuid().optional();
export const RecoveryRootSchema = z.strictObject({
  id: token,
  role: z.enum(["store", "app", "configuration"]),
  expectedIdentity: identity,
  observedIdentity: identity,
  components: z.array(RecoveryComponentSchema).max(RECOVERY_LIMITS.maxComponents),
  entries: z.array(RecoveryEntrySchema).max(RECOVERY_LIMITS.maxEntries),
  access,
});
export const RecoveryManifestSchema = z.strictObject({
  version: z.literal(1),
  candidateRef: candidate,
  roots: z.array(RecoveryRootSchema).min(1).max(RECOVERY_LIMITS.maxRoots),
  references: z.array(RecoveryReferenceSchema).max(RECOVERY_LIMITS.maxReferences),
  external: z
    .array(z.strictObject({ id: token, kind: z.enum(["workspace", "credential"]), state: classification }))
    .max(64),
  enumeration: z.enum(["complete", "incomplete"]),
  observation: z.enum(["unchanged", "failed"]),
  reasons: z.array(z.enum(RECOVERY_REASONS)).max(RECOVERY_REASONS.length),
});
export type RecoveryManifest = z.infer<typeof RecoveryManifestSchema>;
export type RecoveryRoot = z.infer<typeof RecoveryRootSchema>;
export type RecoveryComponent = z.infer<typeof RecoveryComponentSchema>;
export type RecoveryReference = z.infer<typeof RecoveryReferenceSchema>;
export type RecoveryEntry = z.infer<typeof RecoveryEntrySchema>;
export type ManifestParseResult =
  { valid: true; manifest: RecoveryManifest } | { valid: false; reasons: RecoveryReason[] };

/** JSON only: no getters, coercion hooks, filesystem access or raw schema diagnostics. */
export function parseRecoveryManifest(json: string): ManifestParseResult {
  if (typeof json !== "string") return { valid: false, reasons: ["MANIFEST_INVALID"] };
  if (Buffer.byteLength(json) > RECOVERY_LIMITS.maxManifestBytes) return { valid: false, reasons: ["RESOURCE_LIMIT"] };
  try {
    const parsed = RecoveryManifestSchema.safeParse(JSON.parse(json) as unknown);
    if (!parsed.success) return { valid: false, reasons: ["MANIFEST_INVALID"] };
    if (parsed.data.roots.reduce((count, root) => count + root.entries.length, 0) > RECOVERY_LIMITS.maxEntries)
      return { valid: false, reasons: ["RESOURCE_LIMIT"] };
    return { valid: true, manifest: parsed.data };
  } catch {
    return { valid: false, reasons: ["MANIFEST_INVALID"] };
  }
}
