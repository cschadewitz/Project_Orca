/** Yield to timers/native completions between bounded diagnostics-only CPU batches. */

export function completeReportWork<T>(work: Generator<void, T>): T {
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

export function scheduleReportWork<T>(work: Generator<void, T>): Promise<T> {
  // Reuse one callback and one completion promise. Awaiting a fresh immediate
  // promise for every batch creates thousands of otherwise empty async frames.
  return new Promise<T>((resolve, reject) => {
    const advance = () => {
      try {
        const next = work.next();
        if (next.done) resolve(next.value);
        else setImmediate(advance);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("unavailable"));
      }
    };
    setImmediate(advance);
  });
}

// CPU scheduling granularity only; event/report/consent/resource policy is unchanged.
export const REPORT_BATCH_EVENTS = 32;
