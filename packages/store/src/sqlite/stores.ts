/**
 * `sqliteStores(dir)` (#339): the store seams on one SQLite database at `<dir>/metadata.sqlite`.
 *
 * In SQLite: every metadata collection (requests, work items, plans, dependencies, risks,
 * decisions), the run event log, the plan journal and the artifact index. A unit of work can
 * commit several collections together (`metadata.unitOfWork`).
 *
 * Still files, deliberately:
 * - artifact bytes (content-addressed blobs; SQLite holds only their index);
 * - private execution records and pinned workflow versions, which are encrypted per record
 *   (`protected-file.ts`) and keep that protection unchanged;
 * - claims and leases, whose ownership callbacks write to other stores while the fence is held:
 *   an asynchronous callback cannot run inside a synchronous SQLite transaction without holding
 *   the database's write lock across it.
 *
 * This is not the default backend and changes nothing on disk for a workspace that does not
 * open it. A workspace moves to it with `orca store sqlite switch` (store-format.ts), which
 * records the backend and the database's id in the store's format marker.
 */
import { join } from "node:path";
import {
  DecisionSchema,
  DependencySchema,
  PlanSchema,
  RequestSchema,
  RiskSchema,
  WorkItemSchema,
  type Clock,
  type Logger,
} from "@orca/core";
import { FileClaimStore } from "../claim-store.js";
import type { Stores } from "../document-store.js";
import { FileExecutionStore } from "../execution-store.js";
import { FileLeaseStore } from "../lease-store.js";
import { ProtectedEventStore } from "../protected-event-store.js";
import { SQLITE_STORE_CAPABILITIES } from "../store-contracts.js";
import { FileWorkflowVersionStore } from "../workflow-store.js";
import { SqliteArtifactStore } from "./artifacts.js";
import { checkBoundSqliteMetadata, SqliteDatabase, type SqliteOptions } from "./database.js";
import { recordedSqliteBinding, recordedStoreBackend, refuseOtherBackend } from "../store-backend.js";
import { SqliteDocumentStore, type SqliteCollection } from "./documents.js";
import { SqliteEventStore } from "./events.js";
import { SqlitePlanJournal } from "./journal.js";
import { sqliteUnitOfWork } from "./unit-of-work.js";

export const SQLITE_METADATA_FILE = "metadata.sqlite";

export interface SqliteStoresOptions extends SqliteOptions {
  clock?: Clock;
  logger?: Logger;
  /**
   * Open the database even though the store records file metadata: only for maintenance that
   * builds or checks a database beside the files (an import before the switch, the benchmark).
   * A workspace never runs on such a database (store-backend.ts).
   */
  unselected?: boolean;
}

/**
 * The database under `dir`, opened as its workspace's metadata unless `unselected`. A store whose
 * marker records SQLite opens only the database bound to it, which must already exist: it is
 * checked first, changing nothing (`checkBoundSqliteMetadata`), so a lost or replaced database
 * is refused rather than created empty. A store with no marker yet (a test, a fresh directory)
 * gets a new database, as before.
 */
function openDatabase(dir: string, unselected: boolean | undefined, options: SqliteOptions): SqliteDatabase {
  const file = join(dir, SQLITE_METADATA_FILE);
  if (!unselected) {
    refuseOtherBackend(dir, "sqlite");
    if (recordedStoreBackend(dir) === "sqlite") checkBoundSqliteMetadata(file, dir, recordedSqliteBinding(dir));
  }
  return new SqliteDatabase(file, options);
}

/** A new connection on every call: two handles behave like two processes sharing the file. */
export function sqliteStores(dir: string, options: SqliteStoresOptions = {}): Stores {
  const { clock, logger: _logger, unselected, ...db } = options;
  const database = openDatabase(dir, unselected, db);
  const execution = new FileExecutionStore(dir);
  const workflows = new FileWorkflowVersionStore(dir);
  const requests = new SqliteDocumentStore(database, "requests", RequestSchema);
  const workItems = new SqliteDocumentStore(database, "workItems", WorkItemSchema);
  const plans = new SqliteDocumentStore(database, "plans", PlanSchema);
  const dependencies = new SqliteDocumentStore(database, "dependencies", DependencySchema);
  const risks = new SqliteDocumentStore(database, "risks", RiskSchema);
  const decisions = new SqliteDocumentStore(database, "decisions", DecisionSchema);
  const c = <T extends { id: string }>(s: SqliteDocumentStore<T>) => s.collection as unknown as SqliteCollection<never>;
  return {
    execution,
    events: new ProtectedEventStore(new SqliteEventStore(database, clock), execution, workflows),
    artifacts: new SqliteArtifactStore(dir, database),
    requests,
    workItems,
    claims: new FileClaimStore(dir),
    leases: new FileLeaseStore(dir, clock),
    plan: { plans, dependencies, risks, decisions, journal: new SqlitePlanJournal(database, clock) },
    workflows,
    capabilities: SQLITE_STORE_CAPABILITIES,
    unitOfWork: sqliteUnitOfWork(database, {
      requests: c(requests),
      workItems: c(workItems),
      plans: c(plans),
      dependencies: c(dependencies),
      risks: c(risks),
      decisions: c(decisions),
    }),
    close: () => database.close(),
  };
}

/** One collection on the database under `dir`, for tests and tools that need a bare collection. */
export function sqliteCollection<T extends { id: string }>(
  dir: string,
  name: string,
  schema: import("zod").ZodType<T>,
  options: SqliteOptions & { unselected?: boolean } = {},
): SqliteDocumentStore<T> {
  const { unselected, ...db } = options;
  return new SqliteDocumentStore(openDatabase(dir, unselected, db), name, schema);
}
