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
  DaemonCapability,
  HelloResult,
  InputsAnswerParams,
  InputsAnswerResult,
  InputsListParams,
  InputsListResult,
  NotificationMessage,
  ProtocolError,
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
} from "@orca/protocol";
import type { Preferences, PreferencesPatch } from "./preferences/schema.js";

export type BridgeResult<T> = { ok: true; result: T } | { ok: false; error: ProtocolError };

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

export interface OrcaBridge {
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
    /**
     * Stop a run, with the reason recorded on `run.cancelled`. A write.
     *
     * `runs.start` is deliberately **not** here: starting a run needs a workflow picker and
     * a vars form that nothing in this app has yet (#178, v0.5.0), and a bridge entry with
     * no caller is a promise the app cannot keep.
     */
    cancel: (params: RunsCancelParams) => Promise<BridgeResult<RunsCancelResult>>;
    /**
     * Re-drive a parked run under this daemon's lease. It answers when the run parks again
     * or finishes, not when it starts moving, so a caller that wants the steps in between
     * watches the notification stream while the call is open. A write.
     */
    resume: (params: RunsResumeParams) => Promise<BridgeResult<RunsResumeResult>>;
  };
  inputs: {
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
  agents: {
    /**
     * Every configured agent with its handshake health, and what is claimed right now.
     * A read: health is in the daemon's memory rather than in a log, so an agent nothing
     * has contacted answers `unknown` rather than being missing (#222). `agents.ping` is a
     * read too, but it is a button (#176) and is not on the bridge yet.
     */
    list: (params?: Params<AgentsListParams>) => Promise<BridgeResult<AgentsListResult>>;
  };
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
