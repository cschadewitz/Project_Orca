/** Presentation and fixture lifecycle over #495's shared contract. No transport or warning policy lives here. */
import {
  advanceResourceSnapshot,
  HostResourceSnapshotSchema,
  resourceWarnings,
  type HostResourceSnapshot,
  type ResourceMetric,
  type ResourceReason,
  type ResourceSnapshotProvenance,
  type ResourceWarning,
  type WorkstreamSummary,
} from "@orca/protocol";
import type { ConnectionState } from "@orca/design";

/** Only the dev fixture route opens this gate. Real capability/authority discovery belongs to #491. */
export type ResourceAccess = "unconnected" | "fixture" | "unsupported" | "permission-denied";

export interface ResourceViewState {
  targetLabel: string;
  expectedDaemonInstanceId: string;
  generation: number;
  access: ResourceAccess;
  connection: ConnectionState;
  nowMs: number;
  receivedAtMs: number;
  snapshot: HostResourceSnapshot | undefined;
  /** Ordering evidence only: retain the known boot across missing observations, never an old summary. */
  provenance: ResourceSnapshotProvenance | undefined;
  awaitingSnapshot: boolean;
  invalidResponse: boolean;
}

export function resourceViewState(
  targetLabel: string,
  expectedDaemonInstanceId: string,
  access: ResourceAccess = "unconnected",
): ResourceViewState {
  return {
    targetLabel,
    expectedDaemonInstanceId,
    access,
    generation: 0,
    connection: "live",
    nowMs: 0,
    receivedAtMs: 0,
    snapshot: undefined,
    provenance: undefined,
    awaitingSnapshot: true,
    invalidResponse: false,
  };
}

export type ResourceViewAction =
  | { type: "select"; targetLabel: string; daemonInstanceId: string }
  | { type: "access"; access: ResourceAccess }
  | { type: "connection"; connection: ConnectionState }
  | { type: "time"; nowMs: number }
  | { type: "receive"; snapshot: unknown; requestGeneration: number };

/** Explicit fixture events, never asynchronous requests. Generations also cover reconnect and access changes. */
export function resourceViewReducer(state: ResourceViewState, action: ResourceViewAction): ResourceViewState {
  switch (action.type) {
    case "select":
      return {
        ...resourceViewState(action.targetLabel, action.daemonInstanceId, state.access),
        generation: state.generation + 1,
        connection: state.connection,
        nowMs: state.nowMs,
      };
    case "access":
      if (state.access === action.access) return state;
      return {
        ...state,
        access: action.access,
        generation: state.generation + 1,
        snapshot: undefined,
        provenance: undefined,
        awaitingSnapshot: true,
        invalidResponse: false,
      };
    case "connection":
      if (state.connection === action.connection) return state;
      return { ...state, connection: action.connection, generation: state.generation + 1, awaitingSnapshot: true };
    case "time":
      return Number.isFinite(action.nowMs) && action.nowMs >= state.nowMs ? { ...state, nowMs: action.nowMs } : state;
    case "receive": {
      if (state.access !== "fixture" || state.connection !== "live" || action.requestGeneration !== state.generation)
        return state;
      const parsed = HostResourceSnapshotSchema.safeParse(action.snapshot);
      // Never render schema errors or source exceptions: they could include inaccessible data.
      if (!parsed.success) return { ...state, invalidResponse: true };
      const previous = displayedSnapshot(state);
      const connection = {
        expectedDaemonInstanceId: state.expectedDaemonInstanceId,
        requestGeneration: action.requestGeneration,
        currentGeneration: state.generation,
      };
      // Compare against elapsed cache age, not arrival age: repeated delivery cannot
      // renew an old observation. The shared cursor preserves boot evidence through gaps.
      const provenance = advanceResourceSnapshot(
        state.provenance && { ...state.provenance, ageMs: previous?.ageMs ?? state.provenance.ageMs },
        parsed.data,
        connection,
      );
      if (!provenance) return state;
      return {
        ...state,
        snapshot: parsed.data,
        provenance,
        receivedAtMs: state.nowMs,
        awaitingSnapshot: false,
        invalidResponse: false,
      };
    }
  }
}

/** Age from elapsed monotonic time, including while disconnected. Arrival never renews an observation. */
export function ageResourceSnapshot(snapshot: HostResourceSnapshot, elapsedMs: number): HostResourceSnapshot {
  const invalidClock = !Number.isFinite(elapsedMs) || elapsedMs < 0;
  const elapsed = invalidClock ? 0 : elapsedMs;
  const age = <T>(metric: ResourceMetric<T>): ResourceMetric<T> => {
    if (!("value" in metric)) return metric;
    const ageMs = metric.ageMs + elapsed;
    if (invalidClock) return { ...metric, status: "stale", ageMs, reason: "clock-discontinuity" };
    if (metric.status === "available" && ageMs >= snapshot.expiresAfterMs)
      return { ...metric, status: "stale", ageMs, reason: "expired" };
    return { ...metric, ageMs };
  };
  const aged: HostResourceSnapshot = {
    ...snapshot,
    ageMs: snapshot.ageMs + elapsed,
    bootId: age(snapshot.bootId),
    cpu: age(supportedMetric(snapshot, "cpu", snapshot.cpu)),
    cpuLimit: age(supportedMetric(snapshot, "cpuLimit", snapshot.cpuLimit)),
    memory: age(supportedMetric(snapshot, "memory", snapshot.memory)),
    memoryLimit: age(supportedMetric(snapshot, "memoryLimit", snapshot.memoryLimit)),
    swap: age(supportedMetric(snapshot, "swap", snapshot.swap)),
    swapActivity: age(supportedMetric(snapshot, "swapActivity", snapshot.swapActivity)),
    storage: snapshot.storage.map((disk) => ({
      ...disk,
      measurement: age(supportedMetric(snapshot, "storage", disk.measurement)),
    })),
    workstreams: age(snapshot.workstreams),
  };
  return { ...aged, warnings: resourceWarnings(aged) };
}

export function displayedSnapshot(state: ResourceViewState): HostResourceSnapshot | undefined {
  return state.access === "fixture" && state.snapshot
    ? ageResourceSnapshot(state.snapshot, state.nowMs - state.receivedAtMs)
    : undefined;
}

/** Snapshot capabilities say implementation support, never permission or launch capacity. */
export function supportedMetric<T>(
  snapshot: HostResourceSnapshot,
  capability: HostResourceSnapshot["capabilities"][number],
  metric: ResourceMetric<T>,
): ResourceMetric<T> {
  return snapshot.capabilities.includes(capability)
    ? metric
    : { status: "unsupported", source: "none", reason: "unsupported-source" };
}

const decimal = (n: number): string => new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(n);
export const percent = (ratio: number): string => `${decimal(ratio * 100)}%`;
export const seconds = (ms: number): string => `${decimal(ms / 1000)} s`;
export function bytes(value: number): string {
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${decimal(value / 1024 ** Math.max(0, index))} ${units[Math.max(0, index)]}`;
}

export const RESOURCE_REASONS: Record<ResourceReason, string> = {
  "unsupported-platform": "This platform does not support the source.",
  "unsupported-source": "This source is not supported.",
  "permission-denied": "Access to this source was denied.",
  "source-failed": "The source could not be read.",
  "invalid-source": "The source returned invalid data.",
  timeout: "The source did not respond in time.",
  busy: "The source is still busy.",
  "warming-up": "Waiting for a second observation to measure the interval.",
  "counter-reset": "Counters reset; a new interval is needed.",
  "clock-discontinuity": "The clock changed; observation freshness is unverified.",
  "not-configured": "This storage role is not configured.",
  "scope-unverified": "The measurement scope could not be verified.",
  expired: "The observation has expired.",
  "not-authorized": "This caller is not authorized to see the summary.",
  "coverage-limit": "The authorized read reached its coverage limit.",
};

/** Announce access, freshness and coverage changes, never changing counts or observation ages. */
export function workstreamAnnouncement(summary: WorkstreamSummary): string {
  if (!("value" in summary)) {
    const status = summary.status === "permission-denied" ? "permission denied" : summary.status;
    return `Workstream summary ${status}; active work is unknown. ${RESOURCE_REASONS[summary.reason]}`;
  }
  const scope = summary.value.scope === "caller-visible" ? "caller-visible" : "authorized aggregate";
  const coverage = summary.value.complete ? "complete coverage" : "partial coverage";
  const freshness =
    summary.status === "stale" ? `Workstream summary is stale. ${RESOURCE_REASONS[summary.reason]} ` : "";
  return `${freshness}Workstream summary: ${scope}, ${coverage} of the authorized run set.`;
}

const metricNames: Record<ResourceWarning["metric"], string> = {
  cpu: "Whole-machine CPU",
  memory: "Available RAM",
  memoryLimit: "Cgroup memory headroom",
  swapActivity: "Swap activity",
  store: "Store storage",
  workspace: "Workspace storage",
  temp: "Temporary storage",
  snapshot: "Resource observations",
};

/** Words for the shared warning's basis and threshold; no local threshold comparisons. */
export function warningText(warning: ResourceWarning): string {
  const name = metricNames[warning.metric];
  const threshold = warning.threshold;
  switch (warning.basis) {
    case "utilization-ratio":
      return `${name}: utilization reached the advisory threshold${threshold === null ? "" : ` of ${percent(threshold)}`} over the measured interval.`;
    case "available-ratio":
      return `${name}: available capacity is at or below the advisory threshold${threshold === null ? "" : ` of ${percent(threshold)}`}.`;
    case "headroom-ratio":
      return `${name}: headroom is at or below the advisory threshold${threshold === null ? "" : ` of ${percent(threshold)} of the visible limit`}.`;
    case "swap-bytes-per-second":
      return `${name}: combined input and output reached the advisory threshold${threshold === null ? "" : ` of ${bytes(threshold)}/s`}.`;
    case "missing-observation":
      return "Partial data: some host observations are unknown. Missing data does not establish available capacity.";
    case "expired-observation":
      return "Stale data: retained observations cannot establish current pressure or headroom.";
  }
}
