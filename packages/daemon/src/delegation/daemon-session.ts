/**
 * A daemon-backed `AgentSession` (#883): a step whose agent is `type: orca-daemon` runs as a
 * run of a named workflow on another ORCA daemon, reached over the remote profile's SSH
 * tunnel (`@orca/protocol/remote-access`, #874), with the credential that daemon issued.
 *
 * - **Only to the enrolled daemon.** The session is opened over a tunnel that trusts only the
 *   host keys sealed at enrollment (`orca remote enroll`), and refuses before any admission
 *   unless the daemon there names the enrolled workspace and principal; every admission is
 *   bound to them with `expectedScope`.
 * - **One logical delegation, one remote run at a time.** A step's delegation is named by its
 *   first attempt (`TurnContext.delegationId`) and recorded in a durable receipt
 *   (`receipts.ts`) before anything is sent. An engine retry or a restart of this daemon reads
 *   the receipt: it re-sends the same idempotency key while the answer is unknown, follows the
 *   admitted run, and submits replacement work only once the earlier run is verified ended
 *   without success, or verified never admitted.
 * - **Cancel never creates work.** Cancelled while an admission's answer is unknown, the
 *   session fences the key (`admissions.fence`: afterwards no admission under it can admit a
 *   run) or, if a run was already admitted, cancels it and reads it until it is seen ended.
 *   Until one of those is authoritative the receipt stays `cancel-pending`, and each later
 *   session to the remote takes it a step further; nothing in that state submits.
 * - **Progress follows the remote log** by cursor (`runs.events`): remote step milestones and
 *   the remote agents' own updates become this session's updates, and so the parent step's
 *   `agent.update` events.
 * - **Gates are forwarded.** An open input on the remote run (or its children) is asked through
 *   the parent's `askPermission`, and the parent's answer is sent back with `inputs.answer`.
 * - **Reattach, not resubmit.** A connection lost mid-run is retried until the turn's deadline;
 *   the session keeps the remote run id and its cursor, so it picks up where it was. A terminal
 *   event, once seen, stays latched until the run's authoritative result has been read.
 * - **Cancellation reaches the remote run** (`runs.cancel`), whether the parent cancelled the
 *   step or its turn timed out.
 * - **Artifacts come back** once the remote run succeeds: each of the step's deliverables is
 *   matched to an artifact of the run's own succeeded steps by name (else kind), checked
 *   against the remote's record of it (size and sha256), and written to the deliverable's path
 *   on the agent's host, where the step collects it like any agent's output.
 * - **Gates are answered only on the delegated run** or a descendant the remote's own run
 *   records tie to it, and every remote call is bounded by the turn's signal and deadline.
 * - **Refusals are typed.** What a retry cannot fix fails `DELEGATION_REFUSED` with
 *   `details.reason`; a lost connection that outlives the turn is `AGENT_TRANSPORT`; a remote
 *   run that ends without success is `DELEGATED_RUN_FAILED`.
 *
 * `terminated` resolves once every ssh process of the session's tunnel has exited, so the
 * session's slot (#873) comes back only then.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  newId,
  OrcaError,
  RunOriginSchema,
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
  AdmissionsFindResultSchema,
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
  type ArtifactView,
  type OpenInputView,
} from "@orca/protocol";
import { RemoteDaemonClient, RemoteFault, RemoteUnreachable } from "./remote-client.js";
import {
  delegationKey,
  ReceiptConflict,
  sameBinding,
  type DelegationBinding,
  type DelegationReceipt,
  type DelegationReceipts,
} from "./receipts.js";

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
  "admissions.find",
  "admissions.fence",
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
  | "not-enrolled"
  | "tunnel"
  | "auth"
  | "protocol"
  | "admission-closed"
  | "workflow"
  | "git-ref"
  | "scope-changed"
  | "enrollment-in-progress";

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
  /**
   * What enrollment proved the remote daemon names (its workspace and principal), with the
   * enrollment and delegation configuration they were proven for: the session refuses any
   * other daemon, and acts only on receipts made under this same binding.
   */
  binding: DelegationBinding;
  /** Where this daemon records what it asked the remote to run. */
  receipts: DelegationReceipts;
  askPermission?: (req: PermissionRequest, invocation?: PermissionInvocation) => Promise<string | undefined>;
  logger?: Logger;
  clock?: Clock;
  /** How often the remote run is read while it runs. Default 1 s. */
  pollMs?: number;
  /** Per-call limit for remote calls. Default 30 s. */
  callTimeoutMs?: number;
  /**
   * This daemon's workspace id. With it, each admission states its origin (this workspace,
   * the parent run and the step) to a remote whose `hello.admitFields` lists `origin` (#883).
   */
  originWorkspaceId?: string;
  /**
   * The remote's enrollment, as this session sees it (#883 part 4). New work is not submitted
   * while an enrollment is under way, nor once the record no longer is the one `binding` was
   * made from: either could publish a generation that strands the receipt.
   */
  enrollment?: {
    /** An enrollment of this remote is running now. */
    inProgress(): boolean;
    /** The active record is still the one `binding` names. */
    current(): boolean;
  };
}

/** The turn in flight: its remote run, and what its forwarded questions are bound to. */
interface Turn {
  runId: string;
  cancelled: boolean;
  /** The cancel sent to the remote run: the run's terminal status once seen, else undefined. */
  cancelling?: Promise<Terminal["status"] | undefined>;
  id: string;
  /** The turn's deadline: every call made for it is bounded by it. */
  deadline: number;
  /** The delegated run and the descendants it was verified to have. */
  owned: Set<string>;
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

/** How long a cancel is read for before it is left to a later session to confirm. */
const CANCEL_CONFIRM_MS = 30_000;
/** Event pages read per follow round, so a long log cannot hold the loop past its checks. */
const MAX_PAGES_PER_ROUND = 50;
/** How deep a remote input's run may sit below the delegated run. */
const MAX_CHILD_DEPTH = 8;

/** The workspace and principal every remote mutation for a receipt is scoped to. */
/**
 * Whether a daemon takes `runs.admit` `gitRef`: only when its `hello` lists the field in
 * `admitFields`, never on the strength of a protocol minor.
 */
export function takesGitRef(hello: { admitFields?: readonly string[] | undefined }): boolean {
  return hello.admitFields?.includes("gitRef") ?? false;
}

/**
 * Whether a daemon takes `runs.admit` `origin`: only when its `hello` lists the field in
 * `admitFields`, never on the strength of a protocol minor (another 2.6 need not have it).
 */
export function recordsOrigin(hello: { admitFields?: readonly string[] | undefined }): boolean {
  return hello.admitFields?.includes("origin") ?? false;
}

function scopeOf(receipt: DelegationReceipt): { workspaceId: string; principalId: string } {
  return { workspaceId: receipt.binding.workspaceId, principalId: receipt.binding.principalId };
}

/** Why a remote artifact's copy does not match its record, or undefined when it does. */
function artifactMismatch(listed: ArtifactView, got: ArtifactView, text: string): string | undefined {
  if (got.id !== listed.id || got.name !== listed.name || got.kind !== listed.kind) return "identity";
  if (got.producedByStepRunId !== listed.producedByStepRunId) return "producing step";
  if (!got.contentHash || got.contentHash !== listed.contentHash) return "no matching digest";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length !== got.size) return "size";
  if (createHash("sha256").update(bytes).digest("hex") !== got.contentHash) return "digest";
  return undefined;
}

/**
 * Open a session on a remote daemon: `hello` (the protocol must match, every delegation
 * method must be served, and the workspace must be the enrolled one), then `operator.discover`
 * (the credential's principal and the remote workspace must be the enrolled ones). Then any
 * cancelled admission to this remote whose fate is still unknown is looked up again.
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
    const changed = (what: string) =>
      refuse(
        "scope-changed",
        `The daemon on ${options.remoteName} now names a different ${what} than when it was enrolled. Nothing was sent to run. If the change is intended, run \`orca remote enroll ${options.profile}\` again.`,
      );
    const missing = DELEGATION_METHODS.filter((m) => !hello.methods?.includes(m));
    if (missing.length)
      throw refuse(
        "admission-closed",
        `The daemon on ${options.remoteName} does not take delegated runs (it does not answer ${missing.join(", ")}). It may be read-only, not in token mode, or an older ORCA.`,
        { missing },
      );
    if (hello.identity && hello.identity.workspaceId !== options.binding.workspaceId) throw changed("workspace");
    // A named ref is never dropped: a daemon that cannot take one would run the wrong code.
    if (options.agent.gitRef !== undefined && !takesGitRef(hello))
      throw refuse(
        "protocol",
        `The daemon on ${options.remoteName} speaks protocol ${formatProtocolVersion(hello.protocol)}, and does not take the git ref this agent names (its hello does not list \`gitRef\` in admitFields). Update ORCA there, or remove gitRef.`,
        { remoteProtocol: formatProtocolVersion(hello.protocol) },
      );
    const discovery = OperatorDiscoverySchema.parse(
      await client.call("operator.discover", {}).catch((e: unknown) => {
        throw fault(e);
      }),
    );
    if (discovery.target.workspaceId !== options.binding.workspaceId) throw changed("workspace");
    if (discovery.principalId !== options.binding.principalId) throw changed("principal");
    if (!discovery.operations.includes("runs.admit"))
      throw refuse(
        "auth",
        `The credential for ${options.remoteName} may not start runs there. Issue one with the client preset.`,
        { principal: discovery.principalId },
      );
    const session = new DaemonSession(
      options,
      client,
      clock,
      logger,
      { principalId: discovery.principalId, workspaceId: discovery.target.workspaceId },
      recordsOrigin(hello),
    );
    await session.sweep();
    return session;
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
    if (error.code === "NOT_SUPPORTED" && error.details && typeof error.details.gitRef === "string")
      return delegationRefusal(
        profile,
        "git-ref",
        `The remote daemon cannot work from that git ref: ${error.message}`,
        {
          remoteCode: error.code,
          gitRef: error.details.gitRef,
        },
      );
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
    /** The remote's `hello.admitFields` lists `origin`. */
    private readonly takesOrigin = false,
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
    await (current.cancelling ??= this.cancelAndConfirm(current.runId, "cancelled by the delegating run"));
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
    if (!turn)
      throw new OrcaError("NOT_SUPPORTED", "a delegated agent runs workflow steps only", {
        profile: this.options.profile,
      });
    const deadline = started + (options.timeoutMs ?? this.options.agent.turnTimeoutMs);
    if (turn.followUp > 0) {
      // The remote run already ended and delivered what it had; asking again would start a
      // second remote run for the same step. What is still missing stays missing.
      this.note(`The remote run for this step already finished; ${this.options.remoteName} is not asked again.`);
      return { stopReason: "end_turn", durationMs: 0 };
    }
    const task = turn.task || (typeof input === "string" ? input : textOf(input));
    const signal = options.signal;
    let receipt = await this.resolve(turn, task, deadline, signal);
    const runId = receipt.remoteRunId!;
    if (receipt.state === "settled") {
      // This delegation's run already succeeded (an earlier attempt, or this daemon before a
      // restart, did not get to record the step): its artifacts are brought back again.
      this.note(
        `The remote run ${runId} on ${this.options.remoteName} already succeeded; bringing its artifacts back.`,
      );
      await this.deliver(runId, turn.deliverables, deadline, signal);
      return { stopReason: "end_turn", durationMs: this.clock.now() - started };
    }
    const current: Turn = {
      runId,
      cancelled: false,
      id: randomUUID(),
      abort: new AbortController(),
      deadline,
      owned: new Set([runId]),
    };
    this.current = current;
    this.note(`Delegated to ${this.options.remoteName} as run ${runId}.`);
    /** Record a transition; one another session already made a newer decision on loses. */
    const record = (next: DelegationReceipt) => {
      try {
        receipt = this.store(next);
      } catch (error) {
        if (!(error instanceof ReceiptConflict)) throw error;
        this.logger.warn("delegation receipt changed by another session", { profile: this.options.profile, runId });
      }
    };
    const settle = (outcome: NonNullable<DelegationReceipt["outcome"]>) =>
      record({ ...receipt, state: "settled", outcome });
    /** After a cancel: settled once the run is seen ended, else the intent is kept for later. */
    const afterCancel = (status: Terminal["status"] | undefined) => {
      if (receipt.state !== "admitted") return;
      if (status) settle(status);
      else record({ ...receipt, state: "cancel-pending" });
    };
    try {
      const outcome = await this.follow(runId, deadline, signal, current);
      if (outcome === "cancelled") {
        afterCancel(await current.cancelling);
        return { stopReason: "cancelled", durationMs: this.clock.now() - started };
      }
      if (outcome === "timeout") {
        afterCancel(await (current.cancelling ??= this.cancelAndConfirm(runId, "the delegating step timed out")));
        throw new OrcaError("STEP_TIMEOUT", `the remote run ${runId} did not finish within the turn timeout`, {
          profile: this.options.profile,
          remoteRunId: runId,
        });
      }
      settle(outcome.status);
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
      await this.deliver(runId, turn.deliverables, deadline, signal);
      return { stopReason: "end_turn", durationMs: this.clock.now() - started };
    } catch (error) {
      // A turn that ended on its own cancel (a forwarded question the parent could not take).
      if (current.cancelling) afterCancel(await current.cancelling);
      throw error;
    } finally {
      // Questions still being asked belong to this turn only.
      current.abort.abort();
      if (this.current === current) this.current = undefined;
    }
  }

  // ------------------------------------------------------------------ receipts

  /**
   * Replace this delegation's receipt (durable before it returns), if it is still the revision
   * it was read at; `ReceiptConflict` otherwise. A receipt without a revision must be new.
   */
  private store(
    receipt: Omit<DelegationReceipt, "version" | "updatedAt" | "revision" | "instance"> & {
      revision?: number;
      instance?: string;
    },
  ): DelegationReceipt {
    const { version: _v, updatedAt: _u, ...rest } = receipt as DelegationReceipt;
    return this.options.receipts.write(rest);
  }

  /**
   * The remote run this turn follows: an `admitted` receipt, or a `settled` one whose run
   * succeeded. Reads the delegation's receipt and submits only what it proves safe to submit
   * (see `receipts.ts`): never while an earlier admission's fate is unknown, and never to
   * settle a cancellation.
   */
  private async resolve(
    turn: TurnContext,
    task: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<DelegationReceipt> {
    const { runId: parentRunId, delegationId } = turn;
    const wait = async (what: string) => {
      if (this.clock.now() > deadline)
        throw new OrcaError("STEP_TIMEOUT", `${what} did not settle within the turn timeout`, {
          profile: this.options.profile,
        });
      await sleep(this.pollMs, signal);
    };
    for (;;) {
      if (signal?.aborted) throw new OrcaError("CANCELLED", "cancelled before the remote run was admitted");
      const receipt = this.options.receipts.read(parentRunId, delegationId);
      // A reservation made under another binding was never sent under: back it out, then decide.
      if (
        receipt?.state === "reserved" &&
        (receipt.profile !== this.options.profile || !sameBinding(receipt.binding, this.options.binding))
      ) {
        try {
          this.options.receipts.unreserve(receipt);
        } catch (error) {
          if (!(error instanceof ReceiptConflict)) throw error;
        }
        continue;
      }
      if (receipt && (receipt.profile !== this.options.profile || !sameBinding(receipt.binding, this.options.binding)))
        throw delegationRefusal(
          this.options.profile,
          "scope-changed",
          `This step was delegated under remote ${receipt.profile} as it was enrolled and configured then, and that has changed since (the remote, its enrollment, or the agent's workflow). Nothing was sent; cancel the run and start it again to delegate under the new one.`,
          { delegatedTo: receipt.profile },
        );
      try {
        const settledReceipt = await this.step(receipt, turn, task, deadline, signal, wait);
        if (settledReceipt) return settledReceipt;
      } catch (error) {
        // Another session moved the receipt on: read it again and decide anew.
        if (!(error instanceof ReceiptConflict)) throw error;
      }
    }
  }

  /**
   * The origin a new generation states (#883): this daemon's workspace, the parent run and the
   * step's first attempt, which stays the same across retries of the step. Only for a remote
   * that takes it; a 2.5 daemon refuses the unknown field.
   */
  private originOf(turn: TurnContext): Pick<DelegationReceipt, "origin"> {
    if (!this.takesOrigin || !this.options.originWorkspaceId) return {};
    // Canonical ids only, as the remote checks them; an origin that is not one is left out.
    const origin = RunOriginSchema.safeParse({
      workspaceId: this.options.originWorkspaceId,
      runId: turn.runId,
      stepRunId: turn.delegationId,
    });
    return origin.success ? { origin: origin.data } : {};
  }

  /** One decision on a delegation's receipt: the receipt to follow, or undefined to read again. */
  private async step(
    receipt: DelegationReceipt | undefined,
    turn: TurnContext,
    task: string,
    deadline: number,
    signal: AbortSignal | undefined,
    wait: (what: string) => Promise<void>,
  ): Promise<DelegationReceipt | undefined> {
    const { runId: parentRunId, delegationId } = turn;
    if (!receipt) {
      // Reserved first: not submittable by anyone until it passes the enrollment gate.
      const fresh = this.store({
        profile: this.options.profile,
        binding: this.options.binding,
        parentRunId,
        delegationId,
        generation: 0,
        key: delegationKey(parentRunId, delegationId, 0),
        state: "reserved",
        ...this.originOf(turn),
      });
      return this.promote(fresh, task, deadline, signal, wait);
    }
    switch (receipt.state) {
      case "reserved":
        // Another session's reservation, or one a crash left: nothing was sent under it.
        return this.promote(receipt, task, deadline, signal, wait);
      case "admitted": {
        // Reattach only to a run that may still go on; one that ended is settled first.
        const ended = await this.call("runs.get", { runId: receipt.remoteRunId! }, deadline, signal).then(
          (answer) => RunsGetResultSchema.parse(answer).run.status,
        );
        if (ended !== "succeeded" && ended !== "failed" && ended !== "cancelled") return receipt;
        this.store({ ...receipt, state: "settled", outcome: ended });
        return undefined;
      }
      case "submitting":
        // The answer was never learned. The same key replays the admission if it was made.
        return this.submit(receipt, task, deadline, signal);
      case "cancel-pending":
        // A cancellation still being settled. Nothing here submits: the key is fenced or its
        // run is cancelled, and only once that is authoritative may a new generation start.
        if (!(await this.settleCancel(receipt, deadline, signal))) await wait("an earlier cancellation");
        return undefined;
      case "settled": {
        if (receipt.outcome === "succeeded" && receipt.remoteRunId) return receipt;
        // The earlier run is verified ended without success, or verified never admitted.
        const generation = receipt.generation + 1;
        const next = this.store({
          revision: receipt.revision,
          instance: receipt.instance,
          profile: this.options.profile,
          binding: this.options.binding,
          parentRunId,
          delegationId,
          generation,
          key: delegationKey(parentRunId, delegationId, generation),
          state: "reserved",
          previous: {
            generation: receipt.generation,
            key: receipt.key,
            outcome: receipt.outcome!,
            ...(receipt.remoteRunId ? { remoteRunId: receipt.remoteRunId } : {}),
            ...(receipt.origin ? { origin: receipt.origin } : {}),
          },
          ...this.originOf(turn),
        });
        return this.promote(next, task, deadline, signal, wait);
      }
    }
  }

  /**
   * After a new generation's receipt is durable and before anything is sent under it: proceed
   * only while no enrollment of the remote is running and the record is still the one this
   * session is bound to. An enrollment checks for unsettled receipts after taking its lock, and
   * this checks its lock after writing the receipt, so one of the two always sees the other.
   * Otherwise the receipt is backed out (nothing was sent under it), the enrollment is waited
   * out, and the turn goes on only if the record did not change.
   */
  private async enrollmentGate(stored: DelegationReceipt, wait: (what: string) => Promise<void>): Promise<boolean> {
    const gate = this.options.enrollment;
    if (!gate || (!gate.inProgress() && gate.current())) return true;
    this.options.receipts.unreserve(stored);
    while (gate.inProgress()) await wait(`the enrollment of remote ${this.options.remoteName}`);
    if (!gate.current())
      throw delegationRefusal(
        this.options.profile,
        "scope-changed",
        `Remote ${this.options.remoteName} was enrolled again while this step was starting. Nothing was sent; retry the step to delegate under the new enrollment.`,
      );
    return false;
  }

  /**
   * A `reserved` receipt becomes `submitting` (and is submitted) only through the enrollment
   * gate, and only by the one session whose compare-and-swap promotes that exact revision;
   * every other session reads it again. Backed out instead when the gate is closed.
   */
  private async promote(
    reserved: DelegationReceipt,
    task: string,
    deadline: number,
    signal: AbortSignal | undefined,
    wait: (what: string) => Promise<void>,
  ): Promise<DelegationReceipt | undefined> {
    if (!(await this.enrollmentGate(reserved, wait))) return undefined;
    const { previous: _p, version: _v, updatedAt: _u, ...rest } = reserved;
    const submitting = this.store({ ...rest, state: "submitting" });
    return this.submit(submitting, task, deadline, signal);
  }

  /**
   * One step towards settling a `cancel-pending` receipt; true once it is `settled`. Without a
   * run, the key is fenced (`admissions.fence`): then no admission under it can ever make one,
   * or the run it already made is named. With a run, the run is cancelled and read until it is
   * seen ended. Anything less leaves the receipt as it is.
   */
  private async settleCancel(receipt: DelegationReceipt, deadline: number, signal?: AbortSignal): Promise<boolean> {
    let runId = receipt.remoteRunId;
    if (runId === undefined) {
      const fenced = await this.fence(receipt, deadline, signal);
      if (fenced === "pending") return false;
      if (fenced === "fenced") {
        this.store({ ...receipt, state: "settled", outcome: "never-admitted" });
        return true;
      }
      runId = fenced.runId;
      receipt = this.store({ ...receipt, remoteRunId: runId });
    }
    const status = await this.cancelAndConfirm(runId, "cancelled by the delegating run");
    if (!status) return false;
    this.store({ ...receipt, state: "settled", outcome: status });
    return true;
  }

  /**
   * Claim the receipt's key so no admission under it can admit a run, in the receipt's own
   * workspace and principal and for its own workflow: `fenced`, the run an admission under it
   * is seen to have made, or `pending` (an admission still being prepared, a recoverable one
   * whose reserved run does not exist, or no answer). Nothing here can admit a run.
   */
  private async fence(
    receipt: DelegationReceipt,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<{ runId: string } | "fenced" | "pending"> {
    let answer: unknown;
    try {
      answer = await this.client.call(
        "admissions.fence",
        {
          idempotencyKey: receipt.key,
          workflowId: receipt.binding.workflowId,
          expectedScope: scopeOf(receipt),
        },
        this.bounded(deadline, signal),
      );
    } catch (error) {
      if (error instanceof RemoteFault || this.options.transport.failed())
        throw classify(this.options.profile, this.options.transport, error);
      return "pending";
    }
    const found = AdmissionsFindResultSchema.parse(answer);
    if (found.state !== "resolved") return "pending";
    // The retained result, without the wire receipt's operation id.
    const result = (found.result ?? {}) as { state?: unknown; runId?: unknown };
    if (result.state === "fenced") return "fenced";
    if (result.state === "recoverable-failure") {
      // Never reconcile here: reconciling can admit the reserved run. Only a run that already
      // exists under the reserved id is a cancel target; otherwise the outcome stays unknown
      // and the receipt stays cancel-pending until a later look finds the run or none.
      if (typeof result.runId !== "string") return "pending";
      try {
        const state = RunsGetResultSchema.parse(
          await this.client.call("runs.get", { runId: result.runId }, this.bounded(deadline, signal)),
        );
        return state.run.id === result.runId ? { runId: result.runId } : "pending";
      } catch (error) {
        if (!(error instanceof RemoteFault) && this.options.transport.failed())
          throw classify(this.options.profile, this.options.transport, error);
        return "pending";
      }
    }
    if (result.state === "accepted" && typeof result.runId === "string") return { runId: result.runId };
    return "pending";
  }

  /**
   * Settle what earlier sessions left cancel-pending for this remote, one step each. Best
   * effort; never fails the open.
   */
  async sweep(): Promise<void> {
    let pending: DelegationReceipt[];
    try {
      pending = this.options.receipts.cancelPending(this.options.binding);
    } catch {
      return;
    }
    for (const receipt of pending) {
      try {
        await this.settleCancel(receipt, this.clock.now() + 10_000);
      } catch (error) {
        this.logger.warn("delegation sweep could not settle a cancelled admission", {
          profile: this.options.profile,
          error: String(error),
        });
      }
    }
  }

  // ------------------------------------------------------------------ admission

  /** Send the receipt's admission (same key every time) until it is accepted; `admitted` after. */
  private async submit(
    receipt: DelegationReceipt,
    task: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<DelegationReceipt> {
    const params = {
      workflowId: receipt.binding.workflowId,
      vars: { [this.options.agent.promptVar ?? "prompt"]: task },
      idempotencyKey: receipt.key,
      expectedScope: scopeOf(receipt),
      ...(receipt.origin ? { origin: receipt.origin } : {}),
      ...(this.options.agent.gitRef !== undefined ? { gitRef: this.options.agent.gitRef } : {}),
    };
    // The receipt's admission is replayed exactly as it was first sent: an origin it carries is
    // part of that command. A remote that no longer takes one is refused, never sent less.
    if (receipt.origin && !this.takesOrigin)
      throw delegationRefusal(
        this.options.profile,
        "protocol",
        `The daemon on ${this.options.remoteName} no longer takes a run origin, which this step's earlier admission stated. Nothing was sent; update ORCA there to settle the step.`,
      );
    const admitted = (runId: string) => this.store({ ...receipt, state: "admitted", remoteRunId: runId });
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) return this.abandon(receipt, deadline);
      try {
        let answer = RunsAdmitResultSchema.parse(
          await this.client.call("runs.admit", params, this.bounded(deadline, signal)),
        );
        // A prepared or recoverable admission settles through its receipt, never a new submit;
        // a recoverable failure's reserved run id is followed only once reconcile accepts it.
        while (answer.state !== "accepted") {
          await sleep(this.pollMs, signal);
          if (signal?.aborted) return this.abandon(receipt, deadline);
          if (this.clock.now() > deadline)
            throw new OrcaError(
              "STEP_TIMEOUT",
              "the remote daemon did not settle the admission within the turn timeout",
              {
                profile: this.options.profile,
              },
            );
          const method = answer.state === "recoverable-failure" ? "admissions.reconcile" : "admissions.get";
          const settled = (await this.client.call(
            method,
            { operationId: answer.operationId, expectedScope: scopeOf(receipt) },
            this.bounded(deadline, signal),
          )) as { state: string; result?: unknown };
          // The retained result carries no operation id; the receipt's is the same operation.
          if (settled.state === "resolved")
            answer = RunsAdmitResultSchema.parse({
              operationId: answer.operationId,
              ...(settled.result as Record<string, unknown>),
            });
        }
        return admitted(answer.runId);
      } catch (error) {
        // Another session moved the receipt on: back to the outer re-read before anything else
        // is sent.
        if (error instanceof ReceiptConflict || error instanceof OrcaError) throw error;
        if (signal?.aborted) return this.abandon(receipt, deadline);
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

  /**
   * Cancelled while an admission's answer is unknown. Nothing is sent that could admit work:
   * the receipt becomes `cancel-pending`, the key is fenced (or the run it made is cancelled),
   * and what cannot be settled now is settled by a later session to this remote.
   */
  private async abandon(receipt: DelegationReceipt, deadline: number): Promise<never> {
    const pending = this.store({ ...receipt, state: "cancel-pending" });
    try {
      await this.settleCancel(pending, Math.min(deadline, this.clock.now() + 10_000));
    } catch {
      // The receipt stays cancel-pending; the next session to this remote looks again.
    }
    throw new OrcaError("CANCELLED", "cancelled while the remote run was admitted");
  }

  // ------------------------------------------------------------------ following

  private async follow(
    runId: string,
    deadline: number,
    signal: AbortSignal | undefined,
    current: Turn,
  ): Promise<Terminal | "cancelled" | "timeout"> {
    let cursor: number | undefined;
    // Once a terminal event is seen it stays seen: the cursor is past it, so a lost read of the
    // authoritative result must be retried, never followed by more pages.
    let terminal = false;
    const asked = new Set<string>();
    let unreachableSince: number | undefined;
    for (;;) {
      if (signal?.aborted || current.cancelled) {
        current.cancelled = true;
        await (current.cancelling ??= this.cancelAndConfirm(runId, "cancelled by the delegating run"));
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
        await (current.cancelling ??= this.cancelAndConfirm(
          runId,
          "the delegating step stopped on a forwarded question",
        ));
        throw current.failure;
      }
      try {
        // The pages the cursor has (a bounded number per round), then the open questions;
        // each is idempotent to repeat.
        for (let pages = 0; !terminal && pages < MAX_PAGES_PER_ROUND; pages++) {
          const page = RunsEventsResultSchema.parse(
            await this.client.call(
              "runs.events",
              { runId, ...(cursor !== undefined ? { after: cursor } : {}), limit: 200 },
              this.bounded(deadline, signal),
            ),
          );
          for (const event of page.events) {
            this.relay(event);
            if (TERMINAL_EVENTS.has(event.type)) terminal = true;
          }
          if (page.nextCursor !== undefined) cursor = page.nextCursor;
          if (!page.hasMore) break;
        }
        if (terminal) {
          const result = await this.settled(runId, deadline, signal);
          if (result) return result;
          // The log said it ended, and the run was taken up again since: follow it on.
          terminal = false;
        }
        const open = InputsListResultSchema.parse(
          await this.client.call("inputs.list", { runId }, this.bounded(deadline, signal)),
        );
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
        if (unreachableSince === undefined && !signal?.aborted) {
          unreachableSince = this.clock.now();
          this.note(`Lost the connection to ${this.options.remoteName}; reattaching to run ${runId}.`);
        }
      }
      await sleep(this.pollMs, signal);
    }
  }

  /** The run's authoritative result, or undefined while it is not ended. */
  private async settled(runId: string, deadline: number, signal?: AbortSignal): Promise<Terminal | undefined> {
    const state = RunsGetResultSchema.parse(
      await this.client.call("runs.get", { runId }, this.bounded(deadline, signal)),
    );
    const status = state.run.status;
    if (status === "succeeded") return { status };
    if (status !== "failed" && status !== "cancelled") return undefined;
    return { status, ...(state.run.error ? { error: state.run.error } : {}) };
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

  /**
   * Whether `runId` is the delegated run or one of its descendants, by the remote's own run
   * records (each child names its parent): an input is answered only on a run this turn owns.
   */
  private async owns(turn: Turn, runId: string): Promise<boolean> {
    const chain: string[] = [];
    let id = runId;
    for (let depth = 0; depth < MAX_CHILD_DEPTH; depth++) {
      if (turn.owned.has(id)) {
        for (const owned of chain) turn.owned.add(owned);
        return true;
      }
      chain.push(id);
      const state = RunsGetResultSchema.parse(
        await this.client.call("runs.get", { runId: id }, this.bounded(turn.deadline, turn.abort.signal)),
      );
      if (!state.run.parentRunId) return false;
      id = state.run.parentRunId;
    }
    return false;
  }

  /** Ask the parent an open remote input, and answer it on the remote with what the parent chose. */
  private async forward(input: OpenInputView, turn: Turn): Promise<void> {
    let owned = false;
    try {
      owned = await this.owns(turn, input.runId);
    } catch {
      // Not provable now; the follow loop has already moved on and will not ask it again.
    }
    if (!owned) {
      this.logger.warn("remote input not on the delegated run", {
        profile: this.options.profile,
        runId: turn.runId,
        inputRunId: input.runId,
      });
      return;
    }
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
    if (!input.options.some((o) => o.id === optionId)) return;
    // The remote re-drives its run under the answer and replies once it parks again or ends;
    // the wait is bounded by this turn, and the follow loop sees the outcome either way.
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
        this.bounded(turn.deadline, turn.abort.signal, Number.POSITIVE_INFINITY),
      )
      .catch((error: unknown) => {
        if (error instanceof RemoteFault && error.code === "INPUT_ANSWERED") return;
        if (error instanceof RemoteUnreachable) return;
        this.logger.warn("forwarded answer refused", { profile: this.options.profile, error: String(error) });
        this.note(`${this.options.remoteName} did not take the answer to "${input.question}".`);
      });
  }

  /**
   * Cancel a remote run and read it until it is seen ended: its terminal status, or undefined
   * when that could not be seen (the cancel is then not taken as done).
   */
  private async cancelAndConfirm(runId: string, reason: string): Promise<Terminal["status"] | undefined> {
    const until = this.clock.now() + CANCEL_CONFIRM_MS;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.call("runs.cancel", { runId, reason }, { timeoutMs: 10_000 });
        break;
      } catch (error) {
        // Refused (a run that already ended, say): what the run's state says decides.
        if (error instanceof RemoteFault) break;
        await sleep(this.pollMs);
      }
    }
    for (;;) {
      try {
        const status = RunsGetResultSchema.parse(await this.client.call("runs.get", { runId }, { timeoutMs: 10_000 }))
          .run.status;
        if (status === "succeeded" || status === "failed" || status === "cancelled") return status;
      } catch {
        // Read again until the bound.
      }
      if (this.clock.now() > until) break;
      await sleep(this.pollMs);
    }
    this.logger.warn("could not confirm the remote run's cancellation", { profile: this.options.profile, runId });
    return undefined;
  }

  // ------------------------------------------------------------------ artifacts

  /**
   * Bring the succeeded run's artifacts back to the step's deliverables. Only artifacts of the
   * run's own succeeded steps are taken, and each copy is checked against the remote's record
   * of it (identity, producing step, size and sha256) before it is written.
   */
  private async deliver(
    runId: string,
    deliverables: readonly TurnDeliverable[],
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (deliverables.length === 0) return;
    const run = RunsGetResultSchema.parse(await this.call("runs.get", { runId }, deadline, signal));
    if (run.run.status !== "succeeded")
      throw new OrcaError("DELEGATED_RUN_FAILED", `the remote run ${runId} is ${run.run.status}, not succeeded`, {
        profile: this.options.profile,
        remoteRunId: runId,
      });
    const succeededSteps = new Set(
      run.steps.filter((s) => s.runId === runId && s.status === "succeeded").map((s) => s.id),
    );
    const listed = ArtifactsListResultSchema.parse(
      await this.call("artifacts.list", { runId, limit: 500 }, deadline, signal),
    );
    // Newest first: a later attempt's artifact wins over an earlier one of the same name.
    const remote = listed.artifacts
      .filter((a) => a.producedByStepRunId !== undefined && succeededSteps.has(a.producedByStepRunId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const d of deliverables) {
      const match = remote.find((a) => (d.name ? a.name === d.name : a.kind === d.kind));
      if (!match) continue;
      const got = ArtifactsGetResultSchema.parse(
        await this.call("artifacts.get", { artifactId: match.id }, deadline, signal),
      );
      if (got.text === undefined) {
        this.note(
          `${this.options.remoteName}: artifact ${match.name} was not brought back (${got.omitted?.reason ?? "no text"}).`,
        );
        continue;
      }
      const mismatch = artifactMismatch(match, got.artifact, got.text);
      if (mismatch)
        throw new OrcaError(
          "AGENT_PROTOCOL",
          `the remote daemon's copy of artifact ${match.name} does not match its record (${mismatch})`,
          { profile: this.options.profile, remoteRunId: runId, artifactId: match.id, mismatch },
        );
      await this.options.host.fs.mkdirp(parentOf(d.path));
      await this.options.host.fs.writeFile(d.path, got.text);
    }
  }

  /** A read that may be repeated: retried across a lost connection until the deadline. */
  private async call(method: string, params: unknown, deadline: number, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.call(method, params, this.bounded(deadline, signal));
      } catch (error) {
        if (
          error instanceof RemoteFault ||
          this.options.transport.failed() ||
          this.clock.now() > deadline ||
          signal?.aborted
        )
          throw classify(this.options.profile, this.options.transport, error);
        await sleep(Math.min(this.pollMs * 2 ** Math.min(attempt, 5), 30_000), signal);
      }
    }
  }

  /** A call's limits: the turn's signal, and no longer than the turn has left (or `cap`). */
  private bounded(
    deadline: number,
    signal: AbortSignal | undefined,
    cap = this.options.callTimeoutMs ?? 30_000,
  ): { timeoutMs: number; signal: AbortSignal | undefined } {
    return { timeoutMs: Math.max(1_000, Math.min(cap, deadline - this.clock.now())), signal };
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
