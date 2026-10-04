// @vitest-environment happy-dom
/** Accessible meanings, unknown states and fixture interaction; browser measurements live in resources-browser.spec.ts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { hostResourceFixture, workstreamSummaryFixture, type HostResourceSnapshot } from "@orca/protocol";
import { ResourceView } from "../src/resources/resource-view.js";
import { resourceViewReducer, resourceViewState } from "../src/resources/resource-model.js";
import ResourcesPreview from "../src/preview/resources.js";
import { AnnouncementsProvider } from "../src/a11y/announce-context.js";
import { createAnnouncements } from "../src/a11y/announce.js";
import { expectedToken, inBothThemes, installSurfaceStyles, resolved } from "./themes.js";
import { harness, stubMatchMedia } from "./harness.js";

afterEach(cleanup);
const stateFor = (snapshot: HostResourceSnapshot = hostResourceFixture()) =>
  resourceViewReducer(resourceViewState("Fixture daemon", snapshot.daemonInstanceId, "fixture"), {
    type: "receive",
    snapshot,
    requestGeneration: 0,
  });
const metric = (name: string) => within(screen.getByRole("region", { name }));

describe("resource cards", () => {
  it("shows scope, units, intervals, independent free/available RAM and occupied but inactive swap", () => {
    render(<ResourceView state={stateFor()} />);
    expect(metric("Whole-machine CPU").getByText("20% busy")).toBeTruthy();
    expect(metric("Whole-machine CPU").getByText(/5 s across 8 OS-visible/)).toBeTruthy();
    expect(metric("Effective CPU limit").getByText("2 effective cores")).toBeTruthy();
    expect(metric("Available RAM").getByText("7.45 GiB available")).toBeTruthy();
    expect(metric("Available RAM").getByText(/47.68 MiB free/)).toBeTruthy();
    expect(metric("Swap occupancy").getByText("953.67 MiB used")).toBeTruthy();
    expect(metric("Swap activity").getByText("0 B/s in · 0 B/s out")).toBeTruthy();
    expect(screen.getByText(/Desktop-client and SSH execution-host readings are unsupported/)).toBeTruthy();
    expect(screen.getByText(/not launch clearance/)).toBeTruthy();
    expect(metric("Active ORCA workstreams").getByText("Permission denied")).toBeTruthy();
    expect(metric("Active ORCA workstreams").queryByText(/0 active roots/)).toBeNull();
  });

  it("renders shared pressure warnings as named prose with their supplied thresholds", () => {
    render(<ResourceView state={stateFor(hostResourceFixture("pressure"))} />);
    const warnings = within(screen.getByRole("region", { name: "Advisory warnings" }));
    expect(warnings.getByText(/CPU: utilization reached.*90%/)).toBeTruthy();
    expect(warnings.getByText(/Available RAM:.*10%/)).toBeTruthy();
    expect(warnings.getByText(/Swap activity:.*1 MiB\/s/)).toBeTruthy();
    expect(warnings.getByText(/Temporary storage:.*10%/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["cgroup-cpu-unsupported", "cgroup-cpu-denied"] as const)(
    "preserves memory-pressure evidence when %s",
    (kind) => {
      render(<ResourceView state={stateFor(hostResourceFixture(kind))} />);
      expect(metric("Effective CPU limit").getByText("Unknown")).toBeTruthy();
      expect(metric("Cgroup memory headroom").getByText("190.73 MiB headroom")).toBeTruthy();
      expect(screen.getByText(/Cgroup memory headroom:.*10%/)).toBeTruthy();
    },
  );

  it.each(["cgroup-memory-unsupported", "cgroup-memory-denied"] as const)("preserves CPU limits when %s", (kind) => {
    render(<ResourceView state={stateFor(hostResourceFixture(kind))} />);
    expect(metric("Cgroup memory headroom").getByText("Unknown")).toBeTruthy();
    expect(metric("Effective CPU limit").getByText("2 effective cores")).toBeTruthy();
  });

  it("distinguishes unsupported, denied and timed-out fields without zero fallbacks", () => {
    render(<ResourceView state={stateFor(hostResourceFixture("partial"))} />);
    expect(metric("Effective CPU limit").getByText("Unsupported")).toBeTruthy();
    expect(metric("Cgroup memory headroom").getByText("Permission denied")).toBeTruthy();
    expect(metric("Swap activity").getByText("Unavailable")).toBeTruthy();
    expect(metric("Swap activity").getByText(/did not respond in time/)).toBeTruthy();
    expect(metric("Swap activity").queryByText(/0 B/)).toBeNull();
  });

  it("gates metric values on implementation capabilities, separately from summary authority", () => {
    render(<ResourceView state={stateFor({ ...hostResourceFixture(), capabilities: [] })} />);
    expect(metric("Whole-machine CPU").getByText("Unknown")).toBeTruthy();
    expect(metric("Available RAM").queryByText(/7.45 GiB/)).toBeNull();
    expect(metric("Active ORCA workstreams").getByText("Permission denied")).toBeTruthy();
  });

  it("describes shared disk backing and tmpfs overlap without adding capacities", () => {
    render(<ResourceView state={stateFor(hostResourceFixture("tmpfs"))} />);
    expect(metric("Temporary storage").getByText(/tmpfs shares RAM and swap/)).toBeTruthy();
    expect(metric("Store storage").getByText(/backing fs-1/)).toBeTruthy();
    expect(metric("Workspace storage").getByText(/backing fs-1/)).toBeTruthy();
    expect(metric("Temporary storage").getByText(/backing fs-2/)).toBeTruthy();
  });

  it("uses measured ancestor headroom and never calls a null cgroup bound infinite", () => {
    const snapshot = hostResourceFixture();
    if ("value" in snapshot.memoryLimit) snapshot.memoryLimit.value.headroomBytes = 100_000_000;
    const view = render(<ResourceView state={stateFor(snapshot)} />);
    expect(metric("Cgroup memory headroom").getByText("95.37 MiB headroom")).toBeTruthy();
    if ("value" in snapshot.memoryLimit) {
      snapshot.memoryLimit.value.limitBytes = null;
      snapshot.memoryLimit.value.headroomBytes = null;
    }
    view.rerender(<ResourceView state={stateFor(snapshot)} />);
    expect(metric("Cgroup memory headroom").getByText("No finite visible limit")).toBeTruthy();
    expect(metric("Cgroup memory headroom").getByText(/bounded by available RAM/)).toBeTruthy();
  });

  it.each(["active", "empty", "partial"] as const)(
    "renders the shared %s workstream summary and its coverage",
    (kind) => {
      render(
        <ResourceView state={stateFor({ ...hostResourceFixture(), workstreams: workstreamSummaryFixture(kind) })} />,
      );
      expect(
        metric("Active ORCA workstreams").getByText(kind === "empty" ? "0 active roots" : "2 active roots"),
      ).toBeTruthy();
      expect(
        metric("Active ORCA workstreams").getByText(
          kind === "partial" ? /partial coverage/ : /complete for the authorized run set/,
        ),
      ).toBeTruthy();
      expect(metric("Active ORCA workstreams").getByText(/Run counts can exceed roots/)).toBeTruthy();
    },
  );

  it("announces categorical changes through the shared channel, never ticking ages or new live regions", () => {
    const channel = createAnnouncements();
    const say = vi.fn();
    const off = channel.subscribe(say);
    let state = stateFor();
    const view = render(
      <AnnouncementsProvider value={channel}>
        <ResourceView state={state} />
      </AnnouncementsProvider>,
    );
    expect(say).toHaveBeenCalledTimes(1);
    state = resourceViewReducer(state, { type: "time", nowMs: 5_000 });
    view.rerender(
      <AnnouncementsProvider value={channel}>
        <ResourceView state={state} />
      </AnnouncementsProvider>,
    );
    expect(say).toHaveBeenCalledTimes(1);
    state = resourceViewReducer(state, { type: "time", nowMs: 20_000 });
    view.rerender(
      <AnnouncementsProvider value={channel}>
        <ResourceView state={state} />
      </AnnouncementsProvider>,
    );
    expect(say).toHaveBeenLastCalledWith(expect.stringContaining("Stale observations"));
    expect(view.container.querySelector("[aria-live]")).toBeNull();
    expect(metric("Whole-machine CPU").getByText("Stale")).toBeTruthy();
    expect(metric("Whole-machine CPU").getByText(/age 20 s/)).toBeTruthy();
    off();
  });

  it("uses the existing readable tokens in both themes", () => {
    installSurfaceStyles();
    inBothThemes(<ResourceView state={stateFor(hostResourceFixture("pressure"))} />, ({ container, theme }) => {
      expect(resolved(container.querySelector(".orca-resources")!, "color")).toBe(expectedToken(theme, "ink-primary"));
      expect(resolved(container.querySelector(".orca-card")!, "background-color")).toBe(
        expectedToken(theme, "surface-raised"),
      );
    });
  });

  it("replays fixtures, revokes access, ages disconnects and clears a switched target without transport work", () => {
    stubMatchMedia(1280);
    const h = harness();
    const { Providers } = h;
    const view = render(
      <Providers>
        <ResourcesPreview />
      </Providers>,
    );
    try {
      fireEvent.change(screen.getByLabelText("Shared fixture"), { target: { value: "pressure" } });
      expect(metric("Whole-machine CPU").getByText("98% busy")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Simulate disconnect" }));
      for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "Age by 5 seconds" }));
      expect(metric("Whole-machine CPU").getByText("Stale")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Simulate reconnect" }));
      expect(screen.getByText(/Last known readings only/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Switch target" }));
      expect(screen.queryByText("98% busy")).toBeNull();
      expect(screen.getByText(/Waiting for a resource observation/)).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Access gate (simulated)"), { target: { value: "permission-denied" } });
      expect(
        screen.getByText("Resource access denied. No observations or workstream counts are disclosed."),
      ).toBeTruthy();
      expect(view.container.querySelectorAll("[data-orca-announcer]")).toHaveLength(1);
    } finally {
      view.unmount();
      h.dispose();
    }
  });
});
