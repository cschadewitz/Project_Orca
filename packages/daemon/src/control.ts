/**
 * The control model: the four methods that write, and the one function the CLI and the
 * daemon both answer a gate through.
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
import { OrcaError, isOrcaError, type HumanInputRequest, type RunState, type Clock } from "@orca/core";
import { recordAlwaysDecision, type RecordAlwaysResult } from "@orca/agents";
import type { Orchestrator } from "@orca/engine";
import {
  ProtocolFault,
  type InputsAnswerParams,
  type InputsAnswerResult,
  type RunsCancelParams,
  type RunsCancelResult,
  type RunsResumeParams,
  type RunsResumeResult,
  type RunsStartParams,
  type RunsStartResult,
  type RunSummaryView,
} from "@orca/protocol";
import type { ReadModel } from "./read-model.js";

export interface AnswerAndResumeOptions {
  /** The `HumanInputRequest.id` being answered. */
  requestId: string;
  /** An option's `id`, or the free text for a question that offers none. */
  answer: string;
  /** Narrows the search to one run and its descendants; an id is unique without it. */
  runId?: string | undefined;
  /** Re-drive afterwards and return once the run is parked again or finished. Default true. */
  resume?: boolean | undefined;
  /**
   * How to continue. Defaults to `Orchestrator.resume`, which is all the daemon may do: a
   * `ProgramService.resume` additionally mirrors a finished program run onto its Request
   * *document*, and a daemon writing documents beside a CLI is exactly #196. `orca answer`
   * passes `ProgramService.resume`, because in a one-shot CLI process there is no second
   * writer to lose the write to.
   */
  resumeWith?: ((runId: string) => Promise<RunState>) | undefined;
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
  if (found.state.run.status !== "paused")
    throw new ProtocolFault(
      "RUN_NOT_WAITING",
      `run ${runId} is ${found.state.run.status}, not parked: it is not waiting for this answer`,
      { runId, status: found.state.run.status },
    );
  await refuseIfLeasedElsewhere(orc, runId);

  const request = await orc.answer(opts.requestId, opts.answer, runId);
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
  /** Defaults to the orchestrator's own clock, so a test can pin every `asOf`. */
  clock?: Clock | undefined;
}

/** The four writing methods, over one orchestrator holding one lease per run. */
export class ControlModel {
  private readonly orc: Orchestrator;
  private readonly reads: ReadModel;
  private readonly permissionsFile: string | undefined;
  private readonly clock: Clock;

  constructor(opts: ControlModelOptions) {
    this.orc = opts.orchestrator;
    this.reads = opts.reads;
    this.permissionsFile = opts.permissionsFile;
    this.clock = opts.clock ?? opts.orchestrator.clock;
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
  async answerInput(params: InputsAnswerParams): Promise<InputsAnswerResult> {
    const permission = params.always ? await this.recordAlways(params) : undefined;
    const { request, state } = await answerAndResume(this.orc, {
      requestId: params.requestId,
      answer: params.optionId,
      ...(params.runId ? { runId: params.runId } : {}),
      resume: params.resume,
    });
    if (params.note)
      // `human.answered`'s payload is `{ stepRunId, requestId, answer }` and nothing else, so
      // the note reaches the operator's log and not the run's. A client must not present it
      // as something the run recorded. Widening the event is #238.
      this.orc.logger.info("human input answered with a note", {
        runId: request.runId,
        requestId: request.id,
        note: params.note,
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

  /** `runs.resume`: re-drive a parked run here, under this daemon's lease, until it stops again. */
  async resumeRun(params: RunsResumeParams): Promise<RunsResumeResult> {
    const state = await this.orc.getState(params.runId);
    if (isFinished(state))
      throw new ProtocolFault("RUN_NOT_WAITING", `run ${params.runId} is ${state.run.status}: it has finished`, {
        runId: params.runId,
        status: state.run.status,
      });
    await refuseIfLeasedElsewhere(this.orc, params.runId);
    await this.orc.resume(params.runId);
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
  async cancelRun(params: RunsCancelParams): Promise<RunsCancelResult> {
    await refuseIfLeasedElsewhere(this.orc, params.runId);
    try {
      await this.orc.cancel(params.runId, params.reason);
    } catch (e) {
      if (isOrcaError(e, "RUN_LEASED"))
        throw new ProtocolFault("RUN_LEASED_ELSEWHERE", e.message, { runId: params.runId, ...(e.details ?? {}) });
      throw e;
    }
    return { run: await this.runView(params.runId), asOf: this.clock.isoNow() };
  }

  /**
   * `runs.start`: create a run and drive it here until it parks or finishes.
   *
   * A workflow and its vars, and no documents (`RunsStartParamsSchema` says why, #196).
   * `requestId` and `workItemId` travel onto `run.created` and out on the `run.changed`
   * notification; neither is read back from a document store.
   */
  async startRun(params: RunsStartParams): Promise<RunsStartResult> {
    const runId = await this.orc.startRun({
      workflowId: params.workflowId,
      vars: params.vars,
      ...(params.requestId ? { requestId: params.requestId } : {}),
      ...(params.workItemId ? { workItemId: params.workItemId } : {}),
    });
    await this.orc.run(runId);
    return { runId, run: await this.runView(runId), asOf: this.clock.isoNow() };
  }

  // ------------------------------------------------------------------ pieces

  /** Results speak the read model's shapes, so a client folds one status vocabulary, not two. */
  private async runView(runId: string): Promise<RunSummaryView> {
    return (await this.reads.runsGet({ runId })).run;
  }

  /**
   * Append the standing rule an "always" answer implies. It runs *before* the answer is
   * recorded, deliberately: a sidecar write that fails must not leave a run resumed against
   * a permission grant that does not exist, and the reverse - a rule written for an answer
   * that was then refused - costs nothing, because a rule only ever fires on the next ask.
   */
  private async recordAlways(params: InputsAnswerParams): Promise<RecordAlwaysResult> {
    if (!this.permissionsFile)
      throw new OrcaError(
        "NOT_SUPPORTED",
        "this daemon serves no workspace configuration: there is nowhere to record a standing permission",
        { requestId: params.requestId },
      );
    const { request, state } = await findInput(this.orc, params.requestId, params.runId);
    if (request.kind !== "permission")
      throw new OrcaError("NOT_SUPPORTED", `'${params.requestId}' is a ${request.kind}, not a permission ask`, {
        requestId: params.requestId,
        kind: request.kind,
      });
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
    return recordAlwaysDecision({
      file: this.permissionsFile,
      agentId: await this.agentForStep(request.runId, request.stepRunId),
      request: asRequest,
      decision: params.always!.decision,
      workspaceCwd: state.run.workspace.cwd,
    });
  }

  /**
   * Which agent asked. `agent.session.opened` is the only event that records it, and a
   * permission ask always has one: an `ask` reaches a person only through a live session.
   */
  private async agentForStep(runId: string, stepRunId: string): Promise<string> {
    for (const e of await this.orc.stores.events.readTypes(runId, ["agent.session.opened"]))
      if (e.type === "agent.session.opened" && e.payload.stepRunId === stepRunId) return e.payload.agentId;
    throw new OrcaError("AGENT_NOT_FOUND", `no agent session recorded for step ${stepRunId}`, { runId, stepRunId });
  }
}

function isFinished(state: RunState): boolean {
  const s = state.run.status;
  return s === "completed" || s === "failed" || s === "cancelled";
}
