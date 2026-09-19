/**
 * The shape of `window.orca` — the only thing the sandboxed renderer can reach. Declared
 * once here so the preload that builds it and the renderer that calls it cannot drift:
 * both import these types, neither imports the other's code.
 *
 * Every call resolves rather than rejects. An IPC rejection across the context bridge
 * arrives as a stringified `Error` with the stack of the main process, which tells the UI
 * nothing it can render; a `BridgeResult` carries the protocol's own error code instead.
 *
 * `notifications` is the exception to "every call is a request": it is the daemon speaking
 * first, forwarded from the main process's WebSocket over an IPC event rather than an
 * `invoke`. It has no `BridgeResult` because there is no call to fail — a daemon that is
 * gone shows up as the stream going quiet, which is what `hello` and the connection
 * indicator are for.
 */
import type {
  ClaimsListParams,
  ClaimsListResult,
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
