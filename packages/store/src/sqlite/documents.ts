/**
 * Document collections in SQLite (#339): one row per document in the shared `documents` table.
 *
 * Every write is one immediate transaction, so a `putMany` is all-or-nothing to every reader
 * (in this process or another) and a compare-and-swap's check and write cannot be separated.
 * A document's version is the same content hash the other backends use (`documentVersion` of
 * the document as it parses back from JSON), computed on read, so nothing extra is stored and
 * a version means the same thing whichever backend produced it.
 *
 * Reads parse a fresh object from the stored JSON, so a caller can never reach the stored
 * document, and a write stores the JSON of the caller's object at the time of the call.
 */
import type { ZodType } from "zod";
import {
  documentVersion,
  type ConditionalWriteResult,
  type DocumentPage,
  type DocumentQuery,
  type DocumentVersion,
  type VersionedDocument,
  type VersionedDocumentStore,
} from "../store-contracts.js";
import { pageDocuments } from "../store-contracts.js";
import type { SqliteDatabase } from "./database.js";

/** The id as fixed-width UTF-16 code units, so byte order is code-unit order. */
export function sortKey(id: string): string {
  let key = "";
  for (let i = 0; i < id.length; i++) key += id.charCodeAt(i).toString(16).padStart(4, "0");
  return key;
}

const FIELD = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface Row {
  body: string;
}

/**
 * The synchronous operations on one collection, usable inside a transaction. The store's
 * async methods wrap these in `db.read`/`db.write`; a unit of work calls them directly in
 * its commit transaction.
 */
export class SqliteCollection<T extends { id: string }> {
  constructor(
    readonly db: SqliteDatabase,
    readonly name: string,
    readonly schema: ZodType<T>,
  ) {}

  parse(body: string): T {
    return this.schema.parse(JSON.parse(body));
  }

  /** What a reader of the stored JSON would compute; see `JsonFileDocumentStore.versionOf`. */
  versionOf(doc: T): DocumentVersion {
    return documentVersion(this.schema.parse(JSON.parse(JSON.stringify(doc))));
  }

  getSync(id: string): T | undefined {
    const row = this.db.prepare("SELECT body FROM documents WHERE collection = ? AND id = ?").get(this.name, id) as
      Row | undefined;
    return row && this.parse(row.body);
  }

  versionedSync(id: string): VersionedDocument<T> | undefined {
    const doc = this.getSync(id);
    return doc && { doc, version: this.versionOf(doc) };
  }

  /**
   * Store `doc` as JSON. It must parse back through the collection's schema: a document every
   * later read would fail on is refused here, inside the transaction, rather than committed.
   */
  putSync(doc: T): void {
    const body = JSON.stringify(doc);
    this.schema.parse(JSON.parse(body));
    this.db
      .prepare(
        "INSERT INTO documents (collection, id, sort_key, body) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body",
      )
      .run(this.name, doc.id, sortKey(doc.id), body);
  }

  deleteSync(id: string): void {
    this.db.prepare("DELETE FROM documents WHERE collection = ? AND id = ?").run(this.name, id);
  }

  /** Every committed write bumps this; a unit of work compares it to see writes it missed. */
  bumpSync(): void {
    this.db
      .prepare(
        "INSERT INTO collection_versions (collection, counter) VALUES (?, 1) " +
          "ON CONFLICT (collection) DO UPDATE SET counter = counter + 1",
      )
      .run(this.name);
  }

  counterSync(): number {
    const row = this.db.prepare("SELECT counter FROM collection_versions WHERE collection = ?").get(this.name) as
      { counter: number } | undefined;
    return Number(row?.counter ?? 0);
  }

  listSync(): T[] {
    const rows = this.db
      .prepare("SELECT body FROM documents WHERE collection = ? ORDER BY rowid")
      .all(this.name) as unknown as Row[];
    return rows.map((r) => this.parse(r.body));
  }

  /**
   * A typed query in SQL: equality on top-level fields through `json_type`/`json_extract`, so
   * `true` matches only JSON `true` and `null` only a present JSON `null`, as `===` does in
   * `pageDocuments`. A field name that is not a plain identifier falls back to filtering in
   * process; the answer is the same either way.
   */
  querySync(query: DocumentQuery<T> = {}): DocumentPage<T> {
    const { where, limit, after } = query;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new RangeError(`document query limit must be a positive integer, got ${String(limit)}`);
    const conditions = where ? Object.entries(where).filter(([, v]) => v !== undefined) : [];
    if (conditions.some(([k]) => !FIELD.test(k))) return pageDocuments(this.listSync(), query);
    const clauses = ["collection = ?"];
    const params: (string | number)[] = [this.name];
    if (after !== undefined) {
      clauses.push("sort_key > ?");
      params.push(sortKey(after));
    }
    for (const [key, value] of conditions) {
      const path = `'$.${key}'`;
      if (value === null) clauses.push(`json_type(body, ${path}) = 'null'`);
      else if (value === true) clauses.push(`json_type(body, ${path}) = 'true'`);
      else if (value === false) clauses.push(`json_type(body, ${path}) = 'false'`);
      else if (typeof value === "number") {
        clauses.push(`json_type(body, ${path}) IN ('integer', 'real') AND json_extract(body, ${path}) = ?`);
        params.push(value);
      } else if (typeof value === "string") {
        clauses.push(`json_type(body, ${path}) = 'text' AND json_extract(body, ${path}) = ?`);
        params.push(value);
      } else return pageDocuments(this.listSync(), query);
    }
    let sql = `SELECT id, body FROM documents WHERE ${clauses.join(" AND ")} ORDER BY sort_key`;
    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(limit + 1);
    }
    const rows = this.db.prepare(sql).all(...params) as unknown as (Row & { id: string })[];
    const items = rows.slice(0, limit ?? rows.length).map((r) => this.parse(r.body));
    if (limit === undefined || rows.length <= limit) return { items };
    return { items, next: items[items.length - 1]!.id };
  }

  /** The compare-and-swap decision, inside the caller's write transaction. */
  putIfVersionSync(doc: T, expected: DocumentVersion | null): ConditionalWriteResult<T> {
    const current = this.versionedSync(doc.id);
    if ((current?.version ?? null) !== expected) return { ok: false, current };
    this.putSync(doc);
    this.bumpSync();
    return { ok: true, version: this.versionOf(doc) };
  }

  deleteIfVersionSync(id: string, expected: DocumentVersion): ConditionalWriteResult<T> {
    const current = this.versionedSync(id);
    if ((current?.version ?? null) !== expected) return { ok: false, current };
    this.deleteSync(id);
    this.bumpSync();
    return { ok: true, version: undefined };
  }
}

export class SqliteDocumentStore<T extends { id: string }> implements VersionedDocumentStore<T> {
  readonly collection: SqliteCollection<T>;
  constructor(db: SqliteDatabase, name: string, schema: ZodType<T>) {
    this.collection = new SqliteCollection(db, name, schema);
  }
  private get db(): SqliteDatabase {
    return this.collection.db;
  }

  get(id: string): Promise<T | undefined> {
    return this.db.read(() => this.collection.getSync(id));
  }
  async put(doc: T): Promise<void> {
    const snapshot = structuredClone(doc);
    await this.db.write(() => {
      this.collection.putSync(snapshot);
      this.collection.bumpSync();
    });
  }
  async putMany(docs: readonly T[]): Promise<void> {
    if (docs.length === 0) return;
    const snapshot = docs.map((doc) => structuredClone(doc));
    await this.db.write(() => {
      for (const doc of snapshot) this.collection.putSync(doc);
      this.collection.bumpSync();
    });
  }
  async delete(id: string): Promise<void> {
    await this.db.write(() => {
      this.collection.deleteSync(id);
      this.collection.bumpSync();
    });
  }
  async list(predicate?: (doc: T) => boolean): Promise<T[]> {
    const all = await this.db.read(() => this.collection.listSync());
    return predicate ? all.filter(predicate) : all;
  }
  getVersioned(id: string): Promise<VersionedDocument<T> | undefined> {
    return this.db.read(() => this.collection.versionedSync(id));
  }
  putIfVersion(doc: T, expected: DocumentVersion | null): Promise<ConditionalWriteResult<T>> {
    const snapshot = structuredClone(doc);
    return this.db.write(() => this.collection.putIfVersionSync(snapshot, expected));
  }
  deleteIfVersion(id: string, expected: DocumentVersion): Promise<ConditionalWriteResult<T>> {
    return this.db.write(() => this.collection.deleteIfVersionSync(id, expected));
  }
  async query(query?: DocumentQuery<T>): Promise<DocumentPage<T>> {
    return this.db.read(() => this.collection.querySync(query));
  }
}
