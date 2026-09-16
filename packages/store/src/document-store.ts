/**
 * Small keyed document collections for Requests and WorkItems. The engine only
 * needs get/put/list/delete; swap in a database-backed implementation by
 * implementing DocumentStore<T>.
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";
import type { Clock, Request, WorkItem } from "@orca/core";
import { RequestSchema, WorkItemSchema } from "@orca/core";
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

/**
 * Whole-collection JSON file, written atomically (tmp + rename).
 *
 * Mutations are applied to the in-memory map immediately and share a single
 * pending write: everything that changes while a write is in flight is
 * coalesced into one follow-up rewrite, so N concurrent puts cost at most two
 * file writes rather than N. Each call still resolves only once its own change
 * has hit disk.
 */
export class JsonFileDocumentStore<T extends { id: string }> implements DocumentStore<T> {
  private cache: Map<string, T> | undefined;
  private loading: Promise<Map<string, T>> | undefined;
  /** Resolves when the currently running write finishes; the tail of the write chain. */
  private writing: Promise<void> = Promise.resolve();
  /** A write that has not started yet, and so will still pick up further mutations. */
  private pending: Promise<void> | undefined;
  constructor(
    private readonly file: string,
    private readonly schema: ZodType<T>,
  ) {}

  private load(): Promise<Map<string, T>> {
    if (this.cache) return Promise.resolve(this.cache);
    this.loading ??= (async () => {
      const map = new Map<string, T>();
      try {
        const raw = JSON.parse(await readFile(this.file, "utf8")) as unknown[];
        for (const r of raw) {
          const d = this.schema.parse(r);
          map.set(d.id, d);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      this.cache = map;
      this.loading = undefined;
      return map;
    })();
    return this.loading;
  }

  /**
   * Schedule a rewrite of the whole collection. Callers that mutate before the
   * write body starts join the same write; later ones get the next one.
   */
  private flush(map: Map<string, T>): Promise<void> {
    if (this.pending) return this.pending;
    const p = this.writing.then(async () => {
      // Cleared before snapshotting the map, so mutations made from here on
      // schedule a fresh write rather than silently missing this one.
      this.pending = undefined;
      const body = JSON.stringify([...map.values()], null, 2);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.file);
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
    return (await this.load()).get(id);
  }
  async put(doc: T): Promise<void> {
    const map = await this.load();
    map.set(doc.id, doc);
    await this.flush(map);
  }
  async putMany(docs: readonly T[]): Promise<void> {
    if (docs.length === 0) return;
    const map = await this.load();
    for (const doc of docs) map.set(doc.id, doc);
    await this.flush(map);
  }
  async delete(id: string): Promise<void> {
    const map = await this.load();
    map.delete(id);
    await this.flush(map);
  }
  async list(predicate?: (doc: T) => boolean): Promise<T[]> {
    const all = [...(await this.load()).values()];
    return predicate ? all.filter(predicate) : all;
  }
}

export interface Stores {
  events: EventStore;
  artifacts: ArtifactStore;
  requests: DocumentStore<Request>;
  workItems: DocumentStore<WorkItem>;
  /** Long-term planning: plans, dependencies, risks, decisions and their journal. */
  plan: PlanStores;
}

export function fileStores(dir: string, clock?: Clock): Stores {
  return {
    events: new JsonlEventStore(dir, clock),
    artifacts: new FileArtifactStore(dir),
    requests: new JsonFileDocumentStore<Request>(join(dir, "requests.json"), RequestSchema as unknown as ZodType<Request>),
    workItems: new JsonFileDocumentStore<WorkItem>(join(dir, "work-items.json"), WorkItemSchema as unknown as ZodType<WorkItem>),
    plan: filePlanStores(dir, clock),
  };
}

export function memoryStores(clock?: Clock): Stores {
  return {
    events: new InMemoryEventStore(clock),
    artifacts: new InMemoryArtifactStore(),
    requests: new InMemoryDocumentStore<Request>(),
    workItems: new InMemoryDocumentStore<WorkItem>(),
    plan: memoryPlanStores(clock),
  };
}
