/** Expand config-style glob patterns into a sorted list of absolute file paths. */
import { glob } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const GLOB_CHARS = /[*?[{]/;

/** Split an absolute glob into the longest literal directory prefix and the pattern below it. */
function splitGlob(pattern: string): { cwd: string; rest: string } {
  const parts = pattern.split(/[\\/]+/);
  const literal: string[] = [];
  while (parts.length && !GLOB_CHARS.test(parts[0]!)) literal.push(parts.shift()!);
  return { cwd: literal.join("/") || "/", rest: parts.join("/") };
}

/** Resolve `patterns` (relative ones against `baseDir`) to absolute paths, deduped and sorted. */
export async function expandPatterns(patterns: string[], baseDir: string): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    const { cwd, rest } = isAbsolute(pattern) ? splitGlob(pattern) : { cwd: baseDir, rest: pattern };
    if (!rest || !GLOB_CHARS.test(rest)) {
      files.add(join(cwd, rest));
      continue;
    }
    for await (const f of glob(rest, { cwd })) files.add(join(cwd, f));
  }
  return [...files].sort();
}
