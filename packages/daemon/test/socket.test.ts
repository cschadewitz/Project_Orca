import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_UPDATE,
  EVENT_APPENDED,
  INPUT_OPENED,
  PROTOCOL_VERSION,
  RUN_CHANGED,
  STEP_CHANGED,
  SUBSCRIBE_METHOD,
  SubscribeResultSchema,
  UNSUBSCRIBE_METHOD,
  parseNotification,
  type DaemonNotification,
  type NotificationMessage,
  type NotificationMethod,
} from "@orca/protocol";
import { ReadModel, startDaemon, type DaemonHandle } from "@orca/daemon";
import type { OrcaEventInput } from "@orca/core";
import { emptyFixture, type Fixture } from "./fixture.js";

/**
 * A client of the socket, built on Node's own `WebSocket` - the same thing the app's main
 * process uses, so the test drives the transport a real client drives rather than `ws`'s
 * own client.
 */
class Client {
  readonly notifications: DaemonNotification[] = [];
  private readonly pending = new Map<number, (r: { ok: boolean; result?: unknown; error?: unknown }) => void>();
  private nextId = 1;
  private arrived: (() => void)[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data)) as {
        kind: string;
        id?: number;
        ok?: boolean;
        result?: unknown;
        error?: unknown;
        method?: string;
        params?: unknown;
      };
      if (msg.kind === "response" && msg.id !== undefined) {
        this.pending.get(msg.id)?.({ ok: Boolean(msg.ok), result: msg.result, error: msg.error });
        this.pending.delete(msg.id);
        return;
      }
      const notification = parseNotification(msg as NotificationMessage);
      if (notification) this.notifications.push(notification);
      for (const wake of this.arrived.splice(0)) wake();
    });
  }

  static open(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Client(ws)));
      ws.addEventListener("error", () => reject(new Error(`could not open ${url}`)));
    });
  }

  call(method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ kind: "request", id, method, params }));
    });
  }

  async subscribe(params: unknown): Promise<{ subscriptionId: string; replayed: number }> {
    const answer = await this.call(SUBSCRIBE_METHOD, params);
    if (!answer.ok) throw new Error(`subscribe failed: ${JSON.stringify(answer.error)}`);
    return SubscribeResultSchema.parse(answer.result);
  }

  /** The methods seen so far, in arrival order - what "in order" is asserted against. */
  methods(of?: NotificationMethod): string[] {
    return this.notifications.filter((n) => !of || n.method === of).map((n) => n.method);
  }

  /**
   * Resolve once `count` notifications matching `method` have arrived, narrowed to that
   * method's own params. Generic since protocol 1.5: `agent.changed` joined the union and
   * carries neither `runId` nor `seq`, so a caller asking for `step.changed` has to be given
   * back `step.changed` rather than the whole union (#241).
   */
  async waitFor<M extends NotificationMethod>(
    method: M,
    count: number,
  ): Promise<Extract<DaemonNotification, { method: M }>[]> {
    type Matching = Extract<DaemonNotification, { method: M }>;
    const matching = (): Matching[] => this.notifications.filter((n): n is Matching => n.method === method);
    while (matching().length < count) await new Promise<void>((resolve) => this.arrived.push(resolve));
    return matching();
  }

  close(): void {
    this.ws.close();
  }
}

describe("the WebSocket endpoint", () => {
  let fixture: Fixture;
  let daemon: DaemonHandle;
  const clients: Client[] = [];

  /** A daemon over an empty in-memory store, with the batch window closed by the test. */
  async function serve(batchMs?: number): Promise<string> {
    fixture = emptyFixture();
    daemon = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read", "runs.subscribe"],
      reads: new ReadModel({ orchestrator: fixture.orchestrator }),
      source: fixture.orchestrator,
      ...(batchMs === undefined ? {} : { batchMs }),
    });
    return daemon.socketUrl!;
  }

  /** Append to the store the way an interpreter would; the daemon is subscribed to it. */
  async function append(input: OrcaEventInput): Promise<number> {
    return (await fixture.stores.events.append(input)).seq;
  }

  const stepScheduled = (runId: string, stepRunId: string, nodeId: string): OrcaEventInput => ({
    type: "step.scheduled",
    runId,
    payload: { stepRunId, nodeId, nodeType: "agent", attempt: 1 },
  });

  const stepCompleted = (runId: string, stepRunId: string): OrcaEventInput => ({
    type: "step.completed",
    runId,
    payload: { stepRunId, result: { artifactIds: [], data: {} } },
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await daemon.close();
  });

  async function client(url: string): Promise<Client> {
    const c = await Client.open(url);
    clients.push(c);
    return c;
  }

  it("fans one run out to every client subscribed to it, in order", async () => {
    const url = await serve();
    const [a, b] = [await client(url), await client(url)];
    await a.subscribe({ runId: "run-1", methods: [STEP_CHANGED] });
    await b.subscribe({ runId: "run-1", methods: [STEP_CHANGED] });

    await append(stepScheduled("run-1", "sr-1", "plan"));
    await append({ type: "step.started", runId: "run-1", payload: { stepRunId: "sr-1", inputArtifactIds: [] } });
    await append({ type: "step.waiting", runId: "run-1", payload: { stepRunId: "sr-1", on: "human-input" } });
    // Another run, and a run-scoped subscription must not see it.
    await append(stepScheduled("run-2", "sr-9", "other"));

    for (const c of [a, b]) {
      const seen = await c.waitFor(STEP_CHANGED, 3);
      expect(seen.map((n) => [n.params.seq, (n.params as { status: string }).status])).toEqual([
        [0, "blocked"],
        [1, "running"],
        [2, "waiting"],
      ]);
      expect(seen.every((n) => n.params.runId === "run-1")).toBe(true);
      expect(c.methods()).toEqual([STEP_CHANGED, STEP_CHANGED, STEP_CHANGED]);
    }
  });

  it("resumes from a cursor: a client that reconnects at n is sent n+1 onwards", async () => {
    const url = await serve();
    const first = await client(url);
    await first.subscribe({ runId: "run-1", methods: [STEP_CHANGED] });
    await append(stepScheduled("run-1", "sr-1", "plan"));
    await append({ type: "step.started", runId: "run-1", payload: { stepRunId: "sr-1", inputArtifactIds: [] } });
    const seen = await first.waitFor(STEP_CHANGED, 2);
    const cursor = seen[seen.length - 1]!.params.seq;
    expect(cursor).toBe(1);

    // The blip: the socket goes, and the run keeps moving while nobody is listening.
    first.close();
    await append(stepCompleted("run-1", "sr-1"));
    await append(stepScheduled("run-1", "sr-2", "build"));

    const resumed = await client(url);
    const { replayed } = await resumed.subscribe({ runId: "run-1", since: cursor, methods: [STEP_CHANGED] });
    expect(replayed).toBe(2);
    // Live again from where the replay stopped, with no repeat of seq 2 or 3.
    await append({ type: "step.started", runId: "run-1", payload: { stepRunId: "sr-2", inputArtifactIds: [] } });
    const after = await resumed.waitFor(STEP_CHANGED, 3);
    expect(after.map((n) => n.params.seq)).toEqual([2, 3, 4]);
  });

  it("sends the raw log too, minus the agent output the batch already carries", async () => {
    const url = await serve();
    const c = await client(url);
    await c.subscribe({ runId: "run-1" });
    await append({
      type: "human.requested",
      runId: "run-1",
      payload: {
        stepRunId: "sr-1",
        requestId: "hi-1",
        kind: "decision",
        question: "ship?",
        options: [
          { id: "yes", label: "yes" },
          { id: "no", label: "no" },
        ],
        context: {},
      },
    });
    const [opened] = await c.waitFor(INPUT_OPENED, 1);
    // The whole `GateOption` travels as of protocol 1.4, not the ids it used to carry.
    expect(opened!.params).toMatchObject({
      requestId: "hi-1",
      kind: "decision",
      options: [
        { id: "yes", label: "yes" },
        { id: "no", label: "no" },
      ],
      seq: 0,
    });
    // A workflow gate is nobody's agent, so the field is absent rather than empty (#248).
    expect(opened!.params).not.toHaveProperty("agent");
    // The folded notification first, the raw one second: a client watching only the folded
    // stream is never behind one watching both.
    expect(c.methods()).toEqual([INPUT_OPENED, EVENT_APPENDED]);
  });

  it("names the agent a permission ask is holding open", async () => {
    const url = await serve();
    const c = await client(url);
    await c.subscribe({ runId: "run-1" });
    await append({
      type: "human.requested",
      runId: "run-1",
      payload: {
        stepRunId: "sr-1",
        requestId: "hi-perm",
        kind: "permission",
        question: "Run `rm -rf build`?",
        options: [{ id: "allow", label: "Allow" }],
        agent: { id: "builder", hostId: "build-box" },
        context: {},
      },
    });
    const [opened] = await c.waitFor(INPUT_OPENED, 1);
    // Straight off the event, which is what keeps `notificationsFor` free of a store read
    // (#248). `hostType` is configuration and is resolved on `inputs.list`, not pushed.
    expect(opened!.params).toMatchObject({ requestId: "hi-perm", agent: { id: "builder", hostId: "build-box" } });
    expect(opened!.params.agent).not.toHaveProperty("hostType");
  });

  it("coalesces agent output into one notification per step per window", async () => {
    // A 20 ms window rather than the 100 ms default, so the test waits 20 ms and not 100.
    const url = await serve(20);
    const c = await client(url);
    await c.subscribe({ runId: "run-1", methods: [AGENT_UPDATE] });
    for (const text of ["one", "two", "three"]) {
      await append({
        type: "agent.update",
        runId: "run-1",
        payload: { stepRunId: "sr-1", sessionId: "s-1", update: { kind: "agent_message_chunk", text } },
      });
    }
    const [batch] = await c.waitFor(AGENT_UPDATE, 1);
    expect(batch!.params).toMatchObject({ stepRunId: "sr-1", sessionId: "s-1", fromSeq: 0, seq: 2 });
    expect((batch!.params as { updates: { text?: string }[] }).updates.map((u) => u.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("flushes a held batch before the transition that follows it, so nothing arrives out of order", async () => {
    // A window long enough that only the flush-on-transition rule can close it in time.
    const url = await serve(5_000);
    const c = await client(url);
    await c.subscribe({ runId: "run-1", methods: [AGENT_UPDATE, STEP_CHANGED] });
    await append({
      type: "agent.update",
      runId: "run-1",
      payload: { stepRunId: "sr-1", sessionId: "s-1", update: { kind: "agent_message_chunk", text: "working" } },
    });
    await append(stepCompleted("run-1", "sr-1"));
    await c.waitFor(STEP_CHANGED, 1);
    expect(c.methods()).toEqual([AGENT_UPDATE, STEP_CHANGED]);
  });

  it("stops on unsubscribe, and unsubscribing twice is not an error", async () => {
    const url = await serve();
    const c = await client(url);
    const { subscriptionId } = await c.subscribe({ runId: "run-1", methods: [RUN_CHANGED] });
    await append({ type: "run.started", runId: "run-1", payload: {} });
    await c.waitFor(RUN_CHANGED, 1);

    expect(await c.call(UNSUBSCRIBE_METHOD, { subscriptionId })).toMatchObject({ ok: true, result: { stopped: true } });
    await append({ type: "run.completed", runId: "run-1", payload: { outcome: "success" } });
    // Round-trip a request so anything the daemon would have pushed has been and gone.
    expect(await c.call("hello", { client: "t/1", protocol: PROTOCOL_VERSION })).toMatchObject({ ok: true });
    expect(c.notifications).toHaveLength(1);
    expect(await c.call(UNSUBSCRIBE_METHOD, { subscriptionId })).toMatchObject({ result: { stopped: false } });
  });

  it("answers the ordinary methods over the socket too, and refuses a message that is not a request", async () => {
    const url = await serve();
    const c = await client(url);
    expect(await c.call("hello", { client: "t/1", protocol: PROTOCOL_VERSION })).toMatchObject({
      ok: true,
      result: { capabilities: ["runs.read", "runs.subscribe"] },
    });
    expect(await c.call(SUBSCRIBE_METHOD, { since: 1 })).toMatchObject({ error: { code: "PROTOCOL_MESSAGE" } });
    expect(await c.call(UNSUBSCRIBE_METHOD, {})).toMatchObject({ error: { code: "PROTOCOL_MESSAGE" } });
    expect(await c.call("runs.nope", {})).toMatchObject({ error: { code: "PROTOCOL_METHOD" } });
  });
});

describe("the HTTP path", () => {
  let fixture: Fixture;
  let daemon: DaemonHandle;

  afterEach(async () => {
    await daemon.close();
  });

  async function rpc(body: unknown): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> {
    const res = await fetch(`${daemon.url}/rpc`, { method: "POST", body: JSON.stringify(body) });
    return (await res.json()) as { ok: boolean; result?: unknown; error?: { code: string } };
  }

  it("is unchanged by the socket: hello still works with no socket at all", async () => {
    fixture = emptyFixture();
    daemon = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read", "runs.subscribe"],
      reads: new ReadModel({ orchestrator: fixture.orchestrator }),
      source: fixture.orchestrator,
    });
    const hello = await rpc({
      kind: "request",
      id: 1,
      method: "hello",
      params: { client: "t/1", protocol: PROTOCOL_VERSION },
    });
    expect(hello.ok).toBe(true);
    // The subscription methods are advertised: they exist, they just need a connection.
    expect((hello.result as { methods: string[] }).methods).toContain(SUBSCRIBE_METHOD);
    expect((await fetch(`${daemon.url}/health`)).status).toBe(200);
  });

  it("refuses subscribe over /rpc with NOT_SUPPORTED rather than 'unknown method'", async () => {
    fixture = emptyFixture();
    daemon = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read", "runs.subscribe"],
      reads: new ReadModel({ orchestrator: fixture.orchestrator }),
      source: fixture.orchestrator,
    });
    const answer = await rpc({ kind: "request", id: 1, method: SUBSCRIBE_METHOD, params: { runId: "run-1" } });
    expect(answer).toMatchObject({ ok: false, error: { code: "NOT_SUPPORTED" } });
  });

  it("has no socket, and no subscription methods, without a source", async () => {
    fixture = emptyFixture();
    daemon = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read"],
      reads: new ReadModel({ orchestrator: fixture.orchestrator }),
    });
    expect(daemon.socketUrl).toBeUndefined();
    const hello = await rpc({
      kind: "request",
      id: 1,
      method: "hello",
      params: { client: "t/1", protocol: PROTOCOL_VERSION },
    });
    expect((hello.result as { methods: string[] }).methods).not.toContain(SUBSCRIBE_METHOD);
  });
});
