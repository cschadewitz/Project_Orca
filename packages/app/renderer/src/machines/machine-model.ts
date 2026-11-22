/**
 * The words the Machines surface says about each machine (#882), as plain functions with a
 * plain test, like `agents/agent-groups.ts`.
 */
import type { FleetMachine, FleetSnapshot } from "../../../src/daemon-connection.js";
import { counted, unit } from "../ui/index.js";

/** "3 of 4 agent sessions · 2 queued", or nothing when the daemon does not report slots (#873). */
export function slotsLabel(slots: FleetMachine["slots"]): string | undefined {
  if (!slots) return undefined;
  const use =
    slots.maxAgentSessions === undefined
      ? counted(slots.inUse, "agent session")
      : unit(unit(slots.inUse, "of"), counted(slots.maxAgentSessions, "agent session"));
  return slots.queued > 0 ? `${use} · ${unit(slots.queued, "queued")}` : use;
}

/**
 * The surface's one line about all of them. A machine that has never answered adds nothing
 * to the counts and is named as unread instead, so a missing machine never reads as idle.
 */
export function fleetSummary(snapshot: FleetSnapshot): string {
  const machines = snapshot.machines;
  const read = machines.filter((m) => m.work);
  const waiting = read.reduce((sum, m) => sum + (m.work?.waiting ?? 0), 0);
  const active = read.reduce((sum, m) => sum + (m.work?.activeTotal ?? 0), 0);
  const parts = [counted(machines.length, "machine"), counted(active, "active run"), unit(waiting, "waiting")];
  const unread = machines.length - read.length;
  if (unread > 0) parts.push(unit(unread, "not read yet"));
  return parts.join(" · ");
}

/** "Last heard …" applies only to a machine that is not live and has something to show. */
export function isStale(machine: FleetMachine): boolean {
  return machine.staleSince !== undefined && machine.state !== "live" && machine.state !== "file";
}
