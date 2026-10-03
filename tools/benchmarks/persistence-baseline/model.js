/** Bounded workload plans and interval statistics, independent of the runtime. */
export const BASELINE = "e94bf699d9f3000de8822ed3434c1dce92b6ce19";
export const LIMITS = Object.freeze({
  suiteMs: 900_000,
  childMs: 60_000,
  diskBytes: 256 * 1024 * 1024,
  buildRssBytes: 2 * 1024 * 1024 * 1024,
  rssBytes: 512 * 1024 * 1024,
  outputBytes: 2 * 1024 * 1024,
  maxFiles: 12_000,
  repetitions: 3,
});

export function plan(profile) {
  if (!["smoke", "baseline"].includes(profile)) throw new Error("unknown profile");
  const smoke = profile === "smoke";
  const base = { history: smoke ? 8 : 32, runs: 1, catalog: 0, readers: 1, overlays: 1, payloadBytes: 256 };
  const cases = [];
  for (const [axis, levels] of Object.entries({
    history: smoke ? [8, 24, 64] : [32, 128, 512],
    runs: smoke ? [1, 4, 8] : [1, 8, 32],
    catalog: smoke ? [0, 32, 128] : [0, 128, 512],
    readers: [1, 2, 4],
  })) {
    for (const level of levels) cases.push({ id: `${axis}-${level}`, ...base, [axis]: level });
  }
  cases.push({
    id: "combined",
    ...base,
    history: smoke ? 24 : 128,
    runs: smoke ? 4 : 8,
    catalog: smoke ? 32 : 128,
    readers: 4,
  });
  return cases;
}

export function rotate(values, round) {
  const at = round % values.length;
  return [...values.slice(at), ...values.slice(0, at)];
}

export function unionMs(intervals) {
  let end = -Infinity;
  let total = 0;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (stop < start) throw new Error("negative interval");
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}

export function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: values.length, median, min: sorted[0], max: sorted.at(-1), spread: sorted.at(-1) - sorted[0] };
}

export function summarize(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.case.id}/${sample.cache}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  return [...groups].map(([key, rows]) => {
    const passed = rows.filter((row) => row.status === "passed");
    const labels = [...new Set(passed.flatMap((row) => Object.keys(row.result.operations)))];
    return {
      key,
      outcomes: rows.map((row) => row.status),
      wallMs: stats(passed.map((row) => row.result.wallMs)),
      operations: Object.fromEntries(
        labels.map((label) => [
          label,
          {
            unionMs: stats(passed.map((row) => row.result.operations[label].unionMs)),
            counts: passed.map((row) => row.result.operations[label].count),
          },
        ]),
      ),
    };
  });
}
