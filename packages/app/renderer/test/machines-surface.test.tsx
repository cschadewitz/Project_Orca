// @vitest-environment happy-dom
/**
 * The Machines surface (#882): one section per machine, the focused one first and the only
 * one whose rows open; a dropped machine keeps its last answer, marked stale; a machine that
 * never answered is "not read yet", never zero; and Focus, watch and stop watching each go
 * through the bridge rather than to a daemon.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DaemonConnectionBridge,
  FleetBridge,
  FleetMachine,
  FleetSnapshot,
  RemoteProfileView,
} from "../../src/daemon-connection.js";
import { MachinesSurface } from "../src/machines/machines-surface.js";
import { fleetSummary, slotsLabel } from "../src/machines/machine-model.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

const NOW = "2026-11-22T12:00:00.000Z";
/** Keep the no-break spaces `counted` puts between a number and its noun. */
const exact = (text: string): string => text;

const machine = (over: Partial<FleetMachine> & Pick<FleetMachine, "key" | "name">): FleetMachine => ({
  detail: "ssh host",
  focused: false,
  watched: true,
  state: "live",
  ...over,
});

const work = (runs: string[], asks: string[] = []): NonNullable<FleetMachine["work"]> => ({
  runs: runs.map((name) => ({ id: `run-${name}`, name, status: "running" })),
  activeTotal: runs.length,
  inputs: asks.map((question, i) => ({
    id: `in-${i}`,
    tier: "gate",
    runId: `run-${i}`,
    runName: `Asking run ${i}`,
    question,
    requestedAt: NOW,
  })),
  waiting: asks.length,
  asOf: NOW,
});

const SNAPSHOT: FleetSnapshot = {
  machines: [
    machine({
      key: "bundled",
      name: "This computer",
      detail: "Bundled daemon",
      focused: true,
      watched: false,
      work: work(["Local build"], ["Ship it?"]),
    }),
    machine({
      key: "profile:alpha",
      name: "Alpha",
      request: { profile: "alpha" },
      work: work(["Remote build", "Remote lint"]),
      slots: { maxAgentSessions: 4, inUse: 3, queued: 2 },
    }),
    machine({
      key: "profile:beta",
      name: "Beta",
      request: { profile: "beta" },
      state: "reconnecting",
      staleSince: NOW,
      work: work([], ["Deploy?"]),
    }),
    machine({ key: "profile:gamma", name: "Gamma", request: { profile: "gamma" }, state: "disconnected" }),
  ],
};

const PROFILES: RemoteProfileView[] = ["alpha", "beta", "gamma", "delta"].map((id) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  destination: `${id}.example`,
  remotePort: 6722,
  hasCredential: true,
  hostKeyPinned: true,
}));

let fake: FakeBridge;
let h: Harness;
let push: ((snapshot: FleetSnapshot) => void) | undefined;
let fleet: FleetBridge;
let connection: DaemonConnectionBridge;
const teardown: (() => void)[] = [];

beforeEach(() => {
  fake = installBridge();
  teardown.push(fake.install());
  fleet = {
    read: () => SNAPSHOT,
    subscribe: (listener) => {
      push = listener;
      return () => {
        push = undefined;
      };
    },
    watch: vi.fn(async () => ({ ok: true as const, value: null })),
  };
  connection = {
    read: () => ({ epoch: 1, url: "http://127.0.0.1:1", source: "bundled", environmentOverride: false }),
    subscribe: () => () => {},
    show: vi.fn(),
    onShow: () => () => {},
    cancel: vi.fn(),
    activate: vi.fn(),
    connect: vi.fn(async () => ({ ok: true as const })),
    profiles: {
      list: async () => PROFILES,
      save: vi.fn(),
      remove: vi.fn(),
      importCredential: vi.fn(),
      forgetHostKey: vi.fn(),
      useAutomaticSignIn: vi.fn(),
    },
    fleet,
  };
  (window.orca as { daemonConnection?: DaemonConnectionBridge }).daemonConnection = connection;
  h = harness();
});
afterEach(() => {
  cleanup();
  h.dispose();
  while (teardown.length) teardown.pop()?.();
});

function renderSurface() {
  const onOpenRun = vi.fn();
  const onOpenInput = vi.fn();
  render(
    <h.Providers>
      <MachinesSurface onOpenRun={onOpenRun} onOpenInput={onOpenInput} />
    </h.Providers>,
  );
  return { onOpenRun, onOpenInput };
}
const section = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });

describe("the Machines surface", () => {
  it("lists every machine, the focused one first, with counts that leave out a machine never read", () => {
    renderSurface();
    const names = screen.getAllByRole("heading", { level: 2 }).map((h2) => h2.textContent);
    expect(names).toEqual(["This computer", "Alpha", "Beta", "Gamma"]);
    expect(screen.getByText(/4\u00a0machines/, { normalizer: exact }).textContent).toBe(
      "4 machines · 3 active runs · 2 waiting · 1 not read yet",
    );
    expect(within(section("This computer")).getByText("Focused")).toBeTruthy();
  });

  it("opens rows only on the focused machine, and says the others are read-only", () => {
    const { onOpenRun, onOpenInput } = renderSurface();
    fireEvent.click(within(section("This computer")).getByRole("button", { name: "Local build" }));
    expect(onOpenRun).toHaveBeenCalledWith("run-Local build");
    fireEvent.click(within(section("This computer")).getByRole("button", { name: "Asking run 0" }));
    expect(onOpenInput).toHaveBeenCalledWith("in-0");
    const alpha = section("Alpha");
    expect(within(alpha).queryByRole("button", { name: "Remote build" })).toBeNull();
    expect(within(alpha).getByText("Remote build")).toBeTruthy();
    expect(within(alpha).getByText(/Read-only\. Focus this machine/)).toBeTruthy();
  });

  it("shows slots, a stale machine's last answer, and an unread machine as not read yet", () => {
    renderSurface();
    expect(
      within(section("Alpha")).getByText("3\u00a0of\u00a04\u00a0agent sessions · 2\u00a0queued", { normalizer: exact }),
    ).toBeTruthy();
    const beta = section("Beta");
    expect(within(beta).getByText(/Last heard/)).toBeTruthy();
    expect(within(beta).getByText("Deploy?")).toBeTruthy();
    const gamma = section("Gamma");
    expect(within(gamma).getByText(/Not read yet/)).toBeTruthy();
    expect(within(gamma).queryByText(/No active runs/)).toBeNull();
  });

  it("focuses a machine through the connection path and stops watching through the fleet", async () => {
    renderSurface();
    await act(async () => {
      fireEvent.click(within(section("Alpha")).getByRole("button", { name: "Focus" }));
    });
    expect(connection.connect).toHaveBeenCalledWith({ profile: "alpha" });
    await act(async () => {
      fireEvent.click(within(section("Beta")).getByRole("button", { name: "Stop watching" }));
    });
    expect(fleet.watch).toHaveBeenCalledWith("beta", false);
    // The focused machine is not offered Focus or Stop watching.
    expect(within(section("This computer")).queryByRole("button", { name: "Focus" })).toBeNull();
  });

  it("says why a focus was refused", async () => {
    connection.connect = vi.fn(async () => ({ ok: false as const, message: "Save or discard pending edits first." }));
    renderSurface();
    await act(async () => {
      fireEvent.click(within(section("Alpha")).getByRole("button", { name: "Focus" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("Save or discard pending edits first.");
  });

  it("follows pushed snapshots", () => {
    renderSurface();
    act(() => push?.({ machines: [machine({ key: "bundled", name: "This computer", focused: true })] }));
    expect(screen.getAllByRole("heading", { level: 2 }).map((h2) => h2.textContent)).toEqual(["This computer"]);
  });

  it("offers only the saved profiles not already on screen to watch", async () => {
    renderSurface();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Watch a machine" }));
    });
    const options = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(options.some((text) => text?.startsWith("Delta"))).toBe(true);
    expect(options.some((text) => text?.startsWith("Alpha"))).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("menuitem").find((item) => item.textContent?.startsWith("Delta"))!);
    });
    expect(fleet.watch).toHaveBeenCalledWith("delta", true);
  });
});

describe("machine words", () => {
  it("counts slots against a cap, or without one", () => {
    expect(slotsLabel(undefined)).toBeUndefined();
    expect(slotsLabel({ inUse: 1, queued: 0 })).toBe("1 agent session");
    expect(slotsLabel({ maxAgentSessions: 2, inUse: 2, queued: 1 })).toBe("2 of 2 agent sessions · 1 queued");
  });
  it("never counts an unread machine as idle", () => {
    expect(fleetSummary({ machines: [machine({ key: "a", name: "A" })] })).toBe(
      "1 machine · 0 active runs · 0 waiting · 1 not read yet",
    );
  });
});
