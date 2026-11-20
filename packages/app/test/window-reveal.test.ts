/**
 * The new window is shown even when `ready-to-show` never comes (#858). Under a Wayland
 * compositor a hidden window gets no frames, so its first paint is never reported and a
 * window shown only on `ready-to-show` stays hidden while the app runs.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  REVEAL_AFTER_LOAD_MS,
  REVEAL_DEADLINE_MS,
  revealWhenReady,
  type RevealReason,
} from "../src/main/window-reveal.js";

/** Like Electron's: once the window is destroyed, touching its webContents throws. */
class FakeContents extends EventEmitter {
  constructor(private readonly owner: { destroyed: boolean }) {
    super();
  }
  override off(event: string | symbol, listener: (...args: unknown[]) => void) {
    if (this.owner.destroyed) throw new TypeError("Object has been destroyed");
    return super.off(event, listener);
  }
}

class FakeWindow extends EventEmitter {
  visible = false;
  destroyed = false;
  shows = 0;
  readonly webContents: FakeContents = new FakeContents(this);
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  show() {
    this.shows++;
    this.visible = true;
  }
}

function open(win = new FakeWindow()) {
  const reasons: RevealReason[] = [];
  revealWhenReady(win, { onReveal: (reason) => reasons.push(reason) });
  return { win, reasons };
}

describe("revealWhenReady", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("shows on the first paint, once, and nothing fires later", () => {
    const { win, reasons } = open();
    win.webContents.emit("did-finish-load");
    win.emit("ready-to-show");
    vi.advanceTimersByTime(REVEAL_DEADLINE_MS * 2);
    expect(win.shows).toBe(1);
    expect(reasons).toEqual(["ready-to-show"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("the page loaded but no paint was reported: shown after the grace (the Wayland case)", () => {
    const { win, reasons } = open();
    win.webContents.emit("did-finish-load");
    vi.advanceTimersByTime(REVEAL_AFTER_LOAD_MS - 1);
    expect(win.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(win.visible).toBe(true);
    expect(reasons).toEqual(["after-load"]);
    // The late first paint that showing the window lets through changes nothing.
    win.emit("ready-to-show");
    expect(win.shows).toBe(1);
    expect(reasons).toEqual(["after-load"]);
  });

  test("a main-frame load failure is shown too, rather than left running invisibly", () => {
    const { win, reasons } = open();
    win.webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///index.html", false);
    vi.advanceTimersByTime(REVEAL_AFTER_LOAD_MS);
    expect(win.visible).toBe(false);
    win.webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///index.html", true);
    vi.advanceTimersByTime(REVEAL_AFTER_LOAD_MS);
    expect(reasons).toEqual(["after-load"]);
    expect(win.webContents.listenerCount("did-fail-load")).toBe(0);
  });

  test("nothing reported at all: shown at the deadline", () => {
    const { win, reasons } = open();
    vi.advanceTimersByTime(REVEAL_DEADLINE_MS - 1);
    expect(win.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(win.visible).toBe(true);
    expect(reasons).toEqual(["deadline"]);
  });

  test("a window closed before it was shown is never shown", () => {
    const { win, reasons } = open();
    win.webContents.emit("did-finish-load");
    win.destroyed = true;
    win.emit("closed");
    vi.advanceTimersByTime(REVEAL_DEADLINE_MS);
    expect(win.shows).toBe(0);
    expect(reasons).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("closing a window after it was shown does not touch its destroyed webContents", () => {
    const { win } = open();
    win.emit("ready-to-show");
    win.destroyed = true;
    expect(() => win.emit("closed")).not.toThrow();
  });

  test("a window something else already showed is not shown again", () => {
    const { win, reasons } = open();
    win.visible = true; // e.g. a second launch's focusWindow()
    vi.advanceTimersByTime(REVEAL_DEADLINE_MS);
    expect(win.shows).toBe(0);
    expect(reasons).toEqual(["deadline"]);
  });
});
