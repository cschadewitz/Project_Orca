/** Bounded, caller-authorized run summaries; no wire method or daemon background task. */
import { RunStatusSchema, RunOutcomeSchema, type RunOutcome, type RunStatus } from "@orca/core";
import { HOST_RESOURCE_LIMITS, displayStatusForRun, type ResourceReason, type WorkstreamSummary } from "@orca/protocol";

export interface AuthorizedWorkstreamRun {
  runId: string;
  /** Verified lineage from runtime ownership / RunAccess, never a caller-supplied root. */
  rootRunId: string;
}

export interface WorkstreamObservation {
  status: RunStatus;
  outcome?: RunOutcome;
  waitingOn?: string;
  lease: "live" | "lapsed" | "missing" | "unknown";
  /** Time of the actual state/lease observation, not the time this projection was read. */
  observedAt: number;
}

export interface WorkstreamAuthority {
  /** Revalidate current credentials, permission and scope synchronously; fail closed. */
  current(): { scope: "caller-visible" | "authorized-aggregate" } | undefined;
  /** Revalidate ownership and workflow scope for this verified root, without reading data. */
  allows(run: AuthorizedWorkstreamRun): boolean;
}

export interface WorkstreamSource {
  /**
   * Enumerate only this authority's authorized run set, including roots and children.
   * The provider must bound its own work and return at most limit records. `complete`
   * describes that authorized set only: hidden records must not affect it. A runtime
   * index or bounded authorized IDs is appropriate; listRuns()/full history scans are not.
   * Bound allocation before returning: at most limit records and 256 characters per ID.
   * Root lineage is verified by the provider (e.g. RunAccess), not accepted from clients.
   */
  enumerate: (
    authority: WorkstreamAuthority,
    limit: number,
    signal: AbortSignal,
  ) => Promise<{
    runs: readonly AuthorizedWorkstreamRun[];
    complete: boolean;
  }>;
  /**
   * Read actual engine state/wait reason and current lease for one authorized run.
   * Use bounded runtime projections, not claims, configured agents or full event replay.
   * All providers must honor the signal where possible; an ignored abort retains the slot.
   */
  read: (runId: string, signal: AbortSignal) => Promise<WorkstreamObservation>;
}

const absent = (reason: ResourceReason): WorkstreamSummary => ({
  status: reason === "not-authorized" ? "permission-denied" : "unavailable",
  source: "runtime-ownership",
  reason,
});

/** Each instance permits one underlying collection, including work that ignores a timeout. */
export class HostWorkstreamCollector {
  private busy = false;

  constructor(
    private readonly source: WorkstreamSource,
    private readonly now: () => number = Date.now,
  ) {}

  async collect(authority: WorkstreamAuthority): Promise<WorkstreamSummary> {
    const scope = this.scope(authority);
    if (!scope) return absent("not-authorized");
    if (this.busy) return absent("busy");
    const started = this.now();
    if (!Number.isFinite(started) || started < 0 || started > 8_640_000_000_000_000)
      return absent("clock-discontinuity");
    this.busy = true;
    const abort = new AbortController();
    const seen = new Map<string, AuthorizedWorkstreamRun>();
    const roots = new Set<string>();
    const counts = { activeRoots: 0, executingRuns: 0, waitingRuns: 0, blockedRuns: 0, uncertainRuns: 0 };
    let complete = true;
    let oldest = started;
    let stale = false;
    let clockDiscontinuity = false;
    const authorized = (run?: AuthorizedWorkstreamRun) => {
      try {
        return this.scope(authority) === scope && (!run || authority.allows(run));
      } catch {
        return false;
      }
    };
    const result = (reason?: ResourceReason): WorkstreamSummary => {
      if (!authorized() || [...seen.values()].some((run) => !authorized(run))) return absent("not-authorized");
      const current = this.now();
      if (!Number.isFinite(current) || current < started || current > 8_640_000_000_000_000)
        return absent("clock-discontinuity");
      if (reason && !seen.size) return absent(reason);
      const observedAt = new Date(oldest).toISOString();
      const ageMs = current - oldest;
      const base = {
        value: { scope, coverage: "authorized-run-set" as const, complete: complete && !reason, ...counts },
        observedAt,
        ageMs,
        source: "runtime-ownership" as const,
        precision: "estimate" as const,
      };
      return reason || stale || ageMs >= HOST_RESOURCE_LIMITS.expiresAfterMs
        ? { status: "stale", ...base, reason: reason ?? (clockDiscontinuity ? "clock-discontinuity" : "expired") }
        : { status: "available", ...base };
    };
    const operation = (async (): Promise<WorkstreamSummary> => {
      try {
        const set = await this.source.enumerate(authority, HOST_RESOURCE_LIMITS.workstreamRecords, abort.signal);
        if (!authorized()) return absent("not-authorized");
        if (abort.signal.aborted) return absent("timeout");
        complete = set.complete && set.runs.length <= HOST_RESOURCE_LIMITS.workstreamRecords;
        for (const run of set.runs.slice(0, HOST_RESOURCE_LIMITS.workstreamRecords)) {
          if (!run.runId || !run.rootRunId || run.runId.length > 256 || run.rootRunId.length > 256)
            return absent("invalid-source");
          if (!authorized(run)) return absent("not-authorized");
          if (seen.has(run.runId)) {
            if (seen.get(run.runId)!.rootRunId !== run.rootRunId) return absent("invalid-source");
            continue;
          }
          let observation: WorkstreamObservation;
          try {
            observation = await this.source.read(run.runId, abort.signal);
            if (
              !RunStatusSchema.safeParse(observation.status).success ||
              (observation.outcome !== undefined && !RunOutcomeSchema.safeParse(observation.outcome).success) ||
              !["live", "lapsed", "missing", "unknown"].includes(observation.lease)
            )
              throw new Error("invalid observation");
          } catch {
            if (!authorized(run)) return absent("not-authorized");
            if (abort.signal.aborted) return absent("timeout");
            seen.set(run.runId, run);
            // A failed read proves neither a nonterminal run nor an active root.
            counts.uncertainRuns++;
            complete = false;
            continue;
          }
          if (!authorized(run)) return absent("not-authorized");
          if (abort.signal.aborted) return absent("timeout");
          seen.set(run.runId, run);
          // Terminal state is immutable; an old terminal observation remains excluded.
          if (["completed", "failed", "cancelled"].includes(observation.status)) continue;
          roots.add(run.rootRunId);
          counts.activeRoots = roots.size;
          const validTime = Number.isFinite(observation.observedAt) && observation.observedAt >= 0;
          const age = this.now() - observation.observedAt;
          const expired = !validTime || age < 0 || age >= HOST_RESOURCE_LIMITS.expiresAfterMs;
          clockDiscontinuity ||= !validTime || !Number.isFinite(age) || age < 0;
          if (validTime && age >= 0) oldest = Math.min(oldest, observation.observedAt);
          stale ||= expired;
          const status = displayStatusForRun(observation, {
            waitingOn: observation.waitingOn,
            leaseLapsed: ["running", "waiting"].includes(observation.status) && observation.lease !== "live",
          });
          if (expired || status === "stale") counts.uncertainRuns++;
          else if (status === "running") counts.executingRuns++;
          else if (status === "waiting") counts.waitingRuns++;
          else if (status === "blocked") counts.blockedRuns++;
        }
        return result();
      } catch {
        return result("source-failed");
      } finally {
        this.busy = false;
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<WorkstreamSummary>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(result("timeout"));
      }, HOST_RESOURCE_LIMITS.collectionTimeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private scope(authority: WorkstreamAuthority) {
    try {
      const scope = authority.current()?.scope;
      return scope === "caller-visible" || scope === "authorized-aggregate" ? scope : undefined;
    } catch {
      return undefined;
    }
  }
}
