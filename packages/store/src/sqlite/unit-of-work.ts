/**
 * A metadata unit of work on SQLite (#339): several collections commit together or not at all.
 *
 * `node:sqlite` is synchronous and the work is not, so the transaction cannot stay open while
 * the work awaits: every other operation on the connection would run inside it, and work that
 * awaited anything slow would hold the database's single write lock for that long. The unit of
 * work is optimistic instead:
 *
 * - the work's writes are staged in memory and its reads see them on top of committed state;
 * - every committed version it read is recorded (a document's version, or "absent"), and every
 *   collection it listed or queried has its write counter recorded;
 * - at the end, one immediate transaction checks that nothing it read has changed and applies
 *   every staged write. Anything changed is `REVISION_STALE` with `details.unitOfWork`, nothing
 *   is written, and the caller may run the work again on fresh state.
 *
 * Work that throws writes nothing. That is serializable for what the work read: a commit is
 * refused rather than applied over a write the work never saw.
 */
import { OrcaError } from "@orca/core";
import type {
  ConditionalWriteResult,
  DocumentPage,
  DocumentQuery,
  DocumentVersion,
  MetadataCollections,
  UnitOfWork,
  VersionedDocument,
  VersionedDocumentStore,
} from "../store-contracts.js";
import { pageDocuments } from "../store-contracts.js";
import type { SqliteDatabase } from "./database.js";
import type { SqliteCollection } from "./documents.js";

type Staged<T> = { kind: "put"; doc: T } | { kind: "delete" };

class Transaction {
  /** `collection\0id` -> version read, or null for "absent". */
  readonly reads = new Map<string, { collection: SqliteCollection<never>; id: string; version: string | null }>();
  /** collection name -> write counter when it was first listed or queried. */
  readonly scans = new Map<string, { collection: SqliteCollection<never>; counter: number }>();
  readonly views: StagedCollection<never>[] = [];
  done = false;
}

class StagedCollection<T extends { id: string }> implements VersionedDocumentStore<T> {
  /** Staged writes by id, in the order they were last made. */
  readonly staged = new Map<string, Staged<T>>();
  constructor(
    readonly collection: SqliteCollection<T>,
    private readonly tx: Transaction,
  ) {}

  private live(): void {
    if (this.tx.done) throw new OrcaError("STORE_WRITE", "this unit of work has already finished");
  }

  /** The committed document, recording what was seen. */
  private async committed(id: string): Promise<VersionedDocument<T> | undefined> {
    const current = await this.collection.db.read(() => this.collection.versionedSync(id));
    const key = `${this.collection.name}\0${id}`;
    if (!this.tx.reads.has(key))
      this.tx.reads.set(key, {
        collection: this.collection as unknown as SqliteCollection<never>,
        id,
        version: current?.version ?? null,
      });
    return current;
  }

  private async current(id: string): Promise<VersionedDocument<T> | undefined> {
    const staged = this.staged.get(id);
    if (staged) {
      // Still read the committed row once, so the commit notices a concurrent change to it.
      await this.committed(id);
      return staged.kind === "put"
        ? { doc: structuredClone(staged.doc), version: this.collection.versionOf(staged.doc) }
        : undefined;
    }
    return this.committed(id);
  }

  private async all(): Promise<T[]> {
    const { rows, counter } = await this.collection.db.read(() => ({
      rows: this.collection.listSync(),
      counter: this.collection.counterSync(),
    }));
    if (!this.tx.scans.has(this.collection.name))
      this.tx.scans.set(this.collection.name, {
        collection: this.collection as unknown as SqliteCollection<never>,
        counter,
      });
    const map = new Map(rows.map((doc) => [doc.id, doc]));
    for (const [id, s] of this.staged) {
      if (s.kind === "put") map.set(id, structuredClone(s.doc));
      else map.delete(id);
    }
    return [...map.values()];
  }

  async get(id: string): Promise<T | undefined> {
    this.live();
    return (await this.current(id))?.doc;
  }
  async getVersioned(id: string): Promise<VersionedDocument<T> | undefined> {
    this.live();
    return this.current(id);
  }
  async put(doc: T): Promise<void> {
    this.live();
    this.stage(doc.id, { kind: "put", doc: structuredClone(doc) });
  }
  async putMany(docs: readonly T[]): Promise<void> {
    this.live();
    for (const doc of docs) this.stage(doc.id, { kind: "put", doc: structuredClone(doc) });
  }
  async delete(id: string): Promise<void> {
    this.live();
    this.stage(id, { kind: "delete" });
  }
  async list(predicate?: (doc: T) => boolean): Promise<T[]> {
    this.live();
    const all = await this.all();
    return predicate ? all.filter(predicate) : all;
  }
  async query(query?: DocumentQuery<T>): Promise<DocumentPage<T>> {
    this.live();
    return pageDocuments(await this.all(), query);
  }
  async putIfVersion(doc: T, expected: DocumentVersion | null): Promise<ConditionalWriteResult<T>> {
    this.live();
    const current = await this.current(doc.id);
    if ((current?.version ?? null) !== expected) return { ok: false, current };
    this.stage(doc.id, { kind: "put", doc: structuredClone(doc) });
    return { ok: true, version: this.collection.versionOf(doc) };
  }
  async deleteIfVersion(id: string, expected: DocumentVersion): Promise<ConditionalWriteResult<T>> {
    this.live();
    const current = await this.current(id);
    if ((current?.version ?? null) !== expected) return { ok: false, current };
    this.stage(id, { kind: "delete" });
    return { ok: true, version: undefined };
  }

  private stage(id: string, s: Staged<T>): void {
    this.staged.delete(id);
    this.staged.set(id, s);
  }
}

export function sqliteUnitOfWork(
  db: SqliteDatabase,
  collections: { [K in keyof MetadataCollections]: SqliteCollection<never> },
): UnitOfWork {
  return async <R>(work: (tx: MetadataCollections) => Promise<R>): Promise<R> => {
    const tx = new Transaction();
    const views = Object.fromEntries(
      Object.entries(collections).map(([key, collection]) => {
        const view = new StagedCollection(collection, tx);
        tx.views.push(view);
        return [key, view];
      }),
    ) as unknown as MetadataCollections;
    let result: R;
    try {
      result = await work(views);
    } finally {
      tx.done = true;
    }
    const writes = tx.views.filter((v) => v.staged.size > 0);
    if (writes.length === 0) return result;
    await db.write(() => {
      for (const { collection, id, version } of tx.reads.values()) {
        const now = collection.versionedSync(id)?.version ?? null;
        if (now !== version) throw stale({ collection: collection.name, id });
      }
      for (const { collection, counter } of tx.scans.values())
        if (collection.counterSync() !== counter) throw stale({ collection: collection.name });
      for (const view of writes) {
        for (const [id, s] of view.staged) {
          if (s.kind === "put") view.collection.putSync(s.doc);
          else view.collection.deleteSync(id);
        }
        view.collection.bumpSync();
      }
    });
    return result;
  };
}

function stale(where: { collection: string; id?: string }): OrcaError {
  return new OrcaError("REVISION_STALE", "metadata read by this unit of work changed before it committed", {
    unitOfWork: true,
    ...where,
  });
}
