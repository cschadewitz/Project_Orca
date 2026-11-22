/**
 * What the store conformance suite (#338) needs from a backend. A new backend (SQLite, #339)
 * implements `ConformanceBackend` and calls `runStoreConformance` with it; nothing in the suite
 * knows which backend it is testing beyond the capability matrix it declares.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod";
import { FakeClock } from "@orca/core";
import {
  fileStores,
  FILE_STORE_CAPABILITIES,
  InMemoryDocumentStore,
  JsonFileDocumentStore,
  memoryStores,
  MEMORY_STORE_CAPABILITIES,
  type DocumentStore,
  type StoreCapabilityMatrix,
  type Stores,
} from "@orca/store";

/** One empty store root, opened as often as a test needs. */
export interface BackendInstance {
  clock: FakeClock;
  /**
   * A handle on this root. A backend that is `crossProcess` returns a *new* handle each call,
   * with no state shared in memory, so two handles stand in for two processes; an in-process
   * backend returns the same one.
   */
  stores(): Stores;
  /** A document collection called `name` on this root; a new handle per call, as `stores()`. */
  collection<T extends { id: string }>(name: string, schema: ZodType<T>): DocumentStore<T>;
  /** The root on disk, for a backend that has one; fault injection tests use it. */
  dir?: string;
  dispose(): Promise<void>;
}

export interface ConformanceBackend {
  name: string;
  capabilities: StoreCapabilityMatrix;
  create(): Promise<BackendInstance>;
}

export const memoryBackend: ConformanceBackend = {
  name: "memory",
  capabilities: MEMORY_STORE_CAPABILITIES,
  async create() {
    const clock = new FakeClock();
    const stores = memoryStores(clock);
    const collections = new Map<string, DocumentStore<never>>();
    return {
      clock,
      stores: () => stores,
      collection<T extends { id: string }>(name: string) {
        if (!collections.has(name)) collections.set(name, new InMemoryDocumentStore<never>());
        return collections.get(name) as unknown as DocumentStore<T>;
      },
      dispose: async () => {},
    };
  },
};

export const fileBackend: ConformanceBackend = {
  name: "file",
  capabilities: FILE_STORE_CAPABILITIES,
  async create() {
    const clock = new FakeClock();
    const dir = await mkdtemp(join(tmpdir(), "orca-conformance-"));
    return {
      clock,
      dir,
      stores: () => fileStores(dir, clock),
      collection: <T extends { id: string }>(name: string, schema: ZodType<T>) =>
        new JsonFileDocumentStore<T>(join(dir, `${name}.json`), schema),
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  },
};
