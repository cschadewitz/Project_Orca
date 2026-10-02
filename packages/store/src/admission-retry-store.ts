/** Indexed admission journal. Only opaque pointers/counters are public; records reuse ExecutionStore. */
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { OrcaError } from "@orca/core";
import type {
  JsonValue,
  RetryClaimStore,
  RetryFaults,
  RetryLimits,
  RetryRecord,
  RetryScope,
} from "../../core/src/model/admission-retry.js";
import type { ExecutionStore } from "./execution-store.js";
import { withFileLock } from "./file-lock.js";

const idPattern = /^retry_[a-f0-9-]{36}$/;
const Pointer = z.strictObject({ operationId: z.string().regex(idPattern), ref: z.string().uuid() });
const Pending = Pointer.extend({ ordinal: z.number().int().positive(), lookup: z.string().optional() });
const Catalog = z.strictObject({
  total: z.number().int().nonnegative(),
  workspaces: z.record(z.string(), z.number().int().nonnegative()),
  principals: z.record(z.string(), z.number().int().nonnegative()),
  pending: Pending.optional(),
});
const RecordSchema = z.strictObject({
  operationId: z.string().regex(idPattern),
  workspaceId: z.string(),
  principalId: z.string(),
  kind: z.enum(["request.submit", "run.admit", "revision.submit", "revision.replace", "run.continue"]),
  command: z.json(),
  canonical: z.string(),
  binding: z.record(z.string(), z.json()).optional(),
  result: z.json().optional(),
  phase: z.enum(["claimed", "bound", "accepted"]),
});
const unavailable = () => new OrcaError("RUN_STATE", "Retry admission journal is unavailable");

export class FileRetryClaimStore implements RetryClaimStore {
  private readonly dir: string;
  private readonly limits: RetryLimits;
  constructor(
    private readonly options: {
      storeDir: string;
      execution: ExecutionStore;
      faults: RetryFaults;
      limits?: Partial<RetryLimits>;
      lockTimeoutMs?: number;
    },
  ) {
    this.dir = join(options.storeDir, "admission-retries");
    this.limits = { maxClaimsPerWorkspace: 100_000, maxClaimsPerPrincipal: 10_000, ...options.limits };
    if (Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n <= 0))
      throw new OrcaError("CONFIG_INVALID", "Retry quotas must be positive integers");
  }
  private async mutex<T>(name: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return withFileLock(join(this.dir, `${name}.lock`), action, { timeoutMs: this.options.lockTimeoutMs ?? 100 });
  }
  lock<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    if (!idPattern.test(operationId)) throw unavailable();
    return this.mutex(operationId, action);
  }
  private async json(name: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.dir, name), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw unavailable();
    }
  }
  private async publish(name: string, value: unknown): Promise<void> {
    const tmp = join(this.dir, `${randomUUID()}.tmp`);
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, join(this.dir, name));
      if (process.platform !== "win32") {
        for (const dir of [this.dir, this.options.storeDir]) {
          const handle = await open(dir, "r");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      }
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
  private async catalog(): Promise<z.infer<typeof Catalog>> {
    const raw = await this.json("catalog.json");
    const catalog = raw === undefined ? { total: 0, workspaces: {}, principals: {} } : Catalog.parse(raw);
    // Complete one write-ahead publication before accepting any other allocation.
    if (catalog.pending) {
      const { ordinal, lookup, ...pointer } = catalog.pending;
      if (!(await this.readMaterial(pointer))) throw unavailable();
      await this.publish(`${pointer.operationId}.json`, pointer);
      await this.publish(`entry-${ordinal}.json`, { operationId: pointer.operationId });
      if (lookup) {
        const keyId = `admission-retry-key-${lookup}`;
        const existing = await this.options.execution.getGeneration(keyId);
        if (existing === undefined)
          await this.options.execution.putGeneration(keyId, { operationId: pointer.operationId });
        else if (Pointer.pick({ operationId: true }).parse(existing).operationId !== pointer.operationId)
          throw unavailable();
      }
      delete catalog.pending;
      await this.publish("catalog.json", catalog);
    }
    return catalog;
  }
  private async salt(allowCreate: boolean): Promise<string> {
    // Lookup salt is sealed by the existing execution key. No additional key file/lifecycle.
    const id = "admission-retry-lookup";
    let value = await this.options.execution.getGeneration(id);
    if (value === undefined) {
      if (!allowCreate) throw unavailable();
      await this.options.execution.putGeneration(id, { salt: randomUUID() });
      value = await this.options.execution.getGeneration(id);
    }
    return z.strictObject({ salt: z.string().uuid() }).parse(value).salt;
  }
  async claim(
    scope: RetryScope,
    key: string | undefined,
    command: JsonValue,
    canonical: string,
  ): Promise<{ record: RetryRecord; fresh: boolean }> {
    return this.mutex("catalog", async () => {
      const catalog = await this.catalog();
      const salt = await this.salt(catalog.total === 0);
      const digest = (value: unknown) => createHmac("sha256", salt).update(JSON.stringify(value)).digest("hex");
      const lookup = key === undefined ? undefined : digest([scope.workspaceId, scope.principalId, scope.kind, key]);
      if (lookup) {
        const pointer = await this.options.execution.getGeneration(`admission-retry-key-${lookup}`);
        if (pointer !== undefined) {
          const { operationId } = Pointer.pick({ operationId: true }).parse(pointer);
          const record = await this.read(operationId);
          if (
            !record ||
            record.workspaceId !== scope.workspaceId ||
            record.principalId !== scope.principalId ||
            record.kind !== scope.kind
          )
            throw unavailable();
          return { record, fresh: false };
        }
      }
      const workspace = digest([scope.workspaceId]),
        principal = digest([scope.workspaceId, scope.principalId]);
      if (
        (catalog.workspaces[workspace] ?? 0) >= this.limits.maxClaimsPerWorkspace ||
        (catalog.principals[principal] ?? 0) >= this.limits.maxClaimsPerPrincipal
      )
        throw this.options.faults.limit();
      const record: RetryRecord = {
        ...scope,
        operationId: `retry_${randomUUID()}`,
        command,
        canonical,
        phase: "claimed",
      };
      const ref = await this.seal(record);
      catalog.total++;
      catalog.workspaces[workspace] = (catalog.workspaces[workspace] ?? 0) + 1;
      catalog.principals[principal] = (catalog.principals[principal] ?? 0) + 1;
      catalog.pending = { operationId: record.operationId, ref, ordinal: catalog.total, ...(lookup ? { lookup } : {}) };
      await this.publish("catalog.json", catalog);
      await this.catalog();
      return { record, fresh: true };
    });
  }
  private async seal(record: RetryRecord): Promise<string> {
    const ref = randomUUID();
    await this.options.execution.putGeneration(`admission-retry-${ref}`, RecordSchema.parse(record));
    return ref;
  }
  private async readMaterial(pointer: z.infer<typeof Pointer>): Promise<RetryRecord> {
    try {
      const record = RecordSchema.parse(await this.options.execution.getGeneration(`admission-retry-${pointer.ref}`));
      if (
        record.operationId !== pointer.operationId ||
        (record.phase === "accepted" && record.result === undefined) ||
        (record.phase !== "claimed" && !record.binding)
      )
        throw unavailable();
      return record;
    } catch {
      throw unavailable();
    }
  }
  async read(operationId: string): Promise<RetryRecord | undefined> {
    if (!idPattern.test(operationId)) throw unavailable();
    const value = await this.json(`${operationId}.json`);
    if (value === undefined) return undefined;
    const pointer = Pointer.parse(value);
    if (pointer.operationId !== operationId) throw unavailable();
    return this.readMaterial(pointer);
  }
  /** Caller holds the operation mutex. Immutable payload precedes the durable pointer swap. */
  async write(record: RetryRecord): Promise<void> {
    const previous = await this.read(record.operationId);
    if (
      !previous ||
      previous.canonical !== record.canonical ||
      previous.kind !== record.kind ||
      previous.principalId !== record.principalId ||
      previous.workspaceId !== record.workspaceId ||
      !isDeepStrictEqual(previous.command, record.command)
    )
      throw unavailable();
    if (previous.binding && !isDeepStrictEqual(previous.binding, record.binding)) throw this.options.faults.conflict();
    if (isDeepStrictEqual(previous, record)) return;
    const ref = await this.seal(record);
    await this.publish(`${record.operationId}.json`, { operationId: record.operationId, ref });
  }
  async batch(): Promise<string[]> {
    return this.mutex("catalog", async () => {
      const catalog = await this.catalog();
      const stored = await this.json("cursor.json");
      const cursor = stored === undefined ? 0 : z.number().int().nonnegative().parse(stored);
      const begin = cursor >= catalog.total ? 0 : cursor;
      const end = Math.min(begin + 100, catalog.total);
      const ids: string[] = [];
      for (let i = begin + 1; i <= end; i++)
        ids.push(Pointer.pick({ operationId: true }).parse(await this.json(`entry-${i}.json`)).operationId);
      await this.publish("cursor.json", end);
      return ids;
    });
  }
}
