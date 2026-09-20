/**
 * The control methods: the first four calls on this wire that *write*.
 *
 * Everything before them projected a store somebody else was driving. These make the daemon
 * one of the drivers, which is a real change of role and is why they are gated behind their
 * own capability (`runs.control`) and can be switched off (`orca serve --read-only`). The
 * guard against two writers is the run's single-writer lease, not this table: a run another
 * live process is interpreting refuses here with `RUN_LEASED_ELSEWHERE` and the holder's pid
 * and host, immediately, rather than queueing behind it (ADR 0008, #101).
 *
 * Three shapes worth knowing before the schemas:
 *
 * - **An answer is an option id.** Never a label - a label may be reworded between the ask
 *   and the answer, and what is compared against the options when the run is re-driven is
 *   what was recorded. `OpenInputView.options` carries both (protocol 1.4).
 * - **"Always" is stated, not inferred.** A permission ask answered "allow always" writes a
 *   standing rule into the workspace sidecar (`orca.permissions.json`, ADR 0009), and the
 *   client says which way the rule goes in `always.decision`. ORCA will not read an agent's
 *   own option ids and guess that `allow_always` means allow: those ids are the agent's, a
 *   standing permission grant is the last place to guess, and the result says exactly what
 *   was written so a button can promise it honestly.
 * - **`runs.start` writes no documents.** See its schema.
 */
import { z } from "zod";
// The node-free subpath, not the package root: the renderer bundles this package. See runs.ts.
import { PermissionRuleSchema } from "@orca/core/schemas";
import { RunSummaryViewSchema } from "./runs.js";

export const INPUTS_ANSWER_METHOD = "inputs.answer";
export const RUNS_RESUME_METHOD = "runs.resume";
export const RUNS_CANCEL_METHOD = "runs.cancel";
export const RUNS_START_METHOD = "runs.start";

// ----------------------------------------------------------------- inputs.answer

/**
 * What an "always" answer means, said by the client rather than derived from an option id.
 * `allow` and `deny` are the two rule decisions a sidecar can hold; `ask` is what a rule
 * produces, never what one records.
 */
export const AlwaysDecisionSchema = z.object({ decision: z.enum(["allow", "deny"]) });
export type AlwaysDecision = z.infer<typeof AlwaysDecisionSchema>;

export const InputsAnswerParamsSchema = z.object({
  /** The `OpenInputView.id` being answered. */
  requestId: z.string().min(1),
  /** Narrows the search to one run and its descendants. Optional: an id is unique either way. */
  runId: z.string().min(1).optional(),
  /** An option's `id`. For a free-text question (no options) it is the text. */
  optionId: z.string().min(1),
  /**
   * A free-text note the person added: why this option, not which one. It does not reach the
   * workflow, which branches on the option id alone.
   *
   * It does reach the run's log, as of #238 - `human.answered` carries it beside the answer -
   * so a client may show it as something the run recorded, because it is. This comment used
   * to say the opposite and it is worth keeping the reason: the event payload was
   * `{ stepRunId, requestId, answer }` and had nowhere to put it, so the daemon wrote the
   * note to the *operator's* log. A person who typed their reasoning into a gate had attached
   * it to whichever terminal the daemon was logging to, and to nothing that outlived the run.
   */
  note: z.string().optional(),
  /**
   * Only meaningful on a `permission` ask: also write the standing rule this answer
   * justifies into the workspace sidecar. Absent means answer this one call and nothing more,
   * which is "allow once" / "deny once".
   */
  always: AlwaysDecisionSchema.optional(),
  /**
   * Re-drive the run afterwards, under this daemon's lease, and return once it is parked
   * again or finished. False answers without continuing, which is `orca answer --no-resume`.
   */
  resume: z.boolean().default(true),
});
export type InputsAnswerParams = z.infer<typeof InputsAnswerParamsSchema>;

/**
 * What an `always` answer actually wrote - `recordAlwaysDecision`'s own result, verbatim.
 * `added` is the subset this call appended and `refused` is set when nothing could be
 * derived at all, in which case the answer was honoured once and no rule exists. A client
 * that promises "ORCA will not ask again" must read both before saying so.
 */
export const PermissionRecordViewSchema = z.object({
  /** Absolute path of the sidecar written, so the person can go and read the diff. */
  file: z.string(),
  agentId: z.string(),
  /** Every rule this answer implies, appended now or already there. */
  rules: z.array(PermissionRuleSchema),
  /** The subset this call appended. */
  added: z.array(PermissionRuleSchema),
  /** The subset that was already recorded; the file was not rewritten for them. */
  alreadyPresent: z.array(PermissionRuleSchema),
  /** Set when nothing could be derived: the answer held for this one call only. */
  refused: z.object({ reason: z.string(), detail: z.string() }).optional(),
});
export type PermissionRecordView = z.infer<typeof PermissionRecordViewSchema>;

export const InputsAnswerResultSchema = z.object({
  requestId: z.string(),
  runId: z.string(),
  /** What was recorded in the log - the option id, or the free text. */
  answer: z.string(),
  /** Present exactly when `always` was asked for and the request was a permission ask. */
  permission: PermissionRecordViewSchema.optional(),
  /**
   * The run as it stands now. Present when `resume` was true: the call returns once the run
   * is parked again or finished, so this is a settled status and not a snapshot mid-flight.
   */
  run: RunSummaryViewSchema.optional(),
  asOf: z.string(),
});
export type InputsAnswerResult = z.infer<typeof InputsAnswerResultSchema>;

// ------------------------------------------------------------------ runs.resume

export const RunsResumeParamsSchema = z.object({ runId: z.string().min(1) });
export type RunsResumeParams = z.infer<typeof RunsResumeParamsSchema>;

/**
 * The run once it has stopped again. `runs.resume` re-drives it in this process under the
 * lease and answers when it parks or finishes, so this is never "resuming" - a client that
 * wants the steps in between watches the notification stream while the call is open.
 */
export const RunsResumeResultSchema = z.object({
  run: RunSummaryViewSchema,
  asOf: z.string(),
});
export type RunsResumeResult = z.infer<typeof RunsResumeResultSchema>;

// ------------------------------------------------------------------ runs.cancel

export const RunsCancelParamsSchema = z.object({
  runId: z.string().min(1),
  /** Recorded on `run.cancelled`, and shown wherever the run's ending is explained. */
  reason: z.string().optional(),
});
export type RunsCancelParams = z.infer<typeof RunsCancelParamsSchema>;

export const RunsCancelResultSchema = z.object({
  run: RunSummaryViewSchema,
  asOf: z.string(),
});
export type RunsCancelResult = z.infer<typeof RunsCancelResultSchema>;

// ------------------------------------------------------------------- runs.start

/**
 * `runs.start` - a workflow and its vars, and deliberately nothing else.
 *
 * Submitting a *request* and decomposing it into *work items* is `orca submit`'s job, and it
 * is a job this method must not grow, because starting a run from the app would then write
 * request and work-item documents into a store a CLI beside it is also writing. Those two
 * collections live in `JsonFileDocumentStore`, which holds the whole collection in memory
 * for the life of the process and rewrites it whole: a daemon and a CLI would each keep
 * serving the documents they first read and each clobber the other's on the next write
 * (#196). Run logs are not affected - the event store re-reads them - which is exactly why
 * this method may append `run.created` and may not put a document anywhere.
 *
 * So `requestId` and `workItemId` are accepted and passed through: they are recorded on
 * `run.created` and travel out on the `run.changed` notification, so a client that already
 * knows a work item can start a run against it and find the run again. Neither id is read
 * back from a document store and neither document is created. A run naming itself after a
 * work item the daemon has not got simply falls back to the workflow id, which is the
 * fallback chain `ReadModel` has always had.
 *
 * When #196 is closed - a store watcher, or single-ownership of the document stores - a
 * `requests.submit` method can be added beside this one. Until then, the honest surface is
 * this one.
 */
export const RunsStartParamsSchema = z.object({
  workflowId: z.string().min(1),
  /** Merged over the workflow's own `vars`, exactly as `orca run --var` merges them. */
  vars: z.record(z.string(), z.unknown()).default({}),
  /**
   * Recorded on `run.created` and carried into the `run.changed` notification, so a client
   * that started the run can find it. **No request document is written or read** (#196).
   */
  requestId: z.string().min(1).optional(),
  /** The same, for a work item. No work-item document is written or read. */
  workItemId: z.string().min(1).optional(),
});
export type RunsStartParams = z.infer<typeof RunsStartParamsSchema>;

export const RunsStartResultSchema = z.object({
  runId: z.string(),
  run: RunSummaryViewSchema,
  asOf: z.string(),
});
export type RunsStartResult = z.infer<typeof RunsStartResultSchema>;
