/**
 * The renderer's end of the daemon's push channel: raw envelopes off the preload bridge in,
 * a typed stream a screen can listen to one method at a time out.
 *
 * The bridge hands over `NotificationMessage`s — `method` plus an unvalidated `params` —
 * because that is all an IPC frame is. What a screen wants is "tell me when a step in *this*
 * run changes", so this does the three things every listener would otherwise do for itself:
 *
 * - **Validate.** `parseNotification` parses `params` against the method's own schema, so a
 *   listener gets a typed payload rather than `unknown`. A method this build does not know
 *   is a newer daemon's and is dropped, which is the compatible thing to do.
 * - **Route.** One listener per method, and an optional `runId` filter, so a run screen is
 *   not woken by every other run in the store.
 * - **Unsubscribe once.** The bridge subscription is opened on the first listener and closed
 *   when the last one goes, so a screen that mounts and unmounts leaves nothing behind.
 *
 * This module imports `@orca/protocol` and nothing else — no React, no bridge module, no
 * daemon. The source is stated structurally, so `window.orca.notifications` satisfies it and
 * so does a test's fake, and ADR 0008's import boundary is kept by construction rather than
 * by the lint rule alone.
 */
import {
  parseNotification,
  type DaemonNotification,
  type NotificationMessage,
  type NotificationMethod,
  type NotificationParamsByMethod,
} from "@orca/protocol";

/** What the stream needs of the bridge: `window.orca.notifications` is one of these. */
export interface NotificationSource {
  subscribe: (listener: (notification: NotificationMessage) => void) => () => void;
}

/** Narrow what a listener is woken for. Omitted fields mean "everything". */
export interface NotificationFilter {
  /** Only notifications about this run. */
  runId?: string | undefined;
}

export type NotificationListener<M extends NotificationMethod> = (params: NotificationParamsByMethod[M]) => void;

export interface NotificationStream {
  /** Listen to one method. Returns the unsubscribe; call it when the screen goes away. */
  on: <M extends NotificationMethod>(
    method: M,
    listener: NotificationListener<M>,
    filter?: NotificationFilter,
  ) => () => void;
  /** Listen to every method, already parsed: a timeline, a debug panel, a test. */
  onAny: (listener: (notification: DaemonNotification) => void, filter?: NotificationFilter) => () => void;
  /** How many listeners are attached — a screen that leaks one is a screen that leaks. */
  readonly listeners: number;
}

interface Entry {
  method: NotificationMethod | undefined;
  filter: NotificationFilter | undefined;
  deliver: (notification: DaemonNotification) => void;
}

/**
 * A stream over one bridge subscription. Create one per window (the app makes a single
 * instance and shares it) rather than one per screen: every screen listening separately
 * would mean one IPC listener each for frames they nearly all ignore.
 */
export function createNotificationStream(source: NotificationSource): NotificationStream {
  const entries = new Set<Entry>();
  let detach: (() => void) | undefined;

  const receive = (message: NotificationMessage): void => {
    const notification = parseNotification(message);
    if (!notification) return;
    // A copy, because a listener may unsubscribe itself or another while being called.
    for (const entry of [...entries]) {
      if (!entries.has(entry)) continue;
      if (entry.method && entry.method !== notification.method) continue;
      // `agent.changed` is about the process and carries no `runId` (#241), so a listener
      // that asked for one run is not woken by it — the same answer this gives a frame from
      // any other run.
      if (entry.filter?.runId && entry.filter.runId !== (notification.params as { runId?: string }).runId) continue;
      entry.deliver(notification);
    }
  };

  /** Hold the bridge subscription only while somebody is listening. */
  function add(entry: Entry): () => void {
    entries.add(entry);
    detach ??= source.subscribe(receive);
    return () => {
      if (!entries.delete(entry) || entries.size) return;
      detach?.();
      detach = undefined;
    };
  }

  return {
    on(method, listener, filter) {
      return add({
        method,
        filter,
        // Routed by `method` just above, so the payload is this method's by construction;
        // an indexed lookup keyed by a type parameter cannot see that.
        deliver: (n) => listener(n.params as NotificationParamsByMethod[typeof method]),
      });
    },
    onAny(listener, filter) {
      return add({ method: undefined, filter, deliver: listener });
    },
    get listeners() {
      return entries.size;
    },
  };
}
