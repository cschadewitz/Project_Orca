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
import { PROTOCOL_VERSION } from "@orca/protocol";
import { RevisionResultSchema, PendingRevisionViewSchema } from "@orca/protocol";
import { MaintenanceResultSchema, type MaintenanceParams, type MaintenanceResult } from "@orca/protocol";
import {
  ConfigApplyResultSchema,
  ConfigApplyParamsSchema,
  WorkflowsValidateInputsResultSchema,
  WorkflowsValidateInputsParamsSchema,
  OperatorPreflightResultSchema,
  OperatorPreflightParamsSchema,
  type ConfigApplyParams,
  type ConfigApplyResult,
  type WorkflowsValidateInputsParams,
  type WorkflowsValidateInputsResult,
} from "@orca/protocol";
import type { PreflightParams, PreflightResult } from "../configuration-launch-contract.js";

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
  PERMISSIONS_SAVE_JUDGED_RULE_METHOD,
  PermissionsSaveJudgedRuleResultSchema,
  JUDGE_STATUS_METHOD,
  JudgeStatusResultSchema,
  type JudgeStatusResult,
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
  type HelloResult,
  INPUTS_ANSWER_METHOD,
  INPUTS_LIST_METHOD,
  InputsAnswerResultSchema,
  InputsListResultSchema,
  RUNS_CANCEL_METHOD,
  RUNS_EVENTS_METHOD,
  RUNS_GET_METHOD,
  RUNS_LIST_METHOD,
  ADMISSIONS_RECONCILE_METHOD,
  AdmissionRetryResultSchema,
  RUNS_RECOVER_METHOD,
  RUNS_RECOVERY_METHOD,
  RUNS_RESUME_METHOD,
  RUNS_REVIEW_EFFECT_METHOD,
  RUNS_START_METHOD,
  ResponseMessageSchema,
  RunsCancelResultSchema,
  RunsEventsResultSchema,
  RunsGetResultSchema,
  RunsListResultSchema,
  RunsRecoverResultSchema,
  RunsRecoveryResultSchema,
  RunsResumeResultSchema,
  RunsReviewEffectResultSchema,
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
  type PermissionsSaveJudgedRuleParams,
  type PermissionsSaveJudgedRuleResult,
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
  type RunsRecoverParams,
  type RunsRecoverResult,
  type RunsRecoveryParams,
  type RunsRecoveryResult,
  type RunsResumeParams,
  type RunsResumeResult,
  type RunsReviewEffectParams,
  type RunsReviewEffectResult,
  type RunsStartParams,
  type RunsStartResult,
  type WorkflowsGetParams,
  type WorkflowsGetResult,
  type WorkflowsListParams,
  type WorkflowsListResult,
  SEARCH_METHOD,
  SearchResultSchema,
  type SearchParams,
  type SearchResult,
} from "@orca/protocol";
import { appHelloOffer, appSpeaks } from "./protocol-window.js";
import { type ZodType } from "zod";
import {
  assertCredentialDestination,
  authenticationCode,
  CredentialTransportUnavailable,
  type DaemonTokenSource,
} from "./auth.js";
import { DaemonSubscription, type DaemonSubscriptionOptions, type SocketFactory } from "./subscription.js";
import { observeOwnedDiagnostic, type OwnedDiagnosticObserver } from "../main/diagnostics/source-producers.js";

/** Where `orca serve` listens unless told otherwise; 6722 spells ORCA on a phone keypad. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:6722";

const admissionMethod = (method: string) =>
  ["runs.admit", "runs.recover", "requests.submit", "operator.admitRun", "operator.submitRequest"].includes(method);
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? (descriptor.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

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

export interface DaemonClientOptions {
  /** Existing authorized operation facts only; never sends content or performs a diagnostic RPC. */
  onDiagnostic?: OwnedDiagnosticObserver;
  auth?: DaemonTokenSource;
  requireAuthentication?: boolean;
  /** Ordinary RPC failures. Hello owners publish failures after checking their lifetime. */
  onAuthFailure?: () => void;
  /** Current subscription verification only; ordinary hello probes never publish. */
  onHello?: (hello: HelloResult) => void;
  /** How the push stream opens its socket; a saved profile's comes from its tunnel. */
  socket?: SocketFactory;
}

export class DaemonClient {
  maintenance(params: MaintenanceParams): Promise<MaintenanceResult> {
    return this.call("maintenance", params, MaintenanceResultSchema);
  }
  private nextId = 1;

  constructor(
    readonly url: string = DEFAULT_DAEMON_URL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: DaemonClientOptions = {},
  ) {}

  /** Main-only capture: all calls in a guarded operation use the credential discovered at its start.
   * A concurrent ordinary read may refresh the shared source, but cannot change this operation's principal.
   * Tokens stay in the client closure and are never returned through the renderer bridge.
   */
  withCapturedAuthentication(): DaemonClient {
    const token = this.options.auth?.read();
    return new DaemonClient(this.url, this.fetchImpl, {
      ...this.options,
      ...(this.options.auth ? { auth: { read: () => token, refresh: () => false } } : {}),
    });
  }

  /** The WebSocket beside the read endpoint, on the same host and port. */
  get socketUrl(): string {
    return socketUrlFor(this.url);
  }

  async call<R>(
    method: string,
    params: unknown,
    result: ZodType<R>,
    retryAuth = true,
    signal?: AbortSignal,
    publishAuthFailure = true,
  ): Promise<R> {
    const req: RequestMessage = { kind: "request", id: this.nextId++, method, params };
    for (let attempt = 0; ; attempt++) {
      let token: string | undefined;
      try {
        token = this.options.auth?.read();
      } catch (error) {
        // Nothing was sent: the transport is down, not the credential.
        if (error instanceof CredentialTransportUnavailable) throw error;
        if (publishAuthFailure) this.options.onAuthFailure?.();
        if (publishAuthFailure) this.observeError({ code: "AUTH_INVALID", message: "" });
        throw new DaemonClientError({ code: "AUTH_INVALID", message: "Daemon authentication failed" });
      }
      if (this.options.requireAuthentication && !token) {
        if (publishAuthFailure) this.observeError({ code: "AUTH_REQUIRED", message: "" });
        throw new DaemonClientError({
          code: "AUTH_REQUIRED",
          message: "Remote daemon requires an explicit credential",
        });
      }
      assertCredentialDestination(this.url, token);
      // Serialization failure is pre-dispatch and carries no uncertain-admission fact.
      const body = JSON.stringify(req);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.url}/rpc`, {
          method: "POST",
          ...(signal ? { signal } : {}),
          redirect: "manual",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body,
        });
      } catch (error) {
        // This owner knows a request was dispatched and no response was received.
        // The error object is rethrown unchanged, never examined by diagnostics.
        if (admissionMethod(method))
          observeOwnedDiagnostic(this.options.onDiagnostic, "admission", "admission_uncertain");
        throw error;
      }
      // Proxies may reject before the daemon sees the request, with HTML/plain text rather
      // than an ORCA envelope. Status is authoritative: never retry these as network blips
      // or accept an apparent successful envelope carried by a refused HTTP response.
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel().catch(() => undefined);
        if (publishAuthFailure) this.options.onAuthFailure?.();
        if (publishAuthFailure) this.observeError({ code: "AUTH_FORBIDDEN", message: "" });
        throw new DaemonClientError({ code: "AUTH_FORBIDDEN", message: "Daemon RPC redirects are refused" });
      }
      const transportAuthError: ProtocolError | undefined =
        res.status === 401
          ? { code: token ? "AUTH_INVALID" : "AUTH_REQUIRED", message: "Daemon authentication failed" }
          : res.status === 403
            ? { code: "AUTH_FORBIDDEN", message: "Daemon access denied" }
            : undefined;
      const parsed = ResponseMessageSchema.safeParse(await res.json().catch(() => undefined));
      let error: ProtocolError;
      if (transportAuthError) {
        error =
          parsed.success && !parsed.data.ok && authenticationCode(parsed.data) ? parsed.data.error : transportAuthError;
      } else {
        if (!parsed.success) {
          if (admissionMethod(method))
            observeOwnedDiagnostic(this.options.onDiagnostic, "admission", "admission_uncertain");
          throw new DaemonClientError({
            code: "PROTOCOL_MESSAGE",
            message: "daemon sent something that is not a response",
          });
        }
        if (parsed.data.ok) {
          const validated = result.safeParse(parsed.data.result);
          if (!validated.success) {
            if (admissionMethod(method))
              observeOwnedDiagnostic(this.options.onDiagnostic, "admission", "admission_uncertain");
            throw validated.error;
          }
          if (admissionMethod(method)) {
            const receipt =
              ownData(validated.data, "state") === "resolved" ? ownData(validated.data, "result") : validated.data;
            if (ownData(receipt, "state") === "recoverable-failure")
              observeOwnedDiagnostic(this.options.onDiagnostic, "admission", "admission_recoverable_failure");
          }
          return validated.data;
        }
        error = parsed.data.error;
      }
      if (error.code === "AUTH_INVALID" && retryAuth && attempt === 0) {
        try {
          if (this.options.auth?.refresh()) continue;
        } catch {
          // Keep the generic wire failure; filesystem errors must never expose a token.
        }
      }
      if (publishAuthFailure && (transportAuthError || error.code === "AUTH_INVALID" || error.code === "AUTH_REQUIRED"))
        this.options.onAuthFailure?.();
      if (publishAuthFailure) this.observeError(error);
      throw new DaemonClientError(error);
    }
  }

  private observeError(error: ProtocolError): void {
    if (error.code === "AUTH_REQUIRED")
      observeOwnedDiagnostic(this.options.onDiagnostic, "connection", "authentication_required");
    else if (error.code === "AUTH_INVALID")
      observeOwnedDiagnostic(this.options.onDiagnostic, "connection", "authentication_invalid");
    else if (error.code === "AUTH_FORBIDDEN")
      observeOwnedDiagnostic(this.options.onDiagnostic, "connection", "authorization_denied");
    else if (
      error.code === "RUN_STATE" &&
      ownData(ownData(error.details, "diagnostics"), "protectedState") === "unavailable"
    )
      observeOwnedDiagnostic(this.options.onDiagnostic, "protected_state", "protected_state_unavailable");
  }

  async hello(client: string, retryAuth = true): Promise<HelloResult> {
    // The caller owns the lifetime of a probe or post-subscribe handshake. Publishing here
    // would let a late reply mutate connection state before that caller checks its epoch.
    return this.call(
      HELLO_METHOD,
      { client, ...appHelloOffer() },
      HelloResultSchema,
      retryAuth,
      AbortSignal.timeout(10_000),
      false,
    );
  }

  runsList(params: Params<RunsListParams> = {}): Promise<RunsListResult> {
    return this.call(RUNS_LIST_METHOD, params, RunsListResultSchema);
  }

  runsGet(params: RunsGetParams): Promise<RunsGetResult> {
    return this.call(RUNS_GET_METHOD, params, RunsGetResultSchema);
  }

  runsEvents(params: Params<RunsEventsParams> & { runId: string }): Promise<RunsEventsResult> {
    // This build's event schema reads every type up to its own protocol (#357).
    return this.call(RUNS_EVENTS_METHOD, { protocol: PROTOCOL_VERSION, ...params }, RunsEventsResultSchema);
  }

  inputsRevise(params: import("@orca/protocol").InputsReviseParams) {
    return this.call("inputs.revise", params, RevisionResultSchema);
  }
  inputsRevisionPending(params: import("@orca/protocol").InputsRevisionPendingParams) {
    return this.call("inputs.revisionPending", params, PendingRevisionViewSchema);
  }
  inputsReplaceRevision(params: import("@orca/protocol").InputsReplaceRevisionParams) {
    return this.call("inputs.replaceRevision", params, RevisionResultSchema);
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

  /**
   * `search` (#255): event text and text artifacts, matched by the daemon within a limit and a
   * deadline. Ask `hello.methods` first: a daemon before protocol 2.2 does not answer it.
   */
  search(params: Params<SearchParams> & { query: string }): Promise<SearchResult> {
    return this.call(SEARCH_METHOD, params, SearchResultSchema);
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

  configApply(params: ConfigApplyParams): Promise<ConfigApplyResult> {
    return this.call("config.apply", ConfigApplyParamsSchema.parse(params), ConfigApplyResultSchema);
  }

  workflowsValidateInputs(params: WorkflowsValidateInputsParams): Promise<WorkflowsValidateInputsResult> {
    return this.call(
      "workflows.validateInputs",
      WorkflowsValidateInputsParamsSchema.parse(params),
      WorkflowsValidateInputsResultSchema,
    );
  }

  operatorPreflight(params: PreflightParams): Promise<PreflightResult> {
    return this.call("operator.preflight", OperatorPreflightParamsSchema.parse(params), OperatorPreflightResultSchema);
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
  async runsResume(params: RunsResumeParams): Promise<RunsResumeResult> {
    try {
      return await this.call(RUNS_RESUME_METHOD, params, RunsResumeResultSchema);
    } catch (error) {
      observeOwnedDiagnostic(this.options.onDiagnostic, "resume", "resume_failed");
      throw error;
    }
  }

  /**
   * What recovering a stopped run would do (#357): the options, the checkpoints, the steps
   * whose effect is uncertain, and what has drifted since. A read, served from store facts.
   */
  runsRecovery(params: RunsRecoveryParams): Promise<RunsRecoveryResult> {
    return this.call(RUNS_RECOVERY_METHOD, params, RunsRecoveryResultSchema);
  }

  /** Record a person's review of a step whose side effect is uncertain: run it again, or abandon it. */
  runsReviewEffect(params: RunsReviewEffectParams): Promise<RunsReviewEffectResult> {
    return this.call(RUNS_REVIEW_EFFECT_METHOD, params, RunsReviewEffectResultSchema);
  }

  /**
   * Start a checkpoint attempt of a failed run through retry-safe admission. The same
   * `idempotencyKey` answers with the same attempt, so a caller that lost the answer sends
   * the call again with the key it already used rather than a new one.
   */
  runsRecover(params: RunsRecoverParams): Promise<RunsRecoverResult> {
    return this.call(RUNS_RECOVER_METHOD, params, RunsRecoverResultSchema);
  }

  /**
   * Finish a checkpoint attempt whose receipt was a recoverable failure: `admissions.reconcile`,
   * for a checkpoint receipt only, creates the attempt it reserved, or keeps failing if that
   * reservation was retired. The
   * answer is flattened to `runs.recover`'s own shape so one reader handles both.
   */
  async runsRecoverReconcile(params: {
    operationId: string;
    expectedScope?: { principalId: string; workspaceId: string };
  }): Promise<RunsRecoverResult> {
    // `kind` makes the daemon refuse any other receipt before it reconciles anything (#357).
    const answer = await this.call(
      ADMISSIONS_RECONCILE_METHOD,
      { ...params, kind: "run.recover" },
      AdmissionRetryResultSchema,
    );
    if (answer.state === "in-progress") return answer;
    const receipt = answer.result && typeof answer.result === "object" ? answer.result : {};
    return RunsRecoverResultSchema.parse({ ...receipt, operationId: answer.operationId });
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

  /**
   * Save a plain-language rule a person wrote or accepted (protocol 2.12, #701). The daemon
   * appends it to the permission sidecar after every hand-written rule; it allows nothing on
   * its own, only what a judge decides it covers, one call at a time.
   */
  permissionsSaveJudgedRule(params: PermissionsSaveJudgedRuleParams): Promise<PermissionsSaveJudgedRuleResult> {
    return this.call(PERMISSIONS_SAVE_JUDGED_RULE_METHOD, params, PermissionsSaveJudgedRuleResultSchema);
  }

  /** Where the plain-language rule judge's setup stands (protocol 2.12, #701): read-only. */
  judgeStatus(): Promise<JudgeStatusResult> {
    return this.call(JUDGE_STATUS_METHOD, {}, JudgeStatusResultSchema);
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
  subscribe(opts: Omit<DaemonSubscriptionOptions, "url" | "auth">): DaemonSubscription {
    return new DaemonSubscription({
      ...opts,
      url: this.socketUrl,
      verify: async (isCurrent) => {
        const hello = await this.hello("orca-app/subscription", false);
        if (!isCurrent()) return undefined;
        this.options.onHello?.(hello);
        if (!appSpeaks(hello.protocol)) {
          throw new DaemonClientError({ code: "PROTOCOL_VERSION", message: "Daemon protocol mismatch" });
        }
        return hello.identity;
      },
      ...(this.options.auth ? { auth: { tokens: this.options.auth } } : {}),
      ...(this.options.socket ? { socket: this.options.socket } : {}),
    });
  }
}
