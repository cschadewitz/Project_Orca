/** Safe admission index. Authoritative command bytes live in the existing ExecutionStore. */
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isOrcaError, OrcaError } from "@orca/core";
import { InMemoryDocumentStore, JsonFileDocumentStore, withFileLock, type DocumentStore } from "@orca/store";

export const AdmissionSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  workspaceId: z.string(),
  principalId: z.string(),
  workflowId: z.string(),
  workflowVersion: z.string(),
  workflowRevision: z.string(),
  generationId: z.string(),
  createdAt: z.string(),
  /** v1 used a reserved var; v2 uses authenticated creation metadata outside workflow inputs. */
  correlationVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  state: z.enum(["prepared", "accepted", "recoverable-failure"]),
  runId: z.string().optional(),
  /** Reserved root identity for bounded retry reconciliation (never a wire input). */
  reservedRunId: z.string().optional(),
});
export type Admission = z.infer<typeof AdmissionSchema>;

export interface AdmissionStore {
  readonly records: DocumentStore<Admission>;
  /** Serializes the entire reconcile operation across service instances/processes. */
  lock<T>(id: string, action: () => Promise<T>): Promise<T>;
}

export class FileAdmissionStore implements AdmissionStore {
  readonly records: DocumentStore<Admission>;
  constructor(private readonly storeDir: string) {
    this.records = new DurableAdmissionDocuments(storeDir);
  }
  async lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const dir = join(this.storeDir, "request-admission-locks");
    let actionFailed = false;
    try {
      await mkdir(dir, { recursive: true });
      return await withFileLock(join(dir, encodeURIComponent(id) + ".lock"), async () => {
        try {
          return await action();
        } catch (error) {
          actionFailed = true;
          throw error;
        }
      });
    } catch (error) {
      if (actionFailed) throw error;
      throw new OrcaError(
        isOrcaError(error, "STORE_LOCK_TIMEOUT") ? "STORE_LOCK_TIMEOUT" : "STORE_WRITE",
        "Request admission lock is unavailable",
      );
    }
  }
}

/** The admission acknowledgment includes durability of the directory entry after rename. */
class DurableAdmissionDocuments extends JsonFileDocumentStore<Admission> {
  constructor(private readonly storeDir: string) {
    super(join(storeDir, "request-admissions.json"), AdmissionSchema);
  }
  override async put(record: Admission): Promise<void> {
    await super.put(record);
    if (process.platform !== "win32") {
      const directory = await open(this.storeDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
}

/** Test/ephemeral implementation; never a production acceptance ledger. */
export class MemoryAdmissionStore implements AdmissionStore {
  readonly records = new InMemoryDocumentStore<Admission>();
  private readonly pending = new Map<string, Promise<unknown>>();
  async lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.pending.set(id, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(id) === next) this.pending.delete(id);
    }
  }
}
