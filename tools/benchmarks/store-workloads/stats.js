/** Summary statistics for latency samples, in milliseconds. Nearest-rank percentiles, no interpolation. */
export function summarize(samples) {
  if (samples.length === 0) return { n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  const total = sorted.reduce((sum, x) => sum + x, 0);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(rank(50)),
    p95: round(rank(95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(total / sorted.length),
    total: round(total),
  };
}

export function round(x) {
  return Math.round(x * 1000) / 1000;
}

/** A small deterministic PRNG (mulberry32), so every backend sees the same dataset for a seed. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Time one async call. */
export async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}
