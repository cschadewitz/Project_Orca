/**
 * The four store workloads of #341, written against the #338 contracts only, so the same code
 * measures every backend:
 *
 * - dependencyTraversal: "what blocks this work item" over a plan's dependency graph.
 * - paginatedHistory: the timeline's reads of a run log: tail page, backward and forward paging,
 *   a type-filtered page, and `lastSeq`.
 * - concurrentMetadataWrites: several writers doing compare-and-swap increments on a few hot
 *   documents beside unconditional writes of their own, at several concurrency levels, with the
 *   no-lost-update invariant checked afterwards.
 * - projectionRebuild: a derived read model (run summaries + dependency index) cached on disk,
 *   deleted, and rebuilt from the authoritative stores, then checked equal to what was lost.
 *
 * Every function takes `{ api, backend, root, scale, seed, repeat }` and returns a plain JSON
 * result. "cold" samples read through a fresh handle (empty in-process caches; the OS page cache
 * stays warm, see the README); "warm" samples reuse one handle after an untimed warm-up read.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { prng, round, summarize, timed } from "./stats.js";

const AT = "2026-01-01T00:00:00.000Z";

// ------------------------------------------------------------------ datasets

/** Seed one plan's dependency DAG (each item depends on up to `fanIn` earlier items) plus noise in another plan. */
export async function seedDependencies({ api, handle, scale, seed }) {
  const random = prng(seed);
  const deps = [];
  const dependency = (id, planId, from, to) =>
    api.core.DependencySchema.parse({
      id,
      planId,
      from,
      target: { kind: "work-item", workItemId: to },
      origin: { kind: "system" },
      createdAt: AT,
      updatedAt: AT,
    });
  for (let i = 1; i < scale.workItems; i++) {
    const targets = new Set();
    for (let k = 0; k < scale.dependencyFanIn; k++) targets.add(Math.floor(random() * i));
    for (const j of targets) deps.push(dependency(`dep_${i}_${j}`, "plan_bench", `wi_${i}`, `wi_${j}`));
  }
  // A second plan's edges, so the plan filter has something to filter out.
  const noise = Math.max(1, Math.floor(deps.length / 10));
  for (let n = 0; n < noise; n++) deps.push(dependency(`dep_noise_${n}`, "plan_other", `wx_${n}`, `wx_${n + 1}`));
  await handle.stores().plan.dependencies.putMany(deps);
  return { dependencies: deps.length, planDependencies: deps.length - noise };
}

/** Seed `runs` run logs of `eventsPerRun` events: mostly agent updates, a step boundary every 50. */
export async function seedHistory({ handle, scale }) {
  const events = handle.stores().events;
  const text = "streamed agent output ".repeat(8);
  await Promise.all(
    Array.from({ length: scale.runs }, async (_, r) => {
      const runId = `run_bench_${r}`;
      await events.append({
        type: "run.created",
        runId,
        payload: { workflowId: "bench", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
      });
      for (let i = 1; i < scale.eventsPerRun; i++)
        await events.append(
          i % 50 === 0
            ? { type: "step.started", runId, payload: { stepRunId: `step_${i}` } }
            : {
                type: "agent.update",
                runId,
                payload: {
                  stepRunId: `step_${i - (i % 50)}`,
                  sessionId: "s",
                  update: { kind: "agent_message_chunk", text },
                },
              },
        );
    }),
  );
  return { runs: scale.runs, eventsPerRun: scale.eventsPerRun, events: scale.runs * scale.eventsPerRun };
}

// ----------------------------------------------------------- 1. traversal

/** Transitive blockers of `start` over `edges` (from -> targets), breadth first. */
function blockers(edges, start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length)
    for (const next of edges.get(queue.shift()) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  return seen.size;
}

async function blockersOf(api, deps, item) {
  const { items } = await api.store.queryDocuments(deps, { where: { planId: "plan_bench" } });
  const edges = new Map();
  for (const d of items) {
    const list = edges.get(d.from) ?? [];
    list.push(d.target.workItemId);
    edges.set(d.from, list);
  }
  return { reached: blockers(edges, item), edges: items.length, adjacency: edges };
}

export async function dependencyTraversal({ api, backend, handle, scale, seed }) {
  const random = prng(seed ^ 0x5eed);
  const samples = Array.from({ length: scale.traversalSamples }, () => `wi_${Math.floor(random() * scale.workItems)}`);
  const cold = [];
  for (const item of samples)
    cold.push((await timed(() => blockersOf(api, handle.stores().plan.dependencies, item))).ms);
  const warmDeps = handle.stores().plan.dependencies;
  const first = await blockersOf(api, warmDeps, samples[0]);
  const warm = [];
  for (const item of samples) warm.push((await timed(() => blockersOf(api, warmDeps, item))).ms);
  // A full topological order of the plan, the scheduler's question: Kahn's algorithm.
  const order = await timed(async () => {
    const indegree = new Map();
    for (let i = 0; i < scale.workItems; i++) indegree.set(`wi_${i}`, 0);
    const reverse = new Map();
    for (const [from, targets] of first.adjacency)
      for (const to of targets) {
        indegree.set(from, (indegree.get(from) ?? 0) + 1);
        reverse.set(to, [...(reverse.get(to) ?? []), from]);
      }
    const ready = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
    let ordered = 0;
    while (ready.length) {
      const id = ready.pop();
      ordered++;
      for (const dependent of reverse.get(id) ?? []) {
        indegree.set(dependent, indegree.get(dependent) - 1);
        if (indegree.get(dependent) === 0) ready.push(dependent);
      }
    }
    return ordered;
  });
  return {
    planDependencies: first.edges,
    cold: backend.durable ? summarize(cold) : "same as warm: in-process backend",
    warm: summarize(warm),
    topologicalOrderMs: round(order.ms),
    checks: { acyclicOrderCoversPlan: order.value === scale.workItems },
  };
}

// ------------------------------------------------------------- 2. history

export async function paginatedHistory({ backend, handle, scale, repeat }) {
  const runId = "run_bench_0";
  const limit = scale.pageSize;
  const out = { pageSize: limit };
  const phases = backend.durable ? ["cold", "warm"] : ["warm"];
  for (const phase of phases) {
    const fixed = handle.stores().events;
    if (phase === "warm") await fixed.readRange(runId, { before: Number.MAX_SAFE_INTEGER, limit });
    const events = () => (phase === "cold" ? handle.stores().events : fixed);
    const sample = async (fn) => {
      const ms = [];
      for (let i = 0; i < Math.max(repeat, 5); i++) ms.push((await timed(() => fn(events()))).ms);
      return summarize(ms);
    };
    const last = await fixed.lastSeq(runId);
    out[phase] = {
      lastSeq: await sample((e) => e.lastSeq(runId)),
      tailPage: await sample((e) => e.readRange(runId, { before: last + 1, limit })),
      filteredPage: await sample((e) => e.readRange(runId, { types: ["step.started"], limit })),
    };
    // Walk the whole log forward and back one page at a time, as a scrolling timeline does.
    const forward = [];
    let after = -1;
    let seen = 0;
    const walker = events();
    for (;;) {
      const { ms, value } = await timed(() => walker.readRange(runId, { after, limit }));
      if (value.length === 0) break;
      forward.push(ms);
      seen += value.length;
      after = value[value.length - 1].seq;
    }
    const backward = [];
    let before = last + 1;
    for (let i = 0; i < 20 && before > 0; i++) {
      const { ms, value } = await timed(() => walker.readRange(runId, { before, limit }));
      backward.push(ms);
      before = value[0]?.seq ?? 0;
    }
    out[phase].forwardPages = summarize(forward);
    out[phase].backwardPages = summarize(backward);
    out[phase].checks = { forwardWalkSawEveryEvent: seen === scale.eventsPerRun };
  }
  if (!backend.durable) out.cold = "same as warm: in-process backend";
  return out;
}

// ---------------------------------------------------- 3. concurrent writes

/** Attempts per CAS increment before it counts as failed; enough that 16 contending writers all finish. */
export const CAS_ATTEMPTS = 64;

export async function concurrentMetadataWrites({ api, handle, scale, seed }) {
  const body = "x".repeat(200);
  const hot = Array.from({ length: scale.hotDocs }, (_, i) => `hot_${i}`);
  const levels = [];
  for (const writers of scale.concurrency) {
    // Every level starts from an identically seeded collection of its own, so earlier levels'
    // rows never grow the file a later level writes to.
    const name = `bench-metadata-${writers}`;
    await handle
      .collection(name)
      .putMany([
        ...Array.from({ length: scale.collectionDocs }, (_, i) => ({ id: `doc_${i}`, owner: "seed", n: 0, body })),
        ...hot.map((id) => ({ id, owner: "hot", n: 0, body })),
      ]);
    // Each writer's operations are fixed before timing starts: which hot key each CAS targets
    // does not depend on how the writers happen to interleave.
    const random = prng(seed ^ writers);
    const schedules = Array.from({ length: writers }, (_, w) =>
      Array.from({ length: scale.opsPerWriter }, (_, i) =>
        i % 2 === 0
          ? { kind: "cas", id: hot[Math.floor(random() * hot.length)] }
          : { kind: "put", id: `own_${w}_${i}`, doc: { id: `own_${w}_${i}`, owner: `w${w}`, n: i, body } },
      ),
    );
    const intendedCas = schedules.flat().filter((op) => op.kind === "cas").length;
    const intendedPuts = schedules
      .flat()
      .filter((op) => op.kind === "put")
      .map((op) => op.id);
    const before = await sumHot(api, handle.collection(name), hot);
    const latencies = [];
    let casOk = 0;
    let putOk = 0;
    let conflicts = 0;
    let exhausted = 0;
    let errors = 0;
    const errorCodes = {};
    const start = performance.now();
    await Promise.all(
      schedules.map(async (ops) => {
        const docs = api.store.asVersionedDocumentStore(handle.collection(name));
        for (const op of ops) {
          const t = performance.now();
          try {
            if (op.kind === "cas") {
              let done = false;
              for (let attempt = 0; attempt < CAS_ATTEMPTS && !done; attempt++) {
                const current = await docs.getVersioned(op.id);
                const result = await docs.putIfVersion({ ...current.doc, n: current.doc.n + 1 }, current.version);
                if (result.ok) done = true;
                else conflicts++;
              }
              if (done) casOk++;
              else exhausted++;
            } else {
              await docs.put(op.doc);
              putOk++;
            }
          } catch (error) {
            errors++;
            const code = error?.code ?? error?.name ?? "Error";
            errorCodes[code] = (errorCodes[code] ?? 0) + 1;
          }
          latencies.push(performance.now() - t);
        }
      }),
    );
    const wallMs = performance.now() - start;
    const reader = api.store.asVersionedDocumentStore(handle.collection(name));
    const after = await sumHot(api, reader, hot);
    const present = new Set((await reader.list((d) => d.id.startsWith("own_"))).map((d) => d.id));
    const attempted = intendedCas + intendedPuts.length;
    const succeeded = casOk + putOk;
    levels.push({
      writers,
      attemptedOps: attempted,
      succeededOps: succeeded,
      wallMs: round(wallMs),
      attemptedOpsPerSecond: round(attempted / (wallMs / 1000)),
      // Only committed operations count as throughput: a backend that commits nothing scores zero.
      succeededOpsPerSecond: round(succeeded / (wallMs / 1000)),
      latency: summarize(latencies),
      cas: {
        intended: intendedCas,
        succeeded: casOk,
        conflicts,
        retriesExhausted: exhausted,
        attemptLimit: CAS_ATTEMPTS,
      },
      errors,
      ...(errors ? { errorCodes } : {}),
      checks: {
        everyIntendedOperationCommitted: succeeded === attempted && errors === 0 && exhausted === 0,
        hotCountersRoseByIntendedIncrements: after - before === intendedCas,
        everyIntendedUnconditionalWritePresent: intendedPuts.every((id) => present.has(id)),
      },
    });
  }
  return { collectionDocs: scale.collectionDocs + hot.length, hotDocs: hot.length, levels };
}

async function sumHot(api, store, hot) {
  let sum = 0;
  for (const id of hot) sum += (await api.store.asVersionedDocumentStore(store).getVersioned(id))?.doc.n ?? 0;
  return sum;
}

// ----------------------------------------------------- 4. projection rebuild

/** The derived read model: per-run summaries from the event logs and the plan's dependency index. */
async function buildProjection(api, stores) {
  const runs = {};
  for (const runId of (await stores.events.listRuns()).sort()) {
    const byType = {};
    let count = 0;
    let after = -1;
    for (;;) {
      const page = await stores.events.readRange(runId, { after, limit: 1_000 });
      if (page.length === 0) break;
      for (const e of page) byType[e.type] = (byType[e.type] ?? 0) + 1;
      count += page.length;
      after = page[page.length - 1].seq;
    }
    runs[runId] = { count, lastSeq: after, byType };
  }
  const { items } = await api.store.queryDocuments(stores.plan.dependencies, { where: { planId: "plan_bench" } });
  const blockedBy = {};
  for (const d of items) (blockedBy[d.from] ??= []).push(d.target.workItemId);
  for (const list of Object.values(blockedBy)) list.sort();
  return { runs, blockedBy };
}

const canonical = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v,
  );

export async function projectionRebuild({ api, handle, root, repeat }) {
  const cacheDir = join(root, "derived-cache");
  const cacheFile = join(cacheDir, "projection.json");
  await mkdir(cacheDir, { recursive: true });
  const build = await timed(() => buildProjection(api, handle.stores()));
  const original = canonical(build.value);
  const write = await timed(() => writeFile(cacheFile, original));
  const load = await timed(async () => JSON.parse(await readFile(cacheFile, "utf8")));
  const rebuilds = [];
  let equal = true;
  for (let i = 0; i < Math.max(1, repeat); i++) {
    await rm(cacheDir, { recursive: true, force: true }); // The cache is lost.
    const rebuilt = await timed(() => buildProjection(api, handle.stores()));
    rebuilds.push(rebuilt.ms);
    equal &&= canonical(rebuilt.value) === original;
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, canonical(rebuilt.value));
  }
  return {
    projectionBytes: Buffer.byteLength(original),
    initialBuildMs: round(build.ms),
    cacheWriteMs: round(write.ms),
    cacheLoadMs: round(load.ms),
    rebuildAfterLoss: summarize(rebuilds),
    checks: { rebuiltEqualsLostProjection: equal, loadedEqualsBuilt: canonical(load.value) === original },
  };
}

// -------------------------------------------------------- 5. checkpoints

/**
 * A sustained burst of appends to one run, as an agent streaming output does, on a backend with a
 * write-ahead log (SQLite, #339): how large the log grows (sampled, a measurement and not a
 * bound SQLite keeps), how append latency is spread, and what the store's own idle checkpoint
 * did once writes stopped, as the store reported it. Backends without a log say they have none.
 *
 * Appends over 5 ms are reported as latency outliers. Many are commits that ran SQLite's
 * automatic checkpoint, but nothing here tells them apart from any other slow commit.
 */
export async function walCheckpoint({ handle, scale }) {
  if (!handle.wal) return { skipped: "no write-ahead log on this backend" };
  const { wal } = handle;
  const events = handle.stores().events;
  const runId = "run_bench_wal";
  const text = "streamed agent output ".repeat(8);
  await events.append({
    type: "run.created",
    runId,
    payload: { workflowId: "bench", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
  });
  const latency = [];
  // The file as earlier work left it: SQLite reuses a log file from the start rather than
  // shrinking it, so this is not growth from this burst.
  const atStart = wal.bytes();
  let maxWal = atStart;
  const started = performance.now();
  for (let i = 1; i < scale.checkpointBurst; i++) {
    const { ms } = await timed(() =>
      events.append({
        type: "agent.update",
        runId,
        payload: { stepRunId: "step_wal", sessionId: "s", update: { kind: "agent_message_chunk", text } },
      }),
    );
    latency.push(ms);
    if (i % 100 === 0) maxWal = Math.max(maxWal, wal.bytes());
  }
  const burstMs = performance.now() - started;
  maxWal = Math.max(maxWal, wal.bytes());
  const endOfBurst = wal.bytes();
  // Quiet for longer than the idle window, then read what the store's own checkpoint did: the
  // benchmark runs no checkpoint before this point, so whatever was copied, the timer copied.
  const seen = wal.checkpoints.length;
  await new Promise((resolve) => setTimeout(resolve, wal.settings.idleMs + 250));
  const idle = wal.checkpoints.slice(seen).map((event) =>
    "error" in event
      ? { ms: round(event.ms), error: String(event.error) }
      : {
          ms: round(event.ms),
          busy: event.busy,
          logPages: event.logPages,
          checkpointedPages: event.checkpointedPages,
        },
  );
  const truncate = await timed(() => wal.connect().checkpoint("truncate"));
  const afterTruncate = wal.bytes();
  const committed = (await events.lastSeq(runId)) === scale.checkpointBurst - 1;
  return {
    settings: { ...wal.settings },
    appends: latency.length,
    appendsPerSecond: round(latency.length / (burstMs / 1000)),
    latency: summarize(latency),
    latencyOutliersOver5ms: latency.filter((ms) => ms > 5).length,
    walBytes: { atStart, sampledMax: maxWal, endOfBurst, afterTruncate },
    idleCheckpoints: idle,
    truncateMs: round(truncate.ms),
    checks: {
      everyAppendCommitted: committed,
      truncateEmptiedLog: !truncate.value.busy && afterTruncate === 0,
    },
  };
}

// ------------------------------------------------- 6. checkpoints under load

/**
 * The phases of `walUnderLoad`, each with the readers it runs on other connections beside the
 * writer. `holdMs` is how long a reader keeps each snapshot open, `gapMs` how long it waits
 * before the next one:
 *
 * - daemon: none, the writer's process alone.
 * - pollingReader: a short read every 100 ms, as something watching a run does.
 * - backToBack: short reads with no pause at all.
 * - slowConsumer: reads that each keep their snapshot 100 ms, 10 ms apart, as a large export does.
 * - pinnedSnapshot: the same reads with no pause, so some snapshot is almost always open.
 */
export const LOAD_PHASES = [
  { name: "daemon", readers: [] },
  { name: "pollingReader", readers: [{ holdMs: 0, gapMs: 100 }] },
  { name: "backToBack", readers: [{ holdMs: 0, gapMs: 0 }] },
  { name: "slowConsumer", readers: [{ holdMs: 100, gapMs: 10 }] },
  { name: "pinnedSnapshot", readers: [{ holdMs: 100, gapMs: 0 }] },
];

/** At most this many WAL size samples are kept per phase (evenly thinned). */
const KEEP_SAMPLES = 40;

const thin = (samples) =>
  samples.length <= KEEP_SAMPLES
    ? samples
    : Array.from(
        { length: KEEP_SAMPLES },
        (_, i) => samples[Math.round((i * (samples.length - 1)) / (KEEP_SAMPLES - 1))],
      );

/**
 * Checkpoints under sustained load (#339): what the write-ahead log and the writer do when
 * appends never stop for `scale.sustainedMs`, so the store's idle checkpoint never gets its quiet
 * second and only SQLite's automatic checkpoint (`autoPages`) runs, while the store is also read.
 * Each phase (LOAD_PHASES) starts from an emptied log and writes streamed agent output
 * round-robin to four runs as fast as one writer can, while the writer's own process pages
 * history every 25 appends, as the daemon serving a timeline does (`node:sqlite` is synchronous,
 * so those reads never overlap a commit). Phases after `daemon` add worker threads reading on
 * their own connections at the same time as the writer, as another process reading the store
 * would. A reader's snapshot is what a checkpoint cannot copy past and what keeps the log from
 * starting over, so that is where the log can grow.
 *
 * Reported per phase: append rate and latency (stalls over 5 and 50 ms), the log's size over
 * time (sampled; the file never shrinks by itself, so a flat size means the log keeps starting
 * over at about `autoPages`, and a rising one means it does not), what the readers did, and what
 * the idle checkpoint did once the load stopped, and the log's size after the next write, which
 * is when SQLite starts it over and cuts the file back to `walLimitBytes`. Backends without a log
 * say they have none.
 */
export async function walUnderLoad({ handle, scale }) {
  if (!handle.wal) return { skipped: "no write-ahead log on this backend" };
  const { wal } = handle;
  const text = "streamed agent output ".repeat(8);
  const out = { settings: { ...wal.settings }, sustainedMs: scale.sustainedMs };
  for (const { name: phase, readers: outside } of LOAD_PHASES) {
    const events = handle.stores().events;
    const runIds = Array.from({ length: 4 }, (_, i) => `run_bench_load_${phase}_${i}`);
    for (const runId of runIds)
      await events.append({
        type: "run.created",
        runId,
        payload: { workflowId: "bench", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
      });
    // Every phase starts from an empty log, so what it shows is this phase's.
    const emptied = wal.connect().checkpoint("truncate");
    const stop = new SharedArrayBuffer(4);
    const workers = outside.map((reader) => {
      const worker = new Worker(new URL("./outside-reader.js", import.meta.url), {
        workerData: {
          file: wal.file,
          runIds,
          pageSize: scale.pageSize,
          holdMs: reader.holdMs,
          gapMs: reader.gapMs,
          stop,
        },
      });
      const done = new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      return { reader, done };
    });
    const reader = handle.stores().events;
    const readLatency = [];
    let readsOrdered = true;
    const latency = [];
    const samples = [{ ms: 0, walBytes: wal.bytes(), appends: 0 }];
    const started = performance.now();
    let lastSample = started;
    let i = 0;
    while (performance.now() - started < scale.sustainedMs) {
      const runId = runIds[i % runIds.length];
      const { ms } = await timed(() =>
        events.append({
          type: "agent.update",
          runId,
          payload: { stepRunId: "step_load", sessionId: "s", update: { kind: "agent_message_chunk", text } },
        }),
      );
      latency.push(ms);
      i++;
      if (i % 25 === 0) {
        const page = await timed(() =>
          reader.readRange(runId, { before: Number.MAX_SAFE_INTEGER, limit: scale.pageSize }),
        );
        readLatency.push(page.ms);
        for (let k = 1; k < page.value.length; k++)
          if (page.value[k].seq !== page.value[k - 1].seq + 1) readsOrdered = false;
      }
      if (i % 50 === 0) {
        const now = performance.now();
        if (now - lastSample >= 250) {
          samples.push({ ms: round(now - started), walBytes: wal.bytes(), appends: i });
          lastSample = now;
        }
        // Let timers and other work in, as a daemon's event loop would.
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const loadMs = performance.now() - started;
    samples.push({ ms: round(loadMs), walBytes: wal.bytes(), appends: i });
    Atomics.store(new Int32Array(stop), 0, 1);
    const readers = [];
    for (const w of workers) readers.push({ ...w.reader, ...(await w.done) });
    // Quiet for longer than the idle window: what the store's own checkpoint did after the load.
    const seen = wal.checkpoints.length;
    await new Promise((resolve) => setTimeout(resolve, wal.settings.idleMs + 250));
    const idle = wal.checkpoints.slice(seen).map((event) =>
      "error" in event
        ? { ms: round(event.ms), error: String(event.error) }
        : {
            ms: round(event.ms),
            busy: event.busy,
            logPages: event.logPages,
            checkpointedPages: event.checkpointedPages,
          },
    );
    const afterIdle = wal.bytes();
    let total = 0;
    for (const runId of runIds) total += await events.lastSeq(runId);
    const committed = total === i; // seq 0 is run.created in every run.
    // The next write starts the log over (everything was copied back) and cuts the file down.
    await events.append({
      type: "agent.update",
      runId: runIds[0],
      payload: { stepRunId: "step_load", sessionId: "s", update: { kind: "agent_message_chunk", text } },
    });
    const afterNextWrite = wal.bytes();
    const half = samples.filter((s) => s.ms <= loadMs / 2);
    const peak = (list) => list.reduce((max, s) => Math.max(max, s.walBytes), 0);
    const windowRate = (from, to) => {
      const a = samples.findLast((s) => s.ms <= from) ?? samples[0];
      const b = samples.findLast((s) => s.ms <= to) ?? samples.at(-1);
      return b.ms > a.ms ? round((b.appends - a.appends) / ((b.ms - a.ms) / 1000)) : null;
    };
    out[phase] = {
      startedFromEmptyLog: !emptied.busy,
      loadMs: round(loadMs),
      appends: i,
      appendsPerSecond: round(i / (loadMs / 1000)),
      appendsPerSecondFirstFifth: windowRate(0, loadMs / 5),
      appendsPerSecondLastFifth: windowRate((loadMs * 4) / 5, loadMs),
      latency: summarize(latency),
      stallsOver5ms: latency.filter((ms) => ms > 5).length,
      stallsOver50ms: latency.filter((ms) => ms > 50).length,
      walBytes: {
        peakFirstHalf: peak(half),
        peak: peak(samples),
        endOfLoad: samples.at(-1).walBytes,
        afterIdle,
        afterNextWrite,
        samples: thin(samples),
      },
      inProcessReads: summarize(readLatency),
      readers,
      idleCheckpoints: idle,
      checks: {
        everyAppendCommitted: committed,
        logCutBackAfterLoad: afterNextWrite <= wal.settings.walLimitBytes,
        readsNeverFailed: readers.every((r) => r.errors === 0 && r.reads > 0),
        readsSawOrderedPages: readsOrdered && readers.every((r) => r.ordered),
      },
    };
    await wal.connect().checkpoint("truncate");
  }
  return out;
}

export const WORKLOADS = {
  dependencyTraversal,
  paginatedHistory,
  concurrentMetadataWrites,
  projectionRebuild,
  walCheckpoint,
  walUnderLoad,
};
