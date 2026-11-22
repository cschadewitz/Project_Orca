/**
 * The backends the store workload benchmark can run against (#341). Each one opens a store root
 * through the #338 contracts only (`Stores`, `DocumentStore`, `queryDocuments`), so a new backend
 * is added here by giving its `create`, the same shape as the conformance suite's
 * `ConformanceBackend` (packages/store/test/conformance/backend.ts).
 *
 * `stores()` and `collection()` return a *new* handle per call on a durable backend: a fresh handle
 * has empty in-process caches, which is what the benchmark calls a process-cold read. An in-process
 * backend shares everything, so its cold and warm reads are the same thing and are reported so.
 *
 * `api` is `{ store, core }`: the @orca/store and @orca/core modules. run.js passes the compiled
 * `dist` builds; the self-test passes the sources.
 */
import { join } from "node:path";

/** Collection documents are this benchmark's own shape; nothing to validate beyond JSON. */
const passthrough = { parse: (value) => value };

export function backends(api) {
  const { store } = api;
  return {
    memory: {
      name: "memory",
      durable: false,
      async create() {
        const stores = store.memoryStores();
        const collections = new Map();
        return {
          stores: () => stores,
          collection(name) {
            if (!collections.has(name)) collections.set(name, new store.InMemoryDocumentStore());
            return collections.get(name);
          },
          dispose: async () => {},
        };
      },
    },
    file: {
      name: "file",
      durable: true,
      async create(dir) {
        return {
          stores: () => store.fileStores(dir),
          collection: (name) => new store.JsonFileDocumentStore(join(dir, `${name}.json`), passthrough),
          dispose: async () => {},
        };
      },
    },
    sqlite: {
      name: "sqlite",
      durable: true,
      unavailable: "No SQLite backend yet: #339 adds it, then registers it here.",
    },
  };
}
