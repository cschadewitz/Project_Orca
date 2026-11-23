/**
 * The permission sidecar reader and replace guard exactly as released in 0.7.0 (dc04a72a) and
 * 0.7.1 (515fe2b2), which are identical here. Copied verbatim from that tag's
 * `packages/core/src/model/agent.ts` (`RecordedPermissionRuleSchema`, `PermissionPolicyFileSchema`)
 * and `packages/agents/src/permissions.ts` (`readPermissionPolicyFile`, `permissionOverlayFor`,
 * `loadEffectivePermissionPolicy`, `refuseUnsupportedPolicyReplacement`), so #702's tests can
 * show what an older binary does with a sidecar this build writes. Do not update it to match
 * the current code: its whole value is that it does not.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  effectivePermissionPolicy,
  isWildcardPermissionRule,
  OrcaError,
  PermissionRuleSchema,
  type ConfiguredPermissionPolicy,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionRule,
} from "@orca/core";

const RecordedPermissionRuleSchema = PermissionRuleSchema.extend({
  addedAt: z.string().optional(),
  grantedFor: z.string().optional(),
});
const PermissionPolicyFileSchema = z.object({
  version: z.literal(1).default(1),
  agents: z.record(z.string(), z.object({ rules: z.array(RecordedPermissionRuleSchema).default([]) })).default({}),
});
type PermissionPolicyFile = z.infer<typeof PermissionPolicyFileSchema>;
const EMPTY_POLICY_FILE: PermissionPolicyFile = { version: 1, agents: {} };

export async function releasedReadPermissionPolicyFile(file: string): Promise<PermissionPolicyFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_POLICY_FILE };
    throw e;
  }
  if (text.trim() === "") return { ...EMPTY_POLICY_FILE };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new OrcaError("CONFIG_INVALID", `${file}: ${(e as Error).message}`, {}, { cause: e });
  }
  const parsed = PermissionPolicyFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new OrcaError("CONFIG_INVALID", `${file}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

function releasedPermissionOverlayFor(
  doc: PermissionPolicyFile,
  agentId: string,
  onIgnored?: (rule: PermissionRule) => void,
): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const r of doc.agents[agentId]?.rules ?? []) {
    const rule: PermissionRule = { match: { ...r.match }, decision: r.decision };
    if (isWildcardPermissionRule(rule)) onIgnored?.(rule);
    else rules.push(rule);
  }
  return rules;
}

/** The released session passes `onUnreadable`, so an unreadable file is skipped with later allows capped. */
export async function releasedLoadEffectivePermissionPolicy(
  agent: { id: string; permissions: ConfiguredPermissionPolicy },
  files: readonly string[],
  onUnreadable?: (file: string, error: unknown) => void,
  onIgnored?: (file: string, rule: PermissionRule) => void,
): Promise<PermissionPolicy> {
  const overlays: PermissionRule[][] = [];
  let readable: number | undefined;
  for (const file of files) {
    try {
      const doc = await releasedReadPermissionPolicyFile(file);
      overlays.push(
        releasedPermissionOverlayFor(doc, agent.id, onIgnored ? (rule) => onIgnored(file, rule) : undefined),
      );
    } catch (e) {
      if (!onUnreadable) throw e;
      onUnreadable(file, e);
      readable ??= overlays.reduce((n, overlay) => n + overlay.length, agent.permissions.rules.length);
    }
  }
  const policy = effectivePermissionPolicy(agent.permissions, ...overlays);
  if (readable === undefined) return policy;
  const capFrom = readable;
  const cap = (decision: PermissionDecision): PermissionDecision => (decision === "allow" ? "ask" : decision);
  return {
    default: cap(policy.default),
    rules: policy.rules.map((rule, i) => (i < capFrom ? rule : { ...rule, decision: cap(rule.decision) })),
  };
}

/** Run under the lock by both released writers' replace path before writing. */
export async function releasedRefuseUnsupportedPolicyReplacement(file: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "version" in raw && raw.version !== 1)
    throw new OrcaError("CONFIG_INVALID", `${file}: refusing to replace an unsupported permission document version`);
}
