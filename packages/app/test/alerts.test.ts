/**
 * The notification policy (#162): which tier interrupts, when, and how many notifications
 * three asks make.
 *
 * Driven with fake timers, because the two numbers in it are a minute and five minutes and
 * neither is worth waiting for. What is *not* faked is the port: the module is
 * Electron-free precisely so that the thing under test here is the policy and not
 * `Notification`, and the port is recorded rather than mocked so a test can say what the
 * app would have put on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertItem } from "../src/bridge.js";
import { createAlerts, GATE_DELAY_MS, type AlertNotification, type AlertsPort } from "../src/main/alerts.js";
import { DEFAULT_PREFERENCES, type AlertPreferences } from "../src/preferences/schema.js";

const START = Date.UTC(2026, 2, 1, 9, 0, 0);

function item(over: Partial<AlertItem> & Pick<AlertItem, "id" | "tier">): AlertItem {
  return {
    title: `${over.tier} on run-1`,
    body: "the body",
    runId: "run-1",
    since: new Date(START).toISOString(),
    ...over,
  };
}

interface Recorder {
  port: AlertsPort;
  shown: AlertNotification[];
  dismissed: string[];
  badges: number[];
  focused: AlertItem[];
  setFocus: (focused: boolean) => void;
}

function recorder(focused = false): Recorder {
  let windowFocused = focused;
  const shown: AlertNotification[] = [];
  const dismissed: string[] = [];
  const badges: number[] = [];
  const attention: AlertItem[] = [];
  return {
    shown,
    dismissed,
    badges,
    focused: attention,
    setFocus: (value) => {
      windowFocused = value;
    },
    port: {
      show: (notification) => shown.push(notification),
      dismiss: (tier) => dismissed.push(tier),
      badge: (count) => badges.push(count),
      isFocused: () => windowFocused,
      focusAttention: (i) => attention.push(i),
      now: () => Date.now(),
    },
  };
}

/** The defaults, with whatever a test wants to turn on. Read on every decision, not held. */
function preferences(over: Partial<AlertPreferences> = {}): () => AlertPreferences {
  const value = { ...DEFAULT_PREFERENCES.alerts, ...over };
  return () => value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the tier table", () => {
  it("posts a permission ask immediately and a gate only after 60 seconds", () => {
    const r = recorder();
    const alerts = createAlerts(r.port, preferences({ gate: true }));

    alerts.update({
      waiting: 2,
      items: [item({ id: "ask-1", tier: "permission" }), item({ id: "gate-1", tier: "gate" })],
    });
    expect(r.shown.map((n) => n.tier)).toEqual(["permission"]);

    vi.advanceTimersByTime(GATE_DELAY_MS - 1);
    expect(r.shown).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(r.shown.map((n) => n.tier)).toEqual(["permission", "gate"]);
    alerts.close();
  });

  it("measures the gate delay from when it was asked, not from when this process heard", () => {
    const r = recorder();
    const alerts = createAlerts(r.port, preferences({ gate: true }));

    // An app that opens onto a gate ten minutes old has already missed the delay.
    const old = new Date(START - 10 * 60_000).toISOString();
    alerts.update({ waiting: 1, items: [item({ id: "gate-old", tier: "gate", since: old })] });
    expect(r.shown.map((n) => n.tier)).toEqual(["gate"]);
    alerts.close();
  });

  it("defaults to permission asks only: a gate and a failure post nothing", () => {
    const r = recorder();
    const alerts = createAlerts(r.port, preferences());

    alerts.update({
      waiting: 1,
      items: [item({ id: "gate-1", tier: "gate" }), item({ id: "run-2", tier: "failure" })],
    });
    vi.advanceTimersByTime(GATE_DELAY_MS * 2);
    expect(r.shown).toEqual([]);
    // Still counted, still on the badge: opting out of the interruption is not opting out
    // of the number (docs/design/20-attention-and-gates.md).
    expect(r.badges).toEqual([1]);
    alerts.close();
  });

  it("posts a failure when the run fails and never again", () => {
    const r = recorder();
    const alerts = createAlerts(r.port, preferences({ failure: true }));
    const failure = item({ id: "run-2", tier: "failure", title: "sdlc failed" });

    alerts.update({ waiting: 0, items: [failure] });
    alerts.update({ waiting: 0, items: [failure] });
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]).toMatchObject({ tier: "failure", title: "sdlc failed", count: 1 });
    alerts.close();
  });
});

describe("coalescing", () => {
  it("updates the count on the one that is showing rather than posting a second", () => {
    const r = recorder();
    const alerts = createAlerts(r.port, preferences());
    const first = item({ id: "ask-1", tier: "permission" });
    const second = item({ id: "ask-2", tier: "permission", title: "another ask" });

    alerts.update({ waiting: 1, items: [first] });
    alerts.update({ waiting: 2, items: [first, second] });
    alerts.update({ waiting: 3, items: [first, second, item({ id: "ask-3", tier: "permission" })] });

    // Three asks, three `show` calls — and every one of them is the *same* notification
    // being updated, which is what the tier on it says: the port keeps one per tier.
    expect(r.shown.map((n) => [n.tier, n.count])).toEqual([
      ["permission", 1],
      ["permission", 2],
      ["permission", 3],
    ]);
    expect(r.shown[2]?.title).toBe("3 permission asks waiting");
    expect(r.badges).toEqual([1, 2, 3]);
    alerts.close();
  });

  it("withdraws the tier's notification once everything it stood for is answered", () => {
    const r = recorder();
    const alerts = createAlerts(r.port, preferences());
    const first = item({ id: "ask-1", tier: "permission" });
    const second = item({ id: "ask-2", tier: "permission" });

    alerts.update({ waiting: 2, items: [first, second] });
    // One answered: the notification stays, because one ask is still open.
    alerts.update({ waiting: 1, items: [second] });
    expect(r.dismissed).toEqual([]);
    alerts.update({ waiting: 0, items: [] });
    expect(r.dismissed).toEqual(["permission"]);
    expect(r.badges.at(-1)).toBe(0);
    alerts.close();
  });

  it("forgets a gate answered inside its delay, so it never posts", () => {
    const r = recorder();
    const alerts = createAlerts(r.port, preferences({ gate: true }));

    alerts.update({ waiting: 1, items: [item({ id: "gate-1", tier: "gate" })] });
    alerts.update({ waiting: 0, items: [] });
    vi.advanceTimersByTime(GATE_DELAY_MS * 2);
    expect(r.shown).toEqual([]);
    alerts.close();
  });
});

describe("focus", () => {
  it("brings Attention forward for a permission ask only when the window has focus", () => {
    const unfocused = recorder(false);
    const away = createAlerts(unfocused.port, preferences());
    away.update({ waiting: 1, items: [item({ id: "ask-1", tier: "permission" })] });
    expect(unfocused.focused).toEqual([]);
    away.close();

    const r = recorder(true);
    const here = createAlerts(r.port, preferences());
    here.update({ waiting: 1, items: [item({ id: "ask-1", tier: "permission" })] });
    expect(r.focused.map((i) => i.id)).toEqual(["ask-1"]);
    // And a gate never does it, focused or not: only tier 1 may take the attention.
    here.update({ waiting: 2, items: [item({ id: "ask-1", tier: "permission" }), item({ id: "g", tier: "gate" })] });
    expect(r.focused.map((i) => i.id)).toEqual(["ask-1"]);
    here.close();
  });

  it("escalates a gate once the window has been unfocused for the interval", () => {
    const r = recorder(true);
    // Gates are off: the escalation is the only thing that can post this one.
    const alerts = createAlerts(r.port, preferences({ gate: false, unfocusedEscalationMs: 300_000 }));

    alerts.update({ waiting: 1, items: [item({ id: "gate-1", tier: "gate" })] });
    vi.advanceTimersByTime(GATE_DELAY_MS);
    expect(r.shown).toEqual([]);

    r.setFocus(false);
    alerts.focusChanged(false);
    vi.advanceTimersByTime(299_000);
    expect(r.shown).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(r.shown.map((n) => n.tier)).toEqual(["gate"]);
    alerts.close();
  });

  it("cancels the escalation when the person comes back", () => {
    const r = recorder(true);
    const alerts = createAlerts(r.port, preferences({ unfocusedEscalationMs: 60_000 }));

    alerts.update({ waiting: 1, items: [item({ id: "gate-1", tier: "gate" })] });
    alerts.focusChanged(false);
    vi.advanceTimersByTime(30_000);
    alerts.focusChanged(true);
    // A second blur restarts the interval rather than continuing the first one.
    alerts.focusChanged(false);
    vi.advanceTimersByTime(59_000);
    expect(r.shown).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(r.shown.map((n) => n.tier)).toEqual(["gate"]);
    alerts.close();
  });

  it("escalates a gate that arrives while the window is already away", () => {
    const r = recorder(false);
    const alerts = createAlerts(r.port, preferences({ unfocusedEscalationMs: 1_000 }));

    // Unfocused since before the gate: the delay expires with the interval already passed.
    vi.advanceTimersByTime(5_000);
    alerts.update({ waiting: 1, items: [item({ id: "gate-1", tier: "gate", since: new Date().toISOString() })] });
    vi.advanceTimersByTime(GATE_DELAY_MS);
    expect(r.shown.map((n) => n.tier)).toEqual(["gate"]);
    alerts.close();
  });
});

describe("close", () => {
  it("posts nothing after it, and drops the timers", () => {
    const r = recorder();
    const alerts = createAlerts(r.port, preferences({ gate: true }));

    alerts.update({ waiting: 1, items: [item({ id: "gate-1", tier: "gate" })] });
    alerts.close();
    vi.advanceTimersByTime(GATE_DELAY_MS * 2);
    alerts.update({ waiting: 1, items: [item({ id: "ask-1", tier: "permission" })] });
    alerts.focusChanged(false);
    expect(r.shown).toEqual([]);
    expect(r.badges).toEqual([1]);
  });
});
