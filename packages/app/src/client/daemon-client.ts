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
  CONFIG_GET_METHOD,
  CONFIG_SET_METHOD,
  ClaimsListResultSchema,
  ConfigGetResultSchema,
  ConfigSetResultSchema,
  HELLO_METHOD,
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
  ResponseMessageSchema,
  RunsCancelResultSchema,
  RunsEventsResultSchema,
  RunsGetResultSchema,
  RunsListResultSchema,
  RunsResumeResultSchema,
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
  type HelloResult,
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
