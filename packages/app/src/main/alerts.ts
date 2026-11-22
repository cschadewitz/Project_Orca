/**
 * OS notifications, the dock badge and the one rule about focus (#162,
 * docs/design/20-attention-and-gates.md).
 *
 * Electron-free on purpose. Everything that needs `Notification`, `app.dock` or a
 * `BrowserWindow` is an `AlertsPort` the main process implements in six lines, so the part
 * with the timing in it — the 60-second gate delay, the unfocused escalation, the
 * coalescing — is a plain module a test can drive with fake timers. `src/main/index.ts`
 * builds the port; nothing else in the app imports this.
 *
 * Three rules from the tier table, and where each one is:
 *
 * - **A permission ask interrupts immediately; a gate waits 60 seconds; a failure notifies
 *   only when the run fails.** The delay is measured from when the gate was *asked*
 *   (`AlertItem.since`), not from when this process heard about it — an app that opens
 *   onto a gate that has been waiting ten minutes has already missed the delay.
 * - **Coalesced.** One live notification per tier: a second ask while the first is
 *   unanswered updates the count on the one that is showing rather than stacking a second
 *   one behind it. That is why `show` takes a `count` and a tier, and why the port is
 *   expected to keep one `Notification` object per tier rather than one per item.
 * - **A permission ask may steal focus only when the window is already focused, and never
 *   raises the window.** So the only thing this module ever asks for is
 *   `focusAttention`, and only behind `isFocused()`. There is no "show the window" call on
 *   the port at all, which is the strongest way to guarantee the second half.
 *
 * Opt-in per tier, defaulting to permission asks only, is `preferences.alerts`. This module
 * reads the preferences on every decision rather than holding them: a person who turns
 * gates on should not have to wait for the next app start to hear one.
 */
import type { AlertItem, AlertsUpdate } from "../bridge.js";
import type { AlertPreferences } from "../preferences/schema.js";

export type AlertTier = AlertItem["tier"];

/** A gate is not an interruption for its first minute (docs/design/20-attention-and-gates.md). */
export const GATE_DELAY_MS = 60_000;

/**
 * How many already-notified ids are remembered after they leave the open set (#882). An item
 * can leave and come back with the same id when its source changes hands: focus moves to a
 * watched machine, and for a moment neither the fleet nor the renderer states its alerts.
 * Remembering the id means the return is not a second notification. Bounded, oldest first.
 */
export const NOTIFIED_LEDGER_SIZE = 512;

/** What the port is asked to put on screen. One of these per tier, updated in place. */
export interface AlertNotification {
  tier: AlertTier;
  /** One line, sentence case, subject first. */
  title: string;
  body: string;
  /** How many open items of this tier it stands for; 2 or more means it has coalesced. */
  count: number;
  /** The newest item it stands for — what a click comes back with. */
  item: AlertItem;
}

/** The Electron-shaped half, implemented in `index.ts` and faked in the test. */
export interface AlertsPort {
  /** Post this tier's notification, or update the one already showing. */
  show: (notification: AlertNotification) => void;
  /** Withdraw this tier's notification: everything it stood for has gone. */
  dismiss: (tier: AlertTier) => void;
  /** The dock/taskbar badge: the one number, zero for none. */
  badge: (count: number) => void;
  /** Whether the window has focus right now. */
  isFocused: () => boolean;
  /**
   * Put Attention in front of the person *inside* a window that already has focus. There
   * is deliberately no way to ask for the window itself — see the header.
   */
  focusAttention: (item: AlertItem) => void;
  /** Injected so the test can drive it; `Date.now` in the app. */
  now?: () => number;
}

export interface Alerts {
  /** What is open right now, from the renderer. Diffed against what was open before. */
  update: (update: AlertsUpdate) => void;
  /** The window gained or lost focus: what the unfocused escalation is measured from. */
  focusChanged: (focused: boolean) => void;
  /** Drop every timer. Called on quit; nothing posts after it. */
  close: () => void;
}

/** One open item and what has happened to it. */
interface Tracked {
  item: AlertItem;
  /** Set once its notification has been posted, so it is never posted twice. */
  notified: boolean;
  /** Set once it has been put in front of the person at all: notified, or Attention brought forward. */
  presented: boolean;
  /** The pending gate delay, if it is a gate that has not fired yet. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The words a notification says. Deliberately not the question itself for a permission
 * ask: the question is a command or a path and belongs in the app, where it can be read in
 * mono and in full, rather than truncated by the OS into something ambiguous.
 */
function words(item: AlertItem, count: number): { title: string; body: string } {
  if (count > 1) {
    const what = item.tier === "permission" ? "permission asks" : item.tier === "gate" ? "gates" : "runs have failed";
    return item.tier === "failure"
      ? { title: `${count} runs have failed`, body: item.body }
      : { title: `${count} ${what} waiting`, body: item.title };
  }
  return { title: item.title, body: item.body };
}

export function createAlerts(port: AlertsPort, preferences: () => AlertPreferences): Alerts {
  const now = port.now ?? Date.now;
  const tracked = new Map<string, Tracked>();
  /** Presented ids that have left the open set, oldest first, and whether each was notified. */
  const ledger = new Map<string, boolean>();
  /** When the window last lost focus, and the timer that escalates gates if it stays that way. */
  let unfocusedSince: number | undefined = port.isFocused() ? undefined : now();
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const of = (tier: AlertTier): Tracked[] => [...tracked.values()].filter((t) => t.item.tier === tier);

  /**
   * Post or update `tier`'s one notification. The count is every *notified* item of the
   * tier, so a gate still inside its 60 seconds does not inflate the number on a
   * notification that is already showing.
   */
  function post(entry: Tracked): void {
    if (closed || entry.notified) return;
    entry.notified = true;
    entry.presented = true;
    const open = of(entry.item.tier).filter((t) => t.notified);
    port.show({ tier: entry.item.tier, count: open.length, item: entry.item, ...words(entry.item, open.length) });
  }

  /** Whether a gate may notify: its tier is on, or the app has been ignored long enough. */
  function gatesEscalated(): boolean {
    const after = preferences().unfocusedEscalationMs;
    return unfocusedSince !== undefined && now() - unfocusedSince >= after;
  }

  function fireGate(entry: Tracked): void {
    entry.timer = undefined;
    if (preferences().gate || gatesEscalated()) post(entry);
  }

  /** Start a gate's delay, or fire it straight away when the ask is already older than it. */
  function scheduleGate(entry: Tracked): void {
    const waited = now() - Date.parse(entry.item.since);
    const left = GATE_DELAY_MS - waited;
    if (left <= 0) {
      fireGate(entry);
      return;
    }
    entry.timer = setTimeout(() => fireGate(entry), left);
  }

  function arrived(item: AlertItem): void {
    const entry: Tracked = { item, notified: false, presented: false, timer: undefined };
    tracked.set(item.id, entry);
    const before = ledger.get(item.id);
    if (before !== undefined) {
      // Already put in front of the person once; it only went missing while its source
      // changed hands. Neither a notification nor Attention a second time.
      ledger.delete(item.id);
      entry.notified = before;
      entry.presented = true;
      return;
    }
    if (item.tier === "gate") {
      scheduleGate(entry);
      return;
    }
    /* A permission ask is the one thing in the app allowed to take the person's attention,
       and only inside a window that already has focus — so this is asked before the
       preference is, because it is not a notification and is not opted out of. */
    if (item.tier === "permission" && port.isFocused()) {
      entry.presented = true;
      port.focusAttention(item);
    }
    if (item.tier === "permission" ? preferences().permission : preferences().failure) post(entry);
  }

  function departed(entry: Tracked): void {
    if (entry.timer) clearTimeout(entry.timer);
    tracked.delete(entry.item.id);
    if (entry.presented) {
      ledger.delete(entry.item.id);
      ledger.set(entry.item.id, entry.notified);
      for (const id of ledger.keys()) {
        if (ledger.size <= NOTIFIED_LEDGER_SIZE) break;
        ledger.delete(id);
      }
    }
  }

  return {
    update({ waiting, items }) {
      if (closed) return;
      // The daemon's own number, not a recount of `items`: a failure is in `items` and is
      // not something a person is being asked (docs/design/20-attention-and-gates.md).
      port.badge(waiting);

      const seen = new Set(items.map((i) => i.id));
      for (const entry of [...tracked.values()]) {
        if (seen.has(entry.item.id)) continue;
        const tier = entry.item.tier;
        departed(entry);
        // The tier's notification stood for items that are all answered now; leaving it up
        // would be the app asking for something nobody can give it any more.
        if (of(tier).every((t) => !t.notified)) port.dismiss(tier);
      }
      for (const item of items) {
        const known = tracked.get(item.id);
        if (known) known.item = item;
        else arrived(item);
      }
    },

    focusChanged(focused) {
      if (closed) return;
      if (focused) {
        unfocusedSince = undefined;
        if (escalation) clearTimeout(escalation);
        escalation = undefined;
        return;
      }
      if (unfocusedSince !== undefined) return;
      unfocusedSince = now();
      /* "When the app is unfocused for longer than a configurable interval, gates escalate
         to notifications too" — including gates whose 60 seconds passed while the person
         was still at the window and the tier was switched off. */
      escalation = setTimeout(() => {
        escalation = undefined;
        for (const entry of of("gate")) if (!entry.timer) post(entry);
      }, preferences().unfocusedEscalationMs);
    },

    close() {
      closed = true;
      for (const entry of [...tracked.values()]) departed(entry);
      if (escalation) clearTimeout(escalation);
      escalation = undefined;
    },
  };
}
