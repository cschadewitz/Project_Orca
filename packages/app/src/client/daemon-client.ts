/**
 * The app's only way to reach ORCA: request envelopes over the daemon's HTTP endpoint,
 * results validated against the protocol schemas. Lives in the main process (the
 * renderer talks to it over IPC via the preload bridge) and imports nothing but
 * `@orca/protocol`, which the lint config enforces for the whole app package.
 *
 * Reads go over HTTP, one request per response. The one thing HTTP cannot do is let the
 * daemon speak first, so `subscribe()` opens a WebSocket beside it (`subscription.ts`) and
 * hands back a stream that reconnects and resumes on its own. Both halves are the same
 * daemon on the same port; a client that only reads never opens a socket.
 */
import {
  AGENTS_LIST_METHOD,
  ARTIFACTS_GET_METHOD,
  ARTIFACTS_LIST_METHOD,
  AgentsListResultSchema,
  ArtifactsGetResultSchema,
  ArtifactsListResultSchema,
  CLAIMS_LIST_METHOD,
  CLAIMS_RELEASE_METHOD,
  CONFIG_GET_METHOD,
  CONFIG_SET_METHOD,
  ClaimsListResultSchema,
  ClaimsReleaseResultSchema,
  ConfigGetResultSchema,
  ConfigSetResultSchema,
  DECISIONS_DECIDE_METHOD,
  DECISIONS_LIST_METHOD,
  DECISIONS_REOPEN_METHOD,
  DEPENDENCIES_LIST_METHOD,
  DEPENDENCIES_WAIVE_METHOD,
  DecisionsDecideResultSchema,
  DecisionsListResultSchema,
  DecisionsReopenResultSchema,
  DependenciesListResultSchema,
  DependenciesWaiveResultSchema,
  HELLO_METHOD,
  ITEMS_LIST_METHOD,
  ItemsListResultSchema,
  JOURNAL_LIST_METHOD,
  JournalListResultSchema,
  PLANS_LIST_METHOD,
  PLAN_GET_METHOD,
  PlanGetResultSchema,
  PlansListResultSchema,
  RISKS_LIST_METHOD,
  RISKS_UPDATE_METHOD,
  RisksListResultSchema,
  RisksUpdateResultSchema,
  SCHEDULE_EXPLAIN_METHOD,
  SCHEDULE_GET_METHOD,
  ScheduleExplainResultSchema,
  ScheduleGetResultSchema,
  HelloResultSchema,
  INPUTS_ANSWER_METHOD,
  INPUTS_LIST_METHOD,
  InputsAnswerResultSchema,
  InputsListResultSchema,
  PROTOCOL_VERSION,
  RUNS_CANCEL_METHOD,
  RUNS_EVENTS_METHOD,
  RUNS_GET_METHOD,
  RUNS_LIST_METHOD,
  RUNS_RESUME_METHOD,
  RUNS_START_METHOD,
  ResponseMessageSchema,
  RunsCancelResultSchema,
  RunsEventsResultSchema,
  RunsGetResultSchema,
  RunsListResultSchema,
  RunsResumeResultSchema,
  RunsStartResultSchema,
  WORKFLOWS_GET_METHOD,
  WORKFLOWS_LIST_METHOD,
  WorkflowsGetResultSchema,
  WorkflowsListResultSchema,
  socketUrlFor,
  type AgentsListParams,
  type AgentsListResult,
  type ArtifactsGetParams,
  type ArtifactsGetResult,
  type ArtifactsListParams,
  type ArtifactsListResult,
  type ClaimsListParams,
  type ClaimsListResult,
  type ConfigGetParams,
  type ConfigGetResult,
  type ConfigSetParams,
  type ConfigSetResult,
  type ClaimsReleaseParams,
  type ClaimsReleaseResult,
  type DecisionsDecideParams,
  type DecisionsDecideResult,
  type DecisionsListParams,
  type DecisionsListResult,
  type DecisionsReopenParams,
  type DecisionsReopenResult,
  type DependenciesListParams,
  type DependenciesListResult,
  type DependenciesWaiveParams,
  type DependenciesWaiveResult,
  type HelloResult,
  type ItemsListParams,
  type ItemsListResult,
  type JournalListParams,
  type JournalListResult,
  type PlanGetParams,
  type PlanGetResult,
  type PlansListParams,
  type PlansListResult,
  type RisksListParams,
  type RisksListResult,
  type RisksUpdateParams,
  type RisksUpdateResult,
  type ScheduleExplainParams,
  type ScheduleExplainResult,
  type ScheduleGetParams,
  type ScheduleGetResult,
  type InputsAnswerParams,
  type InputsAnswerResult,
  type InputsListParams,
  type InputsListResult,
  type ProtocolError,
  type RequestMessage,
  type RunsCancelParams,
  type RunsCancelResult,
  type RunsEventsParams,
  type RunsEventsResult,
  type RunsGetParams,
  type RunsGetResult,
  type RunsListParams,
  type RunsListResult,
  type RunsResumeParams,
  type RunsResumeResult,
  type RunsStartParams,
  type RunsStartResult,
  type WorkflowsGetParams,
  type WorkflowsGetResult,
  type WorkflowsListParams,
  type WorkflowsListResult,
} from "@orca/protocol";
import type { ZodType } from "zod";
import { DaemonSubscription, type DaemonSubscriptionOptions } from "./subscription.js";

/** Where `orca serve` listens unless told otherwise; 6722 spells ORCA on a phone keypad. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:6722";

/**
 * Params as a caller passes them. The paging defaults (`limit`, `offset`) are the daemon's
 * schema's, so a screen that does not care about them says nothing about them.
 */
type Params<T> = Partial<T>;

export class DaemonClientError extends Error {
  override readonly name = "DaemonClientError";
  constructor(readonly error: ProtocolError) {
    super(`${error.code}: ${error.message}`);
  }
}

export class DaemonClient {
  private nextId = 1;

  constructor(
    readonly url: string = DEFAULT_DAEMON_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The WebSocket beside the read endpoint, on the same host and port. */
  get socketUrl(): string {
    return socketUrlFor(this.url);
  }

  async call<R>(method: string, params: unknown, result: ZodType<R>): Promise<R> {
    const req: RequestMessage = { kind: "request", id: this.nextId++, method, params };
    const res = await this.fetchImpl(`${this.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const parsed = ResponseMessageSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new DaemonClientError({
        code: "PROTOCOL_MESSAGE",
        message: `daemon sent something that is not a response`,
      });
    }
    if (!parsed.data.ok) throw new DaemonClientError(parsed.data.error);
    return result.parse(parsed.data.result);
  }

  hello(client: string): Promise<HelloResult> {
    return this.call(HELLO_METHOD, { client, protocol: PROTOCOL_VERSION }, HelloResultSchema);
  }

  runsList(params: Params<RunsListParams> = {}): Promise<RunsListResult> {
    return this.call(RUNS_LIST_METHOD, params, RunsListResultSchema);
  }

  runsGet(params: RunsGetParams): Promise<RunsGetResult> {
    return this.call(RUNS_GET_METHOD, params, RunsGetResultSchema);
  }

  runsEvents(params: Params<RunsEventsParams> & { runId: string }): Promise<RunsEventsResult> {
    return this.call(RUNS_EVENTS_METHOD, params, RunsEventsResultSchema);
  }

  inputsList(params: Params<InputsListParams> = {}): Promise<InputsListResult> {
    return this.call(INPUTS_LIST_METHOD, params, InputsListResultSchema);
  }

  claimsList(params: Params<ClaimsListParams> = {}): Promise<ClaimsListResult> {
    return this.call(CLAIMS_LIST_METHOD, params, ClaimsListResultSchema);
  }

  /** Artifact metadata only — the docked panel's version list and a step's chips (#159). */
  artifactsList(params: Params<ArtifactsListParams> = {}): Promise<ArtifactsListResult> {
    return this.call(ARTIFACTS_LIST_METHOD, params, ArtifactsListResultSchema);
  }

  /** One artifact's body, or the reason it is not being shown. */
  artifactsGet(params: Params<ArtifactsGetParams>): Promise<ArtifactsGetResult> {
    return this.call(ARTIFACTS_GET_METHOD, params, ArtifactsGetResultSchema);
  }

  /** Every workflow the daemon has registered, as rows for a picker or a viewer list (#174). */
  workflowsList(params: Params<WorkflowsListParams> = {}): Promise<WorkflowsListResult> {
    return this.call(WORKFLOWS_LIST_METHOD, params, WorkflowsListResultSchema);
  }

  /**
   * One workflow's graph. `id` is a registered workflow's, or `parent::node` for a graph
   * written inline inside one; `version` may only be the version on disk, because that is
   * the only definition ORCA keeps.
   */
  workflowsGet(params: WorkflowsGetParams): Promise<WorkflowsGetResult> {
    return this.call(WORKFLOWS_GET_METHOD, params, WorkflowsGetResultSchema);
  }

  /**
   * Both configuration documents — `orca.config.yaml` and the ADR 0009 permission sidecar —
   * with the schema a form renders and the effective permission policy the two add up to
   * (#174, #266).
   *
   * A read, answered by a `--read-only` daemon too. It is **not** redacted: `config.text` is
   * the file's bytes, host entries and command lines included, because a form that edits a
   * file has to show the file.
   */
  configGet(params: Params<ConfigGetParams> = {}): Promise<ConfigGetResult> {
    return this.call(CONFIG_GET_METHOD, params, ConfigGetResultSchema);
  }

  /* ---------- the plan reads (#169): what is coming and why it is not moving ---------- */

  /** Every plan in the store, each with its item counts per schedule classification. */
  plansList(params: Params<PlansListParams> = {}): Promise<PlansListResult> {
    return this.call(PLANS_LIST_METHOD, params, PlansListResultSchema);
  }

  /** One plan's header: requests, counts, risk matrix and scheduling policy. */
  planGet(params: PlanGetParams): Promise<PlanGetResult> {
    return this.call(PLAN_GET_METHOD, params, PlanGetResultSchema);
  }

  /** The schedule table, in schedule order, filtered and paged. */
  itemsList(params: Params<ItemsListParams> & { planId: string }): Promise<ItemsListResult> {
    return this.call(ITEMS_LIST_METHOD, params, ItemsListResultSchema);
  }

  /** What may run now, what waits and why, the waves and the critical path. */
  scheduleGet(params: ScheduleGetParams): Promise<ScheduleGetResult> {
    return this.call(SCHEDULE_GET_METHOD, params, ScheduleGetResultSchema);
  }

  /**
   * One item's place in the schedule, as lines. They are the scheduler's own words - the
   * same ones `orca plan explain` prints - so the popover shows them rather than re-phrasing.
   */
  scheduleExplain(params: ScheduleExplainParams): Promise<ScheduleExplainResult> {
    return this.call(SCHEDULE_EXPLAIN_METHOD, params, ScheduleExplainResultSchema);
  }

  /** The dependency edges, each with the scheduler's live evaluation beside its stored status. */
  dependenciesList(params: Params<DependenciesListParams> & { planId: string }): Promise<DependenciesListResult> {
    return this.call(DEPENDENCIES_LIST_METHOD, params, DependenciesListResultSchema);
  }

  /** The risk register with scores and levels, plus the matrix and the plan's appetite. */
  risksList(params: Params<RisksListParams> & { planId: string }): Promise<RisksListResult> {
    return this.call(RISKS_LIST_METHOD, params, RisksListResultSchema);
  }

  /** The decisions, their matrices and the work items each one gates. */
  decisionsList(params: Params<DecisionsListParams> & { planId: string }): Promise<DecisionsListResult> {
    return this.call(DECISIONS_LIST_METHOD, params, DecisionsListResultSchema);
  }

  /** One page of the plan's audit trail, forwards or backwards by sequence number. */
  journalList(params: Params<JournalListParams> & { planId: string }): Promise<JournalListResult> {
    return this.call(JOURNAL_LIST_METHOD, params, JournalListResultSchema);
  }

  /* ---------- the plan writes (#169, #88) ---------- */

  /** Waive a dependency: a person saying this edge no longer has to hold. */
  dependenciesWaive(params: DependenciesWaiveParams): Promise<DependenciesWaiveResult> {
    return this.call(DEPENDENCIES_WAIVE_METHOD, params, DependenciesWaiveResultSchema);
  }

  /** Record a choice. `recommended` comes back beside it when the decision has a matrix. */
  decisionsDecide(params: DecisionsDecideParams): Promise<DecisionsDecideResult> {
    return this.call(DECISIONS_DECIDE_METHOD, params, DecisionsDecideResultSchema);
  }

  /** Clear a choice, and with it every dependency the choice had satisfied (#104). */
  decisionsReopen(params: DecisionsReopenParams): Promise<DecisionsReopenResult> {
    return this.call(DECISIONS_REOPEN_METHOD, params, DecisionsReopenResultSchema);
  }

  /** Move a risk along its lifecycle; accepting one releases the items it held. */
  risksUpdate(params: RisksUpdateParams): Promise<RisksUpdateResult> {
    return this.call(RISKS_UPDATE_METHOD, params, RisksUpdateResultSchema);
  }

  /**
   * Take a work item away from the run that claimed it. Refused while that run could still
   * resume unless `force`; `ClaimView.owner.releasable` predicts which it will be, so the
   * confirmation can say so before the call rather than after it.
   */
  claimsRelease(params: Params<ClaimsReleaseParams> & { workItemId: string }): Promise<ClaimsReleaseResult> {
    return this.call(CLAIMS_RELEASE_METHOD, params, ClaimsReleaseResultSchema);
  }

  /* ---------- the control methods: the calls that write ---------- */

  /**
   * Answer a gate or a permission ask. The answer is an option *id*; `always` also writes
   * the standing rule into the workspace sidecar and the result says what was written.
   *
   * Slow on purpose when `resume` is left at its default: the daemon re-drives the run
   * under its lease and answers once the run parks again or finishes, so this call is open
   * for as long as the run is moving. Nothing here times it out — the notification stream
   * is what a screen watches meanwhile.
   */
  inputsAnswer(
    params: Params<InputsAnswerParams> & { requestId: string; optionId: string },
  ): Promise<InputsAnswerResult> {
    return this.call(INPUTS_ANSWER_METHOD, params, InputsAnswerResultSchema);
  }

  /** Re-drive a parked run. Answers when it parks again or finishes, never mid-flight. */
  runsResume(params: RunsResumeParams): Promise<RunsResumeResult> {
    return this.call(RUNS_RESUME_METHOD, params, RunsResumeResultSchema);
  }

  /** Stop a run, with the reason recorded on `run.cancelled`. */
  runsCancel(params: RunsCancelParams): Promise<RunsCancelResult> {
    return this.call(RUNS_CANCEL_METHOD, params, RunsCancelResultSchema);
  }

  /**
   * Start a run of a registered workflow (#178). `vars` is merged over the workflow's own,
   * exactly as `orca run --var` merges them; the palette's picker sends none, so a run
   * started from the app runs on the workflow's defaults.
   *
   * It answers as soon as the run exists — `runId` and the summary — rather than when the
   * run finishes, so the caller navigates to a run that is already moving.
   */
  runsStart(params: Params<RunsStartParams> & { workflowId: string }): Promise<RunsStartResult> {
    return this.call(RUNS_START_METHOD, params, RunsStartResultSchema);
  }

  /**
   * Write one configuration document. `expectedRevision` is the `revision` of the view this
   * edit was made against; a daemon whose bytes have moved answers `CONFIG_STALE` rather
   * than overwriting whatever landed in between. Exactly one of `text` and `patch`, and
   * `patch` is the one that keeps the YAML's comments.
   */
  configSet(params: ConfigSetParams): Promise<ConfigSetResult> {
    return this.call(CONFIG_SET_METHOD, params, ConfigSetResultSchema);
  }

  /** Every configured agent's handshake health, with what is claimed right now beside it. */
  agentsList(params: Params<AgentsListParams> = {}): Promise<AgentsListResult> {
    return this.call(AGENTS_LIST_METHOD, params, AgentsListResultSchema);
  }

  /**
   * Open a push stream. Connects immediately and keeps itself connected: the returned
   * subscription reconnects with backoff and resubscribes from the last sequence number it
   * saw, so the caller gets a stream with gaps in *time* and none in content. Call `close()`
   * on it when the screen behind it goes away.
   */
  subscribe(opts: Omit<DaemonSubscriptionOptions, "url">): DaemonSubscription {
    return new DaemonSubscription({ ...opts, url: this.socketUrl });
  }
}
