/** Yield to timers/native completions between bounded diagnostics-only CPU batches. */
import { setImmediate } from "node:timers/promises";

export function completeReportWork<T>(work: Generator<void, T>): T {
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

export async function scheduleReportWork<T>(work: Generator<void, T>): Promise<T> {
  for (;;) {
    await setImmediate();
    const next = work.next();
    if (next.done) return next.value;
  }
}

// CPU scheduling granularity only; event/report/consent/resource policy is unchanged.
export const REPORT_BATCH_EVENTS = 128;
