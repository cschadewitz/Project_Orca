/**
 * The single-writer lease per run (#101): two interpreters over one store must not both drive
 * one run id. The log itself cannot arbitrate that - #97 made it well *numbered*, not
 * single-authored - so attaching takes a lease that is heartbeated while the run is driven.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { OrcaError, parseWorkflow, TemplateRegistry, WorkflowRegistry, type Logger } from "@orca/core";
import {
  LocalWorkspaceProvider,
  Orchestrator,
  builtinExecutors,
  completed,
  runLeaseResource,
  type RunLeaseOptions,
} from "@orca/engine";
import { memoryStores, type EventStore, type Stores } from "@orca/store";

const WORKFLOW = `
id: leased
name: leased
start: s
nodes:
  s: { type: start }
  work: { type: "custom:gate" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

/** A step that reports when it is reached and then waits to be let go. */
function gate() {
  let open = () => {};
  let reached = () => {};
  const wait = new Promise<void>((r) => (open = r));
  const entered = new Promise<void>((r) => (reached = r));
  return { entered, release: () => open(), step: async () => (reached(), wait) };
}

interface App {
  orchestrator: Orchestrator;
  stores: Stores;
  /** Every message this orchestrator logged; the only observable a heartbeat has. */
  logged: string[];
}

/** Silent, but remembers what it was told, so a test can wait for an event instead of a delay. */
function recordingLogger(logged: string[]): Logger {
  const self: Logger = {
    log: (_level, msg) => void logged.push(msg),
    debug: (msg) => void logged.push(msg),
    info: (msg) => void logged.push(msg),
    warn: (msg) => void logged.push(msg),
    error: (msg) => void logged.push(msg),
    child: () => self,
  };
  return self;
}

function make(stores: Stores, step: () => Promise<void>, lease?: RunLeaseOptions): App {
  const executors = builtinExecutors().register({
    type: "custom:gate",
    execute: async () => (await step(), completed()),
  });
  const logged: string[] = [];
  return {
    stores,
    logged,
    orchestrator: new Orchestrator({
      stores,
      agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
      workflows: new WorkflowRegistry().register(parseWorkflow(WORKFLOW)),
      templates: new TemplateRegistry(),
      executors,
      workspaceProvider: new LocalWorkspaceProvider("/tmp"),
      logger: recordingLogger(logged),
      ...(lease ? { lease } : {}),
    }),
  };
}

/**
 * The same store, with every *full* read counted. `readTypes` goes to the inner store
 * directly, so the cheap summary projection an attach begins with is not counted as reducing
 * the whole log - which is the thing a refused interpreter must not do (#267).
 */
function countingReads(inner: EventStore, count: { full: number }): EventStore {
  return {
    append: (input) => inner.append(input),
    read: (runId) => (count.full++, inner.read(runId)),
    readTypes: (runId, types) => inner.readTypes(runId, types),
    listRuns: () => inner.listRuns(),
    subscribe: (listener, filter) => inner.subscribe(listener, filter),
  };
}

const openRun = async (app: App) => app.orchestrator.startRun({ workflowId: "leased" });
const noWait = async () => {};

/** Poll rather than sleep a fixed amount: a loaded CI box runs timers late, not never. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("run leases", () => {
  it("a second interpreter is refused while the first is attached, and let in once it detaches", async () => {
    const g = gate();
    const first = make(memoryStores(), g.step);
    const runId = await openRun(first);
    const driving = first.orchestrator.run(runId);
    await g.entered;

    const second = make(first.stores, noWait);
    const refused = await second.orchestrator.run(runId).catch((e: unknown) => e as OrcaError);
    // The refusal has to say where the other interpreter is, or an operator has nothing to act on.
    expect(refused).toBeInstanceOf(OrcaError);
    expect((refused as OrcaError).code).toBe("RUN_LEASED");
    expect((refused as OrcaError).details).toMatchObject({
      runId,
      pid: process.pid,
      holder: first.orchestrator.leaseHolder,
    });

    g.release();
    expect((await driving).run.status).toBe("completed");
    // Detaching gives the lease back, so nothing has to lapse before the next attach.
    expect(await first.stores.leases.get(runLeaseResource(runId))).toBeUndefined();
    expect((await second.orchestrator.run(runId)).run.status).toBe("completed");
  });

  it("the lease is dropped when a run ends, whichever way it ends", async () => {
    for (const finish of ["complete", "cancel"] as const) {
      const g = gate();
      const app = make(memoryStores(), g.step);
      const runId = await openRun(app);
      const driving = app.orchestrator.run(runId);
      await g.entered;
      expect(await app.stores.leases.get(runLeaseResource(runId))).toMatchObject({
        holder: app.orchestrator.leaseHolder,
      });

      if (finish === "cancel") await app.orchestrator.cancel(runId, "by hand");
      g.release();
      await driving;
      expect(await app.stores.leases.get(runLeaseResource(runId))).toBeUndefined();
    }
  });

  it("a lapsed lease is taken over silently: a crashed interpreter must not wedge the run", async () => {
    const g = gate();
    // A short TTL with a heartbeat that never fires is what a dead holder looks like on disk.
    const first = make(memoryStores(), g.step, { ttlMs: 30, renewMs: 1_000_000 });
    const runId = await openRun(first);
    void first.orchestrator.run(runId).catch(() => undefined);
    await g.entered;

    // Waiting longer than the TTL is enough on any machine: a lease nobody renews cannot
    // un-lapse, so a slow box only makes this more true.
    await new Promise((r) => setTimeout(r, 60));
    const second = make(first.stores, noWait);
    expect((await second.orchestrator.listLeases())[0]!.lapsed).toBe(true);
    expect((await second.orchestrator.run(runId)).run.status).toBe("completed");
    expect(await first.stores.leases.list()).toEqual([]);
  });

  it("losing the lease mid-run stops that interpreter without writing to the log it no longer owns", async () => {
    const g = gate();
    const app = make(memoryStores(), g.step, { renewMs: 2 });
    const runId = await openRun(app);
    const driving = app.orchestrator.run(runId).catch((e: unknown) => e as OrcaError);
    await g.entered;

    const before = (await app.stores.events.read(runId)).map((e) => `${e.seq}:${e.type}`);
    await app.orchestrator.breakLease(runId, { force: true });
    await until("the heartbeat to notice", () => app.logged.includes("run lease lost; stopping this interpreter"));
    g.release();

    // Not one event after the break: a `step.cancelled`/`run.cancelled` from here would land in
    // the log the operator has just handed to somebody else, and cancel *their* run (#267).
    expect((await app.stores.events.read(runId)).map((e) => `${e.seq}:${e.type}`)).toEqual(before);
    expect((await app.orchestrator.getSummary(runId)).status).toBe("running");
    // The caller is told rather than handed a state that stopped for no stated reason.
    const outcome = await driving;
    expect(outcome).toBeInstanceOf(OrcaError);
    expect((outcome as OrcaError).code).toBe("RUN_LEASED");
    expect(app.logged).toContain("run lease lost; stopping without writing to the run's log");
    // The lease that was taken away is the new holder's now; stopping must not release it.
    expect(await app.stores.leases.get(runLeaseResource(runId))).toBeUndefined();
  });

  it("a refused interpreter reduces nothing, so a RUN_LEASED refusal leaves no context behind", async () => {
    const g = gate();
    const first = make(memoryStores(), g.step);
    const runId = await openRun(first);
    const driving = first.orchestrator.run(runId);
    await g.entered;

    const count = { full: 0 };
    const second = make({ ...first.stores, events: countingReads(first.stores.events, count) }, noWait);
    await expect(second.orchestrator.run(runId)).rejects.toMatchObject({ code: "RUN_LEASED" });
    // The lease is decided before the log is read, so the refusal has nothing to cache: the
    // next attach reduces the log the *holder* left, never the one this attempt saw.
    expect(count.full).toBe(0);

    g.release();
    await driving;
    expect((await second.orchestrator.getSummary(runId)).status).toBe("completed");
    expect((await second.orchestrator.run(runId)).run.status).toBe("completed");
  });

  it("a finished run is not leased at all - reading it back must not leave a lease on file", async () => {
    const app = make(memoryStores(), noWait);
    const runId = await openRun(app);
    expect((await app.orchestrator.run(runId)).run.status).toBe("completed");
    expect(await app.stores.leases.list()).toEqual([]);

    expect((await app.orchestrator.run(runId)).run.status).toBe("completed");
    expect(await app.stores.leases.list()).toEqual([]);
  });

  it("breakLease refuses a live lease without force, and then finds nothing left to break", async () => {
    const g = gate();
    const first = make(memoryStores(), g.step);
    const runId = await openRun(first);
    const driving = first.orchestrator.run(runId);
    await g.entered;

    const second = make(first.stores, noWait);
    await expect(second.orchestrator.breakLease(runId)).rejects.toMatchObject({ code: "RUN_STATE" });
    const broken = await second.orchestrator.breakLease(runId, { force: true });
    expect(broken.map((l) => [l.runId, l.lapsed])).toEqual([[runId, false]]);
    await expect(second.orchestrator.breakLease(runId)).rejects.toMatchObject({ code: "LEASE_NOT_FOUND" });

    g.release();
    await driving;
  });

  it("listLeases names the run and the workflow behind each lease", async () => {
    const g = gate();
    const app = make(memoryStores(), g.step);
    const runId = await openRun(app);
    const driving = app.orchestrator.run(runId);
    await g.entered;

    expect((await app.orchestrator.listLeases()).map((l) => [l.runId, l.lapsed, l.note])).toEqual([
      [runId, false, "leased"],
    ]);

    g.release();
    await driving;
  });

  it("cancelling a run another interpreter holds is refused rather than raced into its log", async () => {
    const g = gate();
    const first = make(memoryStores(), g.step);
    const runId = await openRun(first);
    const driving = first.orchestrator.run(runId);
    await g.entered;

    const second = make(first.stores, noWait);
    await expect(second.orchestrator.cancel(runId, "from elsewhere")).rejects.toMatchObject({ code: "RUN_LEASED" });

    g.release();
    expect((await driving).run.status).toBe("completed");
  });
});
