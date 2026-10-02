/** Shared registered-operation retry facility. No callback or operation name is accepted from the wire. */
import { isDeepStrictEqual } from "node:util";
import { OrcaError, isOrcaError } from "@orca/core";
import type {
  JsonValue,
  RetryAuthority,
  RetryClaims,
  RetryClaimStore,
  RetryContext,
  RetryFaults,
  RetryOperation,
  RetryOperationKind,
  RetryOptions,
  RetryRecord,
  RetryResult,
  RetrySafeAdmissions,
} from "../../core/src/model/admission-retry.js";

const unavailable = () => new OrcaError("RUN_STATE", "Retry operation is unavailable");

/** Exact JSON comparison: no coercion, Unicode rewriting, moving defaults or array sorting. */
export function canonicalJson(value: unknown, bounded = true): string {
  const active = new Set<object>();
  let bytes = 0;
  const account = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bounded && bytes > 256 * 1024) throw new OrcaError("WORKFLOW_INPUT_INVALID", "Retry command exceeds 256 KiB");
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (bounded && depth > 32) throw new OrcaError("WORKFLOW_INPUT_INVALID", "Retry command exceeds depth 32");
    if (
      item === null ||
      typeof item === "boolean" ||
      typeof item === "string" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return account(JSON.stringify(item));
    if (typeof item !== "object" || !item || active.has(item))
      throw new OrcaError("WORKFLOW_INPUT_INVALID", "Retry command must be JSON");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new OrcaError("WORKFLOW_INPUT_INVALID", "Retry command must be JSON");
    if (
      Object.getOwnPropertySymbols(item).length ||
      Object.values(Object.getOwnPropertyDescriptors(item)).some((d) => "get" in d || "set" in d)
    )
      throw new OrcaError("WORKFLOW_INPUT_INVALID", "Retry command must be JSON");
    active.add(item);
    let text: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length)
        throw new OrcaError("WORKFLOW_INPUT_INVALID", "Retry arrays must be dense JSON arrays");
      text = account("[") + item.map((v) => visit(v, depth + 1)).join(",") + account("]");
      bytes += Math.max(0, item.length - 1);
    } else {
      const object = item as Record<string, unknown>;
      const keys = Object.keys(object).sort();
      text =
        account("{") +
        keys.map((key) => account(JSON.stringify(key) + ":") + visit(object[key], depth + 1)).join(",") +
        account("}");
      bytes += Math.max(0, keys.length - 1);
    }
    active.delete(item);
    if (bounded && bytes > 256 * 1024) throw new OrcaError("WORKFLOW_INPUT_INVALID", "Retry command exceeds 256 KiB");
    return text;
  };
  return visit(value, 0);
}

interface Registered {
  instance: object;
  authorize?(command: unknown, binding: Record<string, JsonValue> | undefined): Promise<void>;
  verifyAccepted?(
    command: unknown,
    binding: Record<string, JsonValue> | undefined,
    result: unknown,
    operationId: string,
  ): Promise<void>;
  canonicalize(command: unknown): JsonValue;
  validateFresh?(command: unknown): Promise<void>;
  prepare(command: unknown, context: RetryContext): Promise<unknown>;
  recover(command: unknown, context: RetryContext): Promise<unknown>;
}
export class RegisteredRetryClaims implements RetryClaims {
  private readonly operations = new Map<RetryOperationKind, Registered>();
  constructor(
    private readonly store: RetryClaimStore,
    private readonly faults: RetryFaults,
  ) {}

  register<C, R>(
    operation: RetryOperation<C, R>,
    authorize?: (command: C, binding: Record<string, JsonValue> | undefined) => Promise<void>,
    verifyAccepted?: (
      command: C,
      binding: Record<string, JsonValue> | undefined,
      result: unknown,
      operationId: string,
    ) => Promise<void>,
  ): RetryOperation<C, R> {
    if (this.operations.has(operation.kind))
      throw new OrcaError("CONFIG_INVALID", "Retry operation is already registered");
    const instance = Object.freeze(operation);
    const canonicalize = instance.canonicalize.bind(instance);
    const validateFresh = instance.validateFresh?.bind(instance);
    const prepare = instance.prepare.bind(instance);
    const recover = instance.recover.bind(instance);
    this.operations.set(instance.kind, {
      instance,
      ...(authorize
        ? {
            authorize: (command: unknown, binding: Record<string, JsonValue> | undefined) =>
              authorize(command as C, binding),
          }
        : {}),
      ...(verifyAccepted
        ? {
            verifyAccepted: (
              command: unknown,
              binding: Record<string, JsonValue> | undefined,
              result: unknown,
              operationId: string,
            ) => verifyAccepted(command as C, binding, result, operationId),
          }
        : {}),
      canonicalize: (command) => canonicalize(command as C),
      ...(validateFresh ? { validateFresh: (command: unknown) => validateFresh(command as C) } : {}),
      prepare: (command, context) => prepare(command as C, context),
      recover: (command, context) => recover(command as C, context),
    });
    return instance;
  }

  async execute<C, R>(
    operation: RetryOperation<C, R>,
    command: C,
    retry: RetryOptions,
    authority: RetryAuthority<C>,
  ): Promise<RetryResult<R>> {
    const registered = this.operations.get(operation.kind);
    if (registered?.instance !== operation) throw unavailable();
    await authority.authorize(command);
    const key = retry.idempotencyKey;
    if (key !== undefined && (typeof key !== "string" || Buffer.byteLength(key) < 1 || Buffer.byteLength(key) > 128))
      throw new OrcaError("WORKFLOW_INPUT_INVALID", "Retry key must contain 1–128 UTF-8 bytes");
    // Bound raw JSON traversal before an operation's schema/default normalization. Optional
    // top-level TS fields may be absent; nested undefined is never valid JSON intent.
    if (key !== undefined && command && typeof command === "object" && !Array.isArray(command))
      canonicalJson(Object.fromEntries(Object.entries(command).filter(([, value]) => value !== undefined)));
    // Snapshot validated caller intent before any asynchronous work can mutate it.
    const canonical = canonicalJson(registered.canonicalize(command), key !== undefined);
    const normalized = JSON.parse(canonical) as JsonValue;
    if (
      key !== undefined &&
      (operation.kind === "revision.submit" || operation.kind === "revision.replace") &&
      normalized &&
      typeof normalized === "object" &&
      !Array.isArray(normalized) &&
      normalized.payload !== undefined &&
      Buffer.byteLength(canonicalJson(normalized.payload)) > 64 * 1024
    )
      throw new OrcaError("WORKFLOW_INPUT_INVALID", "Revision payload exceeds 64 KiB");
    const scopedAuthority: RetryAuthority<unknown> = {
      ...authority,
      authorize: (value) => authority.authorize(value as C),
    };
    const validateFresh = registered.validateFresh?.bind(registered);
    const { record, fresh } = await this.store.claim(
      { principalId: authority.principalId, workspaceId: authority.workspaceId, kind: operation.kind },
      key,
      normalized,
      canonical,
      validateFresh
        ? async () => {
            // Waiting for the catalog lock or validation must not preserve revoked
            // authority. Every callback receives a copy of the sealed intent.
            const check = async () => {
              await scopedAuthority.authorize(structuredClone(normalized));
              await registered.authorize?.(structuredClone(normalized), undefined);
            };
            await check();
            await validateFresh(structuredClone(normalized));
            await check();
          }
        : undefined,
    );
    await scopedAuthority.authorize(record.command);
    await registered.authorize?.(record.command, record.binding);
    if (record.canonical !== canonical) throw this.faults.conflict();
    return this.run(record, registered, scopedAuthority, fresh, false) as Promise<RetryResult<R>>;
  }

  async operationKind(
    operationId: string,
    scope: { principalId: string; workspaceId: string },
  ): Promise<RetryOperationKind> {
    const record = await this.store.read(operationId);
    if (
      !record ||
      record.principalId !== scope.principalId ||
      record.workspaceId !== scope.workspaceId ||
      !this.operations.has(record.kind)
    )
      throw unavailable();
    return record.kind;
  }

  /** Trusted dispatcher chooses authority by the sealed kind; IDs never select callbacks. */
  async inspect(operationId: string, authority: RetryAuthority<unknown>): Promise<RetryResult<unknown>> {
    const record = await this.owned(operationId, authority);
    if (record.phase !== "accepted") return this.pending(operationId);
    await this.operations
      .get(record.kind)!
      .verifyAccepted?.(record.command, record.binding, record.result, operationId);
    return { state: "resolved", operationId, replayed: true, result: structuredClone(record.result) };
  }
  async reconcile(operationId: string, authority: RetryAuthority<unknown>): Promise<RetryResult<unknown>> {
    const record = await this.owned(operationId, authority);
    const registered = this.operations.get(record.kind);
    if (!registered) throw unavailable();
    return this.run(record, registered, authority, false, true);
  }
  private async owned(operationId: string, authority: RetryAuthority<unknown>): Promise<RetryRecord> {
    // Adapter checks operation grants before lookup; an unowned/missing ID has one refusal.
    const record = await this.store.read(operationId);
    if (
      !record ||
      record.principalId !== authority.principalId ||
      record.workspaceId !== authority.workspaceId ||
      !this.operations.has(record.kind)
    )
      throw unavailable();
    await authority.authorize(record.command);
    await this.operations.get(record.kind)!.authorize?.(record.command, record.binding);
    return record;
  }
  private pending(operationId: string): RetryResult<never> {
    return { state: "in-progress", operationId, recovery: "inspect-or-retry" };
  }
  private async run(
    initial: RetryRecord,
    operation: Registered,
    authority: RetryAuthority<unknown>,
    fresh: boolean,
    reconcile: boolean,
  ): Promise<RetryResult<unknown>> {
    let entered = false;
    try {
      return await this.store.lock(initial.operationId, async () => {
        entered = true;
        let record = await this.owned(initial.operationId, authority);
        // A cached receipt is only a projection. Some operations must recheck their
        // authoritative marker, including before an explicit recovery can run.
        if (record.phase === "accepted")
          await operation.verifyAccepted?.(record.command, record.binding, record.result, record.operationId);
        if (record.phase === "accepted" && !reconcile)
          return {
            state: "resolved",
            operationId: record.operationId,
            replayed: true,
            result: structuredClone(record.result),
          };
        // A crash before binding has no safe target to recover. Never recapture moving defaults.
        if (!fresh && !record.binding) return this.pending(record.operationId);
        let active = true;
        let writes: Promise<void> = Promise.resolve();
        const check = async () => {
          if (!active) throw unavailable();
          await authority.authorize(record.command);
          if (!active) throw unavailable();
        };
        const context: RetryContext = {
          operationId: record.operationId,
          reauthorize: check,
          readBinding: async () => {
            await writes;
            await check();
            return structuredClone(record.binding);
          },
          bind: (binding) => {
            const snapshot = JSON.parse(canonicalJson(binding)) as Record<string, JsonValue>;
            const write = writes.then(async () => {
              await check();
              if (record.binding) {
                if (!isDeepStrictEqual(record.binding, snapshot)) throw this.faults.conflict();
                return;
              }
              record = { ...record, binding: snapshot, phase: "bound" };
              await this.store.write(record);
            });
            // Drain mutations before releasing the lock even if a registered implementation
            // forgets to await one. A rejected CAS does not poison later identical reads.
            writes = write.catch(() => undefined);
            return write;
          },
        };
        try {
          const result = await (fresh
            ? operation.prepare(record.command, context)
            : operation.recover(record.command, context));
          await writes;
          await check();
          if (!record.binding)
            throw new OrcaError("RUN_STATE", "Retry operation did not bind its admission before returning");
          const json = JSON.parse(canonicalJson(result)) as JsonValue;
          record = { ...record, phase: "accepted", result: json };
          await this.store.write(record);
          return {
            state: "resolved",
            operationId: record.operationId,
            replayed: !fresh,
            result: structuredClone(json),
          };
        } finally {
          active = false;
          await writes;
        }
      });
    } catch (error) {
      if (!entered && isOrcaError(error, "STORE_LOCK_TIMEOUT")) return this.pending(initial.operationId);
      throw error;
    }
  }
}

/** Frozen admission consumer interface, composed once from the two registered services. */
export class RetrySafeAdmissionService implements RetrySafeAdmissions {
  constructor(
    private readonly services: {
      requests: Pick<import("./program/request-submission.js").RequestSubmissionService, "submitRetry">;
      direct: Pick<import("./direct-admission.js").DirectAdmissionService, "admitRun">;
    },
  ) {}
  submit(
    command: import("@orca/core").SubmissionCommand,
    retry: RetryOptions,
    authority: import("@orca/core").SubmissionAuthority,
  ) {
    return this.services.requests.submitRetry(command, retry, authority);
  }
  admitRun(
    command: import("../../core/src/model/admission-retry.js").DirectAdmissionCommand,
    retry: RetryOptions,
    authority: import("../../core/src/model/admission-retry.js").DirectAdmissionAuthority,
  ) {
    return this.services.direct.admitRun(command, retry, authority);
  }
}
