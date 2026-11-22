/**
 * The operations view's daemon half (#340): `runs.list` filters and `operations` facts, and
 * two clients following the same runs through perturbed streams - duplicated, reordered and
 * dropped frames, a reconnect by snapshot, a resume by cursor, a daemon restart - that end
 * showing exactly what `runs.get` says, on the in-memory, file and SQLite stores alike.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  FakeClock,
  TemplateRegistry,
  WorkflowRegistry,
  silentLogger,
  type OrcaEventInput,
  type Workspace,
} from "@orca/core";
import { Orchestrator, runLeaseResource } from "@orca/engine";
import { fileStores, memoryStores, sqliteStores, type Stores } from "@orca/store";
import {
  parseNotification,
  RunFollower,
  type FollowPhase,
  type NotificationMessage,
  type RunSummaryView,
} from "@orca/protocol";
import { ReadModel, Subscription } from "../src/index.js";
import { fixture, START, STEP_MS } from "./fixture.js";

const workspace: Workspace = { hostId: "local", cwd: "/work/orca", repo: "orca", branch: "main" };

// ---------------------------------------------------------------- runs.list

describe("runs.list for the operations view", () => {
  it("filters by outcome, workflow and version, and creation time", async () => {
    const f = await fixture();
    const reads = new ReadModel({ orchestrator: f.orchestrator, clock: f.clock });
    const ids = async (params: Parameters<ReadModel["runsList"]>[0]) =>
      (await reads.runsList(params)).runs.map((r) => r.id);
    const all = await reads.runsList({ limit: 100, offset: 0 });
    expect(all.runs.length).toBeGreaterThan(2);

    const failed = all.runs.filter((r) => r.outcome === "failure").map((r) => r.id);
    expect(failed.length).toBeGreaterThan(0);
    expect(await ids({ outcome: ["failure"], limit: 100, offset: 0 })).toEqual(failed);
    // Live runs have no outcome, so an outcome filter never matches them.
    expect(await ids({ outcome: ["success", "failure", "cancelled"], limit: 100, offset: 0 })).toEqual(
      all.runs.filter((r) => r.outcome).map((r) => r.id),
    );

    const first = all.runs[0]!;
    expect(await ids({ workflowId: first.workflowId, limit: 100, offset: 0 })).toEqual(
      all.runs.filter((r) => r.workflowId === first.workflowId).map((r) => r.id),
    );
    expect(await ids({ workflowId: first.workflowId, workflowVersion: "no-such", limit: 100, offset: 0 })).toEqual([]);

    // [from, to): a run created exactly at `to` is outside, one created at `from` inside.
    const pivot = all.runs[1]!.createdAt;
    expect(await ids({ createdFrom: pivot, limit: 100, offset: 0 })).toEqual(
      all.runs.filter((r) => r.createdAt >= pivot).map((r) => r.id),
    );
    expect(await ids({ createdTo: pivot, limit: 100, offset: 0 })).toEqual(
      all.runs.filter((r) => r.createdAt < pivot).map((r) => r.id),
    );
  });

  it("adds operations facts only when asked, with facets unavailable rather than zero", async () => {
    const f = await fixture();
    const reads = new ReadModel({ orchestrator: f.orchestrator, clock: f.clock });
    const plain = await reads.runsList({ limit: 100, offset: 0 });
    expect(plain.runs.every((r) => r.operations === undefined)).toBe(true);

    const ops = await reads.runsList({ operations: true, limit: 100, offset: 0 });
    // Same rows, same order, same fields - plus `operations`.
    expect(ops.runs.map(({ operations: _ops, ...r }) => r)).toEqual(plain.runs);
    for (const row of ops.runs) {
      const events = await f.stores.events.read(row.id);
      const last = events.at(-1)!;
      expect(row.operations).toMatchObject({
        lastSeq: last.seq,
        lastActivityAt: last.at,
        facets: {
          host: { state: "unavailable", reason: "not-collected" },
          usage: { state: "unavailable", reason: "not-collected" },
        },
      });
      // The list's counts, read from step transitions, agree with the full projection's.
      const got = await reads.runsGet({ runId: row.id, operations: true });
      expect(row.operations).toEqual(got.run.operations);
      expect(got.lastSeq).toBe(row.operations!.lastSeq);
    }
    const parent = ops.runs.find((r) => r.id === "run-parent")!;
    expect(parent.operations!.owner).toMatchObject({ holder: "test-holder", lapsed: false });
    expect(parent.operations!.progress.attempts).toBeGreaterThan(1);
    expect(ops.runs.find((r) => r.id === "run-lost")!.operations!.owner).toBeUndefined();
  });

  it("anchors a row and its operations to one watermark when a commit lands between reads", async () => {
    const clock = new FakeClock(START);
    const stores = memoryStores(clock);
    const append = async (e: OrcaEventInput) => {
      clock.advance(STEP_MS);
      return (await stores.events.append(e)).seq;
    };
    await append({
      type: "run.created",
      runId: "r",
      payload: { workflowId: "wf", workflowVersion: "1", workspace, vars: {} },
    });
    await append({ type: "run.started", runId: "r", payload: {} });
    await append({
      type: "step.scheduled",
      runId: "r",
      payload: { stepRunId: "s", nodeId: "n", nodeType: "agent", attempt: 1 },
    });
    const watermark = await append({
      type: "step.started",
      runId: "r",
      payload: { stepRunId: "s", inputArtifactIds: [] },
    });

    // The next read of the store lets a commit in right after it answers: the step completes.
    const events = stores.events;
    let armed = false;
    const commitAfter = async <T>(answer: T): Promise<T> => {
      if (armed) {
        armed = false;
        await append({
          type: "step.completed",
          runId: "r",
          payload: { stepRunId: "s", result: { artifactIds: [], data: {} } },
        });
      }
      return answer;
    };
    const readRange = events.readRange.bind(events);
    const read = events.read.bind(events);
    const readTypes = events.readTypes.bind(events);
    // Only once the listing pass is done, for the second case below.
    let typesArmed = false;
    events.readTypes = async (runId, types) => {
      const answer = await readTypes(runId, types);
      if (typesArmed) {
        typesArmed = false;
        armed = true;
        return commitAfter(answer);
      }
      return answer;
    };
    events.readRange = async (runId, range) => commitAfter(await readRange(runId, range));
    events.read = async (runId) => commitAfter(await read(runId));
    const reads = new ReadModel({ orchestrator: orchestrator(stores, clock), clock });

    // runs.list, a commit between the listing pass and the row's reads: the row is read again,
    // whole, at the newer watermark - never old counts under a new `lastSeq`.
    typesArmed = true;
    const first = (await reads.runsList({ operations: true, limit: 10, offset: 0 })).runs[0]!;
    expect(first.operations).toMatchObject({
      lastSeq: watermark + 1,
      progress: { attempts: 1, active: 0, completed: 1 },
    });

    // runs.list, a commit after the newest event is read and before the row's events are:
    // the row stops at that watermark rather than counting past it.
    armed = true;
    const second = (await reads.runsList({ operations: true, limit: 10, offset: 0 })).runs[0]!;
    expect(armed).toBe(false);
    expect(second.operations).toMatchObject({ lastSeq: watermark + 1, progress: { completed: 1 } });

    // runs.get: the commit lands after the projection is read, before its operations are.
    armed = true;
    const got = await reads.runsGet({ runId: "r", operations: true });
    expect(armed).toBe(false);
    expect(got.lastSeq).toBe(watermark + 2);
    expect(got.run.operations).toMatchObject({ lastSeq: got.lastSeq, progress: { completed: 1, active: 0 } });
    const late = await reads.runsGet({ runId: "r", operations: true });
    expect(late.run.operations!.lastSeq).toBe(late.lastSeq);
  });

  it("pages deterministically: pages concatenate to the full list, ties broken by id", async () => {
    const clock = new FakeClock(START);
    const stores = memoryStores(clock);
    // Six runs created at the same instant: only the id can order them.
    for (const id of ["run-c", "run-a", "run-f", "run-b", "run-e", "run-d"])
      await stores.events.append({
        type: "run.created",
        runId: id,
        payload: { workflowId: "wf", workflowVersion: "1", workspace, vars: {} },
      });
    const reads = new ReadModel({ orchestrator: orchestrator(stores, clock), clock });
    const full = (await reads.runsList({ limit: 100, offset: 0 })).runs.map((r) => r.id);
    expect(full).toEqual(["run-f", "run-e", "run-d", "run-c", "run-b", "run-a"]);
    const paged: string[] = [];
    for (let offset = 0; offset < full.length; offset += 4)
      paged.push(...(await reads.runsList({ limit: 4, offset, operations: true })).runs.map((r) => r.id));
    expect(paged).toEqual(full);
  });
});

// ---------------------------------------------------------------- convergence

function orchestrator(stores: Stores, clock: FakeClock): Orchestrator {
  return new Orchestrator({
    stores,
    clock,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry(),
    templates: new TemplateRegistry(),
    logger: silentLogger,
  });
}

interface Backend {
  name: string;
  /** Open the stores; a persistent backend reopens the same ones after a restart. */
  open(clock: FakeClock): Stores;
  persistent: boolean;
}

const dirs: string[] = [];
const opened: Stores[] = [];
afterEach(async () => {
  for (const stores of opened.splice(0)) stores.close?.();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function backend(kind: "memory" | "file" | "sqlite"): Promise<Backend> {
  if (kind === "memory") return { name: kind, persistent: false, open: (clock) => memoryStores(clock) };
  const dir = await mkdtemp(join(tmpdir(), `orca-ops-${kind}-`));
  dirs.push(dir);
  return {
    name: kind,
    persistent: true,
    open: (clock) => {
      const stores = kind === "file" ? fileStores(dir, clock) : sqliteStores(dir, { clock });
      opened.push(stores);
      return stores;
    },
  };
}

/** The daemon side: stores, engine and read model, rebuilt from the same stores on restart. */
class Daemon {
  stores: Stores;
  orc: Orchestrator;
  reads: ReadModel;
  constructor(
    readonly backend: Backend,
    readonly clock: FakeClock,
  ) {
    this.stores = backend.open(clock);
    this.orc = orchestrator(this.stores, clock);
    this.reads = new ReadModel({ orchestrator: this.orc, clock });
  }
  restart(): void {
    this.stores.close?.();
    this.stores = this.backend.open(this.clock);
    this.orc = orchestrator(this.stores, this.clock);
    this.reads = new ReadModel({ orchestrator: this.orc, clock: this.clock });
  }
  async append(e: OrcaEventInput): Promise<void> {
    this.clock.advance(STEP_MS);
    await this.stores.events.append(e);
  }
}

/**
 * Frames between a subscription and a follower. `perturb` decides, per frame, to pass it,
 * send it twice, hold it back past the next frame, or lose it.
 */
type Fate = "pass" | "twice" | "late" | "lost";

class Client {
  readonly follower: RunFollower;
  readonly phases = new Map<string, FollowPhase[]>();
  private subscriptions: Subscription[] = [];
  private late: NotificationMessage | undefined;
  frames = 0;
  reads = 0;
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;

  /** Hold every snapshot read until `releaseReads`: a slow daemon, made exact. */
  holdReads(): void {
    this.gate = new Promise((resolve) => (this.open = resolve));
  }
  releaseReads(): void {
    this.open?.();
    this.gate = undefined;
  }

  constructor(
    readonly name: string,
    private readonly daemon: Daemon,
    private readonly perturb: (frame: number, message: NotificationMessage) => Fate = () => "pass",
  ) {
    this.follower = new RunFollower({
      fetch: async (runId) => {
        await this.gate;
        this.reads++;
        const got = await this.daemon.reads.runsGet({ runId, operations: true });
        return { run: got.run, lastSeq: got.lastSeq };
      },
      refreshDelayMs: 1,
      backoffMs: () => 2,
      onChange: (view) => {
        const seen = this.phases.get(view.runId) ?? [];
        if (seen.at(-1) !== view.phase) seen.push(view.phase);
        this.phases.set(view.runId, seen);
      },
    });
  }

  private receive = (message: NotificationMessage): void => {
    const fate = this.perturb(this.frames++, message);
    if (fate === "lost") return;
    if (fate === "late") {
      this.late = message;
      return;
    }
    this.deliver(message);
    if (fate === "twice") this.deliver(message);
    if (this.late) {
      const late = this.late;
      this.late = undefined;
      this.deliver(late);
    }
  };

  private deliver(message: NotificationMessage): void {
    const n = parseNotification(message);
    if (n) this.follower.notify(n);
  }

  /** A store-wide subscription, as the app holds. */
  async connect(): Promise<void> {
    await this.subscribe({});
  }

  /** One subscription per followed run, each resuming after the run's cursor. */
  async resume(): Promise<void> {
    for (const run of this.follower.list())
      await this.subscribe({ runId: run.runId, ...(run.cursor >= 0 ? { since: run.cursor } : {}) });
  }

  private async subscribe(params: { runId?: string; since?: number }): Promise<void> {
    const subscription = new Subscription({
      id: `${this.name}-${this.subscriptions.length}`,
      params,
      source: this.daemon.orc,
      send: (m) => this.receive(m),
      batchMs: 3,
    });
    this.subscriptions.push(subscription);
    await subscription.start();
  }

  disconnect(): void {
    for (const s of this.subscriptions.splice(0)) s.stop();
    // What was in flight on the wire is gone with the connection.
    this.late = undefined;
  }

  /** Settled: every run live or terminal, nothing held for later. */
  settled(): boolean {
    return this.follower.list().every((r) => r.phase === "live" || r.phase === "terminal");
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(what: string, ok: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await ok()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** What `runs.get` says now, the thing every client must end up showing. */
async function truth(daemon: Daemon, runId: string): Promise<{ run: RunSummaryView; lastSeq: number }> {
  const got = await daemon.reads.runsGet({ runId, operations: true });
  return { run: got.run, lastSeq: got.lastSeq };
}

async function converged(daemon: Daemon, clients: Client[], runIds: string[]): Promise<void> {
  await until("clients to converge", async () => {
    if (!clients.every((c) => c.settled())) return false;
    for (const runId of runIds) {
      const want = await truth(daemon, runId);
      for (const c of clients) {
        const view = c.follower.get(runId)!;
        if (view.cursor !== want.lastSeq || view.snapshotSeq === undefined) return false;
        try {
          expect(view.run).toEqual(want.run);
        } catch {
          return false;
        }
      }
    }
    return true;
  });
  for (const runId of runIds) {
    const want = await truth(daemon, runId);
    for (const c of clients) {
      expect(c.follower.get(runId)!.run, `${c.name} ${runId}`).toEqual(want.run);
      expect(c.follower.get(runId)!.cursor).toBe(want.lastSeq);
    }
  }
}

const update = (runId: string, stepRunId: string, text: string): OrcaEventInput => ({
  type: "agent.update",
  runId,
  payload: { stepRunId, sessionId: `sess-${stepRunId}`, update: { kind: "text", text } },
});

/** Two runs, interleaved: parallel agent output, a slot wait, a human wait, one finishing. */
async function script(daemon: Daemon, phase: 1 | 2): Promise<void> {
  const a = (e: OrcaEventInput) => daemon.append(e);
  if (phase === 1) {
    for (const runId of ["run-1", "run-2"]) {
      await a({
        type: "run.created",
        runId,
        payload: { workflowId: "ops", workflowVersion: "3", workspace, vars: {} },
      });
      await a({ type: "run.started", runId, payload: {} });
    }
    await daemon.stores.leases.acquire({ resource: runLeaseResource("run-2"), holder: "daemon-a", ttlMs: 600_000 });
    for (const [runId, step, node] of [
      ["run-1", "s1", "build"],
      ["run-1", "s2", "test"],
      ["run-2", "s3", "plan"],
    ] as const) {
      await a({
        type: "step.scheduled",
        runId,
        payload: { stepRunId: step, nodeId: node, nodeType: "agent", attempt: 1 },
      });
      await a({ type: "step.started", runId, payload: { stepRunId: step, inputArtifactIds: [] } });
    }
    // Two steps of run-1 writing at once: their batches interleave sequence numbers.
    for (let i = 0; i < 4; i++) {
      await a(update("run-1", "s1", `build ${i}`));
      await a(update("run-1", "s2", `test ${i}`));
      await a(update("run-2", "s3", `plan ${i}`));
    }
    await a({ type: "step.waiting", runId: "run-2", payload: { stepRunId: "s3", on: "agent-slot", detail: "cap 1" } });
    await a({
      type: "step.completed",
      runId: "run-1",
      payload: { stepRunId: "s1", result: { artifactIds: [], data: {} } },
    });
    await a({
      type: "step.failed",
      runId: "run-1",
      payload: { stepRunId: "s2", error: { code: "AGENT", message: "flaky" }, willRetry: true },
    });
    return;
  }
  await a({
    type: "step.scheduled",
    runId: "run-1",
    payload: { stepRunId: "s2b", nodeId: "test", nodeType: "agent", attempt: 2 },
  });
  await a({ type: "step.started", runId: "run-1", payload: { stepRunId: "s2b", inputArtifactIds: [] } });
  await a({ type: "step.started", runId: "run-2", payload: { stepRunId: "s3", inputArtifactIds: [] } });
  for (let i = 0; i < 3; i++) {
    await a(update("run-1", "s2b", `retry ${i}`));
    await a(update("run-2", "s3", `plan again ${i}`));
  }
  await a({
    type: "step.completed",
    runId: "run-1",
    payload: { stepRunId: "s2b", result: { artifactIds: [], data: {} } },
  });
  await a({ type: "run.completed", runId: "run-1", payload: { outcome: "success" } });
  await a({
    type: "step.waiting",
    runId: "run-2",
    payload: { stepRunId: "s3", on: "human-input", detail: "approve?" },
  });
}

describe.each(["memory", "file", "sqlite"] as const)("operations view convergence on %s stores", (kind) => {
  it("two clients, one with a lossy, duplicating, reordering stream, converge on runs.get", async () => {
    const daemon = new Daemon(await backend(kind), new FakeClock(START));
    const clean = new Client("clean", daemon);
    // Frames are counted from when the runs are followed, so the perturbation lands where it
    // matters; the frame lost is the first `event.appended` of run-2 after that, which a
    // later event of run-2 then shows to be missing. Its snapshot reads are held until the
    // script is done, so no read can paper over the loss before the stream reveals it.
    let followedAt = Number.POSITIVE_INFINITY;
    let run2Events = 0;
    const lossy = new Client("lossy", daemon, (frame, message) => {
      const i = frame - followedAt;
      if (i < 0) return "pass";
      const p = message.params as { runId?: string };
      if (message.method === "event.appended" && p.runId === "run-2" && ++run2Events === 1) return "lost";
      return i % 5 === 2 ? "twice" : i % 7 === 3 ? "late" : "pass";
    });
    await clean.connect();
    await lossy.connect();
    await script(daemon, 1);
    for (const c of [clean, lossy]) for (const runId of ["run-1", "run-2"]) c.follower.follow(runId);
    await until("first snapshots", () => clean.settled() && lossy.settled());
    followedAt = lossy.frames;
    lossy.holdReads();
    await script(daemon, 2);
    lossy.releaseReads();
    await converged(daemon, [clean, lossy], ["run-1", "run-2"]);

    const run1 = clean.follower.get("run-1")!;
    expect(run1.phase).toBe("terminal");
    expect(run1.run).toMatchObject({ status: "succeeded", outcome: "success" });
    expect(run1.run!.operations!.progress).toEqual({
      attempts: 3,
      completed: 2,
      failed: 1,
      active: 0,
      waiting: 0,
      skipped: 0,
    });
    const run2 = clean.follower.get("run-2")!;
    expect(run2.phase).toBe("live");
    expect(run2.run).toMatchObject({ waitingOn: "human-input", waitingDetail: "approve?" });
    expect(run2.run!.operations).toMatchObject({
      owner: { holder: "daemon-a", lapsed: false },
      facets: { host: { state: "unavailable" }, usage: { state: "unavailable" } },
    });
    // The lossy stream lost a frame, noticed, and healed it with a snapshot; the clean one never had to.
    expect([...lossy.phases.values()].flat()).toContain("resyncing");
    expect([...clean.phases.values()].flat()).not.toContain("resyncing");
    lossy.disconnect();
    clean.disconnect();
  });

  it("recovers after a dropped connection by snapshot, by cursor, and across a restart", async () => {
    const daemon = new Daemon(await backend(kind), new FakeClock(START));
    const bySnapshot = new Client("snapshot", daemon);
    const byCursor = new Client("cursor", daemon);
    await script(daemon, 1);
    for (const c of [bySnapshot, byCursor]) {
      for (const runId of ["run-1", "run-2"]) c.follower.follow(runId);
      await c.connect();
    }
    await converged(daemon, [bySnapshot, byCursor], ["run-1", "run-2"]);

    // Both lose the connection; the log moves on while they are away.
    bySnapshot.disconnect();
    bySnapshot.follower.connectionLost();
    byCursor.disconnect();
    expect(bySnapshot.follower.list().map((r) => r.phase)).toEqual(["reconnecting", "reconnecting"]);
    if (daemon.backend.persistent) daemon.restart();
    await script(daemon, 2);

    // One comes back store-wide and re-reads; the other resumes each run after its cursor.
    await bySnapshot.connect();
    bySnapshot.follower.connectionRestored();
    const readsBefore = byCursor.reads;
    await byCursor.resume();
    await converged(daemon, [bySnapshot, byCursor], ["run-1", "run-2"]);
    // Resuming by cursor replays exactly the missed frames: no gap, so no resync read -
    // only the debounced reads its lifecycle frames ask for.
    expect([...byCursor.phases.values()].flat()).not.toContain("resyncing");
    expect(byCursor.reads).toBeGreaterThan(readsBefore);
    expect(bySnapshot.follower.get("run-1")!.phase).toBe("terminal");
    bySnapshot.disconnect();
    byCursor.disconnect();
  });
});
