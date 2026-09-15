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

export interface DocumentStore<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(doc: T): Promise<void>;
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
  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }
  async list(predicate?: (doc: T) => boolean): Promise<T[]> {
    const all = [...this.docs.values()];
    return predicate ? all.filter(predicate) : all;
  }
}

/** Whole-collection JSON file, written atomically (tmp + rename). */
export class JsonFileDocumentStore<T extends { id: string }> implements DocumentStore<T> {
  private cache: Map<string, T> | undefined;
  private writing: Promise<void> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly schema: ZodType<T>,
  ) {}

  private async load(): Promise<Map<string, T>> {
    if (this.cache) return this.cache;
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
    return map;
  }
  private flush(map: Map<string, T>): Promise<void> {
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify([...map.values()], null, 2), "utf8");
      await rename(tmp, this.file);
    });
    return this.writing;
  }
  async get(id: string): Promise<T | undefined> {
    return (await this.load()).get(id);
  }
  async put(doc: T): Promise<void> {
    const map = await this.load();
    map.set(doc.id, doc);
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
}

export function fileStores(dir: string, clock?: Clock): Stores {
  return {
    events: new JsonlEventStore(dir, clock),
    artifacts: new FileArtifactStore(dir),
    requests: new JsonFileDocumentStore<Request>(join(dir, "requests.json"), RequestSchema as unknown as ZodType<Request>),
    workItems: new JsonFileDocumentStore<WorkItem>(join(dir, "work-items.json"), WorkItemSchema as unknown as ZodType<WorkItem>),
  };
}

export function memoryStores(clock?: Clock): Stores {
  return {
    events: new InMemoryEventStore(clock),
    artifacts: new InMemoryArtifactStore(),
    requests: new InMemoryDocumentStore<Request>(),
    workItems: new InMemoryDocumentStore<WorkItem>(),
  };
}
