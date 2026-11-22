/**
 * `orca recovery <runId> [--checkpoint <nodeId>] [--json]` - what recovering a run would do,
 * before anything does it (#357, phase 1).
 *
 * Read-only: it takes no lease and writes nothing. It lists Resume, New run and Checkpoint
 * attempt with why each is or is not available, the steps whose effects are uncertain, and for
 * each completed step of a failed run which steps a checkpoint attempt would reuse and which
 * ran after it last time. Executing a checkpoint attempt is not offered yet.
 */
import {
  OrcaError,
  RECOVERY_BLOCKER_TEXT,
  type RecoveryAssessment,
  type RecoveryCheckpoint,
  type RecoveryOption,
  type RecoveryStep,
} from "@orca/core";
import { previewRecovery } from "@orca/engine";
import { bootstrap } from "../bootstrap.js";
import type { CommandContext } from "./index.js";

export async function recoveryCommand(ctx: CommandContext): Promise<number> {
  const runId = ctx.positionals[0];
  if (!runId) throw new OrcaError("CONFIG_INVALID", "recovery needs a run id");
  const app = await bootstrap({
    cwd: ctx.cwd,
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    logLevel: "warn",
  });
  const orchestrator = app.orchestrator;
  const summary = await orchestrator.getSummary(runId);
  const currentWorkflowVersion = await orchestrator
    .selectDefinition(summary.workflowId)
    .then((definition) => definition.version)
    .catch(() => undefined);
  const assessment = await previewRecovery(orchestrator.stores, runId, {
    currentWorkflowVersion,
    currentConfigGeneration: orchestrator.generations?.current.snapshot.id,
  });
  const only = typeof ctx.flags.checkpoint === "string" ? ctx.flags.checkpoint : undefined;
  if (only !== undefined && !assessment.checkpoints.some((c) => c.nodeId === only))
    throw new OrcaError("CONFIG_INVALID", `run ${runId} has no completed step '${only}' to recover from`);
  if (ctx.flags.json) {
    const shown = only
      ? { ...assessment, checkpoints: assessment.checkpoints.filter((c) => c.nodeId === only) }
      : assessment;
    ctx.out(JSON.stringify(shown, null, 2));
    return 0;
  }
  for (const line of formatRecovery(assessment, only)) ctx.out(line);
  return 0;
}

const KIND_LABEL: Record<RecoveryOption["kind"], string> = {
  resume: "Resume",
  "new-run": "New run",
  "checkpoint-attempt": "Checkpoint attempt",
};
const EFFECT_LABEL: Record<RecoveryStep["effect"], string> = {
  uncertain: "uncertain: started and did not complete; it may have changed the workspace or external systems",
  repeats: "runs again; its earlier changes stay",
  reused: "reused",
  "not-started": "never started",
};

function step(s: RecoveryStep): string {
  const who = s.agent ? ` (agent ${s.agent})` : "";
  const asks = s.asksAgain ? "; asks a person again" : "";
  const missing = s.missingArtifactIds.length ? `; missing artifacts: ${s.missingArtifactIds.join(", ")}` : "";
  return `${s.nodeId} attempt ${s.attempt}${who}: ${EFFECT_LABEL[s.effect]}${asks}${missing}`;
}

export function formatRecovery(a: RecoveryAssessment, only?: string): string[] {
  const out = [`Recovery for run ${a.runId} (${a.workflowId}@${a.workflowVersion}, ${a.status})`, ""];
  for (const option of a.options) {
    const target = option.targetRunId ? ` (re-drives ${option.targetRunId})` : "";
    out.push(`${KIND_LABEL[option.kind]}: ${option.available ? "available" : "not available"}${target}`);
    for (const blocker of option.blockers) out.push(`  - ${RECOVERY_BLOCKER_TEXT[blocker]}`);
    if (option.kind !== "new-run") for (const s of option.runsAgain) out.push(`  ${step(s)}`);
  }
  if (a.uncertain.length) {
    out.push("", "Review before anything runs these again:");
    for (const s of a.uncertain) out.push(`  ${step(s)}`);
  }
  if (a.drift) {
    out.push("");
    if (a.drift.currentWorkflowVersion)
      out.push(
        `The workflow is now at ${a.drift.currentWorkflowVersion}; recovery from history uses ${a.workflowVersion}.`,
      );
    if (a.drift.currentConfigGeneration)
      out.push(
        `Configuration has changed since this run (${a.drift.recordedConfigGeneration} -> ${a.drift.currentConfigGeneration}); agents may resolve differently.`,
      );
  }
  const checkpoints = only ? a.checkpoints.filter((c) => c.nodeId === only) : a.checkpoints;
  if (checkpoints.length) out.push("", "Checkpoints:");
  for (const c of checkpoints) out.push(...checkpoint(c, Boolean(only)));
  out.push("", "Nothing was changed. Approvals and permissions are never carried forward to steps that run again.");
  return out;
}

function checkpoint(c: RecoveryCheckpoint, detail: boolean): string[] {
  const lines = [`  after ${c.nodeId}: ${c.eligible ? "eligible" : "not eligible"}`];
  for (const blocker of c.blockers) lines.push(`    - ${RECOVERY_BLOCKER_TEXT[blocker]}`);
  if (!detail) return lines;
  lines.push("    Reuses:");
  for (const s of c.reused) lines.push(`      ${step(s)}`);
  lines.push(c.ranAfter.length ? "    Ran after it last time (routing is re-evaluated):" : "    Nothing ran after it.");
  for (const s of c.ranAfter) lines.push(`      ${step(s)}`);
  return lines;
}
