/**
 * The shape of `window.orca` — the only thing the sandboxed renderer can reach. Declared
 * once here so the preload that builds it and the renderer that calls it cannot drift:
 * both import these types, neither imports the other's code.
 *
 * Every call resolves rather than rejects. An IPC rejection across the context bridge
 * arrives as a stringified `Error` with the stack of the main process, which tells the UI
 * nothing it can render; a `BridgeResult` carries the protocol's own error code instead.
 *
 * `notifications` and `connection` are the exceptions to "every call is a request": both are
 * the main process speaking first, forwarded over an IPC event rather than an `invoke`.
 * Neither has a `BridgeResult` because there is no call to fail — a daemon that is gone
 * shows up as the stream going quiet and as a `connection` push that says so.
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
  InputsListParams,
  InputsListResult,
  NotificationMessage,
  ProtocolError,
  RunsEventsParams,
  RunsEventsResult,
  RunsGetParams,
  RunsGetResult,
  RunsListParams,
  RunsListResult,
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
  };
  inputs: {
    /** The gates and permission asks waiting on a person. */
    list: (params?: Params<InputsListParams>) => Promise<BridgeResult<InputsListResult>>;
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
