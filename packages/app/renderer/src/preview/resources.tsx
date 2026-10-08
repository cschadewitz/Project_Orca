/** Dev-only, deterministic review surface for #492. No resource RPC, polling, subscription or grants. */
import { useReducer, useState, type JSX } from "react";
import { hostResourceFixture, workstreamSummaryFixture } from "@orca/protocol";
import { THEMES, type ThemeId } from "@orca/design";
import { Announcer } from "../a11y/announcer.js";
import { Button, Text, textClass } from "../ui/index.js";
import { resourceViewReducer, resourceViewState, type ResourceAccess } from "../resources/resource-model.js";
import { ResourceView } from "../resources/resource-view.js";
import "./resources.css";

type FixtureKind = NonNullable<Parameters<typeof hostResourceFixture>[0]>;
type SummaryKind = NonNullable<Parameters<typeof workstreamSummaryFixture>[0]>;
const FIXTURES: FixtureKind[] = [
  "healthy",
  "pressure",
  "partial",
  "stale",
  "tmpfs",
  "cgroup-cpu-unsupported",
  "cgroup-cpu-denied",
  "cgroup-memory-unsupported",
  "cgroup-memory-denied",
];
const SUMMARIES: SummaryKind[] = ["denied", "active", "empty", "partial"];
const ACCESS: ResourceAccess[] = ["fixture", "unconnected", "unsupported", "permission-denied"];
const fixtureTarget = hostResourceFixture().daemonInstanceId;
const otherTarget = "20000000-0000-4000-8000-000000000001";

function initialState() {
  return resourceViewReducer(resourceViewState("Fixture daemon", fixtureTarget, "fixture"), {
    type: "receive",
    snapshot: hostResourceFixture(),
    requestGeneration: 0,
  });
}

export default function ResourcesPreview(): JSX.Element {
  const [state, dispatch] = useReducer(resourceViewReducer, undefined, initialState);
  const [kind, setKind] = useState<FixtureKind>("healthy");
  const [summary, setSummary] = useState<SummaryKind>("denied");
  const [theme, setTheme] = useState<ThemeId>("dark");
  const replay = (nextKind: FixtureKind, nextSummary: SummaryKind) => {
    // A deliberate replay starts a new fixture generation. It is never a live refresh.
    dispatch({ type: "select", targetLabel: "Fixture daemon", daemonInstanceId: fixtureTarget });
    const snapshot = hostResourceFixture(nextKind);
    snapshot.workstreams = workstreamSummaryFixture(nextSummary);
    dispatch({ type: "receive", snapshot, requestGeneration: state.generation + 1 });
  };
  return (
    <main
      className="resource-preview orca-surface"
      data-theme={theme}
      aria-label="Resource fixture preview"
      tabIndex={0}
    >
      <header className="resource-preview__heading">
        <Text as="h1" style="title">
          Resource fixtures
        </Text>
        <Text as="p" style="body">
          Synthetic observations from #495 at <Text style="mono-id">a94d78a</Text>. This is a fixture review, with a
          manually advanced clock. No daemon is measured.
        </Text>
        <Text as="p" style="caption">
          <a href="#preview">Primitives</a> · <a href="#type">Type proof</a> · <a href="#">Operator UI</a>
        </Text>
      </header>
      <div className="resource-preview__controls" aria-label="Fixture controls" role="group">
        <label>
          <Text style="label">Shared fixture</Text>
          <select
            className={`orca-input ${textClass("mono-body")}`}
            value={kind}
            onChange={(event) => {
              const value = event.target.value as FixtureKind;
              setKind(value);
              replay(value, summary);
            }}
          >
            {FIXTURES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <Text style="label">Workstream summary</Text>
          <select
            className={`orca-input ${textClass("label")}`}
            value={summary}
            onChange={(event) => {
              const value = event.target.value as SummaryKind;
              setSummary(value);
              replay(kind, value);
            }}
          >
            {SUMMARIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <Text style="label">Access gate (simulated)</Text>
          <select
            className={`orca-input ${textClass("label")}`}
            value={state.access}
            onChange={(event) => dispatch({ type: "access", access: event.target.value as ResourceAccess })}
          >
            {ACCESS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <Text style="label">Theme</Text>
          <select
            className={`orca-input ${textClass("label")}`}
            value={theme}
            onChange={(event) => setTheme(event.target.value as ThemeId)}
          >
            {THEMES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => dispatch({ type: "time", nowMs: state.nowMs + 5_000 })}>Age by 5 seconds</Button>
        <Button
          onClick={() =>
            dispatch({ type: "connection", connection: state.connection === "live" ? "disconnected" : "live" })
          }
        >
          {state.connection === "live" ? "Simulate disconnect" : "Simulate reconnect"}
        </Button>
        <Button
          onClick={() =>
            dispatch({ type: "select", targetLabel: "Another daemon (no fixture)", daemonInstanceId: otherTarget })
          }
        >
          Switch target
        </Button>
        <Button
          disabled={state.access !== "fixture" || state.connection !== "live"}
          disabledReason={
            state.access !== "fixture" ? "The fixture access gate is closed" : "The simulated connection is not live"
          }
          onClick={() => replay(kind, summary)}
        >
          Replay selected fixture
        </Button>
      </div>
      <Announcer />
      <ResourceView state={state} />
    </main>
  );
}
