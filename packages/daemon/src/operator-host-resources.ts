/** Explicitly mounted, bounded telemetry projection; never constructs a collector or scans runs. */
import { performance } from "node:perf_hooks";
import { OrcaError } from "@orca/core";
import {
  HOST_RESOURCE_LIMITS,
  HostResourceSnapshotSchema,
  OperatorHostResourcesParamsSchema,
  ProtocolFault,
  WorkstreamSummarySchema,
  OperatorHostResourcesResultSchema,
  acceptResourceSnapshot,
  type HostResourceSnapshot,
  type OperatorTarget,
  type WorkstreamSummary,
} from "@orca/protocol";
import { authForbidden, authRequired } from "./auth/errors.js";
import { holds, type Principal } from "./auth/principal.js";

export interface AuthorizedWorkstreamProjection {
  /** Only authorized IDs; enumeration cost/completeness must not depend on hidden work. */
  runIds: readonly string[];
  /** #495 summary over exactly these IDs, including parked work, encoded as bounded JSON. */
  read(this: void, signal: AbortSignal): Promise<string>;
  /** Verify the index/lineage/coverage revision without a fallback scan. */
  current(this: void, signal: AbortSignal): Promise<boolean>;
}

export interface HostResourceReadSource {
  /** Bounded JSON from #495. No caller host/path/refresh selectors or background work. */
  snapshot(this: void, signal: AbortSignal): Promise<string>;
  /** Trusted authorized index + shared summary seam; absent until that integration exists. */
  workstreams?(this: void, principal: Principal, signal: AbortSignal): Promise<AuthorizedWorkstreamProjection>;
}

export interface HostResourceReadAccess {
  /** Synchronous current check of the original verified credential; never a process owner. */
  current(): Principal;
  allowsRun(principal: Principal, runId: string): Promise<boolean>;
}

const invalid = () => new ProtocolFault("PROTOCOL_MESSAGE", "Invalid or oversized resource observation");
const changed = () => new OrcaError("RUN_STATE", "Resource target or observation changed; discover again");
const unavailable = () => new OrcaError("NOT_SUPPORTED", "Resource observation is unavailable; retry later");
const signature = (p: Principal) => JSON.stringify([p.id, p.credentialId, p.scope, [...p.permissions].sort()]);

/** Bound bytes before parsing; providers must also bound allocation before producing the string. */
function decode(raw: unknown): unknown {
  if (
    typeof raw !== "string" ||
    raw.length > HOST_RESOURCE_LIMITS.snapshotBytes ||
    Buffer.byteLength(raw) > HOST_RESOURCE_LIMITS.snapshotBytes
  )
    throw invalid();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalid();
  }
}

/** One instance per daemon mount; deadlines retain unresolved source slots. No result cache. */
export class HostResourceReadModel {
  private busy = false;
  private lastStart = -Infinity;
  private previous: HostResourceSnapshot | undefined;

  constructor(
    private readonly target: OperatorTarget,
    private readonly source: HostResourceReadSource,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async read(raw: unknown, access: HostResourceReadAccess): Promise<HostResourceSnapshot> {
    const principal = access.current();
    if (principal.kind !== "credential" || !principal.credentialId) throw authRequired();
    if (!holds(principal, "host.telemetry.read")) throw authForbidden();
    const original = signature(principal);
    const check = () => {
      const latest = access.current();
      if (latest.kind !== "credential" || signature(latest) !== original || !holds(latest, "host.telemetry.read"))
        throw authForbidden();
      return latest;
    };
    const parsed = OperatorHostResourcesParamsSchema.safeParse(raw);
    if (!parsed.success) throw new ProtocolFault("PROTOCOL_MESSAGE", "Invalid resource read parameters");
    if (
      parsed.data.target.workspaceId !== this.target.workspaceId ||
      parsed.data.target.instanceId !== this.target.instanceId
    )
      throw changed();
    const started = this.now();
    if (!Number.isFinite(started) || this.busy || started - this.lastStart < HOST_RESOURCE_LIMITS.refreshMs)
      throw unavailable();
    this.busy = true;
    this.lastStart = started;
    const abort = new AbortController();
    // Check after successful and failed awaits; do not leak a provider's diagnostic text.
    const readSource = async <T>(read: () => Promise<T>): Promise<T> => {
      check();
      if (abort.signal.aborted) throw unavailable();
      let value: T;
      try {
        value = await read();
      } catch {
        check();
        throw unavailable();
      }
      check();
      if (abort.signal.aborted) throw unavailable();
      return value;
    };
    const checkRuns = async (runIds: readonly string[]) => {
      for (const id of runIds) {
        if (!(await readSource(() => access.allowsRun(check(), id)))) throw authForbidden();
      }
      check();
    };
    const operation = (async () => {
      try {
        const host = HostResourceSnapshotSchema.safeParse(
          decode(await readSource(() => this.source.snapshot(abort.signal))),
        );
        if (!host.success) throw invalid();
        const snapshot = host.data;
        if (snapshot.daemonInstanceId !== this.target.instanceId) throw changed();
        if (
          !acceptResourceSnapshot(this.previous, snapshot, {
            expectedDaemonInstanceId: this.target.instanceId,
            requestGeneration: 0,
            currentGeneration: 0,
          })
        )
          throw changed();
        // Never publish a collector's aggregate counts under a host-only permission.
        let summary: WorkstreamSummary = {
          status: "permission-denied",
          source: "runtime-ownership",
          reason: "not-authorized",
        };
        let projection: AuthorizedWorkstreamProjection | undefined;
        let runIds: readonly string[] = [];
        if (holds(check(), "runs.read")) {
          summary = { status: "unavailable", source: "runtime-ownership", reason: "scope-unverified" };
          if (this.source.workstreams) {
            projection = await readSource(() => this.source.workstreams!(check(), abort.signal));
            if (
              !Array.isArray(projection?.runIds) ||
              projection.runIds.length > HOST_RESOURCE_LIMITS.workstreamRecords ||
              projection.runIds.some((id) => typeof id !== "string" || !id.length || id.length > 256) ||
              new Set(projection.runIds).size !== projection.runIds.length
            )
              throw invalid();
            runIds = [...projection.runIds];
            await checkRuns(runIds);
            const result = WorkstreamSummarySchema.safeParse(
              decode(await readSource(() => projection!.read(abort.signal))),
            );
            if (!result.success || result.data.source !== "runtime-ownership") throw invalid();
            summary = result.data;
            if ("value" in summary) {
              const counts = summary.value;
              if (
                counts.scope !== "caller-visible" ||
                counts.activeRoots > runIds.length ||
                counts.executingRuns + counts.waitingRuns + counts.blockedRuns + counts.uncertainRuns > runIds.length
              )
                throw invalid();
            }
          }
        }
        const result = OperatorHostResourcesResultSchema.safeParse({ ...snapshot, workstreams: summary });
        if (!result.success || Buffer.byteLength(JSON.stringify(result.data)) > HOST_RESOURCE_LIMITS.snapshotBytes)
          throw invalid();
        if (projection) {
          if (!(await readSource(() => projection.current(abort.signal)))) throw changed();
          await checkRuns(runIds);
        }
        check();
        // Retain only host ordering/provenance evidence, never another caller's summary.
        this.previous = {
          ...snapshot,
          workstreams: { status: "permission-denied", source: "runtime-ownership", reason: "not-authorized" },
        };
        return result.data;
      } finally {
        this.busy = false;
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(unavailable());
      }, HOST_RESOURCE_LIMITS.collectionTimeoutMs);
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clearTimeout(timer);
      check();
    }
  }
}
