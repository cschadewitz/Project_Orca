#!/usr/bin/env node
// Refreshes vitest.durations.json, the seed vitest.sequencer.ts uses to order test files on
// a runner with no cached results. Reads Vitest's own results cache from a local run (default
// node_modules/.vite/vitest/*/results.json) or a path given as the first argument, and keeps
// the files that still exist. Run the suite once on a quiet machine first.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function defaultCache() {
  const base = join(root, "node_modules/.vite/vitest");
  if (!existsSync(base)) return null;
  for (const dir of readdirSync(base)) {
    const file = join(base, dir, "results.json");
    if (existsSync(file)) return file;
  }
  return null;
}

const source = process.argv[2] ? resolve(process.argv[2]) : defaultCache();
if (!source) {
  console.error("No Vitest results cache found. Run `pnpm test` once, or pass a results.json path.");
  process.exit(1);
}

const results = JSON.parse(readFileSync(source, "utf8"));
const out = {};
for (const project of Object.values(results.projects ?? {})) {
  for (const [file, info] of Object.entries(project.files ?? {})) {
    if (!existsSync(join(root, file)) || typeof info.duration !== "number") continue;
    // Whole 10 ms steps keep the diff of a refresh small; sub-10 ms files all rank the same.
    out[file] = Math.max(0, Math.round(info.duration / 10) * 10);
  }
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(join(root, "vitest.durations.json"), `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`Wrote ${Object.keys(sorted).length} durations from ${source}`);
