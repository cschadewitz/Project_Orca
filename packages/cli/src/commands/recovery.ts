/**
 * `orca recovery <runId> [--checkpoint <stepRunId|nodeId>] [--json]` - what recovering a run would do,
 * before anything does it (#357, phase 1).
 *
 * `orca recovery review <runId> <stepRunId> --run-again|--abandon [--note text]` - record an
 * operator's side-effect review of a step that may have acted and never finished (#357, phase 2).
 * Until one is recorded, resume refuses to run that step again.
 *
 * `orca recovery start <runId> [--checkpoint <stepRunId|nodeId>] [--idempotency-key k]` - start a
 * checkpoint attempt of a failed run and follow it, as `orca run` does (#357, phase 2).
 *
 * `orca recovery retire <runId> <attemptRunId>` - retire a checkpoint attempt that was reserved
 * and never created (an interrupted admission), so another attempt of the run may start.
 *
 * The preview is read-only: it takes no lease and writes nothing. It lists Resume, New run and
 * Checkpoint attempt with why each is or is not available, the steps whose effects are
 * uncertain, and for each completed step of a failed run which steps a checkpoint attempt would
 * reuse and which ran after it last time.
 */
import {
  consoleLogger,
  loadWorkflows,
  OrcaError,
  RECOVERY_BLOCKER_TEXT,
  RECOVERY_UNVERIFIED_TEXT,
  type RecoveryAssessment,
  type RecoveryCheckpoint,
  type RecoveryOption,
  type RecoveryStep,
} from "@orca/core";
import { resolve } from "node:path";
import { INLINE_SEP, previewRecovery, type CheckpointAdmissionAuthority } from "@orca/engine";
import { enterStoreFormat, fileStores } from "@orca/store";
import { bootstrap, loadConfig, releaseAssets } from "../bootstrap.js";
import { attachEventPrinter, finish, type CommandContext } from "./index.js";
import { admissionRetryOptions } from "./admission-retry.js";
import { localDirectAdmissionAuthority } from "../local-submission-authority.js";

export async function recoveryCommand(ctx: CommandContext): Promise<number> {
  if (ctx.positionals[0] === "review") return reviewCommand(ctx);
  if (ctx.positionals[0] === "start") return startCommand(ctx);
  if (ctx.positionals[0] === "retire") return retireCommand(ctx);
  const runId = ctx.positionals[0];
  if (!runId) throw new OrcaError("CONFIG_INVALID", "recovery needs a run id");
  const checkpoint = typeof ctx.flags.checkpoint === "string" ? ctx.flags.checkpoint : undefined;
  // The checkpoint is chosen once, in the assessment, so the option's readiness and repeat list
  // and the detail below describe the same step attempt.
  const assessment = await readRecovery(ctx.cwd, ctx.configPath, runId, checkpoint);
  if (ctx.flags.json) {
    ctx.out(JSON.stringify(assessment, null, 2));
    return 0;
  }
  for (const line of formatRecovery(assessment, checkpoint !== undefined)) ctx.out(line);
  return 0;
}

/**
 * Start a checkpoint attempt and follow it. With a retry claim store (any persistent store), it
 * goes through retry-safe admission: the printed retry key, given again, returns the same
 * attempt rather than starting another. A run that recorded no configuration generation has
 * nothing to pin an admission to and is started directly.
 */
async function startCommand(ctx: CommandContext): Promise<number> {
  const runId = ctx.positionals[1];
  if (!runId) throw new OrcaError("CONFIG_INVALID", "recovery start needs a run id");
  const checkpoint = typeof ctx.flags.checkpoint === "string" ? ctx.flags.checkpoint : undefined;
  const key = typeof ctx.flags["idempotency-key"] === "string" ? ctx.flags["idempotency-key"] : undefined;
  const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
  const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
  try {
    const source = await app.orchestrator.getSummary(runId);
    let attemptId: string;
    if (app.checkpointAdmissions && source.provenance) {
      const retry = admissionRetryOptions(key);
      if (key === undefined) ctx.err(`Retry key: ${retry.idempotencyKey}`);
      const direct = await localDirectAdmissionAuthority(app);
      // Starting an attempt starts a run of the source's workflow.
      const authority: CheckpointAdmissionAuthority = {
        ...direct,
        authorize: () => direct.authorize({ workflowId: source.workflowId }),
      };
      let response = await app.checkpointAdmissions.startAttempt(
        { runId, ...(checkpoint ? { checkpoint } : {}) },
        retry,
        authority,
      );
      // An interrupted admission is reconciled here, once: it creates its own reserved attempt.
      if (response.state === "resolved" && response.result.state === "recoverable-failure")
        response = await app.checkpointAdmissions.reconcile(response.operationId, authority);
      if (response.state !== "resolved" || response.result.state !== "accepted") {
        const reserved = response.state === "resolved" ? response.result.runId : undefined;
        throw new OrcaError(
          "RUN_STATE",
          `Checkpoint admission requires reconciliation${
            reserved
              ? `; if attempt ${reserved} should never start, retire it with 'orca recovery retire ${runId} ${reserved}'`
              : ""
          }`,
          { ...response },
        );
      }
      attemptId = response.result.runId;
    } else {
      if (key !== undefined)
        throw new OrcaError("NOT_SUPPORTED", "this store has no retry claims, so --idempotency-key cannot be honoured");
      attemptId = await app.orchestrator.startCheckpointAttempt({ runId, ...(checkpoint ? { checkpoint } : {}) });
    }
    ctx.err(`Checkpoint attempt ${attemptId} of ${runId}`);
    return await finish(app, ctx, await app.orchestrator.run(attemptId));
  } finally {
    detach();
  }
}

/**
 * Retire the source's latest checkpoint attempt when it was reserved and never created, so its
 * admission can never create it and another attempt may start. A created attempt is refused.
 */
async function retireCommand(ctx: CommandContext): Promise<number> {
  const [, runId, attemptRunId] = ctx.positionals;
  if (!runId || !attemptRunId)
    throw new OrcaError("CONFIG_INVALID", "recovery retire needs a run id and the reserved attempt's run id");
  const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
  await app.orchestrator.retireCheckpointReservation(runId, attemptRunId);
  ctx.out(`Retired checkpoint attempt ${attemptRunId} of ${runId}: it will never be created.`);
  return 0;
}

/** A writing subcommand: it takes the run's lease, appends the review, and nothing else. */
async function reviewCommand(ctx: CommandContext): Promise<number> {
  const [, runId, stepRunId] = ctx.positionals;
  const runAgain = Boolean(ctx.flags["run-again"]);
  const abandon = Boolean(ctx.flags.abandon);
  if (!runId || !stepRunId || runAgain === abandon)
    throw new OrcaError(
      "CONFIG_INVALID",
      "recovery review needs a run id, a step run id and exactly one of --run-again or --abandon",
    );
  const note = typeof ctx.flags.note === "string" ? ctx.flags.note : undefined;
  const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
  const state = await app.orchestrator.reviewEffect(runId, stepRunId, runAgain ? "run-again" : "abandon", {
    ...(note ? { note } : {}),
  });
  if (ctx.flags.json) {
    ctx.out(
      JSON.stringify({ runId, stepRunId, review: state.steps[stepRunId]?.effectReview, status: state.run.status }),
    );
    return 0;
  }
  ctx.out(
    runAgain
      ? `Reviewed ${stepRunId}: it may run again. 'orca resume ${runId}' attempts it again; its earlier changes stay.`
      : `Reviewed ${stepRunId}: abandoned. Run ${runId} is ${state.run.status}; nothing runs that step again.`,
  );
  return 0;
}

/**
 * A reader-only composition, not `bootstrap`: no writer claim, no store-format stamp, no plugin
 * loading and no configuration generation. It reads the config file, checks the store format in
 * read mode, opens the file stores and reads; the workflow files are parsed only to say which
 * version a new run would use now. Configuration drift needs a generation, which only a writer
 * records, so this path does not report it.
 */
export async function readRecovery(
  cwd: string,
  configPath: string | undefined,
  runId: string,
  checkpoint?: string,
): Promise<RecoveryAssessment> {
  const { config, configDir } = await loadConfig(cwd, configPath);
  const storeDir = resolve(configDir, config.storeDir);
  await enterStoreFormat(storeDir, { appVersion: "recovery-preview", mode: "read" });
  const stores = fileStores(storeDir, undefined, consoleLogger("error"));
  const summary = await stores.events.readRange(runId, { limit: 1 });
  const first = summary[0];
  if (!first) throw new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`);
  const rootId = first.type === "run.created" ? first.payload.workflowId.split(INLINE_SEP)[0]! : undefined;
  const currentWorkflowVersion = rootId
    ? await releaseAssets(config)
        .then((assets) => loadWorkflows(assets.workflows, configDir))
        .then((workflows) => (workflows.has(rootId) ? workflows.get(rootId).version : undefined))
        .catch(() => undefined)
    : undefined;
  return previewRecovery(stores, runId, { currentWorkflowVersion, checkpoint });
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
  restarts: "did not complete; it acts only inside ORCA and starts again",
  reviewed: "did not complete and may have acted; reviewed and marked to run again",
};

const READINESS_LABEL: Record<RecoveryOption["readiness"], string> = {
  available: "available",
  unverified: "not blocked, but unverified",
  blocked: "not available",
};

function step(s: RecoveryStep): string {
  const who = s.agent ? ` (agent ${s.agent})` : "";
  const asks = s.asksAgain
    ? "; asks a person again"
    : s.answerCarried
      ? "; continues with the answer this run already recorded"
      : "";
  const missing = s.missingArtifactIds.length ? `; missing artifacts: ${s.missingArtifactIds.join(", ")}` : "";
  return `${s.nodeId} attempt ${s.attempt}${who}: ${EFFECT_LABEL[s.effect]}${asks}${missing}`;
}

export function formatRecovery(a: RecoveryAssessment, selected = false): string[] {
  const out = [`Recovery for run ${a.runId} (${a.workflowId}@${a.workflowVersion}, ${a.status})`, ""];
  for (const option of a.options) {
    const target = option.targetRunId ? ` (re-drives ${option.targetRunId})` : "";
    const at = option.checkpointStepRunId
      ? ` (after ${a.checkpoints.find((c) => c.stepRunId === option.checkpointStepRunId)?.nodeId} ${option.checkpointStepRunId})`
      : "";
    out.push(`${KIND_LABEL[option.kind]}: ${READINESS_LABEL[option.readiness]}${target}${at}`);
    for (const blocker of option.blockers) out.push(`  - ${RECOVERY_BLOCKER_TEXT[blocker]}`);
    for (const reason of option.unverified) out.push(`  ? ${RECOVERY_UNVERIFIED_TEXT[reason]}`);
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
  const chosen = a.options.find((o) => o.kind === "checkpoint-attempt")?.checkpointStepRunId;
  const checkpoints = selected ? a.checkpoints.filter((c) => c.stepRunId === chosen) : a.checkpoints;
  if (checkpoints.length) out.push("", "Checkpoints:");
  for (const c of checkpoints) out.push(...checkpoint(c, selected));
  out.push(
    "",
    "Nothing was changed. A new run or checkpoint attempt asks every person again; resume continues with the answers this run already recorded.",
  );
  return out;
}

function checkpoint(c: RecoveryCheckpoint, detail: boolean): string[] {
  const lines = [`  after ${c.nodeId} attempt ${c.attempt} (${c.stepRunId}): ${READINESS_LABEL[c.readiness]}`];
  for (const blocker of c.blockers) lines.push(`    - ${RECOVERY_BLOCKER_TEXT[blocker]}`);
  for (const reason of c.unverified) lines.push(`    ? ${RECOVERY_UNVERIFIED_TEXT[reason]}`);
  if (!detail) return lines;
  lines.push("    Reuses:");
  for (const s of c.reused) lines.push(`      ${step(s)}`);
  lines.push(c.ranAfter.length ? "    Ran after it last time (routing is re-evaluated):" : "    Nothing ran after it.");
  for (const s of c.ranAfter) lines.push(`      ${step(s)}`);
  return lines;
}
