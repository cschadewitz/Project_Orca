/** Read-only resource cards. Takes shared snapshots through a closed fixture gate; never reads the bridge. */
import { useEffect, useId, type JSX, type ReactNode } from "react";
import { CONNECTION_PRESENTATION } from "@orca/design";
import type { ResourceMetric } from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import { Card, Chip, Text } from "../ui/index.js";
import {
  bytes,
  displayedSnapshot,
  percent,
  RESOURCE_REASONS,
  seconds,
  supportedMetric,
  warningText,
  type ResourceViewState,
} from "./resource-model.js";
import "./resources.css";

const ACCESS_MESSAGE = {
  unconnected:
    "Resource readings are not connected. This preview requires shared fixtures; authenticated capability discovery is pending.",
  unsupported: "Resource readings are unsupported for this target. No capacity is known.",
  "permission-denied": "Resource access denied. No observations or workstream counts are disclosed.",
} as const;

export function ResourceView({ state }: { state: ResourceViewState }): JSX.Element {
  const titleId = useId();
  const snapshot = displayedSnapshot(state);
  const retained = state.connection !== "live" || state.awaitingSnapshot || state.invalidResponse;
  const freshness = snapshot
    ? snapshot.warnings.some((warning) => warning.code === "stale-data")
      ? "Stale observations"
      : retained
        ? "Last known observations"
        : "Observed readings"
    : "No observations";
  const announce = useAnnounce();
  // Only categorical changes speak. Age and changing measurements never stream into the live region.
  const announcement = `${state.targetLabel}. ${state.access === "fixture" ? `${state.connection}. ${freshness}. ${snapshot?.warnings.map(warningText).join(" ") ?? ""}` : ACCESS_MESSAGE[state.access]}`;
  useEffect(() => announce(announcement), [announce, announcement]);
  const connection = CONNECTION_PRESENTATION[state.connection];

  return (
    <section className="orca-resources" aria-labelledby={titleId}>
      <header className="orca-resources__header">
        <div>
          <Text as="h2" style="title" id={titleId}>
            Daemon resources
          </Text>
          <Text as="p" style="body">
            Selected target: {state.targetLabel}
          </Text>
        </div>
        <Chip glyph={connection.glyph}>{connection.word}</Chip>
        <Chip>{freshness}</Chip>
      </header>
      <Text as="p" style="body">
        Advisory only. Observations can change before launch. These readings do not reserve capacity or establish how
        many workstreams can run.
      </Text>
      {state.access !== "fixture" ? (
        <Card>
          <Text as="p" style="body-strong">
            {ACCESS_MESSAGE[state.access]}
          </Text>
        </Card>
      ) : !snapshot ? (
        <Card>
          <Text as="h3" style="heading">
            {state.invalidResponse
              ? "Resource observation unavailable"
              : state.connection === "live"
                ? "Waiting for a resource observation"
                : "Disconnected without an observation"}
          </Text>
          <Text as="p" style="body">
            {state.invalidResponse
              ? "The response did not match the shared schema."
              : "No reading is available for this selected target."}{" "}
            Capacity and active work are unknown.
          </Text>
        </Card>
      ) : (
        <>
          <Card>
            <Text as="h3" style="heading">
              Observation scope
            </Text>
            <Text as="p" style="body">
              The daemon’s OS-visible machine, including unrelated load. Desktop-client and SSH execution-host readings
              are unsupported. Physical host capacity is unknown; configured limits are not collected.
            </Text>
            <dl className="orca-resources__identity">
              <Fact label="Daemon instance">{snapshot.daemonInstanceId}</Fact>
              <Fact label="Collector instance (opaque alias)">{snapshot.hostId}</Fact>
              <Fact label="Boot identity">{"value" in snapshot.bootId ? snapshot.bootId.value : "Unknown"}</Fact>
              <Fact label="Collection completed">
                <time dateTime={snapshot.collectedAt}>{snapshot.collectedAt}</time>
              </Fact>
              <Fact label="Collection age">{seconds(snapshot.ageMs)}</Fact>
              <Fact label="Sequence">{snapshot.sequence}</Fact>
            </dl>
            <MetricNote metric={snapshot.bootId} retained={retained} />
            <Text as="p" style="caption">
              Observations expire after {seconds(snapshot.expiresAfterMs)}. Each source retains its own observation
              time.
            </Text>
          </Card>
          {(retained || state.invalidResponse) && (
            <Card>
              <Text as="p" style="body-strong">
                {state.invalidResponse ? "The latest response was invalid. " : ""}
                Last known readings only.{" "}
                {state.connection === "live"
                  ? "Waiting for a new valid observation."
                  : "The connection is not live."}{" "}
                Arrival or reconnection does not renew an observation.
              </Text>
            </Card>
          )}
          <section aria-label="Advisory warnings" className="orca-resources__warnings">
            <Text as="h3" style="heading">
              {retained ? "Last observed advisory warnings" : "Advisory warnings"}
            </Text>
            {/* A schema-bounded set of at most twelve prose warnings, not a row list. */}
            {snapshot.warnings.length ? (
              snapshot.warnings.map((warning) => (
                <Card key={`${warning.code}-${warning.metric}`}>
                  <Text as="p" style="body-strong">
                    {warningText(warning)}
                  </Text>
                  <Text style="caption">Shared policy: {warning.policy}</Text>
                </Card>
              ))
            ) : (
              <Text as="p" style="body">
                No shared host warnings in this observation. This is not launch clearance; workstream visibility may
                still be denied.
              </Text>
            )}
          </section>
          <div className="orca-resources__grid">
            <Metric
              title="Whole-machine CPU"
              metric={supportedMetric(snapshot, "cpu", snapshot.cpu)}
              retained={retained}
            >
              {(v) => (
                <>
                  <Value>{percent(v.utilizationRatio)} busy</Value>
                  <Text as="p" style="body">
                    Over {seconds(v.intervalMs)} across {v.logicalCores} OS-visible logical cores. Utilization is not
                    normalized to the cgroup quota.
                  </Text>
                </>
              )}
            </Metric>
            <Metric
              title="Effective CPU limit"
              metric={supportedMetric(snapshot, "cpuLimit", snapshot.cpuLimit)}
              retained={retained}
            >
              {(v) => (
                <>
                  <Value>{v.effectiveCores} effective cores</Value>
                  <Text as="p" style="body">
                    Visible cgroup hierarchy · cpuset {v.cpusetCores} cores ·{" "}
                    {v.quotaCores === null ? "no finite visible CPU quota" : `quota ${v.quotaCores} cores`}. Hidden
                    ancestors and process affinity are unmeasured.
                  </Text>
                </>
              )}
            </Metric>
            <Metric
              title="Available RAM"
              metric={supportedMetric(snapshot, "memory", snapshot.memory)}
              retained={retained}
            >
              {(v) => (
                <>
                  <Value>{bytes(v.availableBytes)} available</Value>
                  <Text as="p" style="body">
                    {bytes(v.totalBytes)} total · {bytes(v.freeBytes)} free. Available is an estimate including
                    reclaimable memory; free is a separate reading.
                  </Text>
                </>
              )}
            </Metric>
            <Metric
              title="Cgroup memory headroom"
              metric={supportedMetric(snapshot, "memoryLimit", snapshot.memoryLimit)}
              retained={retained}
            >
              {(v) => (
                <>
                  <Value>
                    {v.headroomBytes === null ? "No finite visible limit" : `${bytes(v.headroomBytes)} headroom`}
                  </Value>
                  <Text as="p" style="body">
                    {v.limitBytes === null
                      ? "Capacity remains bounded by available RAM and any hidden limits."
                      : `${bytes(v.limitBytes)} smallest visible limit.`}{" "}
                    Leaf usage: {bytes(v.currentBytes)}. Headroom is measured across visible ancestors, not calculated
                    from this limit and leaf usage.
                  </Text>
                </>
              )}
            </Metric>
            <Metric
              title="Swap occupancy"
              metric={supportedMetric(snapshot, "swap", snapshot.swap)}
              retained={retained}
            >
              {(v) => (
                <>
                  <Value>{bytes(v.usedBytes)} used</Value>
                  <Text as="p" style="body">
                    {bytes(v.totalBytes)} total. Occupancy alone does not mean active swapping or thrashing.
                  </Text>
                </>
              )}
            </Metric>
            <Metric
              title="Swap activity"
              metric={supportedMetric(snapshot, "swapActivity", snapshot.swapActivity)}
              retained={retained}
            >
              {(v) => (
                <>
                  <Value>
                    {bytes(v.inBytesPerSecond)}/s in · {bytes(v.outBytesPerSecond)}/s out
                  </Value>
                  <Text as="p" style="body">
                    Over {seconds(v.intervalMs)}.
                    {v.inBytesPerSecond === 0 && v.outBytesPerSecond === 0
                      ? " No activity observed in this interval."
                      : " Interval rates, not occupancy."}
                  </Text>
                </>
              )}
            </Metric>
            {snapshot.storage.map((disk) => (
              <Metric
                key={disk.role}
                title={`${disk.role === "temp" ? "Temporary" : disk.role === "store" ? "Store" : "Workspace"} storage`}
                metric={supportedMetric(snapshot, "storage", disk.measurement)}
                retained={retained}
              >
                {(v) => (
                  <>
                    <Value>{bytes(v.availableBytes)} available</Value>
                    <Text as="p" style="body">
                      {bytes(v.totalBytes)} total · {v.backing} · backing {v.backingId}.
                    </Text>
                    <Text as="p" style="body">
                      {v.capacityRelation === "shared-memory"
                        ? "tmpfs shares RAM and swap capacity; this is not additional disk headroom."
                        : v.capacityRelation === "unknown"
                          ? "Backing and capacity overlap are unknown."
                          : "Filesystem capacity only."}{" "}
                      Matching backing IDs share a filesystem within this observation. Never add capacity across roles.
                    </Text>
                  </>
                )}
              </Metric>
            ))}
            <Metric title="Active ORCA workstreams" metric={snapshot.workstreams} retained={retained}>
              {(v) => (
                <>
                  <Value>{v.activeRoots} active roots</Value>
                  <Text as="p" style="body">
                    {v.scope === "caller-visible" ? "Caller-visible" : "Authorized aggregate"} ·{" "}
                    {v.complete ? "complete for the authorized run set" : "partial coverage of the authorized run set"}.
                    This is not a count of all host jobs.
                  </Text>
                  <Text as="p" style="body">
                    Runs: {v.executingRuns} executing · {v.waitingRuns} waiting · {v.blockedRuns} blocked ·{" "}
                    {v.uncertainRuns} uncertain. Run counts can exceed roots; a workstream includes its root and
                    descendants.
                  </Text>
                </>
              )}
            </Metric>
          </div>
        </>
      )}
      <Text as="p" style="caption">
        Per-workstream CPU and RAM attribution, completion percentage, ETA and agent cost are unavailable.
      </Text>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <Text as="dt" style="caption">
        {label}
      </Text>
      <Text as="dd" style="mono-id">
        {children}
      </Text>
    </div>
  );
}

function Value({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Text as="p" style="mono-strong" className="orca-resources__value">
      {children}
    </Text>
  );
}

function Metric<T>({
  title,
  metric,
  retained,
  children,
}: {
  title: string;
  metric: ResourceMetric<T>;
  retained: boolean;
  children: (value: T) => ReactNode;
}): JSX.Element {
  const id = useId();
  return (
    <section aria-labelledby={id} className="orca-resources__metric">
      <Card>
        <Text as="h3" style="heading" id={id}>
          {title}
        </Text>
        {"value" in metric ? children(metric.value) : <Value>Unknown</Value>}
        <MetricNote metric={metric} retained={retained} />
      </Card>
    </section>
  );
}

function MetricNote<T>({ metric, retained }: { metric: ResourceMetric<T>; retained: boolean }): JSX.Element {
  const label =
    metric.status === "permission-denied"
      ? "Permission denied"
      : metric.status === "unsupported"
        ? "Unsupported"
        : metric.status === "unavailable"
          ? "Unavailable"
          : metric.status === "stale"
            ? "Stale"
            : retained
              ? "Last known"
              : "Observed";
  return (
    <div className="orca-resources__note">
      <Chip>{label}</Chip>
      {"reason" in metric && (
        <Text as="p" style="caption">
          {RESOURCE_REASONS[metric.reason]}
        </Text>
      )}
      {"value" in metric && (
        <Text as="p" style="caption">
          Observed <time dateTime={metric.observedAt}>{metric.observedAt}</time> · age {seconds(metric.ageMs)} ·{" "}
          {metric.precision}
        </Text>
      )}
      <Text as="p" style="mono-id">
        Source: {metric.source}
      </Text>
    </div>
  );
}
