/**
 * Test-file ordering for CI. Vitest starts the longest files first (so none is left to
 * run alone at the end) using the durations it cached from earlier runs. A fresh or
 * ephemeral runner has no such cache, and Vitest then falls back to file size, which
 * ranks the suite's long files poorly. `vitest.durations.json` is a checked-in seed of
 * per-file durations used only for files with no cached result; refresh it with
 * `pnpm run test:durations`. A stale or missing seed costs scheduling quality, never
 * correctness: the order of files does not change what runs.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

export type Durations = Readonly<Record<string, number>>;

export function loadSeed(): Durations {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL("./vitest.durations.json", import.meta.url)), "utf8"));
  } catch {
    return {};
  }
}

/** Longest first; files nobody has timed (neither cache nor seed) go before everything, as Vitest does. */
export function orderByDuration<T>(
  items: readonly T[],
  info: (item: T) => { failed: boolean; duration: number | undefined },
): T[] {
  const rank = (item: T) => {
    const { failed, duration } = info(item);
    return failed ? Number.POSITIVE_INFINITY : (duration ?? Number.MAX_VALUE);
  };
  return [...items].sort((a, b) => rank(b) - rank(a));
}

export default class SeededSequencer extends BaseSequencer {
  private readonly seed = loadSeed();

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const root = this.ctx.config.root;
    return orderByDuration(files, (spec) => {
      const cached = this.ctx.cache.getTestSpecificationResult(spec);
      if (cached) return { failed: cached.failed, duration: cached.duration };
      const rel = relative(root, spec.moduleId).split("\\").join("/");
      return { failed: false, duration: this.seed[rel] };
    });
  }
}
