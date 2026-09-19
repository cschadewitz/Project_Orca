/**
 * One 1Hz clock for the whole renderer.
 *
 * "A duration that is still accruing ticks at 1Hz and no faster"
 * (docs/design/30-long-running-content.md). A run tree can hold a hundred accruing
 * durations; a hundred intervals would be a hundred wake-ups a second and a hundred
 * separate renders, so every subscriber shares one interval and one timestamp and they
 * re-render on the same tick rather than drifting apart a frame at a time.
 *
 * `useTick(false)` subscribes to nothing, so a screen whose durations are all finished
 * schedules no timer at all.
 */
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (timer === undefined) {
    /* Refresh before the first tick: the clock may have been idle for minutes. React
       re-reads the snapshot straight after subscribing, so this lands on the next render. */
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const listener of listeners) listener();
    }, 1000);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/* Stable module-level identities: `useSyncExternalStore` re-subscribes when this changes. */
const idle = (): (() => void) => () => {};
const snapshot = (): number => now;

/** The shared clock, in epoch milliseconds. Re-renders the caller once a second while `active`. */
export const useTick = (active: boolean): number => useSyncExternalStore(active ? subscribe : idle, snapshot, snapshot);
