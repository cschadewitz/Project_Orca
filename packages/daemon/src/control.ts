/**
 * The control model: the methods that write without needing a plan, and the one function the
 * CLI and the daemon both answer a gate through.
 *
 * **One implementation of "answer a gate", not two.** `orca answer <requestId> <option>` has
 * always been `Orchestrator.answer()` followed by `Orchestrator.resume()`, in that order,
 * with the second skipped by `--no-resume`. `inputs.answer` is the same two calls, and the
 * moment they were written twice they would drift - one of them would forget that a parent
 * parked on a child resumes from the *parent*, or would resume a run it had failed to
 * answer. So `answerAndResume` below is the whole of both, and the CLI command is now a
 * caller of it rather than a second copy.
 *
 * **The lease is the guard, and it is checked first.** A run another *live* process is
 * interpreting is refused immediately with that holder's pid and host, rather than queued
 * behind it: `Orchestrator.run()` would block on the lease until the other process let go,
 * and a client waiting on an HTTP call has no way to tell that from a hang. Refusing loudly
 * with somewhere to go is the only useful answer.
 *
 * **Every gate parks to the log.** The daemon drives runs with `PausingHumanInput`, so a
 * decision or a question is recorded as `human.requested` and the run is parked; it is not
 * held open in memory waiting for a socket. That is what makes answering survive a daemon
 * restart, and it is why `inputs.answer` is a write to a log and a re-drive rather than the
 * resolution of a promise.
 */
import type { LiveAnswerAuthority, ExecutionResumeAuthority } from "@orca/engine";
import {
  OrcaError,
  isOrcaError,
  type HumanInputRequest,
  type RunState,
  type Clock,
  type MutationActor,
} from "@orca/core";
import { recordAlwaysDecision, type RecordAlwaysResult } from "@orca/agents";
import type { Orchestrator } from "@orca/engine";
import {
  ProtocolFault,
  type ClaimsReleaseParams,
  type ClaimsReleaseResult,
  type ClaimView,
  type ConfigDocument,
  type InputsAnswerParams,
  type InputsAnswerResult,
  type RunsCancelParams,
  type RunsCancelResult,
  type RunsReviewEffectParams,
  type RunsReviewEffectResult,
  type RunsResumeParams,
  type RunsResumeResult,
  type RunsStartParams,
  type RunsStartResult,
  type RunSummaryView,
} from "@orca/protocol";
import { agentSessionsByStep, type ReadModel } from "./read-model.js";

export interface AnswerAndResumeOptions {
  actor?: MutationActor | undefined;
  /** The `HumanInputRequest.id` being answered. */
  requestId: string;
  /** An option's `id`, or the free text for a question that offers none. */
  answer: string;
  /**
   * Free text the person wrote beside the answer, recorded on `human.answered` (#238). The
   * run does not branch on it - `answer` is the whole of the decision - but the log now
   * holds the reasoning next to the choice instead of only in whoever's terminal it was
   * typed into.
   */
  note?: string | undefined;
  /** Narrows the search to one run and its descendants; an id is unique without it. */
  runId?: string | undefined;
  /** Re-drive afterwards and return once the run is parked again or finished. Default true. */
  resume?: boolean | undefined;
  /**
   * How to continue. Defaults to `Orchestrator.resume`; `orca answer` passes
   * `ProgramService.resume`, which additionally mirrors a finished program run onto its
   * Request *document*.
   *
   * That difference used to be a safety rule - a daemon writing documents beside a CLI was
   * exactly #196 - and is now a scope one: the document store re-reads under a lock, so the
   * write would be safe, but mirroring a program run onto a Request is `ProgramService`'s
   * job and the daemon is not running a program. It stays a caller's choice either way.
   */
  resumeWith?: ((runId: string) => Promise<RunState>) | undefined;
  /** Runs under the answer lease after durable acceptance, before any automatic resume. */
  afterAnswer?: ((request: HumanInputRequest, state: RunState) => Promise<void>) | undefined;
}

export interface AnswerAndResumeResult {
  request: HumanInputRequest;
  /** The run once it stopped again. Absent when `resume` was false. */
  state?: RunState | undefined;
}

/**
 * Answer an open human-input request and continue the run - the one implementation, called
 * by `orca answer` and by the daemon's `inputs.answer`.
 *
 * The refusals are classified here rather than left as the engine's one `RUN_STATE`, because
 * a screen has to tell them apart: "somebody answered this a second before you did" hides
 * the card, "that is not an option" is a bug in the client, and "another process holds the
 * lease" is a different machine's problem. `ProtocolFault` carries the codes; a CLI caller
 * that only wants a message reads `.message`, which says the same thing in words.
 */
export async function answerAndResume(orc: Orchestrator, opts: AnswerAndResumeOptions): Promise<AnswerAndResumeResult> {
  const found = await findInput(orc, opts.requestId, opts.runId);
  if (found.request.answer !== undefined || found.request.answeredAt !== undefined)
    throw new ProtocolFault(
      "INPUT_ANSWERED",
      `'${opts.requestId}' was already answered with '${found.request.answer ?? ""}'`,
      { requestId: opts.requestId, runId: found.request.runId, answer: found.request.answer },
    );

  const ids = found.request.options.map((o) => o.id);
  if (ids.length && !ids.includes(opts.answer))
    throw new ProtocolFault("INPUT_OPTION_UNKNOWN", `'${opts.answer}' is not one of: ${ids.join(", ")}`, {
      requestId: opts.requestId,
      runId: found.request.runId,
      options: ids,
    });

  const runId = found.request.runId;
  if (found.request.kind === "permission") {
    const held = (await orc.listLeases()).some((lease) => lease.runId === runId && !lease.lapsed);
    throw new OrcaError("RUN_STATE", "answer a live permission at its owning daemon with its exact identity", {
      liveInputState: held ? "owner-unavailable" : "expired",
    });
  }
  if (found.state.run.status !== "paused")
    throw new ProtocolFault(
      "RUN_NOT_WAITING",
      `run ${runId} is ${found.state.run.status}, not parked: it is not waiting for this answer`,
      { runId, status: found.state.run.status },
    );
  await refuseIfLeasedElsewhere(orc, runId);

  const request = await leased(runId, () =>
    orc.answer(opts.requestId, opts.answer, runId, opts.note, opts.afterAnswer, opts.actor),
  );
  if (opts.resume === false) return { request };
  // `resume` walks up to the topmost parked ancestor and re-attaches on the way down, so a
  // gate answered inside a child continues the tree and not just the child.
  const resume = opts.resumeWith ?? ((id: string) => orc.resume(id));
  return { request, state: await resume(runId) };
}

/**
 * The request and the state of the run holding it. Looked up over every request the run
 * knows rather than only the pending ones, so "already answered" can be told from "never
 * existed" - which is the difference between a stale card and a wrong id.
 */
async function findInput(
  orc: Orchestrator,
  requestId: string,
  runId: string | undefined,
): Promise<{ request: HumanInputRequest; state: RunState }> {
  const ids = runId ? [runId] : await orc.listRuns();
  for (const id of ids) {
    let state: RunState;
    try {
      state = await orc.getState(id);
    } catch (e) {
      // A child a parent still points at, whose own log is gone. One missing log must not
      // take down the lookup for every other run - `pendingInputs` is tolerant the same way.
      if (isOrcaError(e, "RUN_NOT_FOUND")) continue;
      throw e;
    }
    const request = state.humanInputs[requestId];
    if (request) return { request, state };
    if (runId) {
      // Scoped to a run means that run *and its descendants*, the same as `inputs.list`.
      for (const step of Object.values(state.steps)) for (const child of step.childRunIds) ids.push(child);
    }
  }
  throw new OrcaError("RUN_STATE", `no human input '${requestId}' in this store`, { requestId, runId });
}

/**
 * Refuse a write to a run some other live process is interpreting, naming that process.
 *
 * A lapsed lease is not a refusal: its holder stopped heartbeating, so the next `run()`
 * takes it over, which is the whole point of the lease having a ttl. This daemon's own
 * lease is not a refusal either - one orchestrator re-acquires its own lease rather than
 * blocking on it, which is what lets a nested `runChild` work at all.
 */
async function refuseIfLeasedElsewhere(orc: Orchestrator, runId: string): Promise<void> {
  const held = (await orc.listLeases()).find((l) => l.runId === runId);
  if (!held || held.lapsed || held.holder === orc.leaseHolder) return;
  throw new ProtocolFault(
    "RUN_LEASED_ELSEWHERE",
    `run ${runId} is being interpreted by pid ${held.pid} on ${held.host}: do it there, or take the lease with 'orca leases break ${runId} --force'`,
    { runId, holder: held.holder, pid: held.pid, host: held.host, renewedAt: held.renewedAt },
  );
}

/**
 * Run something that drives `runId`, translating the engine's `RUN_LEASED` into the wire's
 * `RUN_LEASED_ELSEWHERE`.
 *
 * `refuseIfLeasedElsewhere` above is a check, and every check of a lease has a race after it:
 * another process can take the lease in the window before the engine takes it, and an operator
 * can take it *away* mid-run (#267). The engine raises `RUN_LEASED` for both, and without this
 * it surfaces as an unclassified INTERNAL fault - the one refusal a client most needs to tell
 * apart, arriving as the one it cannot. `runs.cancel` had this from the start; `runs.start`
 * and `runs.resume` did not, which is the bug this closes.
 */
async function leased<T>(runId: string, drive: () => Promise<T>): Promise<T> {
  try {
    return await drive();
  } catch (e) {
    if (isOrcaError(e, "RUN_LEASED"))
      throw new ProtocolFault("RUN_LEASED_ELSEWHERE", e.message, { runId, ...(e.details ?? {}) });
    throw e;
  }
}

export interface ControlModelOptions {
  orchestrator: Orchestrator;
  /** The projection the results are rendered from; control answers in the read model's shapes. */
  reads: ReadModel;
  /**
   * The permission sidecar an "always" answer appends to
   * (`permissionPolicyPath(configDir)`). Without it, `inputs.answer` refuses `always`
   * rather than honouring the answer once and quietly recording no rule.
   */
  permissionsFile?: string | undefined;
  /**
   * Where an "always" answer's sidecar write is announced (#266). `recordAlwaysDecision`
   * knows nothing about subscriptions, so the push is made here: a config screen watching
   * the sidecar has to see ORCA's own writes and not only the operator's, or it shows a
   * policy that was true a moment ago. `ConfigModel` is what satisfies this.
   */
  config?: ConfigAnnouncer | undefined;
  /** Defaults to the orchestrator's own clock, so a test can pin every `asOf`. */
  clock?: Clock | undefined;
}

/** The half of `ConfigModel` the control model needs: "that document moved, tell the clients". */
export interface ConfigAnnouncer {
  announce(document: ConfigDocument): Promise<void>;
}

/**
 * The five writing methods that need no plan, over one orchestrator holding one lease per run.
 * Four drive a run; `claims.release` takes a work item back from one.
 */
export class ControlModel {
  get executionOrchestrator() {
    return this.orc;
  }
  private readonly orc: Orchestrator;
  private readonly reads: ReadModel;
  private readonly permissionsFile: string | undefined;
  private readonly config: ConfigAnnouncer | undefined;
  private readonly clock: Clock;

  constructor(opts: ControlModelOptions) {
    this.orc = opts.orchestrator;
    this.reads = opts.reads;
    this.permissionsFile = opts.permissionsFile;
    this.config = opts.config;
    this.clock = opts.clock ?? opts.orchestrator.clock;
  }

  get supportsLiveInputs(): boolean {
    return this.orc.liveInput !== undefined;
  }

  /**
   * `inputs.answer`: record the answer and continue the run.
   *
   * `always` additionally appends the standing rule the answer justifies to the workspace
   * permission sidecar (ADR 0009), and the result carries `recordAlwaysDecision`'s own
   * `added` / `alreadyPresent` / `refused` verbatim - a button that promises "ORCA will not
   * ask again" has to be able to check whether that is true, and `refused` is the case where
   * it is not: nothing generalised, so the answer held for this one call.
   */
  async answerInput(
    params: InputsAnswerParams,
    actor?: MutationActor,
    authority?: LiveAnswerAuthority,
    expected?: { runId: string; requestId: string; stepRunId: string; kind: "decision" | "permission" },
  ): Promise<InputsAnswerResult> {
    const candidate = await findInput(this.orc, params.requestId, params.runId);
    if (
      expected &&
      (candidate.request.runId !== expected.runId ||
        candidate.request.id !== expected.requestId ||
        candidate.request.stepRunId !== expected.stepRunId ||
        candidate.request.kind !== expected.kind)
    )
      throw new OrcaError("RUN_STATE", "The exact decision is no longer available");
    if (candidate.request.kind === "permission") {
      return this.answerLive(params, candidate.request, candidate.state, authority);
    }
    if (params.live) throw new OrcaError("RUN_STATE", "a durable gate has no live callback");
    let permission: RecordAlwaysResult | undefined;
    // Resolve the standing grant without writing; invalid grant prerequisites must not
    // consume even the one-time answer. The engine rechecks the exact gate under its lease.
    if (params.always) {
      const found = await findInput(this.orc, params.requestId, params.runId);
      await this.prepareAlways(params, found.request, found.state);
    }
    const { request, state } = await answerAndResume(this.orc, {
      actor,
      requestId: params.requestId,
      answer: params.optionId,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.note ? { note: params.note } : {}),
      resume: params.resume,
      resumeWith: async (runId) => {
        try {
          return this.orc.liveInput?.withResumeAuthority
            ? await this.orc.liveInput.withResumeAuthority(runId, undefined, () => this.orc.resume(runId))
            : await this.orc.resume(runId);
        } catch (error) {
          if (isOrcaError(error, "RUN_STATE") && error.details?.executionResumeRequired)
            throw new OrcaError(
              "RUN_STATE",
              "answer recorded; resume the run explicitly with current launch authority",
              {
                ...error.details,
                runId,
                requestId: params.requestId,
                answerRecorded: true,
              },
            );
          throw error;
        }
      },
      ...(params.always
        ? {
            afterAnswer: async (request: HumanInputRequest, state: RunState) => {
              try {
                permission = await recordAlwaysDecision(await this.prepareAlways(params, request, state));
              } catch {
                throw new OrcaError(
                  "INTERNAL",
                  "the one-time answer was recorded, but its standing permission could not be saved; the run remains paused",
                  { runId: request.runId, requestId: request.id, answerRecorded: true },
                );
              }
              if (permission.added.length > 0) await this.config?.announce("permissions");
            },
          }
        : {}),
    });
    return {
      requestId: request.id,
      runId: request.runId,
      answer: request.answer ?? params.optionId,
      ...(permission ? { permission } : {}),
      ...(state ? { run: await this.runView(request.runId) } : {}),
      asOf: this.clock.isoNow(),
    };
  }

  private async answerLive(
    params: InputsAnswerParams,
    request: HumanInputRequest,
    state: RunState,
    authority?: LiveAnswerAuthority,
  ): Promise<InputsAnswerResult> {
    if (!authority) throw new OrcaError("NOT_SUPPORTED", "live answers require current server-bound authority");
    if (
      !params.live ||
      params.live.runId !== request.runId ||
      params.live.stepRunId !== request.stepRunId ||
      params.live.requestId !== request.id
    )
      throw new OrcaError("RUN_STATE", "the exact live decision identity is required");
    await authority.authorize(params.live, Boolean(params.always));
    if (!this.orc.liveInput) {
      const held = (await this.orc.listLeases()).find((lease) => lease.runId === request.runId && !lease.lapsed);
      throw new OrcaError("RUN_STATE", "live permission callback cannot be delivered here", {
        liveInputState: held ? "owner-unavailable" : "expired",
      });
    }
    if (!params.resume)
      throw new OrcaError("NOT_SUPPORTED", "a live answer delivers to the original turn; no-resume is not supported");
    const always = params.always ? await this.prepareAlways(params, request, state) : undefined;
    let permission: RecordAlwaysResult | undefined;
    await this.orc.liveInput.port.answer(
      {
        target: params.live,
        optionId: params.optionId,
        ...(params.note ? { note: params.note } : {}),
        standing: Boolean(always),
      },
      authority,
      always
        ? async () => {
            permission = await recordAlwaysDecision(always);
            if (permission.added.length) await this.config?.announce("permissions");
          }
        : undefined,
    );
    return {
      requestId: request.id,
      runId: request.runId,
      answer: params.optionId,
      ...(permission ? { permission } : {}),
      run: await this.runView(request.runId),
      asOf: this.clock.isoNow(),
    };
  }

  /**
   * `runs.resume`: re-drive a parked run here, under this daemon's lease, until it stops again.
   *
   * `refuseIfLeasedElsewhere` is the fast refusal with a pid in it; `leased()` is the one that
   * catches the race it cannot close. The lease can be taken between that check and the
   * engine's own, and it can be taken *away* while the run is being driven, and both come back
   * as an engine `RUN_LEASED` that a screen cannot branch on until it is a `ProtocolFault`.
   */
  async resumeRun(params: RunsResumeParams, authority?: ExecutionResumeAuthority): Promise<RunsResumeResult> {
    const state = await this.orc.getState(params.runId);
    if (isFinished(state))
      throw new ProtocolFault("RUN_NOT_WAITING", `run ${params.runId} is ${state.run.status}: it has finished`, {
        runId: params.runId,
        status: state.run.status,
      });
    await refuseIfLeasedElsewhere(this.orc, params.runId);
    await leased(params.runId, () =>
      this.orc.liveInput?.withResumeAuthority
        ? this.orc.liveInput.withResumeAuthority(params.runId, authority, () => this.orc.resume(params.runId))
        : this.orc.resume(params.runId),
    );
    return { run: await this.runView(params.runId), asOf: this.clock.isoNow() };
  }

  /**
   * `runs.cancel`: close the run and everything under it.
   *
   * `Orchestrator.cancel` takes the lease itself before it appends - cancelling a run is
   * still writing to its log - so the check here is only about refusing *fast* and with the
   * holder's pid, rather than raising the engine's `RUN_LEASED` with a message a screen
   * cannot branch on.
   */
  async cancelRun(params: RunsCancelParams, actor?: MutationActor): Promise<RunsCancelResult> {
    await refuseIfLeasedElsewhere(this.orc, params.runId);
    await leased(params.runId, () => this.orc.cancel(params.runId, params.reason, actor));
    return { run: await this.runView(params.runId), asOf: this.clock.isoNow() };
  }

  /**
   * `runs.reviewEffect` (#357): record an operator's review of a step attempt that may have
   * acted outside ORCA and never finished. The engine takes the run's lease and appends one
   * `step.effect.reviewed`; `abandon` also ends the run there. It drives nothing: resuming or
   * starting a checkpoint attempt is a separate call.
   */
  async reviewEffect(params: RunsReviewEffectParams, actor?: MutationActor): Promise<RunsReviewEffectResult> {
    await refuseIfLeasedElsewhere(this.orc, params.runId);
    await leased(params.runId, () =>
      this.orc.reviewEffect(params.runId, params.stepRunId, params.decision, {
        ...(actor ? { actor } : {}),
        ...(params.note ? { note: params.note } : {}),
      }),
    );
    return { run: await this.runView(params.runId), asOf: this.clock.isoNow() };
  }

  /**
   * `runs.start`: create a run and drive it here until it parks or finishes.
   *
   * A workflow and its vars, with optional existing Request/work-item associations checked
   * by the orchestrator before admission. It never creates a Request; requests.submit is
   * the separate application service for decomposition/program admission.
   */
  async settleAdmitted(runId: string): Promise<RunsStartResult> {
    const state = await this.orc.getState(runId);
    if (state.run.status === "created" || state.run.status === "running")
      await leased(runId, () => this.orc.run(runId));
    return { runId, run: await this.runView(runId), asOf: this.clock.isoNow() };
  }

  async startRun(
    params: RunsStartParams,
    attributeStartedRun?: (runId: string) => void | Promise<void>,
    actor?: MutationActor,
  ): Promise<RunsStartResult> {
    const release = this.orc.runtimeActivity?.enter("dispatch", true);
    try {
      const captured = await this.orc.generations?.captureLaunch({
        purpose: "workflow",
        workflowId: params.workflowId,
        ...(params.workflowVersion ? { workflowVersion: params.workflowVersion } : {}),
        ...(params.expectedWorkflowRevision ? { expectedWorkflowRevision: params.expectedWorkflowRevision } : {}),
        ...(params.expectedConfigGeneration ? { expectedConfigGeneration: params.expectedConfigGeneration } : {}),
      });
      if (params.expectedConfigGeneration && !captured)
        throw new OrcaError("NOT_SUPPORTED", "configuration generations are unavailable");
      const start = captured ? captured.startRun.bind(captured) : this.orc.startRun.bind(this.orc);
      const runId = await start({
        ...(actor ? { actor } : {}),
        workflowId: params.workflowId,
        vars: params.vars,
        ...(params.workflowVersion ? { workflowVersion: params.workflowVersion } : {}),
        ...(params.expectedWorkflowRevision ? { expectedWorkflowRevision: params.expectedWorkflowRevision } : {}),
        ...(params.requestId ? { requestId: params.requestId } : {}),
        ...(params.workItemId ? { workItemId: params.workItemId } : {}),
      });
      // Persist the exact call/run ownership before execution can emit agent or child events.
      await attributeStartedRun?.(runId);
      // A run this daemon has just created cannot be leased by anyone else *yet*, but it can be
      // by the time `run` reaches `execute`, and the lease can be taken away mid-run (#267).
      // Either way the engine raises `RUN_LEASED`, and an unmapped one reaches the client as an
      // INTERNAL fault with no run id on it.
      await leased(runId, () => this.orc.run(runId));
      return { runId, run: await this.runView(runId), asOf: this.clock.isoNow() };
    } finally {
      release?.();
    }
  }

  /**
   * `claims.release`: take a work item away from the run that claimed it (#88).
   *
   * It lives with the run controls rather than with the plan writes, because `handshake.ts`
   * puts it in `CONTROL_METHODS` and because it needs nothing from `PlanService`: it is
   * `Orchestrator.releaseClaim`, a compare-and-delete against the claim store, plus the run
   * projection's `ClaimView`. A control daemon over a store with no plan in it answers it,
   * which is what advertising `runs.control` promises.
   *
   * `Orchestrator.releaseClaim` is the whole of the rule - it refuses while the owner could
   * still resume unless `force`, and it compares and deletes against the incumbent it
   * inspected, so a claim another run took in the meantime survives. What is added here is
   * the `ClaimView` the wire speaks and the note `orca claims release` prints: the claim
   * decides who may *launch* the item, and an item left `in-progress` by a dead run's log is
   * still treated as running by the scheduler until that status changes.
   */
  async releaseClaim(params: ClaimsReleaseParams): Promise<ClaimsReleaseResult> {
    const asOf = this.clock.isoNow();
    // The claim as `claims.list` would have shown it, taken before the release, because
    // afterwards there is no claim to project.
    const before = await this.reads.claimsList({ workItemId: params.workItemId });
    const released = await this.orc.releaseClaim(params.workItemId, { force: params.force });
    const claim: ClaimView = before.claims[0] ?? {
      workItemId: released.workItemId,
      branch: released.branch,
      claimedAt: released.at,
      owner: { runId: released.runId, status: "stale", missing: true, releasable: true },
      ...(released.stepRunId ? { stepRunId: released.stepRunId } : {}),
    };
    const item = await this.orc.stores.workItems.get(params.workItemId);
    const note =
      item?.status === "in-progress"
        ? `${params.workItemId} is still in-progress${item.runId ? ` (run ${item.runId})` : ""}; the plan scheduler treats it as running until that status changes`
        : undefined;
    return { claim, ...(note ? { note } : {}), asOf };
  }

  // ------------------------------------------------------------------ pieces

  /** Results speak the read model's shapes, so a client folds one status vocabulary, not two. */
  private async runView(runId: string): Promise<RunSummaryView> {
    return (await this.reads.runsGet({ runId })).run;
  }

  /** Prepare a grant without touching the sidecar; persist only after exact gate acceptance. */
  private async prepareAlways(
    params: InputsAnswerParams,
    request: HumanInputRequest,
    state: RunState,
  ): Promise<Parameters<typeof recordAlwaysDecision>[0]> {
    if (!this.permissionsFile)
      throw new OrcaError(
        "NOT_SUPPORTED",
        "this daemon serves no workspace configuration: there is nowhere to record a standing permission",
        { requestId: params.requestId },
      );
    if (request.kind !== "permission")
      throw new OrcaError("NOT_SUPPORTED", `'${params.requestId}' is a ${request.kind}, not a permission ask`, {
        requestId: params.requestId,
        kind: request.kind,
      });
    // Which way the standing rule goes is the client's to state (#160), but the one-time
    // answer has to go the same way: an "always deny" sent with an allow option would let this
    // call through while forbidding the next ones. Where the ask marks its rejections
    // (`destructive`, from ACP's option kinds), the two must agree. An ask recorded before
    // options carried the mark cannot be checked and is taken as stated.
    const chosen = request.options.find((option) => option.id === params.optionId);
    const marked = request.options.some((option) => option.destructive === true);
    const decision = params.always!.decision;
    if (decision === "allow" ? chosen?.destructive === true : marked && chosen?.destructive !== true)
      throw new OrcaError(
        "NOT_SUPPORTED",
        `an "always ${decision}" must answer with ${decision === "deny" ? "a deny" : "an allow"} option; '${params.optionId}' goes the other way`,
        { requestId: params.requestId, optionId: params.optionId },
      );
    const toolCall = request.context["toolCall"];
    if (!toolCall || typeof toolCall !== "object")
      throw new OrcaError(
        "NOT_SUPPORTED",
        `'${params.requestId}' recorded no tool call: there is nothing to derive a rule from`,
        { requestId: params.requestId },
      );
    // `derivePermissionRules` reads the tool call and nothing else off the request, so the
    // session id and the options it never looks at are not worth reconstructing from a log.
    const asRequest = { sessionId: "", toolCall, options: [] } as unknown as Parameters<
      typeof recordAlwaysDecision
    >[0]["request"];
    // A lifetime is a duration from now on the daemon's own clock (#702): the client's clock
    // never decides when a grant ends. Stamped here, before the answer is accepted, so the
    // rule cannot outlive what the person chose by however long acceptance took.
    const durationMs = params.always!.durationMs;
    return {
      file: this.permissionsFile,
      agentId: await this.agentForStep(request.runId, request.stepRunId),
      request: asRequest,
      decision: params.always!.decision,
      workspaceCwd: state.run.workspace.cwd,
      ...(durationMs === undefined
        ? {}
        : {
            expiresAt: new Date(this.clock.now() + durationMs).toISOString(),
            // The same clock stamps `addedAt` and judges "not after now", so the two agree.
            now: () => new Date(this.clock.now()),
          }),
    };
  }

  /**
   * Which agent asked. `agent.session.opened` is the only event that records it, and a
   * permission ask always has one: an `ask` reaches a person only through a live session.
   *
   * The scan itself is `agentSessionsByStep` in the read model, shared with `inputs.list`,
   * which needs the same answer to say who is blocked (#248). A standing rule written here
   * has to belong to the agent the card named, and one scan is how that stays true.
   */
  private async agentForStep(runId: string, stepRunId: string): Promise<string> {
    const session = (await agentSessionsByStep(this.orc, runId)).get(stepRunId);
    if (!session)
      throw new OrcaError("AGENT_NOT_FOUND", `no agent session recorded for step ${stepRunId}`, { runId, stepRunId });
    return session.agentId;
  }
}

function isFinished(state: RunState): boolean {
  const s = state.run.status;
  return s === "completed" || s === "failed" || s === "cancelled";
}
