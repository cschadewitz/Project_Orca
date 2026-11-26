// @vitest-environment happy-dom
/**
 * The age on an Attention card counts up while the card is open (#1194). An ask pushed by
 * notification arrives with the age it had then, usually 0, and the card said "waiting 0s"
 * for as long as it stayed on screen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { WaitedAge, waitingSince } from "../src/attention/waited-age.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("waitingSince", () => {
  it("anchors the daemon's age to this window's clock the first time it sees an ask", () => {
    expect(waitingSince({ id: "anchor-a", waitingMs: 5_000 }, 100_000)).toBe(95_000);
    // Seen again later with a fresher snapshot: still the same instant.
    expect(waitingSince({ id: "anchor-a", waitingMs: 15_000 }, 110_000)).toBe(95_000);
  });

  it("keeps the earliest anchor, so a later push carrying 0 does not reset the age", () => {
    expect(waitingSince({ id: "anchor-b", waitingMs: 60_000 }, 200_000)).toBe(140_000);
    expect(waitingSince({ id: "anchor-b", waitingMs: 0 }, 210_000)).toBe(140_000);
  });
});

describe("WaitedAge", () => {
  it("counts up from an ask that arrived at 0s", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    render(<WaitedAge input={{ id: "ticking", waitingMs: 0 }} />);
    expect(screen.getByText("waiting 0s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("waiting 5s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("waiting 1m")).toBeTruthy();
  });
});
