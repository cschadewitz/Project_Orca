/** Explicitly mounted, bounded telemetry projection; never constructs a collector or scans runs. */
import { performance } from "node:perf_hooks";
import { OrcaError, describeError } from "@orca/core";
import {
  HOST_RESOURCE_LIMITS,
  HostResourceSnapshotSchema,
  OperatorHostResourcesParamsSchema,
  ProtocolFault,
  isProtocolFault,
  WorkstreamSummarySchema,
  OperatorHostResourcesResultSchema,
  advanceResourceSnapshot,
  composeResourceSnapshot,
  type ResourceSnapshotProvenance,
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
  /** Synchronous publication fence: unchanged ownership, root visibility, lineage and full index coverage.
   * The provider must invalidate it atomically with every relevant authority/index mutation.
   * It covers this entire run set and summary, including checks completed before later awaits.
   */
  publishable(this: void): boolean;
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
// Response-lifetime guards, never a reusable result cache; keys/closures disappear with the response.
const publicationGuards = new WeakMap<object, () => void>();

/** Recheck at HTTP/WS serialization too: dispatcher/authorization wrappers have their own awaits. */
export function resourceResponseForPublication(message: unknown): unknown {
  if (
    typeof message !== "object" ||
    message === null ||
    !("kind" in message) ||
    message.kind !== "response" ||
    !("ok" in message) ||
    message.ok !== true ||
    !("result" in message) ||
    typeof message.result !== "object" ||
    message.result === null
  )
    return message;
  const guard = publicationGuards.get(message.result);
  if (!guard) return message;
  try {
    guard();
    return message;
  } catch (error) {
    return {
      kind: "response",
      id: "id" in message ? message.id : 0,
      ok: false,
      error: isProtocolFault(error) ? error.toJSON() : describeError(error),
    };
  }
}

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
  private previous: ResourceSnapshotProvenance | undefined;

  constructor(
    private readonly target: OperatorTarget,
    private readonly source: HostResourceReadSource,
    private readonly now: () => number = () => performance.now(),
    private readonly wallNow: () => number = () => Date.now(),
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
        const hostReceived = this.now();
        const wallReceived = this.wallNow();
        if (snapshot.daemonInstanceId !== this.target.instanceId) throw changed();
        const provenance = advanceResourceSnapshot(this.previous, snapshot, {
          expectedDaemonInstanceId: this.target.instanceId,
          requestGeneration: 0,
          currentGeneration: 0,
        });
        if (!provenance) throw changed();
        // Never publish a collector's aggregate counts under a host-only permission.
        let summary: WorkstreamSummary = {
          status: "permission-denied",
          source: "runtime-ownership",
          reason: "not-authorized",
        };
        let projection: AuthorizedWorkstreamProjection | undefined;
        let summaryReceived = hostReceived;
        let runIds: readonly string[] = [];
        if (holds(check(), "runs.read")) {
          summary = { status: "unavailable", source: "runtime-ownership", reason: "scope-unverified" };
          if (this.source.workstreams) {
            projection = await readSource(() => this.source.workstreams!(check(), abort.signal));
            if (
              !Array.isArray(projection?.runIds) ||
              typeof projection.publishable !== "function" ||
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
            summaryReceived = this.now();
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
        // Validate the provider's original host warnings before composition regenerates them.
        const result = OperatorHostResourcesResultSchema.safeParse({
          ...snapshot,
          workstreams: { status: "permission-denied", source: "runtime-ownership", reason: "not-authorized" },
        });
        if (!result.success || Buffer.byteLength(JSON.stringify(result.data)) > HOST_RESOURCE_LIMITS.snapshotBytes)
          throw invalid();
        if (projection) {
          if ((await readSource(() => projection.current(abort.signal))) !== true) throw changed();
          await checkRuns(runIds);
        }
        return { snapshot, summary, projection, provenance, hostReceived, summaryReceived, wallReceived };
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
      const publication = await Promise.race([operation, deadline]);
      const { snapshot, summary, projection, provenance, hostReceived, summaryReceived, wallReceived } = publication;
      let composed: HostResourceSnapshot;
      try {
        if (projection) {
          const completed = this.now();
          const wallCompleted = this.wallNow();
          if (wallCompleted < wallReceived) throw invalid();
          composed = composeResourceSnapshot(snapshot, summary, {
            collectedAt: new Date(wallCompleted).toISOString(),
            hostElapsedMs: completed - hostReceived,
            summaryElapsedMs: completed - summaryReceived,
          });
        } else composed = { ...snapshot, workstreams: summary };
      } catch {
        throw invalid();
      }
      const result = OperatorHostResourcesResultSchema.safeParse(composed);
      if (!result.success || Buffer.byteLength(JSON.stringify(result.data)) > HOST_RESOURCE_LIMITS.snapshotBytes)
        throw invalid();
      const fence = () => {
        check();
        if (projection) {
          let publishable: unknown;
          try {
            publishable = projection.publishable();
            // Never await async authority or consult a returned promise's instance catch.
            if (publishable !== true)
              void Promise.prototype.then.call(Promise.resolve(publishable), undefined, () => {});
          } catch {
            throw unavailable();
          }
          if (publishable !== true) throw changed();
        }
        check();
      };
      // No awaits follow this fence, including the Promise.race continuation above.
      fence();
      publicationGuards.set(result.data, fence);
      // Retain only ordering/provenance evidence; missing boot readings cannot erase a known boot.
      this.previous = provenance;
      return result.data;
    } finally {
      clearTimeout(timer);
      check();
    }
  }
}
