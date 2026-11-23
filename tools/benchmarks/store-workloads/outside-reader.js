/**
 * A reader of a SQLite store from outside the writing process (#339 checkpoint-under-load), run
 * as a worker thread so it really runs alongside the writer: its own connection to the same
 * `metadata.sqlite`, as another ORCA process reading the store would have (a CLI command, a
 * backup). Plain `node:sqlite`, no store package: it only reads, a tail page and the page
 * before it in one snapshot, over and over, until told to stop.
 *
 * workerData: { file, runIds, pageSize, holdMs, gapMs, stop (SharedArrayBuffer, Int32Array[0] = 1
 * stops) }. `holdMs` keeps each snapshot open that long before ending it, as a slow consumer of a
 * large read does; `gapMs` waits that long between reads, as something polling does; 0 and 0
 * read back to back. Posts { ready: true } once its connection is open, then, when stopped,
 * { reads, rows, errors, ordered, snapshotShare, firstError? }: `snapshotShare` is the part of
 * its time it had a snapshot open.
 */
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const { file, runIds, pageSize, holdMs, gapMs, stop } = workerData;
const flag = new Int32Array(stop);
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout = 5000");
const tail = db.prepare("SELECT seq FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?");
const before = db.prepare("SELECT seq FROM events WHERE run_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?");
const pause = new Int32Array(new SharedArrayBuffer(4));
// Ready: the connection is open; the writer starts its load once every reader says so.
parentPort.postMessage({ ready: true });
const started = performance.now();
let inSnapshotMs = 0;
let reads = 0;
let rows = 0;
let errors = 0;
let firstError;
let ordered = true;
let i = 0;
while (Atomics.load(flag, 0) === 0) {
  const runId = runIds[i++ % runIds.length];
  try {
    const opened = performance.now();
    db.exec("BEGIN DEFERRED");
    try {
      const page = tail.all(runId, pageSize);
      const older = page.length ? before.all(runId, page[page.length - 1].seq, pageSize) : [];
      const seqs = [...page, ...older].map((r) => Number(r.seq));
      for (let k = 1; k < seqs.length; k++) if (seqs[k] !== seqs[k - 1] - 1) ordered = false;
      rows += seqs.length;
      // A slow consumer: the snapshot stays open while it "sends" the page.
      if (holdMs > 0) Atomics.wait(pause, 0, 0, holdMs);
    } finally {
      db.exec("COMMIT");
      inSnapshotMs += performance.now() - opened;
    }
    reads++;
    if (gapMs > 0) Atomics.wait(pause, 0, 0, gapMs);
  } catch (error) {
    errors++;
    firstError ??= String(error);
  }
}
const wallMs = performance.now() - started;
db.close();
parentPort.postMessage({
  reads,
  rows,
  errors,
  ordered,
  // How much of its time this reader had a snapshot open: the overlap the writer saw.
  snapshotShare: Math.round((inSnapshotMs / wallMs) * 1000) / 1000,
  ...(firstError ? { firstError } : {}),
});
