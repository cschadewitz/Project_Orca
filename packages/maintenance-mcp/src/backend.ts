/** Bounded independent observations, safe projections and a content-free in-memory audit ring. */
import { randomUUID } from "node:crypto";
import {
  HostObservation,
  INPUTS,
  LogBatch,
  LogRecord,
  ServiceObservation,
  type LogsInput,
  type SafeLogRecord,
} from "./contracts.js";
import { BUILD, LIMITS, OPERATIONS, POLICY, POLICY_ID, type Operation } from "./policy.js";
import { unavailableAdapter, type ObservationAdapter, type ReadRequest } from "./adapter.js";
import { SourceError } from "./observer-io.js";

type Failure = "not_configured" | "busy" | "timeout" | "source_failed" | "oversized_source" | "invalid_source";
type ReadResult = { ok: true; value: unknown } | { ok: false; reason: Failure };
type AuditOutcome = "ok" | "stale" | "unavailable" | "not_supervised" | "invalid_input" | "unsupported";
export interface AuditEntry {
  operation: Operation | "unknown";
  outcome: AuditOutcome;
  responseAt: string;
}
export class ContractError extends Error {
  constructor(readonly code: "invalid_input" | "unsupported") {
    super(code);
  }
}

export class MaintenanceBackend {
  readonly instanceId = randomUUID();
  private inFlight = 0;
  private readonly audit: AuditEntry[] = [];
  constructor(private readonly adapter: ObservationAdapter = unavailableAdapter) {}

  /** Local diagnostic API only; never an MCP raw-log/export tool. Returns a detached bounded copy. */
  auditSnapshot(): readonly AuditEntry[] {
    return this.audit.map((entry) => ({ ...entry }));
  }

  async call(name: string, raw: unknown): Promise<Record<string, unknown>> {
    const operation = OPERATIONS.find((item) => item === name);
    if (!operation) {
      this.record("unknown", "unsupported");
      throw new ContractError("unsupported");
    }
    // Wire transport bounds allocations before parsing; this guard also bounds direct API callers.
    let input: unknown;
    try {
      if (Buffer.byteLength(JSON.stringify(raw) ?? "") > LIMITS.requestBytes) throw new Error();
      input = INPUTS[operation].parse(raw);
    } catch {
      this.record(operation, "invalid_input");
      throw new ContractError("invalid_input");
    }
    if (operation === "maintenance_discover") {
      this.record(operation, "ok");
      return {
        responseAt: new Date().toISOString(),
        build: BUILD,
        policyId: POLICY_ID,
        policy: POLICY,
        bridgeInstanceId: this.instanceId,
        hostBootIdentity: { status: "unavailable", bootId: null, reason: "not_configured" },
        callerIdentity: { kind: "local_stdio_unverified", verifiedHuman: false },
        readiness: "contract_ready",
        productionSources: this.adapter.sourceMode ?? "unavailable",
        transport: "stdio",
        cursors: false,
        mutations: false,
      };
    }
    const parsed = input as { host: "agent-01"; service?: LogsInput["service"] };
    const request: ReadRequest =
      operation === "get_host_health"
        ? { kind: "host", host: "agent-01", mount: "root" }
        : operation === "get_service_health"
          ? { kind: "service", host: "agent-01", service: parsed.service! }
          : { kind: "logs", host: "agent-01", service: parsed.service!, windowSeconds: LIMITS.logWindowSeconds };
    // Foreground ORCA has no approved supervisor identity. Never inspect or infer its PID.
    if (request.kind === "service" && request.service === "orca-daemon") {
      return this.finish(operation, request, "not_supervised", null, { reason: "not_configured" });
    }
    const read = await this.read(request);
    if (!read.ok) return this.finish(operation, request, "unavailable", null, { reason: read.reason });
    if (request.kind === "logs") return this.logs(operation, request, input as LogsInput, read.value);
    const safe = (request.kind === "host" ? HostObservation : ServiceObservation).safeParse(read.value);
    if (!safe.success) return this.finish(operation, request, "unavailable", null, { reason: "invalid_source" });
    const age = Date.now() - Date.parse(safe.data.observedAt);
    if (age < 0) return this.finish(operation, request, "unavailable", null, { reason: "invalid_source" });
    return this.finish(operation, request, age > LIMITS.staleAfterMs ? "stale" : "ok", safe.data.observedAt, {
      observation: safe.data,
    });
  }

  private logs(operation: Operation, request: ReadRequest, input: LogsInput, raw: unknown) {
    const batch = LogBatch.safeParse(raw);
    if (!batch.success || Date.parse(batch.data.observedAt) > Date.now())
      return this.finish(operation, request, "unavailable", null, { reason: "invalid_source" });
    let omittedRecords = 0;
    let recordsWithOmittedFields = 0;
    let filteredRecords = 0;
    const entries: SafeLogRecord[] = [];
    for (const rawRecord of batch.data.records) {
      const safe = LogRecord.safeParse(rawRecord);
      if (!safe.success) {
        omittedRecords++;
        continue;
      }
      if (Object.keys(rawRecord as object).some((key) => !Object.hasOwn(safe.data, key))) recordsWithOmittedFields++;
      const time = Date.parse(safe.data.observedAt);
      const age = Date.parse(batch.data.observedAt) - time;
      if (
        age < 0 ||
        age > LIMITS.logWindowSeconds * 1000 ||
        (input.category && input.category !== safe.data.category)
      ) {
        filteredRecords++;
        continue;
      }
      entries.push(safe.data);
    }
    entries.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const truncated = batch.data.truncated || entries.length > input.limit;
    return this.finish(
      operation,
      request,
      Date.now() - Date.parse(batch.data.observedAt) > LIMITS.staleAfterMs ? "stale" : "ok",
      batch.data.observedAt,
      {
        entries: entries.slice(-input.limit),
        omittedRecords,
        recordsWithOmittedFields,
        filteredRecords,
        truncated,
        windowSeconds: LIMITS.logWindowSeconds,
      },
    );
  }

  private async read(request: ReadRequest): Promise<ReadResult> {
    if (this.inFlight >= LIMITS.concurrentReads) return { ok: false, reason: "busy" };
    this.inFlight++;
    const controller = new AbortController();
    // Keep the slot until the SOURCE settles, even after timeout. An adapter ignoring abort
    // can exhaust two slots, but repeated callers cannot create unlimited orphan reads.
    const work: Promise<ReadResult> = Promise.resolve().then(async () => {
      try {
        const bytes = await this.adapter.read(request, {
          signal: controller.signal,
          maxBytes: LIMITS.sourceBytes,
          maxRecords: LIMITS.sourceRecords,
          deadlineMs: LIMITS.deadlineMs,
        });
        if (bytes === null) return { ok: false, reason: "not_configured" };
        if (!(bytes instanceof Uint8Array)) return { ok: false, reason: "invalid_source" };
        if (bytes.byteLength > LIMITS.sourceBytes) return { ok: false, reason: "oversized_source" };
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          return { ok: true, value };
        } catch {
          return { ok: false, reason: "invalid_source" };
        }
      } catch (error) {
        return { ok: false, reason: error instanceof SourceError ? error.reason : "source_failed" };
      } finally {
        this.inFlight--;
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ReadResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "timeout" });
      }, LIMITS.deadlineMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private finish(
    operation: Operation,
    request: ReadRequest,
    status: AuditOutcome,
    observedAt: string | null,
    fields: Record<string, unknown>,
  ) {
    this.record(operation, status);
    return {
      host: "agent-01",
      ...(request.kind !== "host" ? { service: request.service } : { mount: "root" }),
      bridgeInstanceId: this.instanceId,
      policyId: POLICY_ID,
      responseAt: new Date().toISOString(),
      observedAt,
      status,
      ...fields,
    };
  }
  private record(operation: AuditEntry["operation"], outcome: AuditOutcome) {
    this.audit.push({ operation, outcome, responseAt: new Date().toISOString() });
    if (this.audit.length > LIMITS.auditEntries) this.audit.shift();
  }
}
