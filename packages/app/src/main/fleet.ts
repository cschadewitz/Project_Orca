/**
 * The machines the app watches besides the one it is focused on (#882).
 *
 * `./workspace.ts` owns exactly one daemon: the **focused** one, the only target any write,
 * draft or resource call goes to. This module owns every other daemon on screen — the
 * saved SSH profiles a person chose to watch, and the bundled daemon the workspace parked
 * when focus moved to a remote one. Each watched machine is a {@link Member} with its own
 * client, push stream, cursor, credential (a profile lease) and two fences:
 *
 * - `generation` counts this member's connections. It goes up when the member is opened,
 *   closed or suspended because it became the focused target, and every stream callback and
 *   every read captures it, so a frame or a late reply from an old connection is dropped
 *   rather than painted onto the new one.
 * - `scope` counts the daemon identities seen on the current connection. A reconnect that
 *   lands on another store (`hello.identity` changed) bumps it, clears what was shown and
 *   reads again, so one store's runs never appear under another's name.
 *
 * Nothing here can write. The port a member reads through has `runsList`, `inputsList` and
 * `subscribe` only, and focusing a machine is not done here: it goes through the existing
 * `ConnectionTarget` path (authenticated probe, then the all-window draft guard), after
 * which {@link Fleet.setFocused} suspends the member whose daemon is now the workspace's,
 * so one daemon is never streamed twice.
 *
 * A machine that drops out is not zero work. Its last answer stays on screen, marked with
 * the moment it went quiet; only a machine that has never answered shows no work, and it
 * says "not read yet" rather than "nothing". A reconnect reads the whole picture again
 * (`runs.list`, `inputs.list`) rather than replaying frames, so a resumed stream can never
 * duplicate anything.
 *
 * Electron-free so the per-target fencing is a plain test (`test/fleet.test.ts`).
 */
import type { ConnectionState } from "@orca/design";
import type {
  DaemonNotification,
  HelloResult,
  InputsListParams,
  InputsListResult,
  RunsListParams,
  RunsListResult,
  SessionSlotsSummary,
} from "@orca/protocol";
import { appSpeaks } from "../client/protocol-window.js";
import type { RetryCount, SubscriptionState } from "../client/subscription.js";
import type { AlertItem, AlertsUpdate } from "../bridge.js";
import type { FleetMachine, FleetSnapshot, FleetWork } from "../daemon-connection.js";

export type { FleetInput, FleetMachine, FleetRun, FleetSnapshot, FleetWork } from "../daemon-connection.js";
import { connectionStateFor, QUIET_MS } from "./connection-state.js";
import { connectionFailure } from "./connection-target.js";
import { authenticationCode } from "../client/auth.js";

/** The run statuses a machine's row counts as work in progress. */
export const ACTIVE_STATUSES = ["running", "waiting", "blocked", "held"] as const;
/** How many active runs one machine's section lists; the count beside it is the whole total. */
export const FLEET_RUN_LIMIT = 50;
/** How many of a machine's newest failures it checks against the failures it saw happen. */
const FAILED_LOOKBACK = 20;
/** Coalesce a burst of frames into one read. */
export const REFRESH_DELAY_MS = 300;
/** Retry a machine whose tunnel or first probe failed: quickly at first, then once a minute. */
export const REOPEN_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

/** Which notifications can change what a machine's section shows. */
const REFRESHING = new Set<DaemonNotification["method"]>([
  "run.changed",
  "step.changed",
  "input.opened",
  "input.answered",
  "input.invalidated",
]);

/** What the fleet reads a daemon through. Reads and the push stream only — no writes. */
export interface FleetReader {
  runsList(params: Partial<RunsListParams>): Promise<RunsListResult>;
  inputsList(params: Partial<InputsListParams>): Promise<InputsListResult>;
}
export interface FleetClient extends FleetReader {
  subscribe(options: {
    params: Record<string, never>;
    onNotification: (notification: DaemonNotification) => void;
    onState: (state: SubscriptionState, retries: RetryCount) => void;
  }): { close(): void; readonly lastSeq?: number | undefined };
}

/** A machine to watch: a saved SSH profile, or this computer's parked bundled daemon. */
export type FleetTarget =
  | {
      kind: "profile";
      id: string;
      name: string;
      destination: string;
      /**
       * The profile's revision in `RemoteProfiles`: it moves on every edit, credential import,
       * host-key reset or removal, so a change that keeps the name and destination still
       * reopens the member and drops what the old credential read.
       */
      revision: number;
    }
  | { kind: "bundled"; url: string; tokenFile?: string | undefined; workspace: string };

export function fleetKey(target: FleetTarget): string {
  return target.kind === "profile" ? `profile:${target.id}` : "bundled";
}

/** One open connection to a watched machine. Released when the member closes. */
export interface FleetConnection {
  client: FleetClient;
  /** A sentence for a failure the transport can explain (a profile's tunnel). */
  explainFailure?: (error: unknown) => string | undefined;
  release(): Promise<void>;
}

/** The focused target, as `index.ts` sees it through the workspace and the connection machine. */
export interface FocusedMachine {
  key: string;
  /** The focused daemon's verified `workspaceId`, which its alerts are deduplicated by. */
  workspaceId?: string | undefined;
  name: string;
  detail: string;
  /** The workspace's connection epoch; a focused read is dropped if it moves. */
  epoch: number;
  state: ConnectionState;
  since: string;
}

export interface FleetDeps {
  /** Open a watched machine's connection. `onHello` fires on every verified (re)connect. */
  open(target: FleetTarget, hooks: { onHello: (hello: HelloResult) => void }): Promise<FleetConnection>;
  /** The focused daemon's reader and epoch, read at call time. */
  focusedReader(): { reader: FleetReader; epoch: number } | undefined;
  onChange(snapshot: FleetSnapshot): void;
  /** Alerts from every machine that is not focused; the focused one's come from its renderer. */
  onAlerts(update: AlertsUpdate): void;
  onError?: (message: string) => void;
  now?: () => number;
  quietMs?: number;
  refreshDelayMs?: number;
  reopenBackoffMs?: readonly number[];
}

interface Work {
  work: FleetWork;
  failed: { id: string; name: string; at: string; message?: string }[];
}

/**
 * Where one store's alerts are told apart from another's: every item id is `<scope>␁<id>`,
 * and the scope is the verified workspace (`ws:<workspaceId>`), never the profile or URL
 * that reached it. The same store keeps the same alert ids whichever way it is reached and
 * whether or not it is focused; a different store behind the same profile gets new ones.
 */
export function machineAlertId(scope: string, id: string): string {
  return `${scope}\u0001${id}`;
}

/** The alert scope for a verified workspace, or for a machine that has none yet. */
export function alertScope(workspaceId: string | undefined, key: string): string {
  return workspaceId ? `ws:${workspaceId}` : key;
}

/**
 * Label one machine's alert items: a machine-scoped id, the machine on the item for the
 * click, and the machine's name in the words when there is more than one machine to tell
 * apart. Used for the focused machine's items as well, so an alert keeps one id when focus
 * moves to or from its machine and is not posted twice.
 */
export function labelAlerts(
  items: readonly AlertItem[],
  machine: { key: string; name: string; focused: boolean; scope: string; workspaceId?: string | undefined },
  named: boolean,
): AlertItem[] {
  return items.map((item) => ({
    ...item,
    id: machineAlertId(machine.scope, item.id),
    ...(named ? { title: `${item.title} on ${machine.name}` } : {}),
    machine: {
      key: machine.key,
      name: machine.name,
      focused: machine.focused,
      ...(machine.workspaceId ? { workspaceId: machine.workspaceId } : {}),
    },
  }));
}

function summarize(runs: RunsListResult, inputs: InputsListResult): FleetWork {
  return {
    runs: runs.runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      ...(run.waitingOn ? { waitingOn: run.waitingOn } : {}),
    })),
    activeTotal: runs.total,
    inputs: inputs.inputs.map((input) => ({
      id: input.id,
      tier: input.kind === "permission" ? "permission" : "gate",
      runId: input.runId,
      runName: input.runName,
      question: input.question,
      requestedAt: input.requestedAt,
    })),
    waiting: inputs.waiting,
    asOf: inputs.asOf,
  };
}

async function readWork(reader: FleetReader, failedIds: ReadonlySet<string> | undefined): Promise<Work> {
  const [runs, inputs, failed] = await Promise.all([
    reader.runsList({ status: [...ACTIVE_STATUSES], limit: FLEET_RUN_LIMIT }),
    reader.inputsList({}),
    failedIds?.size ? reader.runsList({ status: ["failed"], limit: FAILED_LOOKBACK }) : undefined,
  ]);
  return {
    work: summarize(runs, inputs),
    failed: (failed?.runs ?? [])
      .filter((run) => failedIds?.has(run.id))
      .map((run) => ({
        id: run.id,
        name: run.name,
        at: run.finishedAt ?? run.createdAt,
        ...(run.error?.message ? { message: run.error.message } : {}),
      })),
  };
}

/** One watched machine. */
class Member {
  generation = 0;
  scope = 0;
  connection: FleetConnection | undefined;
  stream: { close(): void; readonly lastSeq?: number | undefined } | undefined;
  link: SubscriptionState = "connecting";
  retries: RetryCount = { consecutive: 0, atCap: 0 };
  compatible = true;
  /** The identity the current connection last verified, for noticing a reboot or another store. */
  identity: HelloResult["identity"];
  /**
   * The workspace an authenticated `hello` on *this* connection verified, and still
   * authorized. Cleared on every close or reopen and on any loss of authorization; what was
   * retained is shown only while it names the same workspace.
   */
  verified: string | undefined;
  slots: SessionSlotsSummary | undefined;
  /**
   * What the machine last said, bound to the workspace that said it. Kept, and marked stale,
   * while that same verified workspace is away; hidden until a reopened connection verifies
   * that workspace again, and dropped the moment a different one, none, or a refusal answers.
   */
  retained: (Work & { workspaceId: string }) | undefined;
  /** Runs this connection saw fail; only these become failure alerts. */
  failedIds = new Set<string>();
  reason: string | undefined;
  /** When it stopped being live. Undefined while live or before it ever was. */
  wentQuietAt: number | undefined;
  everLive = false;
  suspended = false;
  refreshTimer: ReturnType<typeof setTimeout> | undefined;
  quietTimer: ReturnType<typeof setTimeout> | undefined;
  reopenTimer: ReturnType<typeof setTimeout> | undefined;
  reopenAttempt = 0;
  reading = false;
  readAgain = false;
  constructor(public target: FleetTarget) {}
  get key(): string {
    return fleetKey(this.target);
  }
}

export class Fleet {
  private readonly members = new Map<string, Member>();
  private focused: FocusedMachine | undefined;
  private focusedWork: { epoch: number; work: FleetWork } | undefined;
  private focusedReadEpoch = 0;
  private focusedTimer: ReturnType<typeof setTimeout> | undefined;
  private focusedReading = false;
  private focusedReadAgain = false;
  private closed = false;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly refreshDelayMs: number;
  private readonly backoff: readonly number[];

  constructor(private readonly deps: FleetDeps) {
    this.now = deps.now ?? Date.now;
    this.quietMs = deps.quietMs ?? QUIET_MS;
    this.refreshDelayMs = deps.refreshDelayMs ?? REFRESH_DELAY_MS;
    this.backoff = deps.reopenBackoffMs ?? REOPEN_BACKOFF_MS;
  }

  /** The key of the machine writes go to, if one is focused. */
  get focusedKey(): string | undefined {
    return this.focused?.key;
  }

  /**
   * Where a click on an alert may go now (#882). Its machine counts as focused only while
   * the focused target is that machine *and* still verified on the store the alert came
   * from; a watched machine likewise has to still be verified on it. Anything else (a
   * profile repointed at another daemon, a machine refused or no longer watched) is a stale
   * click and answers undefined, so it opens nothing rather than a route on the wrong store.
   * An alert with no machine predates the fleet and is passed through.
   */
  routeAlert(item: AlertItem): AlertItem | undefined {
    const machine = item.machine;
    if (!machine) return item;
    const focused = this.focused?.key === machine.key;
    const now = focused ? this.focused?.workspaceId : this.verifiedOn(machine.key);
    if (now !== machine.workspaceId || (!focused && now === undefined)) return undefined;
    return { ...item, machine: { ...machine, focused } };
  }

  private verifiedOn(key: string): string | undefined {
    const member = this.members.get(key);
    return member && !member.suspended ? member.verified : undefined;
  }

  /** Whether a watched machine's connection currently uses this profile. */
  usesProfile(id: string): boolean {
    const member = this.members.get(`profile:${id}`);
    return Boolean(member && !member.suspended && member.connection);
  }

  /**
   * Replace the set of watched machines. Members still wanted keep their connection; new
   * ones open; dropped ones close. A profile that changed in any way (its revision rises on an
   * edit, a reset host key or an imported credential) reopens and drops what it showed.
   */
  setTargets(targets: readonly FleetTarget[]): void {
    if (this.closed) return;
    const wanted = new Map(targets.map((target) => [fleetKey(target), target]));
    for (const [key, member] of this.members) {
      const next = wanted.get(key);
      if (!next) {
        void this.closeMember(member);
        this.members.delete(key);
      } else if (JSON.stringify(next) !== JSON.stringify(member.target)) {
        void this.closeMember(member);
        member.target = next;
        this.forget(member);
        member.everLive = false;
        member.wentQuietAt = undefined;
        if (!member.suspended) void this.openMember(member);
      }
    }
    for (const [key, target] of wanted) {
      if (this.members.has(key)) continue;
      const member = new Member(target);
      this.members.set(key, member);
      member.suspended = key === this.focused?.key;
      if (!member.suspended) void this.openMember(member);
    }
    this.publish();
  }

  /**
   * The focused target changed or its connection state did. A watched machine that is now
   * the focused one is suspended (the workspace streams it); one that stopped being focused
   * opens again.
   */
  setFocused(focused: FocusedMachine | undefined): void {
    if (this.closed) return;
    const previous = this.focused;
    this.focused = focused;
    if (previous?.epoch !== focused?.epoch || previous?.key !== focused?.key) {
      this.focusedWork = undefined;
      this.focusedReadEpoch += 1;
    }
    for (const member of this.members.values()) {
      const shouldSuspend = member.key === focused?.key;
      if (shouldSuspend && !member.suspended) {
        member.suspended = true;
        void this.closeMember(member);
      } else if (!shouldSuspend && member.suspended) {
        member.suspended = false;
        void this.openMember(member);
      }
    }
    if (focused && focused.state !== "disconnected" && focused.state !== "mismatch") this.focusedChanged();
    this.publish();
  }

  /** A frame arrived on the focused stream, or it (re)connected: read the focused machine again soon. */
  focusedChanged(notification?: DaemonNotification): void {
    if (this.closed || !this.focused) return;
    if (notification && !REFRESHING.has(notification.method)) return;
    if (this.focusedTimer) return;
    this.focusedTimer = setTimeout(() => {
      this.focusedTimer = undefined;
      void this.readFocused();
    }, this.refreshDelayMs);
  }

  get snapshot(): FleetSnapshot {
    const machines: FleetMachine[] = [];
    const focused = this.focused;
    if (focused) {
      const watched = this.members.get(focused.key);
      const work = this.focusedWork?.epoch === focused.epoch ? this.focusedWork.work : undefined;
      machines.push({
        key: focused.key,
        name: focused.name,
        detail: focused.detail,
        focused: true,
        watched: Boolean(watched && watched.target.kind === "profile"),
        state: focused.state,
        ...(focused.state === "live" || focused.state === "file" ? {} : { staleSince: focused.since }),
        ...(work ? { work } : {}),
        ...(watched?.slots ? { slots: watched.slots } : {}),
      });
    }
    const ordered = [...this.members.values()].sort((a, b) =>
      a.target.kind === b.target.kind ? 0 : a.target.kind === "bundled" ? -1 : 1,
    );
    for (const member of ordered) {
      if (member.suspended) continue;
      machines.push(this.machine(member));
    }
    return { machines };
  }

  /** Close every connection. Nothing is published after this. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.focusedTimer) clearTimeout(this.focusedTimer);
    this.focusedTimer = undefined;
    const releases = [...this.members.values()].map((member) => this.closeMember(member));
    this.members.clear();
    await Promise.allSettled(releases);
  }

  /* ---------- one member ---------- */

  /**
   * What may be shown for a member: its retained answer, only while this connection has
   * verified the same workspace that gave it and nothing has refused it since.
   */
  private shown(member: Member): Member["retained"] {
    const retained = member.retained;
    return retained && !member.suspended && member.verified === retained.workspaceId ? retained : undefined;
  }

  /** Drop everything a member retained: another store, no identity, or no authority. */
  private forget(member: Member): void {
    member.scope += 1;
    member.retained = undefined;
    member.failedIds = new Set();
  }

  /** Authorization was lost: nothing read under it may stay on screen or in an alert. */
  private refused(member: Member, reason: string): void {
    member.verified = undefined;
    member.reason = reason;
    this.forget(member);
  }

  private machine(member: Member): FleetMachine {
    const target = member.target;
    const shown = this.shown(member);
    return {
      key: member.key,
      name: target.kind === "profile" ? target.name : "This computer",
      detail: target.kind === "profile" ? `ssh ${target.destination}` : "Bundled daemon",
      focused: false,
      request: target.kind === "profile" ? { profile: target.id } : null,
      watched: target.kind === "profile",
      state: this.stateOf(member),
      ...(member.wentQuietAt !== undefined && member.link !== "live"
        ? { staleSince: new Date(member.wentQuietAt).toISOString() }
        : {}),
      ...(member.reason ? { reason: member.reason } : {}),
      ...(shown ? { work: shown.work } : {}),
      ...(member.verified && member.slots ? { slots: member.slots } : {}),
    };
  }

  /** The design's five states, with the same five quiet seconds the status bar keeps. */
  private stateOf(member: Member): ConnectionState {
    if (member.reason && !member.connection) return member.compatible ? "disconnected" : "mismatch";
    const state = connectionStateFor({
      link: member.link,
      compatible: member.compatible,
      daemonGone: false,
      failuresAtCap: member.retries.atCap,
      fileMode: false,
    });
    if (
      state === "reconnecting" &&
      member.everLive &&
      member.wentQuietAt !== undefined &&
      this.now() - member.wentQuietAt < this.quietMs
    )
      return "live";
    return state;
  }

  private async openMember(member: Member): Promise<void> {
    if (this.closed || member.suspended) return;
    const generation = ++member.generation;
    member.link = "connecting";
    member.retries = { consecutive: 0, atCap: 0 };
    member.compatible = true;
    member.identity = undefined;
    // Hidden, not dropped: shown again only once this connection verifies the same workspace.
    member.verified = undefined;
    member.scope += 1;
    member.failedIds = new Set();
    let connection: FleetConnection;
    try {
      connection = await this.deps.open(member.target, {
        onHello: (hello) => this.helloed(member, generation, hello),
      });
    } catch (error) {
      if (generation !== member.generation) return;
      if (authenticationCode(error)) this.refused(member, connectionFailure(error));
      else member.reason = connectionFailure(error);
      this.markQuiet(member);
      this.scheduleReopen(member, generation);
      this.publish();
      return;
    }
    if (generation !== member.generation || this.closed) {
      await connection.release().catch(() => undefined);
      return;
    }
    member.connection = connection;
    member.reason = undefined;
    member.stream = connection.client.subscribe({
      params: {},
      onNotification: (notification) => {
        if (generation !== member.generation) return;
        if (
          notification.method === "run.changed" &&
          notification.params.event === "run.failed" &&
          member.failedIds.size < 1_000
        )
          member.failedIds.add(notification.params.runId);
        if (REFRESHING.has(notification.method)) this.scheduleRead(member, generation);
      },
      onState: (state, retries) => {
        if (generation !== member.generation) return;
        this.linkChanged(member, generation, state, retries);
      },
    });
    this.publish();
  }

  private helloed(member: Member, generation: number, hello: HelloResult): void {
    if (generation !== member.generation) return;
    member.compatible = appSpeaks(hello.protocol);
    member.slots = hello.sessionSlots;
    const next = hello.identity;
    const previous = member.identity;
    member.identity = next;
    if (!next) {
      // A daemon that will not say which store it serves cannot vouch for anything shown.
      member.verified = undefined;
      this.forget(member);
    } else {
      if (member.retained && member.retained.workspaceId !== next.workspaceId) {
        // Another store answers behind this machine now — after a reopen too, where there is
        // no previous identity on the connection to compare with: what was retained is the
        // other store's, and is dropped rather than shown under this name.
        this.forget(member);
      } else if (previous && next.instanceId !== previous.instanceId) {
        // The same store rebooted: its history may have rewound, so no read in flight lands.
        member.scope += 1;
      }
      member.verified = next.workspaceId;
    }
    this.publish();
  }

  private linkChanged(member: Member, generation: number, state: SubscriptionState, retries: RetryCount): void {
    const was = member.link;
    member.link = state;
    member.retries = retries;
    if (state === "live") {
      member.everLive = true;
      member.wentQuietAt = undefined;
      member.reason = undefined;
      member.reopenAttempt = 0;
      // A (re)connect reads the whole picture again rather than trusting resumed frames.
      this.scheduleRead(member, generation, 0);
    } else {
      if (was === "live") this.markQuiet(member);
      if (state === "auth-failed") this.refused(member, connectionFailure({ error: { code: "AUTH_INVALID" } }));
    }
    this.publish();
  }

  private markQuiet(member: Member): void {
    if (member.wentQuietAt === undefined && member.everLive) {
      member.wentQuietAt = this.now();
      if (member.quietTimer) clearTimeout(member.quietTimer);
      // Re-publish when the quiet window ends, so `reconnecting` shows without a new input.
      member.quietTimer = setTimeout(() => {
        member.quietTimer = undefined;
        this.publish();
      }, this.quietMs + 1);
    }
  }

  private scheduleReopen(member: Member, generation: number): void {
    if (member.reopenTimer || this.closed) return;
    const delay = this.backoff[Math.min(member.reopenAttempt, this.backoff.length - 1)] ?? 60_000;
    member.reopenAttempt += 1;
    member.reopenTimer = setTimeout(() => {
      member.reopenTimer = undefined;
      if (generation === member.generation && !member.connection) void this.openMember(member);
    }, delay);
  }

  private scheduleRead(member: Member, generation: number, delay = this.refreshDelayMs): void {
    if (member.refreshTimer) {
      if (delay > 0) return;
      clearTimeout(member.refreshTimer);
    }
    member.refreshTimer = setTimeout(() => {
      member.refreshTimer = undefined;
      void this.read(member, generation);
    }, delay);
  }

  private async read(member: Member, generation: number): Promise<void> {
    if (generation !== member.generation || member.link !== "live" || !member.connection) return;
    if (member.reading) {
      member.readAgain = true;
      return;
    }
    const scope = member.scope;
    const workspaceId = member.verified;
    // Nothing is read until this connection has verified which store it is talking to.
    if (!workspaceId) return;
    member.reading = true;
    try {
      const result = await readWork(member.connection.client, member.failedIds);
      // A reply from an earlier connection, another store, or after a refusal is dropped.
      if (generation !== member.generation || scope !== member.scope || member.verified !== workspaceId || this.closed)
        return;
      member.retained = { ...result, workspaceId };
      this.publish();
    } catch (error) {
      if (generation !== member.generation) return;
      if (authenticationCode(error)) {
        this.refused(member, connectionFailure(error));
        this.publish();
        return;
      }
      const explained = member.connection?.explainFailure?.(error);
      this.deps.onError?.(`Could not read ${this.machine(member).name}: ${explained ?? connectionFailure(error)}`);
    } finally {
      member.reading = false;
      if (member.readAgain && generation === member.generation) {
        member.readAgain = false;
        this.scheduleRead(member, generation);
      }
    }
  }

  private closeMember(member: Member): Promise<void> {
    member.generation += 1;
    for (const timer of [member.refreshTimer, member.quietTimer, member.reopenTimer]) if (timer) clearTimeout(timer);
    member.refreshTimer = member.quietTimer = member.reopenTimer = undefined;
    member.reading = false;
    member.readAgain = false;
    member.stream?.close();
    member.stream = undefined;
    const connection = member.connection;
    member.connection = undefined;
    member.link = "closed";
    member.verified = undefined;
    return (
      connection?.release().catch(() => this.deps.onError?.("A watched machine's connection did not close")) ??
      Promise.resolve()
    );
  }

  /* ---------- the focused machine ---------- */

  private async readFocused(): Promise<void> {
    const source = this.deps.focusedReader();
    const focused = this.focused;
    if (!source || !focused || source.epoch !== focused.epoch) return;
    if (this.focusedReading) {
      this.focusedReadAgain = true;
      return;
    }
    this.focusedReading = true;
    const ticket = this.focusedReadEpoch;
    try {
      const { work } = await readWork(source.reader, undefined);
      if (this.closed || ticket !== this.focusedReadEpoch || this.focused?.epoch !== source.epoch) return;
      this.focusedWork = { epoch: source.epoch, work };
      this.publish();
    } catch {
      // The focused connection's own machine reports the failure; the section keeps what it had.
    } finally {
      this.focusedReading = false;
      if (this.focusedReadAgain) {
        this.focusedReadAgain = false;
        this.focusedChanged();
      }
    }
  }

  /* ---------- output ---------- */

  private publish(): void {
    if (this.closed) return;
    this.deps.onChange(this.snapshot);
    this.deps.onAlerts(this.alerts());
  }

  /** Waits and failures from every unfocused machine, labelled with the machine they are on. */
  private alerts(): AlertsUpdate {
    let waiting = 0;
    const items: AlertItem[] = [];
    for (const member of this.members.values()) {
      const shown = this.shown(member);
      if (!shown) continue;
      const name = this.machine(member).name;
      waiting += shown.work.waiting;
      const own: AlertItem[] = [
        ...shown.work.inputs.map<AlertItem>((input) => ({
          id: input.id,
          tier: input.tier,
          title: input.tier === "permission" ? `${input.runName} needs permission` : `${input.runName} is waiting`,
          body: input.question,
          runId: input.runId,
          inputId: input.id,
          since: input.requestedAt,
        })),
        ...shown.failed.map<AlertItem>((run) => ({
          id: run.id,
          tier: "failure",
          title: `${run.name} failed`,
          body: run.message ?? "The run will not proceed.",
          runId: run.id,
          since: run.at,
        })),
      ];
      items.push(
        ...labelAlerts(
          own,
          {
            key: member.key,
            name,
            focused: false,
            scope: alertScope(shown.workspaceId, member.key),
            workspaceId: shown.workspaceId,
          },
          true,
        ),
      );
    }
    return { waiting, items };
  }
}
