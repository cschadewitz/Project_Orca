/**
 * Small keyed document collections for Requests and WorkItems. The engine only
 * needs get/put/list/delete; swap in a database-backed implementation by
 * implementing DocumentStore<T>.
 */
import { mkdir, open, readFile, stat, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";
import type { Clock, Logger, Request, WorkItem } from "@orca/core";
import { OrcaError, RequestSchema, WorkItemSchema } from "@orca/core";
import { FileClaimStore, InMemoryClaimStore, type ClaimStore } from "./claim-store.js";
import { withFileLock } from "./file-lock.js";
import { FileLeaseStore, InMemoryLeaseStore, type LeaseStore } from "./lease-store.js";
import { InMemoryEventStore, type EventStore } from "./event-store.js";
import { JsonlEventStore } from "./jsonl-event-store.js";
import { FileArtifactStore, InMemoryArtifactStore, type ArtifactStore } from "./artifact-store.js";
import { FileWorkflowVersionStore, InMemoryWorkflowVersionStore, type WorkflowVersionStore } from "./workflow-store.js";
import { FileExecutionStore, InMemoryExecutionStore, type ExecutionStore } from "./execution-store.js";
import { ProtectedEventStore } from "./protected-event-store.js";
import { filePlanStores, memoryPlanStores, type PlanStores } from "./plan-store.js";
import {
  documentVersion,
  FILE_STORE_CAPABILITIES,
  MEMORY_STORE_CAPABILITIES,
  pageDocuments,
  type ConditionalWriteResult,
  type DocumentPage,
  type DocumentQuery,
  type DocumentVersion,
  type StoreCapabilityMatrix,
  type UnitOfWork,
  type VersionedDocument,
  type VersionedDocumentStore,
} from "./store-contracts.js";

export interface DocumentStore<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(doc: T): Promise<void>;
  /** Write several documents as one unit; cheaper than a put() per doc on file-backed stores. */
  putMany(docs: readonly T[]): Promise<void>;
  delete(id: string): Promise<void>;
  list(predicate?: (doc: T) => boolean): Promise<T[]>;
}

/**
 * The in-process reference collection. Every method is synchronous between its read and its
 * write, so a conditional write cannot interleave with another one. It owns its documents:
 * what goes in and what comes out are copies (#338), so a caller mutating either can never
 * change the stored document, or its version, without a write.
 */
export class InMemoryDocumentStore<T extends { id: string }> implements VersionedDocumentStore<T> {
  private readonly docs = new Map<string, T>();
  async get(id: string): Promise<T | undefined> {
    return copy(this.docs.get(id));
  }
  async put(doc: T): Promise<void> {
    this.docs.set(doc.id, structuredClone(doc));
  }
  async putMany(docs: readonly T[]): Promise<void> {
    const copies = docs.map((doc) => structuredClone(doc));
    for (const doc of copies) this.docs.set(doc.id, doc);
  }
  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }
  async list(predicate?: (doc: T) => boolean): Promise<T[]> {
    const all = [...this.docs.values()].map((doc) => structuredClone(doc));
    return predicate ? all.filter(predicate) : all;
  }
  async getVersioned(id: string): Promise<VersionedDocument<T> | undefined> {
    return this.versioned(id);
  }
  async putIfVersion(doc: T, expected: DocumentVersion | null): Promise<ConditionalWriteResult<T>> {
    const conflict = this.conflict(doc.id, expected);
    if (conflict) return conflict;
    const stored = structuredClone(doc);
    this.docs.set(stored.id, stored);
    return { ok: true, version: documentVersion(stored) };
  }
  async deleteIfVersion(id: string, expected: DocumentVersion): Promise<ConditionalWriteResult<T>> {
    const conflict = this.conflict(id, expected);
    if (conflict) return conflict;
    this.docs.delete(id);
    return { ok: true, version: undefined };
  }
  async query(query?: DocumentQuery<T>): Promise<DocumentPage<T>> {
    return copyPage(pageDocuments(this.docs.values(), query));
  }
  private versioned(id: string): VersionedDocument<T> | undefined {
    const doc = this.docs.get(id);
    return doc && { doc: structuredClone(doc), version: documentVersion(doc) };
  }
  private conflict(id: string, expected: DocumentVersion | null): ConditionalWriteResult<T> | undefined {
    const current = this.versioned(id);
    return (current?.version ?? null) === expected ? undefined : { ok: false, current };
  }
}

/** A caller's own copy of a stored document. */
function copy<T>(doc: T | undefined): T | undefined {
  return doc === undefined ? undefined : structuredClone(doc);
}

function copyPage<T>(page: DocumentPage<T>): DocumentPage<T> {
  return { ...page, items: page.items.map((doc) => structuredClone(doc)) };
}

/** What the cached collection was read from; the cache is trusted only while this still holds. */
interface Fingerprint {
  ino: number;
  size: number;
  mtimeMs: number;
}

/**
 * A mutation waiting to be applied to the file, kept until a locked write has carried it. A
 * conditional one (`expect` present) is decided inside the lock against the file as it is
 * then, and leaves its outcome in `result` for the caller that queued it.
 */
type Mutation<T> = ({ kind: "put"; doc: T } | { kind: "delete"; id: string }) & {
  expect?: DocumentVersion | null;
  result?: ConditionalWriteResult<T>;
  /** Set when the write that carried it did not commit; the caller rethrows it. */
  failed?: { error: unknown };
  /** Wakes the caller once the write carrying this mutation has committed or failed. */
  settle?: () => void;
};

/**
 * Whole-collection JSON file, written atomically (tmp + rename), safe for two
 * processes over one file (#196).
 *
 * The collection is cached, but the cache is trusted only while `stat` reports
 * the same `{ino, size, mtimeMs}` as it was read from - the idiom `JsonlLogDir`
 * uses for a log tail. Every read re-validates, so another process's write is
 * picked up rather than papered over, and a missing file is an empty collection.
 *
 * A whole-file rewrite is a read-modify-write, so it is only correct under a
 * lock: every mutation runs inside `withFileLock` on `<file>.lock`, re-reads the
 * file when it changed underneath, applies itself to that fresh map and renames
 * the result into place. What is cached between locks is therefore never the
 * basis of a write.
 *
 * Mutations are queued rather than applied to the cache, and everything queued
 * while a locked write is in flight is coalesced into the next one, so N
 * concurrent puts cost at most two writes rather than N. Reads see the cache
 * with the queue applied on top, and each call still resolves only once its own
 * change has hit disk.
 *
 * Compare-and-swap (#338) rides the same queue: a conditional mutation is checked
 * inside the lock, against the freshly re-read file and the batch's earlier
 * mutations, so of two state-changing writers holding one version only the first can win - in
 * this process or another. A conditional mutation always *ends* its batch: what
 * it was decided against is exactly what that write commits, so a success's
 * version and a conflict's `current` both describe committed state, never an
 * intermediate one a later mutation in the same write overwrote. Mutations after
 * it go into the next write. A document's version is the hash of its parsed
 * content, computed on read, so nothing new is written to the file.
 *
 * The store owns its documents (#338): a put stores a copy of the caller's
 * object and every read, including a conflict's `current`, hands back a copy,
 * so the cache and queue can never be changed - nor a version moved - by a
 * caller mutating an object it passed in or got back.
 *
 * `get`, `list` and `query` keep their read-your-writes view (the file plus this
 * process's queued unconditional mutations); `getVersioned` reads only the
 * committed file, because a version is what a caller will compare against on
 * disk. A conditional mutation is never shown before it has been decided and written.
 */
export class JsonFileDocumentStore<T extends { id: string }> implements VersionedDocumentStore<T> {
  private cache: Map<string, T> | undefined;
  private fingerprint: Fingerprint | undefined;
  /** Mutations not yet carried by a completed write, in the order they were made. */
  private readonly queue: Mutation<T>[] = [];
  /** Resolves when the currently running write finishes; the tail of the write chain. */
  private writing: Promise<void> = Promise.resolve();
  /** A write that has not started yet, and so will still pick up further mutations. */
  private pending: Promise<void> | undefined;
  constructor(
    private readonly file: string,
    private readonly schema: ZodType<T>,
  ) {}

  /** The file's identity right now, or undefined when it does not exist. */
  private async fingerprintOf(): Promise<Fingerprint | undefined> {
    try {
      const s = await stat(this.file);
      return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return undefined;
    }
  }

  /**
   * The collection as it is on disk: from the cache while the file is unchanged,
   * otherwise re-read. The fingerprint is taken *before* the read, so a write
   * that lands in between only costs a later re-read and never caches stale
   * contents under a current identity.
   */
  private async load(): Promise<Map<string, T>> {
    const fp = await this.fingerprintOf();
    if (this.cache && same(this.fingerprint, fp)) return this.cache;
    const map = new Map<string, T>();
    if (fp) {
      try {
        const raw = JSON.parse(await readFile(this.file, "utf8")) as unknown[];
        for (const r of raw) {
          const d = this.schema.parse(r);
          map.set(d.id, d);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    this.cache = map;
    this.fingerprint = fp;
    return map;
  }

  /** What a reader should see: the file plus this process's not-yet-written mutations. */
  private async view(): Promise<Map<string, T>> {
    const map = await this.load();
    const unconditional = this.queue.filter((m) => !("expect" in m));
    if (unconditional.length === 0) return map;
    const view = new Map(map);
    for (const m of unconditional) apply(view, m, this.versionOf);
    return view;
  }

  /**
   * The version a reader of the file would compute: the document as it parses back from JSON,
   * so a write and the read after it agree even when the schema fills defaults or drops
   * `undefined` fields.
   */
  private readonly versionOf = (doc: T): DocumentVersion =>
    documentVersion(this.schema.parse(JSON.parse(JSON.stringify(doc))));

  /**
   * Schedule a locked rewrite of the whole collection. Callers that mutate
   * before the write body starts join the same write; later ones get the next
   * one, which re-reads the file again before it applies them.
   */
  private enqueue(...mutations: Mutation<T>[]): Promise<void> {
    this.queue.push(...mutations);
    if (this.pending) return this.pending;
    const p = this.writing.then(async () => {
      // Cleared before snapshotting the queue, so mutations made from here on
      // schedule a fresh write rather than silently missing this one.
      this.pending = undefined;
      // Everything queued so far belongs to this call. It is written in as few
      // batches as conditional boundaries allow: each batch ends at the first
      // conditional mutation (inclusive), so a conditional's outcome is the
      // state its own write commits.
      let remaining = this.queue.length;
      while (remaining > 0) {
        const conditional = this.queue.findIndex((m, i) => i < remaining && "expect" in m);
        const size = conditional === -1 ? remaining : conditional + 1;
        const batch = this.queue.slice(0, size);
        try {
          await this.write(batch);
        } catch (error) {
          // Only this batch failed; later batches are still attempted, and each
          // caller learns its own mutation's fate from `failed`.
          for (const m of batch) m.failed = { error };
        } finally {
          // Retire this batch even when setup or lock acquisition fails before
          // callback entry, so a rejected mutation never reappears in a later
          // write. Only appends happen meanwhile, so the head is still this batch.
          this.queue.splice(0, size);
          remaining -= size;
          // Each caller resumes as soon as its own batch is decided, before any
          // later batch can commit over it.
          for (const m of batch) m.settle?.();
        }
      }
    });
    this.pending = p;
    // Keep the chain alive (and unrejected) so one failed write does not poison later ones.
    this.writing = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  /**
   * Queue `mutations`, wait for the write that carries them, and rethrow if it failed. One
   * call's mutations are queued together and contain at most one conditional (last), so they
   * always share one batch.
   */
  private async commit(...mutations: Mutation<T>[]): Promise<void> {
    const settled = new Promise<void>((resolve) => {
      mutations[mutations.length - 1]!.settle = resolve;
    });
    void this.enqueue(...mutations);
    await settled;
    const failed = mutations.find((m) => m.failed)?.failed;
    if (failed) throw failed.error;
  }

  /**
   * One locked read-modify-write of the whole collection carrying `batch`. The rename is the
   * commit point, and the outcome a caller sees follows it (#338):
   *
   * - a failure *before* the rename rejects with the underlying error: nothing was
   *   committed, so retrying is safe;
   * - a failure *of* the rename rejects with `STORE_WRITE` and `details.outcome: "uncertain"`:
   *   the new file may or may not be in place, so the caller must re-read before retrying;
   * - a failure *after* the rename (refreshing the cache fingerprint, releasing the lock) does
   *   not reject: the batch is committed and its results stand. The cache is dropped so the
   *   next read goes to disk; a lock that could not be released surfaces on the next write.
   */
  private async write(batch: readonly Mutation<T>[]): Promise<void> {
    let stage: "prepare" | "rename" | "committed" = "prepare";
    try {
      await this.writeLocked(batch, (next) => {
        stage = next;
      });
    } catch (error) {
      if (stage === "prepare") throw error;
      this.cache = undefined;
      this.fingerprint = undefined;
      if (stage === "committed") return;
      throw new OrcaError(
        "STORE_WRITE",
        `the outcome of a write to ${this.file} is unknown: re-read before retrying`,
        { file: this.file, outcome: "uncertain" },
        { cause: error },
      );
    }
  }

  private async writeLocked(
    batch: readonly Mutation<T>[],
    reached: (stage: "rename" | "committed") => void,
  ): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await withFileLock(`${this.file}.lock`, async () => {
      // Inside the lock, so nothing can write between this read and the rename.
      const map = new Map(await this.load());
      let changed = false;
      for (const m of batch) changed = apply(map, m, this.versionOf) || changed;
      // Every mutation was a conditional write that lost: the file is already right.
      if (!changed) return;
      const body = JSON.stringify([...map.values()], null, 2);
      // A random tag, not the pid alone (file-lock.ts uses the same idiom): two writers
      // in one process - two collections is the ordinary case, and a pid is reused after
      // a crash - would otherwise share one tmp path and rename each other's bytes into
      // place. The lock makes that unlikely rather than impossible; the name makes it so.
      const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      // Flushed before the rename: the rename is what makes the new file visible, and a
      // machine that loses power between the two would otherwise publish a name pointing
      // at bytes that never reached the disk. `writeFile` alone does not promise that.
      const handle = await open(tmp, "w");
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      reached("rename");
      await rename(tmp, this.file);
      reached("committed");
      this.cache = map;
      this.fingerprint = await this.fingerprintOf();
    });
  }
  async get(id: string): Promise<T | undefined> {
    return copy((await this.view()).get(id));
  }
  async put(doc: T): Promise<void> {
    await this.commit({ kind: "put", doc: structuredClone(doc) });
  }
  async putMany(docs: readonly T[]): Promise<void> {
    if (docs.length === 0) return;
    await this.commit(...docs.map((doc) => ({ kind: "put", doc: structuredClone(doc) }) as const));
  }
  async delete(id: string): Promise<void> {
    await this.commit({ kind: "delete", id });
  }
  async list(predicate?: (doc: T) => boolean): Promise<T[]> {
    const all = [...(await this.view()).values()].map((doc) => structuredClone(doc));
    return predicate ? all.filter(predicate) : all;
  }
  async getVersioned(id: string): Promise<VersionedDocument<T> | undefined> {
    const doc = (await this.load()).get(id);
    return doc && { doc: structuredClone(doc), version: this.versionOf(doc) };
  }
  async putIfVersion(doc: T, expected: DocumentVersion | null): Promise<ConditionalWriteResult<T>> {
    const m: Mutation<T> = { kind: "put", doc: structuredClone(doc), expect: expected };
    await this.commit(m);
    return m.result!;
  }
  async deleteIfVersion(id: string, expected: DocumentVersion): Promise<ConditionalWriteResult<T>> {
    const m: Mutation<T> = { kind: "delete", id, expect: expected };
    await this.commit(m);
    return m.result!;
  }
  async query(query?: DocumentQuery<T>): Promise<DocumentPage<T>> {
    return copyPage(pageDocuments((await this.view()).values(), query));
  }
}

function same(a: Fingerprint | undefined, b: Fingerprint | undefined): boolean {
  if (!a || !b) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Apply one mutation; false when it was a conditional write whose expectation did not hold. */
function apply<T extends { id: string }>(
  map: Map<string, T>,
  m: Mutation<T>,
  versionOf: (doc: T) => DocumentVersion,
): boolean {
  const id = m.kind === "put" ? m.doc.id : m.id;
  if ("expect" in m) {
    const doc = map.get(id);
    const current = doc && { doc: structuredClone(doc), version: versionOf(doc) };
    if ((current?.version ?? null) !== m.expect) {
      m.result = { ok: false, current };
      return false;
    }
    m.result = { ok: true, version: m.kind === "put" ? versionOf(m.doc) : undefined };
  }
  if (m.kind === "put") map.set(m.doc.id, m.doc);
  else map.delete(m.id);
  return true;
}

export interface Stores {
  events: EventStore;
  /** Private execution inputs and original event payloads; never expose through read APIs. */
  execution: ExecutionStore;
  artifacts: ArtifactStore;
  requests: DocumentStore<Request>;
  workItems: DocumentStore<WorkItem>;
  /** Who owns which work item; see claim-store.ts for why this is not part of the event log. */
  claims: ClaimStore;
  /** Who may drive a run right now; see lease-store.ts. Claims cover items, leases cover runs. */
  leases: LeaseStore;
  /** Long-term planning: plans, dependencies, risks, decisions and their journal. */
  plan: PlanStores;
  /** The workflow definitions runs were started on, by `(id, version)`; see workflow-store.ts. */
  workflows: WorkflowVersionStore;
  /** What this backend guarantees beyond the baseline contracts (#338); see store-contracts.ts. */
  capabilities?: StoreCapabilityMatrix;
  /** Present only on a backend that can commit several metadata collections together. */
  unitOfWork?: UnitOfWork;
  /** Release what the backend holds open (a database connection). Absent when there is nothing to release. */
  close?(): void;
}

/** `logger` receives what the file-backed stores notice and survive: torn log lines, stale locks. */
export function fileStores(dir: string, clock?: Clock, logger?: Logger): Stores {
  const execution = new FileExecutionStore(dir);
  const workflows = new FileWorkflowVersionStore(dir);
  return {
    execution,
    events: new ProtectedEventStore(new JsonlEventStore(dir, clock, logger), execution, workflows),
    artifacts: new FileArtifactStore(dir, logger),
    requests: new JsonFileDocumentStore<Request>(join(dir, "requests.json"), RequestSchema),
    workItems: new JsonFileDocumentStore<WorkItem>(join(dir, "work-items.json"), WorkItemSchema),
    claims: new FileClaimStore(dir),
    leases: new FileLeaseStore(dir, clock),
    plan: filePlanStores(dir, clock, logger),
    workflows,
    capabilities: FILE_STORE_CAPABILITIES,
  };
}

export function memoryStores(clock?: Clock): Stores {
  const execution = new InMemoryExecutionStore();
  const workflows = new InMemoryWorkflowVersionStore();
  return {
    execution,
    events: new ProtectedEventStore(new InMemoryEventStore(clock), execution, workflows),
    artifacts: new InMemoryArtifactStore(),
    requests: new InMemoryDocumentStore<Request>(),
    workItems: new InMemoryDocumentStore<WorkItem>(),
    claims: new InMemoryClaimStore(),
    leases: new InMemoryLeaseStore(clock),
    plan: memoryPlanStores(clock),
    workflows,
    capabilities: MEMORY_STORE_CAPABILITIES,
  };
}
