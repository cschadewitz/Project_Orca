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
import { existsSync, statSync } from "node:fs";
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
      async create(dir) {
        // Every handle is its own connection, closed when the backend is disposed.
        const open = [];
        // Every checkpoint a connection runs by itself, as the store reports it.
        const checkpoints = [];
        const options = { checkpoint: { observe: (event) => checkpoints.push(event) } };
        const track = (handle, close) => {
          open.push(close);
          return handle;
        };
        return {
          stores: () => {
            const stores = store.sqliteStores(dir, options);
            return track(stores, () => stores.close());
          },
          collection: (name) => {
            const collection = store.sqliteCollection(dir, name, passthrough, options);
            return track(collection, () => collection.collection.db.close());
          },
          // The write-ahead log, for the checkpoint workload: its settings, its size on disk, the
          // checkpoints the store's connections ran by themselves, and a connection of the
          // benchmark's own to checkpoint it with.
          wal: {
            settings: store.SQLITE_CHECKPOINT,
            checkpoints,
            bytes: () => {
              const file = join(dir, `${store.SQLITE_METADATA_FILE}-wal`);
              return existsSync(file) ? statSync(file).size : 0;
            },
            connect: () => {
              const db = new store.SqliteDatabase(join(dir, store.SQLITE_METADATA_FILE));
              return track(db, () => db.close());
            },
          },
          dispose: async () => {
            for (const close of open.splice(0)) close();
          },
        };
      },
    },
  };
}
