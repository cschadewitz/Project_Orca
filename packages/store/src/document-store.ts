/**
 * Small keyed document collections for Requests and WorkItems. The engine only
 * needs get/put/list/delete; swap in a database-backed implementation by
 * implementing DocumentStore<T>.
 */
import { mkdir, open, readFile, stat, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";
import type { Clock, Logger, Request, WorkItem } from "@orca/core";
import { RequestSchema, WorkItemSchema } from "@orca/core";
import { FileClaimStore, InMemoryClaimStore, type ClaimStore } from "./claim-store.js";
import { withFileLock } from "./file-lock.js";
import { FileLeaseStore, InMemoryLeaseStore, type LeaseStore } from "./lease-store.js";
import { InMemoryEventStore, type EventStore } from "./event-store.js";
import { JsonlEventStore } from "./jsonl-event-store.js";
import { FileArtifactStore, InMemoryArtifactStore, type ArtifactStore } from "./artifact-store.js";
import { filePlanStores, memoryPlanStores, type PlanStores } from "./plan-store.js";

export interface DocumentStore<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(doc: T): Promise<void>;
  /** Write several documents as one unit; cheaper than a put() per doc on file-backed stores. */
  putMany(docs: readonly T[]): Promise<void>;
  delete(id: string): Promise<void>;
  list(predicate?: (doc: T) => boolean): Promise<T[]>;
}

export class InMemoryDocumentStore<T extends { id: string }> implements DocumentStore<T> {
  private readonly docs = new Map<string, T>();
  async get(id: string): Promise<T | undefined> {
    return this.docs.get(id);
  }
  async put(doc: T): Promise<void> {
    this.docs.set(doc.id, doc);
  }
  async putMany(docs: readonly T[]): Promise<void> {
    for (const doc of docs) this.docs.set(doc.id, doc);
  }
  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }
  async list(predicate?: (doc: T) => boolean): Promise<T[]> {
    const all = [...this.docs.values()];
    return predicate ? all.filter(predicate) : all;
  }
}

/** What the cached collection was read from; the cache is trusted only while this still holds. */
interface Fingerprint {
  ino: number;
  size: number;
  mtimeMs: number;
}

/** A mutation waiting to be applied to the file, kept until a locked write has carried it. */
type Mutation<T> = { kind: "put"; doc: T } | { kind: "delete"; id: string };

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
 */
export class JsonFileDocumentStore<T extends { id: string }> implements DocumentStore<T> {
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
    if (this.queue.length === 0) return map;
    const view = new Map(map);
    for (const m of this.queue) apply(view, m);
    return view;
  }

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
      const batch = this.queue.slice();
      if (batch.length === 0) return;
      await mkdir(dirname(this.file), { recursive: true });
      await withFileLock(`${this.file}.lock`, async () => {
        try {
          // Inside the lock, so nothing can write between this read and the rename.
          const map = new Map(await this.load());
          for (const m of batch) apply(map, m);
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
          await rename(tmp, this.file);
          this.cache = map;
          this.fingerprint = await this.fingerprintOf();
        } finally {
          // The batch is the head of the queue: it was snapshotted from the
          // front and only appends have happened since.
          this.queue.splice(0, batch.length);
        }
      });
    });
    this.pending = p;
    // Keep the chain alive (and unrejected) so one failed write does not poison later ones.
    this.writing = p.then(
      () => {},
      () => {},
    );
    return p;
  }
  async get(id: string): Promise<T | undefined> {
    return (await this.view()).get(id);
  }
  async put(doc: T): Promise<void> {
    await this.enqueue({ kind: "put", doc });
  }
  async putMany(docs: readonly T[]): Promise<void> {
    if (docs.length === 0) return;
    await this.enqueue(...docs.map((doc) => ({ kind: "put", doc }) as const));
  }
  async delete(id: string): Promise<void> {
    await this.enqueue({ kind: "delete", id });
  }
  async list(predicate?: (doc: T) => boolean): Promise<T[]> {
    const all = [...(await this.view()).values()];
    return predicate ? all.filter(predicate) : all;
  }
}

function same(a: Fingerprint | undefined, b: Fingerprint | undefined): boolean {
  if (!a || !b) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function apply<T extends { id: string }>(map: Map<string, T>, m: Mutation<T>): void {
  if (m.kind === "put") map.set(m.doc.id, m.doc);
  else map.delete(m.id);
}

export interface Stores {
  events: EventStore;
  artifacts: ArtifactStore;
  requests: DocumentStore<Request>;
  workItems: DocumentStore<WorkItem>;
  /** Who owns which work item; see claim-store.ts for why this is not part of the event log. */
  claims: ClaimStore;
  /** Who may drive a run right now; see lease-store.ts. Claims cover items, leases cover runs. */
  leases: LeaseStore;
  /** Long-term planning: plans, dependencies, risks, decisions and their journal. */
  plan: PlanStores;
}

/** `logger` receives what the file-backed stores notice and survive: torn log lines, stale locks. */
export function fileStores(dir: string, clock?: Clock, logger?: Logger): Stores {
  return {
    events: new JsonlEventStore(dir, clock, logger),
    artifacts: new FileArtifactStore(dir, logger),
    requests: new JsonFileDocumentStore<Request>(join(dir, "requests.json"), RequestSchema),
    workItems: new JsonFileDocumentStore<WorkItem>(join(dir, "work-items.json"), WorkItemSchema),
    claims: new FileClaimStore(dir),
    leases: new FileLeaseStore(dir, clock),
    plan: filePlanStores(dir, clock, logger),
  };
}

export function memoryStores(clock?: Clock): Stores {
  return {
    events: new InMemoryEventStore(clock),
    artifacts: new InMemoryArtifactStore(),
    requests: new InMemoryDocumentStore<Request>(),
    workItems: new InMemoryDocumentStore<WorkItem>(),
    claims: new InMemoryClaimStore(),
    leases: new InMemoryLeaseStore(clock),
    plan: memoryPlanStores(clock),
  };
}
