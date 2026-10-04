/** Private authoritative execution inputs, sensitivity overlays and payloads, separate from the public event log. */
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { serialize } from "node:v8";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { OrcaError, type OrcaEventInput } from "@orca/core";
import {
  observePrivateReads,
  privateJsonNames,
  protectedRecordInvalid,
  readPrivateJson,
  readPrivateJsonBatch,
  validatePrivateJson,
  writePrivateJson,
} from "./protected-file.js";

const SensitivitySchema = z.object({ sensitiveNames: z.array(z.string()), secrets: z.array(z.unknown()) });
const ExecutionInputsSchema = SensitivitySchema.extend({
  runId: z.string(),
  workflowId: z.string(),
  workflowVersion: z.string(),
  vars: z.record(z.string(), z.unknown()),
  sensitivityRefs: z.array(z.string()).optional(),
});
export type ExecutionInputs = z.infer<typeof ExecutionInputsSchema>;
export type ExecutionSensitivity = z.infer<typeof SensitivitySchema>;
const OverlaySchema = SensitivitySchema.extend({ runId: z.string(), ref: z.string() });
const PayloadSchema = z.object({
  runId: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  sensitivityRefs: z.array(z.string()).default([]),
});

export interface ExecutionStore {
  /** Observe authenticated reads and later verify their same inputs without rehydrating plaintext. */
  observe?<T>(
    work: () => Promise<T>,
    limits: { maxRecords: number },
  ): Promise<{ value: T; verifyUnchanged(): Promise<void> }>;
  getGeneration(id: string): Promise<unknown>;
  putGeneration(id: string, snapshot: unknown): Promise<void>;
  getInputs(runId: string): Promise<ExecutionInputs | undefined>;
  putInputs(inputs: ExecutionInputs): Promise<void>;
  addSensitivity(runId: string, sensitivity: ExecutionSensitivity): Promise<void>;
  getPayload(runId: string, ref: string, type: string): Promise<OrcaEventInput["payload"]>;
  /** Authenticate one replay batch with fresh inputs/sensitivity per run, never caller-supplied state. */
  getPayloads?(references: readonly ExecutionPayloadReference[]): Promise<OrcaEventInput["payload"][]>;
  putPayload(ref: string, input: OrcaEventInput): Promise<void>;
}

export interface ExecutionPayloadReference {
  runId: string;
  ref: string;
  type: string;
}

function mergeSensitivity(
  inputs: ExecutionInputs,
  entries: { ref: string; sensitiveNames: string[]; secrets: unknown[] }[],
): ExecutionInputs {
  if (!entries.length) return structuredClone(inputs);
  return structuredClone({
    ...inputs,
    sensitiveNames: [...new Set([...inputs.sensitiveNames, ...entries.flatMap((entry) => entry.sensitiveNames)])],
    secrets: [...inputs.secrets, ...entries.flatMap((entry) => entry.secrets)],
    sensitivityRefs: entries.map((entry) => entry.ref).sort(),
  });
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly observation = new AsyncLocalStorage<{
    reads: Map<string, { digest: string; read: () => unknown }>;
    count: number;
    maxRecords: number;
    active: boolean;
    failure?: OrcaError;
  }>();
  async observe<T>(
    work: () => Promise<T>,
    limits: { maxRecords: number },
  ): Promise<{ value: T; verifyUnchanged(): Promise<void> }> {
    if (this.observation.getStore()) throw unavailable();
    if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 0) throw observationLimit();
    const scope: NonNullable<ReturnType<typeof this.observation.getStore>> = {
      reads: new Map(),
      count: 0,
      maxRecords: limits.maxRecords,
      active: true,
    };
    let value: T;
    try {
      value = await this.observation.run(scope, work);
      if (scope.failure) throw scope.failure;
    } finally {
      scope.active = false;
    }
    const reads = [...scope.reads.values()];
    return {
      value,
      async verifyUnchanged() {
        try {
          for (const { digest, read } of reads) if (memoryDigest(read()) !== digest) throw unavailable();
        } catch {
          throw unavailable();
        }
      },
    };
  }
  private observeRead(id: string, read: () => unknown, count = 1): void {
    const scope = this.observation.getStore();
    if (!scope) return;
    if (!scope.active || scope.failure) throw scope.failure ?? unavailable();
    const previous = scope.reads.get(id);
    if (!previous && count > scope.maxRecords - scope.count) {
      scope.failure = observationLimit();
      throw scope.failure;
    }
    const digest = memoryDigest(read());
    if (previous && previous.digest !== digest) {
      scope.failure = unavailable();
      throw scope.failure;
    }
    if (!previous) {
      scope.count += count;
      scope.reads.set(id, { digest, read });
    }
  }
  private assertWritable(): void {
    const scope = this.observation.getStore();
    if (scope) {
      scope.failure = unavailable();
      throw scope.failure;
    }
  }
  private readonly generations = new Map<string, unknown>();
  async getGeneration(id: string): Promise<unknown> {
    this.observeRead(`generation:${id}`, () => this.generations.get(id));
    return structuredClone(this.generations.get(id));
  }
  async putGeneration(id: string, snapshot: unknown): Promise<void> {
    this.assertWritable();
    if (this.generations.has(id)) throw unavailable();
    this.generations.set(id, structuredClone(snapshot));
  }
  private readonly inputs = new Map<string, ExecutionInputs>();
  private readonly sensitivity = new Map<string, z.infer<typeof OverlaySchema>>();
  private readonly payloads = new Map<string, { input: OrcaEventInput; sensitivityRefs: string[] }>();
  async getInputs(runId: string): Promise<ExecutionInputs | undefined> {
    const base = this.inputs.get(runId);
    const overlays = [...this.sensitivity.values()].filter((value) => value.runId === runId);
    this.observeRead(`inputs:${runId}`, () => this.inputs.get(runId));
    this.observeRead(
      `sensitivity:${runId}`,
      () => [...this.sensitivity.values()].filter((value) => value.runId === runId),
      1 + overlays.length,
    );
    if (!base) {
      if (overlays.length) throw unavailable();
      return undefined;
    }
    return mergeSensitivity(base, overlays);
  }
  async putInputs(inputs: ExecutionInputs): Promise<void> {
    this.assertWritable();
    if (this.inputs.has(inputs.runId)) throw unavailable();
    this.inputs.set(inputs.runId, structuredClone(inputs));
  }
  async addSensitivity(runId: string, sensitivity: ExecutionSensitivity): Promise<void> {
    this.assertWritable();
    if (!this.inputs.has(runId)) throw unavailable();
    const ref = randomUUID();
    this.sensitivity.set(ref, structuredClone({ ...sensitivity, runId, ref }));
  }
  async putPayload(ref: string, input: OrcaEventInput): Promise<void> {
    this.assertWritable();
    if (this.payloads.has(ref)) throw unavailable();
    const inputs = await this.getInputs(input.runId);
    if (!inputs) throw unavailable();
    this.payloads.set(ref, structuredClone({ input, sensitivityRefs: inputs.sensitivityRefs ?? [] }));
  }
  async getPayload(runId: string, ref: string, type: string): Promise<OrcaEventInput["payload"]> {
    const value = this.payloads.get(ref);
    this.observeRead(`payload:${ref}`, () => this.payloads.get(ref));
    if (this.observation.getStore()) await this.getInputs(runId);
    if (!value || value.input.runId !== runId || value.input.type !== type || !this.inputs.has(runId))
      throw unavailable();
    for (const expected of value.sensitivityRefs)
      if (this.sensitivity.get(expected)?.runId !== runId) throw unavailable();
    return structuredClone(value.input.payload);
  }
}

export class FileExecutionStore implements ExecutionStore {
  private readonly dir: string;
  constructor(storeDir: string) {
    this.dir = join(storeDir, "private-execution");
  }
  async observe<T>(
    work: () => Promise<T>,
    limits: { maxRecords: number },
  ): Promise<{ value: T; verifyUnchanged(): Promise<void> }> {
    return observePrivateReads(work, limits);
  }
  async getGeneration(id: string): Promise<unknown> {
    return readPrivateJson(this.dir, `${encodeURIComponent(id)}.generation.json`);
  }
  async putGeneration(id: string, snapshot: unknown): Promise<void> {
    if (!(await writePrivateJson(this.dir, `${encodeURIComponent(id)}.generation.json`, snapshot))) throw unavailable();
  }
  private async overlays(runId: string): Promise<z.infer<typeof OverlaySchema>[]> {
    const prefix = `${encodeURIComponent(runId)}.sensitivity.`;
    const names = await privateJsonNames(this.dir, prefix);
    return Promise.all(
      names.map(async (name) => {
        const result = OverlaySchema.safeParse(await readPrivateJson(this.dir, name));
        if (
          !result.success ||
          result.data.runId !== runId ||
          name !== `${prefix}${encodeURIComponent(result.data.ref)}.json`
        )
          throw unavailable();
        return result.data;
      }),
    );
  }
  async getInputs(runId: string): Promise<ExecutionInputs | undefined> {
    const value = await readPrivateJson(this.dir, `${encodeURIComponent(runId)}.inputs.json`);
    const overlays = await this.overlays(runId);
    if (value === undefined) {
      if (overlays.length) throw unavailable();
      return undefined;
    }
    const result = ExecutionInputsSchema.safeParse(value);
    if (!result.success || result.data.runId !== runId) throw unavailable();
    return mergeSensitivity(result.data, overlays);
  }
  async putInputs(inputs: ExecutionInputs): Promise<void> {
    if (!(await writePrivateJson(this.dir, `${encodeURIComponent(inputs.runId)}.inputs.json`, inputs)))
      throw unavailable();
  }
  async addSensitivity(runId: string, sensitivity: ExecutionSensitivity): Promise<void> {
    if (!(await this.getInputs(runId))) throw unavailable();
    const ref = randomUUID();
    if (
      !(await writePrivateJson(this.dir, `${encodeURIComponent(runId)}.sensitivity.${ref}.json`, {
        ...sensitivity,
        runId,
        ref,
      }))
    )
      throw unavailable();
  }
  async putPayload(ref: string, input: OrcaEventInput): Promise<void> {
    const inputs = await this.getInputs(input.runId);
    if (!inputs) throw unavailable();
    if (
      !(await writePrivateJson(this.dir, `${encodeURIComponent(ref)}.payload.json`, {
        ...input,
        sensitivityRefs: inputs.sensitivityRefs ?? [],
      }))
    )
      throw unavailable();
  }
  async getPayload(runId: string, ref: string, type: string): Promise<OrcaEventInput["payload"]> {
    return (await this.getPayloads([{ runId, ref, type }]))[0]!;
  }
  async getPayloads(references: readonly ExecutionPayloadReference[]): Promise<OrcaEventInput["payload"][]> {
    // Snapshot caller-owned references before any I/O. Only multi-record replay shares
    // an entry key; empty and single-record reads keep their existing fresh-read path.
    const requested = references.map(({ runId, ref, type }) => ({ runId, ref, type }));
    const names = requested.map(({ ref }) => `${encodeURIComponent(ref)}.payload.json`);
    const validate = async (values: unknown[]): Promise<OrcaEventInput["payload"][]> => {
      const records = values.map((value, index) => {
        const { runId, type } = requested[index]!;
        const result = PayloadSchema.safeParse(value);
        if (!result.success || result.data.runId !== runId || result.data.type !== type) throw unavailable();
        return result.data;
      });
      // Read after the payloads, so an overlay removed while replay is being loaded cannot
      // be vouched for by an earlier input snapshot. This state lives only for this call.
      const inputs = new Map(
        await Promise.all(
          [...new Set(records.map((record) => record.runId))].map(async (runId) => {
            const value = await this.getInputs(runId);
            if (!value) throw unavailable();
            return [runId, value] as const;
          }),
        ),
      );
      return records.map((record) => {
        const current = inputs.get(record.runId)!;
        if (record.sensitivityRefs.some((expected) => !current.sensitivityRefs?.includes(expected)))
          throw unavailable();
        return record.payload;
      });
    };
    if (requested.length > 1) return readPrivateJsonBatch(this.dir, names, validate);
    return validatePrivateJson(() => Promise.all(names.map((name) => readPrivateJson(this.dir, name))), validate);
  }
}

export const unavailable = protectedRecordInvalid;
const observationLimit = () => new OrcaError("RUN_STATE", "protected execution observation exceeds record limit");
const memoryDigest = (value: unknown): string =>
  createHash("sha256")
    .update(serialize(structuredClone(value)))
    .digest("hex");

/** Whole fields are hidden when any nested declaration is sensitive; siblings are not a secret-value oracle. */
export function publicInputVars(inputs: ExecutionInputs): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(inputs.vars).map(([name, value]) => [
      inputs.sensitiveNames.includes(name) ? name : redactExecutionValue(name, inputs.secrets),
      inputs.sensitiveNames.includes(name) ? "[REDACTED]" : redactExecutionValue(value, inputs.secrets, true),
    ]),
  );
}

/**
 * Defense in depth for known literals copied into messages, agent updates and nested diagnostics.
 * This is not general taint tracking: encoding, transformations and fragments are not detected.
 */
export function redactExecutionValue<T>(value: T, secrets: readonly unknown[], redactKeys = false): T {
  const strings = new Set<string>();
  const numbers = new Set<number>();
  const booleans = new Set<boolean>();
  const gather = (item: unknown): void => {
    if (typeof item === "string" && item.length) strings.add(item);
    else if (typeof item === "number") {
      numbers.add(item);
      strings.add(String(item));
    } else if (typeof item === "boolean") {
      booleans.add(item);
      strings.add(String(item));
    } else if (Array.isArray(item)) item.forEach(gather);
    else if (item && typeof item === "object")
      for (const [key, nested] of Object.entries(item)) {
        strings.add(key);
        gather(nested);
      }
  };
  secrets.forEach(gather);
  const needles = [...strings].sort((a, b) => b.length - a.length);
  const pattern = needles.length
    ? new RegExp(needles.map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : undefined;
  const text = (input: string) => (pattern ? input.replace(pattern, "[REDACTED]") : input);
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return text(input);
    if (typeof input === "number" && numbers.has(input)) return "[REDACTED]";
    if (typeof input === "boolean" && booleans.has(input)) return "[REDACTED]";
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, nested]) => [redactKeys ? text(key) : key, visit(nested)]),
      );
    return input;
  };
  return visit(value) as T;
}
