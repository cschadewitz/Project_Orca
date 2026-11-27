/**
 * The Machines surface: every daemon the app can see at once, grouped by machine (#882).
 *
 * Four decisions worth knowing before changing anything here:
 *
 * - **One machine is focused; the rest are read-only.** Every other surface, and every write
 *   anywhere in the app, goes to the focused daemon. Here an unfocused machine's runs and
 *   asks are listed for reading only — a gate on it has no answer control, because answering
 *   it would be a write to a daemon the rest of the app is not looking at. **Focus** goes
 *   through `daemonConnection.connect`, the same path as the connection dialog: an
 *   authenticated probe, then the all-window draft check, then the swap.
 * - **A missing machine is never zero work.** What a machine last said stays on screen with
 *   the moment it went quiet ("Last heard …"), and a machine that has never answered says
 *   "Not read yet" rather than showing empty lists. The counts in the summary leave it out and
 *   say how many are unread.
 * - **The main process decides all of it.** Which machines exist, their connection state, their
 *   work and the five quiet seconds before a blip shows are `src/main/fleet.ts`; this file
 *   renders the snapshot it is handed and never reads a daemon itself.
 * - **It is a stack of content, so it scrolls at its root** (AGENTS.md, "Say where your
 *   screen scrolls").
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type {
  DaemonConnectionBridge,
  FleetBridge,
  FleetMachine,
  FleetRun,
  FleetSnapshot,
  RemoteProfileView,
  TailnetPresenceView,
} from "../../../src/daemon-connection.js";
import {
  Button,
  ConnectionIndicator,
  Menu,
  StateView,
  StatusChip,
  Text,
  Time,
  counted,
  textClass,
  type MenuItem,
} from "../ui/index.js";
import {
  fleetSummary,
  isStale,
  machineProfileId,
  presenceText,
  slotsLabel,
  type MachinePresence,
} from "./machine-model.js";
import { ownerText, progressText, waitText } from "../runs/board/board-model.js";
import "./machines.css";

export interface MachinesSurfaceProps {
  /** Open a run on the focused machine. */
  onOpenRun: (runId: string) => void;
  /** Open a gate or permission ask on the focused machine. */
  onOpenInput: (inputId: string) => void;
}

export function MachinesSurface(props: MachinesSurfaceProps): JSX.Element {
  const bridge = window.orca.daemonConnection;
  if (!bridge?.fleet)
    return (
      <div className="orca-machines">
        <StateView kind="empty" title="Machines" body="This build shows one daemon at a time." />
      </div>
    );
  return <Machines {...props} bridge={bridge} fleet={bridge.fleet} />;
}

function useFleet(fleet: FleetBridge): FleetSnapshot {
  const [snapshot, setSnapshot] = useState(() => fleet.read());
  useEffect(() => {
    const off = fleet.subscribe(setSnapshot);
    setSnapshot(fleet.read());
    return off;
  }, [fleet]);
  return snapshot;
}

/** Tailnet presence (#1230): read by the main process only while this view is open. */
function useTailnetPresence(fleet: FleetBridge): TailnetPresenceView {
  const [presence, setPresence] = useState<TailnetPresenceView>({});
  useEffect(() => fleet.tailnetPresence?.(setPresence), [fleet]);
  return presence;
}

function Machines({
  bridge,
  fleet,
  onOpenRun,
  onOpenInput,
}: MachinesSurfaceProps & { bridge: DaemonConnectionBridge; fleet: FleetBridge }): JSX.Element {
  const snapshot = useFleet(fleet);
  const presence = useTailnetPresence(fleet);
  const [profiles, setProfiles] = useState<readonly RemoteProfileView[]>([]);
  const [problem, setProblem] = useState<string>();
  const [focusing, setFocusing] = useState<string>();

  const loadProfiles = useCallback(() => {
    void bridge.profiles?.list().then(setProfiles, () => setProfiles([]));
  }, [bridge]);
  useEffect(loadProfiles, [loadProfiles]);

  const shown = useMemo(() => new Set(snapshot.machines.map((m) => m.key)), [snapshot]);
  const unwatched = profiles.filter((profile) => !shown.has(`profile:${profile.id}`));

  const watch = useCallback(
    async (id: string, watched: boolean) => {
      const result = await fleet.watch(id, watched);
      setProblem(result.ok ? undefined : result.message);
    },
    [fleet],
  );
  const focus = useCallback(
    async (machine: FleetMachine) => {
      if (machine.request === undefined) return;
      setFocusing(machine.key);
      try {
        const result = await bridge.connect(machine.request);
        setProblem(result.ok ? undefined : result.message);
      } finally {
        setFocusing(undefined);
      }
    },
    [bridge],
  );

  const items: MenuItem[] = [
    ...unwatched.map((profile) => ({ id: profile.id, label: profile.name, hintMachine: profile.destination })),
    { id: "\u0000new", label: "New SSH profile…" },
  ];

  return (
    <div className="orca-machines">
      <div className="orca-machines__summary">
        <Text style="caption" className="orca-truncate">
          {fleetSummary(snapshot)}
        </Text>
        <Menu
          label="Watch a machine"
          items={items}
          onOpenChange={(open) => {
            if (open) loadProfiles();
          }}
          onChoose={(item) => {
            if (item.id === "\u0000new") bridge.show();
            else void watch(item.id, true);
          }}
          triggerClassName={`orca-btn orca-btn--sm ${textClass("caption")}`}
          {...(unwatched.length === 0 ? { note: "Every saved profile is already on this screen." } : {})}
        >
          Watch a machine…
        </Menu>
      </div>
      {problem !== undefined && (
        <div className={`orca-banner ${textClass("caption")}`} role="alert">
          <Text style="caption">{problem}</Text>
        </div>
      )}
      {snapshot.machines.length === 0 ? (
        <StateView
          kind="disconnected"
          title="No daemon yet"
          body="Connect to a daemon, then watch other machines here beside it."
        />
      ) : (
        <div className="orca-machines__body">
          {snapshot.machines.map((machine) => (
            <MachineSection
              key={machine.key}
              machine={machine}
              presence={presence[machineProfileId(machine) ?? ""]}
              focusing={focusing === machine.key}
              busy={focusing !== undefined}
              onFocus={() => void focus(machine)}
              onUnwatch={
                machine.watched && machine.key.startsWith("profile:")
                  ? () => void watch(machine.key.slice("profile:".length), false)
                  : undefined
              }
              onOpenRun={onOpenRun}
              onOpenInput={onOpenInput}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A run's console line on its machine (#340): steps, the wait, the owner. The same words the
 * Runs board uses, read from what the machine last said; nothing when it said nothing.
 */
function consoleLine(run: FleetRun): string | undefined {
  const parts = [progressText(run), waitText(run), ownerText(run)].filter((p): p is string => p !== undefined);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Rows listed per machine before "and N more": the count beside the heading is the whole of it. */
const ROWS = 8;

function MachineSection({
  machine,
  presence,
  focusing,
  busy,
  onFocus,
  onUnwatch,
  onOpenRun,
  onOpenInput,
}: {
  machine: FleetMachine;
  presence: MachinePresence | undefined;
  focusing: boolean;
  busy: boolean;
  onFocus: () => void;
  onUnwatch: (() => void) | undefined;
  onOpenRun: (runId: string) => void;
  onOpenInput: (inputId: string) => void;
}): JSX.Element {
  const work = machine.work;
  const slots = slotsLabel(machine.slots);
  const stale = isStale(machine);
  const since = new Date(machine.staleSince ?? work?.asOf ?? Date.now());
  // Only the focused machine's objects can be opened: every other surface shows that one.
  const open = machine.focused;

  return (
    <section
      className={machine.focused ? "orca-machine orca-machine--focused" : "orca-machine"}
      aria-label={`${machine.name}${machine.focused ? ", focused" : ""}`}
    >
      <div className="orca-machine__head">
        <h2 className={`orca-machine__name ${textClass("heading")} orca-truncate`} title={machine.name}>
          {machine.name}
        </h2>
        <Text style="caption" className="orca-machine__detail orca-truncate">
          {machine.detail}
        </Text>
        <ConnectionIndicator state={machine.state} since={since} className="orca-machine__state" />
        {machine.focused ? (
          <Text style="eyebrow" className="orca-machine__focus">
            Focused
          </Text>
        ) : (
          <div className="orca-machine__actions">
            {machine.request !== undefined && (
              <Button
                size="sm"
                onClick={onFocus}
                disabled={busy}
                {...(busy
                  ? { disabledReason: focusing ? "Focusing this machine" : "Another machine is focusing" }
                  : {})}
              >
                {focusing ? "Focusing…" : "Focus"}
              </Button>
            )}
            {onUnwatch && (
              <Button size="sm" tone="ghost" onClick={onUnwatch}>
                Stop watching
              </Button>
            )}
          </div>
        )}
      </div>

      {(slots !== undefined || work) && (
        <div className="orca-machine__facts">
          {work && <Text style="caption">{counted(work.activeTotal, "active run")}</Text>}
          {slots !== undefined && <Text style="caption">{slots}</Text>}
        </div>
      )}
      {presence !== undefined && (
        <Text style="caption" as="p" className="orca-machine__presence">
          {presenceText(presence)}
          {presence.kind === "offline" && presence.lastSeen !== undefined && (
            <>
              {" · last seen "}
              <Time at={new Date(presence.lastSeen)} show="relative" />
            </>
          )}
        </Text>
      )}
      {/* Beside the connection's own reason, never in place of it: that may be a refusal to sign
          in or a different machine, which the tailnet knows nothing about. */}
      {machine.reason !== undefined && (
        <Text style="caption" as="p" className="orca-machine__reason">
          {machine.reason}
        </Text>
      )}
      {stale && work && (
        <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
          <Text style="caption">
            Last heard <Time at={new Date(machine.staleSince!)} show="relative" /> — this is what it said then.
          </Text>
        </div>
      )}

      {!work ? (
        <Text style="caption" as="p" className="orca-machine__unread">
          Not read yet. Its work shows here once it answers.
        </Text>
      ) : (
        <>
          <Waits machine={machine} open={open} onOpenInput={onOpenInput} />
          <Runs machine={machine} open={open} onOpenRun={onOpenRun} />
          {!open && (work.inputs.length > 0 || work.runs.length > 0) && (
            <Text style="caption" as="p" className="orca-machine__hint">
              Read-only. Focus this machine to answer or open its runs.
            </Text>
          )}
        </>
      )}
    </section>
  );
}

function Waits({
  machine,
  open,
  onOpenInput,
}: {
  machine: FleetMachine;
  open: boolean;
  onOpenInput: (inputId: string) => void;
}): JSX.Element | null {
  const inputs = machine.work?.inputs ?? [];
  if (inputs.length === 0) return null;
  const more = inputs.length - ROWS;
  return (
    <div className="orca-machine__group">
      <Text style="eyebrow" as="h3" className="orca-machine__group-head">
        {counted(machine.work!.waiting, "ask")} waiting
      </Text>
      <ul className="orca-machine__list">
        {inputs.slice(0, ROWS).map((input) => (
          <li key={input.id} className="orca-machine__row">
            <StatusChip status="waiting" label={input.tier === "permission" ? "permission" : "gate"} aligned />
            {open ? (
              <button
                type="button"
                className={`orca-machine__link ${textClass("body")} orca-truncate`}
                title={`${input.runName}: ${input.question}`}
                onClick={() => onOpenInput(input.id)}
              >
                {input.runName}
              </button>
            ) : (
              <Text style="body" className="orca-truncate" title={`${input.runName}: ${input.question}`}>
                {input.runName}
              </Text>
            )}
            <Text style="caption" className="orca-machine__question orca-truncate" title={input.question}>
              {input.question}
            </Text>
          </li>
        ))}
      </ul>
      {more > 0 && <Text style="caption">and {counted(more, "more ask")}</Text>}
    </div>
  );
}

function Runs({
  machine,
  open,
  onOpenRun,
}: {
  machine: FleetMachine;
  open: boolean;
  onOpenRun: (runId: string) => void;
}): JSX.Element | null {
  const work = machine.work!;
  if (work.runs.length === 0)
    return (
      <Text style="caption" as="p" className="orca-machine__idle">
        No active runs.
      </Text>
    );
  const more = work.activeTotal - Math.min(ROWS, work.runs.length);
  return (
    <div className="orca-machine__group">
      <Text style="eyebrow" as="h3" className="orca-machine__group-head">
        Active runs
      </Text>
      <ul className="orca-machine__list">
        {work.runs.slice(0, ROWS).map((run) => {
          const line = consoleLine(run);
          return (
            <li key={run.id} className="orca-machine__row">
              <StatusChip status={run.status} aligned />
              {open ? (
                <button
                  type="button"
                  className={`orca-machine__link ${textClass("body")} orca-truncate`}
                  title={run.name}
                  onClick={() => onOpenRun(run.id)}
                >
                  {run.name}
                </button>
              ) : (
                <Text style="body" className="orca-truncate" title={run.name}>
                  {run.name}
                </Text>
              )}
              {(line || run.operations?.lastActivityAt) && (
                <Text style="caption" className="orca-machine__console orca-truncate" title={line}>
                  {line}
                  {line && run.operations?.lastActivityAt ? " · " : ""}
                  {run.operations?.lastActivityAt && (
                    <Time at={new Date(run.operations.lastActivityAt)} show="relative" />
                  )}
                </Text>
              )}
            </li>
          );
        })}
      </ul>
      {more > 0 && <Text style="caption">and {counted(more, "more run")}</Text>}
    </div>
  );
}
