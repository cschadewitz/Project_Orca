/** Protected, immutable discovery hints. Only the run journal can establish acceptance. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OrcaError } from "@orca/core";
import type { RetryClaimStore } from "../../core/src/model/admission-retry.js";
import type { ExecutionStore } from "./execution-store.js";
import { withFileLock } from "./file-lock.js";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const continuationId = z.string().regex(new RegExp(`^ct_${uuid}$`));
const operationId = z.string().regex(new RegExp(`^retry_${uuid}$`));
const LocatorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  continuationId,
  operationId,
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  principalId: z.string().min(1),
});
const BindingSchema = z.strictObject({
  continuationId,
  workspaceId: z.string().min(1),
  principalId: z.string().min(1),
});
const CommandSchema = z.object({ runId: z.string().min(1) });
export type ContinuationLocator = z.infer<typeof LocatorSchema>;
export interface ContinuationLocatorStore {
  /** Must precede authoritative publication; replay is allowed only for identical material. */
  bind(locator: ContinuationLocator): Promise<void>;
  read(continuationId: string): Promise<ContinuationLocator | undefined>;
  /** Candidates only. An existing locator, retry phase or cached result is never acceptance. */
  batch(): Promise<ContinuationLocator[]>;
}
const unavailable = () => new OrcaError("RUN_STATE", "Continuation locator is unavailable");
function parseLocator(value: unknown): ContinuationLocator {
  const parsed = LocatorSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
const key = (id: string) => `continuation-locator-${id}`;

export class FileContinuationLocatorStore implements ContinuationLocatorStore {
  constructor(
    private readonly options: {
      storeDir: string;
      execution: ExecutionStore;
      retries: RetryClaimStore;
      lockTimeoutMs?: number;
    },
  ) {}

  async bind(locator: ContinuationLocator): Promise<void> {
    // Validate and snapshot before awaiting: caller mutation must not change the locked identity.
    const expected = parseLocator(locator);
    const dir = join(this.options.storeDir, "continuation-locators");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await withFileLock(
      join(dir, `${expected.continuationId}.lock`),
      async () => {
        const previous = await this.read(expected.continuationId);
        if (previous !== undefined) {
          if (JSON.stringify(previous) !== JSON.stringify(expected)) throw unavailable();
          return;
        }
        await this.options.execution.putGeneration(key(expected.continuationId), expected);
      },
      { timeoutMs: this.options.lockTimeoutMs ?? 100 },
    );
  }

  async read(id: string): Promise<ContinuationLocator | undefined> {
    if (!continuationId.safeParse(id).success) throw unavailable();
    const value = await this.options.execution.getGeneration(key(id));
    if (value === undefined) return undefined;
    const locator = parseLocator(value);
    if (locator.continuationId !== id) throw unavailable();
    return locator;
  }

  async batch(): Promise<ContinuationLocator[]> {
    // Reuse the retry journal's persisted cursor and bounded page, never scan runs or generations.
    const ids = await this.options.retries.batch();
    if (ids.length > 100) throw unavailable();
    const candidates: ContinuationLocator[] = [];
    for (const id of ids) {
      if (!operationId.safeParse(id).success) throw unavailable();
      const record = await this.options.retries.read(id);
      if (!record || record.operationId !== id) throw unavailable();
      if (record.kind !== "run.continue" || record.binding === undefined) continue;
      const binding = BindingSchema.safeParse(record.binding);
      const command = CommandSchema.safeParse(record.command);
      if (
        !binding.success ||
        !command.success ||
        binding.data.workspaceId !== record.workspaceId ||
        binding.data.principalId !== record.principalId
      )
        throw unavailable();
      const locator = await this.read(binding.data.continuationId);
      const expected = parseLocator({
        schemaVersion: 1,
        ...binding.data,
        operationId: id,
        runId: command.data.runId,
      });
      if (locator !== undefined && JSON.stringify(locator) !== JSON.stringify(expected)) throw unavailable();
      // The retry claim can locate a journal marker after an index rewind, but is
      // only a candidate. The caller must authenticate that authoritative marker
      // before rebuilding a missing locator; discovery itself never writes one.
      candidates.push(expected);
    }
    return candidates;
  }
}
