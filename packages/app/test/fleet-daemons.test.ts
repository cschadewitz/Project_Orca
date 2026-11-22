/**
 * Three real daemons at once (#882): two watched by the fleet, each on its own authenticated
 * client and push stream, and a third read as the focused one. Work started on one daemon
 * shows only under that daemon's name, its gate becomes an alert that names the machine, and
 * stopping one daemon leaves the other watched daemon live and updating.
 *
 * Uses the two-daemon fixture (#885 phase 1), which runs the compiled CLI: `pnpm run build`
 * first; CI builds before it tests.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "@orca/testing/two-daemons";
import type { AlertsUpdate } from "../src/bridge.js";
import { DaemonClient, type DaemonClientOptions } from "../src/client/daemon-client.js";
import type { FleetSnapshot } from "../src/daemon-connection.js";
import { Fleet, type FleetTarget } from "../src/main/fleet.js";

const GATED = `id: gated
name: Gated
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Ship it?", options: [ship, hold] }
  done: { type: end }
edges:
  - { from: s, to: gate }
  - { from: gate, to: done }
`;

let workflows: string;
const daemons: Record<"alpha" | "beta" | "focused", TestDaemon> = {} as never;

beforeAll(async () => {
  workflows = await mkdtemp(join(tmpdir(), "orca-fleet-"));
  await writeFile(join(workflows, "gated.yaml"), GATED);
  const config = `version: 1\nworkflows: [${JSON.stringify(join(workflows, "gated.yaml"))}]\ntemplates: []\n`;
  const [alpha, beta, focused] = await Promise.all(
    (["alpha", "beta", "focused"] as const).map((name) => startTestDaemon({ name, config })),
  );
  Object.assign(daemons, { alpha, beta, focused });
}, 60_000);
afterAll(async () => {
  await Promise.allSettled(Object.values(daemons).map((daemon) => daemon.close()));
  await rm(workflows, { recursive: true, force: true });
});

const client = (daemon: TestDaemon, hooks: Pick<DaemonClientOptions, "onHello"> = {}) =>
  new DaemonClient(daemon.url, fetch, {
    requireAuthentication: true,
    auth: { read: () => daemon.token, refresh: () => false },
    ...hooks,
  });

async function until<T>(read: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function start(daemon: TestDaemon): Promise<string> {
  const answer = await daemon.call("runs.start", { workflowId: "gated" });
  if (!answer.ok) throw new Error(answer.error.message);
  return (answer.result as { runId: string }).runId;
}

describe("three daemons at once", () => {
  it("streams each on its own connection, keeps their work apart, and survives one going away", async () => {
    let snapshot: FleetSnapshot = { machines: [] };
    let alerts: AlertsUpdate = { waiting: 0, items: [] };
    const focusedClient = client(daemons.focused);
    const fleet = new Fleet({
      open: async (target, hooks) => {
        const daemon =
          target.kind === "profile" && (target.id === "alpha" || target.id === "beta") ? daemons[target.id] : undefined;
        if (!daemon) throw new Error("unknown machine");
        return { client: client(daemon, { onHello: hooks.onHello }), release: async () => {} };
      },
      focusedReader: () => ({ reader: focusedClient, epoch: 1 }),
      onChange: (next) => {
        snapshot = next;
      },
      onAlerts: (next) => {
        alerts = next;
      },
      quietMs: 100,
      refreshDelayMs: 50,
    });
    const machine = (key: string) => snapshot.machines.find((m) => m.key === key);
    const targets: FleetTarget[] = [
      { kind: "profile", id: "alpha", name: "Alpha", destination: "alpha.example", revision: 0 },
      { kind: "profile", id: "beta", name: "Beta", destination: "beta.example", revision: 0 },
    ];
    try {
      const focusedRun = await start(daemons.focused);
      fleet.setTargets(targets);
      fleet.setFocused({
        key: "url:focused",
        name: "Focused",
        detail: "Daemon URL",
        epoch: 1,
        state: "live",
        since: new Date().toISOString(),
        authority: 1,
      });
      await until(() => (machine("profile:alpha")?.state === "live" ? true : undefined), "alpha live");
      await until(() => (machine("profile:beta")?.state === "live" ? true : undefined), "beta live");
      await until(() => machine("profile:alpha")?.work, "alpha read");

      // A run on beta shows on beta, and only there, and its gate names beta.
      const betaRun = await start(daemons.beta);
      await until(() => (machine("profile:beta")?.work?.waiting === 1 ? true : undefined), "beta gate");
      expect(machine("profile:beta")!.work!.runs.map((r) => r.id)).toEqual([betaRun]);
      expect(machine("profile:alpha")!.work!.runs).toEqual([]);
      expect(alerts.items.map((item) => [item.title, item.body, item.machine?.name])).toEqual([
        ["gated is waiting on Beta", "Ship it?", "Beta"],
      ]);

      // The focused daemon is read through its own client and never mixed in.
      fleet.focusedChanged();
      await until(() => machine("url:focused")?.work, "focused read");
      expect(machine("url:focused")!.work!.runs.map((r) => r.id)).toEqual([focusedRun]);
      expect(machine("profile:beta")!.work!.runs.map((r) => r.id)).not.toContain(focusedRun);

      // Alpha goes away: it is shown stale with its last answer; beta keeps updating.
      await daemons.alpha.close();
      await until(
        () => (machine("profile:alpha")?.state !== "live" && machine("profile:alpha")?.staleSince ? true : undefined),
        "alpha stale",
      );
      expect(machine("profile:alpha")!.work).toBeDefined();
      const second = await start(daemons.beta);
      await until(() => (machine("profile:beta")?.work?.waiting === 2 ? true : undefined), "beta second gate");
      expect(machine("profile:beta")!.state).toBe("live");
      expect(new Set(machine("profile:beta")!.work!.runs.map((r) => r.id))).toEqual(new Set([betaRun, second]));
    } finally {
      await fleet.close();
    }
  }, 60_000);
});
