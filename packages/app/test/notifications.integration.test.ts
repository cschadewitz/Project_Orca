/** Real daemon HTTP/WebSocket notifications reach the renderer stream through the synthetic IPC seam. */
import { afterEach, describe, expect, it } from "vitest";
import {
  STEP_CHANGED,
  type EventAppendedParams,
  type NotificationMessage,
  type StepChangedParams,
} from "@orca/protocol";
import { startDaemon, type DaemonHandle, type SubscriptionSource } from "@orca/daemon";
import { DaemonClient } from "../src/client/daemon-client.js";
import { DaemonSubscription } from "../src/client/subscription.js";
import { createNotificationStream } from "../renderer/src/notifications.js";

/**
 * The push channel from the daemon's event store to a renderer listener, and the reconnect
 * behaviour that keeps it whole.
 *
 * The chain the first block exercises is the real one, minus Electron: a real daemon with a
 * real WebSocket, the main process's `DaemonClient.subscribe()`, an IPC pair standing in for
 * `webContents.send` / `ipcRenderer.on`, and the renderer's own `createNotificationStream` at
 * the far end. That last module imports `@orca/protocol` and nothing else — no bridge module,
 * no daemon, no Electron — which is ADR 0008's boundary and the point of the test: what
 * reaches a screen is a protocol type that travelled, not an object the renderer reached
 * across the process line to fetch.
 *
 * What is behind the daemon is an event log and not an engine, because the daemon takes its
 * feed as an interface (`SubscriptionSource`) and the app package may not depend on the
 * engine to begin with. How a real orchestrator drives that feed is `packages/daemon`'s test.
 *
 * The second block replaces the socket with a scripted one, because reconnection is about
 * timing and a real socket would make the test about a real daemon's restart time instead.
 */

type OrcaEvent = EventAppendedParams["event"];

/**
 * The daemon's feed, as an append-only log. `seq` is per run and gap-free, which is the
 * property the cursor rests on; nothing else about a store matters here.
 */
class TestEvents implements SubscriptionSource {
  private readonly log = new Map<string, OrcaEvent[]>();
  private readonly listeners = new Set<{ listener: (e: OrcaEvent) => void; runId: string | undefined }>();
  private at = Date.UTC(2026, 2, 1, 9, 0, 0);

  subscribe(listener: (event: OrcaEvent) => void, filter?: { runId?: string | undefined }): () => void {
    const entry = { listener, runId: filter?.runId };
    this.listeners.add(entry);
    return () => void this.listeners.delete(entry);
  }

  async eventsRange(runId: string, range?: { after?: number | undefined }): Promise<OrcaEvent[]> {
    const all = this.log.get(runId) ?? [];
    return range?.after === undefined ? [...all] : all.filter((e) => e.seq > range.after!);
  }

  /** Append and fan out, the way `BaseEventStore` does: durable first, listeners after. */
  append(runId: string, type: OrcaEvent["type"], payload: object): OrcaEvent {
    const list = this.log.get(runId) ?? [];
    this.at += 1000;
    const event = {
      id: `evt-${runId}-${list.length}`,
      seq: list.length,
      runId,
      at: new Date(this.at).toISOString(),
      type,
      payload,
    } as OrcaEvent;
    list.push(event);
    this.log.set(runId, list);
    for (const { listener, runId: only } of this.listeners) if (!only || only === runId) listener(event);
    return event;
  }
}

/** The IPC seam. `send` is the main process's; `subscribe` is what the preload builds over. */
function ipcPair(): {
  send: (notification: NotificationMessage) => void;
  renderer: { subscribe: (listener: (n: NotificationMessage) => void) => () => void };
} {
  const listeners = new Set<(n: NotificationMessage) => void>();
  return {
    // A structured-clone round trip, the way an IPC frame actually arrives: the renderer
    // gets data, never a reference to a main-process object.
    send: (notification) => {
      const copy = JSON.parse(JSON.stringify(notification)) as NotificationMessage;
      for (const listener of [...listeners]) listener(copy);
    },
    renderer: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
  };
}

describe("daemon to renderer", () => {
  let daemon: DaemonHandle | undefined;
  let subscription: DaemonSubscription | undefined;

  afterEach(async () => {
    subscription?.close();
    subscription = undefined;
    await daemon?.close();
    daemon = undefined;
  });

  it("replays a notification to the renderer, typed, over the bridge", async () => {
    const events = new TestEvents();
    daemon = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.subscribe"],
      auth: { mode: "loopback-unauthenticated" },
      source: events,
    });

    // --- main process: one socket, forwarded down the IPC channel.
    const ipc = ipcPair();
    const client = new DaemonClient(daemon.url);
    const live = new Promise<void>((resolve) => {
      subscription = client.subscribe({
        params: { runId: "run-1" },
        onNotification: (n) => ipc.send({ kind: "notification", method: n.method, params: n.params }),
        onState: (state) => void (state === "live" && resolve()),
      });
    });
    await live;

    // --- renderer: the bridge's raw envelopes, routed and validated by the protocol alone.
    const stream = createNotificationStream(ipc.renderer);
    // This method's own params, not the union's: `agent.changed` joined the union in
    // protocol 1.5 and carries no `seq` (#241), and `stream.on` narrows for us anyway.
    const seen: StepChangedParams[] = [];
    const arrived = new Promise<void>((resolve) => {
      stream.on(
        STEP_CHANGED,
        (params) => {
          seen.push(params);
          if (seen.length === 2) resolve();
        },
        { runId: "run-1" },
      );
    });

    events.append("run-1", "step.scheduled", { stepRunId: "sr-1", nodeId: "plan", nodeType: "agent", attempt: 1 });
    events.append("run-1", "step.started", { stepRunId: "sr-1", inputArtifactIds: [] });
    await arrived;

    expect(seen.map((p) => [p.seq, (p as { stepRunId: string }).stepRunId, (p as { status: string }).status])).toEqual([
      [0, "sr-1", "blocked"],
      [1, "sr-1", "running"],
    ]);
    // The cursor a reconnect would resume from is the last sequence number that arrived.
    expect(subscription!.lastSeq).toBe(1);
  });
});
