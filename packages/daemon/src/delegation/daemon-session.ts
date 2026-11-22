/**
 * A daemon-backed `AgentSession` (#883): a step whose agent is `type: orca-daemon` runs as a
 * run of a named workflow on another ORCA daemon, reached over the remote profile's SSH
 * tunnel (`@orca/protocol/remote-access`, #874), with the credential that daemon issued.
 *
 * - **Admission is retry-safe.** A turn is admitted with `runs.admit` under an idempotency key
 *   derived from the parent run and step run, so a call repeated after a dropped connection
 *   gets the same receipt and the same remote run, never a second one.
 * - **Progress follows the remote log** by cursor (`runs.events`): remote step milestones and
 *   the remote agents' own updates become this session's updates, and so the parent step's
 *   `agent.update` events.
 * - **Gates are forwarded.** An open input on the remote run (or its children) is asked through
 *   the parent's `askPermission`, and the parent's answer is sent back with `inputs.answer`.
 * - **Reattach, not resubmit.** A connection lost mid-run is retried until the turn's deadline;
 *   the session keeps the remote run id and its cursor, so it picks up where it was.
 * - **Cancellation reaches the remote run** (`runs.cancel`), whether the parent cancelled the
 *   step or its turn timed out.
 * - **Artifacts come back** once the remote run succeeds: each of the step's deliverables is
 *   matched to a remote artifact by name (else kind) and written to the deliverable's path on
 *   the agent's host, where the step collects it like any agent's output.
 * - **Refusals are typed.** What a retry cannot fix fails `DELEGATION_REFUSED` with
 *   `details.reason`; a lost connection that outlives the turn is `AGENT_TRANSPORT`; a remote
 *   run that ends without success is `DELEGATED_RUN_FAILED`.
 *
 * `terminated` resolves once every ssh process of the session's tunnel has exited, so the
 * session's slot (#873) comes back only then.
 */
import { randomUUID } from "node:crypto";
import {
  newId,
  OrcaError,
  sha256,
  silentLogger,
  systemClock,
  type AgentSpec,
  type AgentUpdateSummary,
  type Clock,
  type Logger,
  type SessionConfigOption,
} from "@orca/core";
import type {
  AgentHost,
  AgentSession,
  OpenSessionOptions,
  PermissionInvocation,
  PromptOptions,
  SessionUpdateEvent,
  TurnContext,
  TurnDeliverable,
  TurnResult,
} from "@orca/agents";
import {
  ArtifactsGetResultSchema,
  ArtifactsListResultSchema,
  daemonRelation,
  formatProtocolVersion,
  helloOffer,
  HelloResultSchema,
  InputsListResultSchema,
  OperatorDiscoverySchema,
  RunsAdmitResultSchema,
  RunsEventsResultSchema,
  RunsGetResultSchema,
  type OpenInputView,
} from "@orca/protocol";
import { RemoteDaemonClient, RemoteFault, RemoteUnreachable } from "./remote-client.js";

/** ACP shapes, through `@orca/agents`' own types: this package does not import the SDK. */
type PromptInput = Parameters<AgentSession["prompt"]>[0];
type ContentBlocks = Exclude<PromptInput, string>;
type PermissionRequest = Parameters<NonNullable<OpenSessionOptions["askPermission"]>>[0];
type RawUpdate = SessionUpdateEvent["raw"];

/** The calls a delegation makes. A daemon that does not answer all of them cannot take one. */
export const DELEGATION_METHODS = [
  "hello",
  "operator.discover",
  "runs.admit",
  "admissions.get",
  "admissions.reconcile",
  "runs.get",
  "runs.events",
  "runs.cancel",
  "inputs.list",
  "inputs.answer",
  "artifacts.list",
  "artifacts.get",
] as const;

/** Why a delegation was refused: `DELEGATION_REFUSED`'s `details.reason`. */
export type DelegationRefusalReason =
  | "profile-invalid"
  | "credential-missing"
  | "tunnel"
  | "auth"
  | "protocol"
  | "admission-closed"
  | "workflow"
  | "scope-changed";

export function delegationRefusal(
  profile: string,
  reason: DelegationRefusalReason,
  message: string,
  details: Record<string, unknown> = {},
): OrcaError {
  return new OrcaError("DELEGATION_REFUSED", message, { reason, profile, ...details });
}

/** What the session needs of the tunnel: streams to the daemon, and its end. */
export interface DelegationTransport {
  connect(): import("node:stream").Duplex;
  /** Whether the transport can never carry a stream again (a permanent tunnel refusal). */
  failed(): DelegationRefusalReason | undefined;
  /** Ends every stream; resolves once every process behind the transport has exited. */
  close(): Promise<void>;
}

export interface OpenDaemonSessionOptions {
  agent: AgentSpec;
  /** The host the step's deliverables are collected on; artifacts are written there. */
  host: AgentHost;
  cwd: string;
  /** The remote profile's id, for messages and refusal details. */
  profile: string;
  /** A display name for the remote, in progress lines and forwarded questions. */
  remoteName: string;
  transport: DelegationTransport;
  token: string;
  askPermission?: (req: PermissionRequest, invocation?: PermissionInvocation) => Promise<string | undefined>;
  logger?: Logger;
  clock?: Clock;
  /** How often the remote run is read while it runs. Default 1 s. */
  pollMs?: number;
  /** Per-call limit for remote calls. Default 30 s. */
  callTimeoutMs?: number;
}

/** The turn in flight: its remote run, and what its forwarded questions are bound to. */
interface Turn {
  runId: string;
  cancelled: boolean;
  id: string;
  abort: AbortController;
  /** A forwarded question the parent could not take (it parked or failed): ends the turn. */
  failure?: Error;
}

type Terminal = { status: "succeeded" } | { status: "failed" | "cancelled"; error?: unknown };

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The parent directory of an absolute path on either kind of host. */
function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at <= 0 ? path.slice(0, 1) : path.slice(0, at);
}

/** The remote run's key: one per parent step attempt, within the 128-byte retry key limit. */
export function delegationKey(turn: Pick<TurnContext, "runId" | "stepRunId">): string {
  return `orca-delegate-${sha256(`${turn.runId}\n${turn.stepRunId}`).slice(0, 48)}`;
}

/**
 * Open a session on a remote daemon: `hello` (the protocol must match and every delegation
 * method must be served), then `operator.discover` (the credential's principal and the remote
 * workspace, which every admission is then bound to with `expectedScope`).
 */
export async function openDaemonSession(options: OpenDaemonSessionOptions): Promise<AgentSession> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const client = new RemoteDaemonClient({
    connect: () => options.transport.connect(),
    token: options.token,
    ...(options.callTimeoutMs ? { timeoutMs: options.callTimeoutMs } : {}),
  });
  const refuse = (reason: DelegationRefusalReason, message: string, details?: Record<string, unknown>) =>
    delegationRefusal(options.profile, reason, message, details);
  const fault = (error: unknown): OrcaError => classify(options.profile, options.transport, error);
  try {
    const hello = HelloResultSchema.parse(
      await client.call("hello", { client: "orca-daemon/delegation", ...helloOffer() }).catch((e: unknown) => {
        throw fault(e);
      }),
    );
    if (!daemonRelation(hello.protocol))
      throw refuse(
        "protocol",
        `The daemon on ${options.remoteName} speaks protocol ${formatProtocolVersion(hello.protocol)}, which this daemon cannot delegate to. Update ORCA on one of them so both speak the same major version.`,
        { remoteProtocol: formatProtocolVersion(hello.protocol) },
      );
    const missing = DELEGATION_METHODS.filter((m) => !hello.methods?.includes(m));
    if (missing.length)
      throw refuse(
        "admission-closed",
        `The daemon on ${options.remoteName} does not take delegated runs (it does not answer ${missing.join(", ")}). It may be read-only, not in token mode, or an older ORCA.`,
        { missing },
      );
    const discovery = OperatorDiscoverySchema.parse(
      await client.call("operator.discover", {}).catch((e: unknown) => {
        throw fault(e);
      }),
    );
    if (!discovery.operations.includes("runs.admit"))
      throw refuse(
        "auth",
        `The credential for ${options.remoteName} may not start runs there. Issue one with the client preset.`,
        { principal: discovery.principalId },
      );
    return new DaemonSession(options, client, clock, logger, {
      principalId: discovery.principalId,
      workspaceId: discovery.target.workspaceId,
    });
  } catch (error) {
    client.close();
    await options.transport.close().catch(() => undefined);
    throw error instanceof OrcaError ? error : fault(error);
  }
}

/** Map a failed call to the typed failure a step records. */
function classify(profile: string, transport: DelegationTransport, error: unknown): OrcaError {
  if (error instanceof OrcaError) return error;
  if (error instanceof RemoteFault) {
    if (["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN"].includes(error.code))
      return delegationRefusal(
        profile,
        "auth",
        `The remote daemon refused this daemon's credential (${error.code}). Issue a new one there and replace the credential file.`,
        { remoteCode: error.code },
      );
    if (error.code === "PROTOCOL_VERSION")
      return delegationRefusal(profile, "protocol", `The remote daemon refused the protocol: ${error.message}`, {
        remoteCode: error.code,
      });
    if (
      error.code === "WORKFLOW_NOT_FOUND" ||
      error.code === "WORKFLOW_INPUT_INVALID" ||
      error.code === "WORKFLOW_INVALID"
    )
      return delegationRefusal(profile, "workflow", `The remote daemon refused the workflow: ${error.message}`, {
        remoteCode: error.code,
      });
    return new OrcaError("AGENT_PROTOCOL", `The remote daemon refused ${error.method}: ${error.message}`, {
      profile,
      remoteCode: error.code,
    });
  }
  const permanent = transport.failed();
  if (permanent)
    return delegationRefusal(profile, permanent, "The SSH connection to the remote daemon cannot be used.");
  const method = error instanceof RemoteUnreachable ? error.method : "call";
  return new OrcaError("AGENT_TRANSPORT", `No answer from the remote daemon (${method}).`, { profile });
}

class DaemonSession implements AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly hostId: string;
  readonly cwd: string;
  readonly acpSessionId: string;
  readonly closed: Promise<void>;
  readonly terminated: Promise<void>;
  readonly configOptions: readonly SessionConfigOption[] = [];
  private readonly listeners = new Set<(e: SessionUpdateEvent) => void>();
  private closing: Promise<void> | undefined;
  private resolveClosed!: () => void;
  private resolveTerminated!: () => void;
  private rejectTerminated!: (error: unknown) => void;
  /** The remote run of the turn in flight, for `cancel()`. */
  private current: Turn | undefined;
  private readonly pollMs: number;

  constructor(
    private readonly options: OpenDaemonSessionOptions,
    private readonly client: RemoteDaemonClient,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly scope: { principalId: string; workspaceId: string },
  ) {
    this.id = newId("sess", clock.now());
    this.agentId = options.agent.id;
    this.hostId = options.host.spec.id;
    this.cwd = options.cwd;
    this.acpSessionId = `orca-daemon:${options.profile}:${this.id}`;
    this.pollMs = options.pollMs ?? 1_000;
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
    this.terminated = new Promise((resolve, reject) => {
      this.resolveTerminated = resolve;
      this.rejectTerminated = reject;
    });
    // Nobody may ever await it (an aborted open); its outcome is still observed by close().
    void this.terminated.catch(() => undefined);
  }

  onUpdate(listener: (e: SessionUpdateEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setConfigOption(): Promise<SessionConfigOption[]> {
    return Promise.reject(
      new OrcaError(
        "NOT_SUPPORTED",
        "a delegated agent has no session options; the remote workflow chooses its agents",
      ),
    );
  }

  async cancel(): Promise<void> {
    const current = this.current;
    if (!current || current.cancelled) return;
    current.cancelled = true;
    await this.cancelRemote(current.runId, "cancelled by the delegating run");
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.client.close();
      try {
        await this.options.transport.close();
        this.resolveTerminated();
      } catch (error) {
        this.rejectTerminated(error);
      }
      this.resolveClosed();
    })());
  }

  async prompt(input: PromptInput, options: PromptOptions = {}): Promise<TurnResult> {
    const started = this.clock.now();
    const turn = options.turn;
    const deadline = started + (options.timeoutMs ?? this.options.agent.turnTimeoutMs);
    if (turn && turn.followUp > 0) {
      // The remote run already ended and delivered what it had; asking again would start a
      // second remote run for the same step. What is still missing stays missing.
      this.note(`The remote run for this step already finished; ${this.options.remoteName} is not asked again.`);
      return { stopReason: "end_turn", durationMs: 0 };
    }
    const task = turn?.task ?? (typeof input === "string" ? input : textOf(input));
    const key = turn ? delegationKey(turn) : `orca-delegate-${newId("sess", started)}`;
    const runId = await this.admit(task, key, deadline, options.signal);
    const current: Turn = { runId, cancelled: false, id: randomUUID(), abort: new AbortController() };
    this.current = current;
    this.note(`Delegated to ${this.options.remoteName} as run ${runId}.`);
    try {
      const outcome = await this.follow(runId, deadline, options.signal, current);
      if (outcome === "cancelled") return { stopReason: "cancelled", durationMs: this.clock.now() - started };
      if (outcome === "timeout") {
        await this.cancelRemote(runId, "the delegating step timed out");
        throw new OrcaError("STEP_TIMEOUT", `the remote run ${runId} did not finish within the turn timeout`, {
          profile: this.options.profile,
          remoteRunId: runId,
        });
      }
      if (outcome.status !== "succeeded")
        throw new OrcaError(
          "DELEGATED_RUN_FAILED",
          `the remote run ${runId} on ${this.options.remoteName} ${outcome.status}`,
          {
            profile: this.options.profile,
            remoteRunId: runId,
            outcome: outcome.status,
            ...(outcome.error !== undefined ? { remoteError: outcome.error } : {}),
          },
        );
      if (turn) await this.deliver(runId, turn.deliverables, deadline);
      return { stopReason: "end_turn", durationMs: this.clock.now() - started };
    } finally {
      // Questions still being asked belong to this turn only.
      current.abort.abort();
      if (this.current === current) this.current = undefined;
    }
  }

  // ------------------------------------------------------------------ admission

  private async admit(task: string, key: string, deadline: number, signal?: AbortSignal): Promise<string> {
    const vars = { [this.options.agent.promptVar ?? "prompt"]: task };
    const params = {
      workflowId: this.options.agent.workflow!,
      vars,
      idempotencyKey: key,
      expectedScope: this.scope,
    };
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new OrcaError("CANCELLED", "cancelled before the remote run was admitted");
      try {
        let receipt = RunsAdmitResultSchema.parse(await this.client.call("runs.admit", params, { signal }));
        // A prepared or recoverable admission settles through its receipt, never a new submit.
        while (receipt.state !== "accepted") {
          if (receipt.state === "recoverable-failure" && receipt.runId) return receipt.runId;
          await sleep(this.pollMs, signal);
          if (signal?.aborted) throw new OrcaError("CANCELLED", "cancelled while the remote run was admitted");
          const method = receipt.state === "recoverable-failure" ? "admissions.reconcile" : "admissions.get";
          const settled = (await this.client.call(method, { operationId: receipt.operationId }, { signal })) as {
            state: string;
            result?: unknown;
          };
          if (settled.state === "resolved") receipt = RunsAdmitResultSchema.parse(settled.result);
          if (this.clock.now() > deadline)
            throw new OrcaError(
              "STEP_TIMEOUT",
              "the remote daemon did not settle the admission within the turn timeout",
              {
                profile: this.options.profile,
              },
            );
        }
        return receipt.runId;
      } catch (error) {
        if (error instanceof OrcaError) throw error;
        if (signal?.aborted) {
          // Cancelled with the admission's answer in flight: the remote may have admitted the
          // run. The same key replays that admission (or makes it), so it can be cancelled
          // rather than left running for nobody.
          await this.client
            .call("runs.admit", params, { timeoutMs: 10_000 })
            .then((answer) => {
              const receipt = RunsAdmitResultSchema.safeParse(answer);
              if (receipt.success && receipt.data.state === "accepted")
                return this.cancelRemote(receipt.data.runId, "cancelled by the delegating run");
              return undefined;
            })
            .catch(() => undefined);
          throw new OrcaError("CANCELLED", "cancelled while the remote run was admitted");
        }
        if (error instanceof RemoteFault) {
          if (error.code === "AUTH_FORBIDDEN" && /scope/i.test(error.message))
            throw delegationRefusal(
              this.options.profile,
              "scope-changed",
              "The remote daemon's credential or workspace changed since this session opened; the run was not admitted.",
            );
          // The same key while the first admission is still in flight: wait for it.
          if (error.code !== "RUN_STATE") throw classify(this.options.profile, this.options.transport, error);
        } else if (this.options.transport.failed()) throw classify(this.options.profile, this.options.transport, error);
        if (this.clock.now() > deadline)
          throw new OrcaError("AGENT_TRANSPORT", "the remote daemon could not be reached to admit the run", {
            profile: this.options.profile,
          });
        this.logger.warn("delegation admission retrying", { profile: this.options.profile, attempt });
        await sleep(Math.min(this.pollMs * 2 ** Math.min(attempt, 5), 30_000), signal);
      }
    }
  }

  // ------------------------------------------------------------------ following

  private async follow(
    runId: string,
    deadline: number,
    signal: AbortSignal | undefined,
    current: Turn,
  ): Promise<Terminal | "cancelled" | "timeout"> {
    let cursor: number | undefined;
    const asked = new Set<string>();
    let unreachableSince: number | undefined;
    for (;;) {
      if (signal?.aborted || current.cancelled) {
        if (!current.cancelled) {
          current.cancelled = true;
          await this.cancelRemote(runId, "cancelled by the delegating run");
        }
        return "cancelled";
      }
      if (this.clock.now() > deadline) return "timeout";
      if (this.closing)
        throw new OrcaError("AGENT_TRANSPORT", "the delegating session was closed while its remote run was followed", {
          profile: this.options.profile,
          remoteRunId: runId,
        });
      if (current.failure !== undefined) {
        // The parent parked or failed on a forwarded question: the remote run must not go on
        // waiting for an answer nobody will send through this turn.
        current.cancelled = true;
        await this.cancelRemote(runId, "the delegating step stopped on a forwarded question");
        throw current.failure;
      }
      try {
        let terminal = false;
        // Every page the cursor has, then the open questions; each is idempotent to repeat.
        for (;;) {
          const page = RunsEventsResultSchema.parse(
            await this.client.call("runs.events", {
              runId,
              ...(cursor !== undefined ? { after: cursor } : {}),
              limit: 200,
            }),
          );
          for (const event of page.events) {
            this.relay(event);
            if (TERMINAL_EVENTS.has(event.type)) terminal = true;
          }
          if (page.nextCursor !== undefined) cursor = page.nextCursor;
          if (!page.hasMore) break;
        }
        if (terminal) return await this.settled(runId);
        const open = InputsListResultSchema.parse(await this.client.call("inputs.list", { runId }));
        for (const input of open.inputs)
          if (!asked.has(input.id)) {
            asked.add(input.id);
            void this.forward(input, current);
          }
        if (unreachableSince !== undefined) {
          this.note(`Reattached to run ${runId} on ${this.options.remoteName}.`);
          unreachableSince = undefined;
        }
      } catch (error) {
        // A read that raced a write to the remote run's log (`RUN_STATE`) is read again.
        if (error instanceof RemoteFault && error.code === "RUN_STATE") {
          await sleep(this.pollMs, signal);
          continue;
        }
        if (error instanceof RemoteFault || this.options.transport.failed())
          throw classify(this.options.profile, this.options.transport, error);
        if (unreachableSince === undefined) {
          unreachableSince = this.clock.now();
          this.note(`Lost the connection to ${this.options.remoteName}; reattaching to run ${runId}.`);
        }
      }
      await sleep(this.pollMs, signal);
    }
  }

  private async settled(runId: string): Promise<Terminal> {
    const state = RunsGetResultSchema.parse(await this.client.call("runs.get", { runId }));
    const status = state.run.status;
    if (status === "succeeded") return { status };
    return {
      status: status === "cancelled" ? "cancelled" : "failed",
      ...(state.run.error ? { error: state.run.error } : {}),
    };
  }

  /** One remote event as this session's update: the remote agents' own, and step milestones. */
  private relay(event: { type: string; payload?: unknown }): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "agent.update":
        this.emit(payload.update as AgentUpdateSummary);
        return;
      case "step.scheduled":
        this.note(`${this.options.remoteName}: step ${String(payload.nodeId)} started.`);
        return;
      case "step.failed":
        this.note(`${this.options.remoteName}: a step failed${payload.willRetry ? " and will be retried" : ""}.`);
        return;
      case "run.paused":
        this.note(`${this.options.remoteName}: the run is waiting for an answer.`);
        return;
      default:
        return;
    }
  }

  /** Ask the parent an open remote input, and answer it on the remote with what the parent chose. */
  private async forward(input: OpenInputView, turn: Turn): Promise<void> {
    if (input.options.length === 0 || !this.options.askPermission) {
      this.note(`${this.options.remoteName} asks "${input.question}"; answer it on that daemon.`);
      return;
    }
    let optionId: string | undefined;
    try {
      // The same shape as an ACP agent's permission ask, so the parent's live and parked
      // question flows take it unchanged. Every option is a one-time choice: a remote gate's
      // answer is never a standing rule here.
      optionId = await this.options.askPermission(
        {
          sessionId: this.acpSessionId,
          toolCall: {
            toolCallId: `remote:${input.id}`,
            title: `${this.options.remoteName}: ${input.question}`,
            kind: "other",
            status: "pending",
            rawInput: { remoteRunId: input.runId, remoteRequestId: input.id, kind: input.kind },
          },
          options: input.options.map((o) => ({
            optionId: o.id,
            name: o.label,
            kind: o.destructive ? ("reject_once" as const) : ("allow_once" as const),
          })),
        },
        { sessionId: this.id, turnId: turn.id, invocationId: randomUUID(), signal: turn.abort.signal },
      );
    } catch (error) {
      if (!turn.abort.signal.aborted)
        turn.failure =
          error instanceof Error ? error : new OrcaError("INTERNAL", "forwarding a remote question failed");
      return;
    }
    if (optionId === undefined || turn.abort.signal.aborted) return;
    // The remote re-drives its run under the answer and replies once it parks again or ends,
    // which may be long after this; the follow loop sees the outcome either way.
    void this.client
      .call(
        "inputs.answer",
        {
          requestId: input.id,
          runId: input.runId,
          optionId,
          ...(input.live ? { live: input.live.target } : {}),
          resume: true,
        },
        { timeoutMs: 24 * 60 * 60_000 },
      )
      .catch((error: unknown) => {
        if (error instanceof RemoteFault && error.code === "INPUT_ANSWERED") return;
        if (error instanceof RemoteUnreachable) return;
        this.logger.warn("forwarded answer refused", { profile: this.options.profile, error: String(error) });
        this.note(`${this.options.remoteName} did not take the answer to "${input.question}".`);
      });
  }

  private async cancelRemote(runId: string, reason: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.call("runs.cancel", { runId, reason });
        return;
      } catch (error) {
        // A run that already ended cannot be cancelled, and that is fine.
        if (error instanceof RemoteFault) return;
        await sleep(this.pollMs);
      }
    }
    this.logger.warn("could not cancel the remote run", { profile: this.options.profile, runId });
  }

  // ------------------------------------------------------------------ artifacts

  private async deliver(runId: string, deliverables: readonly TurnDeliverable[], deadline: number): Promise<void> {
    if (deliverables.length === 0) return;
    const listed = ArtifactsListResultSchema.parse(await this.call("artifacts.list", { runId, limit: 500 }, deadline));
    // Newest first: a later attempt's artifact wins over an earlier one of the same name.
    const remote = [...listed.artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const d of deliverables) {
      const match = remote.find((a) => (d.name ? a.name === d.name : a.kind === d.kind));
      if (!match) continue;
      const got = ArtifactsGetResultSchema.parse(await this.call("artifacts.get", { artifactId: match.id }, deadline));
      if (got.text === undefined) {
        this.note(
          `${this.options.remoteName}: artifact ${match.name} was not brought back (${got.omitted?.reason ?? "no text"}).`,
        );
        continue;
      }
      await this.options.host.fs.mkdirp(parentOf(d.path));
      await this.options.host.fs.writeFile(d.path, got.text);
    }
  }

  /** A read that may be repeated: retried across a lost connection until the deadline. */
  private async call(method: string, params: unknown, deadline: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.call(method, params);
      } catch (error) {
        if (error instanceof RemoteFault || this.options.transport.failed() || this.clock.now() > deadline)
          throw classify(this.options.profile, this.options.transport, error);
        await sleep(Math.min(this.pollMs * 2 ** Math.min(attempt, 5), 30_000));
      }
    }
  }

  // ------------------------------------------------------------------ updates

  private note(text: string): void {
    this.emit({ kind: "agent_thought_chunk", text: `${text}\n` });
  }

  private emit(summary: AgentUpdateSummary | undefined): void {
    if (!summary || typeof summary.kind !== "string") return;
    const raw = {
      sessionUpdate: summary.kind === "agent_message_chunk" ? "agent_message_chunk" : "agent_thought_chunk",
      content: { type: "text", text: summary.text ?? "" },
    } as RawUpdate;
    const event: SessionUpdateEvent = { sessionId: this.acpSessionId, raw, summary, at: this.clock.now() };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn("session update listener failed", { error: String(error) });
      }
    }
  }
}

function textOf(blocks: ContentBlocks): string {
  return blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}
