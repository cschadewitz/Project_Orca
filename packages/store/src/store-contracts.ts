/**
 * Versioned contracts for the seven store seams (#338).
 *
 * ORCA persists through seven interfaces: the run event log (`EventStore`), artifacts
 * (`ArtifactStore`), keyed document collections (`DocumentStore<T>`), work-item claims
 * (`ClaimStore`), run leases (`LeaseStore`), the plan journal (`PlanJournal`) and pinned
 * workflow versions (`WorkflowVersionStore`). The memory and file backends were the only ones,
 * so what callers relied on was whatever those two happened to do. This module names the
 * guarantees instead, so a new backend (SQLite, #339) can be held to them by the conformance
 * suite in `packages/store/test/conformance/` rather than by rereading the file store.
 *
 * `docs/contracts/store-contracts-v1.md` is the prose contract for each seam: identity,
 * ordering, durability, retention, errors, and which data is authoritative versus derived.
 *
 * Nothing here changes what is on disk. A document's version is a hash of its content, computed
 * when it is read, so compare-and-swap works on every existing collection file without a new
 * field or a format change; the store format epoch (#566, #897) is untouched.
 *
 * A capability a backend does not have is an explicit `NOT_SUPPORTED` error, never a silently
 * weaker guarantee: `requireStoreCapability`, `asVersionedDocumentStore` and `runUnitOfWork`
 * are the gates.
 */
import { createHash } from "node:crypto";
import {
  OrcaError,
  type Decision,
  type Dependency,
  type Plan,
  type Request,
  type Risk,
  type WorkItem,
} from "@orca/core";
import type { DocumentStore } from "./document-store.js";

// ------------------------------------------------------------------ versions

/**
 * The contract version each seam's implementations satisfy. A change that weakens or alters a
 * documented guarantee bumps the seam's number and the contract document; adding an optional
 * capability does not. This is the *interface* contract, independent of the on-disk store
 * format epoch (`store-format.ts`).
 */
export const STORE_CONTRACT_VERSIONS = {
  event: 1,
  artifact: 1,
  document: 1,
  claim: 1,
  lease: 1,
  journal: 1,
  workflowVersion: 1,
} as const;

export type StoreSeam = keyof typeof STORE_CONTRACT_VERSIONS;

export const STORE_SEAMS = Object.keys(STORE_CONTRACT_VERSIONS) as StoreSeam[];

// -------------------------------------------------------------- capabilities

/**
 * Optional guarantees. The baseline contract of each seam holds for every backend; these are
 * the ones a backend may or may not offer, and a caller that needs one asks for it.
 */
export type StoreCapability =
  /** State survives the process: a reopened store reads what an acknowledged write wrote. */
  | "durable"
  /** Every guarantee below holds between processes sharing the store, not just within one. */
  | "crossProcess"
  /** `DocumentStore` exposes content versions and compare-and-swap (`VersionedDocumentStore`). */
  | "document.versioned"
  /** `DocumentStore.query` serves typed equality queries with deterministic id pagination natively. */
  | "document.query"
  /** `putMany` is all-or-nothing within one collection: no reader sees part of the batch. */
  | "document.batchAtomic"
  /** Writes across several metadata collections commit or roll back together (`runUnitOfWork`). */
  | "metadata.unitOfWork"
  /** `EventStore.appendDurableUnique`: correlated, idempotent journal publication under a fence. */
  | "event.durableUnique"
  /** `EventStore.readObservation`: a bounded, verifiable snapshot of a run's public history. */
  | "event.observation"
  /** `ArtifactStore.put` refuses a body whose SHA-256 is not the artifact's `contentHash`. */
  | "artifact.verifiedContent"
  /** `FileArtifactStore.unreferencedBlobs`: blobs no index record points at can be listed for reclaim. */
  | "artifact.orphanInventory";

export const STORE_CAPABILITIES: readonly StoreCapability[] = [
  "durable",
  "crossProcess",
  "document.versioned",
  "document.query",
  "document.batchAtomic",
  "metadata.unitOfWork",
  "event.durableUnique",
  "event.observation",
  "artifact.verifiedContent",
  "artifact.orphanInventory",
];

/** What one backend offers: its name, the contract versions it meets, and each capability. */
export interface StoreCapabilityMatrix {
  backend: string;
  contracts: Readonly<Record<StoreSeam, number>>;
  capabilities: Readonly<Record<StoreCapability, boolean>>;
}

function matrix(backend: string, offered: readonly StoreCapability[]): StoreCapabilityMatrix {
  const capabilities = Object.fromEntries(STORE_CAPABILITIES.map((c) => [c, offered.includes(c)])) as Record<
    StoreCapability,
    boolean
  >;
  return Object.freeze({
    backend,
    contracts: Object.freeze({ ...STORE_CONTRACT_VERSIONS }),
    capabilities: Object.freeze(capabilities),
  });
}

/** The in-process reference backend. Nothing outlives the process; nothing is shared with another. */
export const MEMORY_STORE_CAPABILITIES: StoreCapabilityMatrix = matrix("memory", [
  "document.versioned",
  "document.batchAtomic",
  "event.durableUnique",
  "event.observation",
  "artifact.verifiedContent",
]);

/**
 * The file backend (`fileStores`). Durable and safe across processes, one collection file per
 * document type, so a batch is atomic within a collection (one rename) but not across them.
 */
export const FILE_STORE_CAPABILITIES: StoreCapabilityMatrix = matrix("file", [
  "durable",
  "crossProcess",
  "document.versioned",
  "document.batchAtomic",
  "event.durableUnique",
  "event.observation",
  "artifact.verifiedContent",
  "artifact.orphanInventory",
]);

/** Throw `NOT_SUPPORTED` unless the backend offers `capability`. */
export function requireStoreCapability(matrix: StoreCapabilityMatrix, capability: StoreCapability): void {
  if (matrix.capabilities[capability]) return;
  throw unsupported(capability, matrix.backend);
}

export function unsupported(capability: StoreCapability, backend?: string): OrcaError {
  return new OrcaError(
    "NOT_SUPPORTED",
    `store backend${backend ? ` "${backend}"` : ""} does not support ${capability}`,
    backend ? { capability, backend } : { capability },
  );
}

// ------------------------------------------------------- versioned documents

/**
 * An opaque document version (an ETag). Callers compare versions for equality and hand them
 * back; they never parse or order them. The memory and file backends derive it from the
 * document's content, so it changes exactly when the stored document changes.
 */
export type DocumentVersion = string;

export interface VersionedDocument<T> {
  doc: T;
  version: DocumentVersion;
}

/**
 * The outcome of a conditional write. Losing a race is an outcome, not a fault, the same as
 * a lost claim: `ok: false` carries what is stored now (or `undefined` when nothing is), so
 * the caller can rebase and retry without a second read.
 */
export type ConditionalWriteResult<T> =
  { ok: true; version: DocumentVersion | undefined } | { ok: false; current: VersionedDocument<T> | undefined };

/** Equality on top-level scalar fields. Every listed field must match. */
export type DocumentWhere<T> = { [K in keyof T]?: Extract<T[K], string | number | boolean | null> };

export interface DocumentQuery<T> {
  where?: DocumentWhere<T>;
  /** At most this many documents. Absent means every match. Must be a positive integer. */
  limit?: number;
  /** Cursor: only documents whose id sorts after this one (code-unit order). */
  after?: string;
}

/** One page, in ascending id order (code-unit order, not locale order, so it is the same everywhere). */
export interface DocumentPage<T> {
  items: T[];
  /** Pass as `after` for the next page; absent when this page was the last. */
  next?: string;
}

export interface VersionedDocumentStore<T extends { id: string }> extends DocumentStore<T> {
  getVersioned(id: string): Promise<VersionedDocument<T> | undefined>;
  /**
   * Write `doc` only while the stored version is `expected`; `null` means "only if absent". The
   * check and the write are one atomic step, across processes when the backend is
   * `crossProcess`, so two writers holding the same version cannot both succeed.
   */
  putIfVersion(doc: T, expected: DocumentVersion | null): Promise<ConditionalWriteResult<T>>;
  /** Delete `id` only while the stored version is `expected`. */
  deleteIfVersion(id: string, expected: DocumentVersion): Promise<ConditionalWriteResult<T>>;
  query(query?: DocumentQuery<T>): Promise<DocumentPage<T>>;
}

export function isVersionedDocumentStore<T extends { id: string }>(
  store: DocumentStore<T>,
): store is VersionedDocumentStore<T> {
  const s = store as Partial<VersionedDocumentStore<T>>;
  return (
    typeof s.getVersioned === "function" &&
    typeof s.putIfVersion === "function" &&
    typeof s.deleteIfVersion === "function" &&
    typeof s.query === "function"
  );
}

/**
 * The versioned view of a collection, or `NOT_SUPPORTED`. There is deliberately no adapter that
 * emulates compare-and-swap over plain `get`/`put`: that would be a read-then-write race
 * dressed up as a guarantee.
 */
export function asVersionedDocumentStore<T extends { id: string }>(store: DocumentStore<T>): VersionedDocumentStore<T> {
  if (isVersionedDocumentStore(store)) return store;
  throw unsupported("document.versioned");
}

/**
 * Typed query over any collection. Uses the store's own `query` when it has one; otherwise
 * filters `list()`. The fallback is a compatibility adapter for existing consumers: it gives
 * the same answer, at the cost of reading the collection.
 */
export function queryDocuments<T extends { id: string }>(
  store: DocumentStore<T>,
  query: DocumentQuery<T> = {},
): Promise<DocumentPage<T>> {
  if (isVersionedDocumentStore(store)) return store.query(query);
  return store.list().then((docs) => pageDocuments(docs, query));
}

/** Apply a query to a materialized collection. Shared by the reference backends and the adapter. */
export function pageDocuments<T extends { id: string }>(
  docs: Iterable<T>,
  query: DocumentQuery<T> = {},
): DocumentPage<T> {
  const { where, limit, after } = query;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new RangeError(`document query limit must be a positive integer, got ${String(limit)}`);
  const conditions = where ? Object.entries(where).filter(([, v]) => v !== undefined) : [];
  const matching = [...docs]
    .filter((d) => after === undefined || compareIds(d.id, after) > 0)
    .filter((d) => conditions.every(([k, v]) => (d as Record<string, unknown>)[k] === v))
    .sort((a, b) => compareIds(a.id, b.id));
  if (limit === undefined || matching.length <= limit) return { items: matching };
  const items = matching.slice(0, limit);
  return { items, next: items[items.length - 1]!.id };
}

/** Code-unit order: deterministic across hosts and locales, unlike `localeCompare`. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The content version of a document: SHA-256 of its JSON with object keys sorted, so key order
 * and `undefined` fields (which JSON drops) do not change it. Backends that store documents as
 * JSON derive it on read, which is what keeps compare-and-swap free of any on-disk change.
 */
export function documentVersion(doc: unknown): DocumentVersion {
  return createHash("sha256").update(canonicalJson(doc)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => compareIds(a, b)));
  });
}

// --------------------------------------------------------------- unit of work

/**
 * The metadata collections a unit of work may write together. Blobs (artifacts), the event log
 * and agent providers are outside it on purpose: there is no transaction across external blobs
 * and providers, so a caller that writes a blob first and metadata second must treat the blob
 * as unreferenced until the metadata commits (see `FileArtifactStore.unreferencedBlobs`).
 */
export interface MetadataCollections {
  requests: DocumentStore<Request>;
  workItems: DocumentStore<WorkItem>;
  plans: DocumentStore<Plan>;
  dependencies: DocumentStore<Dependency>;
  risks: DocumentStore<Risk>;
  decisions: DocumentStore<Decision>;
}

/**
 * Run `work` so that every write it makes through `tx` commits together, or none does when it
 * throws. A backend offers it by implementing this; one that cannot keeps it absent.
 */
export type UnitOfWork = <R>(work: (tx: MetadataCollections) => Promise<R>) => Promise<R>;

/** Run `work` as one unit of work, or `NOT_SUPPORTED` when the backend cannot promise it. */
export function runUnitOfWork<R>(
  stores: { unitOfWork?: UnitOfWork | undefined; capabilities?: StoreCapabilityMatrix | undefined },
  work: (tx: MetadataCollections) => Promise<R>,
): Promise<R> {
  if (!stores.unitOfWork) return Promise.reject(unsupported("metadata.unitOfWork", stores.capabilities?.backend));
  return stores.unitOfWork(work);
}
