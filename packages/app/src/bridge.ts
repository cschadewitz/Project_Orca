/**
 * The shape of `window.orca` — the only thing the sandboxed renderer can reach. Declared
 * once here so the preload that builds it and the renderer that calls it cannot drift:
 * both import these types, neither imports the other's code.
 *
 * Every call resolves rather than rejects. An IPC rejection across the context bridge
 * arrives as a stringified `Error` with the stack of the main process, which tells the UI
 * nothing it can render; a `BridgeResult` carries the protocol's own error code instead.
 *
 * `notifications`, `connection` and `alerts.subscribe` are the exceptions to "every call is
 * a request": all three are the main process speaking first, forwarded over an IPC event
 * rather than an `invoke`. None has a `BridgeResult` because there is no call to fail — a
 * daemon that is gone shows up as the stream going quiet and as a `connection` push that
 * says so. `alerts.update` is the one call in the other direction with nothing to answer:
 * it states what is waiting, and the main process has no verdict to give back.
 */
import type { ScopedPermissionBridge } from "./scoped-permission-bridge.js";
import type { TemplateBridge } from "./template-bridge.js";
import type { WorkflowDraftBridge } from "./workflow-draft-bridge.js";
import type { DiagnosticsBridge } from "./diagnostics-contract.js";
import type { FirstRunBridge } from "./first-run-contract.js";
import type { DaemonConnectionBridge } from "./daemon-connection.js";
import type { UpdateAction, UpdateSnapshot } from "./update-contract.js";
import type { MacUpdateCommand, MacUpdateView } from "./mac-update-contract.js";
import type {
  CheckoutEvidence,
  LaunchReview,
  LaunchResponse,
  RetainedLaunch,
  PreflightParams,
  PreflightResult,
} from "./configuration-launch-contract.js";

import type { ConnectionState } from "@orca/design";
import type {
  AgentsListParams,
  AgentsListResult,
  ArtifactsGetParams,
  ArtifactsGetResult,
  ArtifactsListParams,
  ArtifactsListResult,
  ClaimsListParams,
  ClaimsListResult,
  ClaimsReleaseParams,
  ClaimsReleaseResult,
  ConfigGetParams,
  ConfigGetResult,
  ConfigApplyParams,
  ConfigApplyResult,
  ConfigSetParams,
  ConfigSetResult,
  DaemonCapability,
  DecisionsDecideParams,
  DecisionsDecideResult,
  DecisionsListParams,
  DecisionsListResult,
  DecisionsReopenParams,
  DecisionsReopenResult,
  DependenciesListParams,
  DependenciesListResult,
  DependenciesWaiveParams,
  DependenciesWaiveResult,
  HelloResult,
  InputsAnswerParams,
  InputsAnswerResult,
  InputsListParams,
  InputsListResult,
  ItemsListParams,
  ItemsListResult,
  JournalListParams,
  JournalListResult,
  NotificationMessage,
  PlanGetParams,
  PlanGetResult,
  PlansListParams,
  PlansListResult,
  ProtocolError,
  RisksListParams,
  RisksListResult,
  RisksUpdateParams,
  RisksUpdateResult,
  RunsCancelParams,
  RunsCancelResult,
  RunsEventsParams,
  RunsEventsResult,
  RunsGetParams,
  RunsGetResult,
  RunsListParams,
  RunsListResult,
  RunsResumeParams,
  RunsResumeResult,
  RunsStartParams,
  RunsStartResult,
  ScheduleExplainParams,
  ScheduleExplainResult,
  ScheduleGetParams,
  ScheduleGetResult,
  WorkflowsGetParams,
  WorkflowsGetResult,
  WorkflowsListParams,
  WorkflowsListResult,
  WorkflowsValidateInputsParams,
  WorkflowsValidateInputsResult,
} from "@orca/protocol";
import type { Preferences, PreferencesPatch } from "./preferences/schema.js";

export type BridgeResult<T> = { ok: true; result: T } | { ok: false; error: ProtocolError };

/**
 * The app-local code for a fail-closed protected-storage refusal (#857): the OS keychain or
 * Linux keyring did not provide ORCA's key, or only `basic_text` is available.
 * `details.reason` is `keyring-locked`, `no-keyring` or `unavailable`, and the
 * message already names the cause and what to do. `details.stage` says what may be claimed:
 * only `before-send` means this launch was not sent and may be retried as new; `after-send`
 * and `unconfirmed` mean a launch may exist, so the screen keeps it and offers recovery.
 */
export const PROTECTED_STORAGE_CODE = "PROTECTED_STORAGE";
export type ProtectedStorageReason = "keyring-locked" | "no-keyring" | "unavailable";
export type ProtectedStorageStage = "before-send" | "after-send" | "unconfirmed";

/**
 * Params as a caller passes them: the schema defaults (`limit`, `offset`) are the daemon's
 * job, so a screen that does not page says nothing about paging.
 */
type Params<T> = Partial<T>;

/**
 * What the main process knows about the daemon connection, as one object. The state
 * machine behind it is `src/main/connection-state.ts`; this is only its wire shape, and it
 * lives here because the preload, the renderer and the machine all have to agree on it.
 *
 * It is a *snapshot*, not a stream of transitions: a window that opens late reads the
 * current one rather than replaying a history it missed. Every optional field is absent
 * because the app does not know it yet, never because something failed — `capabilities`
 * especially, which is the daemon's own list and whose absence means writes are
 * unavailable rather than broken (docs/design/40-connection-states.md).
 */
export interface ConnectionSnapshot {
  /** Successful subscription attachments; independent of the visible quiet window. */
  generation?: number;
  /** One of the design system's five. `file` arrives with workspace selection (#164). */
  state: ConnectionState;
  /** ISO 8601: when the app entered this state — the indicator's elapsed/last-seen reading. */
  since: string;
  /** The event the UI is projected up to, when the stream has one (docs/design/60-implementation.md). */
  eventCursor?: number;
  /** Protocol versions for the `mismatch` rendering: "daemon 1.2 · app 1.3". */
  versions?: { app: string; daemon: string };
  /** The daemon's own version, once it has answered `hello`. */
  orcaVersion?: string;
  /** What the daemon said it can do. Absent means it has not said, which is not an error. */
  capabilities?: readonly DaemonCapability[];
  /**
   * The methods this daemon answers — `hello.methods`, which is `Object.keys` of its own
   * dispatch table (ADR 0008): "a method this daemon will not answer is a method it does
   * not advertise".
   *
   * It is carried beside `capabilities` because the two are different grains and a screen
   * needs the fine one. `runs.control` says the daemon drives runs; it does not say whether
   * *this* daemon serves `config.set` (it needs a `ConfigModel` as well) or
   * `claims.release` (it needs a plan). A control asks for the method it is about to call.
   * Absent means the daemon has not answered `hello` yet, or is too old to list them, and
   * the capability is then the coarse fallback (`renderer/src/connection.ts`).
   */
  methods?: readonly string[];
}

/** How the app arrived at the store it is showing. */
export type WorkspaceSource =
  /** `ORCA_WORKSPACE`, or the user's home directory when nothing was said. */
  | "default"
  /** `ORCA_DAEMON_URL`: a daemon somebody else is running, over a store this app never chose. */
  | "env"
  /** Chosen in the app — the File menu, or a banner. Always read-only (#164). */
  | "chosen";

/**
 * The store on screen. It is not part of `ConnectionSnapshot` on purpose: the connection is
 * about whether a daemon is answering, and this is about *which* store answered — a person
 * can be disconnected from a chosen store, and the banner still has to name it.
 */
export interface WorkspaceSnapshot {
  /** The directory `orca serve` was pointed at; it reads `<path>/.orca`. */
  path: string;
  /** True when the daemon was started `--read-only`, which is what file mode is. */
  readOnly: boolean;
  source: WorkspaceSource;
}

/**
 * One thing that wants a person, as the main process needs to see it: which tier it is
 * (the tier table in docs/design/20-attention-and-gates.md decides when it may interrupt),
 * enough words to put in a notification, and the ids a click has to come back with.
 *
 * A failure is in here beside the two waiting tiers because it is the third row of that
 * table, even though it never enters the count — `waiting` is the count, sent separately
 * for exactly that reason.
 */
export interface AlertItem {
  /** The input's id, or the run's for a failure: what a repeat of the same alert is keyed by. */
  id: string;
  tier: "permission" | "gate" | "failure";
  /** What the notification says, in one line. Already sentence case. */
  title: string;
  body: string;
  runId: string;
  /** Set for the two waiting tiers; a failure is the run itself. */
  inputId?: string;
  /** ISO 8601: when the ask was made. The gate delay is measured from it, not from arrival. */
  since: string;
}

/** Everything open, as one statement. Absent items have gone away. */
export interface AlertsUpdate {
  /** `InputsListResult.waiting` verbatim — the one number in the app, never recounted here. */
  waiting: number;
  items: readonly AlertItem[];
}

/** What came back when a person clicked a notification. */
export interface AlertActivation {
  /** The alert they clicked, when it is still known; absent once it has been answered. */
  item?: AlertItem;
}

import type { GuidedLaunchSnapshot, ProtectedGuidedLaunch } from "./guided-launch-bridge.js";
export interface OrcaBridge {
  firstRun?: FirstRunBridge;
  macUpdates?: {
    read(): MacUpdateView;
    act(command: MacUpdateCommand): Promise<BridgeResult<MacUpdateView>>;
    subscribe(listener: (state: MacUpdateView) => void): () => void;
  };
  guidedLaunch?: {
    snapshot(): Promise<BridgeResult<GuidedLaunchSnapshot>>;
    preflight(
      params: PreflightParams,
    ): Promise<BridgeResult<{ preflight: PreflightResult; checkout: CheckoutEvidence }>>;
    submit(review: LaunchReview): Promise<BridgeResult<{ intent: RetainedLaunch; response: LaunchResponse }>>;
    retained(): Promise<BridgeResult<readonly RetainedLaunch[]>>;
    load(id: string): Promise<BridgeResult<ProtectedGuidedLaunch>>;
    resolve(review: LaunchReview): Promise<BridgeResult<RetainedLaunch | undefined>>;
    recover(params: { id: string; action: "inspect" | "reconcile" }): Promise<BridgeResult<LaunchResponse>>;
    abandon(id: string): Promise<BridgeResult<{ abandoned: boolean }>>;
  };
  diagnostics?: DiagnosticsBridge;
  /** Coherent launch reads; absence is an ordinary unavailable app seam. */
  operator?: {
    preflight(params: PreflightParams): Promise<BridgeResult<PreflightResult>>;
  };
  /** Durable palette intent ownership lives in main, never renderer memory or localStorage. */
  admissionIntents?: {
    start(workflowId: string): Promise<BridgeResult<{ runId: string }>>;
    list(): Promise<BridgeResult<{ id: string; workflowId: string }[]>>;
    abandon(id: string): Promise<BridgeResult<{ abandoned: boolean }>>;
  };
  daemonConnection?: DaemonConnectionBridge;
  updates: {
    read(): UpdateSnapshot;
    act(action: UpdateAction): Promise<BridgeResult<UpdateSnapshot>>;
    subscribe(listener: (state: UpdateSnapshot) => void): () => void;
    prepare(listener: (locked: boolean) => boolean): () => void;
  };
  /** `process.platform` of the main process: `darwin` puts shortcuts on ⌘, everything else on Ctrl. */
  readonly platform: string;
  /** The daemon handshake: protocol version, ORCA version and the daemon's capabilities. */
  hello: () => Promise<BridgeResult<HelloResult>>;
  runs: {
    /** The run list, newest first, filtered and paged. */
    list: (params?: Params<RunsListParams>) => Promise<BridgeResult<RunsListResult>>;
    /** One run whole: steps, attempts, children, artifacts. */
    get: (params: RunsGetParams) => Promise<BridgeResult<RunsGetResult>>;
    /** One page of a run's log, by sequence number, forwards or backwards. */
    events: (params: Params<RunsEventsParams> & { runId: string }) => Promise<BridgeResult<RunsEventsResult>>;
    /** Stop a run, with the reason recorded on `run.cancelled`. A write. */
    cancel: (params: RunsCancelParams) => Promise<BridgeResult<RunsCancelResult>>;
    /**
     * Start a run of a registered workflow (#178). A write, and the app's caller is the
     * palette's **Start a run**: a picker of `workflows.list` and no vars at all, because
     * the vars form the design asks for is not specified yet and a form that guessed at a
     * workflow's inputs would invent them (RULES.md rule 12). A run started from here runs
     * on the workflow's own `vars`.
     *
     * It answers when the run exists rather than when it finishes, so the caller can
     * navigate to `orca://run/<id>` and watch the rest arrive on the stream.
     */
    start: (params: Params<RunsStartParams> & { workflowId: string }) => Promise<BridgeResult<RunsStartResult>>;
    /**
     * Re-drive a parked run under this daemon's lease. It answers when the run parks again
     * or finishes, not when it starts moving, so a caller that wants the steps in between
     * watches the notification stream while the call is open. A write.
     */
    resume: (params: RunsResumeParams) => Promise<BridgeResult<RunsResumeResult>>;
  };
  inputs: {
    revise?: (
      params: import("@orca/protocol").InputsReviseParams,
    ) => Promise<BridgeResult<import("@orca/protocol").RevisionResult>>;
    revisionPending?: (
      params: import("@orca/protocol").InputsRevisionPendingParams,
    ) => Promise<BridgeResult<import("@orca/protocol").PendingRevisionView>>;
    replaceRevision?: (
      params: import("@orca/protocol").InputsReplaceRevisionParams,
    ) => Promise<BridgeResult<import("@orca/protocol").RevisionResult>>;
    /** The gates and permission asks waiting on a person. */
    list: (params?: Params<InputsListParams>) => Promise<BridgeResult<InputsListResult>>;
    /**
     * Answer one of them, by option *id* — a label may be reworded between the ask and the
     * answer, and the id is what the run branches on. `always` also writes the standing
     * rule the answer justifies into the workspace sidecar, and the result says exactly
     * what was written, so a button can promise "ORCA will not ask again" honestly or not
     * at all (`PermissionRecordView`, ADR 0009).
     *
     * A write: absent from a daemon started `--read-only`, which is why a caller asks
     * `useWritability()` first rather than finding out by failing.
     */
    answer: (
      params: Params<InputsAnswerParams> & { requestId: string; optionId: string },
    ) => Promise<BridgeResult<InputsAnswerResult>>;
  };
  claims: {
    /** Who owns which work item, and whether that run is still alive. */
    list: (params?: Params<ClaimsListParams>) => Promise<BridgeResult<ClaimsListResult>>;
    /**
     * Take a work item away from the run that claimed it (#88). A write, and a destructive
     * one: it is refused while the owner could still resume unless `force`, and
     * `ClaimView.owner.releasable` says which it will be *before* the call, so the
     * confirmation can be honest rather than the error being the first news.
     */
    release: (
      params: Params<ClaimsReleaseParams> & { workItemId: string },
    ) => Promise<BridgeResult<ClaimsReleaseResult>>;
  };
  /**
   * The plan (#169) — what is coming, why it is not moving, and what it waits for.
   *
   * Every call names a `planId`: the daemon serves a store, not a person, so it has no
   * default plan and `plan.list()` is how a surface finds one. `schedule.explain` is the one
   * that returns prose, and the prose is `core`'s own — render it, do not re-phrase it.
   */
  plan: {
    list: (params?: Params<PlansListParams>) => Promise<BridgeResult<PlansListResult>>;
    get: (params: PlanGetParams) => Promise<BridgeResult<PlanGetResult>>;
    items: (params: Params<ItemsListParams> & { planId: string }) => Promise<BridgeResult<ItemsListResult>>;
    schedule: (params: ScheduleGetParams) => Promise<BridgeResult<ScheduleGetResult>>;
    explain: (params: ScheduleExplainParams) => Promise<BridgeResult<ScheduleExplainResult>>;
    dependencies: (
      params: Params<DependenciesListParams> & { planId: string },
    ) => Promise<BridgeResult<DependenciesListResult>>;
    risks: (params: Params<RisksListParams> & { planId: string }) => Promise<BridgeResult<RisksListResult>>;
    decisions: (params: Params<DecisionsListParams> & { planId: string }) => Promise<BridgeResult<DecisionsListResult>>;
    journal: (params: Params<JournalListParams> & { planId: string }) => Promise<BridgeResult<JournalListResult>>;
    /** Waive a dependency. A write. */
    waive: (params: DependenciesWaiveParams) => Promise<BridgeResult<DependenciesWaiveResult>>;
    /** Record a choice; `recommended` comes back beside it when there is a matrix. A write. */
    decide: (params: DecisionsDecideParams) => Promise<BridgeResult<DecisionsDecideResult>>;
    /** Clear a choice and the dependencies it satisfied (#104). A write. */
    reopen: (params: DecisionsReopenParams) => Promise<BridgeResult<DecisionsReopenResult>>;
    /** Move a risk along its lifecycle. A write. */
    updateRisk: (params: RisksUpdateParams) => Promise<BridgeResult<RisksUpdateResult>>;
  };
  artifacts: {
    /**
     * Artifact metadata, never bodies: the versions of one name, or everything one step
     * produced. A run with forty artifacts would otherwise ship megabytes to draw a
     * version list (#159).
     */
    list: (params?: Params<ArtifactsListParams>) => Promise<BridgeResult<ArtifactsListResult>>;
    /**
     * One artifact's body, addressed by `artifactId` or by (`runId`, `name`, `version?`).
     * A binary or oversized body comes back as `omitted` with the reason in words rather
     * than as an error — it exists, it is simply not being shown.
     */
    get: (params: Params<ArtifactsGetParams>) => Promise<BridgeResult<ArtifactsGetResult>>;
  };
  workflows: {
    /**
     * Every workflow the daemon has registered, as rows: the viewer's list and, later, the
     * run-start picker (#178). A read, answered by a `--read-only` daemon too — a workflow
     * is a file the daemon has already parsed, and reading it touches no run.
     */
    list: (params?: Params<WorkflowsListParams>) => Promise<BridgeResult<WorkflowsListResult>>;
    /**
     * One workflow's graph: nodes with their per-type fields, edges, and the graphs written
     * inline inside a `loop`, a `parallel` or a `subworkflow` — each with the
     * `parent::node` id the engine addresses it by, so the viewer may draw the nested graph
     * it was given or fetch the same one again when a collapsed node is expanded.
     *
     * `version` may only ever be the version on disk. ORCA records which version a run
     * started against but keeps no copy of that definition, so asking for an older one
     * answers `WORKFLOW_NOT_FOUND` rather than a graph that is not the one that ran.
     */
    get: (params: WorkflowsGetParams) => Promise<BridgeResult<WorkflowsGetResult>>;
    validateInputs?: (params: WorkflowsValidateInputsParams) => Promise<BridgeResult<WorkflowsValidateInputsResult>>;
  };
  agents: {
    /**
     * Every configured agent with its handshake health, and what is claimed right now.
     * A read: health is in the daemon's memory rather than in a log, so an agent nothing
     * has contacted answers `unknown` rather than being missing (#222). `agents.ping` is a
     * read too, but it is a button (#176) and is not on the bridge yet.
     */
    list: (params?: Params<AgentsListParams>) => Promise<BridgeResult<AgentsListResult>>;
  };
  /**
   * The workspace's configuration, as two documents: `orca.config.yaml` and the ADR 0009
   * permission sidecar `orca.permissions.json` (#174, #266). Plumbing only today — the
   * Configuration and Agents surfaces (#175, #176) are what call it.
   */
  config: {
    /**
     * Both documents, each with its own path, its own `revision` and its raw `text`; the
     * schema description a form draws its fields from; and the effective permission policy
     * per agent, in evaluation order, with each rule labelled by the document it came from.
     *
     * A read, so a `--read-only` daemon answers it. **Nothing is redacted**: `text` is the
     * bytes of the config file. A form that edits a file has to show the file, and a
     * redacted text written back would destroy what it hid.
     */
    get: (params?: Params<ConfigGetParams>) => Promise<BridgeResult<ConfigGetResult>>;
    /**
     * Write one of them. `expectedRevision` is what was read; a stale one is refused with
     * `CONFIG_STALE` rather than overwritten. Send `patch` from a form — it edits the YAML
     * document in place and keeps its comments — and `text` from an editor pane.
     * `validateOnly` asks the same questions and writes nothing.
     *
     * A write: absent from a daemon started `--read-only`, so a caller asks
     * `useWritability()` first rather than finding out by failing.
     */
    set: (params: ConfigSetParams) => Promise<BridgeResult<ConfigSetResult>>;
    /** Saved and active remain separate guarded operations. */
    apply?: (params: ConfigApplyParams) => Promise<BridgeResult<ConfigApplyResult>>;
  };
  /** Optional until the integration owner registers the typed template IPC dispatcher. */
  templates?: TemplateBridge;
  scopedPermissions?: ScopedPermissionBridge;
  /** Workflow drafts (#180) for the visual editor. Optional: absent, the workflow viewer stays read-only. */
  workflowDrafts?: WorkflowDraftBridge;
  notifications: {
    /**
     * Daemon-initiated messages: run and step transitions, coalesced agent output, inputs
     * opening and closing, and the raw log. Returns the unsubscribe — a screen that keeps
     * one past its own lifetime keeps repainting something nobody is looking at.
     *
     * The envelope arrives unparsed. `parseNotification` in `@orca/protocol` turns it into
     * the discriminated union a renderer switches on; an envelope this version does not know
     * is a newer daemon's, and dropping it is the compatible thing to do.
     */
    subscribe: (listener: (notification: NotificationMessage) => void) => () => void;
  };
  /**
   * OS notifications, the dock badge and what a person did with one (#162).
   *
   * **`alerts`, not `notifications`**: that name is already the daemon's push stream, and
   * the two are opposite directions. This one is the app talking to the operating system
   * about the person, and the main process owns it because `Notification`, the dock badge
   * and window focus are all on that side of the bridge.
   *
   * The renderer is the one that knows what is waiting — it holds `inputs.list` and the
   * pushes that move it — so it states that, whole, and the main process decides what to
   * post from it. Nothing is counted twice and there is no second fold of the same data.
   */
  alerts: {
    /**
     * What is open right now, and the daemon's own count of it. Sent on every change; the
     * main process diffs it, so re-sending the same set posts nothing.
     */
    update: (update: AlertsUpdate) => void;
    /**
     * The person clicked a notification. Today every activation opens Attention; the
     * `item` on it is the card's identity, which is what turns into an `orca://` route
     * when the route table lands (#165).
     */
    subscribe: (listener: (activation: AlertActivation) => void) => () => void;
  };
  /**
   * The connection state machine's output. One state for the whole app, decided in the main
   * process — which is the only place that can see the socket, the bundled daemon's exit and
   * the handshake at once — and pushed here, rather than probed per screen.
   */
  connection: {
    /**
     * Synchronous for the same reason `preferences.read` is: the chrome renders the status
     * bar on its first pass, and a promise would paint "reconnecting" for a frame first.
     */
    read: () => ConnectionSnapshot;
    /** Every change, until the returned unsubscribe is called. */
    subscribe: (listener: (snapshot: ConnectionSnapshot) => void) => () => void;
  };
  /**
   * Which store is on screen, and how to point the app at another one (#164).
   *
   * File mode is not a second store path — ADR 0008 forbids the renderer reading a store
   * directly — so `open` starts `orca serve --read-only` over the chosen directory and
   * everything else carries on as it was: the same client, the same protocol, with the
   * control methods absent from `hello` and therefore from every button.
   * `src/main/workspace.ts` performs the switch.
   */
  workspace: {
    /** Synchronous, like `connection.read`: the file-mode banner names the path on the first paint. */
    read: () => WorkspaceSnapshot;
    /** Every switch, until the returned unsubscribe is called. */
    subscribe: (listener: (snapshot: WorkspaceSnapshot) => void) => () => void;
    /**
     * Open a store read-only. Without a path the main process asks for one, because a
     * dialog may only be opened there; a cancelled dialog answers the workspace unchanged.
     */
    open: (params?: { path?: string }) => Promise<BridgeResult<WorkspaceSnapshot>>;
    /** The file-mode banner's **Connect to a daemon**: back to the writable default. */
    connectLive: () => Promise<BridgeResult<WorkspaceSnapshot>>;
  };
  /**
   * `orca://` URLs from outside the app: a pasted link, another tool, a second launch. The
   * main process folds the three ways an OS delivers one into this (`main/deep-link.ts`);
   * the renderer resolves them through its route table, which is the only resolver.
   */
  deepLink: {
    /**
     * The URL this window was opened for, if it was opened for one. Read once and
     * synchronously, before subscribing — a link is delivered once, so a reload must not
     * replay it and drag a person back to a place they have left.
     */
    take: () => string | undefined;
    /** Every URL that arrives while this window is open. */
    subscribe: (listener: (url: string) => void) => () => void;
  };
  /** The app's own preferences (theme, per-surface density) — the main process owns the file. */
  preferences: {
    /**
     * Synchronous on purpose: the renderer sets `data-theme` before it mounts anything, and a
     * round trip through a promise would paint the OS theme for a frame first.
     */
    read: () => Preferences;
    /** Merge a patch over what is on disk (`theme` replaces, `density` merges by surface). */
    write: (patch: PreferencesPatch) => Promise<BridgeResult<Preferences>>;
  };
}
